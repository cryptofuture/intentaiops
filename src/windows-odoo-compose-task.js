import { buildWindowsComposeApplicationTask, windowsDockerPowerShellAdapter } from './windows-compose-foundation.js'

const ODOO = 'odoo@sha256:4872f23288454b724fd2d26c176a418276c2b3552e9aa752f9396b59d864b3a0'
const POSTGRES = 'postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94'
const NGINX = 'nginx@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46'
const PORT = 18112
const MARKER = 'WEBMINAI_ODOO_OK'
const PROJECT = 'webminai-odoo-18112'
const ROOT = 'C:\\ProgramData\\WebminAI\\Services\\odoo'
const CREDENTIALS = 'C:\\ProgramData\\WebminAI\\credentials\\odoo'

export function buildWindowsOdooComposeTask (taskId, windowsExecution, docker) {
  return buildWindowsComposeApplicationTask({
    taskId,
    windowsExecution,
    docker,
    application: 'odoo',
    port: PORT,
    images: [ODOO, POSTGRES, NGINX],
    credentials: ['database_password', 'admin_password'],
    summary: 'Deploy a verified Windows Docker Odoo Community service',
    changeOverview: `Reuse the promoted ismet Odoo Community topology on Windows Docker port ${PORT}.`,
    modifiedFiles: [`${ROOT}\\nginx.conf`],
    assumptions: [`Docker reports Linux-container mode (${windowsExecution.docker.serverVersion ?? 'version unavailable'}).`, 'PostgreSQL and Odoo administrator credentials are generated only on-host.'],
    warnings: ['Docker Desktop must remain running for the service to remain available.'],
    commands: [
      item('write-compose', 'configure', writeCommand(), 'Write the ismet digest-pinned Odoo, PostgreSQL, and nginx topology', ['generate-credentials']),
      item('start-compose', 'services', startCommand(), 'Initialize the Odoo database and start persistent services', ['write-compose']),
      item('initialize-odoo', 'initialize', initializeCommand(), 'Verify the initialized Odoo PostgreSQL schema', ['start-compose']),
      item('verify-restart', 'verify', verifyCommand(), 'Verify Odoo version, web client, database, marker, and restart recovery', ['initialize-odoo'], 300000, undefined, 'read')
    ],
    verifyApplied: verifyCommand(false)
  })
}

function writeCommand () {
  const compose = ['services:', '  db:', `    image: ${POSTGRES}`, '    restart: unless-stopped', '    environment:', '      POSTGRES_DB: webminai_odoo_18112', '      POSTGRES_USER: webminai_odoo', '      POSTGRES_PASSWORD_FILE: /run/secrets/database_password', '    secrets: [database_password]', '    volumes: [postgres_data:/var/lib/postgresql/data]', '    healthcheck:', '      test: ["CMD-SHELL", "pg_isready -U webminai_odoo -d webminai_odoo_18112"]', '      interval: 5s', '      timeout: 5s', '      retries: 120', '      start_period: 20s', '  init-config:', `    image: ${ODOO}`, '    user: "0"', '    entrypoint: ["/bin/bash", "-ec"]', '    command:', '      - |', '        umask 077', '        admin=$$(cat /run/secrets/admin_password)', '        password=$$(cat /run/secrets/database_password)', '        printf "%s\\n" "[options]" "admin_passwd = $$admin" "db_host = db" "db_port = 5432" "db_user = webminai_odoo" "db_password = $$password" "db_name = webminai_odoo_18112" "dbfilter = ^webminai_odoo_18112$$" "list_db = False" "proxy_mode = True" "http_interface = 0.0.0.0" "http_port = 8069" "data_dir = /var/lib/odoo" > /etc/odoo/odoo.conf', '        chown odoo:odoo /etc/odoo/odoo.conf', '        chmod 0600 /etc/odoo/odoo.conf', '    secrets: [admin_password, database_password]', '    volumes: [odoo_config:/etc/odoo]', '  app:', `    image: ${ODOO}`, '    restart: unless-stopped', '    volumes: [odoo_config:/etc/odoo, odoo_data:/var/lib/odoo, odoo_addons:/mnt/extra-addons]', '    depends_on:', '      db: { condition: service_healthy }', '      init-config: { condition: service_completed_successfully }', '  nginx:', `    image: ${NGINX}`, '    restart: unless-stopped', '    depends_on:', '      app: { condition: service_started }', `    ports: ["${PORT}:80"]`, '    volumes: [./nginx.conf:/etc/nginx/conf.d/default.conf:ro]', 'secrets:', '  database_password:', `    file: "${CREDENTIALS.replaceAll('\\', '/')}/database_password"`, '  admin_password:', `    file: "${CREDENTIALS.replaceAll('\\', '/')}/admin_password"`, 'volumes:', '  postgres_data:', '  odoo_config:', '  odoo_data:', '  odoo_addons:'].join('\n')
  const nginx = `server { listen 80; server_name _; location = / { default_type text/plain; return 200 "${MARKER}\\n"; } location /web/ { proxy_pass http://app:8069; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; } }\n`
  return ps(["$ErrorActionPreference='Stop'", `New-Item -Path '${q(ROOT)}' -ItemType Directory -Force|Out-Null`, write(`${ROOT}\\compose.yaml`, compose), write(`${ROOT}\\nginx.conf`, nginx), `if(-not(Get-NetFirewallRule -Name '${PROJECT}' -ErrorAction SilentlyContinue)){New-NetFirewallRule -Name '${PROJECT}' -DisplayName 'Intent AI Ops ${PROJECT}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PORT} -Profile Any|Out-Null}`, "Write-Output 'odoo-compose-written'"])
}

function startCommand () { return dockerPs(`& $docker compose -p '${PROJECT}' pull *> $null;& $docker compose -p '${PROJECT}' up -d db *> $null;${health('db')};& $docker compose -p '${PROJECT}' run --rm app odoo -d webminai_odoo_18112 -i base --without-demo=all --stop-after-init *> $null;& $docker compose -p '${PROJECT}' up -d *> $null;${web()};${marker()};Write-Output 'compose-started'`) }
function initializeCommand () { return dockerPs(`${health('db')};${web()};$tables=(& $docker compose -p '${PROJECT}' exec -T db psql -U webminai_odoo -d webminai_odoo_18112 -Atqc 'SELECT count(*) FROM information_schema.tables' 2>$null|Out-String).Trim();if([int]$tables-lt 1){throw 'Odoo database schema was not initialized.'};Write-Output 'odoo-initialized'`) }
function verifyCommand (restart = true) { return dockerPs(`${health('db')};${web()};$version=(& $docker compose -p '${PROJECT}' exec -T app odoo --version 2>$null|Out-String);if($version-notmatch'19\\.0'){throw 'Odoo version verification failed.'};${marker()};${restart ? `& $docker compose -p '${PROJECT}' restart app *> $null;${web()};` : ''}Write-Output 'verification-passed'`) }
function health (service) { return `$ok=$false;for($i=0;$i-lt 180;$i++){$state=(& $docker inspect '${PROJECT}-${service}-1' --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>$null|Out-String).Trim();if($state-eq'healthy'){$ok=$true;break};Start-Sleep 2};if(-not $ok){throw '${service} did not become healthy.'}` }
function web () { return `$ok=$false;for($i=0;$i-lt 180;$i++){try{$response=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${PORT}/web/login?db=webminai_odoo_18112' -TimeoutSec 5;if($response.Content-like'*Odoo*'){$ok=$true;break}}catch{};Start-Sleep 2};if(-not $ok){throw 'Odoo web client did not become ready.'}` }
function marker () { return `$body=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${PORT}/' -TimeoutSec 10).Content;if($body.Trim()-ne'${MARKER}'){throw 'Odoo marker verification failed.'}` }
function dockerPs (body) { return ps(["$ErrorActionPreference='Stop'", windowsDockerPowerShellAdapter(), `Set-Location -LiteralPath '${q(ROOT)}'`, body]) }
function item (id, phase, command, purpose, dependsOn, timeoutMs = 300000, executionMode, risk = 'change') { return { id, phase, command, purpose, dependsOn, timeoutMs, executionMode, risk } }
function write (path, value) { return `[IO.File]::WriteAllText('${q(path)}',@'\n${value}\n'@,[Text.UTF8Encoding]::new($false))` }
function ps (values) { return values.join(';') }
function q (value) { return String(value).replaceAll("'", "''") }
