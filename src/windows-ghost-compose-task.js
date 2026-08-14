import { buildWindowsComposeApplicationTask, windowsDockerPowerShellAdapter } from './windows-compose-foundation.js'

const GHOST = 'ghost@sha256:5cb081c6be54af505f28cde86f209e8e43910da0a406226a9e5e98045388599b'
const MYSQL = 'mysql@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b'
const NGINX = 'nginx@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46'
const PORT = 18110
const MARKER = 'WEBMINAI_GHOST_OK'
const PROJECT = 'webminai-ghost-18110'
const ROOT = 'C:\\ProgramData\\WebminAI\\Services\\ghost'
const CREDENTIALS = 'C:\\ProgramData\\WebminAI\\credentials\\ghost'

export function buildWindowsGhostComposeTask (taskId, windowsExecution, docker) {
  return buildWindowsComposeApplicationTask({
    taskId,
    windowsExecution,
    docker,
    application: 'ghost',
    port: PORT,
    images: [GHOST, MYSQL, NGINX],
    credentials: ['database_password', 'database_root_password'],
    summary: 'Deploy a verified Windows Docker Ghost service',
    changeOverview: `Reuse the promoted ismet digest-pinned Ghost topology on Windows Docker port ${PORT}.`,
    modifiedFiles: [`${ROOT}\\nginx.conf`, `${CREDENTIALS}\\credentials.env`],
    assumptions: [`Docker reports Linux-container mode (${windowsExecution.docker.serverVersion ?? 'version unavailable'}).`, 'Database credentials are generated on-host and written only into protected environment storage.'],
    warnings: ['Docker Desktop must remain running for the service to remain available.'],
    commands: [
      item('write-compose', 'configure', writeCommand(), 'Write the ismet digest-pinned Ghost, MySQL, and nginx topology with protected environment material', ['generate-credentials']),
      item('start-compose', 'services', startCommand(), 'Pull and start MySQL, Ghost, and nginx with positive health evidence', ['write-compose']),
      item('initialize-ghost', 'initialize', initializeCommand(), 'Verify Ghost created persistent database and content state', ['start-compose']),
      item('verify-restart', 'verify', verifyCommand(), 'Verify Ghost version, database, blog, marker, and restart recovery', ['initialize-ghost'], 300000, undefined, 'read')
    ],
    verifyApplied: verifyCommand(false)
  })
}

function writeCommand () {
  // eslint-disable-next-line no-template-curly-in-string
  const compose = ['services:', '  db:', `    image: ${MYSQL}`, '    restart: unless-stopped', '    env_file: [./credentials.env]', '    environment:', '      MYSQL_DATABASE: webminai_ghost_18110', '      MYSQL_USER: webminai_ghost', '    volumes: [mysql_data:/var/lib/mysql]', '    healthcheck:', "      test: ['CMD-SHELL', 'mysqladmin ping -h 127.0.0.1 -u root --password=\"$${MYSQL_ROOT_PASSWORD}\"']", '      interval: 5s', '      timeout: 5s', '      retries: 120', '      start_period: 30s', '  ghost:', `    image: ${GHOST}`, '    restart: unless-stopped', '    env_file: [./credentials.env]', '    environment:', '      NODE_ENV: production', '      database__client: mysql', '      database__connection__host: db', '      database__connection__user: webminai_ghost', '      database__connection__database: webminai_ghost_18110', '    volumes: [ghost_content:/var/lib/ghost/content]', '    depends_on:', '      db: { condition: service_healthy }', '    healthcheck:', '      test: ["CMD", "node", "-e", "fetch(\'http://127.0.0.1:2368/blog/\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]', '      interval: 5s', '      timeout: 5s', '      retries: 120', '      start_period: 30s', '  nginx:', `    image: ${NGINX}`, '    restart: unless-stopped', '    depends_on:', '      ghost: { condition: service_healthy }', `    ports: ["${PORT}:80"]`, '    volumes: [./nginx.conf:/etc/nginx/conf.d/default.conf:ro]', 'volumes:', '  mysql_data:', '  ghost_content:'].join('\n')
  const nginx = `server { listen 80; server_name _; location = / { default_type text/plain; return 200 "${MARKER}\\n"; } location /blog/ { proxy_pass http://ghost:2368; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; } }\n`
  const address = "$route=Get-NetRoute -DestinationPrefix '0.0.0.0/0'|Sort-Object RouteMetric,InterfaceMetric|Select-Object -First 1;$address=(Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4|Where-Object {$_.IPAddress -notlike '169.254.*'}|Select-Object -First 1).IPAddress;if(-not $address){throw 'Primary Windows IPv4 address was not found.'}"
  const environment = `$nl=[Environment]::NewLine;$environment=('MYSQL_PASSWORD='+$password+$nl+'MYSQL_ROOT_PASSWORD='+$rootPassword+$nl+'database__connection__password='+$password+$nl+'url=http://'+$address+':${PORT}/blog/'+$nl+'privacy__useUpdateCheck=false'+$nl)`
  return ps(["$ErrorActionPreference='Stop'", address, `New-Item -Path '${q(ROOT)}' -ItemType Directory -Force|Out-Null`, `$password=[IO.File]::ReadAllText('${q(CREDENTIALS)}\\database_password').Trim()`, `$rootPassword=[IO.File]::ReadAllText('${q(CREDENTIALS)}\\database_root_password').Trim()`, environment, `[IO.File]::WriteAllText('${q(ROOT)}\\credentials.env',$environment,[Text.UTF8Encoding]::new($false))`, write(`${ROOT}\\compose.yaml`, compose), write(`${ROOT}\\nginx.conf`, nginx), `if(-not(Get-NetFirewallRule -Name '${PROJECT}' -ErrorAction SilentlyContinue)){New-NetFirewallRule -Name '${PROJECT}' -DisplayName 'Intent AI Ops ${PROJECT}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${PORT} -Profile Any|Out-Null}`, "Write-Output 'ghost-compose-written'"])
}

function startCommand () { return dockerPs(`& $docker compose -p '${PROJECT}' pull *> $null;& $docker compose -p '${PROJECT}' up -d *> $null;${health('db')};${health('ghost')};${marker()};Write-Output 'compose-started'`) }
function initializeCommand () { return dockerPs(`$state=(& $docker compose -p '${PROJECT}' exec -T ghost /bin/sh -c 'if [ -d /var/lib/ghost/content/data ] && [ -d /var/lib/ghost/content/themes ]; then echo PERSISTED; else echo ABSENT; fi' 2>$null|Out-String).Trim();if($state -ne 'PERSISTED'){throw 'Ghost persistent content state was not created.'};Write-Output 'ghost-initialized'`) }
function verifyCommand (restart = true) { return dockerPs(`${health('db')};${health('ghost')};$version=(& $docker compose -p '${PROJECT}' exec -T ghost node -p "require('/var/lib/ghost/current/package.json').version" 2>$null|Out-String).Trim();if($version -ne '6.56.0'){throw 'Ghost version verification failed.'};${marker()};$blog=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${PORT}/blog/' -TimeoutSec 10;if(-not $blog.StatusCode){throw 'Ghost blog verification failed.'};${restart ? `& $docker compose -p '${PROJECT}' restart ghost *> $null;${health('ghost')};` : ''}Write-Output 'verification-passed'`) }
function health (service) { return `$ok=$false;for($i=0;$i -lt 120;$i++){$state=(& $docker inspect '${PROJECT}-${service}-1' --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>$null|Out-String).Trim();if($state -eq 'healthy'){$ok=$true;break};Start-Sleep 2};if(-not $ok){throw '${service} did not become healthy.'}` }
function marker () { return `$body=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${PORT}/' -TimeoutSec 10).Content;if($body.Trim() -ne '${MARKER}'){throw 'Ghost marker verification failed.'}` }
function dockerPs (body) { return ps(["$ErrorActionPreference='Stop'", windowsDockerPowerShellAdapter(), `Set-Location -LiteralPath '${q(ROOT)}'`, body]) }
function write (path, value) { return `[IO.File]::WriteAllText('${q(path)}',@'\n${value}\n'@,[Text.UTF8Encoding]::new($false))` }
function ps (values) {
  return values.join(';')
    .replaceAll('env_file: [./credentials.env]', `env_file: ["${CREDENTIALS.replaceAll('\\', '/')}/credentials.env"]`)
    .replaceAll(`${q(ROOT)}\\credentials.env`, `${q(CREDENTIALS)}\\credentials.env`)
}
function q (value) { return String(value).replaceAll("'", "''") }
function item (id, phase, command, purpose, dependsOn, timeoutMs = 300000, executionMode, risk = 'change') { return { id, phase, command, purpose, dependsOn, timeoutMs, executionMode, risk } }
