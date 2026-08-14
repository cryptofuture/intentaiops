const EXECUTION_MODES = new Set(['executable', 'context-only'])

const FOUNDATIONS = Object.freeze([
  foundation('linux-baseline', 'linux', ['baseline'], 'Capture task-owned host and package state before changes.', ['beforeRuntime'], ['baseline state'], 'Exact task-owned state is removed only after restoration.'),
  foundation('linux-docker-readiness', 'linux', ['preflight', 'packages'], 'Install or validate Docker only when host policy permits it.', ['beforeRuntime'], ['Docker engine', 'Docker Compose'], 'Runtime bootstrap is reverted only when installed by the task.', { runtime: 'docker' }),
  foundation('linux-docker-compose', 'linux', ['acquire', 'configure', 'services'], 'Create a reviewed Compose project and bounded service lifecycle.', ['afterRuntime', 'installApplication'], ['compose project', 'service root'], 'Task-owned containers, networks and volumes are removed.', { runtime: 'docker' }),
  foundation('linux-nginx-site', 'linux', ['configure', 'services'], 'Create an nginx site with bounded local verification.', ['configureApplication', 'verifyApplication'], ['nginx site path', 'HTTP endpoint'], 'Only task-owned nginx configuration is removed.'),
  foundation('linux-php-fpm-socket', 'linux', ['packages', 'configure', 'services'], 'Install and configure PHP-FPM through a Unix socket.', ['afterRuntime', 'configureApplication'], ['PHP-FPM Unix socket'], 'Package and service state are restored from baseline.'),
  foundation('linux-mariadb', 'linux', ['packages', 'database'], 'Prepare MariaDB and a task-owned application database.', ['afterDatabase'], ['database name', 'database user', 'credential path'], 'Only the task-owned database and user are removed.'),
  foundation('linux-postgresql', 'linux', ['packages', 'database'], 'Prepare PostgreSQL and a task-owned application database.', ['afterDatabase'], ['database name', 'database user', 'credential path'], 'Only the task-owned database and role are removed.'),
  foundation('windows-docker-wsl-readiness', 'windows', ['preflight', 'packages'], 'Validate firmware virtualization, WSL and Linux-container Docker readiness.', ['beforeRuntime'], ['Docker engine', 'Docker Compose'], 'Runtime bootstrap retains pre-existing Windows features.', { runtime: 'docker' }),
  foundation('windows-powershell-compose-adapter', 'windows', ['preflight', 'acquire', 'services'], 'Run Docker Compose safely from the LocalSystem PowerShell identity.', ['afterRuntime'], ['bounded Docker process adapter'], 'Worker processes and temporary streams are bounded.', { runtime: 'docker' }),
  foundation('windows-docker-compose', 'windows', ['baseline', 'secrets', 'acquire', 'services', 'cleanup'], 'Own Windows Compose baselines, protected credentials, lifecycle and rollback.', ['installApplication', 'verifyApplication', 'revertApplication'], ['compose project', 'service root', 'credential root', 'firewall rule'], 'Task-owned containers, images, files and firewall rules are removed.', { runtime: 'docker' }),
  foundation('freebsd-podman-readiness', 'freebsd', ['preflight', 'packages'], 'Install or validate native Podman on an eligible FreeBSD host.', ['beforeRuntime'], ['Podman', 'compose provider'], 'Runtime bootstrap preserves pre-existing packages.', { runtime: 'podman' }),
  foundation('freebsd-podman-compose', 'freebsd', ['baseline', 'secrets', 'acquire', 'services', 'cleanup'], 'Own a native FreeBSD Podman Compose project and rollback.', ['installApplication', 'verifyApplication', 'revertApplication'], ['compose project', 'service root', 'credential root'], 'Task-owned pods, volumes, images and files are removed.', { runtime: 'podman' }),
  foundation('macos-colima-compose', 'macos', ['preflight', 'baseline', 'secrets', 'acquire', 'services', 'cleanup'], 'Own a Colima-backed Docker Compose project on macOS.', ['beforeRuntime', 'installApplication', 'verifyApplication', 'revertApplication'], ['Colima profile', 'compose project', 'credential root'], 'Task-owned Compose state is removed without taking ownership of Homebrew.', { runtime: 'colima' }),
  foundation('kubernetes-api-workload', 'kubernetes', ['baseline', 'secrets', 'configure', 'services', 'verify', 'cleanup'], 'Manage reviewed namespace-scoped Kubernetes resources through the authenticated Stage 2 API gateway.', ['installApplication', 'configureApplication', 'verifyApplication', 'revertApplication'], ['namespace-scoped workload', 'ClusterIP Service', 'per-node health evidence'], 'Only label-owned resources in the Intent AI Ops task namespace are removed.'),
  foundation('host-generated-credentials', '*', ['secrets'], 'Generate credentials on the managed host and expose only protected paths and names.', ['afterRuntime'], ['credential paths and names'], 'Credentials are removed only when task ownership is recorded.'),
  foundation('service-verification', '*', ['health', 'verify'], 'Provide bounded health, restart-recovery and external marker checks.', ['verifyApplication'], ['health evidence'], 'Verification is read-only.'),
  foundation('safe-baseline-rollback', '*', ['cleanup'], 'Restore task-owned state and compare it with the captured baseline.', ['revertApplication'], ['revert evidence'], 'Rollback refuses to remove unowned state.')
])

const FOUNDATION_BY_ID = new Map(FOUNDATIONS.map(item => [item.id, item]))

export function listDeploymentFoundations () {
  return FOUNDATIONS.map(copyFoundation)
}

export function getDeploymentFoundation (id) {
  const value = FOUNDATION_BY_ID.get(id)
  if (!value) throw new Error(`unknown deployment foundation: ${id}`)
  return copyFoundation(value)
}

/** @param {{foundationIds: string[], platform: string, docker?: any, mode?: string}} options */
export function validateFoundationSelection ({ foundationIds, platform, docker = {}, mode = 'context-only' }) {
  if (!Array.isArray(foundationIds) || new Set(foundationIds).size !== foundationIds.length) throw new TypeError('foundation ids must be a unique array')
  if (!EXECUTION_MODES.has(mode)) throw new TypeError('invalid foundation mode')
  return foundationIds.map(id => {
    const value = getDeploymentFoundation(id)
    if (value.platform !== '*' && value.platform !== platform) throw new Error(`foundation ${id} does not support ${platform}`)
    if (value.runtime && docker.preference === 'disabled') throw new Error(`foundation ${id} is disabled by host container-runtime preference`)
    if (mode === 'executable' && value.runtime && !docker.ready && docker.installSupported !== true) throw new Error(`foundation ${id} requires an eligible container-runtime bootstrap`)
    return value
  })
}

/** @param {{foundationIds: string[], platform: string, docker?: any, mode?: string}} options */
export function buildFoundationPlanningContext ({ foundationIds, platform, docker = {}, mode = 'context-only' }) {
  return validateFoundationSelection({ foundationIds, platform, docker, mode }).map(value => ({
    id: value.id,
    version: value.version,
    platform: value.platform,
    mode,
    capabilities: value.capabilities,
    preconditions: runtimePreconditions(value, docker),
    extensionPoints: value.extensionPoints,
    expectedOutputs: value.expectedOutputs,
    verification: value.verification,
    rollbackGuarantee: value.rollbackGuarantee
  }))
}

export function annotateVerifiedPlan (plan, { catalogId, foundationIds }) {
  const selected = foundationIds.map(getDeploymentFoundation)
  return {
    ...plan,
    foundationComposition: {
      version: 1,
      catalogId,
      foundationIds: selected.map(item => item.id)
    },
    commands: plan.commands.map(item => annotateCommand(item, selected, catalogId, false)),
    revertCommands: plan.revertCommands.map(item => annotateCommand(item, selected, catalogId, true))
  }
}

export function composeFoundationPlan ({ foundationCommands, applicationCommands, revertCommands = [], platform = null, docker = {}, foundationIds = null }) {
  if (!Array.isArray(foundationCommands) || !Array.isArray(applicationCommands) || !Array.isArray(revertCommands)) throw new TypeError('foundation composition requires command arrays')
  const verifiedIds = new Set(foundationCommands.map(item => item.id))
  if (applicationCommands.some(item => verifiedIds.has(item.id))) throw new Error('AI application commands cannot overwrite verified foundation commands')
  const commands = foundationCommands.map(item => requireSource(item, 'verified-foundation')).concat(applicationCommands.map(item => ({ ...item, source: { type: 'ai-planned' } })))
  const selectedIds = [...new Set(commands.filter(item => item.source.type === 'verified-foundation').map(item => item.source.id))]
  if (foundationIds && selectedIds.some(id => !foundationIds.includes(id))) throw new Error('composed commands do not match the selected foundation set')
  if (platform) validateFoundationSelection({ foundationIds: foundationIds ?? selectedIds, platform, docker, mode: 'executable' })
  const ownedReverts = revertCommands.map(item => item.source ? validateRevertSource(item) : { ...item, source: { type: 'ai-planned' } })
  validateGraph(commands, 'commands')
  validateGraph(ownedReverts, 'revertCommands')
  return { commands, revertCommands: ownedReverts }
}

export function executableFoundationFromCandidates (candidateContext) {
  if (!Array.isArray(candidateContext)) return null
  const candidate = candidateContext.find(item => item.foundationMode === 'executable' && item.executablePlan)
  if (!candidate) return null
  const foundationIds = [...candidate.foundationIds]
  const commands = normalizeDependencies(candidate.executablePlan.commands.filter(item => item.source?.type === 'verified-foundation' && foundationIds.includes(item.source.id)))
  const revertCommands = normalizeDependencies(candidate.executablePlan.revertCommands.filter(item => item.source?.type === 'verified-foundation' && foundationIds.includes(item.source.id)))
  if (commands.length === 0) throw new Error('executable foundation selection has no verified commands')
  return {
    foundationIds,
    commands,
    revertCommands,
    modifiedFiles: [...candidate.executablePlan.modifiedFiles],
    blueprint: {
      format: 'webminai-foundation-assisted-blueprint',
      version: 1,
      catalogId: candidate.catalogId,
      foundationIds,
      stablePaths: [...candidate.executablePlan.modifiedFiles],
      credentialPaths: candidate.executablePlan.modifiedFiles.filter(value => /credentials/iu.test(value)),
      allowedForwardPhases: ['configure', 'initialize', 'verify'],
      allowedRevertPhases: ['configure', 'cleanup', 'verify']
    }
  }
}

export function composeFoundationAssistedPlan ({ foundation, applicationPlan, platform, docker = {} }) {
  if (!foundation || !applicationPlan) throw new TypeError('foundation-assisted composition requires both plan parts')
  const applicationCommands = linkFirstDependency(applicationPlan.commands, foundation.commands.at(-1)?.id)
  const applicationReverts = applicationPlan.revertCommands.map(item => ({ ...item, source: { type: 'ai-planned' } }))
  const foundationReverts = linkFirstDependency(foundation.revertCommands, applicationReverts.at(-1)?.id)
  const combined = composeFoundationPlan({
    foundationCommands: foundation.commands,
    applicationCommands,
    revertCommands: applicationReverts.concat(foundationReverts),
    platform,
    docker,
    foundationIds: foundation.foundationIds
  })
  return {
    ...applicationPlan,
    modifiedFiles: [...new Set([...foundation.modifiedFiles, ...applicationPlan.modifiedFiles])],
    assumptions: [...new Set([...(applicationPlan.assumptions ?? []), 'Verified deployment foundations are composed locally; Codex supplied only application-owned phases.'])],
    commands: combined.commands,
    revertCommands: combined.revertCommands,
    foundationComposition: { version: 1, mode: 'foundation-assisted', foundationIds: [...foundation.foundationIds] }
  }
}

function annotateCommand (item, foundations, catalogId, revert) {
  const phase = item.phase ?? (revert ? 'cleanup' : null)
  const owner = applicationOwnedCommand(item, revert) ? null : foundationOwnerForCommand(item, foundations, phase, revert)
  return {
    ...item,
    source: owner
      ? { type: 'verified-foundation', id: owner.id, version: owner.version }
      : { type: 'verified-application', id: catalogId, version: 1 }
  }
}

function foundationOwnerForCommand (item, foundations, phase, revert) {
  const preferred = revert
    ? 'safe-baseline-rollback'
    : /^(?:capture|capture-baseline|capture-and-prepare)/u.test(item.id)
      ? 'linux-baseline'
      : item.id === 'generate-credentials'
        ? 'host-generated-credentials'
        : item.id === 'install-packages'
          ? 'linux-php-fpm-socket'
          : item.id === 'prepare-database'
            ? foundations.some(value => value.id.includes('postgresql')) ? 'linux-postgresql' : 'linux-mariadb'
            : item.id === 'configure-php-fpm'
              ? 'linux-php-fpm-socket'
              : item.id === 'configure-nginx'
                ? 'linux-nginx-site'
                : item.id === 'prepare-docker'
                  ? foundations.find(value => /(?:docker|colima)-.*readiness|colima-compose/u.test(value.id))?.id
                  : null
  return foundations.find(value => value.id === preferred) ?? foundations.find(value => value.phases.includes(phase))
}

function applicationOwnedCommand (item, revert) {
  if (revert) return false
  return !/^(?:capture|capture-baseline|capture-and-prepare|prepare-docker|install-packages|generate-credentials|prepare-database|configure-php-fpm|configure-nginx)(?:$|-)/u.test(item.id)
}

function requireSource (item, type) {
  if (item?.source?.type !== type || typeof item.source.id !== 'string' || !Number.isInteger(item.source.version)) throw new Error(`composed foundation command ${item?.id ?? '<unknown>'} requires verified provenance`)
  const foundation = getDeploymentFoundation(item.source.id)
  if (foundation.version !== item.source.version) throw new Error(`unsupported foundation version for ${item.source.id}`)
  return { ...item, source: { ...item.source } }
}

function validateRevertSource (item) {
  if (item.source.type === 'verified-foundation') requireSource(item, 'verified-foundation')
  else if (!['verified-application', 'ai-planned'].includes(item.source.type)) throw new Error(`revert command ${item.id} has invalid provenance`)
  return { ...item, source: { ...item.source } }
}

function validateGraph (items, name) {
  const preceding = new Set()
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || preceding.has(item.id)) throw new Error(`${name} contains duplicate or invalid command ids`)
    if (!Array.isArray(item.dependsOn) || item.dependsOn.some(id => !preceding.has(id))) throw new Error(`${name} contains an invalid dependency graph`)
    preceding.add(item.id)
  }
}

function normalizeDependencies (items) {
  const preceding = new Set()
  return items.map(item => {
    const value = { ...item, dependsOn: (item.dependsOn ?? []).filter(id => preceding.has(id)) }
    preceding.add(item.id)
    return value
  })
}

function linkFirstDependency (items, dependency) {
  if (!dependency || items.length === 0) return items.map(item => ({ ...item, dependsOn: [...(item.dependsOn ?? [])] }))
  return items.map((item, index) => ({ ...item, dependsOn: index === 0 ? [...new Set([dependency, ...(item.dependsOn ?? [])])] : [...(item.dependsOn ?? [])] }))
}

function foundation (id, platform, phases, capabilities, extensionPoints, expectedOutputs, rollbackGuarantee, options = {}) {
  return Object.freeze({ id, version: 1, platform, phases: Object.freeze(phases), capabilities, extensionPoints: Object.freeze(extensionPoints), expectedOutputs: Object.freeze(expectedOutputs), verification: 'Bounded positive evidence is required before the phase is considered complete.', rollbackGuarantee, runtime: options.runtime ?? null })
}

function runtimePreconditions (foundation, docker) {
  if (!foundation.runtime) return ['Eligible managed-host platform and root Stage 2 identity.']
  return [docker.ready ? `${foundation.runtime} runtime is ready.` : `${foundation.runtime} runtime must be installed by an eligible reviewed bootstrap.`, 'Host container-runtime preference must not be disabled.']
}

function copyFoundation (value) {
  return { ...value, phases: [...value.phases], extensionPoints: [...value.extensionPoints], expectedOutputs: [...value.expectedOutputs] }
}
