import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { buildLinuxDockerBootstrapTask } from '../src/linux-docker-bootstrap-task.js'

const options = { platform: 'linux', linuxContext: { identity: { id: 'debian' }, management: { packageManager: 'apt' } }, docker: { preference: 'auto', hostIsContainer: false, containerRuntime: 'none', ready: false, installSupported: true, installMethod: 'official-apt' } }

test('unsupported container installations remain rejected and native plans verify the runtime', () => {
  const container = { ...options.docker, hostIsContainer: true, containerRuntime: 'lxc', installSupported: false }
  assert.throws(() => buildLinuxDockerBootstrapTask(12, options.linuxContext, container), /automatic Docker installation/u)
  assert.throws(() => buildLinuxDockerBootstrapTask(12, options.linuxContext, { ...container, preference: 'enabled' }), /no reviewed Docker installation route/u)
  const built = buildLinuxDockerBootstrapTask(12, options.linuxContext, options.docker)
  assert.match(built.plan.commands[2].command, /systemctl enable --now/u)
  assert.match(built.plan.commands[3].command, /docker run --rm hello-world/u)
})

test('a failed Docker package install records only new package names, never an upgraded baseline package', { skip: !existsSync('/bin/bash') }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'intent-docker-partial-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'packages.before'), 'base=1\n')
  const original = buildLinuxDockerBootstrapTask(12, options.linuxContext, options.docker).plan.commands[2].command
  const start = original.indexOf('export DEBIAN_FRONTEND=noninteractive; apt-get update;')
  const ending = 'apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin'
  const end = original.lastIndexOf(ending) + ending.length
  assert.ok(start > 0 && end > start)
  const script = (original.slice(0, start) + 'false' + original.slice(end)).replaceAll('/var/lib/webminai/tasks/12/linux-docker', directory)
  assert.doesNotMatch(script, /apt-get|\/etc\//u)
  const result = spawnSync('/bin/bash', ['-c', "docker () { return 1; }; dpkg-query () { printf 'base=2\\nadded=1\\n'; }; " + script], { encoding: 'utf8' })
  assert.equal(result.status, 1, result.stderr)
  assert.equal(await readFile(path.join(directory, 'packages.added'), 'utf8'), 'added\n')
})

test('Docker baseline publication is complete and repeated capture preserves the original snapshot', { skip: !existsSync('/bin/bash') }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'intent-docker-baseline-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const command = buildLinuxDockerBootstrapTask(12, options.linuxContext, options.docker).plan.commands[1].command.replaceAll('/var/lib/webminai/tasks/12/linux-docker', directory)
  const run = version => spawnSync('/bin/bash', ['-c', `dpkg-query () { printf 'base=${version}\\n'; }; systemctl () { return 1; }; getent () { return 2; }; ` + command], { encoding: 'utf8' })
  const first = run(1)
  assert.equal(first.status, 0, first.stderr)
  assert.match(await readFile(path.join(directory, 'baseline.sha256'), 'utf8'), /^[a-f0-9]{64}\n$/u)
  await assert.rejects(readFile(path.join(directory, 'baseline.sha256.pending')), { code: 'ENOENT' })
  const second = run(2)
  assert.equal(second.status, 0, second.stderr)
  assert.equal(await readFile(path.join(directory, 'packages.before'), 'utf8'), 'base=1\n')
})

test('RPM rollback protects baseline packages while allowing removal of task-added protected packages', () => {
  const rpm = { ...options, linuxContext: { identity: { id: 'fedora' }, management: { packageManager: 'dnf' } } }
  const command = buildLinuxDockerBootstrapTask(39, rpm.linuxContext, { ...rpm.docker, installMethod: 'official-rpm' }).plan.revertCommands[0].command
  assert.match(command, /baseline checksum changed; cleanup blocked/u)
  assert.match(command, /Refusing to remove a baseline package/u)
  assert.match(command, /cut -d= -f1 "\$state\/packages.before".*sort -u > "\$state\/package-names.before"/u)
  assert.match(command, /--setopt=clean_requirements_on_remove=False --setopt=protected_packages= "--setopt=protected_packages=glob:\$state\/package-names.before" remove --/u)
  assert.match(command, /for version in 621e9f35-58adea78 060a61c51b558a7f742b77aac52feb6b621e9f35-58ade481/u)
  assert.match(command, /if ! grep -Fxq "gpg-pubkey=\$version\.\(none\)" "\$state\/packages.before" && rpm -q "gpg-pubkey-\$version"/u)
  assert.match(command, /rpm -e -- "gpg-pubkey-\$version"/u)
})

test('changed Docker baseline blocks cleanup before any service or package operation', { skip: !existsSync('/bin/bash') }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'intent-docker-tamper-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'packages.before'), 'changed=1\n')
  await writeFile(path.join(directory, 'baseline.sha256'), '0'.repeat(64) + '\n')
  const command = buildLinuxDockerBootstrapTask(12, options.linuxContext, options.docker).plan.revertCommands[0].command.replaceAll('/var/lib/webminai/tasks/12/linux-docker', directory)
  const result = spawnSync('/bin/bash', ['-c', 'systemctl () { printf UNEXPECTED_OPERATION; }; ' + command], { encoding: 'utf8' })
  assert.equal(result.status, 78, result.stderr)
  assert.match(result.stderr, /baseline checksum changed/u)
  assert.doesNotMatch(result.stdout, /UNEXPECTED_OPERATION/u)
  assert.equal(await readFile(path.join(directory, 'packages.before'), 'utf8'), 'changed=1\n')
})
