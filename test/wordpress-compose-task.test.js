import assert from 'node:assert/strict'
import test from 'node:test'
import { buildWordpressComposeTask } from '../src/wordpress-compose-task.js'
import { validateCommandPlan } from '../src/plan-validator.js'
import { rootExecutionPolicy } from '../src/execution-policy.js'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import yaml from 'js-yaml'
import { mariadbComposeBootstrap } from '../src/mariadb-compose-bootstrap.js'

test('WordPress Compose image acquisition uses an observable durable job for slow hosts', () => {
  const { plan } = buildWordpressComposeTask(1, { identity: { id: 'ubuntu', versionId: '26.04' } }, { preferred: true, ready: true })
  validateCommandPlan(plan, rootExecutionPolicy({}))
  const pull = plan.commands.find(command => command.id === 'pull-images')
  assert.equal(pull.executionMode, 'job')
  assert.equal(pull.timeoutMs, 3600000)
  assert.deepEqual(pull.dependsOn, ['write-compose'])
  const start = plan.commands.find(command => command.id === 'start-compose')
  assert.equal(start.executionMode, 'job')
  assert.equal(start.timeoutMs, 900000)
  assert.equal(start.command.match(/ ps --status running --services/gu).length, 1)
  assert.ok(plan.commands.filter(command => !['pull-images', 'start-compose'].includes(command.id)).every(command => command.timeoutMs === 300000))
})

test('WordPress keeps host secrets private and prepares a separate PHP-owned runtime copy', { skip: !existsSync('/bin/bash') }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'intent-wordpress-secret-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { plan } = buildWordpressComposeTask(1, { identity: { id: 'ubuntu' } }, { preferred: true, ready: true })
  const command = plan.commands.find(command => command.id === 'generate-credentials').command.replaceAll('/root/wordpress_credentials', directory)
  const result = spawnSync('/bin/bash', ['-c', 'install () { for destination; do :; done; mkdir -p "$destination"; chmod 0700 "$destination"; }; chgrp () { test "$1" = 33; }; openssl () { printf "fixture-only\\n"; }; ' + command], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  for (const name of ['db_password', 'db_root_password', 'admin_password']) assert.equal((await stat(path.join(directory, name))).mode & 0o777, 0o600)
  const compose = plan.commands.find(command => command.id === 'write-compose').command
  assert.match(compose, /install -o www-data -g www-data -m 0400 \/run\/secrets\/db_password \/run\/webminai\/db_password/u)
  assert.match(compose, /WORDPRESS_DB_PASSWORD_FILE: \/run\/webminai\/db_password/u)
})

test('WordPress database readiness requires its initialized application account and database', { skip: !existsSync('/bin/bash') }, async t => {
  const { plan } = buildWordpressComposeTask(1, { identity: { id: 'ubuntu' } }, { preferred: true, ready: true })
  const compose = plan.commands.find(command => command.id === 'write-compose').command
  assert.match(compose, /MYSQL_PWD=/u)
  assert.match(compose, /--protocol=tcp --host=127\.0\.0\.1 --user=webminai_wordpress --database=webminai_wordpress/u)
  assert.ok(!compose.includes('healthcheck.sh'))
  assert.ok(!compose.includes('--password='))
  const health = JSON.parse(compose.match(/test: (\["CMD-SHELL".*?\])'/u)[1])
  const directory = await mkdtemp(path.join(os.tmpdir(), 'intent-wordpress-health-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const secret = path.join(directory, 'password')
  await writeFile(secret, 'fixture-password\n', { mode: 0o600 })
  const command = health[1].replaceAll('$$', '$').replace('/run/secrets/db_password', secret)
  const ready = spawnSync('/bin/bash', ['-c', 'mariadb () { test "$MYSQL_PWD" = fixture-password && [[ "$*" == *--user=webminai_wordpress* ]] && [[ "$*" == *--database=webminai_wordpress* ]] && [[ "$*" != *fixture-password* ]]; }; ' + command])
  assert.equal(ready.status, 0)
  const incomplete = spawnSync('/bin/bash', ['-c', 'mariadb () { return 1; }; ' + command])
  assert.equal(incomplete.status, 1)
})

test('WordPress extends only the recognized pinned MariaDB bootstrap bound and preserves re-execution', { skip: process.platform !== 'linux' || !existsSync('/bin/bash') }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'intent-wordpress-bootstrap-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { plan } = buildWordpressComposeTask(1, { identity: { id: 'ubuntu' } }, { preferred: true, ready: true })
  const write = plan.commands.find(command => command.id === 'write-compose').command.replaceAll('/opt/webminai/services/wordpress', path.join(directory, 'service')).replaceAll('-o root -g root ', '')
  const result = spawnSync('/bin/bash', ['-c', write], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const compose = yaml.load(await readFile(path.join(directory, 'service/compose.yaml'), 'utf8'))
  assert.deepEqual(compose.services.db.entrypoint, ['/bin/bash', '-ec'])
  const source = path.join(directory, 'upstream.sh')
  await writeFile(source, '#!/bin/bash\nif false; then for i in {30..0}; do break; done; fi\nif [ "$1" = mariadbd ]; then exec "$0" child; fi\ntest "$1" = child && grep -Fq "for i in {300..0}; do" "$0"\n', { mode: 0o755 })
  const bootstrap = compose.services.db.command[0].replaceAll('$$', '$').replaceAll('/usr/local/bin/docker-entrypoint.sh', source).replaceAll('/run/webminai-mariadb-entrypoint', path.join(directory, 'entrypoint'))
  assert.equal(spawnSync('/bin/bash', ['-ec', bootstrap]).status, 0)
  assert.equal((await stat(path.join(directory, 'entrypoint.sh'))).mode & 0o777, 0o555)
  assert.equal(spawnSync('/bin/bash', ['-ec', bootstrap]).status, 0)
  await writeFile(source, '#!/bin/bash\nexit 0\n')
  const changed = spawnSync('/bin/bash', ['-ec', bootstrap], { encoding: 'utf8' })
  assert.equal(changed.status, 1)
  assert.match(changed.stderr, /Unsupported MariaDB bootstrap script/u)
})

test('MariaDB bootstrap preserves server options without shell evaluation', { skip: process.platform !== 'linux' || !existsSync('/bin/bash') }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'intent-mariadb-options-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'upstream.sh')
  await writeFile(source, '#!/bin/bash\nif false; then for i in {30..0}; do break; done; fi\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
  const options = ['--character-set-server=utf8mb4', '--collation-server=utf8mb4_unicode_ci', '--innodb-buffer-pool-size=128M', '--max-connections=50', "--fixture='$(printf unsafe)'"]
  const bootstrap = mariadbComposeBootstrap(options).slice(3).map(line => line.slice(8)).join('\n').replaceAll('$$', '$').replaceAll('/usr/local/bin/docker-entrypoint.sh', source).replaceAll('/run/webminai-mariadb-entrypoint', path.join(directory, 'entrypoint'))
  const result = spawnSync('/bin/bash', ['-ec', bootstrap], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split('\n'), ['mariadbd', ...options])
})
