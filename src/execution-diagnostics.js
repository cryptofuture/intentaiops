import { classifyFailure } from './failure-signature.js'

const REVIEW = 'Inspect recorded remote state. Review any continuation or rollback; do not replay uncertain work.'

export function observation (code, confidence, scope, source, explanation, evidence = {}) {
  return { version: 1, code, confidence, scope, source, observedAt: new Date().toISOString(), explanation, evidence, nextAction: REVIEW }
}

export function executionDiagnostics ({ item = { id: 'execution' }, result = {}, error, before, after }) {
  const observations = []
  observations.push(...(after?.workloadDiagnostics ?? []))
  const add = (code, confidence, scope, explanation, evidence = {}, source = 'execution-result') => observations.push(observation(code, confidence, scope, source, explanation, evidence))
  const errorFields = []
  for (let cause = error, depth = 0; cause && depth < 4; cause = cause.cause, depth++) errorFields.push(cause.message, cause.code, cause.result?.stderr)
  const text = [...errorFields, result.stderr, result.stdout].filter(value => typeof value === 'string').join('\n').slice(0, 8192)
  const failed = error || result.exitCode === null || (Number.isInteger(result.exitCode) && result.exitCode !== 0) || result.timedOut || ['failed', 'timed_out', 'cancelled', 'unknown'].includes(result.state)
  if (Number.isInteger(error?.netdataHttpStatus) && error.netdataHttpStatus >= 400 && error.netdataHttpStatus <= 599) add('NETDATA_API_ERROR', 'confirmed', 'transport', `The Netdata API returned HTTP ${error.netdataHttpStatus}. This does not establish whether the remote command executed.`, { httpStatus: error.netdataHttpStatus }, 'netdata-http-response')
  if (result.timedOut === true || result.state === 'timed_out') add('EXECUTION_TIMEOUT', 'confirmed', 'remote-command', 'The recorded execution deadline was exceeded. Partial changes are possible.')
  if (result.state === 'cancelled') add('OPERATOR_CANCELLED', 'confirmed', 'remote-command', 'The remote job recorded cancellation. Partial changes are possible.')
  if (result.state === 'unknown' && /detached job controller exited before recording a result|job worker exited without a result/u.test(text)) add('CONTROLLER_DISAPPEARED', 'confirmed', 'remote-command', 'The job controller disappeared without a durable result. This does not identify the cause.')
  if (error?.result?.timedOut === true || error?.cause?.result?.timedOut === true) add('LOCAL_PROCESS_TIMEOUT', 'confirmed', 'local-client', 'The local transport process reached its deadline. This does not prove remote execution stopped.')
  if (Number.isInteger(result.signal) && result.signal > 0) add('PROCESS_SIGNAL', 'confirmed', 'remote-command', 'The remote process terminated with a recorded signal; the signal alone does not identify why.', { signal: result.signal })
  if (Number.isInteger(result.exitCode) && result.exitCode !== 0) add('PROCESS_EXIT', 'confirmed', 'remote-command', 'The process recorded a nonzero exit status.', { exitCode: result.exitCode })
  const patterns = [
    ['SSH_HOST_KEY', /host key verification failed|remote host identification has changed/iu, 'transport', 'SSH host-key verification failed. Verify the server identity independently.'],
    ['SSH_AUTHENTICATION', /permission denied \((?:publickey|password|keyboard-interactive)[^)]*\)|ssh.*authentication failed/iu, 'transport', 'SSH authentication was rejected.'],
    ['NAME_RESOLUTION', /could not resolve host|could not resolve hostname|\bENOTFOUND\b|\bEAI_AGAIN\b/iu, error ? 'transport' : 'remote-command', 'Name resolution failed.'],
    ['CONNECTION_REFUSED', /connection refused|\bECONNREFUSED\b/iu, error ? 'transport' : 'remote-command', 'The connection was refused.'],
    ['CONNECTION_FAILED', /failed to connect to [^\r\n]+could not connect to server/iu, error ? 'transport' : 'remote-command', 'The operation reported that it could not establish a connection. Inspect endpoint reachability; this does not establish the outcome of earlier remote work.'],
    ['CONNECTION_TIMEOUT', /connection timed out|connect timeout|\bETIMEDOUT\b/iu, error ? 'transport' : 'remote-command', 'A connection deadline was reached; this is not proof of a remote execution timeout.'],
    ['CONNECTION_LOST', /broken pipe|connection reset|connection (?:closed|lost)|\bECONNRESET\b|\bEPIPE\b/iu, error ? 'transport' : 'remote-command', 'An established connection was lost; remote execution may have continued.'],
    ['DISK_FULL', /no space left on device|\bENOSPC\b|disk (?:is )?full/iu, 'remote-command', 'The command reported insufficient filesystem space or inodes. Inspect the affected filesystem.'],
    ['PATH_NOT_FOUND', /no such file or directory|\bENOENT\b/iu, 'remote-command', 'The command reported a missing filesystem path or executable. Inspect required paths before reviewing continuation; partial changes remain possible.'],
    ['TARGET_CONFLICT', /^task target already exists:/imu, 'remote-command', 'The target-preservation guard refused an existing path. Inspect ownership and preserve existing data before reviewing a new plan.'],
    ['OWNERSHIP_UNCONFIRMED', /\b(?:APPLICATION|DATABASE|MOODLE_CRON)_OWNERSHIP_UNCONFIRMED\b/iu, 'remote-command', 'The ownership guard could not authorize cleanup. Inspect task ownership evidence and remote state before reviewing any continuation.'],
    ['QUOTA_EXCEEDED', /disk quota exceeded|\bEDQUOT\b/iu, 'remote-command', 'The command reported a quota limit.'],
    ['PERMISSION_DENIED', /permission denied|operation not permitted|access is denied|\bEACCES\b|\bEPERM\b/iu, 'remote-command', 'The operation reported a permission denial.'],
    ['MEMORY_ALLOCATION_FAILED', /\bENOMEM\b|cannot allocate memory|insufficient_memory|fatal error:.*heap out of memory/iu, 'remote-command', 'The command reported a memory allocation failure; this does not prove a kernel OOM kill.']
  ]
  if (failed) {
    for (const [code, pattern, scope, explanation] of patterns) if (pattern.test(text)) add(code, 'confirmed', scope, explanation, {}, 'explicit-error')
    const failure = classifyFailure({ item, result, error })
    const explanation = failure.code === 'RUNTIME_VERSION_INCOMPATIBLE'
      ? 'The installer rejected an incompatible Node.js version. Review a compatible task-private runtime or a separately approved system upgrade.'
      : failure.code === 'PACKAGE_MANAGER_BUSY'
        ? 'The package manager reported an installation lock held by another process. Wait for it to finish; do not remove its lock.'
        : failure.code === 'PACKAGE_CONFIGURATION_CONFLICT'
          ? 'dpkg required a configuration-file decision but no interactive input was available. Review the affected package configuration before continuing.'
          : failure.code === 'BASELINE_RESTORATION_BLOCKED'
            ? 'The baseline guard refused cleanup because data remains or recorded baseline integrity changed. Preserve the data and baseline, inspect ownership, and review a new cleanup plan; restoration is not complete.'
            : `Recorded failure category: ${failure.code}.`
    if (!['COMMAND_FAILED', 'TIMEOUT', 'PERMISSION_DENIED', 'INSUFFICIENT_MEMORY'].includes(failure.code)) add(failure.code, 'confirmed', 'remote-command', explanation, {}, 'failure-classifier')
  }
  const elapsed = Date.parse(after?.observedAt) - Date.parse(before?.observedAt)
  const comparable = before?.availability === 'available' && after?.availability === 'available' && before.platform === after.platform && Number.isFinite(elapsed) && elapsed >= 0
  if (comparable && before.bootId && after.bootId && before.bootId !== after.bootId) {
    const unique = before.bootIdentityKind === 'session' && after.bootIdentityKind === 'session'
    add('HOST_REBOOT', unique ? 'confirmed' : 'suspected', 'host', unique ? 'The unique boot session changed. The command outcome is separate.' : 'The reported boot time changed. A reboot is possible, but clock adjustments cannot be excluded.', {}, 'host-snapshot')
  }
  if (comparable && elapsed <= 86400000 && before.bootId && before.bootId === after.bootId) {
    const previous = [before, ...(before.memoryScopes ?? [])]
    const current = [after, ...(after.memoryScopes ?? [])]
    const changed = current.map(scope => ({ scope, old: previous.find(old => old.scopeId && old.scopeId === scope.scopeId) })).find(({ scope, old }) => old && Number.isSafeInteger(old.oomKills) && Number.isSafeInteger(scope.oomKills) && scope.oomKills > old.oomKills)
    if (changed) add('OOM_KILL', 'suspected', 'host', 'An observed cgroup recorded new OOM kills during this attempt. The victim process is unconfirmed; ancestor counters can include unrelated processes.', { delta: changed.scope.oomKills - changed.old.oomKills, scopeId: changed.scope.scopeId, ...(Number.isSafeInteger(before.memoryLimitBytes) ? { memoryLimitBytes: before.memoryLimitBytes } : {}) }, 'cgroup-memory-events')
  }
  if (comparable && before.bootId && before.bootId === after.bootId && Number.isSafeInteger(before.resourceExhaustionRecordId) && after.resourceExhaustionRecordId > before.resourceExhaustionRecordId) add('RESOURCE_EXHAUSTION', 'suspected', 'host', 'A newer Windows resource-exhaustion record was observed. It is not attributed to this process.', {}, 'windows-event-log')
  if (comparable && before.bootId && before.bootId === after.bootId && Number.isSafeInteger(before.applicationCrashRecordId) && after.applicationCrashRecordId > before.applicationCrashRecordId) add('HOST_APPLICATION_CRASH', 'suspected', 'host', 'A newer Windows application-crash record was observed. The application is not attributed to this task.', {}, 'windows-event-log')
  if (before?.platform === 'windows' && Number.isInteger(result.exitCode) && result.exitCode !== 0) add('WINDOWS_NATIVE_STATUS', 'confirmed', 'remote-command', 'The original Windows process status is preserved separately from POSIX signals.', { nativeStatus: result.exitCode >>> 0 })
  for (const snapshot of [before, after]) {
    if (snapshot && snapshot.availability !== 'available') add('EVIDENCE_UNAVAILABLE', 'unknown', 'host', 'Host evidence could not be collected; no cause is inferred.', { availability: snapshot.availability }, 'host-snapshot')
  }
  if (failed && observations.every(value => ['PROCESS_EXIT', 'PROCESS_SIGNAL', 'WINDOWS_NATIVE_STATUS', 'CONTROLLER_DISAPPEARED', 'EVIDENCE_UNAVAILABLE'].includes(value.code))) add('CAUSE_UNKNOWN', 'unknown', error ? 'transport' : 'remote-command', 'There is insufficient evidence to identify the interruption reason.')
  return observations.slice(0, 20)
}

export function diagnosticSummary (diagnostics = []) {
  return diagnostics.map(value => `${value.code} (${value.confidence}): ${value.explanation} ${value.nextAction}`).join('\n')
}
