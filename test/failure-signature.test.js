import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyFailure, isFailureCode } from '../src/failure-signature.js'

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
