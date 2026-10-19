import { createHash } from 'node:crypto'
import { observation } from './execution-diagnostics.js'

const identity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(value)
const digest = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 40)
const inWindow = (value, startedAt, observedAt) => Number.isFinite(Date.parse(value)) && Date.parse(value) >= Date.parse(startedAt) && Date.parse(value) <= Date.parse(observedAt)

export function kubernetesWorkloadDiagnostics (object, { uid, startedAt, observedAt = new Date().toISOString(), generation } = {}) {
  if (!identity(uid) || object?.metadata?.uid !== uid || !Number.isFinite(Date.parse(startedAt)) || Date.parse(startedAt) > Date.parse(observedAt)) return [observation('EVIDENCE_UNAVAILABLE', 'unknown', 'kubernetes-workload', 'kubernetes-api', 'Workload identity or observation window could not be verified.')]
  if (!['Pod', 'Deployment', 'Job'].includes(object.kind)) return []
  if (generation !== undefined && (object.metadata.generation !== generation || (object.status?.observedGeneration !== undefined && object.status.observedGeneration < generation))) return [observation('STALE_WORKLOAD_STATE', 'unknown', 'kubernetes-workload', 'kubernetes-api', 'The workload controller has not observed the reviewed generation.')]
  const observations = []
  const add = (code, explanation, evidence = {}) => observations.push(observation(code, 'confirmed', 'kubernetes-workload', 'kubernetes-api', explanation, { uid, ...evidence }))
  const status = object.status ?? {}
  if (object.kind === 'Pod') {
    if (status.reason === 'Evicted') add('POD_EVICTED', 'Kubernetes reports this pod was evicted. Workload state is separate from API request outcome.')
    for (const container of [...(status.initContainerStatuses ?? []), ...(status.containerStatuses ?? [])].slice(0, 32)) {
      if (!identity(container.name)) continue
      const evidence = { container: container.name, ...(/^[a-z][a-z0-9+.-]*:\/\/[a-f0-9]{12,128}$/u.test(container.containerID ?? '') ? { runtimeIdentity: digest(container.containerID) } : {}), ...(Number.isSafeInteger(container.restartCount) ? { restartCount: container.restartCount } : {}) }
      for (const terminated of [container.state?.terminated, container.lastState?.terminated]) {
        if (!terminated || !inWindow(terminated.finishedAt, startedAt, observedAt)) continue
        const terminationEvidence = { ...evidence }
        delete terminationEvidence.runtimeIdentity
        if (/^[a-z][a-z0-9+.-]*:\/\/[a-f0-9]{12,128}$/u.test(terminated.containerID ?? '')) terminationEvidence.runtimeIdentity = digest(terminated.containerID)
        if (terminated.reason === 'OOMKilled') add('WORKLOAD_OOM_KILLED', 'Kubernetes recorded an OOM-killed container in this pod during the observation window.', terminationEvidence)
        else if (Number.isInteger(terminated.exitCode) && terminated.exitCode !== 0) add('CONTAINER_EXIT', 'Kubernetes recorded a nonzero container termination.', { ...terminationEvidence, exitCode: terminated.exitCode })
      }
      const waiting = container.state?.waiting?.reason
      if (['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName'].includes(waiting)) add('IMAGE_PULL_FAILED', 'The container cannot obtain its image.', evidence)
      if (['CreateContainerConfigError', 'CreateContainerError', 'RunContainerError'].includes(waiting)) add('CONTAINER_START_FAILED', 'The container cannot be configured or started.', evidence)
      if (waiting === 'CrashLoopBackOff') add('CONTAINER_RESTART_BACKOFF', 'Kubernetes is backing off container restarts. Inspect termination evidence for the underlying cause.', evidence)
      if (container.started === false && container.ready === false && container.state?.running) add('CONTAINER_NOT_STARTED', 'The running container has not passed startup. A failed probe is not inferred without explicit evidence.', evidence)
    }
  }
  for (const condition of (status.conditions ?? []).slice(0, 32)) {
    if (condition.lastTransitionTime && !inWindow(condition.lastTransitionTime, startedAt, observedAt)) continue
    if (condition.type === 'PodScheduled' && condition.status === 'False' && condition.reason === 'Unschedulable') add('SCHEDULING_FAILED', 'Kubernetes reports that this pod cannot be scheduled.')
    if (['Ready', 'ContainersReady'].includes(condition.type) && condition.status === 'False' && condition.reason === 'ContainersNotReady') add('WORKLOAD_NOT_READY', 'Kubernetes reports containers are not ready; a specific probe failure is not established.')
    if (condition.type === 'Progressing' && condition.status === 'False' && condition.reason === 'ProgressDeadlineExceeded') add('ROLLOUT_DEADLINE', 'The deployment exceeded its progress deadline.')
    if (object.kind === 'Job' && condition.type === 'Failed' && condition.status === 'True') add(condition.reason === 'DeadlineExceeded' ? 'KUBERNETES_JOB_DEADLINE' : 'KUBERNETES_JOB_FAILED', 'The Kubernetes Job controller reports this Job failed.')
    if (['DisruptionTarget', 'PodReadyToStartContainers'].includes(condition.type) && ['TerminationByKubelet', 'PreemptionByScheduler', 'DeletionByTaintManager'].includes(condition.reason)) add('POD_DISRUPTION', 'Kubernetes reports a pod disruption or termination condition.')
  }
  return observations.slice(0, 32)
}

export function containerRuntimeDiagnostics (object, { id, startedAt, observedAt = new Date().toISOString() } = {}) {
  if (!/^[a-f0-9]{64}$/u.test(id ?? '') || object?.Id !== id || !Number.isFinite(Date.parse(startedAt))) return [observation('EVIDENCE_UNAVAILABLE', 'unknown', 'container', 'runtime-inspect', 'The exact container identity and observation window could not be verified.')]
  const state = object.State ?? {}
  const observations = []
  const add = (code, explanation, evidence = {}) => observations.push(observation(code, 'confirmed', 'container', 'runtime-inspect', explanation, { runtimeIdentity: digest(id), ...evidence }))
  if (inWindow(state.FinishedAt, startedAt, observedAt)) {
    if (state.OOMKilled === true) add('WORKLOAD_OOM_KILLED', 'The runtime recorded this exact container as OOM-killed during the observation window.')
    if (Number.isInteger(state.ExitCode) && state.ExitCode !== 0) add('CONTAINER_EXIT', 'The runtime recorded a nonzero container exit.', { exitCode: state.ExitCode })
  }
  if (state.Health?.Status === 'unhealthy') add('CONTAINER_UNHEALTHY', 'The runtime reports an unhealthy container. Raw health-check output is withheld.')
  return observations
}

export function kubernetesApiDiagnostics (statusCode) {
  const codes = { 401: 'API_AUTHENTICATION', 403: 'API_AUTHORIZATION', 404: 'RESOURCE_NOT_FOUND', 409: 'RESOURCE_CONFLICT', 429: 'API_THROTTLED', 500: 'API_UNAVAILABLE', 502: 'GATEWAY_UNAVAILABLE', 503: 'API_UNAVAILABLE', 504: 'GATEWAY_TIMEOUT' }
  return codes[statusCode] ? [observation(codes[statusCode], 'confirmed', 'transport', 'kubernetes-api', `The API request returned HTTP ${statusCode}. Resource state and mutation outcome require separate inspection.`, { statusCode })] : []
}
