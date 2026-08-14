const DOCKER_PREFERENCES = new Set(['auto', 'enabled', 'disabled'])

export function normalizeDockerPreference (value) {
  const preference = value ?? 'auto'
  if (!DOCKER_PREFERENCES.has(preference)) {
    throw new TypeError('Docker preference must be auto, enabled, or disabled')
  }
  return preference
}

export function detectNetdataContainer (inventory) {
  const agents = Array.isArray(inventory?.info?.agents) ? inventory.info.agents : []
  for (const agent of agents) {
    const container = agent?.application?.container
    const runtime = typeof container === 'string'
      ? container
      : container?.container ?? container?.runtime ?? container?.name
    if (isContainerRuntime(runtime)) return String(runtime).toLowerCase()
  }
  return null
}

/**
 * @param {{preference?: string, capability?: Record<string, any>, inventory?: any}} [options]
 */
export function resolveDockerPolicy ({ preference = 'auto', capability = {}, inventory } = {}) {
  preference = normalizeDockerPreference(preference)
  const inventoryRuntime = detectNetdataContainer(inventory)
  const capabilityRuntime = isContainerRuntime(capability.containerRuntime)
    ? String(capability.containerRuntime).toLowerCase()
    : null
  const containerRuntime = inventoryRuntime ?? capabilityRuntime
  const hostIsContainer = Boolean(containerRuntime || capability.hostIsContainer)
  const cliAvailable = capability.cliAvailable === true
  const daemonReachable = capability.daemonReachable === true
  const composeAvailable = capability.composeAvailable === true
  const ready = cliAvailable && daemonReachable && composeAvailable
  const installSupported = capability.installSupported === true
  const installationSupportedPlatform = !capability.platform || capability.platform === 'linux' || (['windows', 'freebsd', 'macos'].includes(capability.platform) && installSupported)
  const serviceSupportedPlatform = installationSupportedPlatform || capability.platform === 'windows'
  const capable = ready || (installationSupportedPlatform && installSupported)

  let preferred = false
  let reason
  if (preference === 'disabled') {
    reason = 'disabled by host preference'
  } else if (preference === 'enabled') {
    preferred = ready || installationSupportedPlatform
    reason = preferred
      ? (ready ? 'enabled by host preference' : 'enabled by host preference; Docker setup is required')
      : 'Docker is not ready and no reviewed setup route is available on this platform'
  } else if (hostIsContainer) {
    reason = `automatic Docker use is disabled because this host is a ${containerRuntime ?? 'container'}`
  } else if (!serviceSupportedPlatform) {
    reason = 'automatic Docker service deployment is unavailable on this platform'
  } else if (!ready && installSupported) {
    preferred = true
    reason = 'Docker Compose is supported on this host; setup is required'
  } else if (!cliAvailable) {
    reason = 'Docker is not installed and no supported installation route was detected'
  } else if (!daemonReachable) {
    reason = 'the Docker daemon is not reachable'
  } else if (!composeAvailable) {
    reason = 'Docker Compose is not available'
  } else if (ready) {
    preferred = true
    reason = 'Docker Compose is available on a non-container host'
  } else {
    reason = 'Docker is not ready and no reviewed setup route is available on this platform'
  }

  return {
    platform: capability.platform ?? null,
    preference,
    preferred,
    ready,
    capable,
    installSupported,
    setupRequired: preferred && !ready,
    installMethod: capability.installMethod ?? null,
    reason,
    hostIsContainer,
    containerRuntime,
    cliAvailable,
    daemonReachable,
    composeAvailable,
    composeCommand: capability.composeCommand ?? null,
    virtualizationRequired: capability.virtualizationRequired === true,
    virtualizationAvailable: capability.virtualizationAvailable !== false,
    virtualizationInstructions: capability.virtualizationInstructions ?? null
  }
}

function isContainerRuntime (value) {
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return normalized !== '' && !['none', 'unknown', 'host', 'bare-metal', 'physical'].includes(normalized)
}
