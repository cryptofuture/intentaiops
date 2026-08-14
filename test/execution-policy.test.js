import assert from 'node:assert/strict'
import test from 'node:test'
import { rootExecutionPolicy } from '../src/execution-policy.js'

test('root execution policy removes legacy sudo-helper configuration', () => {
  assert.deepEqual(rootExecutionPolicy({
    maxCommands: 10,
    allowSudo: true,
    sudoMode: 'webminai-root-helper',
    sudoCommandPrefix: 'sudo -n /usr/local/libexec/webminai-root',
    sudoActions: ['package-install']
  }), {
    maxCommands: 10,
    allowSudo: false,
    executionIdentity: 'root'
  })
})
