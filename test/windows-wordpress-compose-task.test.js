import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCommonTask, listCommonTasks } from '../src/common-tasks.js'
import { rootExecutionPolicy } from '../src/execution-policy.js'
import { validateCommandPlan } from '../src/plan-validator.js'

const windowsExecution = {
  platform: 'windows',
  identity: 'LocalSystem',
  docker: {
    cliAvailable: true,
    daemonReachable: true,
    composeAvailable: true,
    composeCommand: 'docker compose',
    serverOs: 'linux',
    serverVersion: '28.3.3'
  }
}

const docker = {
  platform: 'windows',
  preference: 'auto',
  preferred: true,
  ready: true,
  reason: 'Docker Compose is available on a non-container host'
}

test('Windows catalog exposes reviewed software, Docker bootstrap, WordPress, and WooCommerce tasks', () => {
  assert.deepEqual(listCommonTasks({ category: 'application', platform: 'windows' }).map(task => task.id), [
    'brave-windows',
    'docker-desktop-windows',
    'wordpress-windows',
    'woocommerce-windows',
    'joomla-windows',
    'drupal-windows',
    'prestashop-windows',
    'moodle-windows',
    'magento-windows',
    'n8n-windows',
    'ghost-windows',
    'mattermost-windows',
    'odoo-windows',
    'jellyfin-windows',
    'home-assistant-windows',
    'intent-ai-ops-windows'
  ])
})

test('Windows application routes prepare WSL and Docker before deploying Compose services', () => {
  const unavailable = { ...docker, preferred: true, ready: false, setupRequired: true, installSupported: true }
  for (const [catalogId, continuation] of [['wordpress-windows', 'WordPress'], ['woocommerce-windows', 'WooCommerce']]) {
    const built = buildCommonTask(catalogId, 35, { platform: 'windows', windowsExecution, docker: unavailable })
    assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
    assert.equal(built.plan.commands[0].id, 'validate-virtualization')
    assert.match(built.plan.commands[0].command, /FIRMWARE_VIRTUALIZATION_DISABLED/u)
    assert.match(built.plan.commands[0].command, /SVM Mode or AMD-V/u)
    assert.match(built.plan.commands[0].command, /nested virtualization/u)
    assert.deepEqual(built.plan.commands[1].dependsOn, ['validate-virtualization'])
    assert.match(built.plan.commands[1].command, /HypervisorPresent -and -not \$cpu\.SecondLevelAddressTranslationExtensions/u)
    assert.match(built.plan.commands.find(item => item.id === 'enable-wsl').command, /VirtualMachinePlatform/u)
    assert.match(built.plan.commands.find(item => item.id === 'enable-wsl').command, /Component Based Servicing\\RebootPending/u)
    assert.match(built.plan.commands.find(item => item.id === 'enable-wsl').command, /pendingRebootBefore=\[bool\]\$pendingReboot/u)
    assert.match(built.plan.commands.find(item => item.id === 'enable-wsl').command, /rebootRequired=\$false/u)
    assert.match(built.plan.commands.find(item => item.id === 'start-wsl-download').command, /wsl\.2\.7\.11\.0\.x64\.msi/u)
    assert.match(built.plan.commands.find(item => item.id === 'verify-wsl-installer').command, /a611ddacee689d2fb1fb5319e58af7f3998864d86cdce632eadd8e61614a0f9d/u)
    assert.deepEqual(built.plan.commands.find(item => item.id === 'wait-wsl-download').retry, { attempts: 120, intervalMs: 5000, exitCodes: [75] })
    assert.match(built.plan.commands.find(item => item.id === 'install-wsl-runtime').command, /msiexec\.exe/u)
    assert.match(built.plan.commands.find(item => item.id === 'start-docker-download').command, /DockerDesktop\.msi/u)
    assert.match(built.plan.commands.find(item => item.id === 'verify-docker-installer').command, /b80a2e8d0b33b752b74f31c82019f62bb0335e6960722af934a7186a0e921682/u)
    assert.match(built.plan.commands.find(item => item.id === 'install-docker-desktop').command, /ENGINE=wsl/u)
    assert.match(built.plan.commands.find(item => item.id === 'install-docker-desktop').command, /DISABLEWINDOWSCONTAINERS=1/u)
    assert.match(built.plan.commands.find(item => item.id === 'install-docker-desktop').command, /DISABLEANALYTICS=1/u)
    assert.match(built.plan.commands.find(item => item.id === 'install-docker-desktop').command, /docker-msi-install\.log/u)
    assert.match(built.plan.commands.find(item => item.id === 'start-docker-desktop').command, /Register-ScheduledTask/u)
    assert.match(built.plan.commands.find(item => item.id === 'start-docker-desktop').command, /LogonType Interactive/u)
    assert.match(built.plan.commands.find(item => item.id === 'start-docker-desktop').command, /WINDOWS_INTERACTIVE_USER_REQUIRED/u)
    assert.deepEqual(built.plan.commands.find(item => item.id === 'wait-docker-ready').retry, { attempts: 120, intervalMs: 5000, exitCodes: [75] })
    assert.match(built.plan.commands.find(item => item.id === 'wait-docker-ready').command, /Docker Compose version/u)
    assert.match(built.plan.commands.find(item => item.id === 'schedule-required-reboot').command, /WEBMINAI_REBOOT_SCHEDULED_30_SECONDS/u)
    assert.match(built.plan.commands.find(item => item.id === 'schedule-required-reboot').command, /Register-ScheduledTask/u)
    assert.match(built.plan.commands.find(item => item.id === 'schedule-required-reboot').command, /DeleteExpiredTaskAfter/u)
    assert.match(built.plan.commands.find(item => item.id === 'schedule-required-reboot').command, /Restart-Computer -Force/u)
    assert.match(built.plan.commands.find(item => item.id === 'schedule-required-reboot').command, /WebminAI-SSH-Recovery-35/u)
    assert.match(built.plan.commands.find(item => item.id === 'schedule-required-reboot').command, /Set-Service -Name 'sshd' -StartupType Automatic/u)
    assert.match(built.plan.commands.find(item => item.id === 'schedule-required-reboot').command, /Start-Service -Name 'Netdata'/u)
    assert.match(built.verifyApplied, /Start-Process -FilePath \$docker/u)
    assert.match(built.verifyApplied, /WaitForExit\(10000\)/u)
    assert.doesNotMatch(built.verifyApplied, /& \$docker info/u)
    assert.match(built.plan.changeOverview, new RegExp(`rerun the ${continuation}`, 'u'))
    assert.equal(built.plan.commands.some(item => item.id === 'write-compose'), false)
  }
})

test('reviewed Windows Brave and Docker bootstrap plans are reversible', () => {
  for (const catalogId of ['brave-windows', 'docker-desktop-windows']) {
    const built = buildCommonTask(catalogId, 36, { platform: 'windows', windowsExecution, docker })
    assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
    assert.ok(built.plan.revertCommands.length > 0)
  }
  const dockerBootstrap = buildCommonTask('docker-desktop-windows', 38, { platform: 'windows', windowsExecution, docker })
  assert.ok(dockerBootstrap.plan.revertCommands.some(item => item.id === 'uninstall-task-owned-wsl'))
  const brave = buildCommonTask('brave-windows', 37, { platform: 'windows', windowsExecution, docker })
  assert.match(brave.plan.commands[0].command, /releases\/latest/u)
  assert.match(brave.plan.commands[0].command, /BraveBrowserStandaloneSetup\.exe\.sha256/u)
  assert.match(brave.plan.commands[0].command, /Get-AuthenticodeSignature/u)
})

test('Windows WordPress task requires Linux-container Docker and protects credentials', () => {
  const built = buildCommonTask('wordpress-windows', 41, { platform: 'windows', windowsExecution, docker })
  assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
  assert.match(built.plan.commands.find(item => item.id === 'capture-baseline').command, /serverOs -ne 'linux'/u)
  assert.match(built.plan.commands.find(item => item.id === 'capture-baseline').command, /Start-Process -FilePath \$dockerExe/u)
  assert.match(built.plan.commands.find(item => item.id === 'generate-credentials').command, /SetAccessRuleProtection/u)
  assert.match(built.plan.commands.find(item => item.id === 'generate-credentials').command, /S-1-5-18/u)
  assert.match(built.plan.commands.find(item => item.id === 'generate-credentials').command, /S-1-5-32-544/u)
  assert.match(built.plan.commands.find(item => item.id === 'write-compose').command, /wordpress:7\.0\.2-php8\.3-fpm/u)
  assert.match(built.plan.commands.find(item => item.id === 'write-compose').command, /tmpfs: \["\/run\/webminai:size=64k,mode=0711"\]/u)
  assert.match(built.plan.commands.find(item => item.id === 'write-compose').command, /WORDPRESS_DB_PASSWORD_FILE: \/run\/secrets\/db_password/u)
  assert.match(built.plan.commands.find(item => item.id === 'write-compose').command, /C:\/ProgramData\/WebminAI\/credentials\/wordpress\/db_password/u)
  assert.doesNotMatch(built.plan.commands.find(item => item.id === 'write-compose').command, /[a-f0-9]{64}/u)
  assert.equal(built.plan.commands.find(item => item.id === 'pull-images').executionMode, 'job')
  assert.match(built.plan.commands.find(item => item.id === 'initialize-wordpress').command, /Success: Database checked/u)
  assert.match(built.plan.commands.find(item => item.id === 'initialize-wordpress').command, /option get siteurl/u)
  assert.equal(built.plan.revertCommands.find(item => item.id === 'remove-compose-project').executionMode, 'job')
  assert.match(built.verifyApplied, /WEBMINAI_WORDPRESS_OK/u)
})

test('Windows WooCommerce task reuses the foundation and pins the verified plugin digest', () => {
  const built = buildCommonTask('woocommerce-windows', 42, { platform: 'windows', windowsExecution, docker })
  assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
  const install = built.plan.commands.find(item => item.id === 'install-woocommerce')
  assert.match(install.command, /woocommerce\.11\.0\.0\.zip/u)
  assert.match(install.command, /ba08c7fc58c98a11f22866269c5832d85c52b664806ec206036f09737ba21666/u)
  assert.match(built.verifyApplied, /plugin is-active woocommerce/u)
  assert.match(built.verifyApplied, /WEBMINAI_WOOCOMMERCE_OK/u)
})

test('Windows Joomla task reuses the promoted ismet Compose matrix and Windows substrate', () => {
  const built = buildCommonTask('joomla-windows', 45, { platform: 'windows', windowsExecution, docker })
  assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
  assert.match(built.plan.commands.find(item => item.id === 'write-compose').command, /joomla:5\.4\.7-php8\.3-fpm/u)
  assert.match(built.plan.commands.find(item => item.id === 'write-compose').command, /mariadb:11\.8\.8/u)
  assert.match(built.plan.commands.find(item => item.id === 'write-compose').command, /fastcgi_pass unix:\/run\/php-fpm\/webminai\.sock/u)
  assert.match(built.plan.commands.find(item => item.id === 'initialize-joomla').command, /WEBMINAI_ADMIN_PASSWORD_FILE=\/run\/secrets\/admin_password/u)
  assert.doesNotMatch(built.plan.commands.find(item => item.id === 'write-compose').command, /[a-f0-9]{64}/u)
  assert.equal(built.plan.commands.find(item => item.id === 'pull-images').executionMode, 'job')
  assert.equal(built.plan.revertCommands.find(item => item.id === 'remove-compose-project').executionMode, 'job')
  assert.match(built.verifyApplied, /WEBMINAI_JOOMLA_OK/u)
})

test('Windows Drupal task reuses the promoted ismet Compose installer and Windows substrate', () => {
  const built = buildCommonTask('drupal-windows', 43, { platform: 'windows', windowsExecution, docker })
  assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /drupal:11\.4\.4-php8\.4-fpm/u)
  assert.match(commands, /install-drupal\.php/u)
  assert.match(commands, /reconcile-drupal\.php/u)
  assert.match(commands, /WEBMINAI_DRUPAL_OK/u)
  assert.match(commands, /webminai\.sock/u)
  assert.doesNotMatch(commands, /[a-f0-9]{64}.*(?:password|credential)/iu)
  assert.match(built.verifyApplied, /sites\/default\/files\/\.webminai-cron-ok/u)
})

test('Windows PrestaShop task stages the promoted ismet installer on the Windows substrate', () => {
  const built = buildCommonTask('prestashop-windows', 44, { platform: 'windows', windowsExecution, docker })
  assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /prestashop\/prestashop:9\.1\.4-5\.0-classic-8\.4-fpm/u)
  assert.match(commands, /--step=database/u)
  assert.match(commands, /--step=modules --modules=ps_linklist/u)
  assert.match(commands, /--step=theme,postInstall/u)
  assert.match(commands, /admin-webminai/u)
  assert.match(built.verifyApplied, /WEBMINAI_PRESTASHOP_OK/u)
})

test('Windows Moodle task uses protected inputs and durable jobs for long phases', () => {
  const built = buildCommonTask('moodle-windows', 52, { platform: 'windows', windowsExecution, docker })
  assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /webminai\/moodle:5\.2\.1-php8\.4-fpm-r2/u)
  assert.match(commands, /php:8\.4\.23-fpm-bookworm/u)
  assert.match(commands, /fastcgi_pass unix:\/run\/php-fpm\/webminai\.sock/u)
  assert.match(commands, /WEBMINAI_DB_PASS_FILE=\/run\/webminai\/db_password/u)
  assert.match(commands, /WEBMINAI_MOODLE_OK/u)
  assert.equal(built.plan.commands.find(item => item.id === 'pull-images').executionMode, 'job')
  assert.equal(built.plan.commands.find(item => item.id === 'initialize-moodle').executionMode, 'job')
  assert.doesNotMatch(commands, /admin_password:\s*[A-Za-z0-9_-]{32}/u)
})

test('Windows Magento task uses the promoted digest matrix and durable lifecycle phases', () => {
  const built = buildCommonTask('magento-windows', 53, { platform: 'windows', windowsExecution, docker })
  assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /mappia\/magento2@sha256:/u)
  assert.match(commands, /opensearchproject\/opensearch@sha256:/u)
  assert.match(commands, /valkey\/valkey@sha256:/u)
  assert.match(commands, /fastcgi_backend \{ server unix:\/run\/php-fpm\/webminai\.sock/u)
  assert.match(commands, /WEBMINAI_DB_PASSWORD_FILE=\/run\/webminai\/db_password/u)
  for (const id of ['pull-images', 'prepare-code', 'start-dependencies', 'initialize-magento', 'compile-magento', 'finalize-magento', 'verify-restart']) {
    assert.equal(built.plan.commands.find(item => item.id === id).executionMode, 'job')
  }
  assert.doesNotMatch(commands, /admin_password:\s*[A-Za-z0-9_-]{32}/u)
})

test('Windows n8n task protects its encryption key and persists SQLite', () => {
  const built = buildCommonTask('n8n-windows', 46, { platform: 'windows', windowsExecution, docker })
  assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /docker\.n8n\.io\/n8nio\/n8n:2\.33\.7/u)
  assert.match(commands, /encryption_key/u)
  assert.match(commands, /database\.sqlite/u)
  assert.match(commands, /WEBMINAI_N8N_OK/u)
  assert.doesNotMatch(commands, /N8N_ENCRYPTION_KEY=[a-f0-9]{64}/u)
})

test('Windows Ghost task reuses digest-pinned ismet images and protected environment storage', () => {
  const built = buildCommonTask('ghost-windows', 47, { platform: 'windows', windowsExecution, docker })
  assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /ghost@sha256:/u)
  assert.match(commands, /mysql@sha256:/u)
  assert.match(commands, /credentials\\ghost\\credentials\.env/u)
  assert.match(commands, /WEBMINAI_GHOST_OK/u)
  assert.doesNotMatch(commands, /MYSQL_PASSWORD=[A-Za-z0-9_-]{32}/u)
})

test('Windows Mattermost task reuses ismet images and does not embed database credentials', () => {
  const built = buildCommonTask('mattermost-windows', 48, { platform: 'windows', windowsExecution, docker })
  assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /mattermost-team-edition@sha256:/u)
  assert.match(commands, /postgres@sha256:/u)
  assert.match(commands, /WEBMINAI_MATTERMOST_OK/u)
  assert.match(commands, /credentials\\mattermost\\credentials\.env/u)
  assert.doesNotMatch(commands, /POSTGRES_PASSWORD=[A-Za-z0-9_-]{32}/u)
})

test('Windows Odoo task reuses ismet images and protected Compose secrets', () => {
  const built = buildCommonTask('odoo-windows', 49, { platform: 'windows', windowsExecution, docker })
  assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /odoo@sha256:/u)
  assert.match(commands, /postgres@sha256:/u)
  assert.match(commands, /WEBMINAI_ODOO_OK/u)
  assert.match(commands, /credentials\/odoo\/database_password/u)
})

test('Windows Jellyfin task reuses ismet images and protected onboarding credentials', () => {
  const built = buildCommonTask('jellyfin-windows', 50, { platform: 'windows', windowsExecution, docker })
  assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /jellyfin\/jellyfin@sha256:/u)
  assert.match(commands, /Startup\/Complete/u)
  assert.match(commands, /WEBMINAI_JELLYFIN_OK/u)
  assert.doesNotMatch(commands, /Password=[A-Za-z0-9_-]{32}/u)
})

test('Windows Home Assistant task reuses the isolated ismet topology', () => {
  const built = buildCommonTask('home-assistant-windows', 51, { platform: 'windows', windowsExecution, docker })
  assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
  const commands = built.plan.commands.map(item => item.command).join('\n')
  assert.match(commands, /home-assistant@sha256:/u)
  assert.match(commands, /api\/onboarding\/users/u)
  assert.match(commands, /WEBMINAI_HOME_ASSISTANT_OK/u)
  assert.doesNotMatch(commands, /password=['"][A-Za-z0-9_-]{32}/u)
})

test('Windows application tasks reject Windows-container mode and disabled Docker', () => {
  assert.throws(
    () => buildCommonTask('wordpress-windows', 43, { platform: 'windows', windowsExecution: { ...windowsExecution, docker: { ...windowsExecution.docker, serverOs: 'windows' } }, docker }),
    /Linux-container mode/u
  )
  assert.throws(
    () => buildCommonTask('wordpress-windows', 44, { platform: 'windows', windowsExecution, docker: { ...docker, preference: 'disabled', preferred: false } }),
    /disabled/u
  )
})
