import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { executionDiagnostics, diagnosticSummary } from '../src/execution-diagnostics.js'
import { hostEvidenceCommand, parseHostEvidence, captureExecutionEvidence, collectHostEvidence } from '../src/host-execution-evidence.js'
import { kubernetesWorkloadDiagnostics, containerRuntimeDiagnostics, kubernetesApiDiagnostics } from '../src/workload-execution-evidence.js'
import { collectComposeEvidence, collectContainerEvidence } from '../src/container-execution-evidence.js'
import { executeApprovedPlan } from '../src/plan-validator.js'
import { KubernetesNetdataClient } from '../src/kubernetes-netdata-client.js'
import { runProcess } from '../src/process-runner.js'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const before = { availability: 'available', platform: 'linux', bootId: 'boot-a', scopeId: 'group-a', oomKills: 0, memoryLimitBytes: 805306368, observedAt: '2026-10-16T01:00:00Z' }
const codes = observations => observations.map(value => value.code)
const window = { uid: 'pod-a', startedAt: '2026-10-16T01:00:00Z', observedAt: '2026-10-16T02:00:00Z' }

test('execution outcome is independent of OOM, reboot, timeout and cancellation evidence', () => {
  const result = { state: 'unknown', exitCode: null, signal: 9 }
  const observations = executionDiagnostics({ result, before, after: { ...before, oomKills: 1 } })
  assert.equal(observations.find(value => value.code === 'OOM_KILL').confidence, 'suspected')
  assert.equal(result.state, 'unknown')
  assert.ok(!codes(executionDiagnostics({ result })).includes('OOM_KILL'))
  assert.ok(!codes(executionDiagnostics({ result: { exitCode: 137 } })).includes('OOM_KILL'))
  assert.ok(codes(executionDiagnostics({ result: { exitCode: 143, timedOut: true } })).includes('EXECUTION_TIMEOUT'))
  assert.ok(!codes(executionDiagnostics({ result: { exitCode: 143, state: 'cancelled' } })).includes('EXECUTION_TIMEOUT'))
  assert.ok(codes(executionDiagnostics({ result, before, after: { ...before, bootId: 'boot-b' } })).includes('HOST_REBOOT'))
  for (const after of [{ ...before }, { ...before, oomKills: -1 }, { ...before, scopeId: 'group-b', oomKills: 1 }, { ...before, bootId: 'boot-b', oomKills: 1 }, { ...before, availability: 'unavailable', oomKills: 1 }, { ...before, oomKills: 1, observedAt: '2026-10-15T01:00:00Z' }, { ...before, oomKills: 1, observedAt: '2026-10-18T01:00:00Z' }]) {
    assert.ok(!codes(executionDiagnostics({ result, before, after })).includes('OOM_KILL'))
  }
  assert.equal(codes(executionDiagnostics({ result: { exitCode: 0, stderr: 'no space left on device' } })).length, 0)
})

test('structured reasons do not retain raw errors, payloads or secrets', () => {
  const cases = [
    ['DISK_FULL', 'No space left on device'], ['QUOTA_EXCEEDED', 'Disk quota exceeded'],
    ['SSH_HOST_KEY', 'Host key verification failed'], ['SSH_AUTHENTICATION', 'Permission denied (publickey)'],
    ['NAME_RESOLUTION', 'Could not resolve hostname'], ['CONNECTION_LOST', 'Connection reset by peer'],
    ['CONNECTION_REFUSED', 'ECONNREFUSED'], ['CONNECTION_TIMEOUT', 'ETIMEDOUT'],
    ['MEMORY_ALLOCATION_FAILED', 'ENOMEM'], ['PERMISSION_DENIED', 'Operation not permitted'],
    ['PACKAGE_VERSION_MISMATCH', 'PACKAGE_VERSION_MISMATCH: jellyfin-server expected 10.11.11, observed 12.2']
  ]
  for (const [code, message] of cases) {
    const observations = executionDiagnostics({ error: new Error(message + ' password=KNOWN_SECRET'), result: { exitCode: null } })
    assert.ok(codes(observations).includes(code))
    assert.ok(!JSON.stringify(observations).includes('KNOWN_SECRET'))
    assert.match(diagnosticSummary(observations), /Inspect recorded remote state/u)
  }
  assert.deepEqual(codes(executionDiagnostics({ result: { exitCode: null } })), ['CAUSE_UNKNOWN'])
  assert.ok(codes(executionDiagnostics({ result: { state: 'unknown', exitCode: null, stderr: 'detached job controller exited before recording a result' } })).includes('CONTROLLER_DISAPPEARED'))
  assert.ok(!codes(executionDiagnostics({ result: { exitCode: 255 } })).includes('CONNECTION_LOST'))
  const wrapped = new Error('Netdata request failed', { cause: Object.assign(new Error('SSH command failed with exit code 255'), { result: { stderr: 'Host key verification failed password=KNOWN_SECRET', timedOut: true } }) })
  assert.ok(codes(executionDiagnostics({ error: wrapped })).includes('SSH_HOST_KEY'))
  assert.ok(codes(executionDiagnostics({ error: wrapped })).includes('LOCAL_PROCESS_TIMEOUT'))
  assert.ok(!JSON.stringify(executionDiagnostics({ error: wrapped })).includes('KNOWN_SECRET'))
  const windows = executionDiagnostics({ result: { exitCode: -1073741801 }, before: { platform: 'windows' } })
  assert.equal(windows.find(value => value.code === 'WINDOWS_NATIVE_STATUS').evidence.nativeStatus, 3221225495)
  const hostEvents = executionDiagnostics({ before: { ...before, platform: 'windows', resourceExhaustionRecordId: 10, applicationCrashRecordId: 20 }, after: { ...before, platform: 'windows', resourceExhaustionRecordId: 11, applicationCrashRecordId: 21 }, result: { exitCode: null } })
  assert.ok(codes(hostEvents).includes('RESOURCE_EXHAUSTION'))
  assert.ok(codes(hostEvents).includes('HOST_APPLICATION_CRASH'))
  assert.equal(hostEvents.find(value => value.code === 'HOST_APPLICATION_CRASH').confidence, 'suspected')
})

test('fixed platform collectors use bounded allowlisted snapshots', async () => {
  for (const platform of ['linux', 'freebsd', 'macos']) {
    assert.doesNotThrow(() => execFileSync('/bin/sh', ['-n'], { input: hostEvidenceCommand(platform) }))
    const evidence = parseHostEvidence(platform, { exitCode: 0, stdout: 'collectorComplete=1\nbootId=123456\nscopeId=/private/path:99\noomKills=2\npassword=KNOWN_SECRET\navailableMemoryBytes=123\n' })
    assert.equal(evidence.oomKills, 2)
    assert.equal(evidence.scopeId.length, 40)
    assert.ok(!JSON.stringify(evidence).includes('KNOWN_SECRET'))
    assert.ok(!JSON.stringify(evidence).includes('/private/path'))
  }
  assert.match(hostEvidenceCommand('windows'), /-EncodedCommand/u)
  assert.equal(hostEvidenceCommand('kubernetes'), null)
  assert.throws(() => hostEvidenceCommand('linux', "/tmp/x';echo unsafe"), /safe path/u)
  assert.match(hostEvidenceCommand('linux', '/var/lib/app'), /df -Pk '\/var\/lib\/app'/u)
  const windows = parseHostEvidence('windows', { exitCode: 0, stdout: JSON.stringify({ collectorComplete: 1, bootId: '638000000000000000', availableMemoryBytes: 10, credential: 'KNOWN_SECRET' }) })
  assert.equal(windows.bootId, '638000000000000000')
  assert.ok(!JSON.stringify(windows).includes('KNOWN_SECRET'))
  assert.equal(parseHostEvidence('linux', { exitCode: 0, stdout: 'x'.repeat(9000) }).availability, 'truncated')
  assert.equal(parseHostEvidence('linux', { exitCode: 1, timedOut: true }).availability, 'timeout')
  assert.equal((await captureExecutionEvidence({ collectExecutionEvidence: async () => { throw new Error('denied') } })).availability, 'unavailable')
  assert.equal(await captureExecutionEvidence({}), undefined)
  assert.equal((await collectHostEvidence({ health: async () => { throw new Error('unavailable') } })).availability, 'unavailable')
})

test('Kubernetes scopes reasons by UID, generation and termination window', () => {
  const pod = { kind: 'Pod', metadata: { uid: 'pod-a', generation: 2 }, status: { containerStatuses: [{ name: 'app', restartCount: 1, state: { waiting: { reason: 'CrashLoopBackOff', message: 'KNOWN_SECRET' } }, lastState: { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: '2026-10-16T01:30:00Z' } } }] } }
  assert.ok(codes(kubernetesWorkloadDiagnostics(pod, window)).includes('WORKLOAD_OOM_KILLED'))
  assert.ok(codes(kubernetesWorkloadDiagnostics(pod, window)).includes('CONTAINER_RESTART_BACKOFF'))
  assert.ok(!JSON.stringify(kubernetesWorkloadDiagnostics(pod, window)).includes('KNOWN_SECRET'))
  assert.deepEqual(codes(kubernetesWorkloadDiagnostics(pod, { ...window, uid: 'reused-name-new-pod' })), ['EVIDENCE_UNAVAILABLE'])
  assert.deepEqual(codes(kubernetesWorkloadDiagnostics(pod, { ...window, generation: 3 })), ['STALE_WORKLOAD_STATE'])
  assert.ok(!codes(kubernetesWorkloadDiagnostics(pod, { ...window, startedAt: '2026-10-16T01:45:00Z' })).includes('WORKLOAD_OOM_KILLED'))
  const pending = { kind: 'Pod', metadata: { uid: 'pod-a' }, status: { phase: 'Pending' } }
  assert.deepEqual(kubernetesWorkloadDiagnostics(pending, window), [])
  for (const [condition, code] of [
    [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable' }, 'SCHEDULING_FAILED'],
    [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }, 'ROLLOUT_DEADLINE'],
    [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }, 'WORKLOAD_NOT_READY']
  ]) assert.ok(codes(kubernetesWorkloadDiagnostics({ ...pending, status: { conditions: [condition] } }, window)).includes(code))
  for (const reason of ['ImagePullBackOff', 'CreateContainerConfigError']) assert.ok(kubernetesWorkloadDiagnostics({ ...pending, status: { containerStatuses: [{ name: 'app', state: { waiting: { reason } } }] } }, window).length)
  assert.ok(codes(kubernetesWorkloadDiagnostics({ ...pending, status: { reason: 'Evicted' } }, window)).includes('POD_EVICTED'))
  assert.ok(codes(kubernetesWorkloadDiagnostics({ ...pending, kind: 'Job', status: { conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }] } }, window)).includes('KUBERNETES_JOB_DEADLINE'))
  for (const status of [401, 403, 404, 409, 429, 500, 502, 503, 504]) assert.equal(kubernetesApiDiagnostics(status).length, 1)
})

test('Docker and Podman require exact identities, not exit 137 or stale terminations', async () => {
  const id = 'a'.repeat(64)
  const object = { Id: id, Config: { Env: ['KNOWN_SECRET'] }, State: { OOMKilled: true, ExitCode: 137, FinishedAt: '2026-10-16T01:30:00Z', Health: { Status: 'unhealthy', Log: ['KNOWN_SECRET'] } } }
  assert.ok(codes(containerRuntimeDiagnostics(object, { ...window, id })).includes('WORKLOAD_OOM_KILLED'))
  assert.ok(!JSON.stringify(containerRuntimeDiagnostics(object, { ...window, id })).includes('KNOWN_SECRET'))
  assert.ok(!codes(containerRuntimeDiagnostics(object, { ...window, id, startedAt: '2026-10-16T01:45:00Z' })).includes('WORKLOAD_OOM_KILLED'))
  assert.deepEqual(codes(containerRuntimeDiagnostics(object, { ...window, id: 'b'.repeat(64) })), ['EVIDENCE_UNAVAILABLE'])
  for (const runtime of ['docker', 'podman']) {
    const observations = await collectContainerEvidence({
      runCommand: async (command, options) => {
        assert.match(command, new RegExp('^' + runtime + ' inspect', 'u'))
        assert.equal(options.timeoutSeconds, 5)
        return { exitCode: 0, stdout: 'true 137 "2026-10-16T01:30:00Z"' }
      }
    }, { runtime, id, startedAt: window.startedAt })
    assert.ok(codes(observations).includes('WORKLOAD_OOM_KILLED'))
  }
  await assert.rejects(collectContainerEvidence({}, { runtime: 'docker;evil', id }), /explicit runtime/u)
  const observations = await collectComposeEvidence({ runCommand: async () => ({ exitCode: 1 }) }, { kind: 'compose', target: '/opt/app' }, window.startedAt)
  assert.deepEqual(codes(observations), ['EVIDENCE_UNAVAILABLE'])
})

test('diagnostics never approve execution or replay an uncertain command', async () => {
  const item = { id: 'inspect', command: 'true', purpose: 'inspect', risk: 'read', timeoutMs: 1000, requiresSudo: false }
  const plan = { summary: 'Inspect', changeOverview: 'Read only', modifiedFiles: [], commands: [item, { ...item, id: 'later' }], revertCommands: [] }
  const events = []
  let dispatches = 0
  const netdata = { collectExecutionEvidence: async () => { throw new Error('KNOWN_SECRET') }, runCommand: async () => { dispatches++; throw new Error('Connection reset') } }
  const results = await executeApprovedPlan({ plan, policy: {}, netdata, approve: async () => true, onExecutionEvent: event => events.push(event) })
  assert.equal(dispatches, 1)
  assert.equal(results[0].recoveryRequired, true)
  assert.ok(codes(results[0].diagnostics).includes('CONNECTION_LOST'))
  assert.ok(events.some(event => event.type === 'command_outcome_unknown'))
  assert.ok(!JSON.stringify(events).includes('KNOWN_SECRET'))
  await executeApprovedPlan({ plan, policy: {}, netdata, approve: async () => false })
  assert.equal(dispatches, 1)
})

test('cancelled and timed-out native jobs cannot complete a step through exit code zero', async () => {
  for (const state of ['cancelled', 'timed_out']) {
    let calls = 0
    const item = { id: 'first', command: 'true', purpose: 'Inspect', risk: 'read', timeoutMs: 1000, requiresSudo: false }
    const plan = { summary: 'Inspect', changeOverview: 'Read only', modifiedFiles: [], commands: [item, { ...item, id: 'second' }], revertCommands: [] }
    const events = []
    const results = await executeApprovedPlan({ plan, policy: {}, approve: async () => true, netdata: { runCommand: async () => { calls++; return { exitCode: 0, state } } }, onExecutionEvent: event => events.push(event) })
    assert.equal(results[0].status, 'failed')
    assert.equal(calls, 1)
    assert.ok(!events.some(event => event.type === 'command_completed'))
  }
})

test('Kubernetes uncertain mutations retain uncertainty and inspection is namespace-scoped', async () => {
  let requests = 0
  const client = new KubernetesNetdataClient({ actionKey: 'a'.repeat(64), kubernetes: { request: async () => { requests++; throw new Error('Connection reset') } } })
  await assert.rejects(client.runApiRequest({ method: 'POST', path: '/api/v1/namespaces/webminai-tasks/pods', body: { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'app' } } }), error => error.recoveryRequired === true && codes(error.diagnostics).includes('CONNECTION_LOST'))
  assert.equal(requests, 1)
  for (const path of ['/api/v1/namespaces/webminai-tasks/secrets/secret', '/api/v1/namespaces/other/pods/app', '/api/v1/namespaces/webminai-tasks/pods/app/log']) await assert.rejects(client.collectWorkloadEvidence({ path, ...window }), /task-namespace/u)
  assert.equal(requests, 1)
})

test('Kubernetes read evidence follows written UIDs, remains sanitized and avoids repeated routine messages', async () => {
  const reports = []
  let object = { kind: 'Pod', metadata: { uid: 'pod-a', generation: 1, namespace: 'webminai-tasks', name: 'app' }, spec: { privateValue: 'KNOWN_SECRET' } }
  const client = new KubernetesNetdataClient({ actionKey: 'a'.repeat(64), kubernetes: { request: async () => ({ exitCode: 0, stdout: JSON.stringify(object), stderr: '' }) }, onDiagnostics: observations => reports.push(observations) })
  const resource = '/api/v1/namespaces/webminai-tasks/pods/app'
  await client.runApiRequest({ method: 'POST', path: '/api/v1/namespaces/webminai-tasks/pods', body: object })
  object = { ...object, status: { containerStatuses: [{ name: 'app', state: { waiting: { reason: 'CrashLoopBackOff', message: 'KNOWN_SECRET' } } }] } }
  await client.runApiRequest({ method: 'GET', path: resource })
  await client.runApiRequest({ method: 'GET', path: resource })
  assert.equal(reports.length, 1)
  assert.ok(!JSON.stringify(reports).includes('KNOWN_SECRET'))
  object = { ...object, metadata: { ...object.metadata, uid: 'pod-b' } }
  const reused = await client.runApiRequest({ method: 'GET', path: resource })
  assert.deepEqual(codes(reused.diagnostics), ['EVIDENCE_UNAVAILABLE'])
  object = { kind: 'Status', code: 403 }
  client.kubernetes.request = async () => ({ exitCode: 1, stdout: JSON.stringify(object), stderr: '' })
  await assert.rejects(client.kubernetesJson({ method: 'GET', path: resource }), error => codes(error.diagnostics).includes('API_AUTHORIZATION') && !error.recoveryRequired)
  client.kubernetes.request = async () => ({ exitCode: 0, timedOut: true, stdout: '{}', stderr: '' })
  await assert.rejects(client.kubernetesJson({ method: 'POST', path: '/api/v1/namespaces/webminai-tasks/pods', body: { metadata: { name: 'app' } } }), error => error.recoveryRequired)
  client.kubernetes.request = async () => ({ exitCode: 0, stdout: 'KNOWN_SECRET invalid JSON', stderr: '' })
  await assert.rejects(client.kubernetesJson({ method: 'POST', path: '/api/v1/namespaces/webminai-tasks/pods', body: { metadata: { name: 'app' } } }), error => error.recoveryRequired && !JSON.stringify(error).includes('KNOWN_SECRET') && !error.message.includes('KNOWN_SECRET'))
})

test('local runner timeout records intent without inventing a remote deadline', async () => {
  const killed = []
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end () {} }
  child.kill = signal => { killed.push(signal); queueMicrotask(() => child.emit('close', null, signal)) }
  const result = await runProcess('ssh', [], { timeoutMs: 5, spawnImpl: () => child })
  assert.equal(result.timedOut, true)
  assert.equal(result.terminationRequested, 'timeout')
  assert.deepEqual(killed, ['SIGTERM'])
  assert.ok(!codes(executionDiagnostics({ error: { result } })).includes('EXECUTION_TIMEOUT'))
})

test('Linux collector smoke test reads no privileged logs and projects only allowed fields', { skip: process.platform !== 'linux' }, () => {
  const stdout = execFileSync('/bin/sh', ['-c', hostEvidenceCommand('linux')], { encoding: 'utf8', timeout: 5000 })
  const evidence = parseHostEvidence('linux', { exitCode: 0, stdout })
  assert.equal(evidence.availability, 'available')
  assert.match(evidence.bootId, /^[a-f0-9-]{36}$/u)
  assert.ok(Number.isSafeInteger(evidence.rootAvailableKiB))
})

test('Linux effective limit and OOM evidence include limiting ancestors, not just the plugin service', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'intent-cgroup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const group = path.join(root, 'system.slice/netdata.service')
  await mkdir(group, { recursive: true })
  await writeFile(path.join(root, 'membership'), '0::/system.slice/netdata.service\n')
  for (const [directory, limit, kills] of [[root, '2147483648', 1], [path.dirname(group), 'max', 0], [group, 'max', 0]]) {
    await writeFile(path.join(directory, 'memory.max'), limit + '\n')
    await writeFile(path.join(directory, 'memory.events'), `oom_kill ${kills}\n`)
  }
  const command = hostEvidenceCommand('linux').replaceAll('/sys/fs/cgroup', root).replaceAll('/proc/self/cgroup', path.join(root, 'membership'))
  const evidence = parseHostEvidence('linux', { exitCode: 0, stdout: execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 5000 }) })
  assert.equal(evidence.memoryLimitBytes, 2147483648)
  assert.equal(evidence.oomKills, 1)
  assert.equal(evidence.memoryScopes.length, 3)
  assert.ok(!JSON.stringify(evidence).includes(root))
  const observations = executionDiagnostics({ before: { ...before, memoryScopes: [{ scopeId: 'parent', oomKills: 0 }] }, after: { ...before, memoryScopes: [{ scopeId: 'child', oomKills: 0 }, { scopeId: 'parent', oomKills: 1 }] }, result: { exitCode: null } })
  assert.ok(codes(observations).includes('OOM_KILL'))
})
