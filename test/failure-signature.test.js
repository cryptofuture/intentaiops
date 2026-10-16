import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyFailure, isFailureCode } from '../src/failure-signature.js'

test('authoritative job timeouts retain their cause even with empty or misleading output', () => {
  for (const result of [{ timedOut: true }, { state: 'timed_out' }]) {
    for (const phase of ['acquire', 'services']) {
      const failure = classifyFailure({ item: { id: 'bounded-job', phase }, result: { exitCode: 143, stderr: '', ...result } })
      assert.equal(failure.code, 'TIMEOUT')
      assert.equal(failure.exitCode, 143)
      assert.equal(failure.evidence, 'Execution exceeded its configured timeout.')
    }
  }
  assert.equal(classifyFailure({ item: { id: 'download', phase: 'acquire' }, result: { timedOut: true, exitCode: 143, stderr: 'curl: (56) connection reset' } }).code, 'TIMEOUT')
})

test('explicit cancellation is not inferred to be a timeout from SIGTERM alone', () => {
  const failure = classifyFailure({ item: { id: 'cancelled-job', phase: 'acquire' }, result: { state: 'cancelled', timedOut: false, exitCode: 143, signal: 15 } })
  assert.equal(failure.code, 'COMMAND_FAILED')
})

test('an explicit package version assertion retains a stable failure category', () => {
  const failure = classifyFailure({ item: { id: 'install-jellyfin', phase: 'acquire' }, result: { exitCode: 1, stderr: 'PACKAGE_VERSION_MISMATCH: jellyfin-server expected 10.11.11, observed 12.2' } })
  assert.equal(failure.code, 'PACKAGE_VERSION_MISMATCH')
  assert.ok(isFailureCode(failure.code))
})

test('Windows Docker prerequisite failures retain actionable stable codes', () => {
  const cases = [
    'FIRMWARE_VIRTUALIZATION_DISABLED',
    'UNSUPPORTED_WINDOWS_VERSION',
    'INSUFFICIENT_MEMORY',
    'SLAT_UNAVAILABLE',
    'WINDOWS_INTERACTIVE_USER_REQUIRED',
    'WSL_RUNTIME_UNAVAILABLE',
    'REBOOT_REQUIRED',
    'DOCKER_SERVICE_NOT_READY'
  ]
  for (const code of cases) {
    const failure = classifyFailure({
      item: { id: 'windows-docker-preflight' },
      result: { exitCode: 1, stderr: `${code}: expected test evidence` }
    })
    assert.equal(failure.code, code)
    assert.equal(isFailureCode(code), true)
  }
})
