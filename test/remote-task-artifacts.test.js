import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { taskArtifactPaths, artifactUsageCommand, parseArtifactUsage, artifactRemovalCommand } from '../src/remote-task-artifacts.js'
import { TaskStore } from '../src/task-store.js'
import { AdminService } from '../src/admin-service.js'
import { runProcess } from '../src/process-runner.js'

async function fixture (t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-artifacts-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = path.join(root, 'remote-backups')
  await mkdir(directory)
  await writeFile(path.join(directory, 'backup.tar.gz'), 'backup')
  const remotePath = '/var/lib/webminai/task-state/1'
  const tasks = new TaskStore(root)
  const task = tasks.create('host', 'Create backup')
  const plan = { summary: 'Back up', changeOverview: 'Create backup', modifiedFiles: [remotePath], commands: [{ id: 'backup', command: `tar -czf '${remotePath}/backup.tar.gz' /srv/app`, purpose: 'Backup', risk: 'change', requiresSudo: true, timeoutMs: 300000, dependsOn: [] }], revertCommands: [] }
  tasks.savePlan('host', task.id, plan)
  tasks.saveResults('host', task.id, [{ id: 'backup', status: 'completed' }])
  const settings = { servers: { host: { historyId: 'host' } } }
  const admin = new AdminService({ dataRoot: root, tasks })
  admin.serverSecrets = async () => ({})
  const calls = []
  const client = {
    health: async () => ({ platform: 'linux' }),
    runCommand: async command => {
      calls.push(command)
      const result = await runProcess('/bin/sh', ['-c', command.replaceAll(remotePath, directory)], { timeoutMs: 10000 })
      return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr }
    }
  }
  admin.netdata = () => client
  return { root, directory, remotePath, tasks, admin, client, calls, args: { settings, passphrase: 'fixture', serverId: 'host', taskId: task.id } }
}

test('artifact paths are limited to exact task-state directories referenced by saved history', () => {
  const tasks = [{ id: 3, plan: { modifiedFiles: ['/var/lib/webminai/task-state/3/backup.tar.gz', '/var/lib/webminai/task-state/30/other', '/var/lib/webminai/action.key'], commands: [{ command: 'state=/var/db/webminai/task-state/3-app\ntrue' }] } }, { id: 4, plan: { modifiedFiles: ['C:\\ProgramData\\WebminAI\\Tasks\\4-backup\\archive.zip'] } }]
  assert.deepEqual(taskArtifactPaths(tasks), ['C:/ProgramData/WebminAI/Tasks/4-backup', '/var/db/webminai/task-state/3-app', '/var/lib/webminai/task-state/3'].sort())
  for (const value of ['/var/lib/webminai', '/var/lib/webminai/task-state', '/var/lib/webminai/task-state/1/../../etc', '/etc']) assert.throws(() => artifactUsageCommand([value], 'linux'), /Unsafe/u)
  assert.throws(() => parseArtifactUsage('0 invalid\n', ['/var/lib/webminai/task-state/1'], 'linux'))
  assert.throws(() => artifactRemovalCommand([{ path: '/var/lib/webminai/task-state/1', bytes: 1, identity: "'; rm /" }], 'linux'))
})

test('inspection reports space and reviewed removal preserves local history but disables rollback and retry reuse', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t)
  const snapshot = await f.admin.inspectTaskArtifacts(f.args)
  const beforeVersion = f.tasks.stateVersion('host', 1)
  assert.ok(snapshot.totalBytes >= 1024)
  assert.equal(await readFile(path.join(f.directory, 'backup.tar.gz'), 'utf8'), 'backup')
  await assert.rejects(f.admin.removeTaskArtifacts({ ...f.args, fingerprint: snapshot.fingerprint }), /approval/u)
  const result = await f.admin.removeTaskArtifacts({ ...f.args, fingerprint: snapshot.fingerprint, approved: true })
  assert.equal(result.historyRetained, true)
  assert.notEqual(f.tasks.stateVersion('host', 1), beforeVersion)
  assert.equal(f.tasks.get('host', 1).status, 'completed')
  await assert.rejects(lstat(f.directory), { code: 'ENOENT' })
  assert.throws(() => f.tasks.assertArtifactsAvailable('host', 1), /artifacts were removed/u)
  const retry = f.tasks.create('host', 'Retry backup', { retryOfTaskId: 1 })
  assert.throws(() => f.tasks.assertArtifactsAvailable('host', retry.id), /artifacts were removed/u)
})

test('stale usage and symlinks fail closed without deleting artifacts', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t)
  const snapshot = await f.admin.inspectTaskArtifacts(f.args)
  await writeFile(path.join(f.directory, 'new-archive'), Buffer.alloc(100000))
  await assert.rejects(f.admin.removeTaskArtifacts({ ...f.args, fingerprint: snapshot.fingerprint, approved: true }), /storage changed/u)
  assert.equal(f.tasks.artifactCleanupState('host', 1).length, 0)
  const moved = path.join(f.root, 'symlink-target')
  await mkdir(moved)
  await rm(f.directory, { recursive: true })
  await symlink(moved, f.directory)
  await assert.rejects(f.admin.inspectTaskArtifacts(f.args), /inspection unavailable/u)
  assert.ok((await lstat(moved)).isDirectory())
})

test('unknown cleanup persists a safety marker and is never automatically replayed', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t)
  const snapshot = await f.admin.inspectTaskArtifacts(f.args)
  const original = f.client.runCommand
  let removals = 0
  f.client.runCommand = async command => { if (command.includes('-depth -delete')) { removals++; throw new Error('Connection lost') }; return original(command) }
  await assert.rejects(f.admin.removeTaskArtifacts({ ...f.args, fingerprint: snapshot.fingerprint, approved: true }), /Connection lost/u)
  assert.equal(removals, 1)
  const reopened = new TaskStore(f.root)
  assert.equal(reopened.artifactCleanupState('host', 1)[0].status, 'unknown')
  assert.throws(() => reopened.assertArtifactsAvailable('host', 1), /cleanup is uncertain/u)
  assert.ok((await lstat(f.directory)).isDirectory())
})

test('Windows usage preserves logical-byte semantics and cleanup rejects reparse points', () => {
  const directory = 'C:/ProgramData/WebminAI/Tasks/1-backup'
  const command = artifactUsageCommand([directory], 'windows')
  assert.match(command, /-EncodedCommand/u)
  assert.deepEqual(parseArtifactUsage(JSON.stringify([{ path: directory, bytes: 1234, identity: '111:222' }]), [directory], 'windows'), [{ path: directory, bytes: 1234, identity: '111:222' }])
  assert.throws(() => parseArtifactUsage(JSON.stringify([{ path: 'C:/Windows', bytes: 1234, identity: '111:222' }]), [directory], 'windows'))
  assert.throws(() => parseArtifactUsage(JSON.stringify([{ path: directory, bytes: 1234, identity: '111:222', secret: 'must not be retained' }]), [directory], 'windows'))
  const removal = artifactRemovalCommand([{ path: directory, bytes: 1234, identity: '111:222' }], 'windows')
  assert.match(Buffer.from(removal.split(' ').at(-1), 'base64').toString('utf16le'), /Nested reparse point refused/u)
})
