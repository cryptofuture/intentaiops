import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildIntentAiOpsInstallTask } from '../src/intent-ai-ops-install-task.js'

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
