import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildMagentoTask, magentoComposeAssets, magentoComposeRelease } from '../src/magento-task.js'
import { buildMacosComposeTask } from '../src/macos-compose-task.js'
import { OPENSEARCH_VERSION, OPENSEARCH_IMAGE, opensearchCompatibilityDockerfile, opensearchCompatibilityImage } from '../src/opensearch-compat.js'

const context = { identity: { id: 'ubuntu', versionId: '26.04', architecture: 'x86_64' } }
const build = () => buildMagentoTask(23, context, { preferred: true, ready: true })

test('Magento verification names the failed check and preserves its exit status', () => {
  const command = build().plan.commands.find(c => c.id === 'verify-magento').command.replace("cd '/opt/webminai/services/magento'", ':')
  assert.match(command, /--max-time 120/u)
  for (const mode of ['success', 'socket', 'indexers', 'version', 'search', 'cache', 'http']) {
    const mocks = `docker () { case "$*" in
      *'ps --status running --services'*) printf 'magento\\nnginx\\ncron\\n';;
      *'test -S'*) test '${mode}' != socket;;
      *'php -r'*) test '${mode}' != indexers && printf magento-indexers-valid;;
      *'php bin/magento --version'*) printf '${mode === 'version' ? 'other-version' : 'Magento CLI 2.4.8-p5'}';;
      *'opensearch curl'*) return ${mode === 'search' ? 22 : 0};;
      *'valkey-cli ping'*) printf '${mode === 'cache' ? 'not-ready' : 'PONG'}';;
      *) return 0;; esac; }; curl () { printf '${mode === 'http' ? 'not-ready' : 'WEBMINAI_MAGENTO_OK'}'; }; `
    const result = spawnSync('/bin/sh', ['-c', mocks + command], { encoding: 'utf8' })
    assert.equal(result.status, mode === 'success' ? 0 : mode === 'search' ? 22 : 1, result.stderr)
    if (mode === 'success') assert.equal(result.stderr, '')
    else assert.match(result.stderr, new RegExp('MAGENTO_VERIFICATION_FAILED:' + mode))
  }
})

test('Magento cold readiness waits independently for cron and bounded HTTP probes', () => {
  const initialize = build().plan.commands.find(c => c.id === 'initialize-magento').command
  const wait = initialize.slice(initialize.indexOf('ready=;'))
  assert.match(wait, /--max-time 60/u)
  assert.doesNotMatch(wait, /setup:install|indexer:reindex|up -d/u)
  for (const mode of ['success', 'cron-timeout', 'http-timeout']) {
    const mocks = `address=127.0.0.1; n=0; docker () { n=$((n + 1)); ${mode === 'cron-timeout' ? 'return 1;' : 'test "$n" -ge 100;'} }; curl () { ${mode === 'http-timeout' ? 'return 28;' : 'printf WEBMINAI_MAGENTO_OK;'} }; sleep () { :; }; `
    const result = spawnSync('/bin/sh', ['-c', 'set -eu; ' + mocks + wait], { encoding: 'utf8' })
    assert.equal(result.status, mode === 'success' ? 0 : 1, result.stderr)
    if (mode === 'success') assert.match(result.stdout, /magento-installed/u)
    else assert.match(result.stderr, new RegExp(mode === 'cron-timeout' ? 'MAGENTO_CRON_READINESS_DEADLINE' : 'MAGENTO_HTTP_READINESS_DEADLINE'))
  }
})

test('Magento verification checks every configured indexer, not only a marker', () => {
  const command = build().plan.commands.find(c => c.id === 'verify-magento').command
  const php = command.match(/php -r '(.*?)';/u)?.[1]
  assert.ok(php)
  assert.match(php, /\\Magento\\Framework\\App\\Bootstrap::create/u)
  assert.doesNotMatch(php, /\\\\Magento/u)
  assert.match(php, /!\$config \|\| !isset\(\$config\["catalogsearch_fulltext"\]\)/u)
  assert.match(php, /foreach \(array_keys\(\$config\) as \$id\)/u)
  assert.match(php, /if \(!\$registry->get\(\$id\)->isValid\(\)\) \{ exit\(1\); \}/u)
  const segment = command.match(/docker compose[^;]+php -r '(.*?)';/u)?.[0]
  assert.ok(segment)
  for (const code of [0, 1]) {
    const result = spawnSync('/bin/sh', ['-c', `set -eu; docker () { return ${code}; }; ${segment} printf verified`], { encoding: 'utf8' })
    assert.equal(result.status, code)
    assert.equal(result.stdout, code === 0 ? 'verified' : '')
  }
})

test('OpenSearch compatibility recipe pins official minimal archive, Java 21 and Debian', () => {
  const file = opensearchCompatibilityDockerfile()
  assert.match(file, /^FROM debian:bookworm-slim@sha256:[a-f0-9]{64}/u)
  assert.match(file, /releases\/core\/opensearch\/3\.9\.0\/opensearch-min-/u)
  assert.match(file, /sha512sum -c -/u)
  assert.match(file, /temurin21-binaries/u)
  assert.match(file, /sha256sum -c -/u)
  assert.match(file, /NOTICE\.txt/u)
  assert.match(file, /legal\/java.base\/LICENSE/u)
  assert.match(file, /test -z .*plugins/u)
  assert.match(file, /USER 1000:1000/u)
  assert.doesNotMatch(file, /--privileged|amazonlinux|opensearch-knn|UseAVX/u)
  for (const line of file.split('\n').filter(line => line.startsWith('RUN '))) assert.equal(spawnSync('/bin/sh', ['-n', '-c', line.slice(4)]).status, 0)
  assert.notEqual(opensearchCompatibilityImage(1), opensearchCompatibilityImage(2))
  for (const value of [0, '../other', 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => opensearchCompatibilityImage(value))
})

test('Magento defaults to official OpenSearch and CPU selection is guarded before mutation', () => {
  assert.ok(magentoComposeAssets().compose.includes(`    image: ${OPENSEARCH_IMAGE}`))
  assert.equal(magentoComposeRelease().images.length, 5)
  const built = build()
  const baseline = built.plan.commands[0].command
  assert.ok(baseline.indexOf('CPU_FEATURES_UNAVAILABLE') < baseline.indexOf('install -d'))
  assert.ok(baseline.indexOf('docker volume ls') < baseline.indexOf('install -d'))
  assert.ok(baseline.indexOf('docker network ls') < baseline.indexOf('install -d'))
  const swapGuard = baseline.indexOf("test ! -e '/var/lib/webminai/webminai-magento-18108.swap'")
  assert.ok(swapGuard >= 0 && swapGuard < baseline.indexOf('install -d'))
  assert.match(baseline, /test ! -L '\/var\/lib\/webminai\/webminai-magento-18108\.swap'/u)
  const pull = built.plan.commands.find(c => c.id === 'pull-images').command
  assert.match(pull, /standard\).*pull --quiet;; compat\)/u)
  assert.match(pull, /builder-created/u)
  assert.match(pull, /trap cleanup_builder EXIT HUP INT TERM/u)
  assert.match(built.plan.commands.find(c => c.id === 'start-dependencies').command, /--pull never/u)
  assert.deepEqual(built.plan.commands.find(c => c.id === 'initialize-magento').dependsOn, ['verify-search'])
  for (const c of [...built.plan.commands, ...built.plan.revertCommands]) assert.equal(spawnSync('/bin/sh', ['-n', '-c', c.command]).status, 0, c.id)
})

test('OpenSearch verification requires an actual indexed search result and removes its probe', () => {
  const command = build().plan.commands.find(c => c.id === 'verify-search').command.replace("cd '/opt/webminai/services/magento'", ':')
  for (const mode of ['success', 'empty-search', 'existing-index', 'create-timeout', 'delete-timeout', 'changed-uuid']) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'opensearch-probe-'))
    const calls = path.join(directory, 'calls')
    const index = path.join(directory, 'index')
    const uuidCalls = path.join(directory, 'uuid-calls')
    try {
      if (mode === 'existing-index') writeFileSync(index, 'preserve existing data')
      const mock = `docker () { printf '%s\\n' "$*" >> '${calls}'; case "$*" in
        *'--head'*) if [ -e '${index}' ]; then printf 200; else printf 404; fi;;
        *'_cat/indices/'*) printf x >> '${uuidCalls}'; ${mode === 'changed-uuid' ? `if [ "$(wc -c < '${uuidCalls}')" -gt 1 ]; then printf zzzzzzzzzzzzzzzzzzzzzz; return 0; fi;` : ''} printf abcdefghijklmnopqrstuv;;
        *'_count?'*) printf '%s' '{"count":${mode === 'empty-search' ? 0 : 1},"_shards":{"successful":1}}';;
        *'-X PUT'*'/_doc/'*) printf '{}';;
        *'-X PUT'*) : > '${index}'; ${mode === 'create-timeout' ? 'return 28;' : ''} printf '%s' '{"acknowledged":true}';;
        *'-X DELETE'*) ${mode === 'delete-timeout' ? 'return 28;' : ''} rm -f '${index}'; printf '%s' '{"acknowledged":true}';;
        *) printf '%s' '{"version":{"number":"${OPENSEARCH_VERSION}"}}';;
      esac; }; `
      const result = spawnSync('/bin/sh', ['-c', mock + command], { encoding: 'utf8' })
      assert.equal(result.status, mode === 'success' ? 0 : mode.endsWith('timeout') ? 28 : 1, mode + ': ' + result.stderr)
      const output = readFileSync(calls, 'utf8')
      const deletes = (output.match(/-X DELETE/gu) ?? []).length
      assert.equal(deletes, ['success', 'empty-search', 'delete-timeout'].includes(mode) ? 1 : 0, mode)
      if (mode === 'existing-index') assert.equal(readFileSync(index, 'utf8'), 'preserve existing data')
      if (mode === 'success') assert.match(output, /--max-time 150 -X PUT/u)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
})

test('Magento rollback rejects changed compatibility image identity and preserves unowned builders', () => {
  const source = build().plan.revertCommands.find(c => c.id === 'remove-compose-images').command
  for (const changed of [false, true]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'opensearch-cleanup-'))
    const calls = path.join(directory, 'calls')
    try {
      writeFileSync(path.join(directory, 'image-profile'), 'compat')
      writeFileSync(path.join(directory, 'builder-created'), '')
      for (const i of [0, 1, 2, 3, 4, 6]) writeFileSync(path.join(directory, `image-${i}.existed`), '')
      writeFileSync(path.join(directory, 'image-5.after'), 'sha256:owned\n')
      const command = source.replaceAll('/var/lib/webminai/task-state/23-magento-compose', directory)
      const mock = `docker () { printf '%s\\n' "$*" >> '${calls}'; case "$1 $2" in 'buildx inspect') return 1;; 'image inspect') printf '%s\\n' '${changed ? 'sha256:changed' : 'sha256:owned'}';; esac; }; `
      const result = spawnSync('/bin/sh', ['-c', mock + command], { encoding: 'utf8' })
      assert.equal(result.status, changed ? 1 : 0, result.stderr)
      assert.equal(readFileSync(calls, 'utf8').includes('image rm intentaiops/magento-opensearch:'), !changed)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
  assert.match(source, /if .*builder-created.*; then docker buildx rm/u)
})

test('macOS keeps official image order and reads CPU capabilities only inside Colima', () => {
  const built = buildMacosComposeTask('magento', 23, { platform: 'macos', runtimeUser: 'operator', runtimeHome: '/Users/operator', architecture: 'x86_64' }, { ready: true })
  const capture = built.plan.commands.find(command => command.id === 'capture-baseline').command
  assert.match(capture, /standard > .*image-profile/u)
  assert.match(built.plan.commands[0].command, /colima ssh.*\/proc\/cpuinfo/u)
  for (const c of built.plan.commands.filter(command => command.id !== 'validate-image-cpu')) assert.doesNotMatch(c.command, /\/proc\/cpuinfo/u)
  assert.match(capture, new RegExp(OPENSEARCH_IMAGE + "'[^;]*; then : > '[^']*image-3\\.existed"))
})
