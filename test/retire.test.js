import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { readQueue, writeQueue } from '../plan.js'

const header = (id, extra = {}) => ({ id, cwd: '/home/pi/tmp', isSeeded: false, ...extra })

/**
 * A host that behaves like the real one where it matters: archiveSession
 * refuses a running session unless `stopActivity` is passed, which is exactly
 * the situation the calling session is always in.
 */
async function host({ tree = [['root', {}], ['fork', { parentSession: 'root', isSeeded: true }], ['sub', { parentSession: 'root', origin: 'subagent' }]], failOn } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'retire-host-'))
  const sessionsRoot = join(home, 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  const headers = new Map()
  for (const [id, extra] of tree) {
    headers.set(id, header(id, extra))
    await mkdir(join(sessionsRoot, '--home-pi-tmp--', id), { recursive: true })
    await writeFile(join(sessionsRoot, '--home-pi-tmp--', id, 'session.v4.jsonl.zstd'), id)
  }
  const archives = []
  const answers = []
  const questions = []
  let asked = 0
  const registry = {
    pinnedSessionIds: [],
    archivedSessionIds: [],
    async archiveSession(id, options) {
      if (failOn === id) throw new Error(`cannot archive session '${id}': simulated failure`)
      if (options?.stopActivity !== true) throw new Error(`cannot archive session '${id}': the session is active (turn)`)
      archives.push({ id, stopActivity: options.stopActivity })
      registry.archivedSessionIds = [...registry.archivedSessionIds, id]
    },
    async unarchiveSession(id) {
      registry.archivedSessionIds = registry.archivedSessionIds.filter((value) => value !== id)
    },
  }
  const store = { list: () => [...headers.values()].map((value) => ({ header: value })), get: () => undefined }
  const definition = {}
  const ctx = {
    get: (name) => ({
      sessionPersistence: { list: async () => [...headers.values()].map((value) => ({ header: value })) },
      sessions: store,
      workspaceRegistry: registry,
      userQuestions: {
        ask: async (payload) => {
          asked += 1
          questions.push(payload)
          const selected = answers.length > 0 ? answers.shift() : ['Retire']
          return { answers: [{ id: 'retire-confirm', selected }] }
        },
      },
    })[name],
    tools: { register: (value) => Object.assign(definition, value) },
    logger: { info() {}, warn() {} },
  }
  ctx.inject = (_deps, callback) => callback(ctx)
  apply(ctx, { dshHome: home })
  const exec = { agent: { session: { id: 'root' } } }
  const run = (args = {}) => definition.execute(args, exec)
  const queueFile = join(home, 'session-retirement-queue.json')
  return { home, registry, archives, queueFile, run, answers, questions, asked: () => asked }
}

test('retire archives children before the root, with stopActivity, and queues every directory', async () => {
  const env = await host()
  const result = await env.run()
  assert.equal(result.status, 'retired')
  assert.equal(result.queued, 3)
  assert.deepEqual(env.archives.map((entry) => entry.id), ['fork', 'sub', 'root'])
  assert.ok(env.archives.every((entry) => entry.stopActivity === true))
  assert.deepEqual((await readQueue(env.queueFile)).map((entry) => entry.id), ['fork', 'sub', 'root'])
  assert.equal(env.asked(), 1)
})

test('dry_run plans the tree without asking, archiving, or queueing', async () => {
  const env = await host()
  const result = await env.run({ dry_run: true })
  assert.equal(result.status, 'planned')
  assert.deepEqual(env.archives, [])
  assert.deepEqual(await readQueue(env.queueFile), [])
  assert.equal(env.asked(), 0)
})

test('the confirmation detail fences the tree so its lines survive Markdown', async () => {
  const env = await host()
  await env.run()
  const detail = env.questions[0].questions[0].detail
  assert.ok(detail.startsWith('```\nroot  [session]\n'))
  assert.ok(detail.includes('\n└── session-') || detail.includes('\n├── fork'))
  assert.ok(detail.includes('```\n\nEvery member is archived'))
  assert.ok(detail.includes(join(env.home, 'Session-Time-Vault')))
  assert.ok(detail.includes(join(env.home, 'gui-log.log')))
})

test('a cancelled confirmation changes nothing', async () => {
  const env = await host()
  env.answers.push(['Cancel'])
  const result = await env.run()
  assert.equal(result.status, 'cancelled')
  assert.deepEqual(env.archives, [])
  assert.deepEqual(await readQueue(env.queueFile), [])
})

test('a second retirement is a no-op that does not ask again', async () => {
  const env = await host()
  assert.equal((await env.run()).status, 'retired')
  const result = await env.run()
  assert.equal(result.status, 'already-retired')
  assert.equal(env.asked(), 1)
  assert.equal((await readQueue(env.queueFile)).length, 3)
})

test('a failure on the root rolls the children back and empties the new queue entries', async () => {
  const env = await host({ failOn: 'root' })
  const result = await env.run()
  assert.equal(result.status, 'aborted')
  assert.match(result.reason, /simulated failure/)
  assert.deepEqual(env.registry.archivedSessionIds, [])
  assert.deepEqual(await readQueue(env.queueFile), [])
})

test('an already-archived fork is not archived again but is still queued', async () => {
  const env = await host()
  env.registry.archivedSessionIds = ['fork']
  const result = await env.run()
  assert.equal(result.status, 'retired')
  assert.deepEqual(env.archives.map((entry) => entry.id), ['sub', 'root'])
  assert.deepEqual((await readQueue(env.queueFile)).map((entry) => entry.id), ['fork', 'sub', 'root'])
})

test('the startup drain waits for the registry, then moves an archived entry', async () => {
  const home = await mkdtemp(join(tmpdir(), 'retire-host-'))
  const queueFile = join(home, 'session-retirement-queue.json')
  const sessionDir = join(home, 'sessions', '--home-pi-tmp--', 'session-old')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'log')
  await writeQueue(queueFile, [{ id: 'session-old', dir: sessionDir, cwd: '/home/pi/tmp', queuedAt: 1 }])
  const registry = { pinnedSessionIds: [], archivedSessionIds: [] }
  const deferred = []
  apply({
    get: (name) => ({
      sessions: { get: () => undefined, list: () => [] },
      workspaceRegistry: registry,
    })[name],
    inject: (_deps, callback) => deferred.push(callback),
    tools: { register() {} },
    logger: { info() {}, warn() {} },
  }, { dshHome: home })

  // Nothing drains while the registry is absent: the queue is unchanged.
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual((await readQueue(queueFile)).map((entry) => entry.id), ['session-old'])
  assert.equal(deferred.length, 1)

  // The registry arrives with the id archived: the drain moves the directory.
  // (The unarchived case is covered by the next test.)
  registry.archivedSessionIds = ['session-old']
  deferred[0]({
    get: (name) => (name === 'sessions' ? { get: () => undefined, list: () => [] } : registry),
    logger: { info() {}, warn() {} },
  })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(await readQueue(queueFile), [])
  assert.equal(await readFile(join(home, 'Session-Time-Vault', 'session-old', 'session.v4.jsonl.zstd'), 'utf8'), 'log')
})

test('the startup drain voids an entry whose session is no longer archived', async () => {
  const home = await mkdtemp(join(tmpdir(), 'retire-host-'))
  const queueFile = join(home, 'session-retirement-queue.json')
  const sessionDir = join(home, 'sessions', '--home-pi-tmp--', 'session-old')
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'log')
  await writeQueue(queueFile, [{ id: 'session-old', dir: sessionDir, cwd: '/home/pi/tmp', queuedAt: 1 }])
  apply({
    get: (name) => ({
      sessions: { get: () => undefined, list: () => [] },
      workspaceRegistry: { pinnedSessionIds: [], archivedSessionIds: [] },
    })[name],
    inject: (_deps, callback) => callback({
      get: (name) => ({
        sessions: { get: () => undefined, list: () => [] },
        workspaceRegistry: { pinnedSessionIds: [], archivedSessionIds: [] },
      })[name],
      logger: { info() {}, warn() {} },
    }),
    tools: { register() {} },
    logger: { info() {}, warn() {} },
  }, { dshHome: home })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(await readQueue(queueFile), [])
  await assert.rejects(readFile(join(home, 'Session-Time-Vault', 'session-old', 'session.v4.jsonl.zstd'), 'utf8'))
})
