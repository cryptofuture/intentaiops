import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildIntentAiOpsInstallTask } from '../src/intent-ai-ops-install-task.js'

test('default POSIX package download verifies its checksum and npm receives only the staged local archive', { skip: process.platform === 'win32' }, () => {
  for (const scenario of ['valid', 'corrupt', 'unavailable', 'malformed']) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-cli-download-'))
    try {
      const state = path.join(directory, 'state')
      const root = path.join(directory, 'install')
      const bin = path.join(directory, 'bin')
      const installer = path.join(directory, 'installer.sh')
      const called = path.join(directory, 'called')
      const payload = 'fixture-package'
      const digest = createHash('sha256').update(payload).digest('hex')
      mkdirSync(bin)
      writeFileSync(installer, `#!/bin/sh\n# INTENTAI_OPS_PACKAGE_URL\ntest "$INTENTAI_OPS_PACKAGE_URL" = '${state}/package.tgz' || exit 97\ntest "$NODE_OPTIONS" = '--max-old-space-size=128 --network-family-autoselection-attempt-timeout=5000' || exit 96\ntest "$npm_config_cache" = '${state}/npm-cache' || exit 95\nprintf called > '${called}'\nprintf '#!/bin/sh\\nexit 0\\n' > "$INTENTAI_OPS_BIN_DIR/intentaiops"\nchmod 0755 "$INTENTAI_OPS_BIN_DIR/intentaiops"\n`)
      const plan = buildIntentAiOpsInstallTask(1, 'linux', { installerPath: installer }).plan
      const rewrite = command => command.replaceAll(plan.modifiedFiles[0], state).replaceAll(plan.modifiedFiles[1], root).replaceAll('/usr/local/bin', bin)
      const run = command => spawnSync('/bin/sh', ['-c', `command () { return 1; }; curl () { url=; output=; while [ "$#" -gt 0 ]; do case "$1" in --output) shift; output=$1;; https:*) url=$1;; esac; shift; done; ${scenario === 'unavailable' ? 'return 28' : `case "$url" in *.sha256) printf '%s\\n' '${scenario === 'corrupt' ? 'b'.repeat(64) : scenario === 'malformed' ? 'not-a-digest' : digest}  ignored-untrusted-filename' > "$output";; *) printf '%s' '${payload}' > "$output";; esac`}; }; ` + rewrite(command)], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=128' } })
      assert.equal(run(plan.commands[0].command).status, 0)
      const result = run(plan.commands[1].command)
      assert.equal(result.status, scenario === 'valid' ? 0 : scenario === 'unavailable' ? 28 : 1, result.stderr)
      assert.equal(existsSync(called), scenario === 'valid')
      if (scenario === 'valid') assert.equal(readFileSync(path.join(state, 'package.tgz'), 'utf8'), payload)
      assert.match(plan.commands[1].command, /--retry 3 --retry-all-errors/u)
      assert.equal(plan.commands[1].retry, undefined)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
})

test('POSIX CLI tasks preserve occupied launchers and dangling roots, and repeated installation is quiet', { skip: process.platform === 'win32' }, () => {
  for (const platform of ['linux', 'freebsd', 'macos']) {
    for (const scenario of ['alias', 'primary', 'dangling-alias', 'dangling-root', 'repeat']) {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-cli-ownership-'))
      try {
        const state = path.join(directory, 'state')
        const root = path.join(directory, 'install')
        const bin = path.join(directory, 'bin')
        const called = path.join(directory, 'called')
        const installer = path.join(directory, 'installer.sh')
        mkdirSync(bin)
        writeFileSync(installer, `#!/bin/sh\n# INTENTAI_OPS_PACKAGE_URL\nprintf 'called\\n' >> '${called}'\nmkdir -p "$INTENTAI_OPS_INSTALL_ROOT"\nprintf '#!/bin/sh\\nexit 0\\n' > "$INTENTAI_OPS_BIN_DIR/intentaiops"\nprintf 'overwritten' > "$INTENTAI_OPS_BIN_DIR/intentops"\nchmod 0755 "$INTENTAI_OPS_BIN_DIR/intentaiops"\n`)
        const target = scenario === 'dangling-root' ? root : path.join(bin, scenario === 'primary' ? 'intentaiops' : 'intentops')
        if (scenario.startsWith('dangling')) symlinkSync(path.join(directory, 'missing'), target)
        else if (scenario !== 'repeat') writeFileSync(target, 'foreign')
        const plan = buildIntentAiOpsInstallTask(1, platform, { installerPath: installer, packageUrl: '/fixture/package.tgz' }).plan
        const rewrite = command => command.replaceAll(plan.modifiedFiles[0], state).replaceAll(plan.modifiedFiles[1], root).replaceAll(path.dirname(plan.modifiedFiles[2]), bin)
        const run = command => spawnSync('/bin/sh', ['-c', 'command () { return 1; }; ' + rewrite(command)], { encoding: 'utf8' })
        assert.equal(run(plan.commands[0].command).status, 0)
        const installed = run(plan.commands[1].command)
        if (scenario === 'repeat') {
          assert.equal(installed.status, 0, installed.stderr)
          assert.equal(run(plan.commands[1].command).status, 0)
          assert.equal(readFileSync(called, 'utf8'), 'called\n')
        } else {
          assert.equal(installed.status, 78, `${platform}/${scenario}: ${installed.stderr}`)
          assert.equal(existsSync(called), false)
          assert.equal(existsSync(path.join(state, 'owns-root')), false)
          if (!scenario.startsWith('dangling')) assert.equal(readFileSync(target, 'utf8'), 'foreign')
        }
      } finally { rmSync(directory, { recursive: true, force: true }) }
    }
  }
})

test('POSIX CLI rollback refuses a symlinked ownership directory', { skip: process.platform === 'win32' }, () => {
  for (const platform of ['linux', 'freebsd', 'macos']) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-cli-rollback-'))
    try {
      const state = path.join(directory, 'state')
      const foreign = path.join(directory, 'foreign')
      const root = path.join(directory, 'install')
      const bin = path.join(directory, 'bin')
      for (const entry of [foreign, root, bin]) mkdirSync(entry)
      writeFileSync(path.join(foreign, 'owns-root'), '')
      writeFileSync(path.join(root, 'preserve'), 'original')
      for (const name of ['intentaiops', 'intentops']) writeFileSync(path.join(bin, name), 'original')
      symlinkSync(foreign, state)
      const plan = buildIntentAiOpsInstallTask(1, platform).plan
      const command = plan.revertCommands[0].command.replaceAll(plan.modifiedFiles[0], state).replaceAll(plan.modifiedFiles[1], root).replaceAll(path.dirname(plan.modifiedFiles[2]), bin)
      const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
      assert.notEqual(result.status, 0, platform)
      assert.equal(readFileSync(path.join(root, 'preserve'), 'utf8'), 'original')
      for (const name of ['intentaiops', 'intentops']) assert.equal(readFileSync(path.join(bin, name), 'utf8'), 'original')
      assert.ok(existsSync(path.join(foreign, 'owns-root')))
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
})

test('Linux CLI acquisition has a bounded 30-minute job while other platforms retain their limits', () => {
  for (const platform of ['linux', 'freebsd', 'macos', 'windows']) {
    const command = buildIntentAiOpsInstallTask(1, platform).plan.commands.find(item => item.id === 'install-intent-ai-ops')
    assert.equal(command.timeoutMs, platform === 'linux' ? 1800000 : 900000)
    assert.equal(command.executionMode, 'job')
    assert.equal(command.retry, undefined)
  }
})

for (const scenario of ['compatible-private', 'incompatible-private', 'missing-private-npm', 'incompatible-system']) {
  test(`installer runtime selection: ${scenario}`, { skip: process.platform === 'win32' }, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'intent-runtime-reuse-'))
    try {
      const tools = path.join(root, 'tools')
      const install = path.join(root, 'install')
      const runtime = path.join(install, 'runtime/bin')
      mkdirSync(tools)
      mkdirSync(runtime, { recursive: true })
      for (const command of ['mkdir', 'cut', 'dirname', 'chmod', 'uname', 'mktemp', 'rm']) symlinkSync(existsSync(`/usr/bin/${command}`) ? `/usr/bin/${command}` : `/bin/${command}`, path.join(tools, command))
      writeFileSync(path.join(runtime, 'node'), `#!/bin/sh\nif [ "$1" = -e ]; then exit ${scenario === 'incompatible-private' ? 1 : 0}; fi\nprintf '24.16.0\\n'\n`, { mode: 0o755 })
      if (scenario !== 'missing-private-npm') writeFileSync(path.join(runtime, 'npm'), `#!/bin/sh\nprintf npm > '${root}/npm-called'\n`, { mode: 0o755 })
      if (scenario === 'incompatible-system') writeFileSync(path.join(tools, 'node'), '#!/bin/sh\nprintf "22.0.0\\n"\n', { mode: 0o755 })
      writeFileSync(path.join(tools, 'curl'), `#!/bin/sh\ncase "$*" in *'--retry 3 --retry-all-errors --retry-delay 2'*) printf curl > '${root}/download-called'; exit 99;; *) exit 98;; esac\n`, { mode: 0o755 })
      const result = spawnSync('/bin/sh', [fileURLToPath(new URL('../scripts/install.sh', import.meta.url))], {
        encoding: 'utf8',
        env: { ...process.env, PATH: tools, INTENTAI_OPS_INSTALL_ROOT: install, INTENTAI_OPS_BIN_DIR: path.join(root, 'bin'), INTENTAI_OPS_PACKAGE_URL: '/fixture/package.tgz' }
      })
      const reused = scenario === 'compatible-private'
      assert.equal(result.status, reused ? 0 : scenario === 'incompatible-system' ? 1 : 99, result.stderr)
      assert.equal(existsSync(path.join(root, 'npm-called')), reused)
      assert.equal(existsSync(path.join(root, 'download-called')), !reused && scenario !== 'incompatible-system')
      assert.ok(existsSync(path.join(runtime, 'node')), 'a failed bootstrap must preserve the old runtime')
      if (reused) assert.ok(readFileSync(path.join(root, 'bin/intentaiops'), 'utf8').includes(path.join(runtime, 'node')))
      if (scenario === 'incompatible-system') assert.match(result.stderr, /Upgrade it explicitly/u)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
