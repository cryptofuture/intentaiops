import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { buildJellyfinTask, jellyfinRelease } from '../src/jellyfin-task.js'
import { validateCommandPlan } from '../src/plan-validator.js'

const ubuntu = context('ubuntu', '24.04', 'debian')
const debian = context('debian', '13', 'debian')
const rocky = context('rocky', '9.8', 'rhel')
const arch = context('arch', '', 'arch')
const alpine = context('alpine', '3.23.5', 'alpine')

test('Jellyfin Compose route pins official images and isolates media without devices', () => {
  const built = buildJellyfinTask(41, ubuntu, { preferred: true, ready: true })
  assert.doesNotMatch(built.plan.commands.find(item => item.id === 'verify-compose').command, /docker compose[^;]* restart/u)
  validateCommandPlan(built.plan, { executionIdentity: 'root', maxJobTimeoutMs: 3600000 })
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /jellyfin\/jellyfin@sha256:[a-f0-9]{64}/u)
  assert.match(commands, /nginx@sha256:[a-f0-9]{64}/u)
  assert.match(commands, /\/media:ro/u)
  assert.match(commands, /Startup\/Complete/u)
  assert.match(commands, /Startup\/User[^]*username=\$\(cat/u)
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
    assert.match(commands, /9f7f194a7e37777cfde0d107c088fc47e81c7904440046ac0ceb7a289546cf79/u)
    assert.match(commands, /jellyfin-ffmpeg_7\.1\.4-3_portable_linux64-gpl\.tar\.xz/u)
    assert.match(commands, /cab9ff40a47e4232d231e4eb7e4e85fabfeec56c6905266bc94291fc0881f83f/u)
    assert.match(commands, /if ! \[ -s .*jellyfin_10\.11\.11-amd64\.tar\.gz/u)
    assert.match(commands, /jellyfin_10\.11\.11-amd64\.tar\.gz\.tmp/u)
    assert.match(commands, /--ffmpeg=\/opt\/webminai-jellyfin-18113\/ffmpeg/u)
    assert.match(commands, /\bxz\b/u)
    if (host === rocky) assert.match(commands, /\bicu\b/u)
    assert.match(commands, /journalctl -u 'webminai-jellyfin-18113'/u)
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
