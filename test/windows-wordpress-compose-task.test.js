import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCommonTask, listCommonTasks } from '../src/common-tasks.js'
import { rootExecutionPolicy } from '../src/execution-policy.js'
import { validateCommandPlan } from '../src/plan-validator.js'
import { validateWindowsPlan } from '../src/planner-platform-policy.js'
import { windowsDockerPowerShellAdapter } from '../src/windows-compose-foundation.js'

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

test('Windows Docker adapter retains native status and never infers success from output', () => {
  const command = windowsDockerPowerShellAdapter(10000)
  assert.ok(command.indexOf('$null=$process.Handle') < command.indexOf('$process.WaitForExit'))
  assert.match(command, /if\(\$null -eq \$exitCode\)\{throw/u)
  assert.match(command, /\$global:LASTEXITCODE=\[int\]\$exitCode/u)
  assert.doesNotMatch(command, /elseif\(\$stderrText/u)
})

test('Windows cold image pulls use the advertised durable timeout and shared native adapter', () => {
  for (const id of ['wordpress-windows', 'woocommerce-windows', 'joomla-windows', 'drupal-windows', 'prestashop-windows', 'n8n-windows', 'ghost-windows', 'mattermost-windows', 'odoo-windows', 'jellyfin-windows', 'home-assistant-windows']) {
    const { plan } = buildCommonTask(id, 901, { platform: 'windows', windowsExecution, docker })
    const pull = plan.commands.find(command => command.id === 'pull-images')
    assert.equal(pull.executionMode, 'job')
    assert.equal(pull.timeoutMs, 3600000)
    assert.match(pull.command, /WaitForExit\(3600000\)/u)
    assert.match(pull.command, /\$null=\$process\.Handle/u)
    const start = plan.commands.find(command => command.id === 'start-compose')
    assert.deepEqual(start.dependsOn, ['pull-images'])
    assert.doesNotMatch(start.command, /compose -p '[^']+' pull/u)
  }
})

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
    assert.equal(built.plan.commands.find(item => item.id === 'install-wsl-runtime').executionMode, 'job')
    assert.equal(built.plan.commands.find(item => item.id === 'install-docker-desktop').executionMode, 'job')
    assert.equal(built.plan.revertCommands.find(item => item.id === 'uninstall-task-owned-wsl').executionMode, 'job')
    assert.equal(built.plan.revertCommands.find(item => item.id === 'uninstall-task-owned-docker').executionMode, 'job')
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
    const ready = built.plan.commands.find(item => item.id === 'wait-docker-ready').command
    assert.ok(ready.indexOf('if($progress.rebootRequired)') < ready.indexOf('Docker CLI is missing'))
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
  const bootstrap = buildCommonTask('docker-desktop-windows', 36, { platform: 'windows', windowsExecution, docker })
  assert.match(bootstrap.plan.commands.find(item => item.id === 'preflight').command, /Get-CimInstance Win32_PhysicalMemory -ErrorAction Stop\|Measure-Object Capacity -Sum/u)
  assert.match(bootstrap.plan.commands.find(item => item.id === 'preflight').command, /if\(\$installed -lt 8GB\)/u)
  for (const id of ['wait-wsl-download', 'wait-docker-download']) {
    const command = bootstrap.plan.commands.find(item => item.id === id).command
    assert.ok(command.indexOf('if($progress.rebootRequired)') >= 0)
    assert.ok(command.indexOf('if($progress.rebootRequired)') < command.indexOf('Get-BitsTransfer'))
  }
  for (const catalogId of ['brave-windows', 'docker-desktop-windows']) {
    const built = buildCommonTask(catalogId, 36, { platform: 'windows', windowsExecution, docker })
    assert.equal(validateCommandPlan(built.plan, rootExecutionPolicy({})), built.plan)
    assert.ok(built.plan.revertCommands.length > 0)
  }
  const dockerBootstrap = buildCommonTask('docker-desktop-windows', 38, { platform: 'windows', windowsExecution, docker })
  assert.match(dockerBootstrap.plan.commands.find(item => item.id === 'preflight').command, /dockerPathPresent=\[bool\]\$pathPresent/u)
  const uninstall = dockerBootstrap.plan.revertCommands[0].command
  assert.ok(uninstall.indexOf('Docker PATH ownership baseline is unavailable') < uninstall.indexOf('Start-Process'))
  assert.match(uninstall, /if\(-not \$baseline\.dockerPathPresent\)/u)
  assert.match(uninstall, /Duplicate Docker PATH entries require operator review/u)
  assert.ok(dockerBootstrap.plan.revertCommands.some(item => item.id === 'uninstall-task-owned-wsl'))
  const brave = buildCommonTask('brave-windows', 37, { platform: 'windows', windowsExecution, docker })
  assert.doesNotThrow(() => validateWindowsPlan(brave.plan, { webminaiExecution: windowsExecution }, 'install Brave'))
  assert.match(brave.plan.revertCommands[0].command, /\$process\.ExitCode -notin @\(0,19\)/u)
  assert.match(brave.plan.revertCommands[0].command, /Brave remains installed after uninstall/u)
  assert.match(brave.plan.commands[0].command, /releases\/latest/u)
  assert.match(brave.plan.commands[0].command, /BraveBrowserStandaloneSetup\.exe\.sha256/u)
  const installBrave = brave.plan.commands.find(item => item.id === 'install-brave')
  assert.match(installBrave.command, /Get-AuthenticodeSignature/u)
  assert.match(brave.plan.commands[0].command, /if\(Test-Path -LiteralPath \$curl -PathType Leaf\)/u)
  assert.match(brave.plan.commands[0].command, /Start-BitsTransfer.*-Asynchronous/u)
  assert.match(brave.plan.commands[0].command, /else\{Invoke-WebRequest[^}]+-TimeoutSec 30 -ErrorAction Stop\}/u)
  const waitBrave = brave.plan.commands.find(item => item.id === 'wait-brave-download')
  assert.deepEqual(waitBrave.retry.exitCodes, [75])
  assert.match(waitBrave.command, /Complete-BitsTransfer/u)
  assert.doesNotMatch(waitBrave.command, /Start-BitsTransfer/u)
  assert.deepEqual(installBrave.dependsOn, ['wait-brave-download'])
  assert.doesNotMatch(brave.plan.commands[0].command, /--insecure/u)
  assert.equal(brave.plan.commands[0].executionMode, 'job')
  assert.equal(brave.plan.revertCommands[0].executionMode, 'job')
  assert.match(brave.plan.revertCommands[0].command, /Get-AuthenticodeSignature -LiteralPath \$file/u)
  assert.match(brave.plan.revertCommands[0].command, /--force-uninstall/u)
  assert.match(brave.plan.revertCommands[0].command, /must preserve user profiles/u)
  const verify = brave.plan.commands.find(item => item.id === 'verify-brave')
  assert.deepEqual(verify.dependsOn, ['install-brave'])
  assert.equal(verify.risk, 'read')
  assert.match(verify.command, /Get-AuthenticodeSignature -LiteralPath \$file/u)
  assert.match(verify.command, /FileVersionInfo/u)
  assert.match(verify.command, /ProgramFiles\(x86\)/u)
  assert.match(brave.stateProbe, /entries=\$entries;taskState=Test-Path/u)
  assert.doesNotMatch(brave.stateProbe, /throw 'Brave is absent/u)
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
  const verify = built.plan.commands.find(item => item.id === 'verify-restart').command
  assert.match(verify, /foreach\(\$service in @\('db','opensearch','valkey'\)\)/u)
  assert.match(verify, /\$attempt-lt 120/u)
  assert.ok(verify.indexOf('Magento dependency health did not recover.') < verify.indexOf('OpenSearch health failed.'))
  assert.match(verify, /\$LASTEXITCODE-ne 0-or\$pong-ne'PONG'/u)
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
  assert.match(commands, /proxy_pass http:\/\/n8n:5678/u)
  assert.match(built.verifyApplied, /\$probe-lt 60/u)
  assert.match(built.verifyApplied, /n8n application UI and proxied health did not become ready/u)
  assert.match(commands, /location = \/webminai-health/u)
  assert.match(commands, /proxy_set_header Upgrade \$http_upgrade/u)
  assert.match(commands, /N8N_PROXY_HOPS: "1"/u)
  assert.match(built.verifyApplied, /\/healthz/u)
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
  assert.match(commands, /map \$http_upgrade \$connection_upgrade/u)
  assert.match(commands, /proxy_set_header Connection \$connection_upgrade/u)
  assert.doesNotMatch(commands, /location \/api\//u)
  assert.match(built.verifyApplied, /ws:\/\/127\.0\.0\.1:18111\/api\/v4\/websocket/u)
  assert.match(built.verifyApplied, /CancellationTokenSource\]::new\(10000\)/u)
  assert.match(built.verifyApplied, /finally\{\$socket\.Abort\(\);\$socket\.Dispose\(\);\$deadline\.Dispose\(\)\}/u)
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

test('Windows application proxies publish the real UI separately from compatibility markers', () => {
  for (const app of ['n8n', 'mattermost', 'odoo', 'jellyfin', 'home-assistant']) {
    const built = buildCommonTask(`${app}-windows`, 901, { platform: 'windows', windowsExecution, docker })
    const configure = built.plan.commands.find(command => command.id === 'write-compose').command
    assert.match(configure, /location = \/webminai-health/u)
    assert.match(configure, /location \/ \{ proxy_pass http:\/\//u)
    assert.match(configure, /proxy_set_header Host \$http_host/u)
    assert.doesNotMatch(configure, /location = \/ \{[^}]*return 200/u)
    assert.match(built.verifyApplied, /application UI|Application UI/u)
    assert.match(built.verifyApplied, /doctype/u)
    assert.match(built.verifyApplied, /\/webminai-health/u)
  }
})
