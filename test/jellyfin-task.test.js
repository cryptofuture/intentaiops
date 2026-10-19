import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildJellyfinTask, jellyfinRelease } from '../src/jellyfin-task.js'
import { validateCommandPlan } from '../src/plan-validator.js'
import { validateDockerAndSecrets } from '../src/planner-platform-policy.js'

const ubuntu = context('ubuntu', '24.04', 'debian')
const debian = context('debian', '13', 'debian')
const rocky = context('rocky', '9.8', 'rhel')
const arch = context('arch', '', 'arch')
const alpine = context('alpine', '3.23.5', 'alpine')

test('Jellyfin resumes bounded transfers, verifies cached bytes and rejects unsafe artifacts', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-jellyfin-download-'))
  const content = 'verified archive'
  const digest = createHash('sha256').update(content).digest('hex')
  const built = buildJellyfinTask(94, rocky)
  const original = built.plan.commands.find(item => item.id === 'install-jellyfin-ffmpeg').command
  const artifact = path.join(root, `jellyfin-ffmpeg_${jellyfinRelease().ffmpegVersion}_portable_linux64-gpl.tar.xz`)
  const partial = `${artifact}.tmp`
  const calls = path.join(root, 'calls')
  const command = original.replaceAll('/var/lib/webminai/task-state/94-jellyfin-linux', root).replaceAll(jellyfinRelease().ffmpegSha256, digest).replaceAll('58599712', String(content.length)).replaceAll('/opt/webminai-jellyfin-18113', root)
  const run = curl => spawnSync('/bin/sh', ['-c', `sleep () { :; }; tar () { printf extracted >> '${calls}'; }; curl () { ${curl}; }; ` + command], { encoding: 'utf8' })
  writeFileSync(path.join(root, 'ffmpeg'), '', { mode: 0o755 })
  try {
    writeFileSync(partial, 'verified')
    const resumed = run(`case "$*" in *'--continue-at - --retry 0'*) :;; *) return 97;; esac; printf ' archive' >> '${partial}'`)
    assert.equal(resumed.status, 0, resumed.stderr)
    assert.equal(readFileSync(artifact, 'utf8'), content)
    assert.equal(run('return 99').status, 0)
    rmSync(artifact)
    writeFileSync(partial, content)
    assert.equal(run('return 99').status, 0)
    rmSync(artifact)
    rmSync(calls)
    writeFileSync(partial, 'x'.repeat(content.length + 1))
    assert.equal(run(`[ ! -e '${partial}' ] || return 98; printf '${content}' > '${partial}'`).status, 0)
    assert.equal(readFileSync(artifact, 'utf8'), content)
    rmSync(artifact)
    rmSync(calls)
    const exhausted = run(`printf x >> '${partial}'; printf call >> '${calls}'; return 28`)
    assert.equal(exhausted.status, 28)
    assert.equal(readFileSync(partial, 'utf8'), 'xxxxxx')
    assert.equal(readFileSync(calls, 'utf8'), 'call'.repeat(6))
    rmSync(calls)
    assert.equal(run('return 22').status, 22)
    assert.equal(existsSync(calls), false)
    assert.equal(run(`printf corrupt > '${partial}'`).status, 1)
    assert.equal(existsSync(calls), false)
    assert.equal(existsSync(partial), false)
    symlinkSync(path.join(root, 'ffmpeg'), partial)
    assert.notEqual(run('return 0').status, 0)
    assert.equal(existsSync(calls), false)
    rmSync(partial)
    symlinkSync(path.join(root, 'ffmpeg'), artifact)
    assert.notEqual(run('return 0').status, 0)
    assert.equal(existsSync(calls), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('reviewed Jellyfin credential initialization satisfies unchanged AI planning policy', () => {
  for (const preferred of [false, true]) {
    const built = buildJellyfinTask(94, ubuntu, { preferred, ready: preferred })
    const item = built.plan.commands.find(item => item.id === 'initialize-jellyfin')
    assert.doesNotThrow(() => validateDockerAndSecrets({ ...built.plan, commands: [item], revertCommands: [] }, { webminaiDocker: { preferred } }))
    if (!preferred) assert.doesNotThrow(() => validateDockerAndSecrets(built.plan, {}))
    const initialize = item.command
    assert.ok(!initialize.includes('$(cat '))
    assert.match(initialize, /username=\$\(sed -n 1p/u)
    assert.match(initialize, /password=\$\(sed -n 1p/u)
  }
})

test('Jellyfin foundation snapshots are immutable on reapply and reject failed or empty package queries', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-jellyfin-snapshot-'))
  try {
    for (const host of [ubuntu, rocky, arch, context('opensuse-leap', '16.0', 'suse')]) {
      const state = root + '/var/lib/webminai/task-state/95-jellyfin-linux'
      mkdirSync(state, { recursive: true })
      mkdirSync(root + '/etc/apt/keyrings', { recursive: true })
      mkdirSync(root + '/etc/apt/sources.list.d', { recursive: true })
      let command = buildJellyfinTask(95, host).plan.commands.find(item => item.id === 'install-foundation').command
      for (const prefix of ['/var/', '/etc/']) command = command.replaceAll(prefix, root + prefix)
      command = command.replaceAll('apt-get', 'fixture_install').replaceAll('dpkg-query', 'fixture_query').replaceAll('rpm -qa', 'fixture_query').replaceAll('pacman -Qq', 'fixture_query')
      const mocks = 'fixture_install () { :; }; dnf () { :; }; pacman () { :; }; zypper () { :; }; systemctl () { :; }; curl () { while [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then printf key > "$2"; return; fi; shift; done; }; gpg () { if [ "$1" = --show-keys ]; then printf \'fpr:::::::::4918AABC486CA052358D778D49023CD01DE21A7B:\\n\'; else while [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then printf key > "$2"; return; fi; shift; done; fi; }; '
      const snapshot = state + '/packages.foundation'
      for (const phase of ['first', 'repeat', 'failed', 'empty']) {
        if (phase === 'failed' || phase === 'empty') rmSync(snapshot, { force: true })
        const query = phase === 'failed' ? 'return 23' : phase === 'empty' ? ':' : `printf 'base-package\\n${phase === 'repeat' ? 'later-package\\n' : ''}'`
        const result = spawnSync('/bin/sh', ['-c', mocks + `fixture_query () { ${query}; }; ` + command], { encoding: 'utf8', timeout: 10000 })
        assert.equal(result.status, phase === 'failed' ? 23 : phase === 'empty' ? 1 : 0, `${host.identity.id}/${phase}: ${result.stderr}`)
        if (phase === 'first' || phase === 'repeat') assert.equal(readFileSync(snapshot, 'utf8'), 'base-package\n', 'reapply rewrote the original foundation snapshot')
        else assert.equal(existsSync(snapshot), false, 'invalid query published a baseline')
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('native Jellyfin rollback cannot remove later files without its own valid baseline', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-jellyfin-owned-'))
  try {
    const built = buildJellyfinTask(92, rocky)
    const state = root + '/var/lib/webminai/task-state/92-jellyfin-linux'
    for (const item of built.plan.revertCommands) {
      const managed = root + (item.id === 'stop-jellyfin' ? '/etc/systemd/system/webminai-jellyfin-18113.service' : '/opt/webminai-jellyfin-18113/original')
      mkdirSync(path.dirname(managed), { recursive: true })
      writeFileSync(managed, 'later operator contents')
      let command = item.command
      for (const prefix of ['/var/', '/etc/', '/root/', '/opt/']) command = command.replaceAll(prefix, root + prefix)
      const prefix = 'systemctl () { return 0; }; getent () { return 2; }; dnf () { return 0; }; '
      for (const kind of ['absent', 'empty', 'symlink']) {
        if (kind === 'empty') mkdirSync(state, { recursive: true })
        if (kind === 'symlink') { rmSync(state, { recursive: true, force: true }); symlinkSync(path.dirname(managed), state) }
        const result = spawnSync('/bin/sh', ['-c', prefix + command], { encoding: 'utf8', timeout: 10000 })
        if (kind !== 'absent') assert.notEqual(result.status, 0, `${item.id}/${kind}: ${result.stderr}`)
        assert.equal(readFileSync(managed, 'utf8'), 'later operator contents')
        if (kind !== 'absent') rmSync(state, { recursive: true, force: true })
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('native Jellyfin restoration preserves failed cleanup evidence and permits repeated successful cleanup', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-jellyfin-restore-'))
  try {
    for (const host of [ubuntu, rocky, arch, context('opensuse-leap', '16.0', 'suse')]) {
      for (const failure of ['packages', 'account', 'account-query', 'enable', 'disable', 'start', 'stop', 'none']) {
        const state = path.join(root, host.identity.id + '-' + failure)
        mkdirSync(state, { mode: 0o700 })
        writeFileSync(path.join(state, 'packages.before'), 'base-package 1\n')
        writeFileSync(path.join(state, 'packages.added'), 'jellyfin-fixture 1\n')
        if (failure === 'enable') writeFileSync(path.join(state, 'nginx.enabled'), '')
        if (failure === 'start') writeFileSync(path.join(state, 'nginx.active'), '')
        const command = buildJellyfinTask(91, host).plan.revertCommands.find(item => item.id === 'restore-foundation').command
          .replaceAll('/var/lib/webminai/task-state/91-jellyfin-linux', state)
          .replaceAll('/etc/apt/sources.list.d/jellyfin.sources', root + '/repository')
          .replaceAll('/etc/apt/keyrings/jellyfin.gpg', root + '/keyring')
          .replaceAll('/etc/nginx/nginx.conf', root + '/nginx.conf')
          .replaceAll('apt-get', 'apt_get')
        const serviceFailure = ['enable', 'disable', 'start', 'stop'].includes(failure)
        const prefix = `apt_get () { return ${failure === 'packages' ? 23 : 0}; }; dnf () { return ${failure === 'packages' ? 23 : 0}; }; pacman () { return ${failure === 'packages' ? 23 : 0}; }; zypper () { return ${failure === 'packages' ? 23 : 0}; }; getent () { return ${failure === 'account' ? 0 : failure === 'account-query' ? 26 : 2}; }; userdel () { return 24; }; systemctl () { ${serviceFailure ? `[ "$1" != '${failure}' ] || return 27; return 0` : 'return 1'}; }; `
        const result = spawnSync('/bin/sh', ['-c', prefix + command], { encoding: 'utf8', timeout: 10000 })
        assert.equal(result.status, failure === 'packages' ? 23 : failure === 'account' ? 24 : failure === 'account-query' ? 26 : serviceFailure ? 27 : 0, `${host.identity.id}/${failure}: ${result.stderr}`)
        assert.equal(existsSync(path.join(state, 'packages.before')), failure !== 'none', 'restoration discarded unresolved evidence or retained completed state')
        if (failure === 'none') assert.equal(spawnSync('/bin/sh', ['-c', prefix + command], { encoding: 'utf8', timeout: 10000 }).status, 0)
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('native Jellyfin cleanup reports service failures instead of deleting evidence', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-jellyfin-service-'))
  try {
    for (const failure of ['disable', 'daemon-reload', 'reload']) {
      const state = root + '/var/lib/webminai/task-state/93-jellyfin-linux'
      const unit = root + '/etc/systemd/system/webminai-jellyfin-18113.service'
      mkdirSync(state, { recursive: true })
      mkdirSync(path.dirname(unit), { recursive: true })
      writeFileSync(state + '/packages.before', 'baseline\n')
      writeFileSync(unit, 'original task unit')
      let command = buildJellyfinTask(93, rocky).plan.revertCommands.find(item => item.id === 'stop-jellyfin').command
      for (const prefix of ['/var/', '/etc/', '/root/', '/opt/']) command = command.replaceAll(prefix, root + prefix)
      const result = spawnSync('/bin/sh', ['-c', `nginx () { return 0; }; systemctl () { [ "$1" != '${failure}' ] || return 27; return 0; }; ` + command], { encoding: 'utf8', timeout: 10000 })
      assert.equal(result.status, 27, `${failure}: ${result.stderr}`)
      assert.ok(existsSync(state + '/packages.before'))
      if (failure === 'disable') assert.equal(readFileSync(unit, 'utf8'), 'original task unit')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Jellyfin Compose route pins official images and isolates media without devices', () => {
  const built = buildJellyfinTask(41, ubuntu, { preferred: true, ready: true })
  assert.doesNotMatch(built.plan.commands.find(item => item.id === 'verify-compose').command, /docker compose[^;]* restart/u)
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /jellyfin\/jellyfin@sha256:[a-f0-9]{64}/u)
  assert.match(commands, /nginx@sha256:[a-f0-9]{64}/u)
  assert.match(commands, /\/media:ro/u)
  assert.match(commands, /Startup\/Complete/u)
  assert.match(commands, /Startup\/User[^]*username=\$\(sed -n 1p/u)
  assert.match(commands, /jellyfin --version 2>&1 \| grep/u)
  assert.match(commands, /WEBMINAI_JELLYFIN_OK/u)
  assert.doesNotMatch(commands, /\/dev\/dri|privileged:|network_mode: host/u)
  assert.doesNotMatch(commands, /Password\\?"?:\\?"?[a-f0-9]{32}/u)
  assertShellSyntax(built)
})

test('Ubuntu and Debian Jellyfin routes use the signed official pinned repository', () => {
  for (const [built, version] of [[buildJellyfinTask(42, ubuntu), '10.11.11+ubu2404'], [buildJellyfinTask(43, debian), '10.11.11+deb13']]) {
    validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
    const commands = built.plan.commands.map(item => item.command).join('\n')
    assert.match(commands, /4918AABC486CA052358D778D49023CD01DE21A7B/u)
    assert.ok(commands.includes(`jellyfin=${version}`))
    assert.ok(commands.includes(`jellyfin-server=${version}`))
    assert.ok(commands.includes(`jellyfin-web=${version}`))
    assert.match(commands, /apt-get install -y --allow-downgrades/u)
    for (const id of ['install-foundation', 'install-jellyfin']) {
      const command = built.plan.commands.find(item => item.id === id).command
      assert.match(command, /apt-get install[^;]*-o DPkg::Lock::Timeout=120/u)
      assert.doesNotMatch(command, /kill|rm[^;]*\/var\/lib\/dpkg\/lock/u)
    }
    assert.match(commands, /for package in jellyfin jellyfin-server jellyfin-web/u)
    assert.match(commands, /PACKAGE_VERSION_MISMATCH/u)
    assert.match(commands, /Startup\/User/u)
    assert.match(commands, /--ffmpeg=\/usr\/lib\/jellyfin-ffmpeg\/ffmpeg/u)
    assertShellSyntax(built)
  }
})

test('glibc distributions use the checksum-pinned official portable archive', () => {
  for (const host of [rocky, arch]) {
    const built = buildJellyfinTask(44, host)
    validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
    const commands = built.plan.commands.map(item => item.command).join('\n')
    assert.match(commands, /jellyfin_10\.11\.11-amd64\.tar\.gz/u)
    assert.match(commands, /\/server\/linux\/stable\/v10\.11\.11\/amd64\//u)
    assert.doesNotMatch(commands, /latest-stable/u)
    assert.match(commands, /--continue-at - --retry 0 --connect-timeout 15 --max-time 540/u)
    assert.match(built.plan.commands.find(item => item.id === 'install-jellyfin-ffmpeg').command, /--continue-at - --retry 0 --connect-timeout 15 --max-time 540/u)
    assert.match(commands, /9f7f194a7e37777cfde0d107c088fc47e81c7904440046ac0ceb7a289546cf79/u)
    assert.match(commands, /jellyfin-ffmpeg_7\.1\.4-3_portable_linux64-gpl\.tar\.xz/u)
    assert.match(commands, /cab9ff40a47e4232d231e4eb7e4e85fabfeec56c6905266bc94291fc0881f83f/u)
    assert.match(commands, /if ! printf .*jellyfin_10\.11\.11-amd64\.tar\.gz.*sha256sum -c/u)
    assert.match(commands, /jellyfin_10\.11\.11-amd64\.tar\.gz\.tmp/u)
    assert.match(commands, /--ffmpeg=\/opt\/webminai-jellyfin-18113\/ffmpeg/u)
    assert.match(commands, /\bxz\b/u)
    if (host === rocky) assert.match(commands, /\bicu\b/u)
    assert.match(commands, /journalctl -u 'webminai-jellyfin-18113'/u)
    assert.match(built.plan.revertCommands.find(item => item.id === 'restore-foundation').command, /if systemctl cat nginx >\/dev\/null 2>&1; then/u)
    assert.match(commands, /webminai-jellyfin/u)
    assert.doesNotMatch(commands, /rpmfusion|aur|third-party/u)
    assertShellSyntax(built)
  }
})

test('Alpine records a reversible no-change result for its lagging musl packages', () => {
  const built = buildJellyfinTask(45, alpine)
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  assert.equal(built.plan.compatibilityManifest.selectedRoute.status, 'unsupported')
  assert.match(built.plan.commands[0].command, /musl community packages lag/u)
  assert.doesNotMatch(built.plan.commands[0].command, /apk add|docker|curl/u)
  assertShellSyntax(built)
})

test('Jellyfin release matrix is pinned', () => {
  assert.equal(jellyfinRelease().version, '10.11.11')
  assert.equal(jellyfinRelease().portableSha256.length, 64)
  assert.equal(jellyfinRelease().ffmpegVersion, '7.1.4-3')
  assert.equal(jellyfinRelease().ffmpegSha256.length, 64)
  assert.equal(jellyfinRelease().images.length, 2)
})

function assertShellSyntax (built) {
  for (const command of [...built.plan.commands, ...built.plan.revertCommands]) {
    const checked = spawnSync('/bin/sh', ['-n', '-c', command.command], { encoding: 'utf8' })
    assert.equal(checked.status, 0, `${command.id}: ${checked.stderr}`)
  }
}

function context (id, versionId, family) {
  return { fingerprint: `${id}-${versionId}`, identity: { id, versionId, architecture: 'x86_64' }, management: { family }, applications: {} }
}
