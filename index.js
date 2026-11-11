/**
 * retire-this-session: retire the current session and its fork/subagent tree
 * by archiving it (reversible, immediately hidden from every grouping surface)
 * and queueing its artifact directories for relocation into
 * `<dshHome>/Session-Time-Vault` at the next startup, when no process holds
 * them.
 *
 * Nothing is deleted, no process is stopped, and the plugin never writes
 * `workspace.json` itself: archiving goes through `ctx.workspaceRegistry`, which
 * owns the durable set and its change events.
 * @module dsh-session-retirement
 */
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { describeTree, drainQueue, findSessionDir, planRetirement, readQueue, writeQueue } from './plan.js'

export const name = 'retire-this-session'

/** The tool registry is the only hard dependency; the rest resolve lazily. */
export const inject = ['tools']

const text = (value) => [{ type: 'text', text: value }]

/** The tool output schema's session shape; abort paths have no directory yet. */
const sessionShape = (members) => members.map((member) => ({
  id: member.id,
  kind: member.kind,
  cwd: member.cwd ?? '',
  dir: member.dir ?? '',
}))

/** Read one argument without trusting its shape. */
function boolArg(args, field) {
  const value = typeof args === 'object' && args !== null ? args[field] : undefined
  return value === true
}

/**
 * Every header this process can see: stored logs first, then live sessions, so
 * a session created but not yet flushed still joins the tree.
 * @param ctx - host context.
 * @returns headers by session id.
 */
async function collectHeaders(ctx) {
  const headers = new Map()
  const persistence = ctx.get('sessionPersistence')
  if (persistence !== undefined) {
    for (const snapshot of await persistence.list()) {
      if (snapshot?.header?.id !== undefined) headers.set(snapshot.header.id, snapshot.header)
    }
  }
  const store = ctx.get('sessions')
  for (const session of store?.list?.() ?? []) {
    const header = session?.header
    if (header?.id !== undefined) headers.set(header.id, header)
  }
  return headers
}

/**
 * Register the retirement tool and drain any queue left by an earlier run.
 * @param ctx - host context.
 * @param config - bundle row config.
 */
export function apply(ctx, config = {}) {
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  // Relative config paths resolve against the DSH home, so a profile never has
  // to repeat the absolute location of this machine's home directory.
  const resolvePath = (value, fallback) => {
    if (value === undefined) return fallback
    return isAbsolute(value) ? value : join(dshHome, value)
  }
  const sessionsRoot = join(dshHome, 'sessions')
  const vaultDir = resolvePath(config.vaultDir, join(dshHome, 'Session-Time-Vault'))
  const queueFile = resolvePath(config.queueFile, join(dshHome, 'session-retirement-queue.json'))
  // Written by the separate @local/dsh-gui-log plugin; named here only so the
  // confirmation tells the reader where the Web UI's own failures are recorded.
  const guiLogFile = resolvePath(config.guiLogFile, join(dshHome, 'gui-log.log'))
  const registry = () => {
    const value = ctx.get('workspaceRegistry')
    if (value === undefined) throw new Error('session-retirement: workspace registry is unavailable')
    return value
  }

  /**
   * Ask the human to confirm. Returns true only for an explicit "Retire".
   * @param exec - tool run context carrying the live agent and its signal.
   * @param tree - the rendered tree shown with the question.
   * @param sessions - the resolved members.
   */
  async function confirm(exec, tree, sessions) {
    const service = ctx.get('userQuestions')
    if (service === undefined) throw new Error('no confirmation channel is available; refusing to retire unconfirmed')
    if (exec.agent === undefined) throw new Error('retirement must be confirmed by a live user session; refusing')
    const answer = await service.ask({
      questions: [{
        id: 'retire-confirm',
        header: 'Retire session',
        question: `Retire ${sessions.length} session(s) into the vault?`,
        // The detail is rendered as Markdown, where single newlines are soft
        // breaks: the tree must be a fenced block or it collapses to one line.
        detail: ['```', tree, '```', '',
          `Every member is archived (hidden from the list, steps blocked) and its log directory moves into ${vaultDir} `
          + 'at the next dsh start. Nothing is deleted. Unarchiving restores the row, not the directory.',
          '',
          `Web UI diagnostics are appended to ${guiLogFile}; a broken page after a restart is reported there, not in this session.`
        ].join('\n'),
        options: [
          { label: 'Retire', description: 'Archive and queue the tree now.' },
          { label: 'Cancel', description: 'Change nothing.' },
        ],
      }],
      agent: exec.agent,
      signal: exec.signal,
    })
    const selected = answer?.answers?.find((item) => item.id === 'retire-confirm')?.selected ?? []
    return selected.includes('Retire')
  }

  /**
   * Drop this run's queue entries after an archive failure, so a later start
   * never moves the log of a session that is not archived. Best effort: the
   * drain already ignores entries whose session is not archived.
   * @param ids - the ids this run queued.
   */
  async function dropQueued(ids) {
    if (ids.length === 0) return
    try {
      const doomed = new Set(ids)
      const pending = await readQueue(queueFile)
      await writeQueue(queueFile, pending.filter((entry) => !doomed.has(entry.id)))
    } catch {
      // best effort; the drain's archive gate is the durable guard
    }
  }

  /**
   * Plan the tree, ask for confirmation, queue the directories, then archive
   * every member that is not archived yet, root last.
   * @param rootId - the requesting session.
   * @param dryRun - report without asking, archiving, or queueing.
   * @param exec - the tool run context, needed to ask and to place the question.
   */
  async function retire(rootId, dryRun, exec) {
    const registryService = registry()
    const headers = await collectHeaders(ctx)
    const plan = planRetirement({
      headers,
      rootId,
      pinned: new Set(registryService.pinnedSessionIds ?? []),
      archived: new Set(registryService.archivedSessionIds ?? []),
    })
    const tree = describeTree(plan.members, rootId)
    if (!plan.ok) return { status: 'aborted', reason: plan.reason, tree, sessions: sessionShape(plan.members), queued: 0 }

    const resolved = []
    for (const member of plan.members) {
      const dir = await findSessionDir(sessionsRoot, member.id)
      if (dir === undefined)
        return { status: 'aborted', reason: `no stored directory for '${member.id}'`, tree, sessions: sessionShape(plan.members), queued: 0 }
      resolved.push({ ...member, dir })
    }
    const sessions = sessionShape(resolved)
    if (dryRun) return { status: 'planned', reason: '', tree, sessions, queued: 0 }

    // Root last: the root's archive cancels this very turn, so a child failure
    // must happen while the turn is still alive and the error can be reported.
    const ordered = [
      ...resolved.filter((member) => member.id !== rootId),
      ...resolved.filter((member) => member.id === rootId),
    ]
    const todo = ordered.filter((member) => member.archived !== true)

    let pending
    try {
      pending = await readQueue(queueFile)
    } catch (error) {
      return { status: 'aborted', reason: `retirement queue unreadable: ${String(error?.message ?? error)}`, tree, sessions, queued: 0 }
    }
    const known = new Set(pending.map((entry) => entry.id))
    const additions = ordered
      .filter((member) => !known.has(member.id))
      .map((member) => ({ id: member.id, dir: member.dir, cwd: member.cwd ?? '', queuedAt: Date.now() }))
    if (todo.length === 0 && additions.length === 0)
      return { status: 'already-retired', reason: '', tree, sessions, queued: 0 }

    let confirmed
    try {
      confirmed = await confirm(exec, tree, sessions)
    } catch (error) {
      return { status: 'aborted', reason: String(error?.message ?? error), tree, sessions, queued: 0 }
    }
    if (!confirmed) return { status: 'cancelled', reason: 'the user did not confirm', tree, sessions, queued: 0 }

    // Queue first: the queue is the durable intent, so a crash after the
    // archive still lets the next start move the logs. An entry whose session
    // is not archived by then is dropped by the drain.
    if (additions.length > 0) {
      try {
        await writeQueue(queueFile, [...pending, ...additions])
      } catch (error) {
        return { status: 'aborted', reason: `queue write failed: ${String(error?.message ?? error)}`, tree, sessions, queued: 0 }
      }
    }

    // stopActivity is mandatory for the root and honest for the rest: a
    // retirement that leaves a job, subagent, or turn running is not a
    // retirement. The archive is durable before any stop is requested, so a
    // cancelled turn still ends with the tree archived and queued.
    const archivedNow = []
    try {
      for (const member of todo) {
        await registryService.archiveSession(member.id, { stopActivity: true })
        archivedNow.push(member.id)
      }
    } catch (error) {
      for (const id of archivedNow.reverse()) {
        try {
          await registryService.unarchiveSession(id)
        } catch {
          // rollback is best effort; the failure below is the one that matters
        }
      }
      await dropQueued(additions.map((entry) => entry.id))
      return { status: 'aborted', reason: String(error?.message ?? error), tree, sessions, queued: 0 }
    }

    return { status: 'retired', reason: '', tree, sessions, queued: ordered.length }
  }

  ctx.tools.register({
    name: 'retire_session',
    description:
      'Retire this session together with its forked and subagent descendants. Every member is archived '
      + '(hidden from the session list, its steps blocked, its directory queued for the Session-Time-Vault at the '
      + 'next dsh start) and any work still running in the tree is cancelled. Nothing is deleted. Use dry_run:true '
      + 'to see the tree first. Without dry_run the human is asked to confirm in the UI, and nothing happens unless '
      + 'they choose Retire. Refuses when a member is pinned or has a different cwd. Retiring the calling session '
      + 'ends its turn, so this call reports as aborted even though the retirement succeeded. Retired logs are kept '
      + 'in ~/.dsh/Session-Time-Vault; Web UI diagnostics are appended to ~/.dsh/gui-log.log.',
    parameters: {
      type: 'object',
      properties: {
        dry_run: {
          type: 'boolean',
          description: 'Report the tree and the directories without archiving or queueing anything.',
        },
      },
      additionalProperties: false,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          reason: { type: 'string' },
          tree: { type: 'string' },
          queued: { type: 'integer' },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                kind: { type: 'string' },
                cwd: { type: 'string' },
                dir: { type: 'string' },
              },
              required: ['id', 'kind', 'cwd', 'dir'],
              additionalProperties: false,
            },
          },
        },
        required: ['status', 'reason', 'tree', 'queued', 'sessions'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const result = value
        if (result.status === 'aborted') return text(`Not retired: ${result.reason}\n\n${result.tree}`)
        if (result.status === 'planned')
          return text(`Would retire ${result.sessions.length} session(s) (dry run):\n${result.tree}\n\n`
            + result.sessions.map((s) => `- ${s.id} (${s.kind}) ${s.dir}`).join('\n'))
        if (result.status === 'cancelled')
          return text(`Cancelled; nothing was archived or queued.\n\n${result.tree}`)
        if (result.status === 'already-retired')
          return text(`Nothing to do: every session in the tree is already archived and queued.\n\n${result.tree}`)
        return text(`Retired ${result.sessions.length} session(s); ${result.queued} director${result.queued === 1 ? 'y' : 'ies'} `
          + 'queued for the Session-Time-Vault at the next dsh start.\n'
          + result.tree
          + '\n\nThis session will not accept another step. Continue in a new session.')
      },
    },
    async execute(args, exec) {
      const rootId = exec.agent?.session?.id
      if (rootId === undefined) return { status: 'aborted', reason: 'this call has no session', tree: '', sessions: [], queued: 0 }
      return await retire(rootId, boolArg(args, 'dry_run'), exec)
    },
  })

  // Relocate whatever a previous run queued, now that no process holds it. Wait
  // for the registry: its archive set is what keeps a stale entry (queued, then
  // never archived) from moving the log of a session that is still listed, and
  // an unready registry must not postpone the drain forever.
  ctx.inject(['workspaceRegistry', 'sessions'], (scoped) => {
    const registryService = scoped.get('workspaceRegistry')
    const store = scoped.get('sessions')
    drainQueue({
      queueFile,
      vaultDir,
      isLive: (id) => store?.get?.(id) !== undefined,
      isArchived: (id) => (registryService.archivedSessionIds ?? []).includes(id),
    })
      .then((result) => {
        if (result.moved > 0) scoped.logger?.info?.(`session-retirement: moved ${result.moved} session director(ies) into the vault`)
        if (result.voided > 0) scoped.logger?.info?.(`session-retirement: dropped ${result.voided} queued id(s) that were unarchived`)
      })
      .catch((error) => scoped.logger?.warn?.(`session-retirement: vault drain failed: ${String(error?.message ?? error)}`))
  })
}
