import { drupalComposeAssets } from './drupal-task.js'
import { buildWindowsComposeApplicationTask, windowsComposePullCommand, windowsDockerPowerShellAdapter } from './windows-compose-foundation.js'

const IMAGE = 'drupal:11.4.4-php8.4-fpm'
const NGINX = 'nginx:1.30.4-alpine'
const DATABASE = 'mariadb:11.8.8'
const PORT = 18104
const MARKER = 'WEBMINAI_DRUPAL_OK'
const PROJECT = 'webminai-drupal-18104'
const ROOT = 'C:\\ProgramData\\WebminAI\\Services\\drupal'
const CREDENTIALS = 'C:\\ProgramData\\WebminAI\\credentials\\drupal'

export function buildWindowsDrupalComposeTask (taskId, windowsExecution, docker) {
  return buildWindowsComposeApplicationTask({
    taskId,
    windowsExecution,
    docker,
    application: 'drupal',
    port: PORT,
    images: [IMAGE, NGINX, DATABASE],
    summary: 'Deploy a verified Windows Docker Drupal site',
    changeOverview: `Reuse the promoted ismet matrix to deploy Drupal 11.4.4 on Windows Docker port ${PORT}.`,
    modifiedFiles: [`${ROOT}\\php-fpm.conf`, `${ROOT}\\nginx.conf`, `${ROOT}\\install-drupal.php`, `${ROOT}\\reconcile-drupal.php`],
    assumptions: [`Docker reports Linux-container mode (${windowsExecution.docker.serverVersion ?? 'version unavailable'}) and Compose is available to LocalSystem.`, 'Database and administrator credentials are generated on-host and mounted only as protected files.'],
    warnings: ['Docker Desktop must remain running for the site to remain available.', `The task creates a scoped inbound firewall rule for TCP ${PORT}.`],
    commands: [
      command('write-compose', 'configure', writeCommand(), 'Write the ismet-promoted Drupal PHP-FPM, nginx, MariaDB, and protected installer assets', ['generate-credentials']),
      command('pull-images', 'acquire', windowsComposePullCommand(ROOT, PROJECT), 'Pull the pinned Drupal, nginx, and MariaDB images', ['write-compose']),
      command('start-compose', 'services', startCommand(), 'Start MariaDB, Drupal PHP-FPM, and nginx and wait for the Unix socket', ['pull-images']),
      command('initialize-drupal', 'initialize', initializeCommand(), 'Install Drupal using mounted protected credential files', ['start-compose']),
      command('reconcile-drupal', 'initialize', reconcileCommand(), 'Reconcile Drupal site content and cron, then verify the external marker', ['initialize-drupal']),
      command('verify-restart', 'verify', verifyCommand(), 'Verify Drupal configuration, cron, socket, marker, login, and restart recovery', ['reconcile-drupal'], 300000, undefined, 'read')
    ],
    verifyApplied: verifyCommand(false)
  })
}

function startCommand () {
  return ps(["$ErrorActionPreference='Stop'", windowsDockerPowerShellAdapter(), `Set-Location -LiteralPath '${q(ROOT)}'`, `& $docker compose -p '${PROJECT}' up -d db drupal nginx`, "if($LASTEXITCODE-ne 0){throw 'Drupal Compose startup failed.'}", `$ready=$false;for($i=0;$i-lt 120;$i++){& $docker compose -p '${PROJECT}' exec -T drupal test -S /run/php-fpm/webminai.sock *> $null;if($LASTEXITCODE-eq 0){$ready=$true;break};Start-Sleep 2};if(-not $ready){throw 'Drupal PHP-FPM socket did not become ready.'}`, "Write-Output 'compose-started'"])
}

function writeCommand () {
  const assets = drupalComposeAssets()
  const compose = [
    'services:',
    '  db:',
    `    image: ${DATABASE}`,
    '    restart: unless-stopped',
    '    environment:',
    '      MARIADB_DATABASE: webminai_drupal_18104',
    '      MARIADB_USER: webminai_drupal_18104',
    '      MARIADB_PASSWORD_FILE: /run/secrets/db_password',
    '      MARIADB_ROOT_PASSWORD_FILE: /run/secrets/db_root_password',
    '    secrets: [db_password, db_root_password]',
    '    volumes: [db_data:/var/lib/mysql]',
    '    healthcheck:',
    '      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]',
    '      interval: 5s',
    '      timeout: 5s',
    '      retries: 60',
    '  drupal:',
    `    image: ${IMAGE}`,
    '    restart: unless-stopped',
    '    depends_on:',
    '      db: { condition: service_healthy }',
    '    secrets: [db_password, admin_password]',
    '    volumes:',
    '      - drupal_data:/var/www/html',
    '      - php_run:/run/php-fpm',
    '      - ./php-fpm.conf:/usr/local/etc/php-fpm.d/zz-webminai-socket.conf:ro',
    '      - ./install-drupal.php:/run/webminai/install-drupal.php:ro',
    '      - ./reconcile-drupal.php:/run/webminai/reconcile-drupal.php:ro',
    '  nginx:',
    `    image: ${NGINX}`,
    '    restart: unless-stopped',
    '    depends_on: [drupal]',
    `    ports: ["${PORT}:80"]`,
    '    volumes:',
    '      - drupal_data:/var/www/html:ro',
    '      - php_run:/run/php-fpm',
    '      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro',
    'secrets:',
    `  db_password: { file: "${slash(CREDENTIALS)}/db_password" }`,
    `  db_root_password: { file: "${slash(CREDENTIALS)}/db_root_password" }`,
    `  admin_password: { file: "${slash(CREDENTIALS)}/admin_password" }`,
    'volumes:',
    '  db_data:',
    '  drupal_data:',
    '  php_run:'
  ].join('\n')
  return ps([
    "$ErrorActionPreference='Stop'",
    `New-Item -Path '${q(ROOT)}' -ItemType Directory -Force|Out-Null`,
    write(`${ROOT}\\compose.yaml`, compose),
    write(`${ROOT}\\php-fpm.conf`, assets.phpFpm.join('\n') + '\n'),
    write(`${ROOT}\\nginx.conf`, assets.nginx.join('\n') + '\n'),
    write(`${ROOT}\\install-drupal.php`, assets.installer.join('\n') + '\n'),
    write(`${ROOT}\\reconcile-drupal.php`, assets.reconciler.join('\n') + '\n'),
    `if(-not(Get-NetFirewallRule -Name '${PROJECT}' -ErrorAction SilentlyContinue)){New-NetFirewallRule -Name '${PROJECT}' -DisplayName 'Intent AI Ops ${PROJECT}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PORT} -Profile Any|Out-Null}`,
    `if((Get-Content -LiteralPath '${q(ROOT)}\\compose.yaml' -Raw)-match '[a-f0-9]{64}'){throw 'Compose must not contain generated credential values.'}`,
    "Write-Output 'drupal-compose-written'"
  ])
}

function initializeCommand () {
  const install = 'WEBMINAI_DRUPAL_ROOT=/var/www/html WEBMINAI_DB_HOST=db WEBMINAI_DB_NAME=webminai_drupal_18104 WEBMINAI_DB_USER=webminai_drupal_18104 WEBMINAI_DB_PASS_FILE=/run/secrets/db_password WEBMINAI_ADMIN_PASS_FILE=/run/secrets/admin_password php /run/webminai/install-drupal.php >/dev/null 2>&1'
  const status = `& $docker compose -p '${PROJECT}' exec -T drupal /bin/sh -c 'if [ -f /var/www/html/sites/default/.webminai-installed ]; then echo INSTALLED; else echo ABSENT; fi' 2>$null`
  return ps([
    "$ErrorActionPreference='Stop'",
    windowsDockerPowerShellAdapter(),
    `Set-Location -LiteralPath '${q(ROOT)}'`,
    `$state=(${status}|Out-String).Trim()`,
    `if($state -ne 'INSTALLED'){& $docker compose -p '${PROJECT}' exec -T drupal /bin/sh -c '${q(install)}' *> $null;$state=(${status}|Out-String).Trim();if($state -ne 'INSTALLED'){throw 'Drupal initialization did not create its completion marker.'}}`,
    "Write-Output 'drupal-initialized'"
  ])
}

function reconcileCommand () {
  const reconcile = `WEBMINAI_DRUPAL_ROOT=/var/www/html WEBMINAI_DRUPAL_URL=http://127.0.0.1:${PORT}/ php /run/webminai/reconcile-drupal.php >/dev/null 2>&1`
  const status = `& $docker compose -p '${PROJECT}' exec -T drupal /bin/sh -c 'if [ -f /var/www/html/sites/default/files/.webminai-cron-ok ]; then echo RECONCILED; else echo ABSENT; fi' 2>$null`
  return ps([
    "$ErrorActionPreference='Stop'",
    windowsDockerPowerShellAdapter(),
    `Set-Location -LiteralPath '${q(ROOT)}'`,
    `$state=(${status}|Out-String).Trim();if($state -ne 'RECONCILED'){& $docker compose -p '${PROJECT}' exec -T drupal /bin/sh -c '${q(reconcile)}' *> $null;$state=(${status}|Out-String).Trim();if($state -ne 'RECONCILED'){throw 'Drupal reconciliation did not create its cron marker.'}}`,
    markerWait(),
    "Write-Output 'drupal-reconciled'"
  ])
}

function verifyCommand (restart = true) {
  return ps([
    "$ErrorActionPreference='Stop'",
    windowsDockerPowerShellAdapter(),
    `Set-Location -LiteralPath '${q(ROOT)}'`,
    ...(restart ? [`& $docker compose -p '${PROJECT}' restart db drupal nginx *> $null`] : []),
    `& $docker compose -p '${PROJECT}' exec -T drupal test -S /run/php-fpm/webminai.sock`,
    "if($LASTEXITCODE -ne 0){throw 'Drupal PHP-FPM socket verification failed.'}",
    `& $docker compose -p '${PROJECT}' exec -T drupal test -f /var/www/html/sites/default/files/.webminai-cron-ok`,
    "if($LASTEXITCODE -ne 0){throw 'Drupal cron verification failed.'}",
    markerWait(),
    `$login=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${PORT}/user/login' -TimeoutSec 10).Content`,
    "if($login -notlike '*form_id*'){throw 'Drupal login verification failed.'}",
    "Write-Output 'verification-passed'"
  ])
}

function markerWait () { return `$ok=$false;for($i=0;$i -lt 90;$i++){try{$body=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${PORT}/' -TimeoutSec 5).Content;if($body -like '*${MARKER}*'){$ok=$true;break}}catch{};Start-Sleep 2};if(-not $ok){throw '${MARKER} was not returned.'}` }
function write (path, value) { return `[IO.File]::WriteAllText('${q(path)}',@'\n${value}\n'@,[Text.UTF8Encoding]::new($false))` }
function slash (value) { return value.replaceAll('\\', '/') }
function ps (values) { return values.join(';') }
function q (value) { return String(value).replaceAll("'", "''") }
function command (id, phase, text, purpose, dependsOn, timeoutMs = 300000, executionMode, risk = 'change') { return { id, phase, command: text, purpose, dependsOn, timeoutMs, executionMode, risk } }
