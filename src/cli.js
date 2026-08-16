import { access, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildCandidatePlanningContext, buildCommonTask, listEligibleCommonTasks } from './common-tasks.js'
import { isSystemUpdateTask, systemUpdateProfile } from './system-update-task.js'
import { parseSshConnection } from './connection.js'
import { VaultAuthenticationError } from './crypto-vault.js'
import { resolveDockerPolicy } from './docker-policy.js'
import { formatDiagnosticError, redactDiagnosticText } from './error-details.js'
import { HostSessionFactory } from './host-session-factory.js'
import { KubernetesClient } from './kubernetes-client.js'
import { KubernetesNetdataClient } from './kubernetes-netdata-client.js'
import { KubernetesStage2Service } from './kubernetes-stage2-service.js'
import { rootExecutionPolicy } from './execution-policy.js'
import { parseClaimingInput, validateClaimDetails } from './netdata-claim.js'
import { MultiHostRunStore } from './multi-host-run-store.js'
import { MultiHostService, parallelMap } from './multi-host-service.js'
import { PLUGIN_VERSION } from './plugin-version.js'
import { detectPersistedPlatform } from './platform-identity.js'
import { parseSshCommand } from './ssh-command.js'
import { ServerWorkspace } from './server-workspace.js'
import { validateServerId } from './server-id.js'
import { SettingsStore } from './settings-store.js'
import { Stage2Service } from './stage2-service.js'
import { SystemSsh } from './system-ssh.js'
import { updateIntentAiOps } from './self-update.js'
import { TerminalUi } from './terminal-ui.js'
import { FALLBACK_ADMIN_EMAIL, normalizeAdminEmailPreset } from './application-defaults.js'
import { CLI_NAME, DATA_DIRECTORY_NAME, LEGACY_DATA_DIRECTORY_NAME, PRODUCT_NAME, PRODUCT_TAGLINE, PRODUCT_URL } from './product.js'
import { hostHealthProfile, isHostHealthTask } from './host-health-task.js'
import {
  buildDashboardHostRow,
  configuredHostDetailLines,
  connectedHostActionOptions,
  connectedHostDetailLines,
  dashboardHostRowText,
  mainActionOptions
} from './cli-display.js'
import {
  catalogChoiceRows,
  cleanupHostIds,
  failedMultiHostIds,
  multiHostHistoryActions,
  multiHostHistoryRows,
  multiHostHistoryRowText,
  multiHostRunDetailLines,
  routingSummaryRows,
  retryCleanupSucceeded,
  taskDetailLines,
  taskHistoryActions,
  taskHistoryLabel,
  taskHistoryRows,
  taskHistoryRowText
} from './cli-workflow-display.js'

const VAULT_PASSPHRASE_GUIDANCE = 'Use at least 12 characters; prefer five or more random words or 20+ password-manager-generated characters.'

export async function runCli ({ argv = process.argv.slice(2), input, output, selfUpdate = updateIntentAiOps } = {}) {
  const cliOptions = parseArguments(argv)
  const ui = new TerminalUi({ input, output })
  try {
    return await runCliSession({ cliOptions, ui, selfUpdate })
  } finally {
    ui.dispose()
  }
}

async function runCliSession ({ cliOptions, ui, selfUpdate }) {
  if (cliOptions.help) {
    printHelp(ui)
    return
  }
  if (cliOptions.update) {
    ui.info(`Updating ${PRODUCT_NAME} from the official repository...`)
    await selfUpdate()
    ui.success(`${PRODUCT_NAME} was updated successfully. Run ${CLI_NAME} again to start the new version.`)
    return
  }
  if (!ui.input.isTTY || !ui.output.isTTY) {
    throw new Error(`${CLI_NAME} is an interactive CLI and requires a TTY`)
  }

  const dataRoot = path.resolve(cliOptions.dataRoot ?? await resolveDefaultDataRoot(os.homedir()))
  const settingsStore = new SettingsStore(dataRoot)
  const baseSsh = new SystemSsh()
  const unlocked = await unlock(ui, settingsStore)
  const settings = unlocked.settings
  const directoryAliases = new Map(Object.entries(settings.servers).map(([serverId, server]) => [serverId, server.historyId ?? serverId]))
  const workspace = new ServerWorkspace(dataRoot, { directoryAliases })
  let passphrase = unlocked.passphrase
  let applicationDefaults = await settingsStore.decryptApplicationDefaults({ settings, passphrase })
  const hostRuntime = new Map()
  const hostSessions = new HostSessionFactory({
    dataRoot,
    settingsStore,
    workspace,
    baseSsh,
    debug: cliOptions.debug,
    onWarning: message => ui.warn(redactDiagnosticText(message)),
    onDebug: (serverId, event) => renderDebugEvent(ui, { phase: `${serverId}:${event.phase}`, message: event.message })
  })
  const context = {
    ui,
    settingsStore,
    workspace,
    baseSsh,
    settings,
    hostRuntime,
    hostSessions,
    directoryAliases,
    get applicationDefaults () { return applicationDefaults },
    set applicationDefaults (value) { applicationDefaults = value },
    get passphrase () { return passphrase }
  }
  let recentServerId = null
  let selectedHostId = null

  for (;;) {
    const serverIds = Object.keys(settings.servers).sort()
    const clusterIds = Object.keys(settings.clusters ?? {}).sort()
    const activeHosts = serverIds.filter(serverId => settings.servers[serverId].desiredStage2 === 'active').length
    const hostRows = await buildDashboardHostRows({ context, serverIds, recentServerId })
    const menuOptions = mainActionOptions({
      hostCount: serverIds.length,
      clusterCount: clusterIds.length,
      recentServerId: recentServerId && settings.servers[recentServerId] ? recentServerId : null
    })
    const selection = await ui.searchableSplitChoose({
      title: '',
      summaryLines: [
        `Data directory: ${dataRoot}`,
        ui.styleTokens(`Hosts: ${serverIds.length} | Stage 2 desired: ${activeHosts} active / ${serverIds.length - activeHosts} inactive`, [
          { text: `${activeHosts} active`, style: 'success' },
          { text: `${serverIds.length - activeHosts} inactive`, style: serverIds.length - activeHosts > 0 ? 'warning' : 'muted' }
        ]),
        `Kubernetes clusters: ${clusterIds.length}`,
        applicationDefaults.adminEmail
          ? `Default administrator email: ${applicationDefaults.adminEmail}`
          : ui.styleToken(`Default administrator email: ${FALLBACK_ADMIN_EMAIL}`, FALLBACK_ADMIN_EMAIL, 'warning')
      ],
      actions: menuOptions,
      rows: hostRows,
      rowSearchText: row => row.searchText,
      renderRow: (row, options) => ui.styleToken(dashboardHostRowText(row, options), row.runtime, ui.statusStyle(row.runtime)),
      renderDetails: row => configuredHostDetailLines(row),
      initialRow: selectedHostId ?? recentServerId,
      emptyMessage: 'No hosts configured.\nAdd a host or a temporary host to begin.',
      footerHints: ['Tab pane', 'Up/Down select', 'Enter open', '/ search', 'Esc back', 'q quit']
    })
    if (!selection) continue
    if (selection.type === 'quit') return
    const selected = selection.type === 'row' ? `host:${selection.value}` : selection.value
    if (selected === 'quit') return
    if (selected === 'change-passphrase') {
      const changed = await changeVaultPassphrase({ ui, settingsStore, settings, passphrase })
      if (changed) passphrase = changed
      continue
    }
    if (selected === 'application-defaults') {
      context.applicationDefaults = await setApplicationDefaults({ context })
      continue
    }
    if (selected === 'add') {
      const added = await addHost({ context, temporary: false })
      if (added) selectedHostId = added
      continue
    }
    if (selected === 'add-temporary') {
      const added = await addHost({ context, temporary: true })
      if (added) selectedHostId = added
      continue
    }
    if (selected === 'add-kubernetes') {
      await addKubernetesCluster({ context })
      continue
    }
    if (selected === 'browse-kubernetes') {
      await browseKubernetesClusters({ context })
      continue
    }
    if (selected === 'multi-task') {
      await runMultiHostTaskMenu({ context, serverIds, debug: cliOptions.debug })
      continue
    }
    if (selected === 'multi-history') {
      await browseMultiHostHistory({ context, debug: cliOptions.debug })
      continue
    }
    if (selected === 'multi-plugin') {
      await updatePluginFleet({ context, serverIds, debug: cliOptions.debug })
      continue
    }
    let serverId = selected === 'browse-hosts'
      ? selectedHostId ?? serverIds[0] ?? null
      : selected.startsWith('host:') ? selected.slice(5) : null
    while (serverId) {
      recentServerId = serverId
      selectedHostId = serverId
      hostRuntime.set(serverId, { state: 'connecting' })
      const action = await runConnectedHostSession({
        context,
        debug: cliOptions.debug,
        serverId
      })
      if (action !== 'switch') break
      serverId = await chooseHost(ui, serverIds, settings, serverId)
    }
  }
}

async function setApplicationDefaults ({ context }) {
  const { ui, settingsStore, settings, passphrase } = context
  ui.clear()
  ui.banner('Application defaults')
  const current = context.applicationDefaults.adminEmail
  ui.line('Stored administrator email', current ?? 'not set')
  ui.line('Effective administrator email', current ?? `${FALLBACK_ADMIN_EMAIL} (non-deliverable fallback)`, current ? undefined : 'warning')
  ui.line('Storage', 'vault encrypted', 'success')
  ui.separator()
  for (const line of ui.wrapText('Verified application tasks use this value when they need an initial administrator or contact email. Relevant AI-planned tasks receive the same application preference.', ui.terminalSize().width)) {
    ui.output.write(`${line}\n`)
  }
  ui.output.write('\n')
  const answer = await ui.ask('Administrator email (- clears, /back cancels)', {
    defaultValue: current ?? undefined,
    required: false
  })
  if (answer.toLocaleLowerCase() === '/back') return context.applicationDefaults
  try {
    const adminEmail = normalizeAdminEmailPreset(answer)
    const defaults = await settingsStore.setApplicationDefaults({
      settings,
      passphrase,
      defaults: { adminEmail }
    })
    ui.success(adminEmail
      ? `Default administrator email set to ${adminEmail}.`
      : `Preset cleared; verified tasks will use ${FALLBACK_ADMIN_EMAIL}.`)
    await ui.pause()
    return defaults
  } catch (error) {
    ui.error(`Could not save application defaults: ${error.message}`)
    await ui.pause()
    return context.applicationDefaults
  }
}

export async function buildDashboardHostRows ({ context, serverIds, recentServerId = null }) {
  const { settingsStore, settings, passphrase, workspace, hostRuntime = new Map() } = context
  const rows = []
  for (const serverId of [...serverIds].sort()) {
    const configured = settings.servers[serverId]
    try {
      const server = await settingsStore.decryptServer({ settings, passphrase, serverId })
      const platform = await loadPlatformHint(workspace, serverId)
      rows.push(buildDashboardHostRow({
        serverId,
        configured,
        server,
        runtime: hostRuntime.get(serverId),
        platform,
        recent: serverId === recentServerId
      }))
    } catch (error) {
      rows.push({
        value: serverId,
        serverId,
        address: 'unavailable',
        authentication: 'unavailable',
        desiredStage2: configured.desiredStage2,
        netdataOwnership: configured.netdataOwnership,
        runtime: 'error',
        platform: null,
        recent: serverId === recentServerId,
        error: redactDiagnosticText(error.message),
        searchText: `${serverId} ${configured.desiredStage2} error`
      })
    }
  }
  return rows
}

async function selectConfiguredHosts ({ context, serverIds, title, initialValues = [] }) {
  const rows = await buildDashboardHostRows({ context, serverIds })
  return context.ui.searchableMultiChoose(title, rows.map(row => ({
    value: row.serverId,
    label: `${row.serverId}  ${row.address}  Stage 2 ${row.desiredStage2}${row.platform ? `  ${row.platform}` : ''}`,
    searchText: [row.serverId, row.address, row.desiredStage2, row.platform].filter(Boolean).join(' ')
  })), {
    initialValues,
    resultLabel: 'hosts'
  })
}

async function chooseHost (ui, serverIds, settings, currentServerId) {
  const choices = serverIds
    .filter(serverId => serverId !== currentServerId)
    .map(serverId => ({
      label: `${serverId}  [Stage 2 ${settings.servers[serverId].desiredStage2}]`,
      value: serverId
    }))
  if (choices.length === 0) return null
  ui.clear()
  ui.banner('Host browser')
  return ui.searchChoose('Choose a host', choices)
}

export async function changeVaultPassphrase ({ ui, settingsStore, settings, passphrase }) {
  ui.clear()
  ui.banner('Change vault passphrase')
  ui.line('Storage', 'vault encrypted')
  ui.line('Host secrets', Object.keys(settings.servers).length)
  ui.separator()
  ui.info('Leave the new passphrase blank to return without changing the vault.')
  const next = await ui.secret('New vault passphrase')
  if (!next) return null
  if (next.length < 12) {
    ui.warn(VAULT_PASSPHRASE_GUIDANCE)
    await ui.pause()
    return null
  }
  const confirmation = await ui.secret('Confirm new vault passphrase')
  if (!confirmation) return null
  if (confirmation !== next) {
    ui.error('The passphrases do not match.')
    await ui.pause()
    return null
  }
  try {
    await settingsStore.changePassphrase({
      settings,
      currentPassphrase: passphrase,
      newPassphrase: next
    })
    ui.success('Vault passphrase changed and every host and Kubernetes cluster secret was re-encrypted.')
    await ui.pause()
    return next
  } catch (error) {
    ui.error(`Could not change vault passphrase: ${error.message}`)
    await ui.pause()
    return null
  }
}

export async function unlock (ui, settingsStore) {
  ui.clear()
  ui.banner(PRODUCT_TAGLINE)
  let settings
  let created = false
  try {
    await access(settingsStore.settingsPath)
    settings = await settingsStore.load()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    ui.info(`Creating settings at ${settingsStore.settingsPath}`)
    settings = await settingsStore.initialize()
    created = true
  }

  ui.line('Data directory', settingsStore.dataRoot)
  ui.line('Settings', created ? 'new' : 'existing')
  ui.separator()
  ui.info(VAULT_PASSPHRASE_GUIDANCE)

  const needsInitialization = created || settingsStore.vaultNeedsInitialization?.(settings) === true

  let lastAuthenticationError
  for (let attempt = 1; attempt <= 3; attempt++) {
    ui.line('Attempt', `${attempt} of 3`)
    const passphrase = await ui.secret('Vault passphrase')
    if (passphrase.length < 12) {
      ui.warn(VAULT_PASSPHRASE_GUIDANCE)
      continue
    }
    if (needsInitialization) {
      const confirmation = await ui.secret('Confirm vault passphrase')
      if (confirmation !== passphrase) {
        ui.error('The passphrases do not match.')
        continue
      }
    }
    try {
      if (needsInitialization) {
        await settingsStore.initializeVault({ settings, passphrase })
      } else {
        const result = await settingsStore.unlockVault({ settings, passphrase })
        if (result.migrated) ui.success(`Vault encryption upgraded to ${result.kdf}.`)
      }
      return { settings, passphrase }
    } catch (error) {
      if (!(error instanceof VaultAuthenticationError)) throw error
      lastAuthenticationError = error
      ui.error('The vault passphrase is incorrect.')
    }
  }
  throw new Error('unable to unlock the vault', { cause: lastAuthenticationError })
}

export async function addHost ({ context, temporary = false }) {
  const { ui, settingsStore, workspace, baseSsh, settings, passphrase } = context
  ui.clear()
  ui.banner(temporary ? 'Temporarily add host' : 'Add host')
  ui.output.write('1. Host name\n2. SSH destination\n3. Authentication\n4. Connection test and fingerprint\n5. Optional encrypted credential\n')
  ui.separator()
  ui.info('Leave the host name or SSH destination blank to return to the dashboard.')
  if (temporary) ui.info(`This connection is removed when ${PRODUCT_NAME} exits; fingerprint-associated task history is retained.`)
  const serverId = await ui.ask('Host name (lowercase letters, numbers, _ or -)', { required: false })
  if (!serverId) return null
  try {
    validateServerId(serverId)
    if (settings.servers[serverId]) throw new Error(`host already exists: ${serverId}`)
  } catch (error) {
    ui.error(error.message)
    await ui.pause()
    return
  }
  const command = await ui.ask('SSH command or ssh:// URL', { required: false })
  if (!command) return null
  let connectionUrl
  try {
    connectionUrl = parseSshCommand(command)
  } catch (error) {
    ui.error(error.message)
    await ui.pause()
    return
  }
  const authentication = await ui.choose('How should OpenSSH authenticate?', [
    { label: 'SSH key or ssh-agent', value: 'key' },
    { label: 'Password (prompted by OpenSSH; never stored)', value: 'password' },
    { label: 'Automatic OpenSSH selection', value: 'auto' },
    { label: 'Cancel and return to dashboard', value: null }
  ])
  if (authentication === null) return null

  ui.info('Testing the connection. OpenSSH may ask to trust the host and request a password or key passphrase.')
  let session
  let hostFingerprint
  try {
    session = await baseSsh.openInteractiveSession(connectionUrl, { authentication })
    const check = await session.ssh.execute(connectionUrl, 'echo WEBMINAI_SSH_OK')
    if (check.stdout.trim() !== 'WEBMINAI_SSH_OK') throw new Error('unexpected SSH test response')
    hostFingerprint = await session.ssh.hostFingerprint(connectionUrl)
    ui.success('SSH connection succeeded.')
  } catch (error) {
    ui.error(`SSH test failed: ${error.message}`)
    await ui.pause()
    return
  } finally {
    await session?.close()
  }

  const credentialMode = await ui.choose(`Should ${PRODUCT_NAME} save an SSH password or private-key passphrase?`, [
    { label: 'Do not save an SSH credential', value: 'none' },
    { label: 'Save it encrypted with the vault passphrase', value: 'save' },
    { label: 'Cancel without adding the host', value: null }
  ])
  if (credentialMode === null) return null
  const sshCredential = credentialMode === 'save'
    ? await ui.secret('SSH password or private-key passphrase (blank cancels)')
    : null
  if (credentialMode === 'save' && !sshCredential) return null

  try {
    const add = temporary
      ? settingsStore.addTemporaryServer.bind(settingsStore)
      : settingsStore.addServer.bind(settingsStore)
    const entry = await add({
      settings,
      passphrase,
      serverId,
      connectionUrl,
      authentication,
      sshCredential,
      hostFingerprint
    })
    workspace.setDirectoryAlias(serverId, entry.historyId)
    await workspace.ensureInitialized(serverId, rootExecutionPolicy({
      maxCommands: 20,
      maxTimeoutMs: 300000,
      deniedPatterns: []
    }))
    ui.success(temporary
      ? `Temporary host ${serverId} was added for this process; its task history is associated with its stable fingerprint.`
      : `Host ${serverId} was saved and associated with its stable fingerprint.`)
    ui.info(sshCredential ? 'The SSH credential is vault encrypted.' : 'No SSH credential was saved.')
    await ui.pause()
    return serverId
  } catch (error) {
    ui.error(`Could not add host: ${error.message}`)
  }
  await ui.pause()
  return null
}

export async function addKubernetesCluster ({ context }) {
  const { ui, settingsStore, settings, passphrase } = context
  ui.clear()
  ui.banner('Add Kubernetes cluster')
  ui.output.write('1. Cluster name\n2. Kubeconfig source\n3. Kubernetes API test\n4. Encrypted save\n')
  ui.separator()
  ui.info('The kubeconfig may be pasted as hidden YAML or read from a local file. Leave the cluster name blank to return.')

  const clusterId = await ui.ask('Cluster name (lowercase letters, numbers, _ or -)', { required: false })
  if (!clusterId) return null
  try {
    validateServerId(clusterId)
    if (settings.servers[clusterId] || settings.clusters?.[clusterId]) throw new Error(`target already exists: ${clusterId}`)
  } catch (error) {
    ui.error(error.message)
    await ui.pause()
    return null
  }

  const sourceMode = await ui.choose('How should the kubeconfig be provided?', [
    { label: 'Paste kubeconfig YAML (hidden)', value: 'paste' },
    { label: 'Read kubeconfig from a local path', value: 'path' },
    { label: 'Cancel and return to dashboard', value: null }
  ])
  if (sourceMode === null) return null

  let kubeconfig
  try {
    if (sourceMode === 'paste') {
      kubeconfig = await ui.secretEditor('Paste Kubernetes kubeconfig', {
        introLines: [
          'Paste the complete YAML, including embedded certificate and authentication data.',
          'Press Ctrl+D when finished. The pasted value is not displayed or added to prompt history.'
        ]
      })
    } else {
      const kubeconfigPath = await ui.ask('Local kubeconfig path (blank cancels)', { required: false })
      if (!kubeconfigPath) return null
      kubeconfig = await readFile(resolveLocalPath(kubeconfigPath), 'utf8')
    }
    if (!kubeconfig) return null
  } catch (error) {
    ui.error(`Could not read kubeconfig: ${error.message}`)
    await ui.pause()
    return null
  }

  ui.info('Validating kubeconfig and testing direct Kubernetes API access...')
  try {
    const kubernetes = createKubernetesClient(context, kubeconfig)
    const [version, nodes] = await Promise.all([kubernetes.version(), kubernetes.nodes()])
    const apiServer = kubernetes.server.origin
    const contextName = kubernetes.contextName || kubernetes.clusterName || clusterId
    ui.success('Kubernetes API connection succeeded.')
    ui.line('Context', contextName)
    ui.line('API server', apiServer)
    ui.line('Kubernetes', version.gitVersion ?? 'available')
    ui.line('Nodes', String(nodes.items?.length ?? 0))
    ui.line('Storage', 'vault encrypted')
    ui.separator()
    const save = await ui.confirm(`Save Kubernetes cluster ${clusterId}?`, false)
    if (!save) return null
    await settingsStore.addKubernetesCluster({
      settings,
      passphrase,
      clusterId,
      kubeconfig,
      apiServer,
      contextName
    })
    ui.success(`Kubernetes cluster ${clusterId} was saved.`)
    ui.info('Open Browse Kubernetes clusters to activate or update its Stage 2 gateway.')
    await ui.pause()
    return clusterId
  } catch (error) {
    ui.error(`Kubernetes connection failed: ${redactDiagnosticText(error.message)}`)
    await ui.pause()
    return null
  }
}

async function browseKubernetesClusters ({ context }) {
  const { ui, settingsStore, settings, passphrase } = context
  const clusterIds = Object.keys(settings.clusters ?? {}).sort()
  if (clusterIds.length === 0) {
    ui.warn('No Kubernetes clusters are configured.')
    await ui.pause()
    return
  }
  const options = []
  for (const clusterId of clusterIds) {
    try {
      const cluster = await settingsStore.decryptKubernetesCluster({ settings, passphrase, clusterId })
      options.push({
        value: clusterId,
        label: `${clusterId}  ${cluster.apiServer}  Stage 2 ${cluster.desiredStage2}`
      })
    } catch {
      options.push({ value: clusterId, label: `${clusterId}  [encrypted details unavailable]` })
    }
  }
  options.push({ value: null, label: 'Back to dashboard' })
  const clusterId = await ui.searchChoose('Kubernetes clusters', options)
  if (clusterId) await runConnectedKubernetesCluster({ context, clusterId })
}

async function runConnectedKubernetesCluster ({ context, clusterId }) {
  const { ui, settingsStore, settings, passphrase } = context
  const cluster = await settingsStore.decryptKubernetesCluster({ settings, passphrase, clusterId })
  const kubernetes = createKubernetesClient(context, cluster.kubeconfig)
  const stage2 = new KubernetesStage2Service({
    kubernetes,
    onProgress: event => ui.info(`[${event.phase}] ${event.message}`)
  })
  let status = await readKubernetesStatus({ kubernetes, cluster })

  for (;;) {
    const actions = [
      { label: 'Refresh status', value: 'refresh' },
      { label: 'Activate/update Stage 2 gateway', value: 'activate' },
      { label: 'Deactivate Stage 2 gateway', value: 'deactivate', style: 'warning' }
    ]
    if (status.stage2 === 'inactive') actions.push({ label: 'Remove saved cluster', value: 'remove', style: 'danger' })
    actions.push({ label: 'Back to dashboard', value: 'back' })
    const action = await ui.splitChoose({
      title: `${PRODUCT_NAME} / Kubernetes: ${clusterId}`,
      actions,
      details: [
        `Cluster: ${clusterId}`,
        `Context: ${cluster.contextName}`,
        `API server: ${cluster.apiServer}`,
        `Kubernetes: ${status.version}`,
        `Nodes: ${status.nodes}`,
        `Desired Stage 2: ${settings.clusters[clusterId].desiredStage2}`,
        `Stage 2 health: ${status.stage2}`,
        `Plugin: ${status.plugin}`
      ],
      footerHints: [['Up/Down', 'select'], ['Enter', 'open'], ['Esc', 'back']]
    })
    if (!action || action === 'back') return
    if (action === 'refresh') {
      ui.info('Refreshing Kubernetes API and Stage 2 status...')
      status = await readKubernetesStatus({ kubernetes, cluster })
      continue
    }
    if (action === 'activate') {
      const confirmed = await ui.confirm('Deploy or update the Stage 2 gateway directly through the Kubernetes API?', false)
      if (!confirmed) continue
      try {
        await stage2.activate({ actionKey: cluster.actionKey })
        await settingsStore.setKubernetesStage2State({ settings, clusterId, desired: 'active' })
        status = await readKubernetesStatus({ kubernetes, cluster })
        ui.success('Kubernetes Stage 2 gateway is active.')
      } catch (error) {
        ui.error(`Kubernetes Stage 2 activation failed: ${redactDiagnosticText(error.message)}`)
        await ui.pause()
      }
      continue
    }
    if (action === 'deactivate') {
      const confirmed = await ui.confirm('Remove the managed Kubernetes Stage 2 namespaces and RBAC resources?', false)
      if (!confirmed) continue
      try {
        await stage2.deactivate()
        await settingsStore.setKubernetesStage2State({ settings, clusterId, desired: 'inactive' })
        status = await readKubernetesStatus({ kubernetes, cluster })
        ui.success('Kubernetes Stage 2 gateway was removed.')
      } catch (error) {
        ui.error(`Kubernetes Stage 2 deactivation failed: ${redactDiagnosticText(error.message)}`)
        await ui.pause()
      }
      continue
    }
    if (action === 'remove') {
      const confirmed = await ui.confirm(`Forget Kubernetes cluster ${clusterId}? Stage 2 resources are already inactive.`, false)
      if (!confirmed) continue
      await settingsStore.removeKubernetesCluster({ settings, clusterId })
      ui.success(`Kubernetes cluster ${clusterId} was removed from the vault.`)
      await ui.pause()
      return
    }
  }
}

async function readKubernetesStatus ({ kubernetes, cluster }) {
  const [version, nodes] = await Promise.all([kubernetes.version(), kubernetes.nodes()])
  let health
  try {
    health = await new KubernetesNetdataClient({
      kubernetes,
      actionKey: cluster.actionKey
    }).health()
  } catch {
    health = null
  }
  return {
    version: version.gitVersion ?? 'available',
    nodes: String(nodes.items?.length ?? 0),
    stage2: health?.platform === 'kubernetes' ? 'active' : 'inactive',
    plugin: health?.version ? `v${health.version}` : 'not installed'
  }
}

function createKubernetesClient (context, kubeconfig) {
  return context.createKubernetesClient
    ? context.createKubernetesClient(kubeconfig)
    : KubernetesClient.fromKubeconfigSource(kubeconfig)
}

function resolveLocalPath (value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return path.resolve(value)
}

async function runMultiHostTaskMenu ({ context, serverIds, debug }) {
  const { ui, settingsStore, workspace, baseSsh, settings, passphrase, applicationDefaults } = context
  ui.clear()
  ui.banner('Parallel multi-host task')
  const selectedHosts = await selectConfiguredHosts({ context, serverIds, title: 'Select target hosts' })
  if (selectedHosts.length === 0) return
  const history = new MultiHostRunStore(settingsStore.dataRoot).list({ limit: 30 })
  let request = await ui.editor('Multi-host AI-assisted task', {
    history,
    introLines: [
      `Targets: ${selectedHosts.join(', ')}`,
      'Describe the task for every selected host.',
      'Prefix the request with ? to ask for advice without executing commands.'
    ]
  })
  if (!request) return
  const parsed = parseAiRequest(request)
  if (parsed.consultation) {
    if (!parsed.question) {
      ui.warn('Add a question after ? to start a consultation.')
      await ui.pause()
      return
    }
    await executeMultiHostConsultation({
      ui,
      settingsStore,
      workspace,
      baseSsh,
      settings,
      passphrase,
      debug,
      serverIds: selectedHosts,
      question: parsed.question,
      storedRequest: parsed.storedRequest
    })
    return
  }
  request = parsed.request
  await executeMultiHostRun({
    ui,
    settingsStore,
    workspace,
    baseSsh,
    settings,
    passphrase,
    debug,
    serverIds: selectedHosts,
    request,
    kind: 'ai',
    catalogId: null,
    applicationDefaults
  })
}

async function executeMultiHostConsultation ({
  ui,
  settingsStore,
  workspace,
  baseSsh,
  settings,
  passphrase,
  debug,
  serverIds,
  question,
  storedRequest
}) {
  ui.clear()
  ui.banner('Multi-host consultation')
  await withMultiHostAdmins({ ui, settingsStore, workspace, baseSsh, settings, passphrase, serverIds, debug }, async adminFor => {
    await parallelMap(serverIds, 4, async serverId => {
      let admin
      let task
      try {
        admin = await adminFor(serverId)
        const consultationContext = admin.listPendingConsultations(serverId)
        task = admin.createTask(serverId, storedRequest, {
          kind: 'consultation',
          consultationIds: consultationContext.map(item => item.id),
          consumeConsultations: false
        })
        ui.info(`[${serverId}] task #${task.id}: consulting; no command will execute`)
        const consultation = await admin.consult({
          settings,
          passphrase,
          serverId,
          question,
          consultationContext,
          onProgress: event => {
            admin.appendTaskProgress(serverId, task.id, event)
            renderMultiHostEvent(ui, { serverId, message: event.message })
          }
        })
        admin.saveConsultation(serverId, task.id, consultation)
        ui.heading(`${serverId} / consultation #${task.id}`)
        ui.output.write('Answer\n------\n')
        writeWrapped(ui, consultation.answer)
        ui.output.write('\nSaved context\n-------------\n')
        writeWrapped(ui, consultation.contextSummary)
        ui.separator()
        ui.success(`[${serverId}] completed`)
      } catch (error) {
        if (admin && task) admin.saveTaskError(serverId, task.id, error)
        ui.error(`[${serverId}] Consultation failed: ${error.message}`)
      }
    })
  })
  ui.info('Consultations were saved per host. No command was proposed, approved, or executed.')
  await ui.pause()
}

async function updatePluginFleet ({ context, serverIds, debug }) {
  const { ui, settingsStore, workspace, baseSsh, settings, passphrase } = context
  ui.clear()
  ui.banner(`Plugin v${PLUGIN_VERSION} fleet update`)
  const selectedHosts = await selectConfiguredHosts({ context, serverIds, title: `Plugin v${PLUGIN_VERSION} fleet targets` })
  if (selectedHosts.length === 0) return
  const sessions = []
  const ready = []
  const fleetRows = []
  try {
    for (const serverId of selectedHosts) {
      ui.info(`[${serverId}] Inspecting Netdata and plugin status...`)
      try {
        const { server, session } = await openConfiguredHostSession({
          ui,
          settingsStore,
          workspace,
          baseSsh,
          settings,
          passphrase,
          serverId,
          onProgress: event => renderConnectionProgress(ui, event, serverId)
        })
        sessions.push(session)
        const stage2 = new Stage2Service({
          ssh: session.ssh,
          debug,
          onDebug: event => renderDebugEvent(ui, { phase: `${serverId}:${event.phase}`, message: event.message })
        })
        const capabilities = await stage2.capabilities(server)
        if (!capabilities.hasNetdata) throw new Error('Netdata is not installed; use full Stage 2 activation for this host')
        let currentVersion = null
        if (capabilities.hasStage2Runner) {
          const observed = await stage2.probe(server)
          if (observed.status === 'active') currentVersion = observed.health.version ?? null
        }
        const elevation = await chooseElevation(ui, capabilities)
        if (!elevation) continue
        const state = currentVersion === PLUGIN_VERSION
          ? `v${currentVersion} (current)`
          : currentVersion ? `v${currentVersion}` : 'not installed/healthy'
        fleetRows.push({ serverId, current: state, target: `v${PLUGIN_VERSION}`, status: 'ready' })
        ready.push({ serverId, server, stage2, elevation })
      } catch (error) {
        fleetRows.push({ serverId, current: error.message, target: `v${PLUGIN_VERSION}`, status: 'unavailable' })
        ui.error(`[${serverId}] ${error.message}`)
      }
    }
    ui.heading(`Plugin v${PLUGIN_VERSION} fleet review`)
    ui.renderTable([
      { key: 'serverId', label: 'HOST', width: 24 },
      { key: 'current', label: 'CURRENT', flex: 1, style: value => ui.statusStyle(value) },
      { key: 'target', label: 'TARGET', width: 12 },
      { key: 'status', label: 'STATUS', width: 14, style: value => ui.statusStyle(value) }
    ], fleetRows)
    ui.separator()
    if (ready.length === 0) {
      ui.warn('No selected host can receive a plugin-only update.')
      return
    }
    if (!await ui.confirm(`Install or update plugin v${PLUGIN_VERSION} on ${ready.length} hosts while preserving Netdata?`, false)) return
    const results = await parallelMap(ready, 4, async entry => {
      try {
        ui.info(`[${entry.serverId}] Installing plugin v${PLUGIN_VERSION}...`)
        const result = await entry.stage2.activate({
          ...entry.server,
          ...entry.elevation,
          installNetdata: false
        })
        ui.success(`[${entry.serverId}] ${pluginActionLabel(result)}; Netdata preserved.`)
        return { ...entry, result }
      } catch (error) {
        renderOperationError(ui, `[${entry.serverId}] Plugin update failed`, error, debug)
        return { ...entry, error }
      } finally {
        if (entry.elevation.sudoPassword) entry.elevation.sudoPassword = null
      }
    })
    for (const entry of results.filter(entry => entry.result)) {
      await settingsStore.setStage2State({
        settings,
        serverId: entry.serverId,
        desired: 'active',
        ownership: entry.result.ownership
      })
      await workspace.enableRootExecution(entry.serverId)
    }
    const succeeded = results.filter(entry => entry.result).length
    const failed = results.length - succeeded
    if (failed === 0) ui.success(`Plugin v${PLUGIN_VERSION} is healthy on all ${succeeded} selected hosts.`)
    else ui.warn(`Plugin update completed on ${succeeded} hosts and failed on ${failed} hosts.`)
  } finally {
    for (const entry of ready) {
      if (entry.elevation.sudoPassword) entry.elevation.sudoPassword = null
    }
    await Promise.allSettled(sessions.map(session => session.close()))
    await ui.pause()
  }
}

function pluginActionLabel (result) {
  if (result.pluginAction === 'installed') return `installed v${result.pluginVersion}`
  if (result.pluginAction === 'updated') return `updated ${result.previousPluginVersion ?? 'unknown'} → v${result.pluginVersion}`
  if (result.pluginAction === 'unchanged') return `already current at v${result.pluginVersion}`
  return `verified v${result.observed?.health?.version ?? result.pluginVersion ?? 'unknown'}`
}

async function executeMultiHostRun ({
  ui,
  settingsStore,
  workspace,
  baseSsh,
  settings,
  passphrase,
  debug,
  serverIds,
  request,
  kind,
  catalogId,
  retryOfRunId = null,
  retryInstructions = null,
  applicationDefaults = {}
}) {
  await withMultiHostAdmins({ ui, settingsStore, workspace, baseSsh, settings, passphrase, serverIds, debug }, async adminFor => {
    let effectiveKind = kind
    let effectiveCatalogId = catalogId
    const planningHints = {}
    if (kind === 'ai' && retryOfRunId === null) {
      ui.info('Asking Codex whether the request matches or can reuse a verified application task for each host platform...')
      const routed = await Promise.allSettled(serverIds.map(async serverId => {
        const admin = await adminFor(serverId)
        const inventory = await admin.refreshInventory({ settings, passphrase, serverId })
        const platform = inventory.webminaiLinuxContext ? 'linux' : inventory.webminaiExecution?.platform ?? null
        const routing = ['freebsd', 'linux', 'macos', 'windows'].includes(platform)
          ? await admin.routeTask({
            settings,
            passphrase,
            serverId,
            request,
            inventory,
            candidates: listEligibleCommonTasks({ ...commonTaskContext({ platform, inventory }), category: 'application' }),
            onProgress: event => renderMultiHostEvent(ui, { serverId, message: event.message })
          })
          : ordinaryTaskRouting('No verified candidate catalog is available for this host platform.')
        return { serverId, inventory, routing }
      }))
      for (const result of routed) {
        if (result.status === 'fulfilled') planningHints[result.value.serverId] = result.value
        else ui.warn(`Candidate routing failed and ordinary AI planning will continue: ${String(result.reason?.message ?? result.reason)}`)
      }
      ui.heading('Multi-host routing')
      ui.renderTable([
        { key: 'serverId', label: 'HOST', width: 24 },
        { key: 'decision', label: 'DECISION', width: 22, style: value => ui.statusStyle(value) },
        { key: 'context', label: 'CATALOG / VERIFIED CONTEXT', flex: 1 }
      ], routingSummaryRows(serverIds, planningHints))
      ui.separator()
      const decisions = routed.filter(result => result.status === 'fulfilled').map(result => result.value.routing)
      const catalogIds = new Set(decisions.map(item => item.catalogId))
      if (decisions.length === serverIds.length && decisions.every(item => item.decision === 'verified_task') && catalogIds.size === 1) {
        effectiveKind = 'catalog'
        effectiveCatalogId = decisions[0].catalogId
        ui.info(`Codex selected the unchanged verified task ${effectiveCatalogId} on every host; command-plan generation will be skipped.`)
      } else {
        for (const { serverId, routing } of Object.values(planningHints)) {
          if (routing.relevantCatalogIds.length > 0) ui.info(`[${serverId}] Custom planning will reuse verified knowledge from ${routing.relevantCatalogIds.join(', ')}.`)
        }
      }
    }
    const service = new MultiHostService({ dataRoot: settingsStore.dataRoot, adminFor })
    const externalVerify = effectiveCatalogId === 'nginx-static-site'
      ? appliedNginxVerifier({ settingsStore, settings, passphrase })
      : null
    const run = await service.run({
      settings,
      passphrase,
      serverIds,
      request,
      kind: effectiveKind,
      catalogId: effectiveCatalogId,
      retryOfRunId,
      retryInstructions,
      planningHints,
      applicationDefaults,
      externalVerify,
      onEvent: event => renderMultiHostEvent(ui, event),
      review: ({ run, hosts }) => reviewMultiHostPlans(ui, run, hosts, 'Execute')
    })
    renderMultiHostRun(ui, run)
    if (run.status === 'completed') ui.success(`Multi-host run #${run.id} completed on every selected host.`)
    else if (run.status === 'cancelled') ui.warn(`Multi-host run #${run.id} was cancelled.`)
    else ui.warn(`Multi-host run #${run.id} finished ${run.status}; retry only the affected hosts from Multi-host run history.`)
  })
  await ui.pause()
}

async function browseMultiHostHistory ({ context, debug }) {
  const { ui, settingsStore, workspace, baseSsh, settings, passphrase, applicationDefaults } = context
  const store = new MultiHostRunStore(settingsStore.dataRoot)
  const history = store.list({ limit: 100 })
  if (history.length === 0) {
    ui.warn('No multi-host run history is available.')
    await ui.pause()
    return
  }
  const rows = multiHostHistoryRows(history)
  const selectedId = await ui.searchableDetailChoose({
    title: 'Multi-host run history',
    rows,
    rowSearchText: row => row.searchText,
    renderRow: (row, options) => ui.styleToken(multiHostHistoryRowText(row, options), row.run.status, ui.statusStyle(row.run.status)),
    renderDetails: row => multiHostRunDetailLines(row?.run),
    resultLabel: 'runs',
    footerHints: ['Enter open', '/ search', 'Esc back']
  })
  if (selectedId === null) return
  const run = store.get(selectedId)
  renderMultiHostRun(ui, run, true)
  const actions = multiHostHistoryActions(run)
  const action = await ui.choose('Run action', actions)
  if (action === 'back') return
  let selectedHosts
  if (action === 'retry-failed') {
    selectedHosts = failedMultiHostIds(run)
    if (selectedHosts.length === 0) {
      ui.warn('This run has no failed hosts.')
      await ui.pause()
      return
    }
  } else {
    const selectable = run.hosts.filter(host => host.taskId)
    selectedHosts = await ui.searchableMultiChoose('Select hosts', selectable.map(host => ({
      label: `${host.serverId} [${host.status}] task #${host.taskId}`,
      value: host.serverId,
      searchText: `${host.serverId} ${host.status} ${host.taskId}`
    })), {
      initialValues: action.startsWith('retry')
        ? selectable.filter(host => ['failed', 'partial', 'revert_failed'].includes(host.status)).map(host => host.serverId)
        : []
    })
    if (selectedHosts.length === 0) return
  }
  if (action === 'revert') {
    await revertMultiHostRun({ ui, settingsStore, workspace, baseSsh, settings, passphrase, debug, run, serverIds: selectedHosts })
    await ui.pause()
    return
  }
  let retryInstructions = null
  if (action === 'retry-extra') {
    retryInstructions = await ui.editor(`Corrections for retry of multi-host run #${run.id}`)
    if (!retryInstructions) return
  }
  const cleanupHosts = cleanupHostIds(run, selectedHosts)
  if (cleanupHosts.length > 0) {
    ui.info('The saved revert plans will restore the selected hosts before their clean retry.')
    const reverted = await revertMultiHostRun({
      ui,
      settingsStore,
      workspace,
      baseSsh,
      settings,
      passphrase,
      debug,
      run,
      serverIds: cleanupHosts,
      pause: false
    })
    if (!retryCleanupSucceeded(reverted, cleanupHosts)) {
      ui.warn('Retry stopped because one or more selected hosts were not cleanly reverted.')
      await ui.pause()
      return
    }
  }
  await executeMultiHostRun({
    ui,
    settingsStore,
    workspace,
    baseSsh,
    settings,
    passphrase,
    debug,
    serverIds: selectedHosts,
    request: run.request,
    kind: run.kind,
    catalogId: run.catalogId,
    retryOfRunId: run.id,
    retryInstructions,
    applicationDefaults
  })
}

async function revertMultiHostRun ({
  ui,
  settingsStore,
  workspace,
  baseSsh,
  settings,
  passphrase,
  debug,
  run,
  serverIds
}) {
  let result = run
  await withMultiHostAdmins({ ui, settingsStore, workspace, baseSsh, settings, passphrase, serverIds, debug }, async adminFor => {
    const service = new MultiHostService({ dataRoot: settingsStore.dataRoot, adminFor })
    result = await service.revert({
      settings,
      passphrase,
      runId: run.id,
      serverIds,
      externalVerify: run.catalogId === 'nginx-static-site'
        ? revertedNginxVerifier({ settingsStore, settings, passphrase })
        : null,
      onEvent: event => renderMultiHostEvent(ui, event),
      review: ({ run, hosts }) => reviewMultiHostPlans(ui, run, hosts, 'Revert')
    })
    renderMultiHostRun(ui, result)
  })
  return result
}

async function withMultiHostAdmins ({ ui, settingsStore, workspace, baseSsh, settings, passphrase, serverIds, debug }, operation) {
  const sessions = []
  const admins = new Map()
  const failures = new Map()
  const hostSessions = new HostSessionFactory({
    dataRoot: settingsStore.dataRoot,
    settingsStore,
    workspace,
    baseSsh,
    debug,
    onWarning: message => ui.warn(redactDiagnosticText(message)),
    onDebug: (serverId, event) => renderDebugEvent(ui, { phase: `${serverId}:${event.phase}`, message: event.message })
  })
  try {
    for (const serverId of serverIds) {
      try {
        const opened = await hostSessions.open({
          settings,
          passphrase,
          serverId,
          requireActive: true,
          onProgress: event => renderConnectionProgress(ui, event, serverId)
        })
        sessions.push(opened.session)
        admins.set(serverId, opened.admin)
        ui.success(`[${serverId}] Stage 2 ready.`)
      } catch (error) {
        failures.set(serverId, error)
        ui.error(`[${serverId}] ${error.message}`)
      }
    }
    return await operation(serverId => {
      if (admins.has(serverId)) return admins.get(serverId)
      throw failures.get(serverId) ?? new Error(`host ${serverId} is unavailable`)
    })
  } finally {
    await Promise.allSettled(sessions.map(session => session.close()))
  }
}

export async function reviewMultiHostPlans (ui, run, hosts, verb) {
  ui.clear()
  ui.banner(`Multi-host run #${run.id}: consolidated review`)
  const commandCount = hosts.reduce((count, host) => count + host.plan.commands.length, 0)
  ui.line('Run', `#${run.id}`)
  ui.line('Hosts', hosts.length)
  ui.line('Commands', commandCount)
  ui.info('Execution starts in parallel only after every host plan is displayed and explicitly confirmed.')
  ui.renderTable([
    { key: 'serverId', label: 'HOST', flex: 1 },
    { key: 'taskId', label: 'TASK', width: 12 },
    { key: 'commands', label: 'COMMANDS', width: 12 },
    { key: 'reverts', label: 'REVERTS', width: 10 }
  ], hosts.map(host => ({
    serverId: host.serverId,
    taskId: `#${host.taskId}`,
    commands: host.plan.commands.length,
    reverts: host.plan.revertCommands.length
  })))
  for (const host of hosts) {
    ui.heading(`${host.serverId} / task #${host.taskId}`)
    renderPlan(ui, host.plan)
  }
  return ui.confirm(`${verb} all ${commandCount} displayed commands across ${hosts.length} hosts?`, false)
}

export function renderMultiHostEvent (ui, event) {
  ui.output.write(`\n${ui.paint('info', `[${event.serverId}]`)} ${event.message}\n`)
  const result = event.result?.result
  for (const [label, stream] of [['stdout', result?.stdout], ['stderr', result?.stderr]]) {
    if (!stream) continue
    const style = label === 'stderr' ? 'error' : 'info'
    for (const line of stream.trimEnd().split('\n')) ui.output.write(`${ui.paint(style, `[${event.serverId}][${label}]`)} ${line}\n`)
  }
}

export function renderMultiHostRun (ui, run, clear = false) {
  if (clear) {
    ui.clear()
    ui.banner(`Multi-host run #${run.id}`)
  }
  ui.heading(`Run #${run.id} [${run.status}]`)
  renderWrappedField(ui, 'Request', run.request)
  ui.line('Kind', run.catalogId ? `catalog:${run.catalogId}` : run.kind)
  if (run.retryOfRunId) ui.line('Retry of run', `#${run.retryOfRunId}`)
  ui.renderTable([
    { key: 'serverId', label: 'HOST', flex: 1 },
    { key: 'status', label: 'STATUS', width: 16, style: value => ui.statusStyle(value) },
    { key: 'task', label: 'TASK', width: 14 },
    { key: 'verification', label: 'VERIFICATION', flex: 1 }
  ], run.hosts.map(host => ({
    serverId: host.serverId,
    status: host.status,
    task: host.taskId ? `#${host.taskId}` : '-',
    verification: host.verification?.url ?? '-'
  })))
  for (const host of run.hosts) {
    if (host.error) ui.error(`[${host.serverId}] ${host.error}`)
  }
}

function appliedNginxVerifier ({ settingsStore, settings, passphrase }) {
  return async ({ serverId }) => {
    const url = await nginxUrl({ settingsStore, settings, passphrase, serverId })
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) })
    const body = await response.text()
    if (!response.ok || !body.includes('WebminAI nginx task')) throw new Error(`external HTTP verification failed for ${url}: status ${response.status}`)
    return { ok: true, url, status: response.status, message: `External HTTP GET passed: ${url}` }
  }
}

function revertedNginxVerifier ({ settingsStore, settings, passphrase }) {
  return async ({ serverId }) => {
    const url = await nginxUrl({ settingsStore, settings, passphrase, serverId })
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
      const body = await response.text()
      if (body.includes('WebminAI nginx task')) throw new Error(`test page is still served at ${url}`)
      return { ok: true, url, status: response.status, message: `Test page is absent: ${url}` }
    } catch (error) {
      if (error.message.includes('test page is still served')) throw error
      return { ok: true, url, status: null, message: `Test endpoint closed: ${url}` }
    }
  }
}

async function nginxUrl ({ settingsStore, settings, passphrase, serverId }) {
  const server = await settingsStore.decryptServer({ settings, passphrase, serverId })
  const host = parseSshConnection(server.connectionUrl).host
  return `http://${host.includes(':') ? `[${host}]` : host}:18080/`
}

async function runConnectedHostSession ({
  context,
  serverId,
  debug
}) {
  const { ui, settingsStore, workspace, settings, passphrase, applicationDefaults, hostSessions } = context
  ui.clear()
  ui.banner(`Connecting to ${serverId}`)
  ui.info(`${PRODUCT_NAME} will use a saved vault credential when available; otherwise OpenSSH may prompt once for this session.`)
  let server
  let session
  let opened
  try {
    opened = await hostSessions.open({
      settings,
      passphrase,
      serverId,
      onProgress: event => renderConnectionProgress(ui, event)
    })
    server = opened.server
    session = opened.session
    context.hostRuntime.set(serverId, { state: 'connected' })
    ui.info('Loading current host, Netdata, and plugin status...')
  } catch (error) {
    context.hostRuntime.set(serverId, { state: 'error', error: redactDiagnosticText(error.message) })
    ui.error(`Connection failed: ${error.message}`)
    await ui.pause()
    return
  }

  const { ssh, stage2, admin } = opened
  try {
    let platformHint = await loadPlatformHint(workspace, serverId)
    let rules = await workspace.loadRules(serverId)
    const statusOptions = () => ({
      stage2,
      server,
      platformHint,
      dockerPreference: rules.preferences.docker,
      admin,
      settings,
      passphrase,
      serverId,
      onProgress: event => renderConnectionProgress(ui, event)
    })
    let status = await readStatus(statusOptions())
    updateHostRuntime(context.hostRuntime, serverId, status)
    platformHint = status.capabilities.platform?.os ?? platformHint
    for (;;) {
      const selected = await ui.splitChoose({
        title: `Host: ${serverId}`,
        actions: connectedHostActionOptions({ status, dockerPreference: rules.preferences.docker, temporary: server.temporary }),
        details: connectedHostDetailLines(serverId, settings.servers[serverId], status),
        footerHints: ['Up/Down select', 'Enter open', 'Esc disconnect', 'q disconnect']
      })
      if (selected === 'back') return
      if (selected === null) return
      if (selected === 'switch') return 'switch'
      if (selected === 'refresh') {
        status = await readStatus(statusOptions())
        updateHostRuntime(context.hostRuntime, serverId, status)
      }
      if (selected === 'docker-preference') {
        const preference = await chooseDockerPreference(ui, rules.preferences.docker)
        if (preference) {
          rules = await workspace.setDockerPreference(serverId, preference)
          status.docker = resolveDockerPolicy({
            preference,
            capability: status.dockerCapability,
            inventory: { info: status.observed.info }
          })
          ui.success(`Docker preference set to ${preference}.`)
        }
      }
      if (selected === 'ssh-credential') {
        server.sshCredential = await changeSavedSshCredential({
          ui,
          settingsStore,
          settings,
          passphrase,
          serverId,
          current: server.sshCredential ?? null
        })
      }
      if (selected === 'requirements') {
        renderRequirements(ui, status.capabilities)
        await ui.pause()
      }
      if (selected === 'shell') {
        ui.info(`Entering the remote shell. Exit it to return to ${PRODUCT_NAME}.`)
        await ui.withTerminalSuspended(() => ssh.interactiveShell(server.connectionUrl))
      }
      if (selected === 'activate' || selected === 'activate-plugin') {
        await activate({
          ui,
          admin,
          settings,
          passphrase,
          serverId,
          capabilities: status.capabilities,
          debug,
          installNetdata: selected === 'activate'
        })
        status = await readStatus(statusOptions())
        updateHostRuntime(context.hostRuntime, serverId, status)
      }
      if (selected === 'claim-cloud') {
        await claimNetdataCloud({ ui, admin, settings, passphrase, serverId, status, debug })
        status = await readStatus(statusOptions())
        updateHostRuntime(context.hostRuntime, serverId, status)
      }
      if (selected === 'deactivate' || selected === 'remove') {
        await deactivate({
          ui,
          admin,
          settings,
          passphrase,
          serverId,
          capabilities: status.capabilities,
          removeManagedNetdata: selected === 'remove',
          debug
        })
        status = await readStatus(statusOptions())
        updateHostRuntime(context.hostRuntime, serverId, status)
      }
      if (selected === 'task') await runTask({ ui, admin, settings, passphrase, serverId, status, applicationDefaults })
      if (selected === 'common-application') {
        const taskPlatform = status.capabilities.platform?.os
        ui.info('Refreshing the host inventory before resolving eligible verified tasks...')
        const inventory = await admin.refreshInventory({ settings, passphrase, serverId })
        const definitions = catalogChoiceRows(eligibleInteractiveCommonTasks({ platform: taskPlatform, inventory, status }))
        const definition = await ui.searchableDetailChoose({
          title: `Verified ${taskPlatform} tasks eligible for this host`,
          rows: definitions,
          rowSearchText: row => row.searchText,
          renderRow: (row, options) => ui.truncateText(`${row.label}  ${row.description}`, options.width),
          renderDetails: row => row ? [`ID: ${row.catalogId}`, `Task: ${row.label}`, `Description: ${row.description}`] : [],
          resultLabel: 'tasks',
          footerHints: ['Enter select', '/ search', 'Esc back']
        })
        if (definition) {
          await runTask({
            ui,
            admin,
            settings,
            passphrase,
            serverId,
            status,
            applicationDefaults,
            catalogId: definition.id,
            initialValue: definition.label
          })
        }
      }
      if (selected === 'history') await browseTaskHistory({ ui, admin, settings, passphrase, serverId, status, applicationDefaults })
      if (selected === 'forget-host') {
        ui.warn('This removes the local connection and encrypted host secret only. It does not change the remote host, and fingerprint-associated task history is retained.')
        if (await ui.confirm(`Remove ${server.temporary ? 'temporary host' : 'saved host connection'} ${serverId}?`, false)) {
          await settingsStore.removeServer({ settings, serverId })
          workspace.clearDirectoryAlias(serverId)
          context.hostRuntime.delete(serverId)
          ui.success(`Host connection ${serverId} was removed. Re-adding the same machine will restore its task history.`)
          await ui.pause()
          return
        }
      }
    }
  } finally {
    await session.close()
  }
}

async function openConfiguredHostSession ({ ui, settingsStore, workspace, baseSsh, settings, passphrase, serverId, onProgress }) {
  const factory = new HostSessionFactory({
    dataRoot: settingsStore.dataRoot,
    settingsStore,
    workspace,
    baseSsh,
    onWarning: message => ui.warn(redactDiagnosticText(message))
  })
  return factory.open({ settings, passphrase, serverId, onProgress })
}

async function changeSavedSshCredential ({ ui, settingsStore, settings, passphrase, serverId, current }) {
  ui.clear()
  ui.banner(`SSH credential / ${serverId}`)
  ui.line('Current state', current ? 'saved and vault encrypted' : 'not saved')
  ui.info('One encrypted value can answer either an SSH password prompt or a private-key passphrase prompt.')
  const action = await ui.choose('Credential action', [
    { label: 'Save or replace the encrypted SSH credential', value: 'save' },
    { label: 'Clear the saved SSH credential', value: 'clear' },
    { label: 'Back without changes', value: null }
  ])
  if (action === null) return current
  let sshCredential = null
  if (action === 'save') {
    sshCredential = await ui.secret('SSH password or private-key passphrase (blank cancels)')
    if (!sshCredential) return current
  } else if (!await ui.confirm('Clear the saved SSH credential?', false)) {
    return current
  }
  await settingsStore.setServerSshCredential({ settings, passphrase, serverId, sshCredential })
  ui.success(sshCredential ? 'SSH credential saved in the encrypted vault.' : 'Saved SSH credential cleared.')
  await ui.pause()
  return sshCredential
}

async function loadPlatformHint (workspace, serverId) {
  try {
    const observed = await workspace.loadObserved(serverId)
    return detectPersistedPlatform(observed.inventory)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return null
}

export async function readStatus ({ stage2, server, platformHint, dockerPreference = 'auto', admin, settings, passphrase, serverId, onProgress = () => {} }) {
  try {
    onProgress({ phase: 'capabilities', state: 'started', message: 'Detecting the remote platform and host capabilities...' })
    const capabilities = await stage2.capabilities({ ...server, platformHint })
    const platformLabel = [capabilities.platform?.system, capabilities.platform?.machine].filter(Boolean).join(' ') || 'unknown platform'
    onProgress({ phase: 'capabilities', state: 'completed', message: `Detected ${platformLabel}.` })
    if (capabilities.hasNetdata) {
      onProgress({ phase: 'netdata', state: 'started', message: 'Checking Netdata, Netdata Cloud, and the Stage 2 plugin...' })
    } else {
      onProgress({ phase: 'netdata', state: 'warning', message: 'Netdata is not installed; Stage 2 is inactive.' })
    }
    const observedPromise = capabilities.hasNetdata && capabilities.hasStage2Runner
      ? stage2.probe(server).then(observed => {
        onProgress({
          phase: 'stage2',
          state: observed.status === 'active' ? 'completed' : 'warning',
          message: `Stage 2 plugin health is ${observed.status}.`
        })
        return observed
      })
      : Promise.resolve({ status: 'inactive' })
    const cloudPromise = capabilities.hasNetdata
      ? stage2.cloudStatus(server).then(cloud => {
        onProgress({
          phase: 'netdata-cloud',
          state: cloud.claimed ? 'completed' : 'warning',
          message: cloud.claimed ? `Netdata Cloud is ${cloud.status}.` : `Netdata Cloud is ${cloud.status ?? 'unavailable'}.`
        })
        return cloud
      }).catch(error => {
        onProgress({ phase: 'netdata-cloud', state: 'warning', message: 'Netdata Cloud status is unavailable.' })
        return { claimed: false, status: 'unavailable', reason: error.message }
      })
      : Promise.resolve({ claimed: false, status: 'unavailable', reason: 'Netdata is not installed' })
    const [observed, cloud] = await Promise.all([observedPromise, cloudPromise])
    if (capabilities.hasNetdata && !capabilities.hasStage2Runner) {
      onProgress({ phase: 'stage2', state: 'warning', message: `The ${PRODUCT_NAME} Stage 2 plugin is not installed.` })
    }
    if (['freebsd', 'macos', 'windows'].includes(capabilities.platform?.os) && observed.status === 'active' && admin) {
      onProgress({ phase: 'inventory', state: 'started', message: 'Refreshing platform inventory through Stage 2...' })
    }
    const platformInventory = ['freebsd', 'macos', 'windows'].includes(capabilities.platform?.os) && observed.status === 'active' && admin
      ? await admin.refreshInventory({ settings, passphrase, serverId })
      : null
    if (platformInventory) onProgress({ phase: 'inventory', state: 'completed', message: 'Platform inventory refreshed.' })
    const dockerCapability = platformInventory?.webminaiDocker ?? capabilities.docker
    const docker = resolveDockerPolicy({
      preference: dockerPreference,
      capability: dockerCapability,
      inventory: { info: observed.info }
    })
    if (capabilities.platform?.os === 'linux' && observed.status === 'active' && admin) {
      onProgress({ phase: 'linux-context', state: 'started', message: 'Refreshing the Linux host profile and package context...' })
    }
    const linuxContext = capabilities.platform?.os === 'linux' && observed.status === 'active' && admin
      ? await admin.refreshLinuxHostContext({
        settings,
        passphrase,
        serverId,
        inventory: { info: observed.info }
      })
      : null
    if (linuxContext) onProgress({ phase: 'linux-context', state: 'completed', message: 'Linux host context refreshed.' })
    onProgress({ phase: 'status', state: 'completed', message: 'Current host status is ready.' })
    return { connected: true, capabilities, observed, cloud, docker, dockerCapability, linuxContext, windowsExecution: capabilities.platform?.os === 'windows' ? platformInventory?.webminaiExecution ?? null : null, freebsdExecution: capabilities.platform?.os === 'freebsd' ? platformInventory?.webminaiExecution ?? null : null, macosExecution: capabilities.platform?.os === 'macos' ? platformInventory?.webminaiExecution ?? null : null }
  } catch (error) {
    onProgress({ phase: 'status', state: 'failed', message: `Host status could not be loaded: ${redactDiagnosticText(error.message)}` })
    return { connected: false, error: error.message, capabilities: {}, observed: { status: 'inactive' }, cloud: { claimed: false, status: 'unavailable' } }
  }
}

function updateHostRuntime (hostRuntime, serverId, status) {
  const platform = status.capabilities.platform
    ? `${status.capabilities.platform.system} ${status.capabilities.platform.machine}`
    : null
  if (!status.connected) {
    hostRuntime.set(serverId, { state: 'error', platform, error: redactDiagnosticText(status.error ?? 'status unavailable') })
    return
  }
  hostRuntime.set(serverId, {
    state: status.observed.status === 'active' ? 'active' : status.observed.status === 'inactive' ? 'inactive' : 'unavailable',
    platform,
    error: status.error ? redactDiagnosticText(status.error) : null
  })
}

async function chooseDockerPreference (ui, current) {
  ui.clear()
  ui.banner('Docker preference')
  ui.info('Automatic prefers Docker Compose only when Docker is ready and the host itself is not a container.')
  ui.info('Enabled overrides the container safeguard. Disabled prevents AI plans from using Docker.')
  return ui.choose(`Current preference: ${current}`, [
    { label: 'Automatic detection', value: 'auto' },
    { label: 'Enable Docker preference', value: 'enabled' },
    { label: 'Disable Docker preference', value: 'disabled' },
    { label: 'Cancel', value: null }
  ])
}

export async function claimNetdataCloud ({ ui, admin, settings, passphrase, serverId, status, debug }) {
  if (!status.capabilities.hasNetdata) {
    ui.error('Install Netdata before connecting it to Netdata Cloud.')
    await ui.pause()
    return
  }
  ui.heading('Netdata Cloud claiming')
  ui.info('Paste a generated claiming command, details URL, or token. Leave it blank to enter values separately.')
  ui.info('While entering separate values, leave the token or room IDs blank to cancel.')
  const pasted = await ui.secret('Claiming command, URL, or token')
  let extracted
  try {
    extracted = parseClaimingInput(pasted)
  } catch {
    ui.warn('Could not safely extract one consistent set of claiming details; enter each value separately.')
    extracted = { claimToken: null, claimUrl: null, roomIds: null }
  }
  const claimToken = extracted.claimToken ?? await ui.secret('Claim token')
  if (!claimToken) return
  const claimUrl = extracted.claimUrl ?? await ui.ask('Claim URL', { defaultValue: 'https://app.netdata.cloud' })
  const roomIds = extracted.roomIds ?? await ui.ask('Room ID(s), comma-separated', { required: false })
  if (!roomIds) return
  let details
  try {
    details = validateClaimDetails({ claimToken, claimUrl, roomIds })
  } catch (error) {
    ui.error(`Invalid claiming details: ${error.message}`)
    await ui.pause()
    return
  }
  ui.line('Claim URL', details.claimUrl)
  ui.line('Room IDs', details.roomIds)
  ui.line('Claim token', 'provided (hidden)')
  if (status.cloud.claimed) ui.warn(`This Agent is already connected with status ${status.cloud.status}; claiming will replace claim.conf.`)
  const elevation = await chooseElevation(ui, status.capabilities)
  if (!elevation) return
  if (!await ui.confirm(`Connect ${serverId} to Netdata Cloud using these details?`, false)) return
  try {
    const result = await admin.claimNetdataCloud({
      settings,
      passphrase,
      serverId,
      ...details,
      ...elevation
    })
    ui.success(`Netdata Cloud connection verified: ${result.cloud.status}.`)
  } catch (error) {
    renderOperationError(ui, 'Netdata Cloud claiming failed', error, debug)
  }
  await ui.pause()
}

async function activate ({
  ui,
  admin,
  settings,
  passphrase,
  serverId,
  capabilities,
  debug,
  installNetdata
}) {
  if (!installNetdata && !capabilities.hasNetdata) {
    ui.error('Plugin-only activation requires Netdata to be installed already.')
    await ui.pause()
    return
  }
  if (installNetdata && !capabilities.hasNetdata && !capabilities.hasCurl && capabilities.platform?.os !== 'freebsd') {
    ui.error('Netdata is absent and curl is unavailable, so the Netdata installer cannot be downloaded.')
    renderRequirements(ui, capabilities)
    await ui.pause()
    return
  }
  const elevation = await chooseElevation(ui, capabilities)
  if (!elevation) return
  const description = installNetdata
    ? `Install/activate Netdata and the ${PRODUCT_NAME} plugin?`
    : `Install/update only the ${PRODUCT_NAME} plugin and preserve Netdata?`
  if (!await ui.confirm(description, true)) return
  ui.info('Activating Stage 2 and verifying its Netdata function API...')
  try {
    const result = await admin.activate({ settings, passphrase, serverId, installNetdata, ...elevation })
    ui.success(`Stage 2 is active; plugin ${pluginActionLabel(result)}.`)
  } catch (error) {
    renderOperationError(ui, 'Activation failed', error, debug)
  }
  await ui.pause()
}

async function deactivate ({
  ui,
  admin,
  settings,
  passphrase,
  serverId,
  capabilities,
  removeManagedNetdata,
  debug
}) {
  const elevation = await chooseElevation(ui, capabilities)
  if (!elevation) return
  const description = removeManagedNetdata
    ? `Remove the plugin and Netdata only if ${PRODUCT_NAME} installed Netdata?`
    : 'Remove the plugin and keep Netdata?'
  if (!await ui.confirm(description, false)) return
  try {
    const result = await admin.deactivate({
      settings,
      passphrase,
      serverId,
      removeManagedNetdata,
      ...elevation
    })
    ui.success(`Stage 2 is ${result.status}. Netdata ownership: ${result.ownership}.`)
  } catch (error) {
    renderOperationError(ui, 'Deactivation failed', error, debug)
  }
  await ui.pause()
}

export async function chooseElevation (ui, capabilities) {
  if (capabilities.platform?.os === 'windows' && capabilities.isAdministrator) {
    return { elevation: 'windows-admin' }
  }
  if (capabilities.isRoot) return { elevation: 'root' }
  if (capabilities.hasPasswordlessSudo) return { elevation: 'sudo-n' }
  if (capabilities.hasPasswordlessDoas) return { elevation: 'doas-n' }
  if (capabilities.hasSudo) {
    ui.info('This account needs a sudo password for host changes. It is used once and never saved. Leave it blank to cancel.')
    const sudoPassword = await ui.secret('Sudo password')
    if (!sudoPassword) return null
    return { elevation: 'sudo-password', sudoPassword }
  }
  ui.error('Activation requires an administrator account on Windows, or root/sudo/doas on Unix.')
  renderRequirements(ui, capabilities)
  await ui.pause()
  return null
}

async function runTask ({
  ui,
  admin,
  settings,
  passphrase,
  serverId,
  status,
  initialValue = '',
  previousAttempts = [],
  retryInstructions = null,
  catalogId = null,
  applicationDefaults = {}
}) {
  if (status.observed.status !== 'active') {
    ui.warn('Activate Stage 2 before running a task.')
    await ui.pause()
    return
  }
  let request = catalogId ? initialValue : null
  if (!catalogId && previousAttempts.length > 0) {
    request = previousAttempts.at(-1).request
  } else if (!catalogId) {
    const history = admin.listTasks(serverId, { limit: 30 })
    const recent = history.slice(0, 3).map(task => `  ${taskHistoryLabel(task)}`)
    request = await ui.editor(`AI-assisted task / ${serverId}`, {
      initialValue,
      history,
      introLines: [
        'Describe the server task.',
        'Prefix the request with ? to ask for advice without executing commands.',
        ...(recent.length > 0 ? ['', 'Recent requests', ...recent] : [])
      ]
    })
    if (!request) return
    const parsed = parseAiRequest(request)
    if (parsed.consultation) {
      if (!parsed.question) {
        ui.warn('Add a question after ? to start a consultation.')
        await ui.pause()
        return
      }
      await runConsultation({
        ui,
        admin,
        settings,
        passphrase,
        serverId,
        question: parsed.question,
        storedRequest: parsed.storedRequest
      })
      return
    }
    request = parsed.request
  }
  let inventory = null
  let routing = catalogId
    ? { decision: 'verified_task', catalogId, relevantCatalogIds: [catalogId], foundationIds: [], foundationMode: 'executable', confidence: 'high', rationale: 'Selected explicitly from the verified common-task catalog.' }
    : ordinaryTaskRouting('Candidate routing was not run.')
  if (!catalogId && previousAttempts.length === 0 && ['freebsd', 'linux', 'macos', 'windows'].includes(status.capabilities.platform?.os)) {
    const taskPlatform = status.capabilities.platform.os
    ui.info(`Asking Codex whether this request matches or can reuse a verified ${taskPlatform} common task...`)
    inventory = await admin.refreshInventory({ settings, passphrase, serverId })
    try {
      routing = await admin.routeTask({
        settings,
        passphrase,
        serverId,
        request,
        inventory,
        candidates: eligibleInteractiveCommonTasks({ platform: taskPlatform, inventory, status }),
        onProgress: event => renderTaskProgress(ui, event)
      })
    } catch (error) {
      ui.warn(`Candidate routing failed; ordinary AI planning will continue: ${error.message}`)
    }
  }
  renderTaskRouting(ui, routing)
  const effectiveCatalogId = routing.decision === 'verified_task' ? routing.catalogId : null
  const kind = effectiveCatalogId ? 'catalog' : 'ai'
  if (routing.decision === 'verified_task' && !catalogId) ui.info(`Codex selected the unchanged verified task ${effectiveCatalogId}; command-plan generation will be skipped.`)
  if (routing.decision === 'informed_planning') ui.info(`Custom planning will reuse verified knowledge from ${routing.relevantCatalogIds.join(', ')}.`)
  const retryOfTaskId = previousAttempts.at(-1)?.id ?? null
  const consultationContext = kind === 'catalog'
    ? []
    : retryOfTaskId
      ? admin.getTaskConsultations(serverId, retryOfTaskId)
      : admin.listPendingConsultations(serverId)
  const task = admin.createTask(serverId, request, {
    kind,
    catalogId: effectiveCatalogId,
    retryOfTaskId,
    retryInstructions,
    consultationIds: consultationContext.map(item => item.id),
    consumeConsultations: retryOfTaskId === null
  })
  admin.appendTaskProgress(serverId, task.id, {
    at: new Date().toISOString(),
    type: 'task_routing',
    message: `${routing.decision}: ${routing.rationale}`
  })
  if (retryOfTaskId) ui.info(`Created retry task #${task.id} from task #${retryOfTaskId}.`)
  if (consultationContext.length > 0) {
    ui.info(`Using ${consultationContext.length} compact consultation ${consultationContext.length === 1 ? 'summary' : 'summaries'}; this task request takes precedence.`)
  }
  ui.info(kind === 'catalog'
    ? 'Preparing the verified common task from the current Netdata inventory...'
    : 'Collecting Netdata inventory and asking Codex for a command plan...')
  try {
    let plan
    if (kind === 'catalog') {
      const refreshed = inventory ?? ((isHostHealthTask(effectiveCatalogId) || isSystemUpdateTask(effectiveCatalogId))
        ? await admin.refreshInventory({ settings, passphrase, serverId })
        : status.linuxContext
          ? null
          : await admin.refreshInventory({ settings, passphrase, serverId }))
      if (isHostHealthTask(effectiveCatalogId) || isSystemUpdateTask(effectiveCatalogId)) inventory = refreshed
      plan = buildCommonTask(effectiveCatalogId, task.id, {
        platform: status.capabilities.platform?.os,
        linuxContext: refreshed?.webminaiLinuxContext ?? status.linuxContext,
        windowsExecution: refreshed?.webminaiExecution ?? status.windowsExecution,
        freebsdExecution: refreshed?.webminaiExecution ?? status.freebsdExecution,
        macosExecution: refreshed?.webminaiExecution ?? status.macosExecution,
        docker: refreshed?.webminaiDocker ?? status.docker,
        applicationDefaults
      }).plan
    } else {
      const candidateContext = buildCandidatePlanningContext(routing.relevantCatalogIds, task.id, {
        platform: status.capabilities.platform?.os,
        linuxContext: inventory?.webminaiLinuxContext ?? status.linuxContext,
        windowsExecution: inventory?.webminaiExecution ?? status.windowsExecution,
        freebsdExecution: inventory?.webminaiExecution ?? status.freebsdExecution,
        macosExecution: inventory?.webminaiExecution ?? status.macosExecution,
        docker: inventory?.webminaiDocker ?? status.docker,
        foundationIds: routing.foundationIds,
        foundationMode: routing.foundationMode ?? 'context-only',
        applicationDefaults
      })
      plan = await admin.plan({
        settings,
        passphrase,
        serverId,
        request,
        inventory,
        taskId: task.id,
        previousAttempts,
        retryInstructions,
        consultationContext,
        candidateContext,
        applicationDefaults,
        onProgress: event => {
          admin.appendTaskProgress(serverId, task.id, event)
          renderTaskProgress(ui, event)
        }
      })
    }
    admin.saveTaskPlan(serverId, task.id, plan)
    renderPlan(ui, plan)
    const approvalMode = await chooseApprovalMode(ui, plan.commands)
    if (!approvalMode) {
      admin.cancelTask(serverId, task.id)
      return
    }
    admin.markTaskRunning(serverId, task.id)
    const healthTask = isHostHealthTask(effectiveCatalogId)
    const updateTask = isSystemUpdateTask(effectiveCatalogId)
    const results = await admin.execute({
      settings,
      passphrase,
      serverId,
      plan,
      onResult: result => admin.appendTaskResult(serverId, task.id, (healthTask || updateTask) ? sanitizeHealthResult(result) : result),
      approve: approvalMode === 'all'
        ? async () => true
        : item => approveCommand(ui, item),
      requireRevert: !updateTask
    })
    const savedResults = (healthTask || updateTask) ? results.map(sanitizeHealthResult) : results
    admin.saveTaskResults(serverId, task.id, savedResults)
    renderResults(ui, savedResults)
    if (isHostHealthTask(effectiveCatalogId) && results.every(result => result.status === 'completed')) {
      await renderAndSaveHostHealthReport({
        ui,
        admin,
        settings,
        passphrase,
        serverId,
        task,
        platform: status.capabilities.platform?.os,
        inventory,
        results
      })
    }
    if (updateTask && results.every(result => result.status === 'completed')) {
      const postInventory = await admin.refreshInventory({ settings, passphrase, serverId })
      await renderAndSaveSystemUpdateReport({
        ui,
        admin,
        settings,
        passphrase,
        serverId,
        task,
        platform: status.capabilities.platform?.os,
        inventory: postInventory,
        results
      })
    }
  } catch (error) {
    admin.saveTaskError(serverId, task.id, error)
    ui.error(`Task failed: ${error.message}`)
  }
  await ui.pause()
}

async function runConsultation ({ ui, admin, settings, passphrase, serverId, question, storedRequest }) {
  const consultationContext = admin.listPendingConsultations(serverId)
  const task = admin.createTask(serverId, storedRequest, {
    kind: 'consultation',
    consultationIds: consultationContext.map(item => item.id),
    consumeConsultations: false
  })
  ui.clear()
  ui.banner(`Codex consultation #${task.id} / ${serverId}`)
  if (consultationContext.length > 0) {
    ui.info(`Consulting with ${consultationContext.length} earlier compact ${consultationContext.length === 1 ? 'summary' : 'summaries'} as background.`)
  }
  ui.info('Collecting Netdata inventory and asking Codex for advice only; no command will execute...')
  try {
    const consultation = await admin.consult({
      settings,
      passphrase,
      serverId,
      question,
      consultationContext,
      onProgress: event => {
        admin.appendTaskProgress(serverId, task.id, event)
        renderTaskProgress(ui, event)
      }
    })
    admin.saveConsultation(serverId, task.id, consultation)
    renderConsultation(ui, consultation, task.id)
  } catch (error) {
    admin.saveTaskError(serverId, task.id, error)
    ui.error(`Consultation failed: ${error.message}`)
  }
  await ui.pause()
}

async function browseTaskHistory ({ ui, admin, settings, passphrase, serverId, status, applicationDefaults }) {
  const history = admin.listTasks(serverId, { limit: 100 })
  if (history.length === 0) {
    ui.warn('No task history is available for this host.')
    await ui.pause()
    return
  }
  const rows = taskHistoryRows(history)
  const selected = await ui.searchableDetailChoose({
    title: `Task history / ${serverId}`,
    rows,
    rowSearchText: row => row.searchText,
    renderRow: (row, options) => ui.styleToken(taskHistoryRowText(row, options), row.task.status, ui.statusStyle(row.task.status)),
    renderDetails: row => taskDetailLines(row?.task),
    resultLabel: 'tasks',
    footerHints: ['Enter open', '/ search', 'Esc back']
  })
  if (selected === null) return
  const task = admin.getTask(serverId, selected)
  renderTaskRecord(ui, task)
  const actions = taskHistoryActions(task, { catalogTask: Boolean(task.catalogId) })
  const action = await ui.choose('History action', actions)
  if (action === 'retry' || action === 'retry-extra') {
    let retryInstructions = null
    if (action === 'retry-extra') {
      retryInstructions = await ui.editor(`Additional corrections for retry of task #${task.id}`)
      if (!retryInstructions) return
    }
    const previousAttempts = admin.getTaskRetryHistory(serverId, task.id)
    await runTask({
      ui,
      admin,
      settings,
      passphrase,
      serverId,
      status,
      applicationDefaults,
      previousAttempts,
      retryInstructions
    })
  } else if (action === 'reuse') {
    await runTask({
      ui,
      admin,
      settings,
      passphrase,
      serverId,
      status,
      applicationDefaults,
      initialValue: task.request,
      catalogId: task.catalogId ?? null
    })
  } else if (action === 'revert') {
    await runRevertTask({ ui, admin, settings, passphrase, serverId, task })
  }
}

async function runRevertTask ({ ui, admin, settings, passphrase, serverId, task }) {
  ui.clear()
  ui.banner(`Revert task #${task.id} / ${serverId}`)
  ui.warn(`Reverting task #${task.id} will execute its saved rollback commands with the privileged Stage 2 identity.`)
  renderCommandList(ui, task.plan.revertCommands, 'Saved revert plan')
  const approvalMode = await chooseApprovalMode(ui, task.plan.revertCommands, 'revert commands')
  if (!approvalMode) return
  admin.markTaskReverting(serverId, task.id)
  try {
    const results = await admin.revertTask({
      settings,
      passphrase,
      serverId,
      taskId: task.id,
      onResult: result => admin.appendTaskRevertResult(serverId, task.id, result),
      approve: approvalMode === 'all'
        ? async () => true
        : item => approveCommand(ui, item, 'Revert')
    })
    admin.saveTaskRevertResults(serverId, task.id, results)
    renderResults(ui, results, 'Revert results')
  } catch (error) {
    admin.saveTaskRevertError(serverId, task.id, error)
    ui.error(`Revert failed: ${error.message}`)
  }
  await ui.pause()
}

async function approveCommand (ui, item, prefix = 'Approve') {
  ui.clear()
  ui.banner(`${prefix} command`)
  ui.heading(`${prefix}: ${item.id}`)
  renderWrappedField(ui, 'Purpose', item.purpose)
  ui.line('Risk', item.risk)
  ui.line('Timeout', `${item.timeoutMs}ms`)
  ui.line('Root required', item.requiresSudo ? 'yes' : 'no')
  ui.separator()
  writeRaw(ui, item.command)
  ui.separator()
  return ui.confirm('Execute this command?', false)
}

export async function chooseApprovalMode (ui, commands, label = 'commands') {
  if (commands.length === 0) return 'all'
  if (await ui.confirm(`Execute all ${commands.length} ${label} exactly as shown?`, false)) return 'all'
  if (await ui.confirm(`Review and approve the ${label} one at a time instead?`, false)) return 'each'
  return null
}

export function parseAiRequest (value) {
  if (typeof value !== 'string') throw new TypeError('AI request must be a string')
  const request = value.trim()
  if (!request.startsWith('?')) return { consultation: false, request }
  const question = request.slice(1).trim()
  return {
    consultation: true,
    question,
    storedRequest: question ? `? ${question}` : '?'
  }
}

function ordinaryTaskRouting (rationale) {
  return {
    decision: 'ordinary_planning',
    catalogId: null,
    relevantCatalogIds: [],
    foundationIds: [],
    foundationMode: 'none',
    confidence: 'high',
    rationale
  }
}

function commonTaskContext ({ platform, inventory = null, status = {} }) {
  const execution = inventory?.webminaiExecution
  return {
    platform,
    inventory,
    linuxContext: inventory?.webminaiLinuxContext ?? status.linuxContext,
    windowsExecution: platform === 'windows' ? execution ?? status.windowsExecution : null,
    freebsdExecution: platform === 'freebsd' ? execution ?? status.freebsdExecution : null,
    macosExecution: platform === 'macos' ? execution ?? status.macosExecution : null,
    docker: inventory?.webminaiDocker ?? status.docker
  }
}

function eligibleInteractiveCommonTasks (options) {
  const context = commonTaskContext(options)
  return [
    ...listEligibleCommonTasks({ ...context, category: 'maintenance' }),
    ...listEligibleCommonTasks({ ...context, category: 'diagnostic' }),
    ...listEligibleCommonTasks({ ...context, category: 'application' })
  ]
}

async function renderAndSaveSystemUpdateReport ({ ui, admin, settings, passphrase, serverId, task, platform, inventory, results }) {
  ui.info('Asking Codex to summarize the exact update delta, reboot requirement, and newer-release availability...')
  const reportInventory = {
    ...inventory,
    webminaiSystemUpdateEvidence: {
      format: 'webminai-system-update-evidence',
      version: 1,
      platform,
      collectedAt: new Date().toISOString(),
      source: 'approved verified common task',
      profile: systemUpdateProfile(platform),
      results: results.map(result => ({
        id: result.id,
        status: result.status,
        stdout: redactHealthText(result.result?.stdout).slice(0, 64 * 1024),
        stderr: redactHealthText(result.result?.stderr).slice(0, 16 * 1024)
      }))
    }
  }
  const report = await admin.consult({
    settings,
    passphrase,
    serverId,
    inventory: reportInventory,
    consultationContext: [],
    question: systemUpdateQuestion(),
    onProgress: event => {
      const safeEvent = { ...event, message: redactHealthText(event.message) }
      admin.appendTaskProgress(serverId, task.id, safeEvent)
      renderTaskProgress(ui, safeEvent)
    }
  })
  const safeReport = {
    answer: redactHealthText(report.answer),
    contextSummary: redactHealthText(report.contextSummary)
  }
  admin.appendTaskProgress(serverId, task.id, {
    at: new Date().toISOString(),
    type: 'system_update_report',
    message: safeReport.answer,
    contextSummary: safeReport.contextSummary
  })
  await admin.saveUpdateContext(serverId, {
    ...systemUpdateProfile(platform),
    observedAt: new Date().toISOString(),
    taskId: task.id,
    reportSummary: safeReport.contextSummary
  })
  ui.heading('System update report')
  writeWrapped(ui, safeReport.answer)
  ui.separator()
  renderWrappedField(ui, 'Reusable update context', safeReport.contextSummary)
}

function systemUpdateQuestion () {
  return [
    'Prepare a concise system-update completion report from webminaiSystemUpdateEvidence.',
    'State whether the update succeeded, then enumerate the software or packages installed, updated, removed, skipped, or failed with before and after versions when present.',
    'State explicitly that no reboot was performed and whether a reboot is now required.',
    'State whether a newer operating-system release or Windows feature upgrade is available, naming it when evidence does so; use unknown when the native check could not determine this.',
    'Do not confuse a package-manager full or dist upgrade inside configured repositories with an operating-system release upgrade.',
    'Mention the retained full audit path if terminal evidence is bounded. Do not propose or execute commands and do not reproduce credentials or secrets.'
  ].join(' ')
}

async function renderAndSaveHostHealthReport ({ ui, admin, settings, passphrase, serverId, task, platform, inventory, results }) {
  ui.info('Asking Codex to turn the Netdata inventory and bounded platform evidence into a concise health report...')
  const evidence = healthEvidence(results)
  const reportInventory = {
    ...inventory,
    webminaiHealthEvidence: {
      format: 'webminai-host-health-evidence',
      version: 1,
      platform,
      collectedAt: new Date().toISOString(),
      source: 'approved read-only common task',
      profile: hostHealthProfile(platform, inventory),
      stdout: evidence.stdout,
      stderr: evidence.stderr
    }
  }
  const report = await admin.consult({
    settings,
    passphrase,
    serverId,
    inventory: reportInventory,
    consultationContext: [],
    question: hostHealthQuestion(),
    onProgress: event => {
      const safeEvent = { ...event, message: redactHealthText(event.message) }
      admin.appendTaskProgress(serverId, task.id, safeEvent)
      renderTaskProgress(ui, safeEvent)
    }
  })
  const safeReport = {
    answer: redactHealthText(report.answer),
    contextSummary: redactHealthText(report.contextSummary)
  }
  admin.appendTaskProgress(serverId, task.id, {
    at: new Date().toISOString(),
    type: 'health_report',
    message: safeReport.answer,
    contextSummary: safeReport.contextSummary
  })
  await admin.saveHealthContext(serverId, {
    ...hostHealthProfile(platform, inventory),
    observedAt: new Date().toISOString(),
    taskId: task.id,
    reportSummary: safeReport.contextSummary
  })
  ui.heading('Host health report')
  writeWrapped(ui, safeReport.answer)
  ui.separator()
  renderWrappedField(ui, 'Reusable diagnostic context', safeReport.contextSummary)
}

function healthEvidence (results) {
  const sections = results.filter(item => item.id.startsWith('collect-health-'))
  return {
    stdout: sections.map(item => `=== ${item.id} ===\n${redactHealthText(item.result?.stdout).slice(0, 48 * 1024)}`).join('\n').slice(0, 128 * 1024),
    stderr: sections.map(item => item.result?.stderr ? `=== ${item.id} ===\n${redactHealthText(item.result.stderr).slice(0, 16 * 1024)}` : '').filter(Boolean).join('\n').slice(0, 32 * 1024)
  }
}

function sanitizeHealthResult (entry) {
  if (!entry?.result) return entry
  return {
    ...entry,
    result: {
      ...entry.result,
      stdout: redactHealthText(entry.result.stdout),
      stderr: redactHealthText(entry.result.stderr)
    }
  }
}

export function redactHealthText (value) {
  return redactDiagnosticText(String(value ?? ''))
    .replace(/\b(password|passwd|token|secret|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=-]+/giu, '$1 [redacted]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s"'<>]+/giu, '[redacted-url]')
    .replace(/\b(?:postgres(?:ql)?|mysql|mariadb|mongodb|redis):\/\/[^\s"']+/giu, '[redacted-service-url]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu, '[redacted-private-key]')
}

function hostHealthQuestion () {
  return [
    'Prepare a concise, decision-useful health report for this host.',
    'Netdata inventory is the primary source for metrics, load, storage, containers, contexts, and alerts. webminaiHealthEvidence is a bounded read-only supplement for recent errors, failed services, updates, reboot state, and platform-specific details.',
    'Report: overall health; immediate issues; load, CPU, memory, storage and swap; service/container reliability; recent errors; pending updates and reboot needs; monitoring gaps; and prioritized next actions.',
    'Distinguish confirmed observations from unavailable or stale checks. Mention evidence timestamps where useful. Do not propose or execute commands. Do not reproduce secrets, tokens, credentials, raw log dumps, or unnecessary personal data.'
  ].join(' ')
}

function renderTaskRouting (ui, routing) {
  ui.heading('Task routing')
  ui.line('Decision', routing.decision.replaceAll('_', ' '))
  ui.line('Verified knowledge', routing.catalogId ?? (routing.relevantCatalogIds.join(', ') || '-'))
  if (routing.foundationIds?.length) ui.line('Foundations', `${routing.foundationMode}: ${routing.foundationIds.join(', ')}`)
  if (routing.confidence) ui.line('Confidence', routing.confidence)
  renderWrappedField(ui, 'Reason', routing.rationale)
  ui.separator()
}

export function renderPlan (ui, plan) {
  ui.heading('Codex command plan')
  renderWrappedField(ui, 'Summary', plan.summary)
  renderWrappedField(ui, 'Change overview', plan.changeOverview)
  ui.line('Confirmation', plan.requiresConfirmation ? 'required' : 'not requested')
  ui.separator()
  if (plan.modifiedFiles.length > 0) {
    ui.heading('Modified files and paths')
    for (const file of plan.modifiedFiles) writeWrapped(ui, file)
  }
  for (const warning of plan.warnings) ui.warn(warning)
  renderCommandList(ui, plan.commands, 'Commands to execute')
  if (plan.revertCommands.length > 0) {
    renderCommandList(ui, plan.revertCommands, 'Saved revert plan (not executed now)')
  }
}

function renderConsultation (ui, consultation, taskId) {
  ui.heading(`Codex consultation #${taskId}`)
  ui.separator()
  writeWrapped(ui, consultation.answer)
  ui.heading('Compact context saved for the next task')
  writeWrapped(ui, consultation.contextSummary)
  ui.separator()
  ui.info('No command was proposed, approved, or executed.')
}

function renderCommandList (ui, commands, heading) {
  ui.heading(`${heading} (${commands.length})`)
  if (commands.length === 0) {
    ui.info('No commands.')
    return
  }
  ui.renderTable([
    { key: 'id', label: 'ID', width: 18 },
    { key: 'purpose', label: 'PURPOSE', flex: 1 },
    { key: 'risk', label: 'RISK', width: 10, style: value => riskTone(value) },
    { key: 'timeout', label: 'TIMEOUT', width: 11 },
    { key: 'root', label: 'ROOT', width: 6, style: value => value === 'yes' ? 'warning' : 'muted' }
  ], commands.map(item => ({
    id: item.id,
    purpose: item.purpose,
    risk: item.risk,
    timeout: `${item.timeoutMs}ms`,
    root: item.requiresSudo ? 'yes' : 'no'
  })), { emptyMessage: 'No commands.' })
  for (const [index, item] of commands.entries()) {
    ui.heading(`${index + 1}. ${item.id}`)
    renderWrappedField(ui, 'Purpose', item.purpose)
    ui.line('Risk', item.risk)
    ui.line('Timeout', `${item.timeoutMs}ms`)
    ui.line('Root required', item.requiresSudo ? 'yes' : 'no')
    if (item.source) ui.line('Source', commandSourceLabel(item.source))
    ui.output.write('Command\n-------\n')
    writeRaw(ui, item.command)
  }
  ui.separator()
}

function commandSourceLabel (source) {
  if (source.type === 'ai-planned') return 'AI-planned application phase'
  return `${source.type === 'verified-foundation' ? 'Verified foundation' : 'Verified application'}: ${source.id} v${source.version}`
}

export function renderResults (ui, results, heading = 'Execution results') {
  ui.heading(heading)
  for (const result of results) {
    ui.separator()
    ui.line('Command', result.id)
    ui.line('Status', result.status)
    ui.output.write(`\n${ui.paint('info', 'stdout')}\n${ui.paint('separator', '------')}\n`)
    writeRaw(ui, result.result?.stdout || '(empty)')
    ui.output.write(`\n${ui.paint('error', 'stderr')}\n${ui.paint('separator', '------')}\n`)
    writeRaw(ui, result.result?.stderr || '(empty)')
  }
  ui.separator()
}

function renderTaskProgress (ui, event) {
  const prefix = event.type === 'reasoning' ? 'Codex reasoning' : `Codex ${event.type}`
  ui.output.write(`\n${ui.paint('muted', `[${prefix}]`)} ${event.message}\n`)
}

export function renderTaskRecord (ui, task) {
  ui.clear()
  ui.banner(`Task history #${task.id}`)
  renderWrappedField(ui, 'Status', task.status)
  renderWrappedField(ui, 'Kind', task.kind)
  if (task.catalogId) ui.line('Common task', task.catalogId)
  if (task.groupRunId) ui.line('Multi-host run', `#${task.groupRunId}`)
  if (task.retryOfTaskId) ui.line('Retry of task', `#${task.retryOfTaskId}`)
  if (task.retryInstructions) renderWrappedField(ui, 'Retry correction', task.retryInstructions)
  if (task.consultationIds.length > 0) ui.line('Consultation context', task.consultationIds.map(id => `#${id}`).join(', '))
  renderWrappedField(ui, 'Request', task.request)
  if (task.consultationAnswer) {
    ui.heading('Consultation answer')
    writeWrapped(ui, task.consultationAnswer)
  }
  if (task.consultationSummary) renderWrappedField(ui, 'Saved compact context', task.consultationSummary)
  if (task.consumedByTaskId) ui.line('Used by task', `#${task.consumedByTaskId}`)
  if (task.changeOverview) renderWrappedField(ui, 'Overview', task.changeOverview)
  if (task.modifiedFiles.length > 0) {
    ui.heading('Modified files and paths')
    for (const file of task.modifiedFiles) writeWrapped(ui, file)
  }
  if (task.progress.length > 0) {
    ui.heading('Codex progress')
    for (const event of task.progress) {
      if (event.type === 'health_report') {
        ui.heading('Host health report')
        writeWrapped(ui, event.message)
        if (event.contextSummary) renderWrappedField(ui, 'Reusable diagnostic context', event.contextSummary)
      } else if (event.type === 'system_update_report') {
        ui.heading('System update report')
        writeWrapped(ui, event.message)
        if (event.contextSummary) renderWrappedField(ui, 'Reusable update context', event.contextSummary)
      } else {
        writeWrapped(ui, `[${event.type}] ${event.message}`)
      }
    }
  }
  if (task.results) renderResults(ui, task.results)
  if (task.revertResults) renderResults(ui, task.revertResults, 'Revert results')
  if (task.error) ui.error(task.error)
  if (task.revertError) ui.error(task.revertError)
}

function renderWrappedField (ui, label, value) {
  const width = Math.max(10, ui.terminalSize().width - 24)
  const lines = ui.wrapText(value, width)
  ui.line(label, lines[0] ?? '')
  for (const line of lines.slice(1)) ui.output.write(`${' '.repeat(23)}${line}\n`)
}

function writeWrapped (ui, value) {
  for (const line of ui.wrapText(value, ui.terminalSize().width)) ui.output.write(`${line}\n`)
}

function writeRaw (ui, value) {
  const text = String(value ?? '')
  ui.output.write(text.endsWith('\n') ? text : `${text}\n`)
}

function renderRequirements (ui, capabilities = {}) {
  ui.clear()
  ui.banner('Server requirements')
  ui.heading('What the remote server needs')
  const requirements = [
    'OpenSSH access using a password, key, or ssh-agent.',
    'A Windows administrator, root login, passwordless sudo/doas, or a sudo password for activation.',
    'Outbound HTTPS access to get.netdata.cloud when Netdata is absent; FreeBSD can install curl through pkg.',
    'A supported Linux, FreeBSD, or x64 Windows host with a matching native plugin artifact.',
    `Port 19999 does not need external exposure; ${PRODUCT_NAME} uses remote loopback.`
  ]
  const width = Math.max(10, ui.terminalSize().width - 4)
  for (const requirement of requirements) {
    const lines = ui.wrapText(requirement, width)
    ui.output.write(`- ${lines[0]}\n`)
    for (const line of lines.slice(1)) ui.output.write(`  ${line}\n`)
  }
  ui.output.write('\n')
  for (const line of ui.wrapText('Stage 2 executes token-authenticated commands as root or Windows LocalSystem. Every command is shown before either per-command or explicit bulk approval.', ui.terminalSize().width)) ui.output.write(`${line}\n`)
  if (!capabilities.isAdministrator && !capabilities.isRoot && !capabilities.hasSudo && !capabilities.hasPasswordlessDoas) {
    ui.warn('Current account is not root and no usable sudo/doas elevation was found. Configure elevation or use a root SSH account.')
  }
  if (!capabilities.hasCurl && !capabilities.hasNetdata && capabilities.platform?.os !== 'freebsd') {
    ui.warn(`curl is missing. Install curl before asking ${PRODUCT_NAME} to install Netdata.`)
  }
}

function parseArguments (argv) {
  const options = { debug: true }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') options.help = true
    else if (argument === '--update') options.update = true
    else if (argument === '--debug') options.debug = true
    else if (argument === '--no-debug') options.debug = false
    else if (argument === '--data-root') {
      options.dataRoot = argv[++index]
      if (!options.dataRoot) throw new TypeError('--data-root requires a directory')
    } else throw new TypeError(`unknown argument: ${argument}`)
  }
  return options
}

function printHelp (ui) {
  ui.output.write(`Usage: ${CLI_NAME} --update\n`)
  ui.output.write(`       ${CLI_NAME} [--debug|--no-debug] [--data-root DIRECTORY]\n\n`)
  ui.output.write('Interactive AI-assisted administration over system OpenSSH and Netdata.\n')
  ui.output.write(`${PRODUCT_URL}\n`)
  ui.output.write(`\nUse --update to install the latest ${PRODUCT_NAME} package, then exit.\n`)
  ui.output.write('Debug tracing is enabled by default. Use --no-debug to suppress it.\n')
}

function renderDebugEvent (ui, { phase, message }) {
  ui.output.write(`\n${ui.paint('muted', `[debug:${phase}]`)} ${redactDiagnosticText(message || '')}\n`)
}

function renderConnectionProgress (ui, event, serverId = null) {
  const prefix = serverId ? `[${serverId}] ` : ''
  const message = `${prefix}${redactDiagnosticText(event?.message ?? '')}`
  if (event?.state === 'completed') ui.success(message)
  else if (event?.state === 'warning') ui.warn(message)
  else if (event?.state === 'failed') ui.error(message)
  else ui.info(message)
}

function riskTone (value) {
  if (['critical', 'high', 'destructive'].includes(value)) return 'danger'
  if (['medium', 'change'].includes(value)) return 'warning'
  if (['low', 'read'].includes(value)) return 'success'
  return undefined
}

function renderOperationError (ui, label, error, debug) {
  ui.error(`${label}: ${error.message}`)
  const details = formatDiagnosticError(error)
  if (details) {
    ui.heading('Diagnostic details')
    ui.output.write(`${details}\n`)
  }
  if (!debug) ui.info(`Rerun ${PRODUCT_NAME} with --debug for activation phase tracing and pre-rollback Netdata diagnostics.`)
}

export async function resolveDefaultDataRoot (homeDirectory, canAccess = access) {
  const current = path.join(homeDirectory, DATA_DIRECTORY_NAME)
  const legacy = path.join(homeDirectory, LEGACY_DATA_DIRECTORY_NAME)
  try {
    await canAccess(current)
    return current
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  try {
    await canAccess(legacy)
    return legacy
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return current
}
