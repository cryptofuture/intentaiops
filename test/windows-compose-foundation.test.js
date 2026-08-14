import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { buildWindowsComposeFoundation } from '../src/windows-compose-foundation.js'
import { buildWindowsJoomlaComposeTask } from '../src/windows-joomla-compose-task.js'
import { buildWindowsMoodleComposeTask } from '../src/windows-moodle-compose-task.js'

const windowsExecution = { platform: 'windows', docker: { serverOs: 'linux', serverVersion: '28.3.3' } }
const docker = { ready: true, preference: 'auto' }

test('Windows Compose foundation owns baseline, credentials, and reversible cleanup', () => {
  const built = buildWindowsComposeFoundation({
    taskId: 91,
    windowsExecution,
    docker,
    application: 'example',
    port: 18991,
    images: ['example/app:1', 'example/db:2']
  })

  assert.deepEqual(built.commands.map(item => item.id), ['capture-baseline', 'generate-credentials'])
  assert.deepEqual(built.revertCommands.map(item => item.id), ['remove-compose-project', 'remove-new-images', 'remove-task-files'])
  assert.match(built.commands[0].command, /example\/app:1/u)
  assert.match(built.commands[1].command, /S-1-5-18/u)
  assert.doesNotMatch(JSON.stringify(built), /password\s*[:=]\s*[A-Za-z0-9_-]{20,}/iu)
  assert.equal(built.revertCommands.find(item => item.id === 'remove-compose-project').executionMode, 'job')
  assert.equal(built.revertCommands.find(item => item.id === 'remove-new-images').executionMode, 'job')
})

test('Windows Compose foundation promotes default long application phases to durable jobs', () => {
  const built = buildWindowsJoomlaComposeTask(93, windowsExecution, docker)
  assert.equal(built.plan.commands.find(item => item.id === 'pull-images').executionMode, 'job')
  assert.equal(built.plan.commands.find(item => item.id === 'pull-images').timeoutMs, 3600000)
  assert.equal(built.plan.commands.find(item => item.id === 'start-compose').timeoutMs, 900000)
  assert.equal(built.plan.commands.find(item => item.id === 'initialize-joomla').timeoutMs, 1800000)
})

test('Windows Moodle is assembled from its own plan and shared Compose mechanics', async () => {
  const source = await readFile(new URL('../src/windows-moodle-compose-task.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /buildWindowsDrupalComposeTask|mapStrings|\.replaceAll\('drupal/iu)

  const built = buildWindowsMoodleComposeTask(92, windowsExecution, docker)
  assert.deepEqual(built.plan.commands.map(item => item.id), [
    'capture-baseline',
    'generate-credentials',
    'write-compose',
    'pull-images',
    'start-compose',
    'initialize-moodle',
    'verify-restart'
  ])
  assert.deepEqual(built.plan.revertCommands.map(item => item.id), [
    'remove-compose-project',
    'remove-new-images',
    'remove-task-files'
  ])
  const serialized = JSON.stringify(built)
  assert.match(serialized, /WEBMINAI_MOODLE_OK/u)
  assert.match(serialized, /webminai\/moodle:5\.2\.1-php8\.4-fpm-r2/u)
  assert.doesNotMatch(serialized, /Drupal|drupal:11\.4\.4/u)
})
