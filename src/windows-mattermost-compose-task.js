import { buildWindowsComposeApplicationTask, windowsDockerPowerShellAdapter } from './windows-compose-foundation.js'

const MATTERMOST = 'mattermost/mattermost-team-edition@sha256:65c8e3fa5122307b833eb08d3ea402b2f829a0fd43a82f6e2ccea0e14225c970'
const POSTGRES = 'postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94'
const NGINX = 'nginx@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46'
const PORT = 18111
const MARKER = 'WEBMINAI_MATTERMOST_OK'
const PROJECT = 'webminai-mattermost-18111'
const ROOT = 'C:\\ProgramData\\WebminAI\\Services\\mattermost'
const CREDENTIALS = 'C:\\ProgramData\\WebminAI\\credentials\\mattermost'

export function buildWindowsMattermostComposeTask (taskId, windowsExecution, docker) {
  return buildWindowsComposeApplicationTask({
    taskId,
    windowsExecution,
    docker,
    application: 'mattermost',
    port: PORT,
    images: [MATTERMOST, POSTGRES, NGINX],
    credentials: ['database_password'],
    summary: 'Deploy a verified Windows Docker Mattermost Team Edition service',
    changeOverview: `Reuse the promoted ismet Mattermost topology on Windows Docker port ${PORT}.`,
    modifiedFiles: [`${ROOT}\\nginx.conf`, `${CREDENTIALS}\\credentials.env`],
    assumptions: [`Docker reports Linux-container mode (${windowsExecution.docker.serverVersion ?? 'version unavailable'}).`, 'PostgreSQL credentials are generated and retained only on-host.'],
    warnings: ['Docker Desktop must remain running for the service to remain available.'],
    commands: [
      item('write-compose', 'configure', writeCommand(), 'Write the ismet digest-pinned Mattermost, PostgreSQL, and nginx topology', ['generate-credentials']),
      item('start-compose', 'services', startCommand(), 'Start Mattermost with PostgreSQL and API readiness', ['write-compose']),
      item('initialize-mattermost', 'initialize', initializeCommand(), 'Verify Mattermost initialized its PostgreSQL schema', ['start-compose']),
      item('verify-restart', 'verify', verifyCommand(), 'Verify Mattermost version, API, database, marker, and restart recovery', ['initialize-mattermost'], 300000, undefined, 'read')
    ],
    verifyApplied: verifyCommand(false)
  })
}

function writeCommand () {
  const compose = ['services:', '  db:', `    image: ${POSTGRES}`, '    restart: unless-stopped', '    env_file: [./credentials.env]', '    environment:', '      POSTGRES_DB: webminai_mattermost_18111', '      POSTGRES_USER: webminai_mattermost', '    volumes: [postgres_data:/var/lib/postgresql/data]', '    healthcheck:', '      test: ["CMD-SHELL", "pg_isready -U webminai_mattermost -d webminai_mattermost_18111"]', '      interval: 5s', '      timeout: 5s', '      retries: 120', '      start_period: 20s', '  app:', `    image: ${MATTERMOST}`, '    restart: unless-stopped', '    env_file: [./credentials.env]', '    environment:', '      MM_SQLSETTINGS_DRIVERNAME: postgres', '      MM_SERVICESETTINGS_LISTENADDRESS: :8065', '      MM_FILESETTINGS_DIRECTORY: /mattermost/data', '      MM_LOGSETTINGS_ENABLEFILE: "false"', '    volumes:', '      - mattermost_config:/mattermost/config', '      - mattermost_data:/mattermost/data', '      - mattermost_logs:/mattermost/logs', '      - mattermost_plugins:/mattermost/plugins', '      - mattermost_client_plugins:/mattermost/client/plugins', '      - mattermost_bleve:/mattermost/bleve-indexes', '    depends_on:', '      db: { condition: service_healthy }', '  nginx:', `    image: ${NGINX}`, '    restart: unless-stopped', '    depends_on:', '      app: { condition: service_started }', `    ports: ["${PORT}:80"]`, '    volumes: [./nginx.conf:/etc/nginx/conf.d/default.conf:ro]', 'volumes:', '  postgres_data:', '  mattermost_config:', '  mattermost_data:', '  mattermost_logs:', '  mattermost_plugins:', '  mattermost_client_plugins:', '  mattermost_bleve:'].join('\n')
  const nginx = `server { listen 80; server_name _; location = / { default_type text/plain; return 200 "${MARKER}\\n"; } location /api/ { proxy_pass http://app:8065; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; } }\n`
  const address = "$route=Get-NetRoute -DestinationPrefix '0.0.0.0/0'|Sort-Object RouteMetric,InterfaceMetric|Select-Object -First 1;$address=(Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4|Where-Object {$_.IPAddress -notlike '169.254.*'}|Select-Object -First 1).IPAddress;if(-not $address){throw 'Primary Windows IPv4 address was not found.'}"
  const environment = `$nl=[Environment]::NewLine;$environment=('POSTGRES_PASSWORD='+$password+$nl+'MM_SQLSETTINGS_DATASOURCE=postgres://webminai_mattermost:'+$password+'@db:5432/webminai_mattermost_18111?sslmode=disable&connect_timeout=10'+$nl+'MM_SERVICESETTINGS_SITEURL=http://'+$address+':${PORT}'+$nl)`
  return ps(["$ErrorActionPreference='Stop'", address, `New-Item -Path '${q(ROOT)}' -ItemType Directory -Force|Out-Null`, `$password=[IO.File]::ReadAllText('${q(CREDENTIALS)}\\database_password').Trim()`, environment, `[IO.File]::WriteAllText('${q(CREDENTIALS)}\\credentials.env',$environment,[Text.UTF8Encoding]::new($false))`, write(`${ROOT}\\compose.yaml`, compose), write(`${ROOT}\\nginx.conf`, nginx), `if(-not(Get-NetFirewallRule -Name '${PROJECT}' -ErrorAction SilentlyContinue)){New-NetFirewallRule -Name '${PROJECT}' -DisplayName 'Intent AI Ops ${PROJECT}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PORT} -Profile Any|Out-Null}`, "Write-Output 'mattermost-compose-written'"])
}

function startCommand () { return dockerPs(`& $docker compose -p '${PROJECT}' pull *> $null;& $docker compose -p '${PROJECT}' up -d *> $null;${health('db')};${api()};${marker()};Write-Output 'compose-started'`) }
function initializeCommand () { return dockerPs(`${health('db')};${api()};$tables=(& $docker compose -p '${PROJECT}' exec -T db psql -U webminai_mattermost -d webminai_mattermost_18111 -Atqc 'SELECT count(*) FROM information_schema.tables' 2>$null|Out-String).Trim();if([int]$tables -lt 1){throw 'Mattermost database schema was not initialized.'};Write-Output 'mattermost-initialized'`) }
function verifyCommand (restart = true) { return dockerPs(`${health('db')};${api()};$version=(& $docker compose -p '${PROJECT}' exec -T app mattermost version 2>$null|Out-String);if($version-notmatch'11\\.7\\.8'){throw 'Mattermost version verification failed.'};${marker()};${restart ? `& $docker compose -p '${PROJECT}' restart app *> $null;${api()};` : ''}Write-Output 'verification-passed'`) }
function health (service) { return `$ok=$false;for($i=0;$i -lt 180;$i++){$state=(& $docker inspect '${PROJECT}-${service}-1' --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>$null|Out-String).Trim();if($state -eq 'healthy'){$ok=$true;break};Start-Sleep 2};if(-not $ok){throw '${service} did not become healthy.'}` }
function api () { return `$ok=$false;for($i=0;$i -lt 180;$i++){try{$response=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${PORT}/api/v4/system/ping' -TimeoutSec 5;if($response.Content-like'*OK*'){$ok=$true;break}}catch{};Start-Sleep 2};if(-not $ok){throw 'Mattermost API did not become ready.'}` }
function marker () { return `$body=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${PORT}/' -TimeoutSec 10).Content;if($body.Trim() -ne '${MARKER}'){throw 'Mattermost marker verification failed.'}` }
function dockerPs (body) { return ps(["$ErrorActionPreference='Stop'", windowsDockerPowerShellAdapter(), `Set-Location -LiteralPath '${q(ROOT)}'`, body]) }
function item (id, phase, command, purpose, dependsOn, timeoutMs = 300000, executionMode, risk = 'change') { return { id, phase, command, purpose, dependsOn, timeoutMs, executionMode, risk } }
function write (path, value) { return `[IO.File]::WriteAllText('${q(path)}',@'\n${value}\n'@,[Text.UTF8Encoding]::new($false))` }
function ps (values) { return values.join(';').replaceAll('env_file: [./credentials.env]', `env_file: ["${CREDENTIALS.replaceAll('\\', '/')}/credentials.env"]`).replaceAll(`${q(ROOT)}\\credentials.env`, `${q(CREDENTIALS)}\\credentials.env`) }
function q (value) { return String(value).replaceAll("'", "''") }
