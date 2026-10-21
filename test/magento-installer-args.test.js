import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

test('Magento reindex failure cannot publish the completion marker', () => {
  for (const file of ['magento-task.js', 'windows-magento-compose-task.js']) {
    const source = readFileSync(new URL('../src/' + file, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /indexer:reindex[^\n]*?2>&1; touch/u, file)
    assert.match(source, /indexer:reindex[^\n]*?2>&1 && touch/u, file)
  }
  assert.notEqual(spawnSync('/bin/sh', ['-c', 'php () { return 1; }; touch () { exit 0; }; php bin/magento indexer:reindex --no-ansi --quiet >/dev/null 2>&1 && touch var/.webminai-indexed']).status, 0)
})

test('Magento installer first-name option remains one shell argument on every route', () => {
  for (const file of ['magento-task.js', 'windows-magento-compose-task.js', 'kubernetes-application-validation.js', 'freebsd-magento-task.js']) {
    const source = readFileSync(new URL('../src/' + file, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /--admin-firstname=Intent AI Ops/u, file)
    const option = source.match(/--admin-firstname=Intent\b/u)?.[0]
    assert.ok(option, file)
    assert.equal(spawnSync('/bin/sh', ['-c', `set -eu; set -- ${option} --admin-lastname=Administrator; test "$#" -eq 2; test "$1" = --admin-firstname=Intent`]).status, 0)
  }
})
