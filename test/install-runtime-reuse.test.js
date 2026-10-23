import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildIntentAiOpsInstallTask } from '../src/intent-ai-ops-install-task.js'

test('FreeBSD installer verifies SQLite and limits npm 12 lifecycle approval to its native dependencies', () => {
  for (const version of ['11.9.0', '12.0.2']) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-freebsd-installer-'))
    try {
      const tools = path.join(directory, 'tools')
      const install = path.join(directory, 'install')
      const runtime = path.join(install, 'runtime/bin')
      const scripts = path.join(install, 'npm/lib/node_modules/intent-ai-ops/scripts')
      mkdirSync(tools)
      mkdirSync(runtime, { recursive: true })
      for (const command of ['mkdir', 'cut', 'dirname', 'chmod']) symlinkSync(existsSync(`/usr/bin/${command}`) ? `/usr/bin/${command}` : `/bin/${command}`, path.join(tools, command))
      symlinkSync(process.execPath, path.join(runtime, 'node'))
      writeFileSync(path.join(tools, 'uname'), '#!/bin/sh\nprintf FreeBSD\n', { mode: 0o700 })
      writeFileSync(path.join(tools, 'pkg'), '#!/bin/sh\n[ "$1" = info ] || exit 99\n', { mode: 0o700 })
      writeFileSync(path.join(tools, 'python3.12'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
      mkdirSync(scripts, { recursive: true })
      writeFileSync(path.join(scripts, 'install-better-sqlite3.js'), `require('node:assert/strict').equal(process.env.PYTHON, ${JSON.stringify(path.join(tools, 'python3.12'))}); require('node:fs').writeFileSync(${JSON.stringify(path.join(directory, 'sqlite-verified'))}, 'verified')`)
      writeFileSync(path.join(runtime, 'npm'), `#!/bin/sh\nif [ "$1" = --version ]; then printf '${version}'; exit 0; fi\nprintf '%s\\n' "$@" > '${directory}/npm-arguments'\n`, { mode: 0o700 })
      const result = spawnSync('/bin/sh', [fileURLToPath(new URL('../scripts/install.sh', import.meta.url))], { encoding: 'utf8', env: { ...process.env, PYTHON: '', PATH: tools, INTENTAI_OPS_INSTALL_ROOT: install, INTENTAI_OPS_BIN_DIR: path.join(directory, 'bin'), INTENTAI_OPS_PACKAGE_URL: '/fixture/package.tgz' } })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(readFileSync(path.join(directory, 'sqlite-verified'), 'utf8'), 'verified')
      const argumentsText = readFileSync(path.join(directory, 'npm-arguments'), 'utf8')
      assert.equal(argumentsText.includes('--allow-scripts=better-sqlite3,node-pty'), version.startsWith('12.'))
      assert.ok(!argumentsText.includes('dangerously-allow-all-scripts'))
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
})

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

for (const scenario of ['valid', 'compatible-system', 'corrupt-checksum', 'malformed-checksum', 'download-failed', 'unsupported-architecture']) {
  test(`Linux common-task private runtime preserves incompatible system Node: ${scenario}`, { skip: process.platform === 'win32' }, () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-private-cli-node-'))
    try {
      const tools = path.join(directory, 'tools')
      const state = path.join(directory, 'state')
      const root = path.join(directory, 'install')
      const bin = path.join(directory, 'bin')
      for (const entry of [tools, bin]) mkdirSync(entry)
      for (const name of ['install', 'mkdir', 'cp', 'chmod', 'grep', 'sh', 'awk', 'sha256sum', 'rm']) symlinkSync(`/usr/bin/${name}`, path.join(tools, name))
      const version = /^NODE_VERSION=(.+)$/mu.exec(readFileSync(fileURLToPath(new URL('../scripts/install.sh', import.meta.url)), 'utf8'))[1]
      const systemNode = `#!/bin/sh\nif [ "$1" = -e ]; then exit ${scenario === 'compatible-system' ? 0 : 1}; fi\nprintf '${scenario === 'compatible-system' ? version : '22.23.3'}\\n'\n`
      writeFileSync(path.join(tools, 'node'), systemNode, { mode: 0o755 })
      writeFileSync(path.join(tools, 'uname'), `#!/bin/sh\nprintf '%s\\n' '${scenario === 'unsupported-architecture' ? 'unsupported' : 'x86_64'}'\n`, { mode: 0o755 })
      const payload = 'verified-node-archive-fixture'
      const digest = scenario === 'corrupt-checksum' ? 'b'.repeat(64) : scenario === 'malformed-checksum' ? 'invalid' : createHash('sha256').update(payload).digest('hex')
      writeFileSync(path.join(tools, 'curl'), `#!/bin/sh\n${scenario === 'download-failed' ? 'exit 28\n' : ''}url=; output=; while [ "$#" -gt 0 ]; do case "$1" in --output) shift; output=$1;; https:*) url=$1;; esac; shift; done\nprintf 'called\\n' >> '${directory}/downloads'\ncase "$url" in */SHASUMS256.txt) printf '%s  %s\\n' '${digest}' 'node-v${version}-linux-x64.tar.gz' > "$output";; *) printf '%s' '${payload}' > "$output";; esac\n`, { mode: 0o755 })
      writeFileSync(path.join(tools, 'tar'), `#!/bin/sh\ncase " $* " in *' --no-same-owner '*) :;; *) exit 96;; esac\nwhile [ "$#" -gt 0 ]; do case "$1" in -C) shift; destination=$1;; esac; shift; done\n/bin/mkdir -p "$destination/bin"\nprintf '#!/bin/sh\\nexit 0\\n' > "$destination/bin/npm"\nprintf '#!/bin/sh\\nif [ "$1" = -e ]; then exit 0; fi\\nprintf "${version}\\\\n"\\n' > "$destination/bin/node"\n/bin/chmod 0755 "$destination/bin/node" "$destination/bin/npm"\n`, { mode: 0o755 })
      const installer = path.join(directory, 'installer.sh')
      writeFileSync(installer, `#!/bin/sh\n# INTENTAI_OPS_PACKAGE_URL\n[ "$(command -v node)" = "${scenario === 'compatible-system' ? tools + '/node' : '$INTENTAI_OPS_INSTALL_ROOT/runtime/bin/node'}" ] || exit 97\nmkdir -p "$INTENTAI_OPS_INSTALL_ROOT"\nprintf called > '${directory}/installed'\nprintf '#!/bin/sh\\nexec "%s" --help\\n' "$(command -v node)" > "$INTENTAI_OPS_BIN_DIR/intentaiops"\nchmod 0755 "$INTENTAI_OPS_BIN_DIR/intentaiops"\n`)
      const plan = buildIntentAiOpsInstallTask(1, 'linux', { installerPath: installer, packageUrl: '/fixture/package.tgz' }, { identity: { id: 'arch' } }).plan
      const rewrite = command => command.replaceAll(plan.modifiedFiles[0], state).replaceAll(plan.modifiedFiles[1], root).replaceAll('/usr/local/bin', bin)
      const run = command => spawnSync('/bin/sh', ['-c', 'umask 002; ' + rewrite(command)], { encoding: 'utf8', env: { ...process.env, PATH: tools }, timeout: 10000 })
      assert.equal(run(plan.commands[0].command).status, 0)
      const result = run(plan.commands[1].command)
      const success = ['valid', 'compatible-system'].includes(scenario)
      assert.equal(result.status, success ? 0 : scenario === 'download-failed' ? 28 : 1, result.stderr)
      assert.equal(readFileSync(path.join(tools, 'node'), 'utf8'), systemNode)
      assert.equal(existsSync(path.join(directory, 'installed')), success)
      if (success) {
        assert.equal(statSync(root).mode & 0o777, 0o755)
        assert.equal(run(plan.commands[1].command).status, 0)
        if (scenario === 'valid') assert.equal(readFileSync(path.join(directory, 'downloads'), 'utf8'), 'called\ncalled\n')
        else assert.equal(existsSync(path.join(directory, 'downloads')), false)
        assert.equal(existsSync(path.join(state, 'node-runtime.tar.gz')), false)
        for (let attempt = 0; attempt < 2; attempt++) assert.equal(run(plan.revertCommands[0].command).status, 0)
        assert.equal(existsSync(root), false)
        assert.equal(existsSync(state), false)
        assert.equal(readFileSync(path.join(tools, 'node'), 'utf8'), systemNode)
      } else assert.equal(existsSync(path.join(root, 'runtime/bin/node')), false)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
}

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
