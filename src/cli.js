import { access, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { listCommonTasks, listEligibleCommonTasks } from './common-tasks.js'
import { prepareTask } from './task-preparation.js'
import { completeTaskReport } from './task-completion-report.js'
import { withHostMutation, assertHostMutationReady } from './host-mutation-ownership.js'
import { isSystemUpdateTask } from './system-update-task.js'
import { parseSshConnection } from './connection.js'
import { VaultAuthenticationError } from './crypto-vault.js'
import { resolveDockerPolicy } from './docker-policy.js'
import { formatDiagnosticError, redactDiagnosticText } from './error-details.js'
import { HostSessionFactory } from './host-session-factory.js'
import { CodexPlanner, normalizeCodexSettings } from './codex-planner.js'
import { KubernetesClient } from './kubernetes-client.js'
import { KubernetesNetdataClient } from './kubernetes-netdata-client.js'
import { KubernetesStage2Service } from './kubernetes-stage2-service.js'
import { KubernetesTaskService } from './kubernetes-task-service.js'
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
import { TaskStore } from './task-store.js'
import { OperatorController } from './operator-controller.js'
import { startOperatorConsole } from './operator-console.js'
import { OperatorWorkspace } from './operator-workspace.js'
import { OperatorHosts } from './operator-hosts.js'
import { OperatorMetrics } from './operator-metrics.js'
import { Stage2Service } from './stage2-service.js'
import { SystemSsh } from './system-ssh.js'
import { updateIntentAiOps } from './self-update.js'
import { TerminalUi } from './terminal-ui.js'
import { FALLBACK_ADMIN_EMAIL, normalizeAdminEmailPreset } from './application-defaults.js'
import { CLI_NAME, DATA_DIRECTORY_NAME, LEGACY_DATA_DIRECTORY_NAME, PRODUCT_NAME, PRODUCT_TAGLINE, PRODUCT_URL } from './product.js'
import { isHostHealthTask, redactHealthText, sanitizeHealthResult } from './host-health-task.js'
import { detectOperationLoop } from './operation-loop-detector.js'
import { normalizeTerminalControls } from './terminal-controls.js'
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

export { redactHealthText } from './host-health-task.js'

export async function runCli ({ argv = process.argv.slice(2), input, output, selfUpdate = updateIntentAiOps } = {}) {
  const cliOptions = parseArguments(argv)
  const ui = new TerminalUi({ input, output })
  let transport
  try {
    return await runCliSession({ cliOptions, ui, selfUpdate, onTransport: value => { transport = value } })
  } finally {
    try { await transport?.closeSessions() } finally { ui.dispose() }
  }
}

async function runCliSession ({ cliOptions, ui, selfUpdate, onTransport }) {
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
  const unlocked = await unlock(ui, settingsStore)
  const settings = unlocked.settings
  const baseSsh = new SystemSsh({
    transport: settings.ssh,
    onDiagnostic: event => {
      if (cliOptions.debug && event.type !== 'channel') renderDebugEvent(ui, { phase: 'ssh-transport', message: JSON.stringify(event) })
    }
  })
  onTransport(baseSsh)
  ui.setControls(settings.controls)
  const directoryAliases = new Map(Object.entries(settings.servers).map(([serverId, server]) => [serverId, server.historyId ?? serverId]))
  const workspace = new ServerWorkspace(dataRoot, { directoryAliases })
  const taskStore = new TaskStore(dataRoot, { directoryAliases })
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
    taskStore,
    baseSsh,
    settings,
    hostRuntime,
    hostSessions,
    directoryAliases,
    labTasks: cliOptions.labTasks === true,
    get applicationDefaults () { return applicationDefaults },
    set applicationDefaults (value) { applicationDefaults = value },
    get passphrase () { return passphrase }
  }
  let recentServerId = null
  let selectedHostId = null

  if (cliOptions.console) {
    const hosts = new OperatorHosts({ factory: hostSessions, settingsStore, workspace, settings, tasks: taskStore, passphrase, credential: capabilities => chooseElevation(ui, capabilities), notify: event => controller?.record(event) })
    const controller = new OperatorController({
      dataRoot,
      settings,
      passphrase,
      tasks: taskStore,
      adminFor: serverId => hosts.lease(serverId)
    })
    const runtime = new OperatorWorkspace({ controller, hosts, metrics: new OperatorMetrics(controller) })
    const consoleServer = await startOperatorConsole({ controller, workspace: runtime, actions: cliOptions.consoleActions, port: cliOptions.webPort ?? 0 })
    ui.info(`Open ${consoleServer.url}`)
    ui.info('Press Ctrl+C in this terminal to stop the local console. SSH authentication prompts appear here when needed.')
    try { await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) }) } finally { await consoleServer.close() }
    return
  }

  for (;;) {
    const serverIds = Object.keys(settings.servers).sort()
    const clusterIds = Object.keys(settings.clusters ?? {}).sort()
    const activeHosts = serverIds.filter(serverId => settings.servers[serverId].desiredStage2 === 'active').length
    const hostRows = await buildDashboardHostRows({ context, serverIds, recentServerId })
    const interrupted = serverIds.flatMap(serverId => taskStore.interruptedTasks(serverId).map(task => `${serverId}/#${task.id}`))
    const menuOptions = mainActionOptions({
      hostCount: serverIds.length,
      clusterCount: clusterIds.length,
      recentServerId: recentServerId && settings.servers[recentServerId] ? recentServerId : null,
      codex: settings.codex
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
        `Codex: ${settings.codex.model} / ${settings.codex.reasoningEffort} reasoning`,
        ...(interrupted.length ? [`Unfinished execution (may still be active): ${interrupted.join(', ')}. Inspect task history.`] : []),
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
    if (selected === 'codex-settings') {
      await setCodexSettings({ context })
      continue
    }
    if (selected === 'controls') {
      await setTerminalControls({ context })
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

export async function setCodexSettings ({ context, planner = new CodexPlanner() }) {
  const { ui, settingsStore, settings } = context
  const current = normalizeCodexSettings(settings.codex)
  ui.clear()
  ui.banner('Codex model')
  ui.info('Loading models and supported reasoning levels from your Codex CLI...')
  let models
  try { models = await planner.listModels() } catch (error) {
    ui.warning(formatDiagnosticError(error))
    await ui.pause()
    return
  }
  const model = await ui.choose('Model', [
    ...models.map(({ model }) => ({
      value: model,
      label: `${model}${model === current.model ? ' (current)' : ''}`
    })),
    { value: null, label: 'Back without changes' }
  ])
  if (!model) return
  const selected = models.find(item => item.model === model)
  if (!selected) throw new Error('Selected model is absent from the Codex catalog')
  const reasoningEffort = await ui.choose('Reasoning effort', [
    ...selected.reasoningEfforts.map(value => ({
      value,
      label: `${value}${value === current.reasoningEffort ? ' (current)' : ''}`
    })),
    { value: null, label: 'Back without changes' }
  ])
  if (!reasoningEffort) return
  if (!selected.reasoningEfforts.includes(reasoningEffort)) throw new Error('Selected reasoning effort is unsupported by this model')
  await settingsStore.setCodexSettings({ settings, model, reasoningEffort })
  ui.success(`Codex set to ${model} with ${reasoningEffort} reasoning.`)
  await ui.pause()
}

async function setTerminalControls ({ context }) {
  const { ui, settingsStore, settings } = context
  for (;;) {
    const controls = normalizeTerminalControls(settings.controls)
    const selected = await ui.choose('Controls', [
      { value: 'wrapNavigation', label: `Wrap menu navigation: ${controls.wrapNavigation ? 'on' : 'off'}` },
      { value: 'vimKeys', label: `Vim navigation (j/k): ${controls.vimKeys ? 'on' : 'off'}` },
      { value: 'numberShortcuts', label: `Number shortcuts: ${controls.numberShortcuts ? 'on' : 'off'}` },
      { value: 'shortcutHints', label: `Shortcut hints: ${controls.shortcutHints ? 'shown' : 'hidden'}` },
      { value: 'colorMode', label: `Color mode: ${controls.colorMode}` },
      { value: null, label: 'Back' }
    ])
    if (!selected) return
    const updated = { ...controls }
    if (selected === 'colorMode') {
      updated.colorMode = await ui.choose('Color mode', [
        { value: 'auto', label: 'Automatic' },
        { value: 'color', label: 'Always use color' },
        { value: 'monochrome', label: 'Monochrome' }
      ])
    } else updated[selected] = !updated[selected]
    await settingsStore.setTerminalControls({ settings, controls: updated })
    ui.setControls(settings.controls)
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
    session = await (baseSsh.acquireSession ?? baseSsh.openInteractiveSession).call(baseSsh, connectionUrl, { authentication })
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
    let actionKey
    if (typeof kubernetes.request === 'function') {
      try { actionKey = await new KubernetesStage2Service({ kubernetes }).existingActionKey() } catch (error) {
        if (error.statusCode !== 403) throw error
        ui.warn('This kubeconfig cannot read managed gateway credentials. API inspection remains available; no additional permission will be requested.')
      }
    }
    await settingsStore.addKubernetesCluster({
      settings,
      passphrase,
      clusterId,
      kubeconfig,
      apiServer,
      contextName,
      ...(actionKey ? { actionKey } : {})
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
    dataRoot: settingsStore.dataRoot,
    onProgress: event => ui.info(`[${event.phase}] ${event.message}`)
  })
  let status = await readKubernetesStatus({ kubernetes, cluster })
  const clusterTasks = new KubernetesTaskService({ dataRoot: settingsStore.dataRoot, settings, passphrase, settingsStore, onEvent: event => ui.info(event.type) })

  for (;;) {
    const actions = [
      { label: 'Refresh status', value: 'refresh' },
      { label: 'Common tasks, persisted reviews and history', value: 'tasks' },
      { label: 'Activate/update Stage 2 gateway', value: 'activate' },
      { label: 'Remote common-task recovery availability', value: 'remote-recovery' },
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
    if (action === 'tasks') {
      try { await runKubernetesTaskMenu({ ui, clusterTasks, clusterId }) } catch (error) { ui.error(redactDiagnosticText(error.message)); await ui.pause() }
      continue
    }
    if (action === 'remote-recovery') {
      const recovery = stage2.remoteRecoveryCapabilities(status.recoveryHealth, await clusterTasks.persistentAvailable(clusterId))
      if (recovery.available) {
        try { await runKubernetesTaskMenu({ ui, clusterTasks, clusterId, remote: true }) } catch (error) { ui.error(redactDiagnosticText(error.message)) }
      } else ui.warn(recovery.reason)
      await ui.pause()
      continue
    }
    if (action === 'refresh') {
      ui.info('Refreshing Kubernetes API and Stage 2 status...')
      status = await readKubernetesStatus({ kubernetes, cluster })
      continue
    }
    if (action === 'activate') {
      const confirmed = await ui.confirm('Deploy or update the Stage 2 gateway directly through the Kubernetes API?', false)
      if (!confirmed) continue
      try {
        let recoveryStorageClass
        if (!status.recoveryHealth?.recoveryConfigured && await ui.confirm('Enable persistent signed recovery storage? This preserves a dedicated PVC across gateway deactivation.', false)) recoveryStorageClass = await ui.ask('Existing StorageClass name', { defaultValue: 'standard' })
        await stage2.activate({ actionKey: cluster.actionKey, recoveryStorageClass })
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
    plugin: health?.version ? `v${health.version}` : 'not installed',
    recoveryHealth: health
  }
}

async function runKubernetesTaskMenu ({ ui, clusterTasks, clusterId, remote = false }) {
  for (;;) {
    if (remote) {
      const listing = await clusterTasks.remoteHistory(clusterId)
      const executionId = await ui.searchChoose('Remote signed common-task records (summaries require verification)', [...listing.executions.map(entry => ({ label: `${entry.executionId} · ${entry.sequence} records`, value: entry.executionId })), { label: 'Back', value: null }])
      if (!executionId) return
      const view = await clusterTasks.prepareRecovery(clusterId, executionId)
      if (view.alreadyAbsent) { ui.info(view.message); await ui.pause(); return }
      await reviewKubernetesTask({ ui, clusterTasks, clusterId, taskId: view.taskId })
      return
    }
    const history = await clusterTasks.history(clusterId)
    const action = await ui.searchChoose('Kubernetes task workspace', [{ label: 'Prepare a verified common-task plan (no execution)', value: 'prepare' }, { label: 'Discover signed remote recovery records', value: 'remote' }, ...history.map(task => ({ label: `#${task.id} ${task.request} [${task.status}]`, value: task.id })), { label: 'Back', value: null }])
    if (!action) return
    if (action === 'remote') { await runKubernetesTaskMenu({ ui, clusterTasks, clusterId, remote: true }); continue }
    let taskId = action
    if (action === 'prepare') {
      const catalogId = await ui.searchChoose('Select a supported Kubernetes application', [...clusterTasks.catalog().map(task => ({ label: task.label, value: task.id })), { label: 'Back', value: null }])
      if (!catalogId) continue
      taskId = (await clusterTasks.prepare(clusterId, catalogId)).taskId
    }
    await reviewKubernetesTask({ ui, clusterTasks, clusterId, taskId })
  }
}

async function reviewKubernetesTask ({ ui, clusterTasks, clusterId, taskId }) {
  for (;;) {
    const view = await clusterTasks.inspect(clusterId, taskId)
    ui.heading(`Kubernetes ${clusterId} / task #${taskId}: ${view.status}`)
    ui.output.write(view.summary + '\n')
    for (const command of view.commands) ui.output.write(`[${command.risk}] ${command.id}: ${command.method} ${command.path}\n  ${command.purpose}\n`)
    for (const warning of view.warnings ?? []) ui.warn(warning)
    const action = await ui.choose('Reviewed cluster controls', [{ label: view.recovery ? 'Review and execute recovery' : 'Review and continue remaining commands', value: 'execute' }, { label: 'Pause before the next command', value: 'pause' }, { label: 'Abort remaining work (does not kill workloads)', value: 'abort' }, ...(!view.recovery ? [{ label: 'Prepare a separate recovery review', value: 'recover' }] : []), { label: 'Back', value: null }])
    if (!action) return
    if (action === 'recover') { await clusterTasks.prepareRecovery(clusterId, view.executionId); ui.info('Recovery plan saved separately. Open it from task history.'); return }
    if (action === 'execute') {
      if (!await ui.confirm('Approve exactly this saved plan for this cluster? Destructive recovery removes task-created application data.', false)) continue
      const takeoverApproved = view.takeoverRequired === true && await ui.confirm('A previous operation still owns this signed execution. Approve the displayed ownership takeover only after inspecting its workload state?', false)
      await clusterTasks.execute(clusterId, taskId, { approved: true, expectedVersion: view.expectedVersion, fingerprint: view.fingerprint, takeoverApproved, takeoverFingerprint: view.takeoverFingerprint })
    } else await clusterTasks.control(clusterId, taskId, view.expectedVersion, action)
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
  const { ui, settingsStore, workspace, taskStore, baseSsh, settings, passphrase } = context
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
        const result = await withHostMutation({ dataRoot: settingsStore.dataRoot, identity: settings.servers[entry.serverId].historyId ?? entry.serverId, before: () => assertHostMutationReady({ settingsStore, tasks: taskStore, settings, serverId: entry.serverId }) }, () => entry.stage2.activate({
          ...entry.server,
          ...entry.elevation,
          installNetdata: false
        }))
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
      ui.info('Asking Codex whether the request matches or can reuse a verified common task for each host platform...')
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
            candidates: eligibleInteractiveCommonTasks({ platform, inventory }),
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
    const controller = new OperatorController({ dataRoot: settingsStore.dataRoot, settings, passphrase, adminFor })
    let rollout
    if (await ui.confirm('Use a staged canary rollout?', false)) {
      const canaryHostId = await ui.choose('Select canary host', serverIds.map(value => ({ label: value, value })))
      rollout = { canaryHostId, batchSize: 2, failureThreshold: 1 }
    }
    const externalVerify = effectiveCatalogId === 'nginx-static-site'
      ? appliedNginxVerifier({ settingsStore, settings, passphrase })
      : null
    const run = await controller.run({
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
      rollout,
      verifyStage: ({ stage }) => ui.confirm(`Stage ${stage.id} completed. Have you verified deployment health on ${stage.hosts.map(host => host.serverId).join(', ')} before continuing?`, false),
      onEvent: event => renderMultiHostEvent(ui, event),
      review: ({ run, hosts }) => reviewMultiHostPlans(ui, run, hosts, 'Execute')
    })
    renderMultiHostRun(ui, run)
    await renderMultiHostReports({ ui, run, adminFor, settings, passphrase })
    if (run.status === 'completed') ui.success(`Multi-host run #${run.id} completed on every selected host.`)
    else if (run.status === 'cancelled') ui.warn(`Multi-host run #${run.id} was cancelled.`)
    else ui.warn(`Multi-host run #${run.id} finished ${run.status}; retry only the affected hosts from Multi-host run history.`)
  })
  await ui.pause()
}

export async function renderMultiHostReports ({ ui, run, adminFor, settings, passphrase }) {
  const render = isHostHealthTask(run.catalogId)
    ? renderAndSaveHostHealthReport
    : isSystemUpdateTask(run.catalogId) ? renderAndSaveSystemUpdateReport : null
  if (!render) return
  const platform = run.catalogId.split('-').at(-1)
  for (const host of run.hosts.filter(host => host.status === 'completed')) {
    try {
      const admin = await adminFor(host.serverId)
      const task = admin.getTask(host.serverId, host.taskId)
      const results = completedReportResults(task)
      if (!results) continue
      const inventory = await admin.refreshInventory({ settings, passphrase, serverId: host.serverId })
      ui.heading(`${host.serverId} / task #${host.taskId}`)
      await render({ ui, admin, settings, passphrase, serverId: host.serverId, task: { ...task, catalogId: run.catalogId }, platform, inventory, results })
    } catch (error) {
      ui.warn(`[${host.serverId}] Report unavailable; command outcomes remain recorded: ${redactHealthText(error.message)}`)
    }
  }
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
  const label = event.serverId ?? `run #${event.runId}`
  const message = event.message ?? (event.type === 'rollout-stage' ? `Starting rollout stage ${event.stage}; ${event.pendingHosts} hosts pending.` : event.type)
  ui.output.write(`\n${ui.paint('info', `[${label}]`)} ${message}\n`)
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
        await withHostMutation({ dataRoot: settingsStore.dataRoot, identity: settings.servers[serverId].historyId ?? serverId }, () => ui.withTerminalSuspended(() => ssh.interactiveShell(server.connectionUrl)))
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
        const definitions = catalogChoiceRows(eligibleInteractiveCommonTasks({ platform: taskPlatform, inventory, status, labTasks: context.labTasks }))
        const definition = await ui.searchableDetailChoose({
          title: `Verified ${taskPlatform} tasks eligible for this host${context.labTasks && taskPlatform === 'linux' ? ' (includes disposable lab fixtures)' : ''}`,
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
      if (selected === 'remote-recovery') {
        try { await browseRemoteCommonTasks({ ui, admin, settings, passphrase, serverId, status, applicationDefaults }) } catch (error) {
          ui.error(redactDiagnosticText(error.message))
          await ui.pause()
        }
      }
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
  let task
  let inventory
  let effectiveCatalogId
  try {
    ui.info('Preparing a persisted plan for review; no commands will execute yet...')
    const prepared = await prepareTask({ admin, settings, passphrase, serverId, request, catalogId, retryOfTaskId: previousAttempts.at(-1)?.id ?? null, retryInstructions, onProgress: event => renderTaskProgress(ui, event) })
    task = admin.getTask(serverId, prepared.taskId)
    inventory = prepared.inventory
    effectiveCatalogId = task.catalogId
    renderTaskRouting(ui, prepared.routing)
    const plan = task.plan
    renderPlan(ui, plan)
    const approvalMode = await chooseApprovalMode(ui, plan.commands)
    if (!approvalMode) {
      admin.cancelTask(serverId, task.id)
      return
    }
    admin.markTaskRunning(serverId, task.id)
    const healthTask = isHostHealthTask(effectiveCatalogId)
    const updateTask = isSystemUpdateTask(effectiveCatalogId)
    const interactive = await ui.confirm('Enable intervention at command boundaries?', false)
    const controller = new OperatorController({ dataRoot: admin.dataRoot, settings, passphrase, tasks: admin.tasks, adminFor: async () => admin })
    const results = await admin.execute({
      settings,
      passphrase,
      serverId,
      taskId: task.id,
      plan,
      onProgress: event => renderTaskProgress(ui, event),
      beforeCommand: interactive
        ? async item => {
          const action = await ui.choose(`Next command: ${item.id}`, [
            { label: 'Continue to normal approval', value: 'run' },
            { label: 'Inspect execution and pause', value: 'pause' },
            { label: 'Abort remaining work', value: 'abort' }
          ])
          if (action === 'run') return true
          controller.control(serverId, task.id, action ?? 'pause', admin.tasks.stateVersion(serverId, task.id))
          return false
        }
        : undefined,
      onResult: result => admin.appendTaskResult(serverId, task.id, (healthTask || updateTask) ? sanitizeHealthResult(result) : result),
      approve: approvalMode === 'all'
        ? async () => true
        : item => approveCommand(ui, item),
      requireRevert: !updateTask
    })
    const savedResults = (healthTask || updateTask) ? results.map(sanitizeHealthResult) : results
    admin.saveTaskResults(serverId, task.id, savedResults)
    renderResults(ui, savedResults)
    if (admin.tasks.control(serverId, task.id).action !== 'run') await manageExecution({ ui, controller, serverId, taskId: task.id })
    const reportResults = completedReportResults(admin.getTask(serverId, task.id))
    if (healthTask && reportResults) {
      await renderAndSaveHostHealthReport({
        ui,
        admin,
        settings,
        passphrase,
        serverId,
        task,
        platform: status.capabilities.platform?.os,
        inventory,
        results: reportResults
      })
    }
    if (updateTask && reportResults) {
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
        results: reportResults
      })
    }
  } catch (error) {
    if (task) admin.saveTaskError(serverId, task.id, error)
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
  if (task.plan) actions.unshift({ label: 'Operator controls: inspect, pause, revise and resume', value: 'operator' })
  if (task.plan && ['running', 'partial', 'failed'].includes(task.status)) actions.unshift({ label: 'Inspect durable execution and recovery', value: 'recover' })
  const action = await ui.choose('History action', actions)
  if (action === 'operator') {
    const controller = new OperatorController({ dataRoot: admin.dataRoot, settings, passphrase, tasks: admin.tasks, adminFor: async () => admin })
    await manageExecution({ ui, controller, serverId, taskId: task.id })
  } else if (action === 'recover') {
    if (!admin.tasks.executionEvents(serverId, task.id).length) {
      ui.warn('This task has no execution journal. Its remote outcome cannot be inferred safely.')
      await ui.pause()
      return
    }
    const controller = new OperatorController({ dataRoot: admin.dataRoot, settings, passphrase, tasks: admin.tasks, adminFor: async () => admin })
    await controller.reconcile(serverId, task.id, admin.tasks.stateVersion(serverId, task.id), event => renderTaskProgress(ui, event))
    await manageExecution({ ui, controller, serverId, taskId: task.id })
  } else if (action === 'retry' || action === 'retry-extra') {
    let retryInstructions = null
    if (action === 'retry-extra') {
      retryInstructions = await ui.editor(`Additional corrections for retry of task #${task.id}`)
      if (!retryInstructions) return
    }
    const previousAttempts = admin.getTaskRetryHistory(serverId, task.id)
    const loop = detectOperationLoop(previousAttempts, settings.operationLoop)
    if (loop.detected) {
      ui.warn(loop.reason)
      if (!retryInstructions) retryInstructions = await ui.editor('Describe an alternative diagnostic or repair strategy')
      if (!retryInstructions) return
    }
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

export async function manageExecution ({ ui, controller, serverId, taskId }) {
  for (;;) {
    const view = controller.inspect(serverId, taskId)
    const localTask = controller.tasks.get(serverId, taskId)
    const localRevisions = controller.tasks.revisions(serverId, taskId)
    const refreshableCatalog = localTask.kind === 'catalog' && listCommonTasks({ category: 'application' }).find(definition => definition.id === localTask.catalogId && ['linux', 'freebsd'].includes(definition.platform) && (!definition.prerequisite || definition.id === 'podman-freebsd'))
    ui.clear()
    ui.banner(`Operator / ${serverId} / task #${taskId}`)
    ui.line('Task status', view.task.status)
    ui.renderTable([{ key: 'commandId', label: 'COMMAND' }, { key: 'status', label: 'STATE' }], view.commands)
    const action = await ui.choose('Execution controls', [
      { label: 'Inspect recorded commands and results', value: 'inspect' },
      { label: 'Pause at next command boundary', value: 'pause' },
      { label: 'Ask Codex a read-only question', value: 'analyze' },
      { label: 'Revise remaining steps', value: 'propose' },
      ...(refreshableCatalog ? [{ label: `Refresh remaining native ${refreshableCatalog.platform === 'freebsd' ? 'FreeBSD' : 'Linux'} catalog steps`, value: 'refresh-catalog' }] : []),
      { label: 'Propose rollback of confirmed changes', value: 'propose-rollback' },
      { label: 'Reconcile durable remote outcomes', value: 'reconcile' },
      { label: 'Record independently verified uncertain outcome', value: 'resolve' },
      { label: 'Review and resume', value: 'resume' },
      { label: 'Abort remaining work', value: 'abort' },
      { label: 'Review rollback', value: 'rollback' },
      ...(view.revisions.some(revision => !revision.approved) ? [{ label: 'Review a pending plan revision', value: 'review-revision' }] : []),
      { label: 'Back', value: null }
    ])
    if (!action) return
    try {
      if (action === 'inspect') {
        renderPlan(ui, localTask.plan)
        renderResults(ui, localTask.results ?? [])
        ui.output.write(`${JSON.stringify(view.revisions.map(item => ({ id: item.id, parentId: item.parentId, approved: item.approved })), null, 2)}\n`)
      } else if (action === 'pause' || action === 'abort') controller.control(serverId, taskId, action, view.stateVersion)
      else if (action === 'analyze') {
        const question = await ui.editor('Read-only question')
        if (question) ui.output.write(`${(await controller.analyze(serverId, taskId, question)).answer}\n`)
      } else if (action === 'reconcile') await controller.reconcile(serverId, taskId, view.stateVersion, event => renderTaskProgress(ui, event))
      else if (action === 'resolve') {
        const uncertain = [...view.commands, ...view.rollbackCommands].filter(command => command.status === 'uncertain')
        if (!uncertain.length) throw new Error('No uncertain commands')
        const command = await ui.choose('Independently verified command', uncertain.map(command => ({ label: `${command.commandId} / ${command.rollbackRevision ? 'rollback' : 'deployment'}`, value: command })))
        if (!command) continue
        const status = await ui.choose('Verified remote outcome', [{ label: 'Completed', value: 'completed' }, { label: 'Failed or partially applied', value: 'failed' }])
        const evidence = await ui.editor('Authoritative remote evidence, without credentials')
        if (await ui.confirm('Attest this outcome without repeating the command?', false)) controller.resolve(serverId, taskId, view.stateVersion, command.commandId, status, evidence, command.rollbackRevision)
      } else if (action === 'refresh-catalog') {
        ui.info('Refreshing inventory and rebuilding trusted catalog steps. No AI call or command execution is performed.')
        const proposal = await controller.proposeCatalogRefresh(serverId, taskId, view.stateVersion)
        ui.output.write(`${JSON.stringify(proposal.differences, null, 2)}\n`)
        renderPlan(ui, controller.tasks.revisions(serverId, taskId).find(revision => revision.id === proposal.revisionId).plan)
        if (await ui.confirm('Approve this replacement plan exactly as shown?', false)) controller.approve(serverId, taskId, proposal.revisionId, proposal.expectedVersion, proposal.fingerprint)
      } else if (action === 'propose' || action === 'propose-rollback') {
        const instructions = await ui.editor('Changes to remaining work')
        if (!instructions) continue
        ui.info('Asking Codex for a replacement plan. No commands execute until separate approval and resume.')
        const proposal = await controller.propose(serverId, taskId, instructions, view.stateVersion, action === 'propose-rollback')
        ui.output.write(`${JSON.stringify(proposal.differences, null, 2)}\n`)
        renderPlan(ui, controller.tasks.revisions(serverId, taskId).find(revision => revision.id === proposal.revisionId).plan)
        if (await ui.confirm('Approve this replacement plan exactly as shown?', false)) controller.approve(serverId, taskId, proposal.revisionId, proposal.expectedVersion, proposal.fingerprint)
      } else if (action === 'review-revision') {
        const revision = await ui.choose('Pending plan revision', view.revisions.filter(revision => !revision.approved).map(revision => ({ label: `#${revision.id} / ${revision.plan.operatorRollback ? 'rollback' : 'remaining work'} / parent #${revision.parentId}`, value: revision })))
        if (!revision) continue
        ui.output.write(`${JSON.stringify(revision.differences, null, 2)}\n`)
        renderPlan(ui, localRevisions.find(item => item.id === revision.id).plan)
        if (await ui.confirm('Approve this replacement plan exactly as shown?', false)) controller.approve(serverId, taskId, revision.id, view.stateVersion, revision.fingerprint)
      } else if (action === 'resume') {
        renderPlan(ui, localTask.plan)
        if (await ui.confirm('Execute remaining steps of this reviewed plan?', false)) await controller.resume(serverId, taskId, view.stateVersion, view.fingerprint, event => renderTaskProgress(ui, event))
      } else if (action === 'rollback') {
        const revision = [...localRevisions].reverse().find(item => item.approved && item.plan.operatorRollback)
        renderCommandList(ui, revision?.plan.commands ?? localTask.plan.revertCommands, 'Reviewed rollback')
        if (await ui.confirm('Execute these reviewed rollback commands?', false)) await controller.rollback(serverId, taskId, view.stateVersion, revision ? view.reviewedRollbackFingerprint : view.rollbackFingerprint, revision?.id)
      }
    } catch (error) { ui.error(error.message) }
    await ui.pause()
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
      onProgress: event => renderTaskProgress(ui, event),
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
  if (item.executionMode === 'job') ui.line('Execution', 'durable signed job')
  if (item.retry) ui.line('Retry policy', `${item.retry.attempts} attempts, ${item.retry.intervalMs}ms delay, exits ${item.retry.exitCodes.join(', ')}${item.retry.states ? `, states ${item.retry.states.join(', ')}` : ''}; never unknown or cancelled`)
  ui.line('Root required', item.requiresSudo ? 'yes' : 'no')
  ui.separator()
  writeRaw(ui, item.command)
  ui.separator()
  return ui.confirm('Execute this command?', false)
}

async function browseRemoteCommonTasks ({ ui, admin, settings, passphrase, serverId, status, applicationDefaults }) {
  const connection = { settings, passphrase, serverId }
  const action = await ui.choose('Remote common-task recovery', [
    { label: 'Browse and verify recorded tasks', value: 'browse' },
    { label: 'Review signing-key rotation', value: 'rotate' },
    { label: 'Review a published signing-key change', value: 'accept-key' },
    { label: 'Back', value: null }
  ])
  if (!action) return
  if (action !== 'browse') {
    const key = await admin.inspectRemoteRecoveryKey(connection)
    ui.line('Target identity', key.target)
    ui.line('Trusted key', key.pinnedFingerprint)
    ui.line('Published key', key.publishedFingerprint)
    ui.warn('Rotation retains historical public keys. An old-key-signed transition does not prove safety if that key or remote administrator was compromised.')
    if (action === 'rotate' && key.changed) throw new Error('Investigate the changed signing key before requesting another rotation')
    if (action === 'accept-key' && !key.changed) {
      ui.info('The published signing key already matches the trusted pin.')
      await ui.pause()
      return
    }
    if (!await ui.confirm(action === 'rotate' ? 'Rotate this host recovery key now? Active ledger owners will block rotation.' : 'Accept this published key only if its signed transition matches the trusted key?', false)) return
    const result = action === 'rotate'
      ? await admin.rotateRemoteRecoveryKey({ ...connection, expectedFingerprint: key.pinnedFingerprint, approved: true })
      : await admin.acceptRemoteRecoveryKeyRotation({ ...connection, expectedFingerprint: key.pinnedFingerprint, publishedFingerprint: key.publishedFingerprint, approved: true })
    ui.line('Trusted replacement key', result.fingerprint)
    ui.success('Recovery key transition verified and recorded. No task was replayed.')
    await ui.pause()
    return
  }
  let after = ''
  while (true) {
    const listing = await admin.listRemoteCommonTasks({ ...connection, after })
    if (listing.available === false || !listing.executions?.length) {
      ui.info('No signed remote common-task records are available on this host.')
      await ui.pause()
      return
    }
    const selected = await ui.choose('Remote common-task executions (verify before recovery)', [
      ...listing.executions.map(item => ({ label: `${item.executionId} (${item.sequence} records)`, value: item.executionId })),
      ...(listing.executions.length === 10 ? [{ label: 'Next page', value: 'next' }] : []),
      { label: 'Back', value: 'back' }
    ])
    if (!selected || selected === 'back') return
    if (selected === 'next') { after = listing.executions.at(-1).executionId; continue }
    const verified = await admin.inspectRemoteCommonTask({ ...connection, executionId: selected })
    const original = verified.records[0]
    ui.line('Common task', original.catalogId)
    ui.line('Original task ID', original.taskId)
    ui.line('Signed records', verified.sequence)
    ui.line('Last observed event', verified.records.at(-1).event)
    ui.line('Recorded outcome', verified.records.at(-1).outcome)
    ui.info('Signature and host identity verified. This is remote evidence, not local execution history or approval.')
    if (!await ui.confirm('Inspect the baseline and generate a new recovery plan?', false)) continue
    const inventory = await admin.refreshInventory(connection)
    const options = {
      platform: status.capabilities.platform?.os,
      linuxContext: inventory.webminaiLinuxContext,
      windowsExecution: inventory.webminaiExecution,
      freebsdExecution: inventory.webminaiExecution,
      macosExecution: inventory.webminaiExecution,
      docker: inventory.webminaiDocker,
      applicationDefaults
    }
    const proposal = await admin.prepareRemoteCommonTaskRecovery({ ...connection, executionId: selected, options })
    renderPlan(ui, proposal.plan)
    let takeoverApproved = false
    if (proposal.ownership?.owned) {
      ui.warn('This completed source still has a remote owner. Taking ownership will fence that session. Unknown or partial source work cannot use this recovery path.')
      takeoverApproved = await ui.confirm('Take ownership of this confirmed source for the reviewed recovery?', false)
      if (!takeoverApproved) { admin.cancelTask(serverId, proposal.taskId); continue }
    }
    const approvalMode = await chooseApprovalMode(ui, proposal.plan.commands, 'recovery commands')
    if (!approvalMode) { admin.cancelTask(serverId, proposal.taskId); continue }
    try {
      const results = await admin.executeRemoteCommonTaskRecovery({
        ...connection,
        taskId: proposal.taskId,
        options,
        ...(takeoverApproved ? { takeoverApproved: true, takeoverFingerprint: proposal.ownership.ownerFingerprint } : {}),
        approve: approvalMode === 'all' ? async () => true : item => approveCommand(ui, item),
        onProgress: event => renderTaskProgress(ui, event),
        onResult: result => admin.appendTaskResult(serverId, proposal.taskId, result)
      })
      admin.saveTaskResults(serverId, proposal.taskId, results)
      renderResults(ui, results)
    } catch (error) {
      admin.saveTaskError(serverId, proposal.taskId, error)
      throw error
    }
    await ui.pause()
  }
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

export function eligibleInteractiveCommonTasks (options) {
  const context = commonTaskContext(options)
  return [
    ...listEligibleCommonTasks({ ...context, category: 'maintenance' }),
    ...listEligibleCommonTasks({ ...context, category: 'diagnostic' }),
    ...listEligibleCommonTasks({ ...context, category: 'application' }),
    ...(options.labTasks === true && context.platform === 'linux' ? listEligibleCommonTasks({ ...context, category: 'system' }) : [])
  ]
}

async function renderAndSaveSystemUpdateReport ({ ui, admin, settings, passphrase, serverId, task, platform, inventory, results }) {
  const safeReport = await completeTaskReport({ admin, settings, passphrase, serverId, task: { ...task, status: 'completed' }, platform, inventory, results, onProgress: event => renderTaskProgress(ui, event) })
  ui.heading('System update report')
  writeWrapped(ui, safeReport.answer)
  ui.separator()
  renderWrappedField(ui, 'Reusable update context', safeReport.contextSummary)
}

async function renderAndSaveHostHealthReport ({ ui, admin, settings, passphrase, serverId, task, platform, inventory, results }) {
  const safeReport = await completeTaskReport({ admin, settings, passphrase, serverId, task: { ...task, status: 'completed' }, platform, inventory, results, onProgress: event => renderTaskProgress(ui, event) })
  ui.heading('Host health report')
  writeWrapped(ui, safeReport.answer)
  ui.separator()
  renderWrappedField(ui, 'Reusable diagnostic context', safeReport.contextSummary)
}

export function completedReportResults (task) {
  if (task.status !== 'completed' || !task.plan?.commands?.length) return null
  const byId = new Map((task.results ?? []).map(result => [result.id, result]))
  const results = task.plan.commands.map(command => byId.get(command.id))
  return results.every(result => result?.status === 'completed') ? results : null
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
    if (item.executionMode === 'job') ui.line('Execution', 'durable signed job')
    if (item.retry) ui.line('Retry policy', `${item.retry.attempts} attempts, ${item.retry.intervalMs}ms delay, exits ${item.retry.exitCodes.join(', ')}${item.retry.states ? `, states ${item.retry.states.join(', ')}` : ''}; never unknown or cancelled`)
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
    if (result.diagnostics?.length) for (const diagnostic of result.diagnostics) ui.line(`${diagnostic.code} (${diagnostic.confidence})`, `${diagnostic.explanation} ${diagnostic.nextAction}`)
    ui.output.write(`\n${ui.paint('info', 'stdout')}\n${ui.paint('separator', '------')}\n`)
    writeRaw(ui, result.result?.stdout || '(empty)')
    ui.output.write(`\n${ui.paint('error', 'stderr')}\n${ui.paint('separator', '------')}\n`)
    writeRaw(ui, result.result?.stderr || '(empty)')
  }
  ui.separator()
}

function renderTaskProgress (ui, event) {
  const prefix = event.phase === 'execution-retry' ? `Retry / ${event.commandId}` : event.phase === 'execution-diagnostics' ? `Evidence / ${event.commandId} / ${event.outcome}` : event.phase === 'execution-recovery' ? `Recovery / ${event.commandId}` : event.type === 'reasoning' ? 'Codex reasoning' : `Codex ${event.type}`
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
    ui.heading('Task progress')
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
        writeWrapped(ui, `[${event.type ?? event.phase ?? 'progress'}] ${event.message}`)
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
    else if (argument === 'console' || argument === '--web') options.console = true
    else if (argument === '--web-port') {
      const value = argv[++index]
      if (!value || !/^\d{1,5}$/u.test(value) || Number(value) > 65535) throw new TypeError('--web-port requires a port between 0 and 65535')
      options.webPort = Number(value)
    } else if (argument === '--console-actions') options.consoleActions = true
    else if (argument === '--update') options.update = true
    else if (argument === '--debug') options.debug = true
    else if (argument === '--no-debug') options.debug = false
    else if (argument === '--lab-tasks') options.labTasks = true
    else if (argument === '--data-root') {
      options.dataRoot = argv[++index]
      if (!options.dataRoot) throw new TypeError('--data-root requires a directory')
    } else throw new TypeError(`unknown argument: ${argument}`)
  }
  if (!options.console && (options.consoleActions || options.webPort !== undefined)) throw new TypeError('--console-actions and --web-port require --web or console')
  if (options.console && (options.update || options.labTasks)) throw new TypeError('--web/console cannot be combined with --update or --lab-tasks')
  return options
}

function printHelp (ui) {
  ui.output.write(`Usage: ${CLI_NAME} --update\n`)
  ui.output.write(`       ${CLI_NAME} console [--console-actions] [--data-root DIRECTORY]\n`)
  ui.output.write(`       ${CLI_NAME} --web [--console-actions] [--web-port PORT] [--data-root DIRECTORY]\n`)
  ui.output.write(`       ${CLI_NAME} [--debug|--no-debug] [--lab-tasks] [--data-root DIRECTORY]\n\n`)
  ui.output.write('Interactive AI-assisted administration over system OpenSSH and Netdata.\n')
  ui.output.write(`${PRODUCT_URL}\n`)
  ui.output.write(`\nUse --update to install the latest ${PRODUCT_NAME} package, then exit.\n`)
  ui.output.write('Debug tracing is enabled by default. Use --no-debug to suppress it.\n')
  ui.output.write('Use --lab-tasks only on disposable Linux labs to include system fixtures in the verified task picker. Normal plan review is still required.\n')
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
