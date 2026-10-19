import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildCommonTask } from '../src/common-tasks.js'
import { LinuxHostContextService } from '../src/linux-host-context.js'
import { applicationDatabaseCommand, postgresApplicationDatabaseCommand } from '../src/linux-application-database.js'

test('PostgreSQL ownership binds repeated execution and rollback to the original cluster and objects', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-postgres-owned-'))
  try {
    const state = path.join(root, 'state')
    const credentials = path.join(root, 'credentials')
    mkdirSync(state)
    mkdirSync(credentials)
    writeFileSync(path.join(credentials, 'database_password'), 'a'.repeat(64))
    const identity = path.join(root, 'identity')
    const log = path.join(root, 'sql')
    const marker = path.join(state, 'postgres-owned')
    writeFileSync(identity, '71|0|0|0\n')
    writeFileSync(log, '')
    const run = (rollback = false, mode = '') => {
      const mock = `runuser () { case "$*" in *pg_control_system*) ${mode === 'denied' ? 'return 1' : `cat '${identity}'`};; *dropdb*) printf 'dropdb\\n' >> '${log}';; *dropuser*) printf 'dropuser\\n' >> '${log}'; printf '71|0|0|0\\n' > '${identity}';; *) cat >> '${log}'; printf '71|90|91|90\\n' > '${identity}'; ${mode === 'partial' ? 'return 1' : ':'};; esac; }; `
      return spawnSync('/bin/sh', ['-c', mock + postgresApplicationDatabaseCommand({ state, credentials, database: 'webminai_test', user: 'webminai_test', rollback })], { encoding: 'utf8' })
    }
    assert.equal(run(false, 'denied').status, 1)
    assert.equal(readFileSync(log, 'utf8'), '')
    writeFileSync(identity, '71|0|0|0\n71|0|0|0\n')
    assert.equal(run().status, 1)
    assert.equal(readFileSync(log, 'utf8'), '')
    writeFileSync(identity, '71|0|0|0\n')
    writeFileSync(path.join(credentials, 'database_password'), "unsafe'; SQL")
    assert.equal(run().status, 1)
    assert.equal(readFileSync(log, 'utf8'), '')
    writeFileSync(path.join(credentials, 'database_password'), 'a'.repeat(64))
    for (const value of ['bad-name', 'x'.repeat(64), "x';DROP ROLE x;"]) {
      assert.throws(() => postgresApplicationDatabaseCommand({ state, credentials, database: value, user: 'webminai_test' }), /invalid PostgreSQL/u)
      assert.throws(() => postgresApplicationDatabaseCommand({ state, credentials, database: 'webminai_test', user: value }), /invalid PostgreSQL/u)
    }
    const created = run()
    assert.equal(created.status, 0, created.stderr)
    assert.equal(readFileSync(marker, 'utf8'), '71|90|91|90\n')
    const sql = readFileSync(log, 'utf8')
    assert.match(sql, /CREATE ROLE webminai_test LOGIN PASSWORD/u)
    assert.doesNotMatch(sql, /ALTER|IF NOT EXISTS/u)
    assert.equal(run().status, 0)
    assert.equal(readFileSync(log, 'utf8'), sql)
    assert.equal(run(true, 'denied').status, 1)
    assert.equal(readFileSync(log, 'utf8'), sql)
    for (const replacement of ['72|90|91|90', '71|92|91|92', '71|90|93|90']) {
      writeFileSync(identity, replacement + '\n')
      assert.equal(run().status, 1)
      assert.equal(run(true).status, 1)
      assert.equal(readFileSync(log, 'utf8'), sql)
    }
    writeFileSync(identity, '71|90|91|90\n')
    assert.equal(run(true).status, 0)
    assert.equal(existsSync(marker), false)
    const reverted = readFileSync(log, 'utf8')
    assert.equal(run(true).status, 0)
    assert.equal(readFileSync(log, 'utf8'), reverted)
    assert.equal(run(false, 'partial').status, 1)
    assert.equal(existsSync(marker), false)
    assert.equal(run(true).status, 1)
    writeFileSync(marker, '71|90|91|90\n')
    rmSync(marker)
    symlinkSync(identity, marker)
    assert.equal(run(true).status, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

for (const rollback of [false, true]) {
  test(`native PostgreSQL ${rollback ? 'rollback' : 'setup'} refuses unowned namespaces`, async () => {
    const context = await new LinuxHostContextService({ fetchImpl: async () => new Response('release') }).build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
    })
    const root = mkdtempSync(path.join(os.tmpdir(), 'intent-postgres-unowned-'))
    try {
      for (const id of ['mattermost-linux', 'odoo-linux']) {
        const plan = buildCommonTask(id, 701, { linuxContext: context, docker: { preferred: false } }).plan
        const state = plan.modifiedFiles.find(value => value.startsWith('/var/lib/webminai/task-state/'))
        const credentials = plan.modifiedFiles.find(value => value.startsWith('/root/'))
        mkdirSync(root + state, { recursive: true })
        mkdirSync(root + credentials, { recursive: true })
        writeFileSync(root + credentials + '/database_password', 'a'.repeat(64))
        const log = `${root}/sql.log`
        writeFileSync(log, '')
        const item = (rollback ? plan.revertCommands : plan.commands).find(value => value.id === (rollback ? 'drop-database' : 'initialize-database'))
        const command = item.command.replaceAll(state, root + state).replaceAll(credentials, root + credentials)
        const mocks = `systemctl () { return 0; }; psql () { printf '1\\n'; }; runuser () { case "$*" in *pg_control_system*) printf '71|90|91|90\\n';; *-Atqc*) printf '1\\n';; *psql*) cat >> '${log}';; *createuser*|*createdb*|*dropdb*|*dropuser*) printf '%s\\n' "$*" >> '${log}';; esac; }; `
        const result = spawnSync('/bin/sh', ['-c', mocks + command], { encoding: 'utf8' })
        assert.notEqual(result.status, 0, `${id} accepted an unowned namespace`)
        assert.match(result.stderr, /DATABASE_OWNERSHIP_UNCONFIRMED/u)
        assert.equal(readFileSync(log, 'utf8'), '', id)
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}

test('native database applications preserve foreign files when rollback baseline is missing', async () => {
  const context = await new LinuxHostContextService({ fetchImpl: async () => new Response('release') }).build({
    inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
    execution: { platform: 'linux', architecture: 'x86_64', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
  })
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-postgres-files-'))
  try {
    for (const id of ['mattermost-linux', 'odoo-linux', 'ghost-linux']) {
      const plan = buildCommonTask(id, 702, { linuxContext: context, docker: { preferred: false } }).plan
      const state = plan.modifiedFiles.find(value => value.startsWith('/var/lib/webminai/task-state/'))
      const target = plan.modifiedFiles.find(value => value.startsWith('/root/'))
      mkdirSync(root + target, { recursive: true })
      writeFileSync(root + target + '/foreign', 'preserve')
      for (const item of plan.revertCommands.filter(value => /^(stop-|remove-.*-files)/u.test(value.id))) {
        let command = item.command
        for (const value of [...plan.modifiedFiles].sort((a, b) => b.length - a.length)) command = command.replaceAll(value, root + value)
        const log = `${root}/mutations`
        writeFileSync(log, '')
        const mocks = `systemctl () { printf 'service\\n' >> '${log}'; }; rm () { printf 'remove\\n' >> '${log}'; }; nginx () { return 0; }; `
        const result = spawnSync('/bin/sh', ['-c', mocks + command], { encoding: 'utf8' })
        assert.notEqual(result.status, 0, `${id}/${item.id} accepted missing ${state}`)
        assert.match(result.stderr, /APPLICATION_OWNERSHIP_UNCONFIRMED/u)
        assert.equal(readFileSync(log, 'utf8'), '')
        assert.equal(readFileSync(root + target + '/foreign', 'utf8'), 'preserve')
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Mattermost baseline refuses an existing account or dangling managed path before capture', async () => {
  const context = await new LinuxHostContextService({ fetchImpl: async () => new Response('release') }).build({
    inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
    execution: { platform: 'linux', architecture: 'x86_64', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
  })
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-mattermost-baseline-'))
  try {
    const plan = buildCommonTask('mattermost-linux', 703, { linuxContext: context, docker: { preferred: false } }).plan
    let command = plan.commands[0].command
    for (const value of [...plan.modifiedFiles].sort((a, b) => b.length - a.length)) command = command.replaceAll(value, root + value)
    const existing = spawnSync('/bin/sh', ['-c', 'id () { return 0; }; ' + command], { encoding: 'utf8' })
    assert.equal(existing.status, 1)
    assert.match(existing.stderr, /Mattermost account already exists/u)
    const target = root + plan.modifiedFiles.find(value => value.startsWith('/root/'))
    mkdirSync(path.dirname(target), { recursive: true })
    symlinkSync(root + '/missing', target)
    const dangling = spawnSync('/bin/sh', ['-c', 'id () { return 1; }; ' + command], { encoding: 'utf8' })
    assert.equal(dangling.status, 1)
    const state = root + plan.modifiedFiles.find(value => value.startsWith('/var/lib/webminai/task-state/'))
    assert.equal(existsSync(state), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('PostgreSQL application package restoration keeps recovery state after a package-manager failure', async () => {
  const context = await new LinuxHostContextService({ fetchImpl: async () => new Response('release') }).build({
    inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
    execution: { platform: 'linux', architecture: 'x86_64', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
  })
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-postgres-packages-'))
  try {
    for (const id of ['mattermost-linux', 'odoo-linux']) {
      const plan = buildCommonTask(id, 704, { linuxContext: context, docker: { preferred: false } }).plan
      const original = plan.modifiedFiles.find(value => value.startsWith('/var/lib/webminai/task-state/'))
      const state = root + original
      mkdirSync(state, { recursive: true })
      writeFileSync(state + '/packages.added', 'intent-test-package\n')
      writeFileSync(state + '/postgres-data.existed', '')
      const log = root + '/removed'
      writeFileSync(log, '')
      const command = plan.revertCommands.find(value => value.id === 'restore-stack').command.replaceAll(original, state)
      const result = spawnSync('/bin/bash', ['-c', `apt-get () { return 37; }; systemctl () { return 0; }; id () { return 1; }; rm () { printf 'removed\\n' >> '${log}'; }; ` + command], { encoding: 'utf8' })
      assert.equal(result.status, 37, `${id}: ${result.stderr}`)
      assert.equal(readFileSync(log, 'utf8'), '')
      assert.equal(readFileSync(state + '/packages.added', 'utf8'), 'intent-test-package\n')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

for (const rollback of [false, true]) {
  test(`Ghost MySQL ${rollback ? 'rollback' : 'setup'} refuses an unowned namespace`, async () => {
    const context = await new LinuxHostContextService({ fetchImpl: async () => new Response('release') }).build({
      inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
      execution: { platform: 'linux', architecture: 'x86_64', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
    })
    const root = mkdtempSync(path.join(os.tmpdir(), 'intent-ghost-ownership-'))
    try {
      const plan = buildCommonTask('ghost-linux', 704, { linuxContext: context }).plan
      const state = plan.modifiedFiles.find(value => value.startsWith('/var/lib/webminai/task-state/'))
      const credentials = '/root/ghost_credentials'
      mkdirSync(root + state, { recursive: true })
      mkdirSync(root + credentials, { recursive: true })
      writeFileSync(root + credentials + '/database_password', 'a'.repeat(64))
      const log = path.join(root, 'sql')
      writeFileSync(log, '')
      const item = (rollback ? plan.revertCommands : plan.commands).find(value => value.id === (rollback ? 'drop-database' : 'initialize-database'))
      const command = item.command.replaceAll(state, root + state).replaceAll(credentials, root + credentials)
      const mock = `mysqladmin () { return 0; }; mysql () { case "$*" in *-Nse*) printf '1\\n';; *) printf '%s\\n' "$*" >> '${log}'; cat >> '${log}';; esac; }; `
      const result = spawnSync('/bin/sh', ['-c', mock + command], { encoding: 'utf8' })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /DATABASE_OWNERSHIP_UNCONFIRMED/u)
      assert.equal(readFileSync(log, 'utf8'), '')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}

test('Ghost baseline rejects dangling application paths and symlinked state before capture', async () => {
  const context = await new LinuxHostContextService({ fetchImpl: async () => new Response('release') }).build({
    inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
    execution: { platform: 'linux', architecture: 'x86_64', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
  })
  for (const target of ['/opt/webminai-ghost-18110', '/opt/webminai-ghost-cli', '/var/lib/webminai/task-state/705-ghost-linux']) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'intent-ghost-baseline-'))
    try {
      const plan = buildCommonTask('ghost-linux', 705, { linuxContext: context }).plan
      const foreign = path.join(root, 'foreign')
      mkdirSync(foreign)
      writeFileSync(path.join(foreign, 'packages.before'), 'preserve\n')
      mkdirSync(path.dirname(root + target), { recursive: true })
      symlinkSync(target.includes('task-state') ? foreign : root + '/absent', root + target)
      let command = plan.commands[0].command
      for (const item of [...plan.modifiedFiles].sort((a, b) => b.length - a.length)) command = command.replaceAll(item, root + item)
      const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
      assert.notEqual(result.status, 0, target)
      assert.equal(readFileSync(path.join(foreign, 'packages.before'), 'utf8'), 'preserve\n')
      if (!target.includes('task-state')) assert.equal(existsSync(root + '/var/lib/webminai/task-state/705-ghost-linux/packages.before'), false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('native PHP rollback refuses an unowned database even when task state exists', async () => {
  const context = await new LinuxHostContextService({ fetchImpl: async () => new Response('release') }).build({
    inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
    execution: { platform: 'linux', architecture: 'x86_64', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
  })
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-db-ownership-'))
  try {
    for (const id of ['wordpress-linux', 'woocommerce-linux', 'joomla-linux', 'drupal-linux', 'prestashop-linux', 'moodle-linux']) {
      const built = buildCommonTask(id, 700, { linuxContext: context })
      const command = built.plan.revertCommands.find(item => /remove-(?:application|wordpress)-database/u.test(item.id)).command.replaceAll('/var/lib/webminai/task-state', root)
      mkdirSync(path.join(root, `700-${id}`), { recursive: true })
      const log = path.join(root, 'sql.log')
      writeFileSync(log, '')
      const result = spawnSync('/bin/sh', ['-c', `mariadb () { cat >> '${log}'; printf '1\n'; }; ${command}`], { encoding: 'utf8' })
      assert.notEqual(result.status, 0, `${id} accepted rollback without ownership`)
      assert.doesNotMatch(readFileSync(log, 'utf8'), /DROP|ALTER/u, id)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function fixture (body) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'intent-db-script-'))
  try {
    const state = path.join(root, 'state')
    const credentials = path.join(root, 'credentials')
    mkdirSync(state)
    mkdirSync(credentials)
    writeFileSync(path.join(credentials, 'db_password'), 'a'.repeat(64))
    const log = path.join(root, 'sql.log')
    const count = path.join(root, 'count')
    const marker = path.join(state, 'database-owned')
    writeFileSync(log, '')
    writeFileSync(count, '0\n')
    const options = { state, database: 'webminai_test', host: 'localhost', credentials }
    const run = (rollback = false, mode = '') => {
      const mock = `${options.client ?? 'mariadb'} () { case "$*" in *-Nse*) ${mode === 'denied' ? 'return 1' : `cat '${count}'`}; return;; esac; sql=$(cat); printf '%s\\n' "$sql" >> '${log}'; ${mode === 'partial' ? `printf '1\\n' > '${count}'; return 1` : mode === 'failed' ? 'return 1' : `case "$sql" in CREATE*) printf '2\\n' > '${count}';; DROP*) printf '0\\n' > '${count}';; esac`}; }; `
      return spawnSync('/bin/sh', ['-c', mock + 'set -eu; ' + applicationDatabaseCommand({ ...options, rollback })], { encoding: 'utf8' })
    }
    body({ options, run, marker, log, count, credentials, state })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('database creation, repeated apply and repeated rollback preserve explicit ownership', () => {
  fixture(({ run, marker, log }) => {
    assert.equal(run().status, 0)
    assert.equal(readFileSync(marker, 'utf8'), 'webminai_test@localhost\n')
    const first = readFileSync(log, 'utf8')
    assert.doesNotMatch(first, /IF NOT EXISTS|ALTER USER/u)
    assert.equal(run().status, 0)
    assert.equal(readFileSync(log, 'utf8'), first)
    assert.equal(run(true).status, 0)
    assert.equal(existsSync(marker), false)
    const reverted = readFileSync(log, 'utf8')
    assert.match(reverted, /DROP USER IF EXISTS 'webminai_test'@'localhost'/u)
    assert.doesNotMatch(reverted, /127\.0\.0\.1/u)
    assert.equal(run(true).status, 0)
    assert.equal(readFileSync(log, 'utf8'), reverted)
  })
})

test('MySQL ownership preserves a distinct account, credential filename and collation across repeat and rollback', () => {
  fixture(({ options, credentials, state, run, marker, count, log }) => {
    Object.assign(options, { client: 'mysql', user: 'webminai_ghost', passwordFile: 'database_password', collation: 'utf8mb4_0900_ai_ci' })
    writeFileSync(path.join(credentials, 'database_password'), 'b'.repeat(64))
    writeFileSync(count, '2\n')
    writeFileSync(marker, 'webminai_test@localhost\n')
    assert.notEqual(run().status, 0)
    assert.notEqual(run(true).status, 0)
    assert.equal(readFileSync(log, 'utf8'), '')
    rmSync(marker)
    writeFileSync(count, '0\n')
    assert.notEqual(run(false, 'denied').status, 0)
    assert.equal(run().status, 0)
    assert.equal(readFileSync(marker, 'utf8'), 'webminai_test:webminai_ghost@localhost\n')
    const sql = readFileSync(log, 'utf8')
    assert.match(sql, /CREATE DATABASE webminai_test.*COLLATE utf8mb4_0900_ai_ci; CREATE USER 'webminai_ghost'@'localhost'/u)
    assert.doesNotMatch(sql, /ALTER USER|CREATE DATABASE IF NOT EXISTS|CREATE USER 'webminai_test'/u)
    assert.equal(run().status, 0)
    assert.equal(readFileSync(log, 'utf8'), sql)
    assert.equal(run(true).status, 0)
    const dropped = readFileSync(log, 'utf8')
    assert.match(dropped, /DROP USER IF EXISTS 'webminai_ghost'@'localhost'/u)
    assert.doesNotMatch(dropped, /DROP USER IF EXISTS 'webminai_test'/u)
    assert.equal(run(true).status, 0)
    assert.equal(readFileSync(log, 'utf8'), dropped)
    for (const invalid of [{ client: 'mysql; evil' }, { user: 'bad-name' }, { passwordFile: '../secret' }, { collation: 'utf8; DROP' }]) {
      assert.throws(() => applicationDatabaseCommand({ ...options, ...invalid }), /identity/u)
    }
    rmSync(state, { recursive: true })
    symlinkSync(credentials, state)
    assert.notEqual(run().status, 0)
    assert.notEqual(run(true).status, 0)
    assert.equal(readFileSync(log, 'utf8'), dropped)
  })
})

test('existing namespaces and denied observations cannot authorize creation or deletion', () => {
  fixture(({ run, count, log }) => {
    writeFileSync(count, '1\n')
    for (const rollback of [false, true]) {
      for (const mode of ['', 'denied']) assert.notEqual(run(rollback, mode).status, 0)
    }
    assert.equal(readFileSync(log, 'utf8'), '')
  })
})

test('a missing database client is unavailable evidence, not an empty namespace', () => {
  fixture(({ options }) => {
    const result = spawnSync('/bin/sh', ['-c', applicationDatabaseCommand({ ...options, rollback: true })], { encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent-intent-database-client' } })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /OWNERSHIP_UNCONFIRMED/u)
  })
})

test('partial SQL failure leaves no ownership claim and requires reviewed recovery', () => {
  fixture(({ run, marker, log }) => {
    assert.notEqual(run(false, 'partial').status, 0)
    assert.equal(existsSync(marker), false)
    const partial = readFileSync(log, 'utf8')
    assert.notEqual(run().status, 0)
    assert.notEqual(run(true).status, 0)
    assert.equal(readFileSync(log, 'utf8'), partial)
  })
})

test('failed rollback retains ownership evidence; stale and symlink markers reject', () => {
  fixture(({ run, marker, log, count }) => {
    assert.equal(run().status, 0)
    assert.notEqual(run(true, 'failed').status, 0)
    assert.equal(existsSync(marker), true)
    const saved = readFileSync(log, 'utf8')
    writeFileSync(count, '1\n')
    assert.notEqual(run().status, 0)
    writeFileSync(marker, 'some_other_database@localhost\n')
    assert.notEqual(run(true).status, 0)
    rmSync(marker)
    symlinkSync(log, marker)
    assert.notEqual(run().status, 0)
    assert.notEqual(run(true).status, 0)
    assert.equal(readFileSync(log, 'utf8'), saved)
  })
})

test('invalid database identities and malformed credential files reject without SQL writes', () => {
  fixture(({ options, credentials, run, log }) => {
    for (const database of ['x; DROP DATABASE x', 'x-y', '']) assert.throws(() => applicationDatabaseCommand({ ...options, database }), /identity/u)
    assert.throws(() => applicationDatabaseCommand({ ...options, host: "localhost';" }), /identity/u)
    writeFileSync(path.join(credentials, 'db_password'), "unsafe'password")
    assert.notEqual(run().status, 0)
    assert.equal(readFileSync(log, 'utf8'), '')
  })
})
