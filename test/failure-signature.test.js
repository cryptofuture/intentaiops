import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyFailure, isFailureCode } from '../src/failure-signature.js'
import { executionDiagnostics } from '../src/execution-diagnostics.js'

test('FreeBSD pkg missing exact package is an authoritative package failure, not a transport diagnosis', () => {
  const item = { id: 'install-jellyfin-runtime' }
  const result = { exitCode: 1, stderr: "pkg: No packages available to install matching 'jellyfin-10.11.11' have been found in the repositories" }
  assert.equal(classifyFailure({ item, result }).code, 'PACKAGE_NOT_FOUND')
  assert.ok(executionDiagnostics({ item, result }).some(value => value.code === 'PACKAGE_NOT_FOUND' && value.confidence === 'confirmed'))
  assert.deepEqual(executionDiagnostics({ item, result: { ...result, exitCode: 0 } }), [])
})

test('explicit CPU instruction-set failures remain distinct from exit 127 or SIGKILL', () => {
  const item = { id: 'check-cpu', phase: 'baseline' }
  for (const stderr of ['CPU_INSTRUCTION_SET_UNSUPPORTED: requires x86-64-v2', 'Fatal glibc error: CPU does not support x86-64-v2']) {
    const result = { exitCode: 1, stderr }
    assert.equal(classifyFailure({ item, result }).code, 'CPU_INSTRUCTION_SET_UNSUPPORTED')
    assert.ok(isFailureCode('CPU_INSTRUCTION_SET_UNSUPPORTED'))
    assert.ok(executionDiagnostics({ item, result }).some(value => value.code === 'CPU_INSTRUCTION_SET_UNSUPPORTED'))
  }
  for (const exitCode of [127, 137]) assert.equal(classifyFailure({ item, result: { exitCode } }).code, 'COMMAND_FAILED')
})

test('Docker package and LXC runtime failures stay distinct from execution uncertainty', () => {
  for (const [marker, code] of [['DOCKER_PACKAGE_INSTALL_FAILED', 'PACKAGE_MANAGER_FAILED'], ['DOCKER_LAB_RUNTIME_UNAVAILABLE', 'DOCKER_SERVICE_NOT_READY']]) {
    const item = { id: 'docker-lab' }
    const result = { exitCode: 78, stderr: marker + ': inspect recorded state', stdout: '' }
    assert.equal(classifyFailure({ item, result }).code, code)
    assert.ok(executionDiagnostics({ item, result }).some(value => value.code === code && value.confidence === 'confirmed'))
    assert.deepEqual(executionDiagnostics({ item, result: { ...result, exitCode: 0 } }), [])
    const uncertain = { ...result, exitCode: null, state: 'unknown' }
    executionDiagnostics({ item, result: uncertain })
    assert.equal(uncertain.state, 'unknown')
  }
})

test('the explicit installer runtime rejection explains failure without changing an uncertain outcome', () => {
  const item = { id: 'install-intent-ai-ops', phase: 'acquire' }
  const result = { exitCode: 1, stderr: 'ERROR: Node.js 22.23.3 is installed, but Intent AI Ops requires 24.7 or newer. Upgrade it explicitly and rerun this installer.' }
  assert.equal(classifyFailure({ item, result }).code, 'RUNTIME_VERSION_INCOMPATIBLE')
  assert.ok(isFailureCode('RUNTIME_VERSION_INCOMPATIBLE'))
  const diagnostics = executionDiagnostics({ item, result })
  assert.ok(diagnostics.some(value => value.code === 'RUNTIME_VERSION_INCOMPATIBLE' && value.confidence === 'confirmed'))
  assert.ok(!diagnostics.some(value => value.code === 'CAUSE_UNKNOWN'))
  assert.deepEqual(executionDiagnostics({ item, result: { ...result, exitCode: 0 } }), [])
  const uncertain = { ...result, exitCode: null, state: 'unknown' }
  assert.ok(executionDiagnostics({ item, result: uncertain }).some(value => value.code === 'RUNTIME_VERSION_INCOMPATIBLE'))
  assert.equal(uncertain.state, 'unknown')
  assert.equal(classifyFailure({ item, result: { exitCode: 1, stderr: 'Node.js may be old' } }).code, 'COMMAND_FAILED')
})

test('a recorded apt lock owner explains package contention without changing execution outcome', () => {
  const item = { id: 'install-jellyfin', phase: 'acquire' }
  const result = { exitCode: 100, stderr: 'E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 18233 (unattended-upgr)' }
  const failure = classifyFailure({ item, result })
  assert.equal(failure.code, 'PACKAGE_MANAGER_BUSY')
  assert.ok(isFailureCode(failure.code))
  const observations = executionDiagnostics({ item, result })
  assert.ok(observations.some(value => value.code === 'PACKAGE_MANAGER_BUSY' && value.confidence === 'confirmed'))
  assert.match(observations.find(value => value.code === 'PACKAGE_MANAGER_BUSY').explanation, /Wait for it to finish; do not remove its lock/u)
  assert.ok(!observations.some(value => value.code === 'CAUSE_UNKNOWN'))
  assert.deepEqual(executionDiagnostics({ item, result: { ...result, exitCode: 0 } }), [])
  assert.equal(classifyFailure({ item, result: { exitCode: 100, stderr: 'Could not open lock file /var/lib/dpkg/lock-frontend: Permission denied' } }).code, 'PERMISSION_DENIED')
  assert.equal(classifyFailure({ item, result: { exitCode: 1, stderr: 'Could not get lock /tmp/application.lock. It is held by process 123' } }).code, 'COMMAND_FAILED')
})

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

test('an explicit dpkg conffile prompt explains a package configuration failure', () => {
  const item = { id: 'install-stack', phase: 'packages' }
  const result = { exitCode: 100, stderr: 'dpkg: error processing package mysql-server-8.0 (--configure):\n end of file on stdin at conffile prompt' }
  assert.equal(classifyFailure({ item, result }).code, 'PACKAGE_CONFIGURATION_CONFLICT')
  const observations = executionDiagnostics({ item, result })
  assert.ok(observations.some(value => value.code === 'PACKAGE_CONFIGURATION_CONFLICT' && value.confidence === 'confirmed'))
  assert.match(observations.find(value => value.code === 'PACKAGE_CONFIGURATION_CONFLICT').explanation, /configuration-file decision/u)
  assert.ok(!observations.some(value => value.code === 'CAUSE_UNKNOWN'))
  assert.deepEqual(executionDiagnostics({ item, result: { ...result, exitCode: 0 } }), [])
})

test('explicit recovery guard refusals explain incomplete restoration without implying data loss or retry', () => {
  for (const marker of ['DATABASE_DATA_REMAINS', 'RECOVERY_BASELINE_CHANGED']) {
    const item = { id: 'restore-stack', phase: 'cleanup' }
    const result = { exitCode: 1, stderr: marker + ': preserve and inspect baseline', stdout: 'x'.repeat(10000) }
    assert.equal(classifyFailure({ item, result }).code, 'BASELINE_RESTORATION_BLOCKED')
    const diagnostics = executionDiagnostics({ item, result })
    assert.ok(diagnostics.some(value => value.code === 'BASELINE_RESTORATION_BLOCKED' && value.confidence === 'confirmed'))
    assert.match(diagnostics.find(value => value.code === 'BASELINE_RESTORATION_BLOCKED').explanation, /restoration is not complete/u)
    assert.ok(!diagnostics.some(value => value.code === 'CAUSE_UNKNOWN'))
    assert.deepEqual(executionDiagnostics({ item, result: { ...result, exitCode: 0 } }), [])
  }
})

test('explicit cancellation is not inferred to be a timeout from SIGTERM alone', () => {
  const failure = classifyFailure({ item: { id: 'cancelled-job', phase: 'acquire' }, result: { state: 'cancelled', timedOut: false, exitCode: 143, signal: 15 } })
  assert.equal(failure.code, 'COMMAND_FAILED')
})

test('request timeout parameters are not timeout evidence', () => {
  const item = { id: 'cleanup', phase: 'cleanup' }
  const error = new Error('Netdata POST /api/v3/function?function=webminai%3Acommand&timeout=300 failed: SSH command failed with exit code 22')
  assert.equal(classifyFailure({ item, error }).code, 'COMMAND_FAILED')
  for (const stderr of ['request timed out', 'execution timeout exceeded', 'deadline exceeded', 'timeout']) {
    assert.equal(classifyFailure({ item, result: { exitCode: 1, stderr } }).code, 'TIMEOUT', stderr)
  }
})

test('Docker CDN header timeout is an artifact failure, not an execution deadline', () => {
  const item = { id: 'pull-images', phase: 'acquire' }
  const result = { exitCode: 1, timedOut: false, stderr: 'failed to copy: httpReadSeeker: Get "https://cdn.example.test/blob?Signature=fixture-signature&Key-Pair-Id=fixture-key": net/http: timeout awaiting response headers' }
  const failure = classifyFailure({ item, result })
  assert.equal(failure.code, 'ARTIFACT_DOWNLOAD_FAILED')
  assert.ok(!failure.evidence.includes('fixture-'))
  const diagnostics = executionDiagnostics({ item, result })
  assert.ok(diagnostics.some(value => value.code === 'CONNECTION_TIMEOUT' && value.scope === 'remote-command' && value.confidence === 'confirmed'))
  assert.ok(diagnostics.some(value => value.code === 'ARTIFACT_DOWNLOAD_FAILED'))
  assert.ok(!diagnostics.some(value => ['EXECUTION_TIMEOUT', 'CAUSE_UNKNOWN'].includes(value.code)))
  assert.deepEqual(executionDiagnostics({ item, result: { ...result, exitCode: 0 } }), [])
  assert.equal(classifyFailure({ item, result: { ...result, timedOut: true } }).code, 'TIMEOUT')
  const uncertain = { ...result, exitCode: null, state: 'unknown' }
  executionDiagnostics({ item, result: uncertain })
  assert.equal(uncertain.state, 'unknown')
})

test('an explicit package version assertion retains a stable failure category', () => {
  const failure = classifyFailure({ item: { id: 'install-jellyfin', phase: 'acquire' }, result: { exitCode: 1, stderr: 'PACKAGE_VERSION_MISMATCH: jellyfin-server expected 10.11.11, observed 12.2' } })
  assert.equal(failure.code, 'PACKAGE_VERSION_MISMATCH')
  assert.ok(isFailureCode(failure.code))
})

test('storage preflight distinguishes insufficient capacity from unavailable measurements', () => {
  for (const code of ['INSUFFICIENT_DISK', 'DISK_CAPACITY_UNAVAILABLE']) {
    const result = { exitCode: 78, stderr: `${code}: cold build preflight stopped before mutation` }
    assert.equal(classifyFailure({ item: { id: 'prepare-podman-application' }, result }).code, code)
    assert.ok(isFailureCode(code))
    assert.equal(classifyFailure({ item: { id: 'prepare-podman-application' }, result: { ...result, timedOut: true } }).code, 'TIMEOUT')
  }
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
