import assert from 'node:assert/strict'
import { copyFile, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { downloadRemoteFile, fileTransferDescription, validateFileTransfer } from '../src/local-file-transfer.js'
import { executeApprovedPlan, validateCommandPlan } from '../src/plan-validator.js'
import { rootExecutionPolicy } from '../src/execution-policy.js'
import { runProcess } from '../src/process-runner.js'
import { planFingerprint } from '../src/execution-journal.js'
import { AdminService } from '../src/admin-service.js'

async function fixture (t, removeSource = false) {
  const root = await mkdtemp(path.join(await realpath(os.homedir()), 'intent-transfer-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const remotePath = path.join(root, 'source.tar.gz')
  const localPath = path.join(root, 'backup.tar.gz')
  await writeFile(remotePath, 'backup payload\0with binary bytes')
  const fileTransfer = { remotePath, localPath, removeSource }
  const item = { id: 'download', purpose: 'Save backup locally', command: fileTransferDescription(fileTransfer), executionMode: 'download', fileTransfer, risk: removeSource ? 'destructive' : 'change', requiresSudo: true, timeoutMs: 300000, dependsOn: [] }
  const calls = []
  const netdata = {
    health: async () => ({ platform: 'linux' }),
    async runCommand (command) {
      calls.push(command)
      const result = await runProcess('/bin/sh', ['-c', command], { timeoutMs: 10000 })
      return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr }
    }
  }
  const ssh = {
    execute: async () => ({ stdout: `${process.getuid()}\n${process.getgid()}\n` }),
    download: async (_url, source, destination) => copyFile(source, destination)
  }
  const plan = { summary: 'Download backup', changeOverview: item.command, modifiedFiles: [localPath], requiresConfirmation: true, commands: [item], revertCommands: [] }
  return { item, plan, ssh, netdata, calls, root, remotePath, localPath, connectionUrl: 'ssh://fixture' }
}

test('transfer validation rejects traversal, hidden destinations and arbitrary executable data', () => {
  const transfer = { remotePath: '/srv/backup.tar.gz', localPath: path.join(os.homedir(), 'backup.tar.gz'), removeSource: false }
  assert.deepEqual(validateFileTransfer(transfer), transfer)
  for (const patch of [{ remotePath: '/srv/../etc/passwd' }, { remotePath: '/srv/file\nrm -rf /' }, { localPath: path.resolve(os.homedir(), '..', 'elsewhere') }, { localPath: path.join(os.homedir(), '.ssh', 'file') }, { removeSource: 'yes' }, { shell: 'rm -rf /' }]) assert.throws(() => validateFileTransfer({ ...transfer, ...patch }))
})

test('download plans bind paths, cleanup and risk to approval without permitting retries or local shell', async t => {
  const f = await fixture(t)
  const policy = rootExecutionPolicy({})
  validateCommandPlan(f.plan, policy)
  const changed = structuredClone(f.plan)
  changed.commands[0].fileTransfer.localPath = path.join(f.root, 'other.tar.gz')
  assert.notEqual(planFingerprint(changed), planFingerprint(f.plan))
  assert.throws(() => validateCommandPlan(changed, policy), /download semantics/u)
  for (const patch of [{ risk: 'read' }, { requiresSudo: false }, { command: 'touch local-file' }, { retry: { attempts: 2, intervalMs: 0, exitCodes: [1] } }]) assert.throws(() => validateCommandPlan({ ...f.plan, commands: [{ ...f.item, ...patch }] }, policy))
  let downloads = 0
  const result = await executeApprovedPlan({ plan: f.plan, policy, netdata: f.netdata, download: async () => { downloads++; return { exitCode: 0 } }, approve: async () => false })
  assert.equal(downloads, 0)
  assert.equal(result[0].status, 'rejected')
})

for (const removeSource of [false, true]) {
  test(`Unix transfer verifies a real local file before optional cleanup: ${removeSource}`, { skip: process.platform !== 'linux' }, async t => {
    const f = await fixture(t, removeSource)
    const result = await downloadRemoteFile(f)
    assert.equal(result.exitCode, 0)
    assert.equal(await readFile(f.localPath, 'utf8'), 'backup payload\0with binary bytes')
    assert.equal((await lstat(f.localPath)).mode & 0o777, 0o600)
    if (removeSource) await assert.rejects(lstat(f.remotePath), { code: 'ENOENT' })
    else assert.ok((await lstat(f.remotePath)).isFile())
  })
}

test('failed SCP and checksum mismatches preserve the source and never publish a partial local file', { skip: process.platform !== 'linux' }, async t => {
  for (const corrupt of [false, true]) {
    const f = await fixture(t, true)
    f.ssh.download = async (_url, _source, destination) => { if (!corrupt) throw new Error('connection lost'); await writeFile(destination, 'corrupt') }
    await assert.rejects(downloadRemoteFile(f), /connection lost|checksum mismatch/u)
    assert.ok((await lstat(f.remotePath)).isFile())
    await assert.rejects(lstat(f.localPath), { code: 'ENOENT' })
  }
})

test('existing destinations and remote symlinks cannot be overwritten or deleted', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, true)
  await writeFile(f.localPath, 'original local data')
  await assert.rejects(downloadRemoteFile(f), /already exists/u)
  assert.equal(f.calls.length, 0)
  assert.equal(await readFile(f.localPath, 'utf8'), 'original local data')
  await rm(f.localPath)
  const link = path.join(f.root, 'source-link')
  await symlink(f.remotePath, link)
  f.item.fileTransfer.remotePath = link
  await assert.rejects(downloadRemoteFile(f), /staging failed/u)
  assert.ok((await lstat(f.remotePath)).isFile())
})

test('changed source prevents deletion even after a verified local download', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, true)
  f.ssh.download = async (_url, source, destination) => { await copyFile(source, destination); await writeFile(f.remotePath, 'new unrelated content') }
  await assert.rejects(downloadRemoteFile(f), /cleanup was not confirmed/u)
  assert.equal(await readFile(f.remotePath, 'utf8'), 'new unrelated content')
  assert.equal(await readFile(f.localPath, 'utf8'), 'backup payload\0with binary bytes')
})

test('unconfirmed staging cleanup preserves the source and is not silently retried', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, true)
  const original = f.netdata.runCommand
  let cleanupCommand; let cleanups = 0
  f.netdata.runCommand = async command => {
    if (command.startsWith('set -eu; test ! -L')) { cleanupCommand = command; cleanups++; return { exitCode: 1, stdout: '', stderr: 'denied' } }
    return original(command)
  }
  t.after(async () => { if (cleanupCommand) await original(cleanupCommand) })
  await assert.rejects(downloadRemoteFile(f), /staging cleanup was not confirmed/u)
  assert.equal(cleanups, 1)
  assert.ok((await lstat(f.remotePath)).isFile())
  assert.ok((await lstat(f.localPath)).isFile())
})

test('AdminService routes a reviewed download through the shared handler, not remote shell execution', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t)
  const context = { ssh: f.ssh, serverSecrets: async () => ({ connectionUrl: f.connectionUrl }), workspace: { loadRules: async () => ({ policy: rootExecutionPolicy({}) }) }, netdata: () => f.netdata }
  const result = await AdminService.prototype.execute.call(context, { settings: {}, passphrase: 'fixture', serverId: 'fixture', plan: f.plan, approve: async () => true })
  assert.equal(result[0].status, 'completed')
  assert.ok(f.calls.every(command => command !== f.item.command))
  assert.equal(await readFile(f.localPath, 'utf8'), 'backup payload\0with binary bytes')
})

test('SCP reports live local file growth followed by separate checksum verification', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t)
  const events = []
  f.ssh.download = async (_url, source, destination) => {
    await writeFile(destination, 'backup')
    await new Promise(resolve => setTimeout(resolve, 1150))
    await copyFile(source, destination)
  }
  await downloadRemoteFile({ ...f, onProgress: event => events.push(event) })
  assert.ok(events.some(event => event.phase === 'download' && event.localBytes > 0 && event.localBytes < event.totalBytes))
  assert.equal(events[0].localBytes, 0)
  assert.equal(events.at(-2).phase, 'verify')
  assert.equal(events.at(-1).phase, 'verified')
  assert.ok(events.every(event => event.type === 'transfer_progress' && event.commandId === 'download' && event.percent >= 0 && event.percent <= 100))
  assert.ok(!JSON.stringify(events).includes('with binary bytes'))
})

test('destination races and unsupported targets cannot cause remote deletion', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t, true)
  f.ssh.download = async (_url, source, destination) => { await copyFile(source, destination); await writeFile(f.localPath, 'another task won this filename') }
  await assert.rejects(downloadRemoteFile(f), { code: 'EEXIST' })
  assert.equal(await readFile(f.localPath, 'utf8'), 'another task won this filename')
  assert.ok((await lstat(f.remotePath)).isFile())
  await rm(f.localPath)
  const calls = f.calls.length
  f.netdata.health = async () => ({ platform: 'windows' })
  await assert.rejects(downloadRemoteFile(f), /Unix SSH host/u)
  assert.equal(f.calls.length, calls)
})

test('uncertain transfer is journaled and never replayed; confirmed downloads are skipped on resume', async t => {
  const f = await fixture(t)
  let attempts = 0
  const events = []
  const options = { plan: f.plan, policy: rootExecutionPolicy({}), netdata: {}, approve: async () => true, download: async () => { attempts++; throw new Error('lost connection after local receipt') }, onExecutionEvent: async event => events.push(event) }
  const results = await executeApprovedPlan(options)
  assert.equal(attempts, 1)
  assert.equal(results[0].recoveryRequired, true)
  assert.ok(events.some(event => event.type === 'command_outcome_unknown'))
  await executeApprovedPlan({ ...options, completedCommandIds: ['download'] })
  assert.equal(attempts, 1)
})
