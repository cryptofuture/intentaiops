import { buildWindowsComposeApplicationTask, windowsDockerPowerShellAdapter } from './windows-compose-foundation.js'

const APP = 'ghcr.io/home-assistant/home-assistant@sha256:6340a3de3917a9b19368e767310a96dd090f6a19aca8aeadf87fd1145cec9682'
const NGINX = 'nginx@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46'
const PORT = 18115
const MARKER = 'WEBMINAI_HOME_ASSISTANT_OK'
const PROJECT = 'webminai-home-assistant-18115'
const ROOT = 'C:\\ProgramData\\WebminAI\\Services\\home-assistant'
const CREDENTIALS = 'C:\\ProgramData\\WebminAI\\credentials\\home-assistant'

export function buildWindowsHomeAssistantComposeTask (taskId, windowsExecution, docker) {
  return buildWindowsComposeApplicationTask({
    taskId,
    windowsExecution,
    docker,
    application: 'home-assistant',
    port: PORT,
    images: [APP, NGINX],
    credentials: ['admin_username', 'admin_password'],
    summary: 'Deploy a verified Windows Docker Home Assistant service',
    changeOverview: `Reuse the promoted isolated ismet Home Assistant topology on Windows Docker port ${PORT}.`,
    modifiedFiles: [`${ROOT}\\configuration.yaml`, `${ROOT}\\nginx.conf`, `${ROOT}\\initialize-stage`],
    assumptions: [`Docker reports Linux-container mode (${windowsExecution.docker.serverVersion ?? 'version unavailable'}).`, 'Home Assistant administrator material is generated and read only on-host.'],
    warnings: ['Docker Desktop must remain running for the service to remain available.'],
    commands: [
      item('normalize-admin-username', 'secrets', normalizeUsernameCommand(), 'Normalize the generated Home Assistant administrator name without exposing it', ['generate-credentials']),
      item('write-compose', 'configure', writeCommand(), 'Write the ismet isolated Home Assistant and nginx topology', ['normalize-admin-username']),
      item('start-compose', 'services', startCommand(), 'Start Home Assistant and nginx with bounded health readiness', ['write-compose']),
      item('initialize-home-assistant', 'initialize', initializeCommand(), 'Complete Home Assistant onboarding using protected administrator files', ['start-compose']),
      item('verify-restart', 'verify', verifyCommand(), 'Verify Home Assistant version, onboarding, SQLite state, marker, and restart recovery', ['initialize-home-assistant'], 300000, undefined, 'read')
    ],
    verifyApplied: verifyCommand(false)
  })
}

function normalizeUsernameCommand () { return `$value=[IO.File]::ReadAllText('${q(CREDENTIALS)}\\admin_username').Trim().ToLowerInvariant();$value=[Text.RegularExpressions.Regex]::Replace($value,'[^a-z0-9_]','');[IO.File]::WriteAllText('${q(CREDENTIALS)}\\admin_username',$value,[Text.UTF8Encoding]::new($false));Write-Output 'administrator-name-prepared'` }

function writeCommand () {
  const config = `homeassistant:\n  name: ${MARKER}\n  latitude: 0\n  longitude: 0\n  elevation: 0\n  unit_system: metric\n  time_zone: Etc/UTC\nfrontend:\napi:\nconfig:\nhistory:\nlogbook:\nrecorder:\nhttp:\n  server_host: 0.0.0.0\n  server_port: 8123\n  use_x_forwarded_for: true\n  trusted_proxies:\n    - 172.16.0.0/12\n`
  const compose = ['services:', '  init-config:', `    image: ${APP}`, '    user: "0"', '    entrypoint: ["/bin/sh", "-c"]', '    command: ["test -f /config/configuration.yaml || cp /run/webminai/configuration.yaml /config/configuration.yaml"]', '    volumes: [ha_config:/config, ./configuration.yaml:/run/webminai/configuration.yaml:ro]', '  app:', `    image: ${APP}`, '    restart: unless-stopped', '    environment: [TZ=Etc/UTC]', '    volumes: [ha_config:/config, /etc/localtime:/etc/localtime:ro]', '    depends_on:', '      init-config: { condition: service_completed_successfully }', '    healthcheck:', '      test: ["CMD", "python3", "-c", "import urllib.request; urllib.request.urlopen(\'http://127.0.0.1:8123/\', timeout=5).read()"]', '      interval: 5s', '      timeout: 8s', '      retries: 180', '      start_period: 30s', '  nginx:', `    image: ${NGINX}`, '    restart: unless-stopped', '    depends_on:', '      app: { condition: service_healthy }', `    ports: ["${PORT}:80"]`, '    volumes: [./nginx.conf:/etc/nginx/conf.d/default.conf:ro]', 'volumes:', '  ha_config:'].join('\n')
  const nginx = `server { listen 80; server_name _; location = / { default_type text/plain; return 200 "${MARKER}\\n"; } location /homeassistant/ { proxy_pass http://app:8123/; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; } }\n`
  return ps(["$ErrorActionPreference='Stop'", `New-Item -Path '${q(ROOT)}' -ItemType Directory -Force|Out-Null`, write(`${ROOT}\\compose.yaml`, compose), write(`${ROOT}\\configuration.yaml`, config), write(`${ROOT}\\nginx.conf`, nginx), `if(-not(Get-NetFirewallRule -Name '${PROJECT}' -ErrorAction SilentlyContinue)){New-NetFirewallRule -Name '${PROJECT}' -DisplayName 'Intent AI Ops ${PROJECT}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PORT} -Profile Any|Out-Null}`, "Write-Output 'home-assistant-compose-written'"])
}

function startCommand () { return dockerPs(`& $docker compose -p '${PROJECT}' pull *> $null;& $docker compose -p '${PROJECT}' up -d *> $null;${health()};${marker()};Write-Output 'compose-started'`) }
function initializeCommand () { return dockerPs(`${health()};$stage='${q(ROOT)}\\initialize-stage';$base='http://127.0.0.1:${PORT}/homeassistant';$done=(Test-Path -LiteralPath $stage)-and([IO.File]::ReadAllText($stage)-eq'completed');if(-not $done){$username=[IO.File]::ReadAllText('${q(CREDENTIALS)}\\admin_username').Trim();$password=[IO.File]::ReadAllText('${q(CREDENTIALS)}\\admin_password').Trim();$body=@{client_id="$base/";name='${MARKER}';username=$username;password=$password;language='en'}|ConvertTo-Json;[IO.File]::WriteAllText($stage,'users');try{$created=Invoke-RestMethod -Method Post -Uri "$base/api/onboarding/users" -ContentType 'application/json' -Body $body}catch{$code=[int]$_.Exception.Response.StatusCode;[IO.File]::WriteAllText($stage,'users-http-'+$code);throw};[IO.File]::WriteAllText($stage,'token');$token=Invoke-RestMethod -Method Post -Uri "$base/auth/token" -ContentType 'application/x-www-form-urlencoded' -Body @{grant_type='authorization_code';code=$created.auth_code;client_id="$base/"};$headers=@{Authorization='Bearer '+$token.access_token};[IO.File]::WriteAllText($stage,'core-config');Invoke-RestMethod -Method Post -Uri "$base/api/onboarding/core_config" -Headers $headers|Out-Null;[IO.File]::WriteAllText($stage,'integration');Invoke-RestMethod -Method Post -Uri "$base/api/onboarding/integration" -Headers $headers -ContentType 'application/json' -Body (@{client_id="$base/";redirect_uri="$base/"}|ConvertTo-Json)|Out-Null;[IO.File]::WriteAllText($stage,'analytics');Invoke-RestMethod -Method Post -Uri "$base/api/onboarding/analytics" -Headers $headers|Out-Null;[IO.File]::WriteAllText($stage,'completed')};Write-Output 'home-assistant-initialized'`) }
function verifyCommand (restart = true) { return dockerPs(`${health()};$version=(& $docker compose -p '${PROJECT}' exec -T app python3 -c 'from homeassistant.const import __version__; print(__version__)' 2>$null|Out-String).Trim();if($version-ne'2026.8.1'){throw 'Home Assistant version verification failed.'};if((-not(Test-Path -LiteralPath '${q(ROOT)}\\initialize-stage'))-or([IO.File]::ReadAllText('${q(ROOT)}\\initialize-stage')-ne'completed')){throw 'Home Assistant onboarding evidence is missing.'};$db=(& $docker compose -p '${PROJECT}' exec -T app sh -c 'test -s /config/home-assistant_v2.db && test -s /config/.storage/auth && echo READY' 2>$null|Out-String).Trim();if($db-ne'READY'){throw 'Home Assistant persistent state is missing.'};${marker()};${restart ? `& $docker compose -p '${PROJECT}' restart app *> $null;${health()};` : ''}Write-Output 'verification-passed'`) }
function health () { return `$ok=$false;for($i=0;$i-lt 180;$i++){$state=(& $docker inspect '${PROJECT}-app-1' --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>$null|Out-String).Trim();if($state-eq'healthy'){$ok=$true;break};Start-Sleep 2};if(-not $ok){throw 'Home Assistant did not become healthy.'}` }
function marker () { return `$body=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${PORT}/' -TimeoutSec 10).Content;if($body.Trim()-ne'${MARKER}'){throw 'Home Assistant marker verification failed.'}` }
function dockerPs (body) { return ps(["$ErrorActionPreference='Stop'", windowsDockerPowerShellAdapter(), `Set-Location -LiteralPath '${q(ROOT)}'`, body]) }
function write (path, value) { return `[IO.File]::WriteAllText('${q(path)}',@'\n${value}\n'@,[Text.UTF8Encoding]::new($false))` }
function ps (values) { return values.join(';') }
function q (value) { return String(value).replaceAll("'", "''") }
function item (id, phase, command, purpose, dependsOn, timeoutMs = 300000, executionMode, risk = 'change') { return { id, phase, command, purpose, dependsOn, timeoutMs, executionMode, risk } }
