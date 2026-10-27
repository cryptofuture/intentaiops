import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildGhostTask, ghostRelease } from '../src/ghost-task.js'
import { validateCommandPlan } from '../src/plan-validator.js'

const ubuntu = context('ubuntu', '24.04', 'debian', 'apt', 'systemd')
const debian = context('debian', '13', 'debian', 'apt', 'systemd')

test('Ghost selects a CPU-compatible profile before creating baseline state', () => {
  const command = buildGhostTask(7, ubuntu, { preferred: true, ready: true }).plan.commands[0].command.split('; if [ ! -s ')[0]
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ghost-cpu-'))
  const file = path.join(directory, 'cpuinfo')
  const flags = 'cx16 lahf_lm popcnt pni sse4_1 sse4_2 ssse3'
  try {
    for (const [contents, expected, marker] of [
      [`flags\t: ${flags}\n`, 0, 'standard'],
      [`flags: ${flags.replace('sse4_2', 'sse4_20')}\n`, 0, 'compat'],
      [`flags: ${flags}\nflags: cx16\n`, 0, 'compat'],
      ['', 1, 'CPU_FEATURES_UNAVAILABLE']
    ]) {
      writeFileSync(file, contents)
      const result = spawnSync('/bin/sh', ['-c', `uname () { printf x86_64; }; ${command.replaceAll('/proc/cpuinfo', file)}; printf '%s' "$image_cpu_profile"`], { encoding: 'utf8' })
      assert.equal(result.status, expected, result.stderr)
      if (expected) assert.ok(result.stderr.includes(marker))
      else assert.equal(result.stdout, marker)
    }
    const arm = spawnSync('/bin/sh', ['-c', `uname () { printf aarch64; }; ${command.replaceAll('/proc/cpuinfo', '/missing-cpuinfo')}`], { encoding: 'utf8' })
    assert.equal(arm.status, 0, arm.stderr)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('Ghost Compose route pins official production images and protects MySQL credentials', () => {
  const built = buildGhostTask(7, ubuntu, { preferred: true, ready: true })
  assert.doesNotMatch(built.plan.commands.find(item => item.id === 'verify-compose').command, /docker compose[^;]* restart/u)
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /ghost@sha256:[a-f0-9]{64}/u)
  assert.match(commands, /mysql@sha256:[a-f0-9]{64}/u)
  assert.match(commands, /NODE_ENV: production/u)
  assert.match(commands, /database__client: mysql/u)
  assert.match(commands, /127\.0\.0\.1:2368\/blog\//u)
  assert.match(commands, /proxy_pass http:\/\/ghost:2368;/u)
  assert.match(commands, /url=http:\/\/%s:18110\/blog\//u)
  assert.doesNotMatch(commands, /for \(index=/u)
  assert.match(commands, /\/root\/ghost_credentials\/credentials\.env/u)
  assert.match(commands, /WEBMINAI_GHOST_OK/u)
  assert.doesNotMatch(commands, /MYSQL_PASSWORD=[a-f0-9]{32,}/u)
  assert.match(built.plan.revertCommands[0].command, /already-reverted/u)
  assert.match(built.plan.revertCommands.at(-1).command, /already-reverted/u)
  assertShellSyntax(built)
})

test('Ubuntu Ghost route uses Node 22, Oracle MySQL 8, nginx, and a protected service environment', () => {
  const built = buildGhostTask(11, ubuntu, { preferred: false })
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /nodejs\.org\/dist\/v22\.23\.1\/node-v22\.23\.1-linux/u)
  assert.match(commands, /sha256sum -c/u)
  assert.match(commands, /ExecStart=\/opt\/webminai-ghost-cli\/bin\/node/u)
  assert.doesNotMatch(commands, /apt-get install -y nodejs|deb\.nodesource\.com/u)
  assert.match(commands, /mysql-server/u)
  assert.match(commands, /Ver 8\\\.0/u)
  assert.match(commands, /ghost-cli@1\.29\.1/u)
  assert.match(commands, /pnpm@11\.15\.1/u)
  assert.match(commands, /ghost' install '6\.57\.0'/u)
  assert.match(commands, /current\/index\.js/u)
  assert.match(commands, /\/config\.production\.json/u)
  assert.doesNotMatch(commands, /\/\.config\.production\.json/u)
  assert.match(commands, /content\/themes\/source/u)
  const acquisition = built.plan.commands.find(item => item.id === 'install-ghost').command
  assert.match(acquisition, /install -d -o root -g root -m 0700 '\/var\/lib\/webminai\/task-state\/11-ghost-linux\/npm-cache'/u)
  assert.match(acquisition, /runuser[^;]*npm_config_cache='\/var\/lib\/webminai-ghost-18110\/npm-cache'/u)
  assert.doesNotMatch(acquisition, /runuser[^;]*npm_config_cache='\/var\/lib\/webminai\/task-state/u)
  assert.match(commands, /EnvironmentFile=\/root\/ghost_credentials\/service\.env/u)
  assert.match(commands, /proxy_pass http:\/\/127\.0\.0\.1:2368/u)
  assert.match(commands, /WEBMINAI_GHOST_OK/u)
  assert.equal(built.plan.commands.find(item => item.id === 'initialize-database').executionMode, 'job')
  assert.equal(built.plan.commands.find(item => item.id === 'initialize-database').timeoutMs, 900000)
  assert.doesNotMatch(commands, /database__connection__password=[a-f0-9]{32,}/u)
  assert.match(built.plan.revertCommands.at(-1).command, /already-reverted/u)
  assert.match(built.plan.revertCommands.at(-1).command, /systemctl cat mysql/u)
  assertShellSyntax(built)
})

test('unsupported native distributions produce a reversible no-change compatibility result', () => {
  const built = buildGhostTask(13, debian, { preferred: false })
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  assert.equal(built.plan.compatibilityManifest.selectedRoute.status, 'unsupported')
  assert.equal(built.plan.commands.length, 1)
  assert.match(built.plan.commands[0].command, /MariaDB or production SQLite substitutions are forbidden/u)
  assert.doesNotMatch(built.plan.commands[0].command, /apt-get|dnf|apk add|pacman|zypper|docker/u)
  assertShellSyntax(built)
})

test('Ghost release matrix is pinned', () => {
  assert.deepEqual(ghostRelease(), {
    version: '6.57.0',
    composeVersion: '6.56.0',
    images: ghostRelease().images
  })
  assert.equal(ghostRelease().images.length, 3)
})

test('Ghost rollback retains its baseline and refuses success while newly created MySQL data remains', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-ghost-residue-'))
  try {
    const state = '/var/lib/webminai/task-state/73-ghost-linux'
    const plan = buildGhostTask(73, ubuntu, { preferred: false }).plan
    assert.match(plan.commands[0].command, /\[ ! -e \/var\/lib\/mysql \] && \[ ! -L \/var\/lib\/mysql \]/u)
    const restore = plan.revertCommands.at(-1).command
    const guard = restore.slice(restore.indexOf(`if [ -e '${state}/mysql-data.absent'`), restore.indexOf(`; if [ -e '${state}/user-created'`))
    assert.ok(guard && restore.indexOf(guard) < restore.lastIndexOf('rm -rf'))
    const command = guard.replaceAll(state, directory).replaceAll('/var/lib/mysql', directory + '/mysql')
    writeFileSync(path.join(directory, 'mysql-data.absent'), '')
    const run = () => spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
    assert.equal(run().status, 0)
    mkdirSync(path.join(directory, 'mysql'))
    writeFileSync(path.join(directory, 'mysql', 'preserve'), 'data')
    let result = run()
    assert.equal(result.status, 1)
    assert.match(result.stderr, /DATABASE_DATA_REMAINS/u)
    assert.equal(readFileSync(path.join(directory, 'mysql', 'preserve'), 'utf8'), 'data')
    rmSync(path.join(directory, 'mysql'), { recursive: true })
    symlinkSync(path.join(directory, 'missing-target'), path.join(directory, 'mysql'))
    result = run()
    assert.equal(result.status, 1)
    rmSync(path.join(directory, 'mysql-data.absent'))
    assert.equal(run().status, 0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('Ghost package rollback does not claim upgraded baseline packages', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-ghost-delta-'))
  try {
    for (const preferred of [false, true]) {
      const built = buildGhostTask(71, ubuntu, { preferred, ready: true })
      const state = `/var/lib/webminai/task-state/71-ghost-${preferred ? 'compose' : 'linux'}`
      const source = built.plan.commands.find(item => item.id === (preferred ? 'prepare-docker' : 'install-stack')).command
      const tail = source.slice(source.lastIndexOf('dpkg-query -W')).replaceAll(state, directory)
      writeFileSync(path.join(directory, 'packages.before'), 'ii curl 1\nrc mysql-server-8.0 8\nii nginx 1\n')
      const result = spawnSync('/bin/bash', ['-c', "dpkg-query () { printf 'ii curl 2\\nii mysql-server 8\\nii mysql-server-8.0 8\\nii nginx 1\\n'; }; " + tail], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(readFileSync(path.join(directory, 'packages.added'), 'utf8'), 'mysql-server 8\nmysql-server-8.0 8\n')
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('Ghost retains a private bounded package-error tail and restores only missing package configuration', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-ghost-package-error-'))
  try {
    const source = buildGhostTask(72, ubuntu, { preferred: false }).plan.commands.find(item => item.id === 'install-stack').command
    assert.match(source, /--force-confmiss/u)
    assert.match(source, /--force-confold/u)
    assert.doesNotMatch(source, /--force-confnew/u)
    const command = source.replaceAll('/var/lib/webminai/task-state/72-ghost-linux', directory).replaceAll('/var/lib/mysql', directory + '/mysql')
    const result = spawnSync('/bin/bash', ['-c', "apt-get () { [ \"$1\" != update ] || return 0; printf '%030000d\\n' 0; printf '%s\\n' 'end of file on stdin at conffile prompt' >&2; return 42; }; umask 0007; " + command], { encoding: 'utf8' })
    assert.equal(result.status, 42, result.stderr)
    assert.match(result.stdout, /end of file on stdin at conffile prompt/u)
    assert.ok(Buffer.byteLength(result.stdout) <= 4000)
    assert.equal(statSync(path.join(directory, 'packages.log')).mode & 0o777, 0o600)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

function assertShellSyntax (built) {
  for (const command of [...built.plan.commands, ...built.plan.revertCommands]) {
    const checked = spawnSync('/bin/sh', ['-n', '-c', command.command], { encoding: 'utf8' })
    assert.equal(checked.status, 0, `${command.id}: ${checked.stderr}`)
  }
}

function context (id, versionId, family, packageManager, serviceManager) {
  return {
    fingerprint: `${id}-${versionId}`,
    identity: { id, versionId, architecture: 'x86_64' },
    management: { family, packageManager, serviceManager },
    applications: {}
  }
}
