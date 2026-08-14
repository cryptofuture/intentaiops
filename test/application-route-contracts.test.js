import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDrupalTask } from '../src/drupal-task.js'
import { buildFreebsdDrupalTask } from '../src/freebsd-drupal-task.js'
import { buildFreebsdGhostTask } from '../src/freebsd-ghost-task.js'
import { buildFreebsdHomeAssistantTask } from '../src/freebsd-home-assistant-task.js'
import { buildFreebsdJellyfinTask } from '../src/freebsd-jellyfin-task.js'
import { buildFreebsdJoomlaTask } from '../src/freebsd-joomla-task.js'
import { buildFreebsdMagentoTask } from '../src/freebsd-magento-task.js'
import { buildFreebsdMattermostTask } from '../src/freebsd-mattermost-task.js'
import { buildFreebsdMoodleTask } from '../src/freebsd-moodle-task.js'
import { buildFreebsdN8nTask } from '../src/freebsd-n8n-task.js'
import { buildFreebsdNextcloudTask } from '../src/freebsd-nextcloud-task.js'
import { buildFreebsdOdooTask } from '../src/freebsd-odoo-task.js'
import { buildFreebsdPhpRuntimeCommand, FREEBSD_PHP_IMAGE } from '../src/freebsd-php-runtime.js'
import { buildFreebsdPodmanBootstrapTask } from '../src/freebsd-podman-bootstrap-task.js'
import { buildFreebsdPrestaShopTask } from '../src/freebsd-prestashop-task.js'
import { buildFreebsdWooCommerceTask } from '../src/freebsd-woocommerce-task.js'
import { buildFreebsdWordpressTask } from '../src/freebsd-wordpress-task.js'
import { buildJoomlaTask } from '../src/joomla-task.js'
import { buildLinuxDockerBootstrapTask } from '../src/linux-docker-bootstrap-task.js'
import { buildLinuxComposeReferenceContext } from '../src/linux-host-context.js'
import { buildMacosColimaBootstrapTask } from '../src/macos-colima-bootstrap-task.js'
import { buildMacosComposeTask } from '../src/macos-compose-task.js'
import { buildMacosWordpressComposeTask } from '../src/macos-wordpress-compose-task.js'
import { buildMoodleTask } from '../src/moodle-task.js'
import { buildPrestaShopTask } from '../src/prestashop-task.js'
import { buildWindowsBraveTask } from '../src/windows-brave-task.js'
import { buildWindowsDockerBootstrapTask } from '../src/windows-docker-bootstrap-task.js'
import { buildWindowsDrupalComposeTask } from '../src/windows-drupal-compose-task.js'
import { buildWindowsGhostComposeTask } from '../src/windows-ghost-compose-task.js'
import { buildWindowsHomeAssistantComposeTask } from '../src/windows-home-assistant-compose-task.js'
import { buildWindowsJellyfinComposeTask } from '../src/windows-jellyfin-compose-task.js'
import { buildWindowsJoomlaComposeTask } from '../src/windows-joomla-compose-task.js'
import { buildWindowsMagentoComposeTask } from '../src/windows-magento-compose-task.js'
import { buildWindowsMattermostComposeTask } from '../src/windows-mattermost-compose-task.js'
import { buildWindowsN8nComposeTask } from '../src/windows-n8n-compose-task.js'
import { buildWindowsOdooComposeTask } from '../src/windows-odoo-compose-task.js'
import { buildWindowsPrestaShopComposeTask } from '../src/windows-prestashop-compose-task.js'
import { buildWooCommerceTask } from '../src/woocommerce-task.js'
import { buildWordpressComposeTask } from '../src/wordpress-compose-task.js'
import { buildWordpressLinuxTask } from '../src/wordpress-linux-task.js'
import { rootExecutionPolicy } from '../src/execution-policy.js'
import { validateCommandPlan } from '../src/plan-validator.js'

const linux = buildLinuxComposeReferenceContext()
const compose = { platform: 'linux', preferred: true, ready: true, installSupported: true }
const freebsd = {
  platform: 'freebsd',
  freebsdVersion: '15.1-RELEASE',
  docker: { ready: true, daemonReachable: true, composeAvailable: true, installSupported: true, hostIsContainer: false }
}
const windows = {
  platform: 'windows',
  identity: 'LocalSystem',
  docker: { cliAvailable: true, daemonReachable: true, composeAvailable: true, composeCommand: 'docker compose', serverOs: 'linux' }
}
const windowsDocker = { platform: 'windows', preference: 'auto', preferred: true, ready: true, installSupported: true }
const macos = {
  platform: 'macos',
  architecture: 'x86_64',
  brewPath: '/usr/local/bin/brew',
  brewPrefix: '/usr/local',
  runtimeUser: 'mac',
  runtimeHome: '/Users/mac'
}
const macosDocker = { platform: 'macos', preference: 'auto', preferred: true, ready: true, installSupported: true, installMethod: 'homebrew-colima' }

function assertReversiblePlan (built, label) {
  assert.ok(built && typeof built === 'object', `${label} must return a task`)
  assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
  assert.ok(built.plan.commands.length > 0, `${label} must execute at least one command`)
  assert.ok(built.plan.revertCommands.length > 0, `${label} must provide rollback`)
  assert.equal(typeof built.verifyApplied, 'string', `${label} must verify application state`)
  assert.equal(typeof built.verifyReverted, 'string', `${label} must verify rollback state`)
  assert.equal(typeof built.stateProbe, 'string', `${label} must expose a state probe`)
}

test('direct Linux PHP route contracts produce independently valid reversible plans', () => {
  const routes = [
    ['wordpress-native', () => buildWordpressLinuxTask(1, linux)],
    ['wordpress-compose', () => buildWordpressComposeTask(2, linux, compose)],
    ['woocommerce', () => buildWooCommerceTask(3, linux, compose)],
    ['joomla', () => buildJoomlaTask(4, linux, compose)],
    ['drupal', () => buildDrupalTask(5, linux, compose)],
    ['prestashop', () => buildPrestaShopTask(6, linux, compose)],
    ['moodle', () => buildMoodleTask(7, linux, compose)]
  ]
  for (const [label, build] of routes) assertReversiblePlan(build(), label)
})

test('Linux Docker bootstrap enforces platform preconditions and emits a reversible job plan', () => {
  const built = buildLinuxDockerBootstrapTask(20, linux, {
    platform: 'linux',
    preference: 'auto',
    preferred: true,
    ready: false,
    installSupported: true,
    installMethod: 'official-apt'
  })
  assertReversiblePlan(built, 'linux-docker')
  assert.equal(built.plan.commands.find(command => command.id === 'install-docker-engine').executionMode, 'job')
  assert.throws(() => buildLinuxDockerBootstrapTask(21, linux, { preference: 'disabled' }), /disabled by this host preference/u)
})

test('direct FreeBSD route contracts cover Podman-backed and native applications', () => {
  const routes = [
    buildFreebsdWordpressTask,
    buildFreebsdWooCommerceTask,
    buildFreebsdJoomlaTask,
    buildFreebsdDrupalTask,
    buildFreebsdPrestaShopTask,
    buildFreebsdMoodleTask,
    buildFreebsdNextcloudTask,
    buildFreebsdJellyfinTask,
    buildFreebsdMattermostTask,
    buildFreebsdN8nTask,
    buildFreebsdGhostTask,
    buildFreebsdOdooTask,
    buildFreebsdHomeAssistantTask,
    buildFreebsdMagentoTask
  ]
  routes.forEach((build, index) => assertReversiblePlan(build(40 + index, freebsd), build.name))

  const runtime = buildFreebsdPhpRuntimeCommand('/var/db/webminai/build-test')
  assert.match(runtime, /php84/u)
  assert.match(runtime, new RegExp(FREEBSD_PHP_IMAGE.replaceAll('.', '\\.')), 'runtime must tag the reviewed image')
})

test('FreeBSD Podman bootstrap rejects jails and preserves an exact rollback boundary', () => {
  const docker = { platform: 'freebsd', preference: 'auto', ready: false, installSupported: true, installMethod: 'freebsd-podman-linux' }
  assertReversiblePlan(buildFreebsdPodmanBootstrapTask(60, freebsd, docker), 'freebsd-podman')
  assert.throws(
    () => buildFreebsdPodmanBootstrapTask(61, { ...freebsd, docker: { ...freebsd.docker, hostIsContainer: true } }, docker),
    /unavailable inside a jail/u
  )
})

test('direct Windows route contracts produce valid LocalSystem Compose plans', () => {
  const routes = [
    buildWindowsDrupalComposeTask,
    buildWindowsGhostComposeTask,
    buildWindowsHomeAssistantComposeTask,
    buildWindowsJellyfinComposeTask,
    buildWindowsJoomlaComposeTask,
    buildWindowsMagentoComposeTask,
    buildWindowsMattermostComposeTask,
    buildWindowsN8nComposeTask,
    buildWindowsOdooComposeTask,
    buildWindowsPrestaShopComposeTask
  ]
  routes.forEach((build, index) => assertReversiblePlan(build(70 + index, windows, windowsDocker), build.name))
  assertReversiblePlan(buildWindowsBraveTask(85, windows), 'windows-brave')
  assertReversiblePlan(buildWindowsDockerBootstrapTask(86, windows, windowsDocker), 'windows-docker')
})

test('direct macOS route contracts preserve the Colima ownership boundary', () => {
  assertReversiblePlan(buildMacosColimaBootstrapTask(90, macos, macosDocker), 'macos-colima')
  assertReversiblePlan(buildMacosWordpressComposeTask(91, macos, macosDocker), 'macos-wordpress')
  const ghost = buildMacosComposeTask('ghost', 92, macos, macosDocker)
  assertReversiblePlan(ghost, 'macos-ghost')
  assert.match(JSON.stringify(ghost.plan), /\/Users\/mac\/\.colima\/default\/docker\.sock/u)
  assert.doesNotMatch(JSON.stringify(ghost.plan), /\/root\/ghost_credentials/u)
})
