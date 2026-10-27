import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildCommonTask } from '../src/common-tasks.js'
import { buildCliLifecycleProbe } from '../scripts/cli-lifecycle-probe.js'

for (const catalogId of ['systemd-service', 'systemd-timer', 'logrotate-rule', 'tmpfiles-rule']) {
  test(`${catalogId} restores the complete isolated filesystem after two applies and two rollbacks`, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'intent-common-restoration-'))
    try {
      writeFileSync(path.join(root, 'unrelated'), 'private unrelated contents', { mode: 0o600 })
      symlinkSync('unrelated', path.join(root, 'unrelated-link'))
      const built = buildCommonTask(catalogId, 89, { platform: 'linux' })
      const mappings = built.plan.modifiedFiles.map((entry, index) => [entry, `${root}/managed-${index}`]).sort((a, b) => b[0].length - a[0].length)
      const relocate = text => mappings.reduce((value, [original, replacement]) => value.replaceAll(original, replacement), text).replaceAll('systemd-tmpfiles', 'fixture_tmpfiles')
      const runtime = mappings.find(([entry]) => entry.startsWith('/run/'))?.[1]
      const prefix = `logrotate () { :; }; fixture_tmpfiles () { mkdir -m 0750 '${runtime}'; }; systemctl () { case "$1" in start|enable) : > '${runtime}';; esac; }; probe_packages () { printf 'fixture-package-version\\n'; };`
      const run = command => {
        const result = spawnSync('/bin/sh', ['-c', prefix + command], { encoding: 'utf8', timeout: 10000 })
        assert.equal(result.status, 0, result.stderr)
        return result.stdout
      }
      const probe = buildCliLifecycleProbe({ paths: [root], packageManager: 'apt', serviceManager: 'systemd' }).replaceAll('dpkg-query', 'probe_packages')
      const baseline = run(probe)
      run(relocate(built.plan.commands[0].command))
      const applied = run(probe)
      assert.notEqual(applied, baseline)
      run(relocate(built.plan.commands[0].command))
      assert.equal(run(probe), applied, 'second apply changed the isolated managed tree')
      for (let attempt = 0; attempt < 2; attempt++) {
        run(relocate(built.plan.revertCommands[0].command))
        assert.equal(run(probe), baseline, 'rollback did not restore the entire isolated tree')
      }
      assert.equal(readFileSync(path.join(root, 'unrelated'), 'utf8'), 'private unrelated contents')
      assert.doesNotMatch(baseline + applied, /private unrelated contents/u)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
