import { moodleComposeAssets, moodleRelease } from './moodle-task.js'
import {
  buildWindowsComposeFoundation,
  powerShellQuote,
  powershell,
  windowsComposeCommand,
  windowsComposePowerShell,
  windowsPathForCompose,
  windowsTextFileCommand
} from './windows-compose-foundation.js'

const RELEASE = moodleRelease()
const IMAGE = RELEASE.image
const PHP_IMAGE = RELEASE.phpImage
const NGINX_IMAGE = 'nginx:1.30.4-alpine'
const DATABASE_IMAGE = 'mariadb:11.8.8'
const PORT = 18106
const MARKER = 'WEBMINAI_MOODLE_OK'
const PROJECT = 'webminai-moodle-18106'
const ROOT = 'C:\\ProgramData\\WebminAI\\Services\\moodle'
const CREDENTIALS = 'C:\\ProgramData\\WebminAI\\credentials\\moodle'

export function buildWindowsMoodleComposeTask (taskId, windowsExecution, docker) {
  const foundation = buildWindowsComposeFoundation({
    taskId,
    windowsExecution,
    docker,
    application: 'moodle',
    port: PORT,
    images: [PHP_IMAGE, IMAGE, NGINX_IMAGE, DATABASE_IMAGE]
  })
  return {
    plan: {
      summary: 'Deploy a verified Windows Docker Moodle site',
      changeOverview: `Reuse the promoted ismet Moodle ${RELEASE.version} matrix on Windows Docker port ${PORT}, with long build and initialization phases handled as restart-safe jobs.`,
      modifiedFiles: [foundation.paths.state, ROOT, `${ROOT}\\compose.yaml`, `${ROOT}\\Dockerfile`, `${ROOT}\\docker-entrypoint.sh`, `${ROOT}\\php-fpm.conf`, `${ROOT}\\php.ini`, `${ROOT}\\nginx.conf`, `${ROOT}\\installer-argv.php`, CREDENTIALS],
      assumptions: [
        `Docker reports Linux-container mode (${windowsExecution.docker.serverVersion ?? 'version unavailable'}) and Compose is available to LocalSystem.`,
        `The promoted Moodle ${RELEASE.version}, PHP 8.4, nginx, and MariaDB image matrix is used without application-plan rewriting.`,
        'Database and administrator credentials are generated on-host, protected by SID ACLs, and mounted as files.'
      ],
      warnings: ['Docker Desktop must remain running for the site to remain available.', `The task creates a scoped inbound firewall rule for TCP ${PORT}.`],
      requiresConfirmation: true,
      commands: foundation.commands.concat([
        windowsComposeCommand('write-compose', 'configure', writeCommand(), 'Write the promoted Moodle image build, PHP-FPM socket, nginx, MariaDB, cron, and protected installer assets', ['generate-credentials']),
        windowsComposeCommand('pull-images', 'acquire', buildCommand(), 'Build the digest-verified Moodle image and pull the pinned nginx and MariaDB images', ['write-compose'], 45 * 60 * 1000, 'job'),
        windowsComposeCommand('start-compose', 'services', startCommand(), 'Start MariaDB, Moodle PHP-FPM, and nginx and wait for the CLI installer and Unix socket', ['pull-images']),
        windowsComposeCommand('initialize-moodle', 'initialize', initializeCommand(), 'Install Moodle through its official CLI using protected credential files, then start recurring cron', ['start-compose'], 30 * 60 * 1000, 'job'),
        windowsComposeCommand('verify-restart', 'verify', verifyCommand(), 'Verify Moodle configuration, off-web data, cron, socket, login, external marker, and restart recovery', ['initialize-moodle'], 300000, undefined, 'read')
      ]),
      revertCommands: foundation.revertCommands
    },
    verifyApplied: verifyCommand(false),
    verifyReverted: foundation.verifyReverted,
    stateProbe: foundation.stateProbe
  }
}

function writeCommand () {
  const assets = /** @type {{ compose: string[], dockerfile: string[], entrypoint: string[], fpm: string[], phpIni: string[], nginx: string[], installer: string[] }} */ (moodleComposeAssets())
  const compose = assets.compose.map(line => line.replace('/root/moodle_credentials/', `${windowsPathForCompose(CREDENTIALS)}/`)).join('\n')
  return powershell([
    "$ErrorActionPreference='Stop'",
    `New-Item -Path '${q(ROOT)}' -ItemType Directory -Force|Out-Null`,
    windowsTextFileCommand(`${ROOT}\\compose.yaml`, compose),
    windowsTextFileCommand(`${ROOT}\\Dockerfile`, assets.dockerfile.join('\n') + '\n'),
    windowsTextFileCommand(`${ROOT}\\docker-entrypoint.sh`, assets.entrypoint.join('\n') + '\n'),
    windowsTextFileCommand(`${ROOT}\\php-fpm.conf`, assets.fpm.join('\n') + '\n'),
    windowsTextFileCommand(`${ROOT}\\php.ini`, assets.phpIni.join('\n') + '\n'),
    windowsTextFileCommand(`${ROOT}\\nginx.conf`, assets.nginx.join('\n') + '\n'),
    windowsTextFileCommand(`${ROOT}\\installer-argv.php`, assets.installer.join('\n') + '\n'),
    `if(-not(Get-NetFirewallRule -Name '${PROJECT}' -ErrorAction SilentlyContinue)){New-NetFirewallRule -Name '${PROJECT}' -DisplayName 'Intent AI Ops ${PROJECT}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PORT} -Profile Any|Out-Null}`,
    `if((Get-Content -LiteralPath '${q(`${ROOT}\\compose.yaml`)}' -Raw)-match '[A-Za-z0-9_-]{40,}'){throw 'Compose contains an unexpected secret-shaped value.'}`,
    "Write-Output 'moodle-compose-written'"
  ])
}

function buildCommand () {
  return dockerPs(`& $docker compose -p '${PROJECT}' build --pull moodle;if($LASTEXITCODE -ne 0){throw 'Moodle image build failed.'};& $docker compose -p '${PROJECT}' pull db nginx;if($LASTEXITCODE -ne 0){throw 'Moodle dependency image pull failed.'};Write-Output 'moodle-images-ready'`, 45 * 60 * 1000)
}

function startCommand () {
  const state = `& $docker compose -p '${PROJECT}' exec -T moodle /bin/sh -c 'if [ -S /run/php-fpm/webminai.sock ] && [ -f /var/www/html/admin/cli/install.php ]; then echo READY; else echo WAITING; fi' 2>$null`
  return dockerPs(`& $docker compose -p '${PROJECT}' up -d db moodle nginx;if($LASTEXITCODE -ne 0){throw 'Moodle Compose startup failed.'};$ready=$false;for($i=0;$i -lt 120;$i++){if((${state}|Out-String).Trim()-eq 'READY'){$ready=$true;break};Start-Sleep 2};if(-not $ready){throw 'Moodle did not expose its installer and PHP-FPM socket.'};Write-Output 'moodle-compose-started'`)
}

function initializeCommand () {
  const prepare = 'install -d -o www-data -g www-data -m 0700 /run/webminai; install -o www-data -g www-data -m 0400 /run/secrets/db_password /run/webminai/db_password; install -o www-data -g www-data -m 0400 /run/secrets/admin_password /run/webminai/admin_password'
  const install = `WEBMINAI_DB_PASS_FILE=/run/webminai/db_password WEBMINAI_ADMIN_PASSWORD_FILE=/run/webminai/admin_password php -d memory_limit=512M -d max_input_vars=5000 -d auto_prepend_file=/run/webminai/installer-argv.php /var/www/html/admin/cli/install.php --non-interactive --agree-license --lang=en --wwwroot="$WEBMINAI_MOODLE_URL" --dataroot=/var/moodledata --dbtype=mariadb --dbhost=db --dbname=webminai_moodle_18106 --dbuser=webminai_moodle_18106 --prefix=wmai_ --fullname=${MARKER} --shortname=${MARKER} --adminuser=webminai_admin --adminemail=intentaiops@example.invalid >/dev/null 2>&1`
  const finalize = `rm -f /run/webminai/db_password /run/webminai/admin_password; printf '%s\\n' installation-completed > /var/www/html/.webminai-installed; printf '%s\\n' ${MARKER} > /var/www/html/public/webminai-health.txt; chown www-data:www-data /var/www/html/.webminai-installed /var/www/html/public/webminai-health.txt; chmod 0644 /var/www/html/public/webminai-health.txt`
  return dockerPs([
    "$route=Get-NetRoute -DestinationPrefix '0.0.0.0/0'|Sort-Object RouteMetric,InterfaceMetric|Select-Object -First 1",
    "$address=(Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4|Where-Object {$_.IPAddress -notlike '169.254.*'}|Select-Object -First 1).IPAddress",
    "if(-not $address){throw 'Primary Windows IPv4 address was not found.'}",
    `$installed=(& $docker compose -p '${PROJECT}' exec -T moodle /bin/sh -c 'if [ -f /var/www/html/.webminai-installed ]; then echo yes; else echo no; fi' 2>$null|Out-String).Trim()`,
    `if($installed-ne'yes'){& $docker compose -p '${PROJECT}' exec -T moodle /bin/sh -c '${q(prepare)}' *> $null;if($LASTEXITCODE-ne 0){throw 'Protected Moodle credential staging failed.'};& $docker compose -p '${PROJECT}' exec -T --user www-data -e WEBMINAI_MOODLE_URL="http://${'$'}{address}:${PORT}" moodle /bin/sh -c '${q(install)}' *> $null;if($LASTEXITCODE-ne 0){throw 'Moodle CLI installation failed.'};& $docker compose -p '${PROJECT}' exec -T moodle /bin/sh -c '${q(finalize)}' *> $null;if($LASTEXITCODE-ne 0){throw 'Moodle finalization failed.'}}`,
    `& $docker compose -p '${PROJECT}' up -d cron *> $null;if($LASTEXITCODE-ne 0){throw 'Moodle cron startup failed.'}`,
    `$ready=$false;for($i=0;$i-lt 120;$i++){try{$body=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${PORT}/webminai-health.txt' -TimeoutSec 5).Content;if($body-like'*${MARKER}*'){$ready=$true;break}}catch{};Start-Sleep 2};if(-not $ready){throw '${MARKER} was not returned.'}`,
    "Write-Output 'moodle-initialized'"
  ].join(';'), 30 * 60 * 1000)
}

function verifyCommand (restart = true) {
  const checks = `& $docker compose -p '${PROJECT}' exec -T moodle /bin/sh -c 'test -S /run/php-fpm/webminai.sock && test -f /var/www/html/.webminai-installed && test -f /var/www/html/config.php && test -f /var/moodledata/.webminai-cron-ok' *> $null;if($LASTEXITCODE-ne 0){throw 'Moodle managed state verification failed.'}`
  return dockerPs(`${restart ? `& $docker compose -p '${PROJECT}' restart db moodle nginx cron *> $null;if($LASTEXITCODE-ne 0){throw 'Moodle restart failed.'};` : ''}${checks};$ready=$false;for($i=0;$i-lt 120;$i++){try{$marker=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${PORT}/webminai-health.txt' -TimeoutSec 5).Content;if($marker-like'*${MARKER}*'){$ready=$true;break}}catch{};Start-Sleep 2};if(-not $ready){throw 'Moodle HTTP verification failed.'};Write-Output 'verification-passed'`)
}

function dockerPs (body, timeoutMs = 300000) { return windowsComposePowerShell(ROOT, body, timeoutMs) }
const q = powerShellQuote
