import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexPlanner } from '../src/codex-planner.js'
import { buildCandidatePlanningContext, buildCommonTask, commonTaskFoundationIds, listCommonTasks } from '../src/common-tasks.js'
import {
  composeFoundationAssistedPlan,
  composeFoundationPlan,
  executableFoundationFromCandidates,
  getDeploymentFoundation,
  listDeploymentFoundations,
  validateFoundationSelection
} from '../src/deployment-foundations.js'
import { LinuxHostContextService } from '../src/linux-host-context.js'

test('deployment foundation registry validates platform, runtime policy, and versions', () => {
  const foundations = listDeploymentFoundations()
  assert.equal(foundations.every(item => Number.isInteger(item.version) && item.version > 0), true)
  assert.equal(getDeploymentFoundation('linux-php-fpm-socket').platform, 'linux')
  assert.throws(() => getDeploymentFoundation('unknown-foundation'), /unknown deployment foundation/u)
  assert.throws(() => validateFoundationSelection({ foundationIds: ['linux-nginx-site'], platform: 'windows' }), /does not support windows/u)
  assert.throws(() => validateFoundationSelection({ foundationIds: ['linux-docker-compose'], platform: 'linux', docker: { preference: 'disabled' }, mode: 'executable' }), /disabled by host container-runtime preference/u)
  assert.throws(() => validateFoundationSelection({ foundationIds: ['linux-docker-compose'], platform: 'linux', docker: { preference: 'auto', ready: false, installSupported: false }, mode: 'executable' }), /eligible container-runtime bootstrap/u)
  assert.equal(validateFoundationSelection({ foundationIds: ['linux-docker-compose'], platform: 'linux', docker: { preference: 'auto', ready: false, installSupported: true }, mode: 'executable' }).length, 1)
})

test('foundation composition preserves provenance and rejects overwrites and invalid graphs', () => {
  const foundation = command('capture-baseline', [], { type: 'verified-foundation', id: 'linux-baseline', version: 1 })
  const composed = composeFoundationPlan({
    foundationCommands: [foundation],
    applicationCommands: [command('initialize-custom-cms', ['capture-baseline'])],
    revertCommands: []
  })
  assert.deepEqual(composed.commands[0].source, foundation.source)
  assert.deepEqual(composed.commands[1].source, { type: 'ai-planned' })
  assert.throws(() => composeFoundationPlan({ foundationCommands: [foundation], applicationCommands: [command('capture-baseline', [])] }), /cannot overwrite/u)
  assert.throws(() => composeFoundationPlan({ foundationCommands: [foundation], applicationCommands: [command('initialize-custom-cms', ['missing'])] }), /invalid dependency graph/u)
  assert.throws(() => composeFoundationPlan({ foundationCommands: [{ ...foundation, source: { ...foundation.source, version: 99 } }], applicationCommands: [] }), /unsupported foundation version/u)
})

test('verified tasks and candidate context derive foundations from the same catalog source', async () => {
  const context = await linuxContext()
  const options = { platform: 'linux', linuxContext: context, docker: { preferred: false } }
  const built = buildCommonTask('wordpress-linux', 31, options)
  const catalog = listCommonTasks({ category: 'application', ...options }).find(item => item.id === 'wordpress-linux')
  assert.deepEqual(built.plan.foundationComposition.foundationIds, catalog.foundationIds)
  assert.equal([...built.plan.commands, ...built.plan.revertCommands].every(item => item.source?.type?.startsWith('verified-')), true)
  const candidates = buildCandidatePlanningContext(['wordpress-linux'], 32, { ...options, foundationMode: 'context-only' })
  assert.deepEqual(candidates[0].foundationIds, catalog.foundationIds)
  assert.equal(candidates[0].foundations.every(item => item.mode === 'context-only'), true)
  assert.match(JSON.stringify(candidates), /credential paths and names/u)
  assert.doesNotMatch(JSON.stringify(candidates), /db_password\s*[=:]\s*[A-Za-z0-9_-]{16,}/u)
})

test('container runtime prerequisites declare their readiness foundations', () => {
  assert.deepEqual(commonTaskFoundationIds('docker-linux', { platform: 'linux' }), ['linux-docker-readiness', 'safe-baseline-rollback'])
  assert.deepEqual(commonTaskFoundationIds('docker-desktop-windows', { platform: 'windows' }), ['windows-docker-wsl-readiness', 'safe-baseline-rollback'])
  assert.deepEqual(commonTaskFoundationIds('podman-freebsd', { platform: 'freebsd' }), ['freebsd-podman-readiness', 'safe-baseline-rollback'])
  assert.deepEqual(commonTaskFoundationIds('colima-macos', { platform: 'macos' }), ['macos-colima-compose', 'safe-baseline-rollback'])
})

test('shared Linux PHP-FPM foundation is idempotent and waits for its Unix socket', async () => {
  const context = await linuxContext()
  context.management.family = 'alpine'
  context.applications.wordpress.phpFpmService = 'php-fpm83'
  context.applications.wordpress.phpFpmBinary = '/usr/sbin/php-fpm83'
  context.applications.wordpress.phpFpmPool = '/etc/php83/php-fpm.d/webminai-wordpress-18101.conf'
  context.applications.wordpress.phpFpmRuntimeDirectory = '/run/webminai-wordpress-18101'
  context.applications.wordpress.phpFpmListener = '/run/webminai-wordpress-18101/php-fpm.sock'
  context.applications.wordpress.phpExtensionConfig = '/etc/php83/conf.d/webminai-wordpress-18101.ini'
  context.applications.wordpress.phpExtensionsToEnable = ['gd', 'mysqli']
  const plan = buildCommonTask('joomla-linux', 33, { platform: 'linux', linuxContext: context, docker: { preferred: false } }).plan
  const command = plan.commands.find(item => item.id === 'configure-php-fpm').command
  assert.match(command, /pool_candidate=\$\(mktemp\)/u)
  assert.match(command, /cmp -s/u)
  assert.match(command, /rc-service 'php-fpm83' status/u)
  assert.match(command, /extension=gd/u)
  assert.match(command, /extension=mysqli/u)
  assert.match(command, /for attempt in \$\(seq 1 30\)/u)
  assert.match(command, /test -S '\/run\/webminai-joomla-18103\/php-fpm\.sock'/u)
  assert.match(plan.revertCommands.find(item => item.id === 'remove-application-files').command, /\/etc\/php83\/conf\.d\/webminai-joomla-18103\.ini/u)
})

test('shared native PHP foundation does not upgrade pre-existing Debian packages', async () => {
  const context = await linuxContext()
  const command = buildCommonTask('joomla-linux', 34, { platform: 'linux', linuxContext: context, docker: { preferred: false } }).plan.commands.find(item => item.id === 'install-packages').command
  assert.match(command, /apt-get install --no-upgrade -y/u)
})

test('shared Compose foundation uses durable jobs for long operations', async () => {
  const context = await linuxContext()
  const plan = buildCommonTask('joomla-linux', 35, { platform: 'linux', linuxContext: context, docker: { preferred: true, ready: true } }).plan
  for (const id of ['prepare-docker', 'pull-images', 'start-compose', 'initialize-joomla', 'verify-compose']) {
    const command = plan.commands.find(item => item.id === id)
    assert.equal(command.executionMode, 'job', id)
    assert.equal(command.timeoutMs > 300000, true, id)
  }
})

test('executable candidate context composes verified phases with an AI application delta', async () => {
  const context = await linuxContext()
  const options = { platform: 'linux', linuxContext: context, docker: { preferred: false }, foundationMode: 'executable' }
  const candidates = buildCandidatePlanningContext(['wordpress-linux'], 41, options)
  assert.equal(Object.hasOwn(candidates[0], 'executablePlan'), true)
  assert.equal(JSON.stringify(candidates).includes('executablePlan'), false)
  const foundation = executableFoundationFromCandidates(candidates)
  const applicationPlan = {
    summary: 'Initialize a custom PHP CMS',
    changeOverview: 'Add only the application-owned CMS phase',
    modifiedFiles: ['/srv/webminai-wordpress-18101/custom-cms.php'],
    assumptions: [],
    warnings: [],
    requiresConfirmation: true,
    commands: [command('initialize-custom-cms', [])],
    revertCommands: [command('remove-custom-cms', [])]
  }
  const plan = composeFoundationAssistedPlan({ foundation, applicationPlan, platform: 'linux', docker: options.docker })
  assert.equal(plan.commands.some(item => item.source.type === 'verified-foundation'), true)
  assert.deepEqual(plan.commands.at(-1).source, { type: 'ai-planned' })
  assert.equal(plan.commands.at(-1).dependsOn.includes(plan.commands.at(-2).id), true)
  assert.equal(plan.revertCommands.some(item => item.source.type === 'verified-foundation'), true)
  assert.deepEqual(plan.foundationComposition, { version: 1, mode: 'foundation-assisted', foundationIds: foundation.foundationIds })
  assert.equal(executableFoundationFromCandidates(buildCandidatePlanningContext(['wordpress-linux'], 42, { ...options, foundationMode: 'context-only' })), null)
})

test('semantic router distinguishes exact, foundation-assisted, context-only, and ordinary tasks', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-foundation-routing-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  const candidates = listCommonTasks({ category: 'application', platform: 'linux', docker: { preferred: false } })
  const cases = [
    {
      request: 'Please put WordPress on this server.',
      response: route('verified_task', 'wordpress-linux', ['wordpress-linux'], candidates.find(item => item.id === 'wordpress-linux').foundationIds, 'executable'),
      expected: ['verified_task', 'executable']
    },
    {
      request: 'Deploy this custom PHP CMS behind nginx using MariaDB.',
      response: route('informed_planning', 'none', ['joomla-linux', 'drupal-linux'], ['linux-baseline', 'linux-nginx-site', 'linux-php-fpm-socket', 'linux-mariadb'], 'executable'),
      expected: ['informed_planning', 'executable']
    },
    {
      request: 'Fix email delivery on my existing WordPress installation.',
      response: route('informed_planning', 'none', ['wordpress-linux'], candidates.find(item => item.id === 'wordpress-linux').foundationIds, 'context-only'),
      expected: ['informed_planning', 'context-only']
    },
    {
      request: 'Inspect a custom kernel trace unrelated to the catalog.',
      response: route('ordinary_planning', 'none', [], [], 'none'),
      expected: ['ordinary_planning', 'none']
    }
  ]
  for (const entry of cases) {
    const planner = new CodexPlanner({ runner: async () => ({ code: 0, stdout: JSON.stringify(entry.response), stderr: '' }) })
    const result = await planner.routeTask({ serverDirectory, request: entry.request, inventory: { os: 'linux' }, candidates })
    assert.deepEqual([result.decision, result.foundationMode], entry.expected)
    if (result.foundationMode === 'executable') {
      assert.equal(result.foundationIds.includes('service-verification'), true)
      assert.equal(result.foundationIds.includes('safe-baseline-rollback'), true)
    }
  }
  const planner = new CodexPlanner({ runner: async () => ({ code: 0, stdout: JSON.stringify(route('informed_planning', 'none', ['wordpress-linux'], ['made-up-foundation'], 'context-only')), stderr: '' }) })
  await assert.rejects(planner.routeTask({ serverDirectory, request: 'A related task', inventory: { os: 'linux' }, candidates }), /unknown foundation id/u)
})

test('migrated application builders do not recursively rewrite finalized application plans', async () => {
  const builders = [
    'woocommerce-task.js',
    'joomla-task.js',
    'drupal-task.js',
    'prestashop-task.js',
    'moodle-task.js',
    'freebsd-woocommerce-task.js',
    'windows-joomla-compose-task.js',
    'windows-drupal-compose-task.js',
    'windows-prestashop-compose-task.js',
    'windows-magento-compose-task.js',
    'windows-n8n-compose-task.js',
    'windows-ghost-compose-task.js',
    'windows-mattermost-compose-task.js',
    'windows-odoo-compose-task.js',
    'windows-jellyfin-compose-task.js',
    'windows-home-assistant-compose-task.js',
    'macos-compose-task.js'
  ]
  for (const file of builders) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\bmapStrings\s*\(|structuredClone\s*\(/u, file)
  }
  assert.doesNotMatch(await readFile(new URL('../src/woocommerce-task.js', import.meta.url), 'utf8'), /from '.\/wordpress-(?:linux|compose)-task\.js'/u)
  assert.doesNotMatch(await readFile(new URL('../src/freebsd-woocommerce-task.js', import.meta.url), 'utf8'), /buildFreebsdWordpressTask/u)
})

function command (id, dependsOn, source) {
  return { id, phase: 'configure', command: 'true', purpose: id, risk: 'change', timeoutMs: 1000, requiresSudo: true, dependsOn, ...(source ? { source } : {}) }
}

function route (decision, catalogId, relevantCatalogIds, foundationIds, foundationMode) {
  return { decision, catalogId, relevantCatalogIds, foundationIds, foundationMode, confidence: 'high', rationale: 'Semantic intent and deployment state determine this route.' }
}

async function linuxContext () {
  return new LinuxHostContextService({ fetchImpl: async () => new Response('official release', { status: 200 }), now: () => new Date('2026-08-12T00:00:00.000Z') }).build({
    inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
    execution: { platform: 'linux', architecture: 'x86_64', kernel: '7.0', init: 'systemd', osRelease: { ID: 'ubuntu', VERSION_ID: '24.04' }, commands: { apt: true } }
  })
}
