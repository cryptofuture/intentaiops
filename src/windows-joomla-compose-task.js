import { buildWindowsComposeApplicationTask, windowsComposePullCommand, windowsDockerPowerShellAdapter } from './windows-compose-foundation.js'

const VERSION = '5.4.7'
const JOOMLA_IMAGE = `joomla:${VERSION}-php8.3-fpm`
const NGINX_IMAGE = 'nginx:1.30.4-alpine'
const DATABASE_IMAGE = 'mariadb:11.8.8'
const PORT = 18103
const MARKER = 'WEBMINAI_JOOMLA_OK'
const PROJECT = 'webminai-joomla-18103'
const ROOT = 'C:\\ProgramData\\WebminAI\\Services\\joomla'
const CREDENTIALS = 'C:\\ProgramData\\WebminAI\\credentials\\joomla'

export function buildWindowsJoomlaComposeTask (taskId, windowsExecution, docker) {
  return buildWindowsComposeApplicationTask({
    taskId,
    windowsExecution,
    docker,
    application: 'joomla',
    port: PORT,
    images: [JOOMLA_IMAGE, NGINX_IMAGE, DATABASE_IMAGE],
    summary: 'Deploy a verified Windows Docker Joomla site',
    changeOverview: `Reuse the promoted ismet Compose matrix to deploy Joomla ${VERSION}, nginx, and MariaDB on Windows Docker port ${PORT}.`,
    modifiedFiles: [`${ROOT}\\php-fpm.conf`, `${ROOT}\\nginx.conf`, `${ROOT}\\installer-argv.php`],
    assumptions: [`Docker reports Linux-container mode (${windowsExecution.docker.serverVersion ?? 'version unavailable'}) and Compose is available to LocalSystem.`, `The ismet-verified images ${JOOMLA_IMAGE}, ${NGINX_IMAGE}, and ${DATABASE_IMAGE} form the reviewed compatibility row.`, 'Database and administrator credentials are generated on-host, protected by SID ACLs, and mounted as files.'],
    warnings: ['Docker Desktop must remain running for the site to remain available.', `The task creates a scoped inbound firewall rule for TCP ${PORT}.`],
    commands: [
      command('write-compose', 'configure', writeComposeCommand(), 'Write the ismet-verified Joomla Compose topology with Windows paths and protected file-backed secrets', ['generate-credentials']),
      command('pull-images', 'acquire', windowsComposePullCommand(ROOT, PROJECT), 'Pull the pinned Joomla, nginx, and MariaDB images', ['write-compose']),
      command('start-compose', 'services', startCommand(), 'Start MariaDB, Joomla PHP-FPM, and nginx and wait for the Unix socket', ['pull-images']),
      command('initialize-joomla', 'initialize', initializeCommand(), 'Initialize Joomla non-interactively using mounted credential files', ['start-compose']),
      command('verify-restart', 'verify', verifyCommand(), 'Verify Joomla configuration, database-backed HTTP health, PHP-FPM socket, and restart recovery', ['initialize-joomla'], 300000, undefined, 'read')
    ],
    verifyApplied: verifyCommand(false)
  })
}

function startCommand () {
  return ps(["$ErrorActionPreference='Stop'", windowsDockerPowerShellAdapter(), `Set-Location -LiteralPath '${quote(ROOT)}'`, `& $docker compose -p '${PROJECT}' up -d db joomla nginx`, "if($LASTEXITCODE-ne 0){throw 'Joomla Compose startup failed.'}", `$ready=$false;for($i=0;$i-lt 120;$i++){& $docker compose -p '${PROJECT}' exec -T joomla test -S /run/php-fpm/webminai.sock *> $null;if($LASTEXITCODE-eq 0){$ready=$true;break};Start-Sleep 2};if(-not $ready){throw 'Joomla PHP-FPM socket did not become ready.'}`, "Write-Output 'compose-started'"])
}

function writeComposeCommand () {
  const compose = [
    'services:',
    '  db:',
    `    image: ${DATABASE_IMAGE}`,
    '    restart: unless-stopped',
    '    environment:',
    '      MARIADB_DATABASE: webminai_joomla_18103',
    '      MARIADB_USER: webminai_joomla_18103',
    '      MARIADB_PASSWORD_FILE: /run/secrets/db_password',
    '      MARIADB_ROOT_PASSWORD_FILE: /run/secrets/db_root_password',
    '    secrets: [db_password, db_root_password]',
    '    volumes: [db_data:/var/lib/mysql]',
    '    healthcheck:',
    '      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]',
    '      interval: 5s',
    '      timeout: 5s',
    '      retries: 60',
    '  joomla:',
    `    image: ${JOOMLA_IMAGE}`,
    '    restart: unless-stopped',
    '    depends_on:',
    '      db: { condition: service_healthy }',
    '    environment:',
    '      JOOMLA_DB_HOST: db:3306',
    '      JOOMLA_DB_NAME: webminai_joomla_18103',
    '      JOOMLA_DB_USER: webminai_joomla_18103',
    '      JOOMLA_DB_PASSWORD_FILE: /run/secrets/db_password',
    '    secrets: [db_password, admin_password]',
    '    volumes:',
    '      - joomla_data:/var/www/html',
    '      - php_run:/run/php-fpm',
    '      - ./php-fpm.conf:/usr/local/etc/php-fpm.d/zz-webminai-socket.conf:ro',
    '      - ./installer-argv.php:/run/webminai/installer-argv.php:ro',
    '  nginx:',
    `    image: ${NGINX_IMAGE}`,
    '    restart: unless-stopped',
    '    depends_on: [joomla]',
    `    ports: ["${PORT}:80"]`,
    '    volumes:',
    '      - joomla_data:/var/www/html:ro',
    '      - php_run:/run/php-fpm',
    '      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro',
    'secrets:',
    `  db_password: { file: "${CREDENTIALS.replaceAll('\\', '/')}/db_password" }`,
    `  db_root_password: { file: "${CREDENTIALS.replaceAll('\\', '/')}/db_root_password" }`,
    `  admin_password: { file: "${CREDENTIALS.replaceAll('\\', '/')}/admin_password" }`,
    'volumes:',
    '  db_data:',
    '  joomla_data:',
    '  php_run:'
  ].join('\n')
  const fpm = '[www]\nlisten = /run/php-fpm/webminai.sock\nlisten.owner = www-data\nlisten.group = www-data\nlisten.mode = 0666\n'
  const nginx = 'server { listen 80 default_server; root /var/www/html; index index.php index.html; location / { try_files $uri $uri/ /index.php?$args; } location ~ \\.php$ { try_files $uri =404; include fastcgi_params; fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name; fastcgi_pass unix:/run/php-fpm/webminai.sock; } location ~ /\\. { deny all; } }\n'
  const bootstrap = installerBootstrapLines().join('\n') + '\n'
  return ps([
    "$ErrorActionPreference='Stop'",
    `New-Item -Path '${quote(ROOT)}' -ItemType Directory -Force|Out-Null`,
    `[IO.File]::WriteAllText('${quote(ROOT)}\\compose.yaml',@'\n${compose}\n'@,[Text.UTF8Encoding]::new($false))`,
    `[IO.File]::WriteAllText('${quote(ROOT)}\\php-fpm.conf',@'\n${fpm}'@,[Text.UTF8Encoding]::new($false))`,
    `[IO.File]::WriteAllText('${quote(ROOT)}\\nginx.conf',@'\n${nginx}'@,[Text.UTF8Encoding]::new($false))`,
    `[IO.File]::WriteAllText('${quote(ROOT)}\\installer-argv.php',@'\n${bootstrap}'@,[Text.UTF8Encoding]::new($false))`,
    `if(-not(Get-NetFirewallRule -Name '${PROJECT}' -ErrorAction SilentlyContinue)){New-NetFirewallRule -Name '${PROJECT}' -DisplayName 'Intent AI Ops ${PROJECT}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PORT} -Profile Any|Out-Null}`,
    `if((Get-Content -LiteralPath '${quote(ROOT)}\\compose.yaml' -Raw)-match '[a-f0-9]{64}'){throw 'Compose must not contain generated credential values.'}`,
    "Write-Output 'joomla-compose-written'"
  ])
}

function initializeCommand () {
  const status = `& $docker compose -p '${PROJECT}' exec -T joomla /bin/sh -c 'if [ -f /var/www/html/configuration.php ]; then echo CONFIGURED; else echo UNCONFIGURED; fi' 2>$null`
  const install = `WEBMINAI_DB_PASS_FILE=/run/secrets/db_password WEBMINAI_ADMIN_PASSWORD_FILE=/run/secrets/admin_password php -d auto_prepend_file=/run/webminai/installer-argv.php /var/www/html/installation/joomla.php install --no-interaction --site-name=${MARKER} --admin-user="Intent AI Ops Administrator" --admin-username=webminai_admin --admin-email=intentaiops@example.invalid --db-type=mysqli --db-host=db --db-user=webminai_joomla_18103 --db-name=webminai_joomla_18103 --db-prefix=wmai_ --db-encryption=0`
  return ps([
    "$ErrorActionPreference='Stop'",
    windowsDockerPowerShellAdapter(),
    `Set-Location -LiteralPath '${quote(ROOT)}'`,
    `$configured=(${status}|Out-String).Trim()`,
    `if($configured -ne 'CONFIGURED'){$installed=$false;for($attempt=0;$attempt -lt 60;$attempt++){& $docker compose -p '${PROJECT}' exec -T joomla /bin/sh -c '${quote(install)}' *> $null;$configured=(${status}|Out-String).Trim();if($configured -eq 'CONFIGURED'){$installed=$true;break};Start-Sleep -Seconds 2};if(-not $installed){throw 'Joomla initialization failed.'}}`,
    markerWait(),
    "Write-Output 'joomla-initialized'"
  ])
}

function verifyCommand (restart = true) {
  return ps([
    "$ErrorActionPreference='Stop'",
    windowsDockerPowerShellAdapter(),
    `Set-Location -LiteralPath '${quote(ROOT)}'`,
    ...(restart ? [`& $docker compose -p '${PROJECT}' restart db joomla nginx *> $null`] : []),
    `$configured=(& $docker compose -p '${PROJECT}' exec -T joomla /bin/sh -c 'if [ -f /var/www/html/configuration.php ]; then echo CONFIGURED; else echo UNCONFIGURED; fi' 2>$null|Out-String).Trim()`,
    "if($configured -ne 'CONFIGURED'){throw 'Joomla configuration verification failed.'}",
    markerWait(),
    "Write-Output 'verification-passed'"
  ])
}

function markerWait () {
  return `$verified=$false;for($attempt=0;$attempt -lt 90;$attempt++){try{$body=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${PORT}/' -TimeoutSec 5).Content;if($body -like '*${MARKER}*'){$verified=$true;break}}catch{};Start-Sleep -Seconds 2};if(-not $verified){throw '${MARKER} was not returned.'}`
}

function installerBootstrapLines () {
  return ['<?php', "$files = ['db-pass' => getenv('WEBMINAI_DB_PASS_FILE'), 'admin-password' => getenv('WEBMINAI_ADMIN_PASSWORD_FILE')];", 'foreach ($files as $option => $path) {', "    if (!$path || !is_file($path)) { fwrite(STDERR, 'missing protected credential file' . PHP_EOL); exit(1); }", '    $value = trim((string) file_get_contents($path));', "    if ($value === '') { fwrite(STDERR, 'empty protected credential file' . PHP_EOL); exit(1); }", "    $_SERVER['argv'][] = '--' . $option . '=' . $value;", '}', "$_SERVER['argc'] = count($_SERVER['argv']);", "$GLOBALS['argv'] = $_SERVER['argv'];", "$GLOBALS['argc'] = $_SERVER['argc'];"]
}

function ps (statements) { return statements.join(';') }
function quote (value) { return String(value).replaceAll("'", "''") }
function command (id, phase, text, purpose, dependsOn, timeoutMs = 300000, executionMode, risk = 'change') { return { id, phase, command: text, purpose, dependsOn, timeoutMs, executionMode, risk } }
