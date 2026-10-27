import assert from 'node:assert/strict'
import test from 'node:test'
import { formatDiagnosticError, redactDiagnosticText } from '../src/error-details.js'

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

test('diagnostic URLs exclude signed queries, credentials and launch fragments', () => {
  const values = [
    'https://cdn.example.test/blob?Expires=123&Signature=fixture-signature&Key-Pair-Id=fixture-key',
    'https://objects.example.test/item?X-Amz-Credential=fixture-credential&X-Amz-Signature=fixture-signature',
    'https://example.test/path?%53ignature=fixture-signature',
    'https://fixture-user:fixture-password@example.test/path?token=fixture-token',
    'http://127.0.0.1:4317/workspace/instance/#fixture-launch-token'
  ]
  for (const value of values) {
    const result = redactDiagnosticText('Download failed: "' + value + '"')
    assert.ok(!result.includes('fixture-'))
    assert.match(result, /redacted-(?:query|fragment)/u)
  }
  assert.equal(redactDiagnosticText('https://fixture-user:fixture-password@example.test/path'), 'https://example.test/path')
  assert.equal(redactDiagnosticText('See https://example.test/path for help'), 'See https://example.test/path for help')
  assert.equal(redactDiagnosticText('Failed https://[invalid?token=fixture-token'), 'Failed [redacted-http-url]')
})
