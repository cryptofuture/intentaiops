import assert from 'node:assert/strict'
import test from 'node:test'
import { findLatestBraveTask, requireCompleted, singleLine } from '../scripts/validate-windows-brave.js'

test('Windows Brave validation selects the newest matching task for the requested host', () => {
  const calls = []
  const admin = {
    listTasks (serverId, options) {
      calls.push({ serverId, options })
      return [
        { id: 7, request: 'inspect nginx' },
        { id: 6, request: 'install brave browser', status: 'partial' },
        { id: 5, request: 'install brave', status: 'completed' }
      ]
    }
  }
  assert.equal(findLatestBraveTask(admin, 'windows-11').id, 6)
  assert.deepEqual(calls, [{ serverId: 'windows-11', options: { limit: 100 } }])
})

test('Windows Brave validation requires every command result to complete', () => {
  assert.doesNotThrow(() => requireCompleted([{ id: 'verify', status: 'completed' }], 'Brave task'))
  assert.throws(
    () => requireCompleted([{ id: 'install', status: 'failed', result: { stderr: 'installer failed' } }], 'Brave task'),
    /Brave task did not complete: installer failed/
  )
  assert.throws(() => requireCompleted([], 'Brave task'), /Brave task did not complete: no result/)
})

test('Windows Brave validation progress output is bounded to one line', () => {
  assert.equal(singleLine('  first\nsecond\tthird  '), 'first second third')
  assert.equal(singleLine('x'.repeat(1200)).length, 1000)
  assert.equal(singleLine(null), '')
})
