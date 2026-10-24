import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, access, rm, symlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { buildFreebsdPodmanBootstrapTask } from '../src/freebsd-podman-bootstrap-task.js'

test('FreeBSD bootstrap initializes missing facilities and preserves pre-existing runtime workloads', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-freebsd-bootstrap-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const built = buildFreebsdPodmanBootstrapTask(121, { platform: 'freebsd', docker: { installSupported: true } })
  for (const [existing, linux32] of [[false, false], [true, true], [false, true]]) {
    const directory = path.join(root, `${existing}-${linux32}`)
    await mkdir(directory)
    await writeFile(path.join(directory, 'fstab'), existing ? 'fdesc /dev/fd fdescfs rw 0 0\n' : '')
    await writeFile(path.join(directory, 'sysctl.conf'), existing ? 'net.pf.filter_local=1\n' : '')
    await writeFile(path.join(directory, 'rc.conf'), existing ? 'linux_enable="YES"\n' : '')
    if (existing) for (const name of ['config', 'storage']) await mkdir(path.join(directory, name))
    const adapt = command => command.replaceAll('/var/db/webminai/task-state/121-freebsd-podman', directory + '/state').replaceAll('/usr/local/etc/containers', directory + '/config').replaceAll('/var/db/containers', directory + '/storage').replaceAll('/etc/fstab', directory + '/fstab').replaceAll('/etc/sysctl.conf', directory + '/sysctl.conf').replaceAll('/etc/rc.conf', directory + '/rc.conf').replaceAll('freebsd-version', 'freebsd_version').replaceAll('command -v podman', 'probe_command -v podman')
    const fixture = `set -eu; existing=${existing ? 'yes' : 'no'}; linux32=${linux32 ? 'yes' : 'no'}; pkg_installed=no; root='${directory}';
probe_command () { [ "$1" = -v ] && [ "$2" = podman ] && [ "$existing" = yes ]; }
env () { shift; "$@"; }
pkg () { if [ "$1" = query ]; then printf 'base=1\\n'; if [ "$existing" = yes ] || [ "$pkg_installed" = yes ]; then printf 'podman=1\\n'; fi; else pkg_installed=yes; fi; }
sha256 () { printf 'fixture-hash\\n'; }
stat () { if [ "$2" = '%u' ]; then printf 0; else printf 0:0:644; fi; }
mount () { if [ "$#" = 0 ]; then [ "$existing" != yes ] || printf 'fdesc on /dev/fd (fdescfs)\\n'; else : > "$root/mounted"; fi; }
kldstat () { [ "$existing" = yes ] || { [ "$3" = linux.ko ] && [ "$linux32" = yes ]; }; }
kldload () { printf '%s\\n' "$1" >> "$root/modules"; }
freebsd_version () { printf '14.4-RELEASE\\n'; }
sysctl () { if [ "$1" = -n ]; then if [ "$existing" = yes ]; then printf 1; else printf 0; fi; fi; }
sysrc () { if [ "$1" = -n ]; then [ "$existing" = yes ] && printf YES; else :; fi; }
test () { if [ "$1" = -c ] && [ "$2" = /dev/pf ]; then [ "$existing" = yes ]; else command test "$@"; fi; }
service () { if [ "$2" = status ]; then return 1; fi; printf '%s %s\\n' "$1" "$2" >> "$root/services"; }
`
    const commands = ['capture-podman-baseline', 'install-podman-suite'].map(id => adapt(built.plan.commands.find(command => command.id === id).command)).join('\n')
    const result = spawnSync('/bin/sh', ['-c', fixture + commands], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const services = await readFile(path.join(directory, 'services'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
    assert.equal(services.includes('podman start'), !existing)
    assert.equal(services.includes('linux onestart'), !existing)
    const stateFiles = ['fdescfs.added-mount', 'fdescfs.added-config', 'pf.added-module', 'pf-filter.added-config', 'linux.added-module']
    for (const name of stateFiles) assert.equal(await access(path.join(directory, 'state', name)).then(() => true, () => false), !existing, name)
    assert.equal(await access(path.join(directory, 'state', 'podman.preexisting')).then(() => true, () => false), existing)
    assert.equal(await access(path.join(directory, 'state', 'linux-any.loaded')).then(() => true, () => false), existing || linux32)
    assert.match(built.plan.commands.find(command => command.id === 'install-podman-suite').command, /sysrc linux_enable=YES/u)
    assert.match(built.plan.revertCommands.find(command => command.id === 'restore-podman-baseline').command, /linux-enable[.]before/u)
    assert.match(built.plan.revertCommands.find(command => command.id === 'restore-podman-baseline').command, /linux[.]added-module" \] && \[ ! -e "\$state\/linux-any[.]loaded/u)
    assert.equal(await readFile(path.join(directory, 'state', 'packages.added'), 'utf8'), existing ? '' : 'podman\n')
    assert.equal(await readFile(path.join(directory, 'fstab'), 'utf8'), 'fdesc /dev/fd fdescfs rw 0 0\n')
    assert.equal(await readFile(path.join(directory, 'sysctl.conf'), 'utf8'), 'net.pf.filter_local=1\n')
  }
})

test('FreeBSD rc rollback restores absent defaults byte-for-byte and rejects drift or unsafe backups', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-freebsd-rc-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const built = buildFreebsdPodmanBootstrapTask(121, { platform: 'freebsd', docker: { installSupported: true } })
  const command = built.plan.revertCommands.find(command => command.id === 'restore-podman-baseline').command
  const marker = 'if [ -f "$state/rc.conf.before" ]; then '
  const start = command.indexOf(marker)
  const end = command.indexOf('; else ', start)
  assert.ok(start > 0 && end > start)
  const exact = command.slice(start + marker.length, end)
  const hash = value => createHash('sha256').update(value).digest('hex')
  for (const explicit of [false, true]) {
    const before = (explicit ? 'linux_enable="NO"\n' : '') + 'hostname="lab"\n'
    const applied = 'linux_enable="YES"\npodman_enable="YES"\nhostname="lab"\n'
    for (const scenario of ['applied', 'unchanged', 'drift', 'tamper', 'symlink']) {
      const directory = path.join(root, `${explicit}-${scenario}`)
      await mkdir(directory)
      const file = path.join(directory, 'rc.conf')
      const backup = path.join(directory, 'rc.conf.before')
      const current = scenario === 'unchanged' ? before : applied + (scenario === 'drift' ? 'unrelated="YES"\n' : '')
      await writeFile(file, current)
      await writeFile(backup, scenario === 'tamper' ? 'tampered\n' : before, { mode: 0o600 })
      await writeFile(path.join(directory, 'rc.before.sha256'), hash(before))
      await writeFile(path.join(directory, 'rc.applied.sha256'), hash(applied))
      await writeFile(path.join(directory, 'rc.metadata'), '0:0:644')
      if (scenario === 'symlink') {
        await rm(backup)
        await symlink(file, backup)
      }
      const fixture = `set -eu; state='${directory}'; stat () { if [ "$2" = '%u:%Lp' ]; then printf 0:600; else printf 0:0:644; fi; }; sha256 () { sha256sum "$2" | cut -d ' ' -f 1; }; `
      const result = spawnSync('/bin/sh', ['-c', fixture + exact.replaceAll('/etc/rc.conf', file)], { encoding: 'utf8' })
      const valid = ['applied', 'unchanged'].includes(scenario)
      assert.equal(result.status === 0, valid, scenario + ': ' + result.stderr)
      assert.equal(await readFile(file, 'utf8'), valid ? before : current)
    }
  }
})
