import assert from 'node:assert/strict'
import test from 'node:test'
import { formatDiagnosticError } from '../src/error-details.js'

test('diagnostic errors include nested remote evidence and redact secrets', () => {
  const actionKey = 'ab'.repeat(32)
  const remote = new Error('SSH command failed')
  remote.result = {
    code: 1,
    signal: null,
    stdout: `connecting to ssh://admin@example.test\nkey=${actionKey}\n`,
    stderr: 'systemctl: netdata.service failed\n'
  }
  const top = new AggregateError([remote], 'activation and rollback failed')
  top.diagnostics = 'journal: plugin exited with status 127'

  const text = formatDiagnosticError(top)
  assert.match(text, /activation and rollback failed/)
  assert.match(text, /Exit code: 1/)
  assert.match(text, /netdata\.service failed/)
  assert.match(text, /plugin exited with status 127/)
  assert.equal(text.includes(actionKey), false)
  assert.equal(text.includes('ssh://admin@example.test'), false)
})
