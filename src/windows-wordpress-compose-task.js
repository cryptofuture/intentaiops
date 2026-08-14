import { applyWindowsComposeOperationDefaults, buildWindowsComposeFoundation, windowsDockerPowerShellAdapter } from './windows-compose-foundation.js'

const WORDPRESS_VERSION = '7.0.2'
const WORDPRESS_IMAGE = `wordpress:${WORDPRESS_VERSION}-php8.3-fpm`
const CLI_IMAGE = 'wordpress:cli-2.12.0-php8.3'
const NGINX_IMAGE = 'nginx:1.30.4-alpine'
const DATABASE_IMAGE = 'mariadb:11.8.8'
const WOO_VERSION = '11.0.0'
const WOO_URL = `https://downloads.wordpress.org/plugin/woocommerce.${WOO_VERSION}.zip`
const WOO_SHA256 = 'ba08c7fc58c98a11f22866269c5832d85c52b664806ec206036f09737ba21666'

export function buildWindowsWordpressComposeTask (taskId, windowsExecution, docker, { wooCommerce = false } = {}) {
  const app = wooCommerce ? 'woocommerce' : 'wordpress'
  const port = wooCommerce ? 18102 : 18101
  const marker = wooCommerce ? 'WEBMINAI_WOOCOMMERCE_OK' : 'WEBMINAI_WORDPRESS_OK'
  const project = `webminai-${app}-${port}`
  const root = `C:\\ProgramData\\WebminAI\\Services\\${app}`
  const credentials = `C:\\ProgramData\\WebminAI\\credentials\\${app}`
  const foundation = buildWindowsComposeFoundation({
    taskId,
    windowsExecution,
    docker,
    application: app,
    port,
    images: [WORDPRESS_IMAGE, CLI_IMAGE, NGINX_IMAGE, DATABASE_IMAGE]
  })
  const state = foundation.paths.state
  const commands = foundation.commands.concat([
    item('write-compose', 'configure', composeCommand({ root, credentials, project, port }), 'Write the reviewed pinned Compose, PHP-FPM socket, and nginx configuration', ['generate-credentials']),
    item('pull-images', 'acquire', dockerCommand(root, project, ['--profile', 'tools', 'pull'], 'images-pulled'), 'Pull the pinned WordPress, WP-CLI, nginx, and MariaDB images', ['write-compose']),
    item('start-compose', 'services', startCommand({ root, project, port }), 'Start the isolated Compose services and wait for HTTP readiness', ['pull-images']),
    item('initialize-wordpress', 'initialize', initializeCommand({ root, project, port, marker }), `Initialize ${wooCommerce ? 'the WordPress foundation' : 'WordPress'} without exposing host-generated credentials`, ['start-compose'])
  ])
  if (wooCommerce) {
    commands.push(item('install-woocommerce', 'initialize', wooCommerceCommand({ root, project }), `Install and activate digest-pinned WooCommerce ${WOO_VERSION}`, ['initialize-wordpress']))
  }
  commands.push(item('verify-restart', 'verify', verifyCommand({ root, project, port, marker, wooCommerce }), `Verify ${wooCommerce ? 'WooCommerce' : 'WordPress'}, external marker readiness, and restart recovery`, [wooCommerce ? 'install-woocommerce' : 'initialize-wordpress'], 300000, undefined, 'read'))
  const boundedCommands = applyWindowsComposeOperationDefaults(commands)

  return {
    plan: {
      summary: `Deploy a verified Windows Docker ${wooCommerce ? 'WooCommerce store' : 'WordPress site'}`,
      changeOverview: `Use the Linux-container Docker engine on Windows to deploy pinned WordPress PHP-FPM, nginx, and MariaDB services${wooCommerce ? ` plus WooCommerce ${WOO_VERSION}` : ''} on port ${port}.`,
      modifiedFiles: [state, root, `${root}\\compose.yaml`, `${root}\\php-fpm.conf`, `${root}\\nginx.conf`, credentials],
      assumptions: [
        `Docker reports Linux-container mode (${windowsExecution.docker.serverVersion ?? 'version unavailable'}) and Docker Compose is callable by LocalSystem.`,
        `The stable Compose project ${project}, TCP port ${port}, and task-owned paths are unused before execution.`,
        'Pinned deployment knowledge is shared with the verified ismet Compose route; Windows-specific path, ACL, firewall, and engine checks are applied here.'
      ],
      warnings: ['Docker Desktop must remain running for the site to remain available.', `The task creates a narrowly scoped inbound Windows Firewall rule for TCP ${port}.`],
      requiresConfirmation: true,
      commands: boundedCommands,
      revertCommands: foundation.revertCommands
    },
    verifyApplied: verifyCommand({ root, project, port, marker, wooCommerce, restart: false }),
    verifyReverted: foundation.verifyReverted,
    stateProbe: foundation.stateProbe
  }
}

export { windowsDockerPowerShellAdapter }

function composeCommand ({ root, credentials, project, port }) {
  const compose = [
    'services:',
    '  db:',
    `    image: ${DATABASE_IMAGE}`,
    '    restart: unless-stopped',
    '    environment:',
    `      MARIADB_DATABASE: ${project.replaceAll('-', '_')}`,
    `      MARIADB_USER: ${project.replaceAll('-', '_')}`,
    '      MARIADB_PASSWORD_FILE: /run/secrets/db_password',
    '      MARIADB_ROOT_PASSWORD_FILE: /run/secrets/db_root_password',
    '    secrets: [db_password, db_root_password]',
    '    volumes: [db_data:/var/lib/mysql]',
    '    healthcheck:',
    '      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]',
    '      interval: 5s',
    '      timeout: 5s',
    '      retries: 60',
    '  wordpress:',
    `    image: ${WORDPRESS_IMAGE}`,
    '    restart: unless-stopped',
    '    depends_on:',
    '      db: { condition: service_healthy }',
    '    environment: &wordpress_environment',
    '      WORDPRESS_DB_HOST: db:3306',
    `      WORDPRESS_DB_NAME: ${project.replaceAll('-', '_')}`,
    `      WORDPRESS_DB_USER: ${project.replaceAll('-', '_')}`,
    '      WORDPRESS_DB_PASSWORD_FILE: /run/webminai/db_password',
    '    command: ["/bin/sh", "-c", "install -o www-data -g www-data -m 0400 /run/secrets/db_password /run/webminai/db_password && exec docker-entrypoint.sh php-fpm"]',
    '    tmpfs: ["/run/webminai:size=64k,mode=0711"]',
    '    secrets: [db_password]',
    '    volumes:',
    '      - wordpress_data:/var/www/html',
    '      - php_run:/run/php-fpm',
    '      - ./php-fpm.conf:/usr/local/etc/php-fpm.d/zz-webminai-socket.conf:ro',
    '  nginx:',
    `    image: ${NGINX_IMAGE}`,
    '    restart: unless-stopped',
    '    depends_on: [wordpress]',
    `    ports: ["${port}:80"]`,
    '    volumes:',
    '      - wordpress_data:/var/www/html:ro',
    '      - php_run:/run/php-fpm',
    '      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro',
    '  cli:',
    `    image: ${CLI_IMAGE}`,
    '    profiles: [tools]',
    '    user: "0:0"',
    '    environment:',
    '      <<: *wordpress_environment',
    '      WORDPRESS_DB_PASSWORD_FILE: /run/secrets/db_password',
    '      HOME: /tmp',
    '      WP_CLI_ALLOW_ROOT: "1"',
    '    secrets: [db_password, admin_password]',
    '    volumes: [wordpress_data:/var/www/html]',
    'secrets:',
    `  db_password: { file: "${credentials.replaceAll('\\', '/')}/db_password" }`,
    `  db_root_password: { file: "${credentials.replaceAll('\\', '/')}/db_root_password" }`,
    `  admin_password: { file: "${credentials.replaceAll('\\', '/')}/admin_password" }`,
    'volumes:',
    '  db_data:',
    '  wordpress_data:',
    '  php_run:'
  ].join('\n')
  const fpm = '[www]\nlisten = /run/php-fpm/webminai.sock\nlisten.owner = www-data\nlisten.group = www-data\nlisten.mode = 0666\n'
  const nginx = 'server { listen 80 default_server; root /var/www/html; index index.php; location / { try_files $uri $uri/ /index.php?$args; } location ~ \\.php$ { try_files $uri =404; include fastcgi_params; fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name; fastcgi_param HTTP_HOST $http_host; fastcgi_pass unix:/run/php-fpm/webminai.sock; } }\n'
  return ps([
    "$ErrorActionPreference='Stop'",
    `New-Item -Path '${psQuote(root)}' -ItemType Directory -Force | Out-Null`,
    `[IO.File]::WriteAllText('${psQuote(root)}\\compose.yaml',@'\n${compose}\n'@,[Text.UTF8Encoding]::new($false))`,
    `[IO.File]::WriteAllText('${psQuote(root)}\\php-fpm.conf',@'\n${fpm}'@,[Text.UTF8Encoding]::new($false))`,
    `[IO.File]::WriteAllText('${psQuote(root)}\\nginx.conf',@'\n${nginx}'@,[Text.UTF8Encoding]::new($false))`,
    `if(-not (Get-NetFirewallRule -Name '${project}' -ErrorAction SilentlyContinue)){New-NetFirewallRule -Name '${project}' -DisplayName 'Intent AI Ops ${project}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile Any | Out-Null}`,
    "Write-Output 'compose-written'"
  ])
}

function dockerCommand (root, project, args, success) {
  return ps([
    '$ErrorActionPreference=\'Stop\'',
    dockerDiscovery('$docker'),
    `Set-Location -LiteralPath '${psQuote(root)}'`,
    `& $docker compose -p '${project}' ${args.map(value => `'${psQuote(value)}'`).join(' ')}`,
    'if($LASTEXITCODE -ne 0){throw \'Docker Compose command failed.\'}',
    `Write-Output '${success}'`
  ])
}

function startCommand ({ root, project, port }) {
  return ps([
    "$ErrorActionPreference='Stop'", dockerDiscovery('$docker'), `Set-Location -LiteralPath '${psQuote(root)}'`,
    `& $docker compose -p '${project}' up -d db wordpress nginx`, "if($LASTEXITCODE -ne 0){throw 'Compose startup failed.'}",
    `$ready=$false;for($attempt=0;$attempt -lt 120;$attempt++){try{$response=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${port}/' -TimeoutSec 5;if($response.StatusCode -ge 200){$ready=$true;break}}catch{};Start-Sleep -Seconds 2}`,
    "if(-not $ready){throw 'WordPress HTTP endpoint did not become ready.'}", "Write-Output 'compose-started'"
  ])
}

function initializeCommand ({ root, project, port, marker }) {
  const cli = `& $docker compose -p '${project}' --profile tools run --rm --no-deps -T --entrypoint /usr/local/bin/wp cli`
  return ps([
    "$ErrorActionPreference='Stop'", dockerDiscovery('$docker'), `Set-Location -LiteralPath '${psQuote(root)}'`,
    `$databaseReady=$false;for($attempt=0;$attempt -lt 60;$attempt++){$databaseCheck=(${cli} --allow-root db check 2>$null|Out-String);if($databaseCheck -match 'Success: Database checked'){$databaseReady=$true;break};Start-Sleep -Seconds 2};if(-not $databaseReady){throw 'WordPress database did not become ready for WP-CLI.'}`,
    `$siteUrl=(${cli} --allow-root option get siteurl 2>$null|Out-String).Trim()`,
    `if($siteUrl -notmatch '^https?://'){& $docker compose -p '${project}' --profile tools run --rm --no-deps -T --entrypoint /bin/sh cli -c 'wp --allow-root core install --url=http://localhost:${port} --title="Intent AI Ops ${project}" --admin_user=webminai_admin --admin_email=intentaiops@example.invalid --admin_password="$(cat /run/secrets/admin_password)" --skip-email' *> $null;$siteUrl=(${cli} --allow-root option get siteurl 2>$null|Out-String).Trim();if($siteUrl -notmatch '^https?://'){throw 'WordPress initialization failed.'}}`,
    `$page=(${cli} --allow-root post list --post_type=page --name=webminai-compatibility-marker --field=ID --format=ids 2>$null | Select-Object -First 1)`,
    `if(-not $page){$page=(${cli} --allow-root post create --post_type=page --post_status=publish --post_name=webminai-compatibility-marker --post_title='WebminAI Compatibility Marker' --post_content='${marker}' --porcelain);if($LASTEXITCODE -ne 0){throw 'Marker page creation failed.'}}else{${cli} --allow-root post update $page --post_status=publish --post_title='WebminAI Compatibility Marker' --post_content='${marker}' *> $null}`,
    `${cli} --allow-root option update show_on_front page *> $null`, `${cli} --allow-root option update page_on_front $page *> $null`,
    "Write-Output 'wordpress-initialized'"
  ])
}

function wooCommerceCommand ({ root, project }) {
  const artifact = `${root}\\woocommerce.${WOO_VERSION}.zip`
  const cli = `& $docker compose -p '${project}' --profile tools run --rm --no-deps -T --entrypoint /usr/local/bin/wp cli`
  return ps([
    "$ErrorActionPreference='Stop'", dockerDiscovery('$docker'), `Set-Location -LiteralPath '${psQuote(root)}'`,
    `Invoke-WebRequest -UseBasicParsing -Uri '${WOO_URL}' -OutFile '${psQuote(artifact)}' -TimeoutSec 300`,
    `if((Get-FileHash -LiteralPath '${psQuote(artifact)}' -Algorithm SHA256).Hash.ToLowerInvariant() -ne '${WOO_SHA256}'){Remove-Item -LiteralPath '${psQuote(artifact)}' -Force;throw 'WooCommerce SHA-256 verification failed.'}`,
    `& $docker compose -p '${project}' cp '${psQuote(artifact)}' 'wordpress:/var/www/html/woocommerce.zip'`, "if($LASTEXITCODE -ne 0){throw 'WooCommerce artifact copy failed.'}",
    `${cli} --allow-root plugin install /var/www/html/woocommerce.zip --force --activate`, "if($LASTEXITCODE -ne 0){throw 'WooCommerce activation failed.'}",
    `& $docker compose -p '${project}' exec -T wordpress rm -f /var/www/html/woocommerce.zip`,
    `${cli} --allow-root plugin is-active woocommerce *> $null`, "if($LASTEXITCODE -ne 0){throw 'WooCommerce is not active.'}",
    "Write-Output 'woocommerce-installed'"
  ])
}

function verifyCommand ({ root, project, port, marker, wooCommerce, restart = true }) {
  const cli = `& $docker compose -p '${project}' --profile tools run --rm --no-deps -T --entrypoint /usr/local/bin/wp cli`
  return ps([
    "$ErrorActionPreference='Stop'", dockerDiscovery('$docker'), `Set-Location -LiteralPath '${psQuote(root)}'`,
    ...(wooCommerce ? [`${cli} --allow-root plugin is-active woocommerce *> $null`, "if($LASTEXITCODE -ne 0){throw 'WooCommerce activation verification failed.'}"] : []),
    ...(restart ? [`& $docker compose -p '${project}' restart db wordpress nginx`, "if($LASTEXITCODE -ne 0){throw 'Compose restart failed.'}"] : []),
    `$verified=$false;for($attempt=0;$attempt -lt 90;$attempt++){try{$body=(Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:${port}/' -TimeoutSec 5).Content;if($body -like '*${marker}*'){$verified=$true;break}}catch{};Start-Sleep -Seconds 2}`,
    `if(-not $verified){throw '${marker} was not returned after restart.'}`, "Write-Output 'verification-passed'"
  ])
}

function item (id, phase, command, purpose, dependsOn = [], timeoutMs = 300000, executionMode, risk = 'change') {
  return { id, phase, command, purpose, risk, timeoutMs, requiresSudo: true, dependsOn, ...(executionMode ? { executionMode } : {}) }
}

function ps (statements) {
  return statements.join(';')
}

function psQuote (value) {
  return String(value).replaceAll("'", "''")
}

function dockerDiscovery (variable, timeoutMs = 300000) {
  return `$dockerExe=(Get-Command docker.exe -ErrorAction SilentlyContinue).Source;if(-not $dockerExe){$dockerExe=Join-Path $env:ProgramFiles 'Docker\\Docker\\resources\\bin\\docker.exe'};if(-not (Test-Path -LiteralPath $dockerExe -PathType Leaf)){throw 'docker.exe is unavailable to LocalSystem.'};${variable}={$dockerArguments=@($args|ForEach-Object{$value=[string]$_;if($value -match '[\\s"]'){'"'+$value.Replace('"','\\"')+'"'}else{$value}});$stdout=[IO.Path]::GetTempFileName();$stderr=[IO.Path]::GetTempFileName();try{$process=Start-Process -FilePath $dockerExe -ArgumentList $dockerArguments -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr;if(-not $process.WaitForExit(${timeoutMs})){$process.Kill();throw 'Docker command timed out.'};$stdoutText=[string](Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue);$stderrText=[string](Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue);$global:LASTEXITCODE=if($null -ne $process.ExitCode){[int]$process.ExitCode}elseif($stderrText -match '(?im)^(error|failed|unknown command|docker:)'){1}else{0};if($stdoutText){Write-Output $stdoutText};if($stderrText){Write-Error -Message $stderrText -ErrorAction Continue}}finally{Remove-Item -LiteralPath $stdout,$stderr -Force -ErrorAction SilentlyContinue}}`
}
