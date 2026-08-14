#!/usr/bin/env node
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AdminService } from '../src/admin-service.js'
import { buildCommonTask } from '../src/common-tasks.js'
import { runProcess } from '../src/process-runner.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { windowsDockerPowerShellAdapter } from '../src/windows-wordpress-compose-task.js'

const SERVER_ID = process.env.WEBMINAI_TEST_SERVER ?? 'windows-11'
const CANDIDATES = {
  wordpress: { catalogId: 'wordpress-windows', label: 'WordPress', port: 18101, marker: 'WEBMINAI_WORDPRESS_OK' },
  woocommerce: { catalogId: 'woocommerce-windows', label: 'WooCommerce', port: 18102, marker: 'WEBMINAI_WOOCOMMERCE_OK' },
  joomla: { catalogId: 'joomla-windows', label: 'Joomla', port: 18103, marker: 'WEBMINAI_JOOMLA_OK' },
  drupal: { catalogId: 'drupal-windows', label: 'Drupal', port: 18104, marker: 'WEBMINAI_DRUPAL_OK' },
  prestashop: { catalogId: 'prestashop-windows', label: 'PrestaShop', port: 18105, marker: 'WEBMINAI_PRESTASHOP_OK' },
  moodle: { catalogId: 'moodle-windows', label: 'Moodle', port: 18106, marker: 'WEBMINAI_MOODLE_OK' },
  magento: { catalogId: 'magento-windows', label: 'Magento Open Source', port: 18108, marker: 'WEBMINAI_MAGENTO_OK' },
  n8n: { catalogId: 'n8n-windows', label: 'n8n', port: 18109, marker: 'WEBMINAI_N8N_OK' },
  ghost: { catalogId: 'ghost-windows', label: 'Ghost', port: 18110, marker: 'WEBMINAI_GHOST_OK' },
  mattermost: { catalogId: 'mattermost-windows', label: 'Mattermost', port: 18111, marker: 'WEBMINAI_MATTERMOST_OK' },
  odoo: { catalogId: 'odoo-windows', label: 'Odoo Community', port: 18112, marker: 'WEBMINAI_ODOO_OK' },
  jellyfin: { catalogId: 'jellyfin-windows', label: 'Jellyfin', port: 18113, marker: 'WEBMINAI_JELLYFIN_OK' },
  homeassistant: { catalogId: 'home-assistant-windows', label: 'Home Assistant', port: 18115, marker: 'WEBMINAI_HOME_ASSISTANT_OK' }
}
const CANDIDATE = CANDIDATES[process.argv[2] ?? 'joomla']
if (!CANDIDATE) throw new Error(`usage: validate-windows-joomla.js [${Object.keys(CANDIDATES).join('|')}]`)
const { catalogId: CATALOG_ID, label: LABEL, port: PORT, marker: MARKER } = CANDIDATE
const ACTION = process.argv[3] ?? 'promote'
const TASK_ID = process.argv[4] === undefined ? null : Number(process.argv[4])
if (!['promote', 'diagnose', 'verify-current', 'cleanup', 'cleanup-current'].includes(ACTION)) throw new Error('action must be promote, diagnose, verify-current, cleanup, or cleanup-current')
const WORDPRESS_PORT = 18101
const WORDPRESS_MARKER = 'WEBMINAI_WORDPRESS_OK'
const VERIFY_WORDPRESS_CONTROL = process.env.WEBMINAI_VERIFY_WORDPRESS_CONTROL !== '0'

async function main () {
  if (!process.env.VAULT_TEST || !(process.env.SSH_HOST_PWD || process.env.SSH_HOST_1)) {
    throw new Error('VAULT_TEST and SSH_HOST_PWD (or SSH_HOST_1) are required')
  }
  const dataRoot = path.resolve(process.env.WEBMINAI_DATA_ROOT ?? path.join(os.homedir(), '.webminai'))
  const settingsStore = new SettingsStore(dataRoot)
  const settings = await settingsStore.load()
  const server = await settingsStore.decryptServer({ settings, passphrase: process.env.VAULT_TEST, serverId: SERVER_ID })
  const environment = {
    ...process.env,
    SSH_HOST_1: process.env.SSH_HOST_PWD ?? process.env.SSH_HOST_1,
    SSH_ASKPASS: path.resolve('scripts/webminai-askpass.sh'),
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: 'webminai-askpass'
  }
  const baseSsh = new SystemSsh({
    interactiveRunner: (command, args, options = {}) => runProcess('setsid', ['-w', command, ...args], { ...options, env: environment }),
    terminalCheck: () => true
  })
  const session = await baseSsh.openInteractiveSession(server.connectionUrl, { authentication: server.authentication ?? 'password' })
  try {
    const admin = new AdminService({ dataRoot, ssh: session.ssh, settings: settingsStore })
    if (ACTION === 'diagnose') {
      await diagnose(admin.netdata(server))
      return
    }
    if (ACTION === 'cleanup' || ACTION === 'cleanup-current') {
      if (!Number.isInteger(TASK_ID)) throw new Error('cleanup requires a task id')
      let plan
      if (ACTION === 'cleanup-current') {
        const inventory = await admin.refreshInventory({ settings, passphrase: process.env.VAULT_TEST, serverId: SERVER_ID })
        const built = buildCommonTask(CATALOG_ID, TASK_ID, { platform: 'windows', windowsExecution: inventory.webminaiExecution, docker: inventory.webminaiDocker })
        plan = { ...built.plan, commands: built.plan.revertCommands, revertCommands: [] }
      }
      if (ACTION === 'cleanup') admin.markTaskReverting(SERVER_ID, TASK_ID)
      const results = plan
        ? await admin.execute({ settings, passphrase: process.env.VAULT_TEST, serverId: SERVER_ID, plan, requireRevert: false, approve: async () => true, onResult: result => process.stdout.write(`[cleanup:${result.id}] ${result.status}\n`) })
        : await admin.revertTask({ settings, passphrase: process.env.VAULT_TEST, serverId: SERVER_ID, taskId: TASK_ID, approve: async () => true, onResult: result => process.stdout.write(`[cleanup:${result.id}] ${result.status}\n`) })
      requireCompleted(results, 'cleanup')
      if (ACTION === 'cleanup') admin.saveTaskRevertResults(SERVER_ID, TASK_ID, results)
      return
    }
    const inventory = await admin.refreshInventory({ settings, passphrase: process.env.VAULT_TEST, serverId: SERVER_ID })
    assert.equal(inventory.webminaiExecution?.platform, 'windows')
    assert.equal(inventory.webminaiExecution?.docker?.serverOs, 'linux')
    assert.equal(inventory.webminaiDocker?.ready, true, inventory.webminaiDocker?.reason)
    if (ACTION === 'verify-current') {
      if (!Number.isInteger(TASK_ID)) throw new Error('verify-current requires a task id')
      const built = buildCommonTask(CATALOG_ID, TASK_ID, { platform: 'windows', windowsExecution: inventory.webminaiExecution, docker: inventory.webminaiDocker })
      await verify(admin.netdata(server), built.verifyApplied, server.connectionUrl)
      process.stdout.write(`CURRENT_VERIFY_OK ${LABEL} task #${TASK_ID}\n`)
      return
    }
    const task = admin.createTask(SERVER_ID, `Deploy the learned reversible ${LABEL} compatibility site.`, { kind: 'catalog', catalogId: CATALOG_ID })
    const built = buildCommonTask(CATALOG_ID, task.id, {
      platform: 'windows',
      windowsExecution: inventory.webminaiExecution,
      docker: inventory.webminaiDocker
    })
    admin.saveTaskPlan(SERVER_ID, task.id, built.plan)
    const netdata = admin.netdata(server)
    const baseline = await probe(netdata, built.stateProbe)
    let cleanupRequired = false
    try {
      admin.markTaskRunning(SERVER_ID, task.id)
      const apply1 = await execute(admin, settings, task.id, built.plan, 'apply-1')
      requireCompleted(apply1, 'first apply')
      cleanupRequired = true
      await verify(netdata, built.verifyApplied, server.connectionUrl)
      const appliedState = await probe(netdata, built.stateProbe)

      const apply2 = await execute(admin, settings, task.id, built.plan, 'apply-2')
      requireCompleted(apply2, 'second apply')
      assert.deepEqual(await probe(netdata, built.stateProbe), appliedState, 'second apply changed the managed state')
      await verify(netdata, built.verifyApplied, server.connectionUrl)

      const revertPlan = { ...built.plan, summary: `Revert ${built.plan.summary}`, commands: built.plan.revertCommands, revertCommands: [] }
      const revert1 = await execute(admin, settings, task.id, revertPlan, 'revert-1', false)
      requireCompleted(revert1, 'first revert')
      await verifyReverted(netdata, built.verifyReverted, server.connectionUrl)
      const reverted = await probe(netdata, built.stateProbe)

      const revert2 = await execute(admin, settings, task.id, revertPlan, 'revert-2', false)
      requireCompleted(revert2, 'second revert')
      assert.deepEqual(await probe(netdata, built.stateProbe), reverted, 'second revert changed the managed state')
      assert.deepEqual(reverted, baseline, 'revert did not restore the exact baseline')
      if (VERIFY_WORDPRESS_CONTROL) await verifyWordpress(server.connectionUrl)
      admin.saveTaskResults(SERVER_ID, task.id, apply2)
      admin.saveTaskRevertResults(SERVER_ID, task.id, revert2)
      const controlEvidence = VERIFY_WORDPRESS_CONTROL ? ', WordPress control healthy' : ''
      process.stdout.write(`PROMOTION_READY Windows ${LABEL} task #${task.id}: two applies, restart recovery, external HTTP marker, two reverts, exact baseline${controlEvidence}.\n`)
    } catch (error) {
      if (cleanupRequired) {
        try {
          const revertPlan = { ...built.plan, summary: `Revert ${built.plan.summary}`, commands: built.plan.revertCommands, revertCommands: [] }
          const cleanup = await execute(admin, settings, task.id, revertPlan, 'failure-cleanup', false)
          requireCompleted(cleanup, 'failure cleanup')
          admin.saveTaskRevertResults(SERVER_ID, task.id, cleanup)
        } catch (cleanupError) {
          admin.saveTaskRevertError(SERVER_ID, task.id, cleanupError)
          process.stderr.write(`CLEANUP_FAILED task #${task.id}: ${cleanupError.message}\n`)
        }
      }
      admin.saveTaskError(SERVER_ID, task.id, error)
      throw error
    }
  } finally {
    await session.close()
  }
}

async function diagnose (netdata) {
  const application = CATALOG_ID.replace('-windows', '')
  const root = `C:\\ProgramData\\WebminAI\\Services\\${application}`
  const project = `webminai-${application}-${PORT}`
  const paths = application === 'prestashop'
    ? '/var/www/html/install/index_cli.php /var/www/html/app/config/parameters.php /var/www/html/admin /var/www/html/admin-webminai/index.php /var/www/html/.webminai-installed'
    : application === 'ghost'
      ? '/var/lib/ghost/content /var/lib/ghost/content/data /var/lib/ghost/content/logs /var/lib/ghost/content/settings /var/lib/ghost/content/themes'
      : '/var/www/html/autoload.php /var/www/html/sites/default/settings.php /var/www/html/sites/default/.webminai-installed /var/www/html/sites/default/files/.webminai-cron-ok'
  const command = [
    "$ErrorActionPreference='Stop'",
    windowsDockerPowerShellAdapter(),
    `Set-Location -LiteralPath '${root}'`,
    `Get-NetTCPConnection -State Listen -LocalPort ${PORT} -ErrorAction SilentlyContinue|Select-Object LocalAddress,LocalPort,State|ConvertTo-Json -Compress`,
    `Get-NetFirewallRule -Name '${project}' -ErrorAction SilentlyContinue|Select-Object Name,Enabled,Direction,Action,Profile|ConvertTo-Json -Compress`,
    `& $docker compose -p '${project}' config --images`,
    `& $docker compose -p '${project}' ps --all`,
    `& $docker compose -p '${project}' exec -T '${application}' /bin/sh -c 'for path in ${paths}; do if [ -e "$path" ]; then echo present=$path; else echo absent=$path; fi; done'`,
    ...(CATALOG_ID === 'ghost-windows'
      ? [`& $docker compose -p '${project}' exec -T ghost /bin/sh -c 'find /var/lib/ghost/content -mindepth 1 -maxdepth 2 -type f -o -type d | sort | head -80'`]
      : []),
    ...(CATALOG_ID === 'jellyfin-windows'
      ? [`Invoke-RestMethod -Uri 'http://127.0.0.1:${PORT}/jellyfin/Startup/Configuration' -TimeoutSec 10|Select-Object IsStartupWizardCompleted,UICulture,MetadataCountryCode,PreferredMetadataLanguage|ConvertTo-Json -Compress`, `if(Test-Path -LiteralPath '${root}\\initialize-stage'){Write-Output ('initialize-stage='+[IO.File]::ReadAllText('${root}\\initialize-stage'))}`]
      : []),
    ...(CATALOG_ID === 'home-assistant-windows'
      ? [`Invoke-RestMethod -Uri 'http://127.0.0.1:${PORT}/homeassistant/api/onboarding' -TimeoutSec 10|ConvertTo-Json -Compress`, `if(Test-Path -LiteralPath '${root}\\initialize-stage'){Write-Output ('initialize-stage='+[IO.File]::ReadAllText('${root}\\initialize-stage'))}`, `& $docker compose -p '${project}' logs --no-color --tail 120 app|Select-String -Pattern 'ERROR|Error|Exception|onboarding'`]
      : []),
    ...(CATALOG_ID === 'moodle-windows'
      ? [
          'Get-NetIPAddress -AddressFamily IPv4|Where-Object {$_.IPAddress -notlike \'169.254.*\'}|Select-Object InterfaceAlias,IPAddress|ConvertTo-Json -Compress',
          `& $docker compose -p '${project}' exec -T moodle /bin/sh -c 'for path in /var/www/html/config.php /var/www/html/.webminai-installed /var/www/html/public/webminai-health.txt /var/moodledata/.webminai-cron-ok /run/php-fpm/webminai.sock; do if [ -e "$path" ]; then echo present=$path; else echo absent=$path; fi; done; grep -F "wwwroot" /var/www/html/config.php'`,
          `try{$response=Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -Uri 'http://127.0.0.1:${PORT}/webminai-health.txt' -TimeoutSec 10;Write-Output ('health-status='+[int]$response.StatusCode);Write-Output ('health-body='+$response.Content.Trim())}catch{Write-Output ('health-error='+$_.Exception.Message)}`,
          `try{$response=Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -Uri 'http://127.0.0.1:${PORT}/login/index.php' -TimeoutSec 10;Write-Output ('login-status='+[int]$response.StatusCode);Write-Output ('login-location='+$response.Headers.Location)}catch{Write-Output ('login-error='+$_.Exception.Message);if($_.Exception.Response){Write-Output ('login-status='+[int]$_.Exception.Response.StatusCode);Write-Output ('login-location='+$_.Exception.Response.Headers.Location)}}`,
          `curl.exe --silent --show-error --max-time 10 --max-redirs 0 --head 'http://127.0.0.1:${PORT}/login/index.php'`
        ]
      : []),
    ...(CATALOG_ID === 'drupal-windows'
      ? [
          `& $docker compose -p '${project}' exec -T drupal php -l /run/webminai/install-drupal.php`,
          `& $docker compose -p '${project}' exec -T drupal /bin/sh -c 'for extension in pdo_mysql mysqli gd mbstring xml; do php -m | grep -Fqi "$extension" && echo extension-$extension=present || echo extension-$extension=absent; done'`,
          `& $docker compose -p '${project}' exec -T drupal /bin/sh -c 'test -s /run/secrets/db_password && test -s /run/secrets/admin_password && echo protected-inputs=present || echo protected-inputs=absent'`,
          `& $docker compose -p '${project}' exec -T drupal /bin/sh -c 'WEBMINAI_DRUPAL_ROOT=/var/www/html WEBMINAI_DB_HOST=db WEBMINAI_DB_NAME=webminai_drupal_18104 WEBMINAI_DB_USER=webminai_drupal_18104 WEBMINAI_DB_PASS_FILE=/run/secrets/db_password WEBMINAI_ADMIN_PASS_FILE=/run/secrets/admin_password php /run/webminai/install-drupal.php >/tmp/webminai-install.out 2>/tmp/webminai-install.err || true; grep -Eo "SQLSTATE\\[[A-Z0-9]+\\]|Call to undefined function [A-Za-z0-9_]+|Class [A-Za-z0-9_\\\\]+ not found|Permission denied|Connection refused|Access denied|Unknown database|already exists|cannot create Drupal [a-z]+" /tmp/webminai-install.err | head -20; test -f /var/www/html/sites/default/settings.php && echo retry-settings=present || echo retry-settings=absent'`,
          `& $docker compose -p '${project}' exec -T drupal /bin/sh -c 'WEBMINAI_DRUPAL_ROOT=/var/www/html WEBMINAI_DRUPAL_URL=http://127.0.0.1:${PORT}/ php /run/webminai/reconcile-drupal.php >/tmp/webminai-reconcile.out 2>/tmp/webminai-reconcile.err || true; grep -Eo "Call to undefined function [A-Za-z0-9_]+|Class [A-Za-z0-9_\\\\]+ not found|Permission denied|Connection refused|Drupal cron did not complete" /tmp/webminai-reconcile.err | head -20; test -f /var/www/html/sites/default/files/.webminai-cron-ok && echo reconcile=ready || echo reconcile=failed'`
        ]
      : []),
    `try{$response=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${PORT}/' -TimeoutSec 10;Write-Output ('http-status='+[int]$response.StatusCode);Write-Output ('marker='+[bool]($response.Content-like'*${MARKER}*'))}catch{Write-Output ('http-error='+$_.Exception.Message)}`
  ].join(';')
  const result = await netdata.runCommand(command, { timeoutSeconds: 60 })
  process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
}

async function execute (admin, settings, taskId, plan, label, requireRevert = true) {
  return admin.execute({
    settings,
    passphrase: process.env.VAULT_TEST,
    serverId: SERVER_ID,
    plan,
    requireRevert,
    approve: async () => true,
    onResult: result => process.stdout.write(`[${label}:${result.id}] ${result.status}\n`)
  })
}

async function probe (netdata, command) {
  const result = await netdata.runCommand(command, { timeoutSeconds: 60 })
  assert.equal(result.exitCode, 0, result.stderr.trim() || result.stdout.trim())
  return JSON.parse(result.stdout)
}

async function verify (netdata, command, connectionUrl) {
  const result = await netdata.runCommand(command, { timeoutSeconds: 300 })
  assert.equal(result.exitCode, 0, result.stderr.trim() || result.stdout.trim())
  await requireHttpMarker(connectionUrl, PORT, MARKER, CATALOG_ID === 'moodle-windows' ? '/webminai-health.txt' : '/')
  if (VERIFY_WORDPRESS_CONTROL) await verifyWordpress(connectionUrl)
}

async function verifyReverted (netdata, command, connectionUrl) {
  const result = await netdata.runCommand(command, { timeoutSeconds: 60 })
  assert.equal(result.exitCode, 0, result.stderr.trim() || result.stdout.trim())
  const address = new URL(connectionUrl).hostname
  await assert.rejects(fetch(`http://${address}:${PORT}/`, { signal: AbortSignal.timeout(2000) }))
}

async function verifyWordpress (connectionUrl) {
  await requireHttpMarker(connectionUrl, WORDPRESS_PORT, WORDPRESS_MARKER)
}

async function requireHttpMarker (connectionUrl, port, marker, pathname = '/') {
  const address = new URL(connectionUrl).hostname
  let evidence = 'no response'
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const response = await fetch(`http://${address}:${port}${pathname}`, { signal: AbortSignal.timeout(3000) })
      const body = await response.text()
      if (response.ok && body.includes(marker)) return
      evidence = `HTTP ${response.status}`
    } catch (error) {
      evidence = error.message
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`HTTP marker ${marker} was not reachable: ${evidence}`)
}

function requireCompleted (results, label) {
  const failed = results?.find(result => result.status !== 'completed')
  if (!Array.isArray(results) || results.length === 0 || failed) {
    throw new Error(`${label} failed: ${failed?.result?.stderr?.trim() || failed?.result?.stdout?.trim() || failed?.status || 'no results'}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
