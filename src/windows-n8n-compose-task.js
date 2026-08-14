import { buildWindowsComposeApplicationTask, windowsDockerPowerShellAdapter } from './windows-compose-foundation.js'

const IMAGE = 'docker.n8n.io/n8nio/n8n:2.33.7'
const PORT = 18109
const MARKER = 'WEBMINAI_N8N_OK'
const PROJECT = 'webminai-n8n-18109'
const ROOT = 'C:\\ProgramData\\WebminAI\\Services\\n8n'
const CREDENTIALS = 'C:\\ProgramData\\WebminAI\\credentials\\n8n'

export function buildWindowsN8nComposeTask (taskId, windowsExecution, docker) {
  return buildWindowsComposeApplicationTask({
    taskId,
    windowsExecution,
    docker,
    application: 'n8n',
    port: PORT,
    images: [IMAGE, 'nginx:1.30.4-alpine'],
    credentials: ['encryption_key'],
    summary: 'Deploy a verified Windows Docker n8n service',
    changeOverview: `Reuse the promoted ismet n8n ${IMAGE.split(':').at(-1)} topology on Windows Docker port ${PORT}.`,
    modifiedFiles: [`${ROOT}\\nginx.conf`],
    assumptions: [`Docker reports Linux-container mode (${windowsExecution.docker.serverVersion ?? 'version unavailable'}).`, 'The n8n encryption key is generated on-host and mounted as a protected file.'],
    warnings: ['Docker Desktop must remain running for the service to remain available.'],
    commands: [
      item('write-compose', 'configure', writeCommand(), 'Write the promoted n8n, SQLite persistence, secret, and nginx Compose topology', ['generate-credentials']),
      item('start-compose', 'services', startCommand(), 'Pull and start n8n and nginx with positive health evidence', ['write-compose']),
      item('initialize-n8n', 'initialize', initializeCommand(), 'Require n8n SQLite persistence without exposing its encryption key', ['start-compose']),
      item('verify-restart', 'verify', verifyCommand(), 'Verify n8n health, SQLite persistence, marker, and restart recovery', ['initialize-n8n'], 300000, undefined, 'read')
    ],
    verifyApplied: verifyCommand(false)
  })
}

function writeCommand () {
  const compose = ['services:', '  n8n:', `    image: ${IMAGE}`, '    restart: unless-stopped', '    user: root', '    entrypoint: ["/bin/sh", "-c"]', '    command: ["export N8N_ENCRYPTION_KEY=$$(cat /run/secrets/encryption_key); chown -R node:node /home/node/.n8n; exec su -p -s /bin/sh node -c \'exec /docker-entrypoint.sh start\'"]', '    environment:', '      HOME: /home/node', '      N8N_USER_FOLDER: /home/node', '      N8N_PORT: "5678"', '      N8N_LISTEN_ADDRESS: 0.0.0.0', '      N8N_DIAGNOSTICS_ENABLED: "false"', '      N8N_VERSION_NOTIFICATIONS_ENABLED: "false"', '      N8N_SECURE_COOKIE: "false"', '    secrets: [encryption_key]', '    volumes: [n8n_data:/home/node/.n8n]', '    healthcheck:', '      test: ["CMD", "node", "-e", "fetch(\'http://127.0.0.1:5678/healthz\').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]', '      interval: 5s', '      timeout: 5s', '      retries: 120', '  nginx:', '    image: nginx:1.30.4-alpine', '    restart: unless-stopped', '    depends_on:', '      n8n: { condition: service_healthy }', `    ports: ["${PORT}:80"]`, '    volumes:', '      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro', 'secrets:', `  encryption_key: { file: "${slash(CREDENTIALS)}/encryption_key" }`, 'volumes:', '  n8n_data:'].join('\n')
  const nginx = `server { listen 80; server_name _; default_type text/plain; location = / { return 200 "${MARKER}\\n"; } }\n`
  return ps(["$ErrorActionPreference='Stop'", `New-Item -Path '${q(ROOT)}' -ItemType Directory -Force|Out-Null`, write(`${ROOT}\\compose.yaml`, compose), write(`${ROOT}\\nginx.conf`, nginx), `if(-not(Get-NetFirewallRule -Name '${PROJECT}' -ErrorAction SilentlyContinue)){New-NetFirewallRule -Name '${PROJECT}' -DisplayName 'Intent AI Ops ${PROJECT}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PORT} -Profile Any|Out-Null}`, "Write-Output 'n8n-compose-written'"])
}

function startCommand () { return dockerPs(`& $docker compose -p '${PROJECT}' pull *> $null;& $docker compose -p '${PROJECT}' up -d *> $null;${healthWait()};Write-Output 'compose-started'`) }
function initializeCommand () { return dockerPs(`$state=(& $docker compose -p '${PROJECT}' exec -T n8n /bin/sh -c 'if [ -s /home/node/.n8n/database.sqlite ]; then echo PERSISTED; else echo ABSENT; fi' 2>$null|Out-String).Trim();if($state -ne 'PERSISTED'){throw 'n8n SQLite persistence was not created.'};Write-Output 'n8n-initialized'`) }
function verifyCommand (restart = true) { return dockerPs(`${healthWait()};${markerWait()};${restart ? `& $docker compose -p '${PROJECT}' restart n8n *> $null;${healthWait()};` : ''}Write-Output 'verification-passed'`) }
function healthWait () { return `$ok=$false;for($i=0;$i -lt 120;$i++){$state=(& $docker inspect '${PROJECT}-n8n-1' --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>$null|Out-String).Trim();if($state -eq 'healthy'){$ok=$true;break};Start-Sleep 2};if(-not $ok){throw 'n8n did not become healthy.'}` }
function markerWait () { return `$body=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${PORT}/' -TimeoutSec 10).Content;if($body.Trim() -ne '${MARKER}'){throw 'n8n marker verification failed.'}` }
function dockerPs (body) { return ps(["$ErrorActionPreference='Stop'", windowsDockerPowerShellAdapter(), `Set-Location -LiteralPath '${q(ROOT)}'`, body]) }
function write (path, value) { return `[IO.File]::WriteAllText('${q(path)}',@'\n${value}\n'@,[Text.UTF8Encoding]::new($false))` }
function slash (value) { return value.replaceAll('\\', '/') }
function ps (values) { return values.join(';') }
function q (value) { return String(value).replaceAll("'", "''") }
function item (id, phase, command, purpose, dependsOn, timeoutMs = 300000, executionMode, risk = 'change') { return { id, phase, command, purpose, dependsOn, timeoutMs, executionMode, risk } }
