import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildCommonTask } from '../src/common-tasks.js'
import { LinuxHostContextService } from '../src/linux-host-context.js'
import { mariadbDataPreflight, wordpressArtifactCommand } from '../src/linux-php-foundation.js'
import { n8nRelease } from '../src/n8n-task.js'
import { moodleRelease } from '../src/moodle-task.js'

test('Moodle retries truncated acquisition within a bound and never publishes a failed digest', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-moodle-acquire-'))
  try {
    const context = await new LinuxHostContextService({ fetchImpl: async () => new Response('official release') }).build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
    })
    const built = buildCommonTask('moodle-linux', 312, { platform: 'linux', linuxContext: context, docker: { preferred: false } })
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
