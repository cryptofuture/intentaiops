import { magentoComposeAssets, magentoComposeRelease } from './magento-task.js'
import { buildWindowsComposeApplicationTask, windowsDockerPowerShellAdapter } from './windows-compose-foundation.js'

const RELEASE = magentoComposeRelease()
const PORT = 18108
const MARKER = 'WEBMINAI_MAGENTO_OK'
const PROJECT = 'webminai-magento-18108'
const ROOT = 'C:\\ProgramData\\WebminAI\\Services\\magento'
const CREDENTIALS = 'C:\\ProgramData\\WebminAI\\credentials\\magento'

export function buildWindowsMagentoComposeTask (taskId, windowsExecution, docker) {
  return buildWindowsComposeApplicationTask({
    taskId,
    windowsExecution,
    docker,
    application: 'magento',
    port: PORT,
    images: RELEASE.images,
    credentials: ['db_password', 'db_root_password', 'admin_password', 'db_username', 'admin_username'],
    summary: 'Deploy a verified Windows Docker Magento Open Source store',
    changeOverview: `Reuse the promoted ismet Magento ${RELEASE.version} digest matrix on Windows Docker port ${PORT}, with restart-safe jobs for long lifecycle phases.`,
    modifiedFiles: [`${ROOT}\\php-fpm.conf`, `${ROOT}\\nginx.conf`, `${ROOT}\\installer-argv.php`, `${ROOT}\\marker.php`],
    assumptions: [`Docker reports Linux-container mode (${windowsExecution.docker.serverVersion ?? 'version unavailable'}).`, 'All database and administrator material is generated and consumed on-host.'],
    warnings: ['Docker Desktop must remain running for the store to remain available.', 'Magento build and initialization phases use durable Stage 2 jobs.'],
    commands: [
      item('normalize-magento-usernames', 'secrets', normalizeUsernamesCommand(), 'Create bounded Magento database and administrator identifiers from protected host-generated values', ['generate-credentials']),
      item('write-compose', 'configure', writeCommand(), 'Write the promoted digest-pinned Magento, PHP-FPM socket, nginx, MariaDB, OpenSearch, Valkey, cron, and protected installer assets', ['normalize-magento-usernames']),
      item('pull-images', 'acquire', pullCommand(), 'Pull all immutable Magento topology images and verify their local availability', ['write-compose'], 60 * 60 * 1000, 'job'),
      item('prepare-code', 'initialize', prepareCodeCommand(), 'Populate the isolated Magento code volume and prepare its production autoloader', ['pull-images'], 15 * 60 * 1000, 'job'),
      item('start-dependencies', 'services', startCommand(), 'Start MariaDB, OpenSearch, Valkey, Magento PHP-FPM, and nginx with bounded readiness', ['prepare-code'], 15 * 60 * 1000, 'job'),
      item('initialize-magento', 'initialize', initializeCommand(), 'Install Magento using only protected credential-file inputs', ['start-dependencies'], 60 * 60 * 1000, 'job'),
      item('compile-magento', 'initialize', compileCommand(), 'Compile Magento dependency injection and the production autoloader', ['initialize-magento'], 60 * 60 * 1000, 'job'),
      item('finalize-magento', 'initialize', finalizeCommand(), 'Deploy static content, create the CMS marker, reindex, flush caches, and start cron', ['compile-magento'], 45 * 60 * 1000, 'job'),
      item('verify-restart', 'verify', verifyCommand(), 'Verify Magento CLI state, search, database, Valkey, cron, socket, external marker, and restart recovery', ['finalize-magento'], 15 * 60 * 1000, 'job', 'read')
    ],
    verifyApplied: verifyCommand(false)
  })
}

function normalizeUsernamesCommand () {
  return ps([`$db=Join-Path '${q(CREDENTIALS)}' 'db_username'`, `$admin=Join-Path '${q(CREDENTIALS)}' 'admin_username'`, '$dbValue=[IO.File]::ReadAllText($db).Trim()', '$adminValue=[IO.File]::ReadAllText($admin).Trim()', 'if($dbValue-notlike\'magento_*\'){[IO.File]::WriteAllText($db,\'magento_\'+$dbValue.Substring(0,16),[Text.UTF8Encoding]::new($false))}', 'if($adminValue-notlike\'admin_*\'){[IO.File]::WriteAllText($admin,\'admin_\'+$adminValue.Substring(0,16),[Text.UTF8Encoding]::new($false))}', "Write-Output 'magento-usernames-ready'"])
}

function writeCommand () {
  const assets = /** @type {{ compose: string[], fpm: string[], nginx: string[], installer: string[], marker: string[] }} */ (magentoComposeAssets())
  const compose = assets.compose.map(line => line.replace('/root/magento_credentials/', `${slash(CREDENTIALS)}/`)).join('\n')
  return ps([
    "$ErrorActionPreference='Stop'",
    `New-Item -Path '${q(ROOT)}' -ItemType Directory -Force|Out-Null`,
    write(`${ROOT}\\compose.yaml`, compose),
    write(`${ROOT}\\php-fpm.conf`, assets.fpm.join('\n') + '\n'),
    write(`${ROOT}\\nginx.conf`, assets.nginx.join('\n') + '\n'),
    write(`${ROOT}\\installer-argv.php`, assets.installer.join('\n') + '\n'),
    write(`${ROOT}\\marker.php`, assets.marker.join('\n') + '\n'),
    `if(-not(Get-NetFirewallRule -Name '${PROJECT}' -ErrorAction SilentlyContinue)){New-NetFirewallRule -Name '${PROJECT}' -DisplayName 'Intent AI Ops ${PROJECT}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PORT} -Profile Any|Out-Null}`,
    "Write-Output 'magento-compose-written'"
  ])
}

function pullCommand () {
  return dockerPs(`& $docker compose -p '${PROJECT}' --profile tools pull;if($LASTEXITCODE-ne 0){throw 'Magento image pull failed.'};${RELEASE.images.map(image => `& $docker image inspect '${image}' *> $null;if($LASTEXITCODE-ne 0){throw 'A pinned Magento image is unavailable.'}`).join(';')};Write-Output 'magento-images-ready'`, 60 * 60 * 1000)
}

function prepareCodeCommand () {
  const prepare = 'if [ ! -f /target/var/.webminai-source-prepared ]; then test -f /target/bin/magento || cp -a /var/www/html/. /target/; rm -f /target/app/etc/env.php; rm -rf /target/generated/code/* /target/generated/metadata/* /target/var/cache/* /target/var/page_cache/* /target/var/di/*; cd /target; COMPOSER_ALLOW_SUPERUSER=1 composer dump-autoload --no-dev --no-interaction --no-ansi --quiet; install -d -o www-data -g www-data -m 0775 /target/var; touch /target/var/.webminai-source-prepared; chown -R www-data:www-data /target; fi; test -f /target/bin/magento; test -f /target/var/.webminai-source-prepared'
  return dockerPs(`& $docker compose -p '${PROJECT}' --profile tools run --rm --entrypoint /bin/sh bootstrap -c '${q(prepare)}' *> $null;if($LASTEXITCODE-ne 0){throw 'Magento code preparation failed.'};Write-Output 'magento-code-ready'`, 15 * 60 * 1000)
}

function startCommand () {
  const state = `& $docker compose -p '${PROJECT}' exec -T magento /bin/sh -c 'if [ -S /run/php-fpm/webminai.sock ] && [ -f /var/www/html/bin/magento ]; then echo READY; else echo WAITING; fi' 2>$null`
  return dockerPs(`& $docker compose -p '${PROJECT}' up -d db opensearch valkey magento nginx;if($LASTEXITCODE-ne 0){throw 'Magento dependency startup failed.'};$ready=$false;for($i=0;$i-lt 180;$i++){if((${state}|Out-String).Trim()-eq'READY'){$ready=$true;break};Start-Sleep 3};if(-not $ready){throw 'Magento dependencies or PHP-FPM did not become ready.'};Write-Output 'magento-dependencies-ready'`, 15 * 60 * 1000)
}

function initializeCommand () {
  const prepare = 'install -d -o www-data -g www-data -m 0700 /run/webminai; for name in db_username db_password admin_username admin_password; do install -o www-data -g www-data -m 0400 "/run/secrets/$name" "/run/webminai/$name"; done'
  const install = 'WEBMINAI_DB_USERNAME_FILE=/run/webminai/db_username WEBMINAI_DB_PASSWORD_FILE=/run/webminai/db_password WEBMINAI_ADMIN_USERNAME_FILE=/run/webminai/admin_username WEBMINAI_ADMIN_PASSWORD_FILE=/run/webminai/admin_password php -d memory_limit=2G -d auto_prepend_file=/run/webminai/installer-argv.php bin/magento setup:install --no-interaction --no-ansi --quiet --cleanup-database --base-url="$WEBMINAI_MAGENTO_URL" --db-host=db --db-name=webminai_magento_18108 --backend-frontname=webminai_admin --admin-firstname=Intent AI Ops --admin-lastname=Administrator --admin-email=intentaiops@example.invalid --language=en_US --currency=USD --timezone=UTC --use-rewrites=1 --search-engine=opensearch --opensearch-host=opensearch --opensearch-port=9200 --opensearch-enable-auth=0 --session-save=redis --session-save-redis-host=valkey --session-save-redis-db=2 --cache-backend=redis --cache-backend-redis-server=valkey --cache-backend-redis-db=0 --page-cache=redis --page-cache-redis-server=valkey --page-cache-redis-db=1 >/dev/null 2>&1'
  return dockerPs([
    "$route=Get-NetRoute -DestinationPrefix '0.0.0.0/0'|Sort-Object RouteMetric,InterfaceMetric|Select-Object -First 1",
    "$address=(Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4|Where-Object {$_.IPAddress -notlike '169.254.*'}|Select-Object -First 1).IPAddress",
    "if(-not $address){throw 'Primary Windows IPv4 address was not found.'}",
    `$installed=(& $docker compose -p '${PROJECT}' exec -T magento /bin/sh -c 'if [ -f /var/www/html/app/etc/env.php ]; then echo yes; else echo no; fi' 2>$null|Out-String).Trim()`,
    `if($installed-ne'yes'){& $docker compose -p '${PROJECT}' exec -T magento /bin/sh -c '${q(prepare)}' *> $null;if($LASTEXITCODE-ne 0){throw 'Magento protected input staging failed.'};& $docker compose -p '${PROJECT}' exec -T --user www-data -e WEBMINAI_MAGENTO_URL="http://${'$'}{address}:${PORT}/" magento /bin/sh -c '${q(install)}' *> $null;if($LASTEXITCODE-ne 0){throw 'Magento setup:install failed.'};& $docker compose -p '${PROJECT}' exec -T magento rm -f -- /run/webminai/db_username /run/webminai/db_password /run/webminai/admin_username /run/webminai/admin_password *> $null}`,
    "Write-Output 'magento-installed'"
  ].join(';'), 60 * 60 * 1000)
}

function compileCommand () {
  const compile = 'rm -rf generated/code/* generated/metadata/* var/cache/* var/page_cache/* var/di/*; COMPOSER_ALLOW_SUPERUSER=1 composer dump-autoload --no-dev --no-interaction --no-ansi --quiet; php -d memory_limit=2G bin/magento setup:di:compile --no-ansi --quiet; touch var/.webminai-compiled'
  return dockerPs(`$compiled=(& $docker compose -p '${PROJECT}' exec -T magento /bin/sh -c 'if [ -f /var/www/html/var/.webminai-compiled ]; then echo yes; else echo no; fi' 2>$null|Out-String).Trim();if($compiled-ne'yes'){& $docker compose -p '${PROJECT}' exec -T --user www-data magento /bin/sh -c '${q(compile)}' *> $null;if($LASTEXITCODE-ne 0){throw 'Magento dependency-injection compilation failed.'}};Write-Output 'magento-compiled'`, 60 * 60 * 1000)
}

function finalizeCommand () {
  return dockerPs(`& $docker compose -p '${PROJECT}' exec -T --user www-data magento php -d memory_limit=2G bin/magento setup:static-content:deploy -f en_US --no-ansi --quiet *> $null;if($LASTEXITCODE-ne 0){throw 'Magento static content deployment failed.'};& $docker compose -p '${PROJECT}' exec -T --user www-data magento php -d memory_limit=2G /run/webminai/marker.php *> $null;if($LASTEXITCODE-ne 0){throw 'Magento marker creation failed.'};& $docker compose -p '${PROJECT}' exec -T --user www-data magento /bin/sh -c 'php bin/magento indexer:reindex --no-ansi --quiet >/dev/null 2>&1; touch var/.webminai-indexed' *> $null;if($LASTEXITCODE-ne 0){throw 'Magento indexer failed.'};& $docker compose -p '${PROJECT}' exec -T --user www-data magento php bin/magento cache:flush --no-ansi --quiet *> $null;& $docker compose -p '${PROJECT}' up -d cron *> $null;$ready=$false;for($i=0;$i-lt 120;$i++){try{$body=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${PORT}/' -TimeoutSec 10).Content;if($body-like'*${MARKER}*'){$ready=$true;break}}catch{};Start-Sleep 3};if(-not $ready){throw '${MARKER} was not returned.'};Write-Output 'magento-finalized'`, 45 * 60 * 1000)
}

function verifyCommand (restart = true) {
  const state = `& $docker compose -p '${PROJECT}' exec -T magento /bin/sh -c 'test -S /run/php-fpm/webminai.sock && test -f /var/www/html/app/etc/env.php && test -f /var/www/html/var/.webminai-indexed && test -f /var/www/html/var/.webminai-cron-ok' *> $null;if($LASTEXITCODE-ne 0){throw 'Magento managed state verification failed.'}`
  return dockerPs(`${restart ? `& $docker compose -p '${PROJECT}' restart db opensearch valkey magento nginx cron *> $null;if($LASTEXITCODE-ne 0){throw 'Magento restart failed.'};` : ''}${state};& $docker compose -p '${PROJECT}' exec -T opensearch curl --fail --silent http://127.0.0.1:9200/_cluster/health *> $null;if($LASTEXITCODE-ne 0){throw 'OpenSearch health failed.'};& $docker compose -p '${PROJECT}' exec -T valkey valkey-cli ping|Select-String -SimpleMatch PONG|Out-Null;if(-not $?){throw 'Valkey health failed.'};$ready=$false;for($i=0;$i-lt 120;$i++){try{$body=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${PORT}/' -TimeoutSec 10).Content;if($body-like'*${MARKER}*'){$ready=$true;break}}catch{};Start-Sleep 3};if(-not $ready){throw 'Magento HTTP verification failed.'};Write-Output 'verification-passed'`, 15 * 60 * 1000)
}

function dockerPs (body, timeoutMs = 300000) { return ps(["$ErrorActionPreference='Stop'", windowsDockerPowerShellAdapter(timeoutMs), `Set-Location -LiteralPath '${q(ROOT)}'`, body]) }
function item (id, phase, command, purpose, dependsOn, timeoutMs = 300000, executionMode, risk = 'change') { return { id, phase, command, purpose, dependsOn, timeoutMs, executionMode, risk } }
function write (path, value) { return `[IO.File]::WriteAllText('${q(path)}',@'\n${value}\n'@,[Text.UTF8Encoding]::new($false))` }
function slash (value) { return value.replaceAll('\\', '/') }
function ps (values) { return values.join(';') }
function q (value) { return String(value).replaceAll("'", "''") }
