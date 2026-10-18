import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildCommonTask } from '../src/common-tasks.js'
import { LinuxHostContextService } from '../src/linux-host-context.js'
import { httpMarkerCheck, mariadbDataPreflight, wordpressArtifactCommand } from '../src/linux-php-foundation.js'
import { buildN8nTask, n8nRelease } from '../src/n8n-task.js'
import { moodleRelease } from '../src/moodle-task.js'
import { buildMattermostTask, mattermostRelease } from '../src/mattermost-task.js'
import { buildJellyfinTask } from '../src/jellyfin-task.js'
import { buildOdooTask } from '../src/odoo-task.js'

test('system-user rollback without its baseline preserves an existing account', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-user-rollback-'))
  try {
    const command = buildCommonTask('system-user', 327).plan.revertCommands[0].command
      .replaceAll('/var/lib/webminai/task-state', `${root}/state`)
    const result = spawnSync('/bin/sh', ['-c', `id () { return 0; }; userdel () { printf removed; }; deluser () { printf removed; }; ${command}`], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('native PHP restoration reports failure and retains recovery state', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-php-restore-'))
  try {
    const context = await new LinuxHostContextService({ fetchImpl: async () => new Response('official release') }).build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
    })
    for (const id of ['wordpress-linux', 'woocommerce-linux', 'joomla-linux', 'drupal-linux', 'prestashop-linux', 'moodle-linux']) {
      const built = buildCommonTask(id, 328, { platform: 'linux', linuxContext: context, docker: { preferred: false } })
      const original = built.plan.modifiedFiles.find(file => file.startsWith('/var/lib/webminai/task-state/'))
      for (const restartFails of [false, true]) {
        const state = path.join(root, `${id}-${restartFails}`)
        mkdirSync(state)
        writeFileSync(path.join(state, 'packages.added'), 'fixture-package\n')
        writeFileSync(path.join(state, 'database-data.existed'), '')
        if (restartFails) writeFileSync(path.join(state, 'service-0.active'), '')
        const command = built.plan.revertCommands.find(item => item.id === 'restore-packages-services').command.replaceAll(original, state)
        const result = spawnSync('/bin/sh', ['-c', `systemctl () { return ${restartFails ? 24 : 0}; }; env () { return 23; }; ${command}`], { encoding: 'utf8' })
        assert.notEqual(result.status, 0, `${id}: failed restoration was reported successful`)
        assert.ok(existsSync(path.join(state, 'packages.added')), `${id}: recovery baseline was deleted`)
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('cron fixture refuses existing entries and dangling links before creating task state', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-cron-baseline-'))
  try {
    const entry = `${root}/cron/webminai-test`
    mkdirSync(path.dirname(entry))
    const command = buildCommonTask('cron-job', 326).plan.commands[0].command
      .replaceAll('/var/lib/webminai/task-state', `${root}/state`)
      .replaceAll('/etc/cron.d', `${root}/cron`)
      .replaceAll('/tmp/webminai-cron-ran', `${root}/ran`)
    for (const dangling of [false, true]) {
      if (dangling) symlinkSync(`${root}/absent`, entry)
      else writeFileSync(entry, 'existing operator entry\n')
      const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
      assert.equal(result.status, 1, result.stderr)
      assert.equal(existsSync(`${root}/state`), false)
      if (!dangling) assert.equal(readFileSync(entry, 'utf8'), 'existing operator entry\n')
      rmSync(entry)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('HTTP marker checks drain large responses and reject failed transfers containing a marker', () => {
  const check = httpMarkerCheck('curl --fail --max-time 10 http://127.0.0.1/', 'EXPECTED_MARKER')
  const run = body => spawnSync('/bin/sh', ['-c', `set -eu; curl () { ${body}; }; ${check}; printf verified`], { encoding: 'utf8' })
  const large = run("printf 'EXPECTED_MARKER\\n'; head -c 1048576 /dev/zero | tr '\\000' x")
  assert.equal(large.status, 0, large.stderr)
  assert.equal(large.stdout, 'verified')
  assert.equal(large.stderr, '')
  for (const status of [18, 22, 23, 28]) {
    const failed = run(`printf 'EXPECTED_MARKER\\n'; return ${status}`)
    assert.equal(failed.status, status)
    assert.equal(failed.stdout, '')
  }
  const missing = run("printf 'unrelated response'")
  assert.equal(missing.status, 1)
  assert.equal(missing.stdout, '')
  const html = spawnSync('/bin/sh', ['-c', `curl () { printf '<HTML>'; }; ${httpMarkerCheck('curl', '<!DOCTYPE html|<html', '-Ei')}`], { encoding: 'utf8' })
  assert.equal(html.status, 0, html.stderr)
})

test('Linux PHP native and Compose verification checks preserve HTTP transfer outcomes', async () => {
  const context = await new LinuxHostContextService({ fetchImpl: async () => new Response('official release') }).build({
    inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
    execution: { platform: 'linux', architecture: 'x86_64', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
  })
  for (const preferred of [false, true]) {
    for (const id of ['woocommerce-linux', 'joomla-linux', 'drupal-linux', 'prestashop-linux', 'moodle-linux']) {
      const built = buildCommonTask(id, 324, { platform: 'linux', linuxContext: context, docker: { preferred, ready: true, installMethod: 'official-apt' } })
      assert.match(built.verifyApplied, /response=\$\(curl/u, id)
      for (const command of [...built.plan.commands.map(value => value.command), built.verifyApplied]) {
        assert.doesNotMatch(command, /curl[^;\n]*\| grep -[FE]i?q\b/u, id)
        const syntax = spawnSync('/bin/sh', ['-n', '-c', command], { encoding: 'utf8' })
        assert.equal(syntax.status, 0, `${id}: ${syntax.stderr}`)
      }
    }
  }
})

test('Arch PHP baseline preserves shared nginx configuration but refuses owned paths and dangling links', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-arch-php-baseline-'))
  try {
    const context = await new LinuxHostContextService({ fetchImpl: async () => new Response('official release') }).build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', init: 'systemd', osRelease: { ID: 'arch' }, commands: { pacman: true } }
    })
    const built = buildCommonTask('woocommerce-linux', 325, { platform: 'linux', linuxContext: context })
    const config = `${root}/etc/nginx/nginx.conf`
    mkdirSync(path.dirname(config), { recursive: true })
    writeFileSync(config, 'http {\n}\n')
    const command = built.plan.commands[0].command.replaceAll('/var/', `${root}/var/`).replaceAll('/etc/', `${root}/etc/`).replaceAll('/root/', `${root}/root/`).replaceAll('/run/', `${root}/run/`)
    const mocks = "pacman () { printf 'base-package\\n'; }; systemctl () { return 1; }; "
    const state = `${root}/var/lib/webminai/task-state/325-woocommerce-linux`
    const owned = `${root}/srv/webminai-woocommerce-18102`
    const safeCommand = command.replaceAll('/srv/', `${root}/srv/`).replace('install -d -o root -g root -m 0700', 'mkdir -p')
    mkdirSync(path.dirname(owned), { recursive: true })
    symlinkSync(`${root}/missing`, owned)
    const blocked = spawnSync('/bin/sh', ['-c', mocks + safeCommand], { encoding: 'utf8' })
    assert.equal(blocked.status, 1)
    assert.match(blocked.stderr, /task target already exists/u)
    assert.equal(existsSync(state), false)
    rmSync(owned)
    const captured = spawnSync('/bin/sh', ['-c', mocks + safeCommand], { encoding: 'utf8' })
    assert.equal(captured.status, 0, captured.stderr)
    assert.equal(readFileSync(`${state}/nginx.conf.before`, 'utf8'), 'http {\n}\n')
    assert.equal(readFileSync(config, 'utf8'), 'http {\n}\n')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Alpine PHP rollback never starts a previously inactive service', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-alpine-service-restore-'))
  try {
    const context = await new LinuxHostContextService({ fetchImpl: async () => new Response('official release') }).build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', init: 'openrc', osRelease: { ID: 'alpine', VERSION_ID: '3.23' }, commands: { apk: true } }
    })
    const built = buildCommonTask('woocommerce-linux', 326, { platform: 'linux', linuxContext: context })
    const state = `${root}/state`
    const command = built.plan.revertCommands.find(value => value.id === 'restore-packages-services').command
      .replaceAll('/var/lib/webminai/task-state/326-woocommerce-linux', state)
      .replaceAll('/var/lib/mysql', `${root}/mysql`).replaceAll('/run/mysqld', `${root}/mysqld`).replaceAll('/run/mariadb', `${root}/mariadb`)
      .replaceAll('rc-service ', 'mock_rc_service ')
    for (const active of [false, true]) {
      mkdirSync(state)
      writeFileSync(`${state}/packages.added`, '')
      writeFileSync(`${root}/calls`, '')
      if (active) writeFileSync(`${state}/service-0.active`, '')
      const result = spawnSync('/bin/sh', ['-c', `mock_rc_service () { printf '%s %s\\n' "$1" "$2" >> '${root}/calls'; [ "$2" != restart ]; }; ${command}`], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(readFileSync(`${root}/calls`, 'utf8'), active ? 'mariadb restart\nmariadb start\nphp-fpm83 stop\nnginx stop\n' : 'mariadb stop\nphp-fpm83 stop\nnginx stop\n')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Odoo baseline actually stops for an existing executable and dangling data path', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-odoo-baseline-'))
  try {
    const built = buildOdooTask(321, { identity: { id: 'ubuntu', versionId: '24.04', architecture: 'x86_64' }, management: { family: 'debian' } })
    const command = built.plan.commands[0].command.replaceAll('/opt/', `${root}/opt/`).replaceAll('/var/', `${root}/var/`).replaceAll('/root/', `${root}/root/`).replaceAll('/etc/', `${root}/etc/`).replace('command -v odoo', 'mock_odoo_probe')
    const installed = spawnSync('/bin/sh', ['-c', 'mock_odoo_probe () { return 0; }; ' + command], { encoding: 'utf8' })
    assert.equal(installed.status, 1)
    assert.match(installed.stderr, /BASELINE_DRIFT: Odoo executable already exists/)
    assert.equal(existsSync(`${root}/var/lib/webminai/task-state/321-odoo-linux`), false)
    mkdirSync(`${root}/var/lib`, { recursive: true })
    symlinkSync(path.join(root, 'missing-data'), `${root}/var/lib/odoo`)
    const linked = spawnSync('/bin/sh', ['-c', 'mock_odoo_probe () { return 1; }; ' + command], { encoding: 'utf8' })
    assert.equal(linked.status, 1)
    assert.match(linked.stderr, /BASELINE_DRIFT: managed path already exists:/)
    assert.equal(existsSync(`${root}/var/lib/webminai/task-state/321-odoo-linux`), false)
    rmSync(`${root}/var/lib/odoo`)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('openSUSE Jellyfin uses its nginx vhost directory and refuses either existing layout', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-jellyfin-suse-'))
  try {
    const built = buildJellyfinTask(322, { identity: { id: 'opensuse-leap', architecture: 'x86_64' }, management: { family: 'suse' } })
    const current = '/etc/nginx/vhosts.d/webminai-jellyfin-18113.conf'
    const legacy = '/etc/nginx/conf.d/webminai-jellyfin-18113.conf'
    assert.ok(built.plan.modifiedFiles.includes(current))
    assert.ok(built.plan.commands.find(c => c.id === 'configure-jellyfin').command.includes(current))
    assert.ok(built.plan.revertCommands.find(c => c.id === 'stop-jellyfin').command.includes(current))
    const baseline = built.plan.commands[0].command.replaceAll('/opt/', `${root}/opt/`).replaceAll('/var/', `${root}/var/`).replaceAll('/root/', `${root}/root/`).replaceAll('/etc/', `${root}/etc/`)
    for (const file of [current, legacy]) {
      mkdirSync(path.dirname(`${root}${file}`), { recursive: true })
      writeFileSync(`${root}${file}`, 'preserve')
      const result = spawnSync('/bin/sh', ['-c', baseline], { encoding: 'utf8' })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /BASELINE_DRIFT/)
      assert.equal(readFileSync(`${root}${file}`, 'utf8'), 'preserve')
      assert.equal(existsSync(`${root}/var/lib/webminai/task-state/322-jellyfin-linux`), false)
      rmSync(`${root}${file}`)
    }
    assert.ok(!built.plan.revertCommands.some(c => c.command.includes(legacy)))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('portable Jellyfin rollback preserves unrelated default data and service', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-jellyfin-owned-'))
  try {
    const defaults = ['/etc/jellyfin', '/var/lib/jellyfin', '/var/cache/jellyfin', '/var/log/jellyfin']
    for (const [id, family] of [['arch', 'arch'], ['rocky', 'rhel'], ['opensuse-leap', 'suse']]) {
      const built = buildJellyfinTask(319, { identity: { id, architecture: 'x86_64' }, management: { family } })
      if (family === 'arch') assert.ok(built.plan.modifiedFiles.includes('/etc/nginx/nginx.conf'))
      const remap = command => command.replaceAll('/opt/', `${root}/opt/`).replaceAll('/var/', `${root}/var/`).replaceAll('/root/', `${root}/root/`).replaceAll('/etc/', `${root}/etc/`)
      for (const directory of defaults) {
        mkdirSync(`${root}${directory}`, { recursive: true })
        writeFileSync(`${root}${directory}/keep`, 'pre-existing')
      }
      const stop = built.plan.revertCommands.find(c => c.id === 'stop-jellyfin').command
      const remove = built.plan.revertCommands.find(c => c.id === 'remove-jellyfin-files').command
      const result = spawnSync('/bin/sh', ['-c', `systemctl () { printf '%s\\n' "$*" >> '${root}/calls'; }; nginx () { return 0; }; ` + remap(stop) + '; ' + remap(remove)], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      assert.doesNotMatch(readFileSync(path.join(root, 'calls'), 'utf8'), /disable --now jellyfin(?:\n|$)/)
      for (const directory of defaults) assert.equal(readFileSync(`${root}${directory}/keep`, 'utf8'), 'pre-existing')
      rmSync(path.join(root, 'calls'))
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('package Jellyfin owns default data only after refusing pre-existing paths and units', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-jellyfin-defaults-'))
  try {
    const built = buildJellyfinTask(320, { identity: { id: 'debian', versionId: '13', architecture: 'x86_64' }, management: { family: 'debian' } })
    const baseline = built.plan.commands[0].command
    assert.match(baseline, /if systemctl cat jellyfin\.service/)
    for (const file of ['/etc/jellyfin', '/var/lib/jellyfin', '/var/cache/jellyfin', '/var/log/jellyfin']) {
      assert.ok(baseline.includes(`BASELINE_DRIFT: managed path already exists: ${file}`))
      assert.ok(built.plan.revertCommands.find(c => c.id === 'remove-jellyfin-files').command.includes(`'${file}'`))
    }
    const command = baseline.replaceAll('/opt/', `${root}/opt/`).replaceAll('/var/', `${root}/var/`).replaceAll('/root/', `${root}/root/`).replaceAll('/etc/', `${root}/etc/`)
    mkdirSync(`${root}/etc`, { recursive: true })
    symlinkSync(path.join(root, 'missing-data'), `${root}/etc/jellyfin`)
    const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /BASELINE_DRIFT/)
    assert.equal(existsSync(`${root}/var/lib/webminai/task-state/320-jellyfin-linux`), false)
    rmSync(`${root}/etc/jellyfin`)
    const unit = spawnSync('/bin/sh', ['-c', `getent () { return 2; }; mock_jellyfin_probe () { return 1; }; systemctl () { printf checked > '${root}/unit-probed'; return 0; }; ` + command.replace('command -v jellyfin', 'mock_jellyfin_probe')], { encoding: 'utf8' })
    assert.equal(unit.status, 1)
    assert.equal(readFileSync(path.join(root, 'unit-probed'), 'utf8'), 'checked')
    assert.equal(existsSync(`${root}/var/lib/webminai/task-state/320-jellyfin-linux`), false)
    for (const guard of ['account', 'binary', 'port']) {
      const mocks = `getent () { return ${guard === 'account' ? 0 : 2}; }; mock_jellyfin_probe () { return ${guard === 'binary' ? 0 : 1}; }; systemctl () { return 1; }; ss () { ${guard === 'port' ? "printf '%s\\n' 'LISTEN 0 128 0.0.0.0:8096 0.0.0.0:*';" : 'return 0;'} }; `
      const blocked = spawnSync('/bin/sh', ['-c', mocks + command.replace('command -v jellyfin', 'mock_jellyfin_probe')], { encoding: 'utf8' })
      assert.equal(blocked.status, 1, guard)
      assert.match(blocked.stderr, /BASELINE_DRIFT/)
      assert.equal(existsSync(`${root}/var/lib/webminai/task-state/320-jellyfin-linux`), false)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('n8n baseline explains an existing path or dangling symlink without changing it', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-n8n-baseline-'))
  try {
    const context = { identity: { id: 'arch', architecture: 'x86_64' }, management: { family: 'arch', serviceManager: 'systemd' } }
    const command = buildN8nTask(318, context, { preferred: false }).plan.commands[0].command
      .replaceAll('/var/lib/webminai/task-state/318-n8n-linux', path.join(root, 'state'))
      .replaceAll('/opt/webminai-n8n-18109', path.join(root, 'app'))
    for (const link of [false, true]) {
      if (link) symlinkSync(path.join(root, 'missing'), path.join(root, 'app'))
      else mkdirSync(path.join(root, 'app'))
      const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /BASELINE_DRIFT: managed path already exists:/)
      assert.equal(existsSync(path.join(root, 'state')), false)
      rmSync(path.join(root, 'app'), { recursive: !link })
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Jellyfin rejects a mismatched server or web package even when its meta-package is pinned', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-jellyfin-pins-'))
  try {
    writeFileSync(path.join(root, 'packages.before'), '')
    const built = buildJellyfinTask(316, { identity: { id: 'debian', versionId: '13', architecture: 'x86_64' }, management: { family: 'debian' } })
    const command = built.plan.commands.find(c => c.id === 'install-jellyfin').command.replaceAll('/var/lib/webminai/task-state/316-jellyfin-linux', root).replaceAll('apt-get', 'mock_apt_get').replaceAll('dpkg-query', 'mock_dpkg_query')
    for (const mismatched of ['', 'jellyfin-server', 'jellyfin-web']) {
      const result = spawnSync('/bin/sh', ['-c', `mock_apt_get () { case "$*" in *'jellyfin=10.11.11+deb13'*'jellyfin-server=10.11.11+deb13'*'jellyfin-web=10.11.11+deb13'*) return 0;; *) return 99;; esac; }; systemctl () { return 0; }; mock_dpkg_query () { if [ "$#" -eq 2 ]; then return 0; fi; if [ "$3" = '${mismatched}' ]; then printf '12.2+deb13'; else printf '10.11.11+deb13'; fi; }; ` + command], { encoding: 'utf8' })
      assert.equal(result.status, mismatched ? 1 : 0, result.stderr)
      if (mismatched) assert.match(result.stderr, new RegExp(`PACKAGE_VERSION_MISMATCH: ${mismatched}`))
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Jellyfin rollback tolerates a removed nginx unit but still restores an installed service', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-jellyfin-rollback-'))
  try {
    const built = buildJellyfinTask(314, { identity: { id: 'arch', architecture: 'x86_64' }, management: { family: 'arch' } })
    const state = path.join(root, 'state')
    const command = built.plan.revertCommands.find(c => c.id === 'restore-foundation').command.replaceAll('/var/lib/webminai/task-state/314-jellyfin-linux', state)
    for (const installed of [false, true]) {
      mkdirSync(state)
      writeFileSync(path.join(state, 'nginx.active'), '')
      writeFileSync(path.join(state, 'nginx.enabled'), '')
      const result = spawnSync('/bin/sh', ['-c', `getent () { return 2; }; systemctl () { printf '%s\\n' "$*" >> '${root}/calls'; case "$1" in cat) ${installed ? 'return 0' : 'return 1'};; start) ${installed ? 'return 0' : 'return 5'};; esac; }; ` + command], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(existsSync(state), false)
      assert.equal(readFileSync(path.join(root, 'calls'), 'utf8').includes('start nginx'), installed)
      rmSync(path.join(root, 'calls'))
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Jellyfin rollback never purges an upgraded pre-existing Debian package and rejects missing or empty baselines', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-jellyfin-package-baseline-'))
  try {
    const built = buildJellyfinTask(317, { identity: { id: 'debian', versionId: '13', architecture: 'x86_64' }, management: { family: 'debian' } })
    const state = path.join(root, 'state')
    const command = built.plan.revertCommands.find(c => c.id === 'restore-foundation').command.replaceAll('/var/lib/webminai/task-state/317-jellyfin-linux', state).replaceAll('/etc/apt/sources.list.d/jellyfin.sources', path.join(root, 'jellyfin.sources')).replaceAll('/etc/apt/keyrings/jellyfin.gpg', path.join(root, 'jellyfin.gpg')).replaceAll('apt-get', 'mock_apt_get')
    const mocks = `getent () { return 2; }; systemctl () { return 0; }; mock_apt_get () { if [ "$1" = purge ]; then printf '%s\\n' "$*" > '${root}/removed'; fi; }; `
    for (const baseline of ['present', 'missing', 'empty']) {
      mkdirSync(state)
      if (baseline !== 'missing') writeFileSync(path.join(state, 'packages.before'), baseline === 'present' ? 'libc6 1\ncurl 1\n' : '')
      writeFileSync(path.join(state, 'packages.added'), 'libc6 2\ncurl 2\njellyfin 10.11.11+deb13\n')
      const result = spawnSync('/bin/sh', ['-c', mocks + command], { encoding: 'utf8' })
      assert.equal(result.status, baseline === 'present' ? 0 : 1, result.stderr)
      assert.equal(existsSync(path.join(root, 'removed')), baseline === 'present')
      if (baseline === 'present') {
        assert.equal(readFileSync(path.join(root, 'removed'), 'utf8'), 'purge -y jellyfin\n')
        rmSync(path.join(root, 'removed'))
      }
      if (existsSync(state)) rmSync(state, { recursive: true })
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Arch rollback stops only task-added nginx before removal and refuses removal if stopping fails', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-arch-nginx-'))
  const context = { identity: { id: 'arch', architecture: 'x86_64' }, management: { family: 'arch', serviceManager: 'systemd' } }
  try {
    for (const [catalog, builder, step] of [['n8n', buildN8nTask, 'restore-packages'], ['jellyfin', buildJellyfinTask, 'restore-foundation']]) {
      for (const [owned, denied] of [[false, false], [true, false], [true, true]]) {
        const state = path.join(root, `${catalog}-${owned}-${denied}`)
        mkdirSync(state)
        writeFileSync(path.join(state, 'packages.before'), owned ? 'curl\n' : 'curl\nnginx\n')
        writeFileSync(path.join(state, 'packages.added'), owned ? 'nginx\n' : 'xz\n')
        const built = builder(315, context)
        const command = built.plan.revertCommands.find(c => c.id === step).command.replaceAll(`/var/lib/webminai/task-state/315-${catalog}-linux`, state)
        const result = spawnSync('/bin/sh', ['-c', `getent () { return 2; }; systemctl () { case "$1" in cat) return 1;; stop) printf 'stop\\n' >> '${root}/calls'; return ${denied ? 7 : 0};; esac; }; pacman () { if [ "$1" = -Qq ]; then printf 'curl\\nnginx\\n'; else printf 'remove\\n' >> '${root}/calls'; fi; }; xargs () { printf 'remove\\n' >> '${root}/calls'; }; ` + command], { encoding: 'utf8' })
        assert.equal(result.status, denied ? 7 : 0, result.stderr)
        const calls = existsSync(path.join(root, 'calls')) ? readFileSync(path.join(root, 'calls'), 'utf8') : ''
        if (owned) assert.equal(calls, denied ? 'stop\n' : 'stop\nremove\n')
        else assert.doesNotMatch(calls, /stop/u)
        if (existsSync(path.join(root, 'calls'))) rmSync(path.join(root, 'calls'))
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Mattermost resumes partial downloads and never extracts an invalid complete archive', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-mattermost-acquire-'))
  try {
    const app = path.join(root, 'application')
    const state = path.join(root, 'state')
    mkdirSync(state)
    const archive = path.join(state, 'mattermost-team-11.7.8-linux-amd64.tar.gz')
    const content = 'verified archive'
    const digest = createHash('sha256').update(content).digest('hex')
    const binary = path.join(root, 'mattermost')
    writeFileSync(binary, '#!/bin/sh\nprintf 11.7.8\n', { mode: 0o755 })
    const built = buildMattermostTask(313, { identity: { id: 'ubuntu', versionId: '24.04' }, management: { family: 'debian' } })
    const command = built.plan.commands.find(c => c.id === 'install-mattermost').command.replaceAll('/opt/webminai-mattermost-18111', app).replaceAll('/var/lib/webminai/task-state/313-mattermost-linux', state).replaceAll(mattermostRelease().archiveSha256, digest).replace('-ge 411962109', `-ge ${content.length}`).replaceAll('-o root -g root ', '')
    const mocks = `curl () { case "$*" in *'--continue-at -'*) :;; *) return 97;; esac; if [ -s '${archive}' ]; then [ "$(cat '${archive}')" = verified ] || return 98; printf ' archive' >> '${archive}'; else printf '${content}' > '${archive}'; fi; }; tar () { mkdir -p '${app}.new/bin'; cp '${binary}' '${app}.new/bin/mattermost'; }; `
    writeFileSync(archive, 'verified')
    const resumed = spawnSync('/bin/sh', ['-c', mocks + command], { encoding: 'utf8' })
    assert.equal(resumed.status, 0, resumed.stderr)
    assert.equal(readFileSync(archive, 'utf8'), content)
    rmSync(app, { recursive: true })
    writeFileSync(archive, 'x'.repeat(content.length))
    const restarted = spawnSync('/bin/sh', ['-c', mocks + command], { encoding: 'utf8' })
    assert.equal(restarted.status, 0, restarted.stderr)
    assert.equal(readFileSync(archive, 'utf8'), content)
    rmSync(app, { recursive: true })
    writeFileSync(archive, 'verified')
    const failed = spawnSync('/bin/sh', ['-c', `curl () { printf 'partial' > '${archive}'; return 56; }; ` + command], { encoding: 'utf8' })
    assert.equal(failed.status, 56)
    assert.equal(readFileSync(archive, 'utf8'), 'partial')
    const corrupt = spawnSync('/bin/sh', ['-c', `curl () { printf corrupt > '${archive}'; }; tar () { touch '${root}/unexpected-extraction'; }; ` + command], { encoding: 'utf8' })
    assert.equal(corrupt.status, 1)
    assert.equal(existsSync(archive), false)
    assert.equal(existsSync(app), false)
    assert.equal(existsSync(path.join(root, 'unexpected-extraction')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Moodle retries truncated acquisition within a bound and never publishes a failed digest', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-moodle-acquire-'))
  try {
    const context = await new LinuxHostContextService({ fetchImpl: async () => new Response('official release') }).build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
    })
    const built = buildCommonTask('moodle-linux', 312, { platform: 'linux', linuxContext: context, docker: { preferred: false } })
    assert.equal(built.plan.commands.find(c => c.id === 'verify-artifacts').timeoutMs, 3600000)
    assert.equal(built.plan.commands.find(c => c.id === 'verify-artifacts').executionMode, 'job')
    const digest = createHash('sha256').update('verified fixture').digest('hex')
    const command = built.plan.commands.find(c => c.id === 'verify-artifacts').command.replaceAll('/var/lib/webminai/webminai-moodle-18106', root).replaceAll(moodleRelease().sha256, digest).replaceAll('-o root -g root ', '')
    const mock = `calls=0; curl () { calls=$((calls+1)); printf x >> '${root}/calls'; if [ "$calls" -eq 1 ]; then printf truncated; else printf 'verified fixture'; fi > '${root}/moodle.tar.gz.tmp'; }; `
    const result = spawnSync('/bin/sh', ['-c', mock + command], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(path.join(root, 'calls'), 'utf8'), 'xx')
    assert.equal(readFileSync(path.join(root, 'moodle.tar.gz'), 'utf8'), 'verified fixture')
    assert.equal(spawnSync('/bin/sh', ['-c', 'curl () { return 9; }; ' + command]).status, 0)
    writeFileSync(path.join(root, 'moodle.tar.gz'), 'corrupt')
    const failed = spawnSync('/bin/sh', ['-c', `curl () { printf x >> '${root}/failures'; printf corrupt > '${root}/moodle.tar.gz.tmp'; }; ` + command], { encoding: 'utf8' })
    assert.equal(failed.status, 1)
    assert.equal(readFileSync(path.join(root, 'failures'), 'utf8'), 'xxx')
    assert.match(failed.stderr, /ARTIFACT_DOWNLOAD_FAILED/)
    const expired = spawnSync('/bin/sh', ['-c', `clock=0; date () { clock=$((clock+1)); if [ -f '${root}/clock' ]; then printf 4301; else touch '${root}/clock'; printf 1000; fi; }; curl () { touch '${root}/unexpected-download'; }; ` + command], { encoding: 'utf8' })
    assert.equal(expired.status, 1)
    assert.equal(existsSync(path.join(root, 'unexpected-download')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('n8n acquisition never trusts an executable left by an interrupted npm install', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-n8n-acquire-'))
  try {
    const context = await new LinuxHostContextService({ fetchImpl: async () => new Response('official release') }).build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
    })
    const app = path.join(root, 'application')
    mkdirSync(path.join(app, 'node_modules/.bin'), { recursive: true })
    writeFileSync(path.join(app, 'node_modules/stale'), 'partial')
    writeFileSync(path.join(app, 'package-lock.json'), '{partial')
    writeFileSync(path.join(app, 'node_modules/.bin/n8n'), '#!/bin/sh\nexit 42\n', { mode: 0o755 })
    const fixture = path.join(root, 'valid-n8n')
    writeFileSync(fixture, `#!/bin/sh\nprintf '%s\\n' '${n8nRelease().version}'\n`, { mode: 0o755 })
    const built = buildCommonTask('n8n-linux', 311, { platform: 'linux', linuxContext: context, docker: { preferred: false } })
    const command = built.plan.commands.find(c => c.id === 'install-n8n').command.replaceAll('/opt/webminai-n8n-18109', app).replaceAll('/var/lib/webminai/task-state/311-n8n-linux', path.join(root, 'state')).replaceAll('-o root -g root ', '')
    assert.match(command, /install --prefer-offline --maxsockets=4 --omit=dev/)
    assert.match(command, /--fetch-retries=5 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=30000 --fetch-timeout=120000/)
    const mocks = `node () { test -f '${root}/binding-ready'; }; npm () { case "$1" in install-scripts) if [ "$2" = --help ]; then return 0; fi; printf '%s' "$3" > '${root}/approved'; return 0;; rebuild) : > '${root}/binding-ready'; return 0;; esac; [ ! -e '${app}/package-lock.json' ] || return 8; printf called >> '${root}/calls'; mkdir -p '${app}/node_modules/.bin'; cp '${fixture}' '${app}/node_modules/.bin/n8n'; }; `
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync('/bin/sh', ['-c', mocks + command], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    assert.equal(existsSync(path.join(app, 'node_modules/stale')), false)
    assert.equal(readFileSync(path.join(root, 'calls'), 'utf8'), 'called')
    assert.equal(readFileSync(path.join(root, 'approved'), 'utf8'), 'sqlite3')
    assert.equal(existsSync(path.join(app, '.webminai-npm-complete')), true)
    rmSync(path.join(app, '.webminai-npm-complete'))
    rmSync(path.join(root, 'binding-ready'))
    rmSync(path.join(root, 'approved'))
    assert.equal(spawnSync('/bin/sh', ['-c', mocks.replace('then return 0;', 'then return 1;') + command]).status, 0)
    assert.equal(existsSync(path.join(root, 'approved')), false)
    assert.equal(existsSync(path.join(root, 'binding-ready')), true)
    rmSync(path.join(app, '.webminai-npm-complete'))
    assert.equal(spawnSync('/bin/sh', ['-c', 'npm () { return 9; }; ' + command]).status, 9)
    assert.equal(existsSync(path.join(app, '.webminai-npm-complete')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('repeating Oracle htop rollback preserves the pre-existing repository after task state is removed', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-epel-'))
  try {
    const directory = path.join(root, 'state')
    mkdirSync(directory)
    writeFileSync(path.join(directory, 'was-present'), '')
    writeFileSync(path.join(directory, 'oracle-epel-was-present'), '')
    const built = buildCommonTask('install-htop', 305, { linuxContext: { identity: { id: 'ol' } } })
    const command = built.plan.revertCommands[0].command.replaceAll('/var/lib/webminai/task-state/305-install-htop', directory)
    const mocks = `rpm () { return 0; }; dnf () { printf removed > '${root}/removed'; }; `
    for (let attempt = 0; attempt < 2; attempt++) assert.equal(spawnSync('/bin/sh', ['-c', mocks + command]).status, 0)
    assert.equal(existsSync(path.join(root, 'removed')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('shared WordPress acquisition reuses only hash-verified artifacts and rejects a corrupt cache', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-artifacts-'))
  try {
    for (const [name, algorithm, suffix] of [['wordpress.tar.gz', 'sha1', '.sha1'], ['wp-cli.phar', 'sha512', '.sha512']]) {
      writeFileSync(path.join(root, name), 'fixture-' + name)
      writeFileSync(path.join(root, name + suffix), createHash(algorithm).update('fixture-' + name).digest('hex') + '\n')
    }
    const command = 'curl () { return 9; }; ' + wordpressArtifactCommand(root).replaceAll('-o root -g root ', '')
    const cached = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
    assert.equal(cached.status, 0, cached.stderr)
    assert.match(cached.stdout, /artifacts-already-verified/)
    writeFileSync(path.join(root, 'wp-cli.phar'), 'corrupt')
    assert.equal(spawnSync('/bin/sh', ['-c', command]).status, 9)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('nginx rollback without task state preserves an existing website', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-nginx-unowned-'))
  try {
    const site = path.join(root, 'site')
    mkdirSync(site)
    writeFileSync(path.join(site, 'index.html'), 'existing site')
    const command = buildCommonTask('nginx-static-site', 329).plan.revertCommands[0].command
      .replaceAll('/var/www/webminai-test-site', site)
      .replaceAll('/etc/nginx', `${root}/nginx`)
      .replaceAll('/var/lib/webminai/task-state', `${root}/state`)
    const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(existsSync(path.join(site, 'index.html')), 'rollback deleted an unowned website')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('nginx preparation explains existing paths and rejects dangling links before capturing state', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-nginx-guard-'))
  try {
    const command = buildCommonTask('nginx-static-site', 330).plan.commands[0].command
      .replaceAll('/var/www/webminai-test-site', `${root}/site`)
      .replaceAll('/etc/nginx', `${root}/nginx`)
      .replaceAll('/var/lib/webminai/task-state', `${root}/state`)
    mkdirSync(path.join(root, 'site'))
    let result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /task target already exists/u)
    rmSync(path.join(root, 'site'), { recursive: true })
    mkdirSync(path.join(root, 'nginx/conf.d'), { recursive: true })
    symlinkSync(`${root}/absent`, `${root}/nginx/conf.d/webminai-test-site.conf`)
    result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /task target already exists/u)
    assert.equal(existsSync(path.join(root, 'state')), false)
    assert.equal(existsSync(path.join(root, 'absent')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('nginx detects missing includes even when conf.d already exists and preserves the original backup', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-nginx-'))
  try {
    const built = buildCommonTask('nginx-static-site', 301)
    assert.equal(built.plan.commands[0].executionMode, 'job')
    assert.equal(built.plan.commands[0].timeoutMs, 1800000)
    assert.match(built.plan.revertCommands[1].command, /created-runtime-directory.*\] && \[ -d \/run\/nginx \]; then rmdir/)
    const config = path.join(root, 'etc/nginx/nginx.conf')
    const state = path.join(root, 'var/lib/webminai/task-state/301-nginx-static-site')
    mkdirSync(path.join(root, 'etc/nginx/conf.d'), { recursive: true })
    mkdirSync(state, { recursive: true })
    const original = 'events {}\nhttp {\n}\n'
    writeFileSync(config, original)
    const adapt = command => command.replaceAll('/etc/nginx', `${root}/etc/nginx`).replaceAll('/var/lib/webminai', `${root}/var/lib/webminai`).replaceAll('/var/www', `${root}/var/www`).replaceAll('/run/nginx', `${root}/run/nginx`).replaceAll('-o root -g root ', '')
    const write = adapt(built.plan.commands.find(item => item.id === 'write-site').command)
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync('/bin/sh', ['-c', write], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    assert.equal(readFileSync(config, 'utf8').match(/include /g).length, 1)
    assert.equal(readFileSync(path.join(state, 'nginx-conf-before'), 'utf8'), original)
    assert.equal(readFileSync(path.join(state, 'created-runtime-directory'), 'utf8'), '')
    const cleanup = spawnSync('/bin/sh', ['-c', adapt(built.plan.revertCommands[0].command)], { encoding: 'utf8' })
    assert.equal(cleanup.status, 0, cleanup.stderr)
    assert.equal(readFileSync(config, 'utf8'), original)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('MySQL data blocks MariaDB installation without changing existing files', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-database-'))
  try {
    const command = mariadbDataPreflight().replaceAll('/var/lib/mysql', root)
    assert.equal(spawnSync('/bin/sh', ['-c', command]).status, 0)
    writeFileSync(path.join(root, 'mysql_upgrade_info'), '10.11.14-MariaDB\n')
    assert.equal(spawnSync('/bin/sh', ['-c', command]).status, 0)
    writeFileSync(path.join(root, 'mysql_upgrade_info'), '8.0\n')
    const blocked = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
    assert.equal(blocked.status, 1)
    assert.match(blocked.stderr, /operator-reviewed migration/)
    assert.equal(readFileSync(path.join(root, 'mysql_upgrade_info'), 'utf8'), '8.0\n')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('openSUSE PHP plans refresh repositories without forcing repeated metadata downloads', async () => {
  const context = await new LinuxHostContextService({ fetchImpl: async () => new Response('official release') }).build({
    inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
    execution: { platform: 'linux', architecture: 'x86_64', init: 'systemd', osRelease: { ID: 'opensuse-leap', VERSION_ID: '16.0' }, commands: { zypper: true } }
  })
  for (const id of ['wordpress-linux', 'woocommerce-linux', 'joomla-linux', 'moodle-linux']) {
    const built = buildCommonTask(id, 306, { platform: 'linux', linuxContext: context, docker: { preferred: false } })
    const install = built.plan.commands.find(c => c.id === 'install-packages')
    assert.match(install.command, /zypper --non-interactive refresh;/)
    assert.doesNotMatch(install.command, /refresh --force|no-gpg-checks/)
    if (id === 'joomla-linux') {
      const acquire = built.plan.commands.find(c => c.id === 'verify-artifacts').command
      assert.match(acquire, /--retry 2 --retry-all-errors --retry-delay 2 --connect-timeout 15/)
      assert.match(acquire, /sha256sum -c/)
    }
  }
})

test('n8n native and Docker rollback do nothing once their task-owned state is gone', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-n8n-rollback-'))
  try {
    const context = await new LinuxHostContextService({ fetchImpl: async () => new Response('official release') }).build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
    })
    for (const preferred of [false, true]) {
      const built = buildCommonTask('n8n-linux', 307, { platform: 'linux', linuxContext: context, docker: { preferred, ready: true } })
      const state = built.plan.modifiedFiles.find(file => file.startsWith('/var/lib/webminai/task-state/'))
      assert.ok(state)
      const rollback = built.plan.revertCommands.find(c => c.id === (preferred ? 'restore-docker' : 'restore-packages'))
      const command = rollback.command.replaceAll(state, path.join(root, 'absent'))
      const result = spawnSync('/bin/sh', ['-c', 'rm () { return 91; }; cp () { return 92; }; systemctl () { return 94; }; ' + command], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      if (!preferred) {
        assert.match(built.plan.commands.find(c => c.id === 'configure-services').command, /user-created/)
        const present = path.join(root, 'present')
        mkdirSync(present)
        const mocks = `rm () { return 0; }; cp () { return 0; }; systemctl () { return 0; }; id () { return 0; }; userdel () { printf removed > '${root}/user-removed'; }; `
        const restore = rollback.command.replaceAll(state, present)
        assert.equal(spawnSync('/bin/sh', ['-c', mocks + restore]).status, 0)
        assert.equal(existsSync(path.join(root, 'user-removed')), false)
        writeFileSync(path.join(present, 'user-created'), '')
        assert.equal(spawnSync('/bin/sh', ['-c', mocks + restore]).status, 0)
        assert.equal(existsSync(path.join(root, 'user-removed')), true)
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('npm acquisition allows slow address attempts without disabling IPv6 or changing global configuration', async () => {
  const context = await new LinuxHostContextService({ fetchImpl: async () => new Response('official release') }).build({
    inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
    execution: { platform: 'linux', architecture: 'x86_64', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
  })
  for (const id of ['n8n-linux', 'ghost-linux']) {
    const built = buildCommonTask(id, 308, { platform: 'linux', linuxContext: context, docker: { preferred: false } })
    const acquire = built.plan.commands.find(c => c.command.includes('npm install') || c.command.includes('npm --prefix'))
    const setting = acquire.command.split('; ').find(part => part.startsWith('export NODE_OPTIONS='))
    assert.ok(setting)
    const result = spawnSync('/bin/sh', ['-c', setting + '; printf "%s" "$NODE_OPTIONS"'], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512' } })
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '--max-old-space-size=512 --network-family-autoselection-attempt-timeout=5000')
    assert.doesNotMatch(acquire.command, /no-network-family-autoselection|dns-result-order|strict-ssl=false|NODE_TLS_REJECT_UNAUTHORIZED/)
  }
})

test('Ghost rejects existing MariaDB data before any MySQL package changes', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-mysql-preflight-'))
  try {
    const context = await new LinuxHostContextService({ fetchImpl: async () => new Response('official release') }).build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
    })
    const built = buildCommonTask('ghost-linux', 309, { platform: 'linux', linuxContext: context, docker: { preferred: false } })
    assert.match(built.plan.commands.find(c => c.id === 'install-ghost').command, /user-created/)
    const state = '/var/lib/webminai/task-state/309-ghost-linux'
    const present = path.join(root, 'task-state')
    mkdirSync(present)
    const restore = built.plan.revertCommands.find(c => c.id === 'restore-stack').command.replaceAll(state, present)
    const mocks = `rm () { return 0; }; cp () { return 0; }; systemctl () { return 0; }; id () { return 0; }; userdel () { printf removed > '${root}/user-removed'; }; `
    assert.equal(spawnSync('/bin/sh', ['-c', mocks + restore]).status, 0)
    assert.equal(existsSync(path.join(root, 'user-removed')), false)
    writeFileSync(path.join(present, 'user-created'), '')
    assert.equal(spawnSync('/bin/sh', ['-c', mocks + restore]).status, 0)
    assert.equal(existsSync(path.join(root, 'user-removed')), true)
    const command = built.plan.commands.find(c => c.id === 'install-stack').command
    const preflight = command.slice(0, command.indexOf('; export DEBIAN_FRONTEND=')).replaceAll('/var/lib/mysql', root)
    assert.match(preflight, /operator-reviewed migration/)
    assert.equal(spawnSync('/bin/sh', ['-c', preflight]).status, 0)
    writeFileSync(path.join(root, 'mysql_upgrade_info'), '8.0.44\n')
    assert.equal(spawnSync('/bin/sh', ['-c', preflight]).status, 0)
    writeFileSync(path.join(root, 'mysql_upgrade_info'), '10.11.14-MariaDB\n')
    const blocked = spawnSync('/bin/sh', ['-c', preflight], { encoding: 'utf8' })
    assert.equal(blocked.status, 1)
    assert.match(blocked.stderr, /Existing MariaDB data/)
    assert.equal(readFileSync(path.join(root, 'mysql_upgrade_info'), 'utf8'), '10.11.14-MariaDB\n')
    rmSync(path.join(root, 'mysql_upgrade_info'))
    writeFileSync(path.join(root, 'aria_log_control'), 'preserved')
    assert.equal(spawnSync('/bin/sh', ['-c', preflight]).status, 1)
    assert.equal(readFileSync(path.join(root, 'aria_log_control'), 'utf8'), 'preserved')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Alpine CLI installation owns only packages absent from its captured baseline', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-alpine-install-'))
  try {
    const built = buildCommonTask('intent-ai-ops-linux', 310, { platform: 'linux', linuxContext: { identity: { id: 'alpine' } } })
    assert.match(built.plan.commands[0].command, /apk info -e 'nodejs'/)
    assert.match(built.plan.commands[1].command, /apk add --no-cache nodejs npm/)
    const state = '/var/lib/webminai/tasks/310/intent-ai-ops-install'
    writeFileSync(path.join(root, 'owns-root'), '')
    writeFileSync(path.join(root, 'pkg-nodejs.existed'), '')
    const command = built.plan.revertCommands[0].command.replaceAll(state, root)
    const result = spawnSync('/bin/sh', ['-c', `rm () { return 0; }; apk () { printf '%s\\n' "$*" >> '${root}/removed'; }; ` + command], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(path.join(root, 'removed'), 'utf8'), 'del npm\n')
    const installer = readFileSync(new URL('../scripts/install.sh', import.meta.url), 'utf8')
    assert.equal(spawnSync('/bin/sh', ['-n'], { input: installer }).status, 0)
    assert.match(installer, /\/etc\/alpine-release/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Fedora Moodle uses native MariaDB without EL9 module changes, and slow installs use durable jobs', async () => {
  const context = await new LinuxHostContextService({ fetchImpl: async () => new Response('official release') }).build({
    inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
    execution: { platform: 'linux', architecture: 'x86_64', init: 'systemd', osRelease: { ID: 'fedora', VERSION_ID: '44' }, commands: { dnf: true } }
  })
  const moodle = buildCommonTask('moodle-linux', 302, { platform: 'linux', linuxContext: context, docker: { preferred: false } })
  assert.doesNotMatch(JSON.stringify(moodle.plan), /module (?:list|enable|reset) mariadb/)
  assert.match(moodle.plan.commands.find(item => item.id === 'install-packages').command, /remi-release-44/)
  for (const catalogId of ['wordpress-linux', 'woocommerce-linux']) {
    const built = buildCommonTask(catalogId, 303, { platform: 'linux', linuxContext: context, docker: { preferred: false } })
    assert.match(built.plan.commands[0].command, /Existing MySQL data requires/)
    if (catalogId === 'woocommerce-linux') {
      assert.equal(built.plan.commands.find(item => item.id === 'install-woocommerce').executionMode, 'job')
      assert.match(built.plan.commands.find(item => item.id === 'verify-artifacts').command, /artifacts-already-verified/)
    }
    for (const id of ['install-packages', 'verify-artifacts']) {
      const step = built.plan.commands.find(item => item.id === id)
      assert.equal(step.executionMode, 'job')
      assert.equal(step.timeoutMs, 1800000)
    }
  }
  assert.equal(buildCommonTask('install-htop', 304).plan.commands[0].executionMode, 'job')
  const oracle = buildCommonTask('install-htop', 305, { linuxContext: { identity: { id: 'ol' } } })
  assert.match(oracle.plan.revertCommands[0].command, /if \[ -d .*305-install-htop.*\] && \[ ! -e .*oracle-epel-was-present/)
})
