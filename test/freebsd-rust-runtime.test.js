import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { freebsdRustEnvironment, freebsdRustPackageCommand, freebsdRustSetupCommand } from '../src/freebsd-rust-runtime.js'
import { buildCommonTask } from '../src/common-tasks.js'

test('FreeBSD Rust package selection keeps existing compilers and avoids full Rust on upstream host-tool targets', () => {
  for (const [present, architecture, expected] of [[true, 'amd64', ''], [false, 'amd64', 'rustup-init'], [false, 'aarch64', 'rustup-init'], [false, 'i386', 'rust']]) {
    const result = spawnSync('/bin/sh', ['-c', `command () { return ${present ? 0 : 1}; }; uname () { printf '${architecture}'; }; pkg () { return 1; }; env () { printf '%s' "$5"; }; ` + freebsdRustPackageCommand()], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, expected)
  }
})

test('FreeBSD private Rust pins a minimal toolchain, keeps state private and reuses confirmed setup', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-rust-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tools = path.join(root, 'tools')
  await mkdir(tools)
  for (const name of ['mkdir', 'chmod', 'grep']) await symlink(existsSync('/usr/bin/' + name) ? '/usr/bin/' + name : '/bin/' + name, path.join(tools, name))
  await writeFile(path.join(tools, 'uname'), '#!/bin/sh\nprintf amd64\n', { mode: 0o700 })
  await writeFile(path.join(tools, 'rustup-init'), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$CARGO_HOME/../init-calls"
mkdir -p "$CARGO_HOME/bin"
printf '#!/bin/sh\\nprintf "rustc 1.99.1 (fixture)\\\\n"\\n' > "$CARGO_HOME/bin/rustc"
printf '#!/bin/sh\\nprintf "cargo 1.99.1\\\\n"\\n' > "$CARGO_HOME/bin/cargo"
chmod 700 "$CARGO_HOME/bin/rustc" "$CARGO_HOME/bin/cargo"
`, { mode: 0o700 })
  await mkdir(path.join(root, 'cargo'))
  const state = '/var/lib/webminai/task-state/9-rust'
  const command = freebsdRustSetupCommand(state).replaceAll(state, root)
  const environment = { ...process.env, PATH: tools }
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync('/bin/sh', ['-c', command], { env: environment, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /rustc 1[.]99[.]1/u)
  }
  const calls = await readFile(path.join(root, 'init-calls'), 'utf8')
  assert.equal(calls.trim().split('\n').length, 1)
  assert.match(calls, /--no-modify-path --profile minimal/u)
  assert.match(calls, /--default-toolchain 1[.]99[.]1/u)
  assert.match(freebsdRustEnvironment(state), /RUSTUP_TOOLCHAIN=1[.]99[.]1/u)
  assert.throws(() => freebsdRustSetupCommand('/tmp/unsafe;id'), /Invalid/u)
})

test('FreeBSD Python application plans have a separately journaled build toolchain phase', () => {
  for (const name of ['odoo', 'home-assistant']) {
    const plan = buildCommonTask(name + '-freebsd', 9, { platform: 'freebsd', freebsdExecution: { platform: 'freebsd' } }).plan
    const phase = plan.commands.find(command => command.id === `install-${name}-build-toolchain`)
    assert.equal(phase.executionMode, 'job')
    assert.equal(phase.timeoutMs, 3600000)
    assert.deepEqual(plan.commands.find(command => command.id === `install-${name}-application`).dependsOn, [phase.id])
    assert.ok(plan.commands.find(command => command.id === `install-${name}-application`).command.includes('/rust-private-ready'))
  }
})
