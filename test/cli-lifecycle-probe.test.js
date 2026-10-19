import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildCliLifecycleProbe } from '../scripts/cli-lifecycle-probe.js'

test('read-only probes fingerprint managed metadata, file contents, symlinks, packages and services', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-lifecycle-probe-'))
  try {
    const file = `${root}/operator's config`
    const link = `${root}/link`
    writeFileSync(file, 'password=fixture-private-value\n')
    symlinkSync('missing\n', link)
    const options = { paths: [file, link, `${root}/absent`, root], packageManager: 'apt', serviceManager: 'systemd', services: ['fixture.service'] }
    const command = buildCliLifecycleProbe(options).replaceAll('dpkg-query', 'probe_packages')
    const run = (packages = 'package\t1.0\tx86_64\tii', active = 'inactive', fail = '') => {
      const result = spawnSync('/bin/sh', ['-c', `probe_packages () { ${fail === 'packages' ? 'return 1' : `printf '%s\\n' '${packages}'`}; }; systemctl () { ${fail === 'services' ? 'return 1' : `printf '%s\\n' 'LoadState=loaded' 'ActiveState=${active}' 'UnitFileState=disabled'`}; }; ` + command], { encoding: 'utf8' })
      return result
    }
    const baseline = run()
    assert.equal(baseline.status, 0, baseline.stderr)
    assert.match(baseline.stdout, /^probe-version=1\npaths=[a-f0-9]{64}\npackages=[a-f0-9]{64}\nservices=[a-f0-9]{64}\n$/u)
    assert.doesNotMatch(baseline.stdout, /fixture-private-value|operator|missing/u)
    assert.equal(run().stdout, baseline.stdout)
    assert.equal(readFileSync(file, 'utf8'), 'password=fixture-private-value\n')
    assert.notEqual(run('package\t2.0\tx86_64\tii').stdout, baseline.stdout)
    assert.notEqual(run('').status, 0)
    assert.notEqual(run(undefined, 'active').stdout, baseline.stdout)
    for (const failure of ['packages', 'services']) assert.notEqual(run(undefined, undefined, failure).status, 0)
    writeFileSync(file, 'different private contents\n')
    assert.notEqual(run().stdout, baseline.stdout)
    writeFileSync(file, 'password=fixture-private-value\n')
    assert.equal(run().stdout, baseline.stdout)
    chmodSync(file, 0o400)
    assert.notEqual(run().stdout, baseline.stdout)
    chmodSync(file, 0o644)
    rmSync(link)
    symlinkSync('missing\n\n', link)
    assert.notEqual(run().stdout, baseline.stdout)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('probe package families and OpenRC states use fixed read-only native commands', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-probe-openrc-'))
  try {
    mkdirSync(`${root}/init`)
    writeFileSync(`${root}/init/fixture`, 'fixture')
    for (const [manager, binary] of [['apt', 'dpkg-query'], ['dnf', 'rpm'], ['yum', 'rpm'], ['zypper', 'rpm'], ['apk', 'apk'], ['pacman', 'pacman']]) {
      const command = buildCliLifecycleProbe({ paths: [root], packageManager: manager, serviceManager: 'openrc', services: ['fixture'] })
        .replaceAll(binary, 'probe_packages').replaceAll('rc-service', 'probe_service').replaceAll('rc-update', 'probe_runlevels').replaceAll('/etc/init.d', `${root}/init`)
      const run = (status, enabled = true) => spawnSync('/bin/sh', ['-c', `probe_packages () { printf 'package-version\\n'; }; probe_service () { return ${status}; }; probe_runlevels () { printf '%s\\n' '${enabled ? 'fixture | default' : ''}'; }; ${command}`], { encoding: 'utf8' })
      const active = run(0)
      const stopped = run(3)
      assert.equal(active.status, 0, active.stderr)
      assert.equal(stopped.status, 0, stopped.stderr)
      assert.notEqual(active.stdout, stopped.stdout, manager)
      assert.notEqual(active.stdout, run(0, false).stdout, manager)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('probe builder rejects unsupported or unbounded scope before producing a command', () => {
  const valid = { paths: ['/srv/intent-fixture'], packageManager: 'apt', serviceManager: 'systemd' }
  for (const patch of [
    { packageManager: '__proto__' }, { packageManager: 'unsupported' }, { serviceManager: 'unknown' },
    { paths: [] }, { paths: ['relative'] }, { paths: ['/srv/../etc'] }, { paths: ['/srv/name\nother'] },
    { paths: ['/srv/one', '/srv/one'] }, { paths: Array.from({ length: 81 }, (_, index) => `/srv/${index}`) },
    { services: ['--all'] }, { services: ['fixture; false'] }, { services: ['same', 'same'] }
  ]) assert.throws(() => buildCliLifecycleProbe({ ...valid, ...patch }), /probe|unsupported/u)
})
