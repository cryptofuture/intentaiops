import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { freebsdHostIdChangeScript, replaceFreeBsdHostId } from '../src/freebsd-machine-identity.js'
import { runProcess } from '../src/process-runner.js'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const previous = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const next = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const fingerprint = uuid => `SHA256:${createHash('sha256').update(`freebsd:${uuid}`).digest('hex')}`

test('FreeBSD identity repair uses native services with guarded persistent files, not SMBIOS reset', async () => {
  const script = freebsdHostIdChangeScript(previous, next)
  for (const values of [[previous, previous], [previous, '00000000-0000-0000-0000-000000000000'], ['invalid', next], [previous, "'; reboot"]]) assert.throws(() => freebsdHostIdChangeScript(...values))
  for (const fragment of ['security.jail.jailed', 'kern.securelevel', 'kstat.zfs', 'zpool list -H -o name', 'check_config hostid_save', 'test ! -L /etc', 'stat -f', 'mkdir -m 700', 'service hostid onestart', 'service hostid_save onestart', 'kern.hostid', '/etc/machine-id']) assert.ok(script.includes(fragment), fragment)
  assert.doesNotMatch(script, /hostid reset|hostid onereset|reboot|sysrc .*=/u)
  assert.ok(script.indexOf('zpool list') < script.indexOf('mv -f'))
  assert.ok(script.indexOf('check_config hostid_save') < script.indexOf('mv -f'))
  if (process.platform !== 'win32') assert.equal((await runProcess('/bin/sh', ['-n'], { input: script })).code, 0)
})

test('FreeBSD replacement rechecks the old UUID and verifies the new identity before enrollment', async () => {
  let current = previous; let writes = 0
  const ssh = { hostFingerprint: async () => fingerprint(current), execute: async () => ({ stdout: current }) }
  const result = await replaceFreeBsdHostId({
    ssh,
    connectionUrl: 'ssh://freebsd',
    expectedFingerprint: fingerprint(previous),
    runElevated: async script => {
      writes++
      current = script.match(/prepare \/etc\/hostid "\$host_tmp" '([a-f0-9-]{36})'/u)[1]
      return { code: 0, stdout: 'WEBMINAI_FREEBSD_HOST_ID_CHANGED\n' }
    }
  })
  assert.equal(writes, 1)
  assert.equal(result, fingerprint(current))
  assert.notEqual(current, previous)
})

test('stale UUIDs, failed guards and lost acknowledgments never authorize another write', async () => {
  let writes = 0
  const ssh = { hostFingerprint: async () => fingerprint(previous), execute: async () => ({ stdout: previous }) }
  const options = { ssh, connectionUrl: 'ssh://freebsd', expectedFingerprint: fingerprint(previous), runElevated: async () => { writes++; return { code: 78, stdout: '' } } }
  await assert.rejects(replaceFreeBsdHostId({ ...options, expectedFingerprint: fingerprint(next) }), /changed before confirmation/u)
  assert.equal(writes, 0)
  await assert.rejects(replaceFreeBsdHostId(options), /Inspect kern.hostuuid/u)
  assert.equal(writes, 1)
  await assert.rejects(replaceFreeBsdHostId({ ...options, runElevated: async () => { writes++; throw new Error('SSH disconnected after dispatch') } }), /no automatic retry/u)
  assert.equal(writes, 2)
})

test('FreeBSD jail, securelevel and imported ZFS guards exit before mutation', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-freebsd-preflight-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'etc'))
  await writeFile(path.join(root, 'etc/hostid'), previous)
  await writeFile(path.join(root, 'etc/machine-id'), previous.replaceAll('-', ''))
  const script = freebsdHostIdChangeScript(previous, next)
  const preflight = script.slice(0, script.indexOf('check_config()')).replaceAll('/etc', `${root}/etc`).replace('test "$(uname -s)" = FreeBSD', ':').replace('test "$(id -u)" = 0', ':').replace(/for tool in [^\n]+/u, ':').replace('stat -f \'%u %Lp %l\' "$p"', "printf '0 444 1'").replaceAll('/sbin/sysctl', 'mock_sysctl').replaceAll('/sbin/mount', 'mock_mount').replaceAll('zpool', 'mock_zpool')
  for (const [jail, securelevel, zfs, expected] of [[0, 0, false, 0], [1, 0, false, 1], [0, 1, false, 1], [0, 0, true, 78]]) {
    const mocks = `mock_sysctl(){ case "$2" in security.jail.jailed) echo ${jail};; kern.securelevel) echo ${securelevel};; kern.hostuuid) echo ${previous};; kstat.zfs) return ${zfs ? 0 : 1};; *) return 1;; esac; }; mock_mount(){ printf '%s\\n' '/dev/test / ufs rw 0 0'; }; mock_zpool(){ echo zroot; };\n`
    const result = await runProcess('/bin/sh', ['-c', mocks + preflight])
    assert.equal(result.code, expected, result.stderr)
    assert.equal(await readFile(path.join(root, 'etc/hostid'), 'utf8'), previous)
  }
})
