import { buildLinuxComposeReferenceContext } from './linux-host-context.js'
import { buildWooCommerceTask } from './woocommerce-task.js'
import { buildJoomlaTask } from './joomla-task.js'
import { buildDrupalTask } from './drupal-task.js'
import { buildPrestaShopTask } from './prestashop-task.js'
import { buildMoodleTask } from './moodle-task.js'
import { buildMagentoTask } from './magento-task.js'
import { buildN8nTask } from './n8n-task.js'
import { buildGhostTask } from './ghost-task.js'
import { buildMattermostTask } from './mattermost-task.js'
import { buildOdooTask } from './odoo-task.js'
import { buildJellyfinTask } from './jellyfin-task.js'
import { buildHomeAssistantTask } from './home-assistant-task.js'

const BUILDERS = {
  woocommerce: buildWooCommerceTask,
  joomla: buildJoomlaTask,
  drupal: buildDrupalTask,
  prestashop: buildPrestaShopTask,
  moodle: buildMoodleTask,
  magento: buildMagentoTask,
  n8n: buildN8nTask,
  ghost: buildGhostTask,
  mattermost: buildMattermostTask,
  odoo: buildOdooTask,
  jellyfin: buildJellyfinTask,
  'home-assistant': buildHomeAssistantTask
}

const CREDENTIAL_NAMES = {
  woocommerce: 'woocommerce_credentials',
  joomla: 'joomla_credentials',
  drupal: 'drupal_credentials',
  prestashop: 'prestashop_credentials',
  moodle: 'moodle_credentials',
  magento: 'magento_credentials',
  n8n: 'n8n_credentials',
  ghost: 'ghost_credentials',
  mattermost: 'mattermost_credentials',
  odoo: 'odoo_credentials',
  jellyfin: 'jellyfin_credentials',
  'home-assistant': 'home_assistant_credentials'
}

const HOST_DATA_ROOTS = {
  jellyfin: '/var/lib/webminai-jellyfin-18113',
  'home-assistant': '/var/lib/webminai-home-assistant-18115'
}

export function buildMacosComposeTask (application, taskId, execution = {}, docker = {}) {
  const build = BUILDERS[application]
  if (!build) throw new Error(`unknown macOS Compose application: ${application}`)
  validateExecution(execution, docker)
  const home = execution.runtimeHome
  const user = execution.runtimeUser
  const serviceRoot = `${home}/.webminai/services/${application}`
  const credentials = `${home}/.webminai/credentials/${application}`
  const addressCommand = "ifconfig | awk '/^[a-z0-9]+:/{iface=$1; sub(/:$/,\"\",iface)} /inet / && $2 != \"127.0.0.1\" {print $2; exit}'"
  const linuxContext = buildLinuxComposeReferenceContext({ architecture: execution.architecture, primaryAddressCommand: addressCommand })
  const built = build(taskId, linuxContext, { preferred: true, ready: true, installSupported: true, installMethod: 'homebrew-colima' })
  const original = JSON.stringify(built.plan)
  const originalState = firstMatch(original, new RegExp(`/var/lib/webminai/task-state/${taskId}-[A-Za-z0-9-]+`, 'u'))
  if (!originalState) throw new Error(`${application} Compose plan does not expose a task state path`)
  const state = originalState.replace('/var/lib/webminai', '/var/db/webminai')
  const originalServiceRoot = firstMatch(original, /\/opt\/webminai\/services\/[A-Za-z0-9-]+/u)
  const credentialName = CREDENTIAL_NAMES[application]
  const originalCredentials = `/root/${credentialName}`
  const originalDataRoot = HOST_DATA_ROOTS[application] ?? null
  const dataRoot = originalDataRoot ? `${home}/.webminai/data/${application}` : null
  const paths = { home, originalState, state, originalServiceRoot, serviceRoot, originalCredentials, credentials, originalDataRoot, dataRoot }
  const images = extractImages(built.plan.commands.find(item => item.id === 'capture-baseline')?.command ?? original)

  for (const item of [...built.plan.commands, ...built.plan.revertCommands]) {
    item.command = adapt(item.command, paths)
  }
  replace(built.plan.commands, 'capture-baseline', baseline({ state, serviceRoot, credentials, images, home }))
  replace(built.plan.commands, 'prepare-docker', dockerReady(state, home))
  replace(built.plan.revertCommands, 'restore-docker', withDocker(`set -eu; rm -rf -- ${quote(state)}; printf '%s\n' colima-preserved`, home))
  const credentialCommand = built.plan.commands.find(item => item.id === 'generate-credentials')
  if (credentialCommand) {
    credentialCommand.command += `; chown ${quote(user)}:staff ${quote(`${home}/.webminai`)}; chmod 0700 ${quote(`${home}/.webminai`)}; install -d -o ${quote(user)} -g staff -m 0700 ${quote(`${home}/.webminai/credentials`)}; chown -R ${quote(user)}:staff ${quote(credentials)}; chmod 0700 ${quote(credentials)}; find ${quote(credentials)} -type f -exec chmod 0600 {} +`
  }
  const composeCommand = built.plan.commands.find(item => item.id === 'write-compose')
  if (composeCommand) {
    composeCommand.command += `; chown ${quote(user)}:staff ${quote(`${home}/.webminai/services`)}; chown -R ${quote(user)}:staff ${quote(serviceRoot)}; chmod 0750 ${quote(`${home}/.webminai/services`)}; chmod 0700 ${quote(serviceRoot)}`
    if (dataRoot) composeCommand.command += `; chown -R ${quote(user)}:staff ${quote(dataRoot)}; chmod 0755 ${quote(dataRoot)}`
    if (application === 'jellyfin') composeCommand.command += `; chmod 0777 ${quote(`${dataRoot}/config`)} ${quote(`${dataRoot}/cache`)}; chmod 0755 ${quote(`${dataRoot}/media`)}`
  }
  if (application === 'n8n') adaptN8nStartup(built.plan.commands)
  for (const item of [...built.plan.commands, ...built.plan.revertCommands]) {
    if (item.id.includes('swap')) item.command = withDocker("printf '%s\n' macos-colima-memory-managed", home)
    if (!['capture-baseline', 'prepare-docker', 'generate-credentials', 'write-compose', 'remove-compose-files', 'restore-docker'].includes(item.id)) {
      item.executionMode = 'job'
      item.timeoutMs = Math.max(item.timeoutMs ?? 300000, 30 * 60 * 1000)
    }
  }
  built.plan.summary = built.plan.summary.replace(/(learned reversible )/u, '$1macOS ')
  built.plan.changeOverview = `Reuse the promoted ismet ${application} Compose matrix through the reviewed Colima socket, with macOS-home bind paths and host-generated protected credentials.`
  built.plan.modifiedFiles = [...new Set(built.plan.modifiedFiles.map(path => adaptPath(path, paths)).filter(path => !/^\/(etc\/apt|var\/lib\/(docker|containerd))/u.test(path)))]
  if (built.plan.applicationDelta) {
    built.plan.applicationDelta = adaptApplicationDelta(built.plan.applicationDelta, paths)
  }
  built.plan.assumptions = [
    'Signed macOS inventory reports the reviewed Colima Docker and Compose substrate ready.',
    'The shared Colima VM is preserved by application rollback.',
    `Credentials are host-generated and restricted to the detected Colima owner ${user} for virtiofs access.`
  ]
  built.plan.warnings = [...new Set([...(built.plan.warnings ?? []), 'This macOS route reuses only the already promoted ismet Compose inputs and does not install a native macOS application runtime.'])]
  built.verifyApplied = adapt(built.verifyApplied, paths)
  built.verifyReverted = adapt(built.verifyReverted, paths)
  built.stateProbe = adapt(built.stateProbe, paths)
  if (application === 'home-assistant') {
    adaptHomeAssistantIdempotency(built.plan.commands, dataRoot)
    built.verifyApplied = adaptHomeAssistantVerification(built.verifyApplied)
  }
  return built
}

function adaptHomeAssistantIdempotency (commands, dataRoot) {
  const start = commands.find(item => item.id === 'start-compose')
  const initialize = commands.find(item => item.id === 'initialize-home-assistant')
  const verify = commands.find(item => item.id === 'verify-compose')
  if (!start || !initialize || !verify || !dataRoot) throw new Error('Home Assistant Compose plan is missing idempotency inputs')
  start.command = removeHomeAssistantProxyWait(start.command)
  const initialized = '; fi; curl --fail'
  const initializedAt = initialize.command.lastIndexOf(initialized)
  if (initializedAt < 0) throw new Error('Home Assistant initialization shape changed')
  initialize.command = `${initialize.command.slice(0, initializedAt + 6)} test -s ${quote(`${dataRoot}/.storage/auth`)}; grep -Fq 'WEBMINAI_HOME_ASSISTANT_OK' ${quote(`${dataRoot}/configuration.yaml`)}; printf '%s\n' initialized`
  const onboarding = 'curl --fail --silent --show-error http://127.0.0.1:18115/api/onboarding | '
  const onboardingAt = verify.command.indexOf(onboarding)
  const persistedAt = verify.command.indexOf('; test -s ', onboardingAt)
  if (onboardingAt < 0 || persistedAt < 0) throw new Error('Home Assistant verification shape changed')
  verify.command = adaptHomeAssistantVerification(`${verify.command.slice(0, onboardingAt)}:${verify.command.slice(persistedAt)}`)
}

function adaptHomeAssistantVerification (command) {
  const page = "curl --fail --silent --show-error http://127.0.0.1:18115/homeassistant/ | grep -Fqi 'home assistant'; "
  if (!command.includes(page)) throw new Error('Home Assistant macOS proxy verification shape changed')
  let adapted = removeHomeAssistantProxyWait(command).replace(page, '')
  const onboarding = 'curl --fail --silent --show-error http://127.0.0.1:18115/api/onboarding | '
  const onboardingAt = adapted.indexOf(onboarding)
  if (onboardingAt >= 0) {
    const persistedAt = adapted.indexOf('; test -s ', onboardingAt)
    if (persistedAt < 0) throw new Error('Home Assistant macOS onboarding verification shape changed')
    adapted = `${adapted.slice(0, onboardingAt)}:${adapted.slice(persistedAt)}`
  }
  return adapted
}

function removeHomeAssistantProxyWait (command) {
  const wait = /ready=; for attempt in \$\(jot \d+\); do if curl --fail --silent --show-error --max-time 5 'http:\/\/127\.0\.0\.1:18115\/homeassistant\/' >\/dev\/null 2>&1; then ready=yes; break; fi; sleep 2; done; \[ "\$ready" = yes \]; /u
  if (!wait.test(command)) throw new Error('Home Assistant macOS proxy readiness shape changed')
  return command.replace(wait, '')
}

function adaptN8nStartup (commands) {
  const command = commands.find(item => item.id === 'start-compose')
  if (!command) throw new Error('n8n Compose plan is missing start-compose')
  const compose = "docker compose -p 'webminai-n8n-18109'"
  const original = `${compose} up -d;`
  if (!command.command.includes(original)) throw new Error('n8n Compose startup shape changed')
  command.command = command.command
    .replace(original, `${compose} up -d n8n;`)
    .replace("[ \"$ready\" = yes ]; printf '%s\\n' compose-ready", `[ "$ready" = yes ]; ${compose} up -d; printf '%s\\n' compose-ready`)
}

function validateExecution (execution, docker) {
  if (execution.platform !== 'macos') throw new Error('macOS Compose requires signed macOS execution inventory')
  if (!/^[a-z_][a-z0-9_-]{0,31}$/u.test(execution.runtimeUser ?? '') || !/^\/Users\/[a-z_][a-z0-9_-]{0,31}$/u.test(execution.runtimeHome ?? '')) throw new Error('macOS Compose requires a reviewed non-root Homebrew owner')
  if (docker.ready !== true) throw new Error('macOS Compose requires the reviewed Colima prerequisite')
}

function adapt (command, paths) {
  let value = String(command)
  for (const [from, to] of [[paths.originalState, paths.state], [paths.originalServiceRoot, paths.serviceRoot], [paths.originalCredentials, paths.credentials], [paths.originalDataRoot, paths.dataRoot], ['/var/lib/webminai/', `${paths.home}/.webminai/artifacts/`], ['/srv/', `${paths.home}/.webminai/data/`]]) {
    if (from) value = value.replaceAll(from, to)
  }
  value = value.replaceAll('-g root', '-g wheel').replaceAll('$(seq 1 ', '$(jot ')
  value = value
    .replaceAll("primary=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (field=1; field<=NF; field++) if ($field == \"src\") { print $(field+1); exit }}' || true)", "iface=$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}'); primary=$(ipconfig getifaddr \"$iface\" 2>/dev/null || true)")
    .replaceAll("[ -n \"$primary\" ] || primary=$(hostname -I 2>/dev/null | awk '{print $1}')", ':')
    .replaceAll("stat -c '%a'", "stat -f '%Lp'")
    .replaceAll('stat -c %a', 'stat -f %Lp')
    .replaceAll("stat -c '%U'", "stat -f '%Su'")
    .replaceAll("grep -Fi 'home assistant'", "grep -Fqi 'home assistant'")
    .replace(/(docker compose[^;]*? pull)([^;]*);/gu, '$1 --quiet$2;')
  return withDocker(value, paths.home)
}

function adaptPath (path, paths) {
  let value = String(path)
  for (const [from, to] of [[paths.originalState, paths.state], [paths.originalServiceRoot, paths.serviceRoot], [paths.originalCredentials, paths.credentials], [paths.originalDataRoot, paths.dataRoot], ['/var/lib/webminai/', `${paths.home}/.webminai/artifacts/`], ['/srv/', `${paths.home}/.webminai/data/`]]) if (from) value = value.replaceAll(from, to)
  return value
}

function baseline ({ state, serviceRoot, credentials, images, home }) {
  const imageChecks = images.map((image, index) => `if docker image inspect ${quote(image)} >/dev/null 2>&1; then : > ${quote(`${state}/image-${index}.existed`)}; fi`).join('; ')
  return withDocker(`set -eu; if [ ! -e ${quote(`${state}/baseline.ready`)} ]; then test ! -e ${quote(serviceRoot)}; test ! -e ${quote(credentials)}; install -d -o root -g wheel -m 0700 ${quote(state)}; ${imageChecks}; : > ${quote(`${state}/baseline.ready`)}; fi; printf '%s\n' baseline-ready`, home)
}

function dockerReady (state, home) {
  return withDocker(`set -eu; docker info >/dev/null; docker compose version >/dev/null; : > ${quote(`${state}/docker-ready.before`)}; printf '%s\n' docker-ready`, home)
}

function withDocker (command, home) {
  const prefix = `export HOME=${quote(home)} PATH='/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin' DOCKER_HOST=${quote(`unix://${home}/.colima/default/docker.sock`)}`
  return command.startsWith(`${prefix}; `) ? command : `${prefix}; ${command}`
}

function extractImages (command) {
  const images = []
  for (const match of String(command).matchAll(/docker image inspect '([^']+)'/gu)) if (!images.includes(match[1])) images.push(match[1])
  return images
}

function firstMatch (value, pattern) {
  return String(value).match(pattern)?.[0] ?? null
}

function replace (items, id, command) {
  const item = items.find(item => item.id === id)
  if (!item) throw new Error(`Compose plan is missing ${id}`)
  item.command = command
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function adaptApplicationDelta (delta, paths) {
  return {
    ...delta,
    application: delta.application ? { ...delta.application } : delta.application,
    manifest: delta.manifest ? { ...delta.manifest } : delta.manifest,
    foundationPhases: Array.isArray(delta.foundationPhases) ? [...delta.foundationPhases] : [],
    foundationPaths: Array.isArray(delta.foundationPaths) ? delta.foundationPaths.map(path => adaptPath(path, paths)) : [],
    extensionPoints: Array.isArray(delta.extensionPoints) ? [...delta.extensionPoints] : delta.extensionPoints
  }
}
