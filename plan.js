/**
 * Pure planning and queue mechanics for session retirement. No cordis, no
 * @deepseek-ai imports: everything here is exercised by test/plan.test.js with
 * plain objects.
 * @module session-retirement/plan
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Coarse kind of one tree member, from its durable header only. */
export function classify(header) {
  if (header?.origin === 'subagent') return 'subagent'
  if (header?.isSeeded === true) return 'fork'
  return 'session'
}

/**
 * Build the retirement tree: the transitive closure of `parentSession` seeded
 * at `rootId`, in breadth-first order.
 * @param headers - every stored and live header, by id.
 * @param rootId - the session that asked to retire.
 * @returns members with kind and depth, or an empty list when the root is unknown.
 */
export function treeOf(headers, rootId) {
  if (!headers.has(rootId)) return []
  const members = []
  const seen = new Set([rootId])
  let level = [{ id: rootId, depth: 0 }]
  while (level.length > 0) {
    const next = []
    for (const node of level) {
      const header = headers.get(node.id)
      members.push({ id: node.id, kind: classify(header), depth: node.depth, cwd: header.cwd, header })
      for (const [childId, child] of headers) {
        if (child.parentSession !== node.id || seen.has(childId)) continue
        seen.add(childId)
        next.push({ id: childId, depth: node.depth + 1 })
      }
    }
    level = next
  }
  return members
}

/**
 * Decide whether a tree may be retired.
 * @param options.headers - every header by id.
 * @param options.rootId - the requesting session.
 * @param options.pinned - pinned session ids.
 * @param options.archived - archived session ids.
 * @returns a plan: `ok` plus members, or `ok:false` with the reason and the
 *   members found so far (empty when the root itself is unknown).
 */
export function planRetirement({ headers, rootId, pinned = new Set(), archived = new Set() }) {
  const members = treeOf(headers, rootId)
  if (members.length === 0) return { ok: false, reason: `session '${rootId}' has no stored header`, members: [] }

  const rootCwd = members[0].cwd
  const foreign = members.filter((m) => m.cwd !== rootCwd)
  if (foreign.length > 0)
    return { ok: false, reason: `cwd differs inside the tree: ${foreign.map((m) => `${m.id}=${m.cwd ?? '(none)'}`).join(', ')}`, members }

  const pinnedMembers = members.filter((m) => pinned.has(m.id))
  if (pinnedMembers.length > 0)
    return { ok: false, reason: `pinned: ${pinnedMembers.map((m) => m.id).join(', ')}`, members }

  // An already-archived member is skipped, not refused: retirement stays
  // idempotent and a partly retired tree can still be finished. Its directory
  // is still queued for the vault.
  return { ok: true, reason: '', members: members.map((m) => ({ ...m, archived: archived.has(m.id) })) }
}

/**
 * Locate a session's artifact directory under the persistence root without
 * re-deriving the project-directory encoding: session ids are unique, so scan
 * the project directories for a child of that exact name.
 * @param sessionsRoot - `<dshHome>/sessions`.
 * @param id - the session id.
 * @returns the absolute directory, or undefined when the session has no log.
 */
export async function findSessionDir(sessionsRoot, id) {
  let projects
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(sessionsRoot, project.name, id)
    try {
      if ((await stat(candidate)).isDirectory()) return candidate
    } catch {
      // not in this project
    }
  }
  return undefined
}

/** Render a tree the way the skill printed it, for tool output and logs. */
export function describeTree(members, rootId) {
  const byParent = new Map()
  for (const member of members) {
    const parent = member.header?.parentSession
    if (parent === undefined || !members.some((m) => m.id === parent)) continue
    const siblings = byParent.get(parent) ?? []
    siblings.push(member)
    byParent.set(parent, siblings)
  }
  const root = members.find((m) => m.id === rootId) ?? members[0]
  const lines = [`${root.id}  [${root.kind}]`]
  const walk = (node, prefix) => {
    const children = byParent.get(node.id) ?? []
    children.forEach((child, index) => {
      const last = index === children.length - 1
      const detail = child.kind === 'subagent' ? `${child.kind}, depth ${child.depth}` : child.kind
      lines.push(`${prefix}${last ? '└── ' : '├── '}${child.id}  (${detail})`)
      walk(child, `${prefix}${last ? '    ' : '│   '}`)
    })
  }
  walk(root, '')
  return lines.join('\n')
}

/**
 * Read the durable queue.
 * @returns the parsed entries, `[]` when absent, or throws on a malformed file.
 */
export async function readQueue(queueFile) {
  let raw
  try {
    raw = await readFile(queueFile, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed?.entries)) throw new Error(`malformed retirement queue: ${queueFile}`)
  return parsed.entries.filter((entry) => typeof entry?.id === 'string' && typeof entry?.dir === 'string')
}

/** Replace the queue atomically; an empty entry list removes the file. */
export async function writeQueue(queueFile, entries) {
  if (entries.length === 0) {
    await rm(queueFile, { force: true })
    return
  }
  const body = `${JSON.stringify({ version: 1, entries }, null, 2)}\n`
  const tmp = `${queueFile}.${process.pid}.tmp`
  await writeFile(tmp, body, { mode: 0o600 })
  await rename(tmp, queueFile)
}

/**
 * Move one session directory into the vault. Rename is preferred; a
 * cross-device target falls back to a recursive copy followed by removal of
 * the source, which is still a move and never leaves the source truncated.
 * @returns `moved`, `exists` (target already present), or `missing` (source gone).
 */
export async function moveIntoVault(source, vaultDir, id) {
  const target = join(vaultDir, id)
  try {
    await stat(target)
    return 'exists'
  } catch {
    // target free
  }
  try {
    await stat(source)
  } catch {
    return 'missing'
  }
  await mkdir(vaultDir, { recursive: true })
  try {
    await rename(source, target)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    const { cp } = await import('node:fs/promises')
    await cp(source, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
    await rm(source, { recursive: true, force: true })
  }
  return 'moved'
}

/**
 * Drain the queue into the vault. An entry whose session is live again stays
 * queued; an entry whose session is no longer archived is dropped, because
 * unarchiving voids the retirement intent and moving the log of a session that
 * is still listed would strand it; an unknown archive state (the registry is
 * not ready yet) also stays queued. Entries whose target already exists or
 * whose directory vanished are handled without failing the rest.
 * @param options.queueFile - durable queue path.
 * @param options.vaultDir - `Session-Time-Vault`.
 * @param options.isLive - id predicate for sessions the store currently owns.
 * @param options.isArchived - id predicate for the registry's archive set, or
 *   `undefined` when the registry cannot answer yet.
 * @returns counts plus the entries left queued.
 */
export async function drainQueue({
  queueFile,
  vaultDir,
  isLive = () => false,
  isArchived = () => true,
}) {
  const entries = await readQueue(queueFile)
  const remaining = []
  const result = { moved: 0, skipped: 0, kept: 0, voided: 0 }
  for (const entry of entries) {
    if (isLive(entry.id)) {
      remaining.push(entry)
      result.kept += 1
      continue
    }
    const archived = isArchived(entry.id)
    if (archived === false) {
      result.voided += 1
      continue
    }
    if (archived !== true) {
      remaining.push(entry)
      result.kept += 1
      continue
    }
    try {
      const outcome = await moveIntoVault(entry.dir, vaultDir, entry.id)
      if (outcome === 'moved') result.moved += 1
      else result.skipped += 1
      if (outcome === 'exists') {
        // The vault already holds this id; do not keep re-trying it.
        continue
      }
      if (outcome === 'missing') {
        // Nothing to move; the id stays archived but has no artifact.
        continue
      }
    } catch (error) {
      remaining.push({ ...entry, error: String(error?.message ?? error) })
      result.kept += 1
    }
  }
  await writeQueue(queueFile, remaining)
  return { ...result, remaining }
}
