import { parseSshConnection } from './connection.js'
import { PLUGIN_VERSION } from './plugin-version.js'
import { PRODUCT_NAME } from './product.js'

export function mainActionOptions ({ hostCount, clusterCount = 0, recentServerId }) {
  const actions = []
  if (recentServerId) actions.push({ label: `Reconnect to ${recentServerId}`, value: `host:${recentServerId}` })
  if (hostCount > 0) actions.push({ label: `Browse/search hosts (${hostCount})`, value: 'browse-hosts', focusRows: true })
  if (hostCount > 1) actions.push({ label: 'Run one task on multiple hosts', value: 'multi-task' })
  if (hostCount > 1) actions.push({ label: 'Install/update plugin on multiple hosts', value: 'multi-plugin' })
  if (clusterCount > 0) actions.push({ label: `Browse Kubernetes clusters (${clusterCount})`, value: 'browse-kubernetes' })
  actions.push({ label: 'Multi-host run history', value: 'multi-history' })
  actions.push({ label: 'Add host', value: 'add' })
  actions.push({ label: 'Temporarily add host (removed on exit)', value: 'add-temporary' })
  actions.push({ label: 'Add Kubernetes cluster', value: 'add-kubernetes' })
  actions.push({ label: 'Set default administrator email', value: 'application-defaults' })
  actions.push({ label: 'Change vault passphrase', value: 'change-passphrase' })
  actions.push({ label: 'Quit', value: 'quit' })
  return actions
}

export function connectedHostActionOptions ({ status, dockerPreference, temporary = false }) {
  return [
    { label: 'Refresh status', value: 'refresh' },
    { label: 'Activate Stage 2 (install Netdata if needed)', value: 'activate' },
    { label: 'Install/update plugin only (keep existing Netdata)', value: 'activate-plugin' },
    { label: 'Connect existing Netdata to Netdata Cloud', value: 'claim-cloud' },
    { label: 'Deactivate plugin and keep Netdata', value: 'deactivate', style: 'warning' },
    { label: `Remove plugin and ${PRODUCT_NAME}-managed Netdata`, value: 'remove', style: 'danger' },
    { label: `Set Docker preference (${dockerPreference})`, value: 'docker-preference' },
    { label: 'Set or clear saved SSH credential', value: 'ssh-credential' },
    ...(['freebsd', 'linux', 'macos', 'windows'].includes(status.capabilities.platform?.os)
      ? [{ label: 'Run a verified common task', value: 'common-application' }]
      : []),
    { label: 'Run an AI-assisted task', value: 'task' },
    { label: 'Task history and reverts', value: 'history' },
    { label: 'Open an interactive SSH shell', value: 'shell' },
    { label: 'Show server requirements', value: 'requirements' },
    { label: 'Switch to another host', value: 'switch' },
    { label: temporary ? 'Remove temporary host now (keep task history)' : 'Remove saved host connection (keep task history)', value: 'forget-host', style: 'danger' },
    { label: 'Disconnect', value: 'back' }
  ]
}

export function buildDashboardHostRow ({ serverId, configured, server, runtime = {}, platform = null, recent = false }) {
  const address = sanitizedSshDestination(server.connectionUrl)
  const state = runtime.state ?? 'not probed'
  const safeError = runtime.error ? String(runtime.error).replaceAll(/[\r\n]+/gu, ' ').slice(0, 300) : null
  return {
    value: serverId,
    serverId,
    address,
    authentication: authenticationLabel(server.authentication),
    savedCredential: Boolean(server.sshCredential),
    temporary: Boolean(server.temporary),
    desiredStage2: configured.desiredStage2,
    netdataOwnership: configured.netdataOwnership,
    runtime: state,
    platform: runtime.platform ?? platform ?? null,
    recent,
    error: safeError,
    searchText: [serverId, address, configured.desiredStage2, state, runtime.platform ?? platform].filter(Boolean).join(' ')
  }
}

export function dashboardHostRowText (row, { width = 50 } = {}) {
  if (!row) return ''
  if (width < 38) return `${clip(row.serverId, Math.max(4, width - row.runtime.length - 3))} [${row.runtime}]`
  if (width < 58) return `${padCell(row.serverId, 18)} ${clip(row.address, Math.max(4, width - 19))}`
  if (width < 76) return `${padCell(row.serverId, 18)} ${padCell(row.address, 26)} [${row.runtime}]`
  return `${padCell(row.serverId, 20)} ${padCell(row.address, 30)} ${padCell(row.desiredStage2, 10)} ${row.runtime}`
}

export function configuredHostDetailLines (row) {
  if (!row) return ['Select a host to view its configured details.']
  return [
    `Host: ${row.serverId}`,
    `Address: ${row.address}`,
    `Authentication: ${row.authentication}`,
    `Saved SSH credential: ${row.savedCredential ? 'vault encrypted' : 'not saved'}`,
    `Persistence: ${row.temporary ? 'current process only (history retained)' : 'saved'}`,
    `Desired Stage 2: ${row.desiredStage2}`,
    `Netdata ownership: ${row.netdataOwnership}`,
    `Runtime: ${row.runtime}`,
    ...(row.platform ? [`Platform: ${row.platform}`] : []),
    ...(row.recent ? ['Recent host: yes'] : []),
    ...(row.error ? [`Current error: ${row.error}`] : [])
  ]
}

export function connectedHostDetailLines (serverId, configured, status) {
  const lines = [
    `SSH: ${status.connected ? 'connected' : 'error'}`
  ]
  if (status.capabilities.platform) lines.push(`Platform: ${status.capabilities.platform.system} ${status.capabilities.platform.machine}`)
  lines.push(`Remote user: ${status.capabilities.platform?.os === 'windows'
    ? (status.capabilities.isAdministrator ? 'Windows administrator' : 'Windows standard user')
    : (status.capabilities.isRoot ? 'root' : `uid ${status.capabilities.uid ?? 'unknown'}`)}`)
  lines.push(`Privilege: ${privilegeLabel(status.capabilities)}`)
  lines.push(`Host environment: ${status.docker?.hostIsContainer ? `${status.docker.containerRuntime ?? 'container'} container` : 'non-container host'}`)
  const runtimeLabel = status.docker?.platform === 'freebsd' ? 'Podman' : status.docker?.platform === 'macos' ? 'Colima/Docker' : 'Docker'
  lines.push(`${runtimeLabel}: ${dockerStatusLabel(status.docker)}`)
  lines.push(`Docker preference: ${status.docker?.preference ?? 'auto'} - ${status.docker?.preferred ? 'preferred' : 'not preferred'}`)
  if (status.docker?.virtualizationRequired) {
    lines.push(`Container virtualization: ${status.docker.virtualizationAvailable ? 'available' : 'unavailable'}`)
    if (!status.docker.virtualizationAvailable && status.docker.virtualizationInstructions) lines.push(`Container guidance: ${status.docker.virtualizationInstructions}`)
  } else if (status.docker) {
    lines.push('Container virtualization: not required')
  }
  if (status.linuxContext?.identity) {
    const identity = status.linuxContext.identity
    const profile = identity.prettyName || [identity.name, identity.versionId].filter(Boolean).join(' ')
    const management = status.linuxContext.management
    lines.push(`Linux profile: ${profile || identity.id} - ${identity.architecture || 'unknown architecture'}`)
    lines.push(`Host management: ${management?.packageManager ?? 'unknown packages'} / ${management?.serviceManager ?? 'unknown services'}`)
    lines.push(`Profile source: ${status.linuxContext.officialSources?.release?.status === 'online' ? `Netdata + official ${identity.id} source` : 'Netdata + cached/local detection'}`)
  }
  lines.push(`Netdata: ${status.capabilities.hasNetdata ? 'installed' : 'not installed'}`)
  lines.push(`Netdata Cloud: ${status.cloud.claimed ? `connected (${status.cloud.status})` : `${status.cloud.status}${status.cloud.reason ? ` - ${status.cloud.reason}` : ''}`}`)
  lines.push(`curl: ${status.capabilities.hasCurl ? 'available' : 'missing'}`)
  lines.push(`${PRODUCT_NAME} plugin: ${pluginStatusLabel(status)}`)
  lines.push(`Stage 2 health: ${status.observed.status}`)
  lines.push(`Netdata ownership: ${configured.netdataOwnership}`)
  lines.push(`Command identity: ${status.observed.executionIdentity === 'root'
    ? 'root (token-authenticated plugin)'
    : status.observed.executionIdentity === 'system'
      ? 'LocalSystem (token-authenticated plugin)'
      : 'privileged execution unavailable'}`)
  if (status.error) lines.push(`Current error: ${status.error}`)
  return lines
}

export function sanitizedSshDestination (connectionUrl) {
  const connection = parseSshConnection(connectionUrl)
  const host = connection.host.startsWith('[') ? connection.host : connection.host.includes(':') ? `[${connection.host}]` : connection.host
  const target = connection.username ? `${connection.username}@${host}` : host
  return connection.port === 22 ? target : `${target}:${connection.port}`
}

export function privilegeLabel (capabilities) {
  if (capabilities.platform?.os === 'windows') return capabilities.isAdministrator ? 'Windows administrator' : 'no administrative elevation'
  if (capabilities.isRoot) return 'root'
  if (capabilities.hasPasswordlessSudo) return 'passwordless sudo'
  if (capabilities.hasPasswordlessDoas) return 'passwordless doas'
  if (capabilities.hasSudo) return 'sudo password required'
  return 'no administrative elevation'
}

export function dockerStatusLabel (docker) {
  if (!docker) return 'unknown'
  if (docker.ready) return `ready (${docker.composeCommand ?? 'Compose'})`
  if (docker.virtualizationRequired && !docker.virtualizationAvailable) return 'virtualization unavailable (run the container-runtime prerequisite for instructions)'
  if (docker.installSupported) return `supported (setup required via ${docker.installMethod ?? 'host packages'})`
  if (!docker.cliAvailable) return 'not installed'
  if (!docker.daemonReachable) return 'daemon unavailable'
  if (!docker.composeAvailable) return 'Compose unavailable'
  return 'unavailable'
}

function pluginStatusLabel (status) {
  const remotePluginVersion = status.observed.health?.version
  if (remotePluginVersion) return `v${remotePluginVersion}${remotePluginVersion === PLUGIN_VERSION ? ' (current)' : ` (bundled v${PLUGIN_VERSION})`}`
  return status.capabilities.hasStage2Runner ? `unavailable (bundled v${PLUGIN_VERSION})` : `not installed (bundled v${PLUGIN_VERSION})`
}

function authenticationLabel (value) {
  if (value === 'key') return 'key or ssh-agent'
  if (value === 'password') return 'OpenSSH password prompt'
  return 'automatic OpenSSH selection'
}

function padCell (value, width) {
  return clip(value, width).padEnd(width)
}

function clip (value, width) {
  const text = String(value ?? '')
  const characters = Array.from(text)
  if (characters.length <= width) return text
  if (width <= 1) return '…'.slice(0, width)
  return `${characters.slice(0, width - 1).join('')}…`
}
