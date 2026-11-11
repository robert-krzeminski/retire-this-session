import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { describeTree, drainQueue, findSessionDir, planRetirement, readQueue, treeOf, writeQueue } from '../plan.js'

const header = (id, extra = {}) => ({ id, cwd: '/home/pi/DSH', isSeeded: false, ...extra })

test('treeOf walks forks, subagents, and a fork of a fork', () => {
  const headers = new Map([
    ['root', header('root')],
    ['fork', header('fork', { parentSession: 'root', isSeeded: true })],
    ['fork2', header('fork2', { parentSession: 'fork', isSeeded: true })],
    ['sub', header('sub', { parentSession: 'root', origin: 'subagent', delegationDepth: 1 })],
    ['other', header('other')],
  ])
  const members = treeOf(headers, 'root')
  assert.deepEqual(members.map((m) => m.id), ['root', 'fork', 'sub', 'fork2'])
  assert.deepEqual(members.map((m) => m.kind), ['session', 'fork', 'subagent', 'fork'])
  assert.equal(members[3].depth, 2)
  assert.ok(!members.some((m) => m.id === 'other'))
})

test('treeOf returns nothing for an unknown root', () => {
  assert.deepEqual(treeOf(new Map(), 'root'), [])
})

test('planRetirement accepts a consistent tree', () => {
  const headers = new Map([['root', header('root')], ['sub', header('sub', { parentSession: 'root', origin: 'subagent' })]])
  const plan = planRetirement({ headers, rootId: 'root', pinned: new Set(), archived: new Set() })
  assert.equal(plan.ok, true)
  assert.equal(plan.members.length, 2)
})

test('planRetirement refuses a missing root', () => {
  const plan = planRetirement({ headers: new Map(), rootId: 'ghost' })
  assert.equal(plan.ok, false)
  assert.match(plan.reason, /no stored header/)
})

test('planRetirement refuses a mixed cwd', () => {
  const headers = new Map([['root', header('root')], ['sub', header('sub', { parentSession: 'root', cwd: '/tmp' })]])
  const plan = planRetirement({ headers, rootId: 'root' })
  assert.equal(plan.ok, false)
  assert.match(plan.reason, /cwd differs/)
})

test('planRetirement refuses a pinned member and flags an archived one', () => {
  const headers = new Map([['root', header('root')], ['sub', header('sub', { parentSession: 'root' })]])
  assert.match(planRetirement({ headers, rootId: 'root', pinned: new Set(['sub']) }).reason, /pinned: sub/)
  const plan = planRetirement({ headers, rootId: 'root', archived: new Set(['sub']) })
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.members.map((m) => [m.id, m.archived]), [['root', false], ['sub', true]])
})

test('describeTree nests children under their parent', () => {
  const headers = new Map([
    ['root', header('root')],
    ['a', header('a', { parentSession: 'root', isSeeded: true })],
    ['b', header('b', { parentSession: 'root', origin: 'subagent' })],
    ['a1', header('a1', { parentSession: 'a', isSeeded: true })],
  ])
  const rendered = describeTree(treeOf(headers, 'root'), 'root')
  assert.equal(rendered, ['root  [session]', '├── a  (fork)', '│   └── a1  (fork)', '└── b  (subagent, depth 1)'].join('\n'))
})

test('findSessionDir locates a session under its project directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retire-root-'))
  await mkdir(join(root, '--home-pi-DSH--', 'session-abc'), { recursive: true })
  assert.equal(await findSessionDir(root, 'session-abc'), join(root, '--home-pi-DSH--', 'session-abc'))
  assert.equal(await findSessionDir(root, 'session-nope'), undefined)
  assert.equal(await findSessionDir(join(root, 'absent'), 'session-abc'), undefined)
})

test('writeQueue is atomic, readable, and removes itself when empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'retire-queue-'))
  const file = join(dir, 'queue.json')
  await writeQueue(file, [{ id: 'a', dir: '/x/a', cwd: '/x', queuedAt: 1 }])
  assert.deepEqual(await readQueue(file), [{ id: 'a', dir: '/x/a', cwd: '/x', queuedAt: 1 }])
  await writeQueue(file, [])
  assert.deepEqual(await readQueue(file), [])
  await assert.rejects(readFile(file, 'utf8'))
})

test('readQueue ignores malformed entries but refuses a malformed file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'retire-queue-'))
  const file = join(dir, 'queue.json')
  await writeFile(file, JSON.stringify({ version: 1, entries: [{ id: 'a', dir: '/x/a' }, { nope: true }] }))
  assert.equal((await readQueue(file)).length, 1)
  await writeFile(file, JSON.stringify({ nope: true }))
  await assert.rejects(readQueue(file), /malformed/)
})

test('drainQueue moves queued directories, keeps live ones, and drops vanished ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'retire-drain-'))
  const sessions = join(dir, 'sessions', '--x--')
  const vault = join(dir, 'vault')
  const queueFile = join(dir, 'queue.json')
  await mkdir(join(sessions, 'session-a'), { recursive: true })
  await writeFile(join(sessions, 'session-a', 'session.v4.jsonl.zstd'), 'log-a')
  await mkdir(join(sessions, 'session-live'), { recursive: true })
  await writeQueue(queueFile, [
    { id: 'session-a', dir: join(sessions, 'session-a'), cwd: '/x', queuedAt: 1 },
    { id: 'session-live', dir: join(sessions, 'session-live'), cwd: '/x', queuedAt: 2 },
    { id: 'session-gone', dir: join(sessions, 'session-gone'), cwd: '/x', queuedAt: 3 },
  ])
  const result = await drainQueue({ queueFile, vaultDir: vault, isLive: (id) => id === 'session-live' })
  assert.equal(result.moved, 1)
  assert.equal(result.skipped, 1)
  assert.equal(result.kept, 1)
  assert.equal(await readFile(join(vault, 'session-a', 'session.v4.jsonl.zstd'), 'utf8'), 'log-a')
  assert.deepEqual((await readQueue(queueFile)).map((e) => e.id), ['session-live'])
})

test('drainQueue does not overwrite an id already in the vault', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'retire-drain-'))
  const sessions = join(dir, 'sessions', '--x--')
  const vault = join(dir, 'vault')
  const queueFile = join(dir, 'queue.json')
  await mkdir(join(sessions, 'session-a'), { recursive: true })
  await mkdir(join(vault, 'session-a'), { recursive: true })
  await writeFile(join(vault, 'session-a', 'marker'), 'keep')
  await writeQueue(queueFile, [{ id: 'session-a', dir: join(sessions, 'session-a'), cwd: '/x', queuedAt: 1 }])
  const result = await drainQueue({ queueFile, vaultDir: vault, isLive: () => false })
  assert.equal(result.moved, 0)
  assert.equal(await readFile(join(vault, 'session-a', 'marker'), 'utf8'), 'keep')
  assert.deepEqual(await readQueue(queueFile), [])
})

test('drainQueue voids an entry whose session is not archived and keeps an unknown one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'retire-drain-'))
  const vault = join(dir, 'vault')
  const queueFile = join(dir, 'queue.json')
  await writeQueue(queueFile, [
    { id: 'archived', dir: join(dir, 'archived'), cwd: '/x', queuedAt: 1 },
    { id: 'unarchived', dir: join(dir, 'unarchived'), cwd: '/x', queuedAt: 2 },
    { id: 'unknown', dir: join(dir, 'unknown'), cwd: '/x', queuedAt: 3 },
  ])
  await mkdir(join(dir, 'archived'), { recursive: true })
  await writeFile(join(dir, 'archived', 'log'), 'a')
  await mkdir(join(dir, 'unarchived'), { recursive: true })
  await writeFile(join(dir, 'unarchived', 'log'), 'b')
  const result = await drainQueue({
    queueFile,
    vaultDir: vault,
    isLive: () => false,
    isArchived: (id) => (id === 'unknown' ? undefined : id === 'archived'),
  })
  assert.equal(result.moved, 1)
  assert.equal(result.voided, 1)
  assert.equal(result.kept, 1)
  assert.deepEqual(result.remaining.map((e) => e.id), ['unknown'])
  assert.deepEqual(await readQueue(queueFile), [{ id: 'unknown', dir: join(dir, 'unknown'), cwd: '/x', queuedAt: 3 }])
  assert.equal(await readFile(join(vault, 'archived', 'log'), 'utf8'), 'a')
  await assert.rejects(readFile(join(vault, 'unarchived', 'log'), 'utf8'))
})
