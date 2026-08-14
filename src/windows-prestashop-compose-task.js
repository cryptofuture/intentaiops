import { prestaShopComposeAssets } from './prestashop-task.js'
import { buildWindowsComposeApplicationTask, windowsComposePullCommand, windowsDockerPowerShellAdapter } from './windows-compose-foundation.js'

const IMAGE = 'prestashop/prestashop:9.1.4-5.0-classic-8.4-fpm'
const PORT = 18105
const MARKER = 'WEBMINAI_PRESTASHOP_OK'
const PROJECT = 'webminai-prestashop-18105'
const ROOT = 'C:\\ProgramData\\WebminAI\\Services\\prestashop'
const CREDENTIALS = 'C:\\ProgramData\\WebminAI\\credentials\\prestashop'

export function buildWindowsPrestaShopComposeTask (taskId, windowsExecution, docker) {
  return buildWindowsComposeApplicationTask({
    taskId,
    windowsExecution,
    docker,
    application: 'prestashop',
    port: PORT,
    images: [IMAGE, 'nginx:1.30.4-alpine', 'mariadb:11.8.8'],
    summary: 'Deploy a verified Windows Docker PrestaShop store',
    changeOverview: `Reuse the promoted ismet matrix to deploy PrestaShop 9.1.4 on Windows Docker port ${PORT}.`,
    modifiedFiles: [`${ROOT}\\php-fpm.conf`, `${ROOT}\\nginx.conf`, `${ROOT}\\installer-argv.php`],
    assumptions: [`Docker reports Linux-container mode (${windowsExecution.docker.serverVersion ?? 'version unavailable'}) and Compose is available to LocalSystem.`, 'Database and administrator credentials remain host-generated and file-backed.'],
    warnings: ['Docker Desktop must remain running for the store to remain available.', `The task creates a scoped inbound firewall rule for TCP ${PORT}.`],
    commands: [
      item('write-compose', 'configure', writeCommand(), 'Write the ismet-promoted PrestaShop FPM topology and protected installer bootstrap', ['generate-credentials']),
      item('pull-images', 'acquire', windowsComposePullCommand(ROOT, PROJECT), 'Pull the pinned PrestaShop, nginx, and MariaDB images', ['write-compose']),
      item('start-compose', 'services', startCommand(), 'Start MariaDB, PrestaShop PHP-FPM, and nginx and require positive socket and installer readiness', ['pull-images']),
      item('initialize-prestashop', 'initialize', installStep('database'), 'Initialize the PrestaShop database from protected credential files', ['start-compose']),
      item('reconcile-prestashop', 'initialize', installStep('modules', ['ps_linklist']), 'Install the reviewed storefront module batch', ['initialize-prestashop']),
      item('initialize-prestashop-theme', 'initialize', installStep('theme,postInstall'), 'Install the classic theme and its post-install phase', ['reconcile-prestashop']),
      item('finalize-prestashop', 'initialize', finalizeCommand(), 'Finalize the deterministic administrator path and remove installer artifacts', ['initialize-prestashop-theme']),
      item('verify-restart', 'verify', verifyCommand(), 'Verify PrestaShop configuration, administrator assets, socket, marker, and restart recovery', ['finalize-prestashop'], 300000, undefined, 'read')
    ],
    verifyApplied: verifyCommand(false)
  })
}

function startCommand () {
  const status = `& $docker compose -p '${PROJECT}' exec -T prestashop /bin/sh -c 'if [ -S /run/php-fpm/webminai.sock ] && { [ -f /var/www/html/.webminai-installed ] || [ -f /var/www/html/install/index_cli.php ]; }; then echo READY; else echo WAITING; fi' 2>$null`
  return dockerPs(`& $docker compose -p '${PROJECT}' up -d db prestashop nginx *> $null;$ready=$false;for($i=0;$i -lt 90;$i++){$state=(${status}|Out-String).Trim();if($state -eq 'READY'){$ready=$true;break};Start-Sleep 2};if(-not $ready){throw 'PrestaShop container did not expose its installer and PHP-FPM socket.'};Write-Output 'compose-started'`)
}

function writeCommand () {
  const assets = prestaShopComposeAssets()
  const compose = [
    'services:', '  db:', '    image: mariadb:11.8.8', '    restart: unless-stopped', '    environment:',
    '      MARIADB_DATABASE: webminai_prestashop_18105', '      MARIADB_USER: webminai_prestashop_18105',
    '      MARIADB_PASSWORD_FILE: /run/secrets/db_password', '      MARIADB_ROOT_PASSWORD_FILE: /run/secrets/db_root_password',
    '    secrets: [db_password, db_root_password]', '    volumes: [db_data:/var/lib/mysql]', '    healthcheck:',
    '      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]', '      interval: 5s', '      timeout: 5s', '      retries: 60',
    '  prestashop:', `    image: ${IMAGE}`, '    restart: unless-stopped', '    environment:', '      PS_INSTALL_AUTO: "0"',
    '    depends_on:', '      db: { condition: service_healthy }', '    secrets: [db_password, admin_password]', '    volumes:',
    '      - prestashop_data:/var/www/html', '      - php_run:/run/php-fpm', '      - ./php-fpm.conf:/usr/local/etc/php-fpm.d/zz-webminai-socket.conf:ro',
    '      - ./installer-argv.php:/run/webminai/installer-argv.php:ro',
    '  nginx:', '    image: nginx:1.30.4-alpine', '    restart: unless-stopped', '    depends_on: [prestashop]', `    ports: ["${PORT}:80"]`,
    '    volumes:', '      - prestashop_data:/var/www/html:ro', '      - php_run:/run/php-fpm', '      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro',
    'secrets:', `  db_password: { file: "${slash(CREDENTIALS)}/db_password" }`, `  db_root_password: { file: "${slash(CREDENTIALS)}/db_root_password" }`,
    `  admin_password: { file: "${slash(CREDENTIALS)}/admin_password" }`, 'volumes:', '  db_data:', '  prestashop_data:', '  php_run:'
  ].join('\n')
  return ps(["$ErrorActionPreference='Stop'", `New-Item -Path '${q(ROOT)}' -ItemType Directory -Force|Out-Null`, write(`${ROOT}\\compose.yaml`, compose), write(`${ROOT}\\php-fpm.conf`, assets.phpFpm.join('\n') + '\n'), write(`${ROOT}\\nginx.conf`, assets.nginx.join('\n') + '\n'), write(`${ROOT}\\installer-argv.php`, assets.installer.join('\n') + '\n'), `if(-not(Get-NetFirewallRule -Name '${PROJECT}' -ErrorAction SilentlyContinue)){New-NetFirewallRule -Name '${PROJECT}' -DisplayName 'Intent AI Ops ${PROJECT}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PORT} -Profile Any|Out-Null}`, "Write-Output 'prestashop-compose-written'"])
}

function installStep (step, modules = []) {
  const selected = modules.length ? ` --modules=${modules.join(',')}` : ''
  const install = `WEBMINAI_DB_PASS_FILE=/run/secrets/db_password WEBMINAI_ADMIN_PASSWORD_FILE=/run/secrets/admin_password php -d memory_limit=-1 -d auto_prepend_file=/run/webminai/installer-argv.php /var/www/html/install/index_cli.php --step=${step}${selected} --domain="$WEBMINAI_DOMAIN" --db_server=db --db_user=webminai_prestashop_18105 --db_name=webminai_prestashop_18105 --db_clear=1 --prefix=wmai_ --name=${MARKER} --email=intentaiops@example.invalid --firstname=Intent AI Ops --lastname=Administrator --country=us --timezone=Etc/UTC --fixtures=0 --rewrite=1 >/dev/null 2>&1`
  const address = "$route=Get-NetRoute -DestinationPrefix '0.0.0.0/0'|Sort-Object RouteMetric,InterfaceMetric|Select-Object -First 1;$address=(Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4|Where-Object {$_.IPAddress -notlike '169.254.*'}|Select-Object -First 1).IPAddress;if(-not $address){throw 'Primary Windows IPv4 address was not found.'}"
  return dockerPs(`${address};& $docker compose -p '${PROJECT}' exec -T -e WEBMINAI_DOMAIN="${'$'}{address}:${PORT}" prestashop /bin/sh -c '${q(install)}' *> $null;Write-Output 'prestashop-${step}-ready'`)
}

function finalizeCommand () {
  const script = "if [ -d /var/www/html/admin ] && [ ! -e /var/www/html/admin-webminai ]; then mv /var/www/html/admin /var/www/html/admin-webminai; fi; test -d /var/www/html/admin-webminai; rm -rf /var/www/html/admin-webminai/bundles/fosjsrouting /var/www/html/admin-webminai/bundles/apiplatform; install -d -o www-data -g www-data -m 0755 /var/www/html/admin-webminai/bundles; ln -s /var/www/html/vendor/friendsofsymfony/jsrouting-bundle/Resources/public /var/www/html/admin-webminai/bundles/fosjsrouting; ln -s /var/www/html/vendor/api-platform/core/src/Symfony/Bundle/Resources/public /var/www/html/admin-webminai/bundles/apiplatform; chown -R www-data:www-data /var/www/html/var/cache; rm -rf /var/www/html/install; printf '%s\\n' installation-completed > /var/www/html/.webminai-installed; chown www-data:www-data /var/www/html/.webminai-installed"
  return dockerPs(`& $docker compose -p '${PROJECT}' exec -T prestashop /bin/sh -c '${q(script)}' *> $null;${markerWait()};Write-Output 'prestashop-finalized'`)
}

function verifyCommand (restart = true) {
  const status = `& $docker compose -p '${PROJECT}' exec -T prestashop /bin/sh -c 'if [ -f /var/www/html/.webminai-installed ] && [ -f /var/www/html/app/config/parameters.php ] && [ -f /var/www/html/admin-webminai/index.php ] && [ ! -d /var/www/html/install ] && [ -S /run/php-fpm/webminai.sock ]; then echo VERIFIED; else echo INCOMPLETE; fi' 2>$null`
  return ps(["$ErrorActionPreference='Stop'", windowsDockerPowerShellAdapter(), `Set-Location -LiteralPath '${q(ROOT)}'`, ...(restart ? [`& $docker compose -p '${PROJECT}' restart db prestashop nginx *> $null`] : []), `$state=(${status}|Out-String).Trim();if($state -ne 'VERIFIED'){throw 'PrestaShop state verification failed.'}`, markerWait(), "Write-Output 'verification-passed'"])
}

function dockerPs (body) { return ps(["$ErrorActionPreference='Stop'", windowsDockerPowerShellAdapter(), `Set-Location -LiteralPath '${q(ROOT)}'`, body]) }
function markerWait () { return `$ok=$false;for($i=0;$i -lt 90;$i++){try{$body=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${PORT}/' -TimeoutSec 5).Content;if($body -like '*${MARKER}*'){$ok=$true;break}}catch{};Start-Sleep 2};if(-not $ok){throw '${MARKER} was not returned.'}` }
function item (id, phase, command, purpose, dependsOn, timeoutMs = 300000, executionMode, risk = 'change') { return { id, phase, command, purpose, risk, timeoutMs, executionMode, dependsOn } }
function write (path, value) { return `[IO.File]::WriteAllText('${q(path)}',@'\n${value}\n'@,[Text.UTF8Encoding]::new($false))` }
function slash (value) { return value.replaceAll('\\', '/') }
function ps (values) { return values.join(';') }
function q (value) { return String(value).replaceAll("'", "''") }
