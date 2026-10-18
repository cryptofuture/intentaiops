import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildCommonTask } from '../src/common-tasks.js'
import { LinuxHostContextService } from '../src/linux-host-context.js'
import { applicationDatabaseCommand } from '../src/linux-application-database.js'

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
      const mock = `mariadb () { case "$*" in *-Nse*) ${mode === 'denied' ? 'return 1' : `cat '${count}'`}; return;; esac; sql=$(cat); printf '%s\\n' "$sql" >> '${log}'; ${mode === 'partial' ? `printf '1\\n' > '${count}'; return 1` : mode === 'failed' ? 'return 1' : `case "$sql" in CREATE*) printf '2\\n' > '${count}';; DROP*) printf '0\\n' > '${count}';; esac`}; }; `
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
