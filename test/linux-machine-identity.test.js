import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, chmod, lstat, symlink, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { linuxMachineIdChangeScript, replaceLinuxMachineId } from '../src/linux-machine-identity.js'
import { runProcess } from '../src/process-runner.js'

const previous = 'a'.repeat(32)
const fingerprint = value => `SHA256:${createHash('sha256').update(`linux:${value}`).digest('hex')}`

test('machine identity replacement uses only validated IDs and a fixed preconditioned Linux script', async () => {
  const script = linuxMachineIdChangeScript(previous, 'b'.repeat(32))
  for (const pair of [[previous, previous], [previous, '0'.repeat(32)], [previous, 'x; rm /'], ['invalid', 'b'.repeat(32)]]) assert.throws(() => linuxMachineIdChangeScript(...pair))
  assert.match(script, /test "\$\(id -u\)" = 0/u)
  assert.match(script, /mountinfo/u)
  assert.match(script, /readlink -f/u)
  assert.match(script, /stat -c '%u %g %a'/u)
  assert.match(script, /test "\$\(\(0\$3 & 0022\)\)" = 0/u)
  assert.doesNotMatch(script, /reboot|systemctl restart|ssh_host_/u)
  if (process.platform !== 'win32') assert.equal((await runProcess('/bin/sh', ['-n'], { input: script })).code, 0)
})

test('a confirmed replacement rechecks the old identity and verifies the new fingerprint', async () => {
  let current = previous; let writes = 0
  const ssh = { hostFingerprint: async () => fingerprint(current), execute: async () => ({ stdout: current }) }
  const result = await replaceLinuxMachineId({
    ssh,
    connectionUrl: 'ssh://fixture',
    expectedFingerprint: fingerprint(previous),
    runElevated: async script => {
      writes++
      current = script.match(/printf[^\n]*'([a-f0-9]{32})'/u)[1]
      return { code: 0, stdout: 'WEBMINAI_MACHINE_ID_CHANGED\n' }
    }
  })
  assert.equal(writes, 1)
  assert.notEqual(current, previous)
  assert.equal(result, fingerprint(current))
})

test('stale identity or an unconfirmed write never triggers an automatic retry', async () => {
  let writes = 0
  const ssh = { hostFingerprint: async () => fingerprint(previous), execute: async () => ({ stdout: previous }) }
  const options = { ssh, connectionUrl: 'ssh://fixture', expectedFingerprint: fingerprint(previous), runElevated: async () => { writes++; throw new Error('connection lost') } }
  await assert.rejects(replaceLinuxMachineId({ ...options, expectedFingerprint: fingerprint('c'.repeat(32)) }), /identity changed before/u)
  assert.equal(writes, 0)
  await assert.rejects(replaceLinuxMachineId(options), /Inspect \/etc\/machine-id/u)
  assert.equal(writes, 1)
})

for (const dbus of ['none', 'file', 'symlink']) {
  test(`identity script updates disposable Linux fixtures and preserves D-Bus layout: ${dbus}`, { skip: process.platform !== 'linux' }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'intent-machine-id-test-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    await mkdir(path.join(root, 'etc'), { recursive: true })
    await mkdir(path.join(root, 'var/lib/dbus'), { recursive: true })
    const main = path.join(root, 'etc/machine-id')
    const dbusFile = path.join(root, 'var/lib/dbus/machine-id')
    await writeFile(main, `${previous}\n`)
    await chmod(main, 0o444)
    if (dbus === 'file') { await writeFile(dbusFile, `${previous}\n`); await chmod(dbusFile, 0o644) }
    if (dbus === 'symlink') await symlink(main, dbusFile)
    const script = linuxMachineIdChangeScript(previous, 'b'.repeat(32)).replaceAll('/etc', `${root}/etc`).replaceAll('/var', `${root}/var`).replace('test "$(id -u)" = 0', `test "$(id -u)" = ${process.getuid()}`).replace('test "$1" = 0', `test "$1" = ${process.getuid()}`)
    const result = await runProcess('/bin/sh', ['-c', script], { timeoutMs: 15000 })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(await readFile(main, 'utf8'), `${'b'.repeat(32)}\n`)
    assert.equal((await lstat(main)).mode & 0o777, 0o444)
    if (dbus !== 'none') assert.equal(await readFile(dbusFile, 'utf8'), `${'b'.repeat(32)}\n`)
    if (dbus === 'symlink') assert.ok((await lstat(dbusFile)).isSymbolicLink())
    if (dbus === 'file') assert.equal((await lstat(dbusFile)).mode & 0o777, 0o644)
  })
}
