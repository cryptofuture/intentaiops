import { buildWindowsComposeApplicationTask, windowsDockerPowerShellAdapter } from './windows-compose-foundation.js'

const APP = 'jellyfin/jellyfin@sha256:aefb67e6a7ff1debdd154a78a7bbb780fd0c873d8639210a7f6a2016ad2b35db'
const NGINX = 'nginx@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46'
const PORT = 18113
const MARKER = 'WEBMINAI_JELLYFIN_OK'
const PROJECT = 'webminai-jellyfin-18113'
const ROOT = 'C:\\ProgramData\\WebminAI\\Services\\jellyfin'
const CREDENTIALS = 'C:\\ProgramData\\WebminAI\\credentials\\jellyfin'

export function buildWindowsJellyfinComposeTask (taskId, windowsExecution, docker) {
  return buildWindowsComposeApplicationTask({
    taskId,
    windowsExecution,
    docker,
    application: 'jellyfin',
    port: PORT,
    images: [APP, NGINX],
    credentials: ['admin_username', 'admin_password'],
    summary: 'Deploy a verified Windows Docker Jellyfin service',
    changeOverview: `Reuse the promoted ismet Jellyfin topology on Windows Docker port ${PORT}.`,
    modifiedFiles: [`${ROOT}\\nginx.conf`, `${ROOT}\\initialize-stage`],
    assumptions: [`Docker reports Linux-container mode (${windowsExecution.docker.serverVersion ?? 'version unavailable'}).`, 'The administrator name and password are generated only on-host.'],
    warnings: ['Docker Desktop must remain running for the service to remain available.'],
    commands: [
      item('normalize-admin-username', 'secrets', normalizeUsernameCommand(), 'Derive a bounded Jellyfin administrator name without exposing it', ['generate-credentials']),
      item('write-compose', 'configure', writeCommand(), 'Write the ismet digest-pinned Jellyfin and nginx topology', ['normalize-admin-username']),
      item('start-compose', 'services', startCommand(), 'Start Jellyfin and nginx with health readiness', ['write-compose']),
      item('initialize-jellyfin', 'initialize', initializeCommand(), 'Complete Jellyfin startup using protected administrator files', ['start-compose']),
      item('verify-restart', 'verify', verifyCommand(), 'Verify Jellyfin version, API, persistent database, marker, and restart recovery', ['initialize-jellyfin'], 300000, undefined, 'read')
    ],
    verifyApplied: verifyCommand(false)
  })
}

function normalizeUsernameCommand () { return `$value=[IO.File]::ReadAllText('${q(CREDENTIALS)}\\admin_username').Trim();if($value-notlike'webminai_*'){[IO.File]::WriteAllText('${q(CREDENTIALS)}\\admin_username','webminai_'+$value.Substring(0,8),[Text.UTF8Encoding]::new($false))};Write-Output 'administrator-name-prepared'` }

function writeCommand () {
  const compose = ['services:', '  app:', `    image: ${APP}`, '    restart: unless-stopped', '    volumes: [jellyfin_config:/config, jellyfin_cache:/cache, jellyfin_media:/media:ro]', '    healthcheck:', '      test: ["CMD", "curl", "--fail", "--silent", "http://127.0.0.1:8096/health"]', '      interval: 5s', '      timeout: 5s', '      retries: 120', '      start_period: 20s', '  nginx:', `    image: ${NGINX}`, '    restart: unless-stopped', '    depends_on:', '      app: { condition: service_healthy }', `    ports: ["${PORT}:80"]`, '    volumes: [./nginx.conf:/etc/nginx/conf.d/default.conf:ro]', 'volumes:', '  jellyfin_config:', '  jellyfin_cache:', '  jellyfin_media:'].join('\n')
  const nginx = `server { listen 80; server_name _; location = / { default_type text/plain; return 200 "${MARKER}\\n"; } location /jellyfin/ { proxy_pass http://app:8096/; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; } }\n`
  return ps(["$ErrorActionPreference='Stop'", `New-Item -Path '${q(ROOT)}' -ItemType Directory -Force|Out-Null`, write(`${ROOT}\\compose.yaml`, compose), write(`${ROOT}\\nginx.conf`, nginx), `if(-not(Get-NetFirewallRule -Name '${PROJECT}' -ErrorAction SilentlyContinue)){New-NetFirewallRule -Name '${PROJECT}' -DisplayName 'Intent AI Ops ${PROJECT}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PORT} -Profile Any|Out-Null}`, "Write-Output 'jellyfin-compose-written'"])
}

function startCommand () { return dockerPs(`& $docker compose -p '${PROJECT}' pull *> $null;& $docker compose -p '${PROJECT}' up -d *> $null;${health()};${marker()};Write-Output 'compose-started'`) }
function initializeCommand () { return dockerPs(`${health()};$base='http://127.0.0.1:${PORT}/jellyfin';$stage='${q(ROOT)}\\initialize-stage';$done=(Test-Path -LiteralPath $stage)-and([IO.File]::ReadAllText($stage)-eq'completed');if(-not $done){$username=[IO.File]::ReadAllText('${q(CREDENTIALS)}\\admin_username').Trim();$password=[IO.File]::ReadAllText('${q(CREDENTIALS)}\\admin_password').Trim();[IO.File]::WriteAllText($stage,'configuration');Invoke-RestMethod -Method Post -Uri "$base/Startup/Configuration" -ContentType 'application/json' -Body (@{UICulture='en-US';MetadataCountryCode='US';PreferredMetadataLanguage='en'}|ConvertTo-Json)|Out-Null;Invoke-RestMethod -Uri "$base/Startup/User" -TimeoutSec 10|Out-Null;[IO.File]::WriteAllText($stage,'user');try{Invoke-RestMethod -Method Post -Uri "$base/Startup/User" -ContentType 'application/json' -Body (@{Name=$username;Password=$password}|ConvertTo-Json)|Out-Null}catch{$code=[int]$_.Exception.Response.StatusCode;[IO.File]::WriteAllText($stage,'user-http-'+$code);throw};[IO.File]::WriteAllText($stage,'remote-access');Invoke-RestMethod -Method Post -Uri "$base/Startup/RemoteAccess" -ContentType 'application/json' -Body (@{EnableRemoteAccess=$true;EnableAutomaticPortMapping=$false}|ConvertTo-Json)|Out-Null;[IO.File]::WriteAllText($stage,'complete');Invoke-RestMethod -Method Post -Uri "$base/Startup/Complete"|Out-Null;[IO.File]::WriteAllText($stage,'completed')};Write-Output 'jellyfin-initialized'`) }
function verifyCommand (restart = true) { return dockerPs(`${health()};$info=Invoke-RestMethod -Uri 'http://127.0.0.1:${PORT}/jellyfin/System/Info/Public' -TimeoutSec 10;if($info.Version-ne'10.11.11'){throw 'Jellyfin version verification failed.'};$db=(& $docker compose -p '${PROJECT}' exec -T app sh -c 'find /config -maxdepth 3 -type f -name "*.db" | head -1' 2>$null|Out-String).Trim();if(-not $db){throw 'Jellyfin database was not created.'};${marker()};${restart ? `& $docker compose -p '${PROJECT}' restart app *> $null;${health()};` : ''}Write-Output 'verification-passed'`) }
function health () { return `$ok=$false;for($i=0;$i-lt 180;$i++){$state=(& $docker inspect '${PROJECT}-app-1' --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>$null|Out-String).Trim();if($state-eq'healthy'){$ok=$true;break};Start-Sleep 2};if(-not $ok){throw 'Jellyfin did not become healthy.'}` }
function marker () { return `$body=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${PORT}/' -TimeoutSec 10).Content;if($body.Trim()-ne'${MARKER}'){throw 'Jellyfin marker verification failed.'}` }
function dockerPs (body) { return ps(["$ErrorActionPreference='Stop'", windowsDockerPowerShellAdapter(), `Set-Location -LiteralPath '${q(ROOT)}'`, body]) }
function item (id, phase, command, purpose, dependsOn, timeoutMs = 300000, executionMode, risk = 'change') { return { id, phase, command, purpose, dependsOn, timeoutMs, executionMode, risk } }
function write (path, value) { return `[IO.File]::WriteAllText('${q(path)}',@'\n${value}\n'@,[Text.UTF8Encoding]::new($false))` }
function ps (values) { return values.join(';') }
function q (value) { return String(value).replaceAll("'", "''") }
