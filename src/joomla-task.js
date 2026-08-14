import { deploymentBlueprint, validateApplicationDeltaPlan } from './application-delta.js'
import { buildLinuxPhpApplicationFoundation, linuxPhpApplicationProfile } from './linux-php-foundation.js'

const VERSION = '5.4.7'
const ARCHIVE_URL = `https://update.joomla.org/releases/${VERSION}/Joomla_${VERSION}-Stable-Full_Package.tar.gz`
const ARCHIVE_SHA1 = 'abdea97da1a6bba01796f9f017582cda15dce4c8'
const ARCHIVE_SHA256 = 'd989e8a315238784b8e4ca5eef0cad3e498e989cc0b9094d341c0d997ddb8729'
const JOOMLA_IMAGE = 'joomla:5.4.7-php8.3-fpm'
const NGINX_IMAGE = 'nginx:1.30.4-alpine'
const DATABASE_IMAGE = 'mariadb:11.8.8'
const PORT = 18103
const MARKER = 'WEBMINAI_JOOMLA_OK'
const SITE = 'webminai-joomla-18103'
const WEB_ROOT = `/srv/${SITE}`
const ARTIFACTS = `/var/lib/webminai/${SITE}`
const CREDENTIALS = '/root/joomla_credentials'
const DATABASE = 'webminai_joomla_18103'
const SERVICE_ROOT = '/opt/webminai/services/joomla'
const PROJECT = 'webminai-joomla-18103'

export function buildJoomlaTask (taskId, linuxContext, docker = {}) {
  const compose = docker.preferred === true
  const application = applicationContract()
  const built = buildLinuxPhpApplicationFoundation({ taskId, linuxContext, docker, application })
  const manifest = compatibilityManifest(linuxContext, compose)

  if (compose) configureComposePlan(built, taskId, linuxContext)
  else configureNativePlan(built, taskId, linuxContext)

  assignPhases(built.plan)
  const deltaCommands = built.plan.commands.filter(item => ['extract-joomla', 'install-joomla', 'verify-joomla', 'write-compose', 'initialize-joomla'].includes(item.id))
  validateApplicationDeltaPlan({ commands: deltaCommands, revertCommands: [] })

  built.plan.summary = `Deploy a learned reversible ${compose ? 'Joomla Compose site' : 'native Joomla site'}`
  built.plan.changeOverview = `Compose the reviewed PHP/database foundation with digest-verified Joomla ${VERSION} on port ${PORT}.`
  built.plan.assumptions = [
    `Compatibility resolved from Joomla ${VERSION}'s official support matrix before planning.`,
    compose
      ? 'The pinned official Joomla PHP 8.3 image and MariaDB 11.8 image satisfy the resolved row.'
      : 'The reviewed distro profile supplies PHP 8.1+, MariaDB 10.4+, and nginx 1.21+; EL9 selects task-owned module streams when necessary.',
    'Administrator and database passwords are generated on-host and consumed only from protected files.'
  ]
  built.plan.warnings = [
    `This controlled test serves HTTP on isolated port ${PORT}.`,
    'The native installer bootstrap contains no credentials and exists only to translate protected file paths inside PHP.'
  ]
  built.plan.compatibilityManifest = manifest
  built.plan.modifiedFiles = [...new Set(built.plan.modifiedFiles)]
  built.plan.applicationDelta = deploymentBlueprint({
    manifest,
    foundationPhases: [...new Set(built.plan.commands.filter(item => !deltaCommands.includes(item)).map(item => item.phase))],
    foundationPaths: built.plan.modifiedFiles.filter(path => !path.endsWith('/joomla.tar.gz'))
  })
  return built
}

export function joomlaRelease () {
  return Object.freeze({ version: VERSION, url: ARCHIVE_URL, sha1: ARCHIVE_SHA1, sha256: ARCHIVE_SHA256, image: JOOMLA_IMAGE })
}

export function joomlaComposeAssets () {
  return Object.freeze({
    fpm: fpmSocketConfig().join('\n'),
    nginx: nginxConfig().join('\n'),
    installer: installerBootstrapLines().join('\n')
  })
}

function configureNativePlan (built, taskId, linuxContext) {
  const profile = linuxPhpApplicationProfile(linuxContext, applicationContract())
  const state = `/var/lib/webminai/task-state/${taskId}-joomla-linux`
  replaceCommand(built.plan, 'capture-baseline', nativeBaselineCommand(built.plan.commands.find(item => item.id === 'capture-baseline').command, state, linuxContext))
  replaceCommand(built.plan, 'install-packages', nativePackagesCommand(built.plan.commands.find(item => item.id === 'install-packages').command, state, linuxContext, profile))
  replaceCommand(built.plan, 'verify-artifacts', artifactCommand(), 'Acquire and verify the exact official Joomla archive')
  renameCommand(built.plan, 'extract-application', 'extract-joomla', extractCommand(profile), 'Extract the verified Joomla release with reviewed ownership and permissions')
  renameCommand(built.plan, 'install-application', 'install-joomla', installCommand(profile, state), 'Install Joomla using protected credential-file indirection inside PHP')
  renameCommand(built.plan, 'verify-application', 'verify-joomla', nativeVerifyCommand(profile), 'Verify Joomla configuration, database state, and the external marker')
  enhanceNativeModuleRestore(built.plan, state, linuxContext)
  built.plan.modifiedFiles.push(`${ARTIFACTS}/joomla.tar.gz`, `${state}/installer-argv.php`)
  built.verifyApplied = `${quote(profile.phpBinary)} -r ${quote(`require '${WEB_ROOT}/includes/defines.php';`)} >/dev/null 2>&1 && test -f ${quote(`${WEB_ROOT}/configuration.php`)} && curl --fail --silent --show-error --max-time 10 http://127.0.0.1:${PORT}/ | grep -Fq ${MARKER}`
  built.verifyReverted = `test ! -e ${quote(WEB_ROOT)} && test ! -e ${quote(ARTIFACTS)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)}`
}

function configureComposePlan (built, taskId, linuxContext) {
  const state = `/var/lib/webminai/task-state/${taskId}-joomla-compose`
  replaceCommand(built.plan, 'write-compose', composeCommand(), 'Write the pinned Joomla Compose application using file-backed secrets')
  replaceCommand(built.plan, 'pull-images', pullCommand(state), 'Pull and record the pinned Joomla PHP-FPM, nginx, and MariaDB images')
  replaceCommand(built.plan, 'start-compose', startCommand(), 'Start MariaDB, Joomla PHP-FPM, and nginx and wait through bounded readiness')
  renameCommand(built.plan, 'initialize-application', 'initialize-joomla', composeInitializeCommand(linuxContext), 'Install Joomla inside the container using protected credential-file indirection')
  replaceCommand(built.plan, 'verify-compose', composeVerifyCommand(linuxContext), 'Verify Compose health and the Joomla marker')
  built.plan.modifiedFiles.push(`${SERVICE_ROOT}/compose.yaml`, `${SERVICE_ROOT}/php-fpm.conf`, `${SERVICE_ROOT}/nginx.conf`)
  built.verifyApplied = `cd ${quote(SERVICE_ROOT)} && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq joomla && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq nginx && docker compose -p ${quote(PROJECT)} exec -T joomla test -S /run/php-fpm/webminai.sock && curl --fail --location --silent --show-error --max-time 10 http://127.0.0.1:${PORT}/ | grep -Fq ${MARKER}`
  built.verifyReverted = `test ! -e ${quote(SERVICE_ROOT)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)} && { ! command -v docker >/dev/null 2>&1 || ! docker ps -aq --filter label=com.docker.compose.project=${quote(PROJECT)} | grep -q .; }`
}

function applicationContract () {
  return { id: 'joomla', label: 'Joomla', project: PROJECT, port: PORT, webRoot: WEB_ROOT, artifacts: ARTIFACTS, credentials: CREDENTIALS, database: DATABASE, serviceRoot: SERVICE_ROOT, marker: MARKER, images: [JOOMLA_IMAGE, NGINX_IMAGE, DATABASE_IMAGE] }
}

function nativeBaselineCommand (foundation, state, linuxContext) {
  if (!requiresEl9Streams(linuxContext)) return foundation
  const suffix = "fi; printf '%s\n' baseline-ready"
  if (!foundation.endsWith(suffix)) throw new Error('Joomla foundation baseline hook is unavailable')
  return foundation.replace(suffix, [
    'php_stream=$(dnf -q module list php --enabled 2>/dev/null | awk \'$1 == "php" { print $2; exit }\')',
    'nginx_stream=$(dnf -q module list nginx --enabled 2>/dev/null | awk \'$1 == "nginx" { print $2; exit }\')',
    `printf '%s\\n' "$php_stream" > ${quote(`${state}/php-stream.before`)}`,
    `printf '%s\\n' "$nginx_stream" > ${quote(`${state}/nginx-stream.before`)}`,
    suffix
  ].join('; '))
}

function nativePackagesCommand (foundation, state, linuxContext, profile) {
  const requirements = `${quote(profile.phpBinary)} -r ${quote('exit(PHP_VERSION_ID >= 80100 ? 0 : 1);')}`
  const suffix = "printf '%s\n' packages-ready"
  if (!foundation.endsWith(suffix)) throw new Error('Joomla foundation package hook is unavailable')
  if (!requiresEl9Streams(linuxContext)) return foundation.replace(suffix, `${requirements}; ${suffix}`)
  const prepare = [
    `php_stream=$(sed -n 1p ${quote(`${state}/php-stream.before`)})`,
    `nginx_stream=$(sed -n 1p ${quote(`${state}/nginx-stream.before`)})`,
    '[ -z "$php_stream" ] || [ "$php_stream" = 8.3 ] || { printf \'%s\\n\' "unsupported pre-existing PHP module stream: $php_stream" >&2; exit 1; }',
    '[ -z "$nginx_stream" ] || [ "$nginx_stream" = 1.26 ] || { printf \'%s\\n\' "unsupported pre-existing nginx module stream: $nginx_stream" >&2; exit 1; }',
    `[ -n "$php_stream" ] || { dnf -y module enable php:8.3; : > ${quote(`${state}/php-stream.changed`)}; }`,
    `[ -n "$nginx_stream" ] || { dnf -y module enable nginx:1.26; : > ${quote(`${state}/nginx-stream.changed`)}; }`
  ].join('; ')
  return foundation.replace('set -eu; ', `set -eu; ${prepare}; `).replace(suffix, `${requirements}; ${suffix}`)
}

function enhanceNativeModuleRestore (plan, state, linuxContext) {
  if (!requiresEl9Streams(linuxContext)) return
  const restore = plan.revertCommands.find(item => item.id === 'restore-packages-services')
  const reset = `if [ -e ${quote(`${state}/php-stream.changed`)} ]; then dnf -y module reset php; fi; if [ -e ${quote(`${state}/nginx-stream.changed`)} ]; then dnf -y module reset nginx; fi`
  restore.command = restore.command.replace(`rm -rf -- ${quote(state)}`, `${reset}; rm -rf -- ${quote(state)}`)
}

function artifactCommand () {
  const archive = `${ARTIFACTS}/joomla.tar.gz`
  return [
    'set -eu',
    `install -d -o root -g root -m 0755 ${quote(ARTIFACTS)}`,
    `if [ -s ${quote(archive)} ] && printf '%s  %s\\n' ${quote(ARCHIVE_SHA256)} ${quote(archive)} | sha256sum -c - >/dev/null 2>&1; then printf '%s\\n' artifact-already-verified; exit 0; fi`,
    `curl --fail --location --silent --show-error --output ${quote(`${archive}.tmp`)} ${quote(ARCHIVE_URL)}`,
    `printf '%s  %s\\n' ${quote(ARCHIVE_SHA1)} ${quote(`${archive}.tmp`)} | sha1sum -c - >/dev/null`,
    `printf '%s  %s\\n' ${quote(ARCHIVE_SHA256)} ${quote(`${archive}.tmp`)} | sha256sum -c - >/dev/null`,
    `mv -f -- ${quote(`${archive}.tmp`)} ${quote(archive)}`,
    "printf '%s\\n' artifact-verified"
  ].join('; ')
}

function extractCommand (profile) {
  return [
    'set -eu',
    `if [ ! -f ${quote(`${WEB_ROOT}/installation/joomla.php`)} ] && [ ! -f ${quote(`${WEB_ROOT}/configuration.php`)} ]; then :`,
    `work=$(mktemp -d ${quote('/var/lib/webminai/joomla-extract.XXXXXX')})`,
    'trap \'rm -rf -- "$work"\' EXIT',
    'install -d -m 0755 "$work/joomla"',
    `tar -xzf ${quote(`${ARTIFACTS}/joomla.tar.gz`)} -C "$work/joomla"`,
    '[ -f "$work/joomla/installation/joomla.php" ]',
    `mv "$work/joomla" ${quote(WEB_ROOT)}`,
    `chown -R ${quote(`${profile.phpFpmUser}:${profile.phpFpmGroup}`)} ${quote(WEB_ROOT)}`,
    `find ${quote(WEB_ROOT)} -type d -exec chmod 0755 {} +`,
    `find ${quote(WEB_ROOT)} -type f -exec chmod 0644 {} +`,
    'trap - EXIT; rm -rf -- "$work"',
    'fi',
    "printf '%s\\n' files-ready"
  ].join('; ')
}

function installCommand (profile, state) {
  const bootstrap = `${state}/installer-argv.php`
  const php = installerBootstrapLines()
  return [
    'set -eu',
    `${quote(profile.phpBinary)} -r ${quote("$required=['dom','gd','json','mysqli','simplexml','zlib']; foreach ($required as $extension) { if (!extension_loaded($extension)) { fwrite(STDERR, $extension . PHP_EOL); exit(1); } }")}`,
    `if [ ! -f ${quote(`${WEB_ROOT}/configuration.php`)} ]; then :`,
    'bootstrap_candidate=$(mktemp)',
    `printf '%s\\n' ${php.map(quote).join(' ')} > "$bootstrap_candidate"`,
    `install -o root -g root -m 0600 "$bootstrap_candidate" ${quote(bootstrap)}`,
    'rm -f -- "$bootstrap_candidate"',
    `WEBMINAI_DB_PASS_FILE=${quote(`${CREDENTIALS}/db_password`)} WEBMINAI_ADMIN_PASSWORD_FILE=${quote(`${CREDENTIALS}/admin_password`)} ${quote(profile.phpBinary)} -d auto_prepend_file=${quote(bootstrap)} ${quote(`${WEB_ROOT}/installation/joomla.php`)} install --no-interaction --site-name=${quote(MARKER)} --admin-user=${quote('Intent AI Ops Administrator')} --admin-username=webminai_admin --admin-email=intentaiops@example.invalid --db-type=mysqli --db-host=${quote(profile.databaseHost)} --db-user=${quote(DATABASE)} --db-name=${quote(DATABASE)} --db-prefix=wmai_ --db-encryption=0 >/dev/null 2>&1`,
    'fi',
    `test -f ${quote(`${WEB_ROOT}/configuration.php`)}`,
    `test ! -d ${quote(`${WEB_ROOT}/installation`)}`,
    `chown ${quote(`${profile.phpFpmUser}:${profile.phpFpmGroup}`)} ${quote(`${WEB_ROOT}/configuration.php`)}`,
    `chmod 0640 ${quote(`${WEB_ROOT}/configuration.php`)}`,
    "printf '%s\\n' joomla-installed"
  ].join('; ')
}

function nativeVerifyCommand (profile) {
  return [
    'set -eu',
    `test -f ${quote(`${WEB_ROOT}/configuration.php`)}`,
    `mariadb --protocol=socket -uroot -Nse ${quote(`SELECT COUNT(*) FROM ${DATABASE}.wmai_users WHERE username='webminai_admin';`)} | grep -Fxq 1`,
    `address=$(${profile.primaryAddressCommand})`,
    '[ -n "$address" ]',
    `curl --fail --location --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 --max-time 10 "http://$address:${PORT}/" | grep -Fq ${MARKER}`,
    "printf '%s\\n' verification-passed"
  ].join('; ')
}

function composeCommand () {
  const lines = [
    'services:',
    '  db:',
    `    image: ${DATABASE_IMAGE}`,
    '    restart: unless-stopped',
    '    environment:',
    '      MARIADB_DATABASE: webminai_joomla',
    '      MARIADB_USER: webminai_joomla',
    '      MARIADB_PASSWORD_FILE: /run/secrets/db_password',
    '      MARIADB_ROOT_PASSWORD_FILE: /run/secrets/db_root_password',
    '    secrets:',
    '      - db_password',
    '      - db_root_password',
    '    volumes:',
    '      - db_data:/var/lib/mysql',
    '    healthcheck:',
    '      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]',
    '      interval: 5s',
    '      timeout: 5s',
    '      retries: 30',
    '  joomla:',
    `    image: ${JOOMLA_IMAGE}`,
    '    restart: unless-stopped',
    '    depends_on:',
    '      db:',
    '        condition: service_healthy',
    '    environment:',
    '      JOOMLA_DB_HOST: db:3306',
    '      JOOMLA_DB_NAME: webminai_joomla',
    '      JOOMLA_DB_USER: webminai_joomla',
    '      JOOMLA_DB_PASSWORD_FILE: /run/secrets/db_password',
    '    secrets:',
    '      - db_password',
    '      - admin_password',
    '    volumes:',
    '      - joomla_data:/var/www/html',
    '      - php_run:/run/php-fpm',
    '      - ./php-fpm.conf:/usr/local/etc/php-fpm.d/zz-webminai-socket.conf:ro',
    '      - ./installer-argv.php:/run/webminai/installer-argv.php:ro',
    '  nginx:',
    `    image: ${NGINX_IMAGE}`,
    '    restart: unless-stopped',
    '    depends_on:',
    '      - joomla',
    '    ports:',
    `      - "${PORT}:80"`,
    '    volumes:',
    '      - joomla_data:/var/www/html:ro',
    '      - php_run:/run/php-fpm',
    '      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro',
    'secrets:',
    '  db_password:',
    `    file: ${CREDENTIALS}/db_password`,
    '  db_root_password:',
    `    file: ${CREDENTIALS}/db_root_password`,
    '  admin_password:',
    `    file: ${CREDENTIALS}/admin_password`,
    'volumes:',
    '  db_data:',
    '  joomla_data:',
    '  php_run:'
  ]
  const bootstrap = installerBootstrapLines()
  const fpm = fpmSocketConfig()
  const nginx = nginxConfig()
  return `set -eu; install -d -o root -g root -m 0755 ${quote(SERVICE_ROOT)}; candidate=$(mktemp); printf '%s\\n' ${lines.map(quote).join(' ')} > "$candidate"; if ! cmp -s "$candidate" ${quote(`${SERVICE_ROOT}/compose.yaml`)}; then install -o root -g root -m 0644 "$candidate" ${quote(`${SERVICE_ROOT}/compose.yaml`)}; fi; rm -f -- "$candidate"; fpm_candidate=$(mktemp); printf '%s\\n' ${fpm.map(quote).join(' ')} > "$fpm_candidate"; install -o root -g root -m 0444 "$fpm_candidate" ${quote(`${SERVICE_ROOT}/php-fpm.conf`)}; rm -f -- "$fpm_candidate"; nginx_candidate=$(mktemp); printf '%s\\n' ${nginx.map(quote).join(' ')} > "$nginx_candidate"; install -o root -g root -m 0444 "$nginx_candidate" ${quote(`${SERVICE_ROOT}/nginx.conf`)}; rm -f -- "$nginx_candidate"; bootstrap_candidate=$(mktemp); printf '%s\\n' ${bootstrap.map(quote).join(' ')} > "$bootstrap_candidate"; if ! cmp -s "$bootstrap_candidate" ${quote(`${SERVICE_ROOT}/installer-argv.php`)}; then install -o root -g root -m 0444 "$bootstrap_candidate" ${quote(`${SERVICE_ROOT}/installer-argv.php`)}; fi; rm -f -- "$bootstrap_candidate"; grep -Fq ${quote(`file: ${CREDENTIALS}/admin_password`)} ${quote(`${SERVICE_ROOT}/compose.yaml`)}; grep -Fq 'fastcgi_pass unix:/run/php-fpm/webminai.sock' ${quote(`${SERVICE_ROOT}/nginx.conf`)}; ! grep -Eq '[0-9a-f]{32,}' ${quote(`${SERVICE_ROOT}/compose.yaml`)}; printf '%s\\n' compose-ready`
}

function pullCommand (state) {
  return `set -eu; cd ${quote(SERVICE_ROOT)}; docker compose -p ${quote(PROJECT)} pull; docker image inspect ${quote(JOOMLA_IMAGE)} --format '{{.Id}}' > ${quote(`${state}/image-0.after`)}; cp ${quote(`${state}/image-0.after`)} ${quote(`${state}/image-1.after`)}; docker image inspect ${quote(NGINX_IMAGE)} --format '{{.Id}}' > ${quote(`${state}/image-2.after`)}; docker image inspect ${quote(DATABASE_IMAGE)} --format '{{.Id}}' > ${quote(`${state}/image-3.after`)}; printf '%s\\n' images-pulled`
}

function startCommand () {
  return `set -eu; cd ${quote(SERVICE_ROOT)}; docker compose -p ${quote(PROJECT)} up -d db joomla nginx; ready=; for attempt in $(seq 1 60); do if docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq db && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq joomla && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq nginx && docker compose -p ${quote(PROJECT)} exec -T joomla test -S /run/php-fpm/webminai.sock && curl --fail --location --silent --show-error --max-time 3 http://127.0.0.1:${PORT}/ >/dev/null 2>&1; then ready=yes; break; fi; sleep 2; done; [ "$ready" = yes ]; printf '%s\\n' compose-started`
}

function composeInitializeCommand (linuxContext) {
  const addressCommand = linuxContext?.applications?.wordpress?.primaryAddressCommand ?? "ip -4 -o route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i == \"src\") {print $(i+1); exit}}'"
  const install = `WEBMINAI_DB_PASS_FILE=/run/secrets/db_password WEBMINAI_ADMIN_PASSWORD_FILE=/run/secrets/admin_password php -d auto_prepend_file=/run/webminai/installer-argv.php /var/www/html/installation/joomla.php install --no-interaction --site-name=${MARKER} --admin-user=${quote('Intent AI Ops Administrator')} --admin-username=webminai_admin --admin-email=intentaiops@example.invalid --db-type=mysqli --db-host=db --db-user=webminai_joomla --db-name=webminai_joomla --db-prefix=wmai_ --db-encryption=0`
  return `set -eu; cd ${quote(SERVICE_ROOT)}; if ! docker compose -p ${quote(PROJECT)} exec -T joomla test -f /var/www/html/configuration.php; then docker compose -p ${quote(PROJECT)} exec -T joomla /bin/sh -c ${quote(`${install} >/dev/null 2>&1`)}; fi; docker compose -p ${quote(PROJECT)} exec -T joomla test -f /var/www/html/configuration.php; address=$(${addressCommand}); [ -n "$address" ]; ready=; for attempt in $(seq 1 30); do if curl --fail --location --silent --show-error --max-time 3 "http://$address:${PORT}/" 2>/dev/null | grep -Fq ${MARKER}; then ready=yes; break; fi; sleep 2; done; [ "$ready" = yes ]; printf '%s\\n' joomla-installed`
}

function composeVerifyCommand (linuxContext) {
  const addressCommand = linuxContext?.applications?.wordpress?.primaryAddressCommand ?? "ip -4 -o route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i == \"src\") {print $(i+1); exit}}'"
  return `set -eu; cd ${quote(SERVICE_ROOT)}; docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq joomla; docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq nginx; docker compose -p ${quote(PROJECT)} exec -T joomla test -S /run/php-fpm/webminai.sock; docker compose -p ${quote(PROJECT)} exec -T joomla test -f /var/www/html/configuration.php; address=$(${addressCommand}); [ -n "$address" ]; curl --fail --location --silent --show-error --max-time 10 "http://$address:${PORT}/" | grep -Fq ${MARKER}; printf '%s\\n' verification-passed`
}

function fpmSocketConfig () {
  return ['[www]', 'listen = /run/php-fpm/webminai.sock', 'listen.owner = www-data', 'listen.group = www-data', 'listen.mode = 0666']
}

function nginxConfig () {
  return [
    'server {',
    '    listen 80;',
    '    root /var/www/html;',
    '    index index.php index.html;',
    '    location / { try_files $uri $uri/ /index.php?$args; }',
    '    location ~ \\.php$ {',
    '        include fastcgi_params;',
    '        fastcgi_pass unix:/run/php-fpm/webminai.sock;',
    '        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;',
    '    }',
    '    location ~ /\\. { deny all; }',
    '}'
  ]
}

function installerBootstrapLines () {
  return [
    '<?php',
    "$files = ['db-pass' => getenv('WEBMINAI_DB_PASS_FILE'), 'admin-password' => getenv('WEBMINAI_ADMIN_PASSWORD_FILE')];",
    'foreach ($files as $option => $path) {',
    "    if (!$path || !is_file($path)) { fwrite(STDERR, 'missing protected credential file' . PHP_EOL); exit(1); }",
    '    $value = trim((string) file_get_contents($path));',
    "    if ($value === '') { fwrite(STDERR, 'empty protected credential file' . PHP_EOL); exit(1); }",
    "    $_SERVER['argv'][] = '--' . $option . '=' . $value;",
    '}',
    "$_SERVER['argc'] = count($_SERVER['argv']);",
    "$GLOBALS['argv'] = $_SERVER['argv'];",
    "$GLOBALS['argc'] = $_SERVER['argc'];"
  ]
}

function compatibilityManifest (linuxContext, compose) {
  const identity = linuxContext.identity
  const selectedRoute = {
    id: compose ? 'joomla-compose' : 'joomla-native',
    kind: compose ? 'compose' : 'native',
    status: 'resolved',
    reason: compose
      ? 'the official pinned Joomla PHP 8.3 image and pinned MariaDB image satisfy the supported row'
      : requiresEl9Streams(linuxContext)
        ? 'reviewed PHP 8.3 and nginx 1.26 module streams resolve the EL9 repository defaults below Joomla minima'
        : 'the reviewed distribution PHP, nginx, and MariaDB profile satisfies Joomla 5.4 requirements',
    components: compose
      ? [
          { profileId: 'joomla', selectedVersion: VERSION, source: JOOMLA_IMAGE, status: 'supported' },
          { profileId: 'php-fpm', selectedVersion: '8.3', source: JOOMLA_IMAGE, status: 'supported' },
          { profileId: 'mariadb', selectedVersion: '11.8.8', source: DATABASE_IMAGE, status: 'supported' }
        ]
      : [
          { profileId: 'joomla', selectedVersion: VERSION, source: 'verified-official-archive', status: 'supported' },
          { profileId: 'php-fpm', selectedVersion: requiresEl9Streams(linuxContext) ? '8.3' : linuxContext.stackProfiles.profiles['php-fpm'].capabilities.profileVersion ?? 'runtime-preflight', source: 'reviewed-distro-profile', status: 'supported' },
          { profileId: 'nginx', selectedVersion: requiresEl9Streams(linuxContext) ? '1.26' : 'distribution-supported', source: 'reviewed-distro-profile', status: 'supported' },
          { profileId: 'mariadb', selectedVersion: 'distribution-supported', source: 'reviewed-distro-profile', status: 'supported' }
        ]
  }
  return {
    format: 'webminai-compatibility-manifest',
    version: 1,
    generatedAt: new Date().toISOString(),
    application: { id: 'joomla', version: VERSION },
    host: { fingerprint: linuxContext.fingerprint, distribution: identity.id, distributionVersion: identity.versionId, architecture: identity.architecture, family: linuxContext.management.family },
    status: 'resolved',
    selectedRoute,
    evaluatedRoutes: [selectedRoute],
    reason: selectedRoute.reason,
    officialRequirements: { php: '>=8.1.0', mariadb: '>=10.4.0', nginx: '>=1.21' },
    artifact: { url: ARCHIVE_URL, sha1: ARCHIVE_SHA1, sha256: ARCHIVE_SHA256 },
    sources: ['https://manual.joomla.org/docs/5.4/get-started/technical-requirements/', 'https://downloads.joomla.org/us/cms/joomla5/5-4-7', 'https://hub.docker.com/_/joomla']
  }
}

function requiresEl9Streams (linuxContext) {
  return linuxContext?.management?.family === 'rhel' && ['almalinux', 'rocky', 'ol'].includes(linuxContext?.identity?.id)
}

function replaceCommand (plan, id, commandText, purpose) {
  const item = plan.commands.find(command => command.id === id)
  if (!item) throw new Error(`Joomla foundation is missing ${id}`)
  item.command = commandText
  if (purpose) item.purpose = purpose
}

function renameCommand (plan, oldId, newId, commandText, purpose) {
  const item = plan.commands.find(command => command.id === oldId)
  if (!item) throw new Error(`Joomla foundation is missing ${oldId}`)
  item.id = newId
  item.command = commandText
  item.purpose = purpose
  for (const command of [...plan.commands, ...plan.revertCommands]) command.dependsOn = command.dependsOn.map(id => id === oldId ? newId : id)
}

function assignPhases (plan) {
  const phases = {
    'capture-baseline': 'baseline',
    'prepare-docker': 'packages',
    'install-packages': 'packages',
    'verify-artifacts': 'acquire',
    'pull-images': 'acquire',
    'generate-credentials': 'secrets',
    'prepare-database': 'database',
    'extract-joomla': 'configure',
    'configure-php-fpm': 'configure',
    'configure-nginx': 'configure',
    'write-compose': 'configure',
    'start-compose': 'services',
    'install-joomla': 'initialize',
    'initialize-joomla': 'initialize',
    'verify-joomla': 'verify',
    'verify-compose': 'verify'
  }
  for (const item of plan.commands) item.phase = phases[item.id] ?? 'verify'
  for (const item of plan.revertCommands) item.phase = 'cleanup'
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
