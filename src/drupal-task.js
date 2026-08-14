import { deploymentBlueprint, validateApplicationDeltaPlan } from './application-delta.js'
import { buildLinuxPhpApplicationFoundation, linuxPhpApplicationProfile } from './linux-php-foundation.js'

const VERSION = '11.4.4'
const ARCHIVE_URL = `https://ftp.drupal.org/files/projects/drupal-${VERSION}.tar.gz`
const ARCHIVE_SHA1 = '4f89fe6058f36ed907def628253cf9f567eb894e'
const ARCHIVE_SHA256 = 'c786e19dcf9e9129da23ece5f11cbc6dbac756aa1cc0ffe2e23b33cf74f9f619'
const DRUPAL_IMAGE = 'drupal:11.4.4-php8.4-fpm'
const NGINX_IMAGE = 'nginx:1.30.4-alpine'
const DATABASE_IMAGE = 'mariadb:11.8.8'
const PORT = 18104
const MARKER = 'WEBMINAI_DRUPAL_OK'
const SITE = 'webminai-drupal-18104'
const WEB_ROOT = `/srv/${SITE}`
const ARTIFACTS = `/var/lib/webminai/${SITE}`
const CREDENTIALS = '/root/drupal_credentials'
const DATABASE = 'webminai_drupal_18104'
const SERVICE_ROOT = '/opt/webminai/services/drupal'
const PROJECT = 'webminai-drupal-18104'

export function buildDrupalTask (taskId, linuxContext, docker = {}) {
  const compose = docker.preferred === true
  const built = buildLinuxPhpApplicationFoundation({ taskId, linuxContext, docker, application: applicationContract() })
  const manifest = compatibilityManifest(linuxContext, compose)

  if (compose) configureComposePlan(built, taskId, linuxContext)
  else configureNativePlan(built, taskId, linuxContext)

  assignPhases(built.plan)
  const deltaIds = ['extract-drupal', 'install-drupal', 'verify-drupal', 'write-compose', 'initialize-drupal']
  const deltaCommands = built.plan.commands.filter(item => deltaIds.includes(item.id))
  validateApplicationDeltaPlan({ commands: deltaCommands, revertCommands: [] })
  built.plan.summary = `Deploy a learned reversible ${compose ? 'Drupal Compose site' : 'native Drupal site'}`
  built.plan.changeOverview = `Compose the reviewed PHP/database foundation with digest-verified Drupal ${VERSION} on port ${PORT}.`
  built.plan.assumptions = [
    `Compatibility resolved from Drupal ${VERSION}'s official PHP and database support matrices before planning.`,
    compose
      ? 'The pinned official Drupal PHP 8.4 image and MariaDB 11.8 image satisfy the resolved row.'
      : 'The reviewed distro profile supplies PHP 8.3+, MariaDB 10.6+, and nginx; EL9 selects task-owned module streams when necessary.',
    'Administrator and database passwords are generated on-host and consumed only from protected files.'
  ]
  built.plan.warnings = [
    `This controlled test serves HTTP on isolated port ${PORT}.`,
    'The root-owned Drupal installer bootstrap receives only credential file paths and never prints their contents.'
  ]
  built.plan.compatibilityManifest = manifest
  built.plan.modifiedFiles = [...new Set(built.plan.modifiedFiles)]
  built.plan.applicationDelta = deploymentBlueprint({
    manifest,
    foundationPhases: [...new Set(built.plan.commands.filter(item => !deltaCommands.includes(item)).map(item => item.phase))],
    foundationPaths: built.plan.modifiedFiles.filter(path => !path.endsWith('/drupal.tar.gz'))
  })
  return built
}

export function drupalRelease () {
  return Object.freeze({ version: VERSION, url: ARCHIVE_URL, sha1: ARCHIVE_SHA1, sha256: ARCHIVE_SHA256, image: DRUPAL_IMAGE })
}

export function drupalComposeAssets () {
  return Object.freeze({
    installer: Object.freeze(installerLines()),
    reconciler: Object.freeze(reconcilerLines()),
    nginx: Object.freeze(nginxConfig()),
    phpFpm: Object.freeze(fpmSocketConfig())
  })
}

function configureNativePlan (built, taskId, linuxContext) {
  const profile = linuxPhpApplicationProfile(linuxContext, applicationContract())
  const state = `/var/lib/webminai/task-state/${taskId}-drupal-linux`
  replaceCommand(built.plan, 'capture-baseline', nativeBaselineCommand(built.plan.commands.find(item => item.id === 'capture-baseline').command, state, linuxContext))
  replaceCommand(built.plan, 'install-packages', nativePackagesCommand(built.plan.commands.find(item => item.id === 'install-packages').command, state, linuxContext, profile))
  replaceCommand(built.plan, 'verify-artifacts', artifactCommand(), 'Acquire and verify the exact official Drupal archive')
  renameCommand(built.plan, 'extract-application', 'extract-drupal', extractCommand(profile), 'Extract the verified Drupal release with reviewed ownership and permissions')
  renameCommand(built.plan, 'install-application', 'install-drupal', installCommand(profile, state), 'Install Drupal and initialize content using protected credential-file inputs')
  renameCommand(built.plan, 'verify-application', 'verify-drupal', nativeVerifyCommand(profile), 'Verify Drupal, clean URLs, database state, files permissions, cron, and the external marker')
  enhanceNativeModuleRestore(built.plan, state, linuxContext)
  built.plan.modifiedFiles.push(`${ARTIFACTS}/drupal.tar.gz`, `${state}/install-drupal.php`, `${state}/reconcile-drupal.php`)
  built.verifyApplied = `test -f ${quote(`${WEB_ROOT}/sites/default/.webminai-installed`)} && test -f ${quote(`${WEB_ROOT}/sites/default/settings.php`)} && test -f ${quote(`${WEB_ROOT}/sites/default/files/.webminai-cron-ok`)} && curl --fail --location --silent --show-error --max-time 10 http://127.0.0.1:${PORT}/ | grep -Fq ${MARKER}`
  built.verifyReverted = `test ! -e ${quote(WEB_ROOT)} && test ! -e ${quote(ARTIFACTS)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)}`
}

function configureComposePlan (built, taskId, linuxContext) {
  const state = `/var/lib/webminai/task-state/${taskId}-drupal-compose`
  replaceCommand(built.plan, 'write-compose', composeCommand(), 'Write the pinned Drupal Compose application using file-backed secrets')
  replaceCommand(built.plan, 'pull-images', pullCommand(state), 'Pull and record the pinned official Drupal PHP-FPM, nginx, and MariaDB images')
  replaceCommand(built.plan, 'start-compose', startCommand(), 'Start MariaDB, Drupal PHP-FPM, and nginx and wait for bounded HTTP readiness')
  renameCommand(built.plan, 'initialize-application', 'initialize-drupal', composeInitializeCommand(linuxContext), 'Install Drupal and reconcile marker content and cron inside the container')
  replaceCommand(built.plan, 'verify-compose', composeVerifyCommand(linuxContext), 'Verify Compose health, clean URLs, persistence, cron, and the Drupal marker')
  built.plan.modifiedFiles.push(`${SERVICE_ROOT}/compose.yaml`, `${SERVICE_ROOT}/php-fpm.conf`, `${SERVICE_ROOT}/nginx.conf`, `${SERVICE_ROOT}/install-drupal.php`, `${SERVICE_ROOT}/reconcile-drupal.php`)
  built.verifyApplied = `cd ${quote(SERVICE_ROOT)} && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq drupal && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq nginx && docker compose -p ${quote(PROJECT)} exec -T drupal test -S /run/php-fpm/webminai.sock && docker compose -p ${quote(PROJECT)} exec -T drupal test -f /var/www/html/sites/default/.webminai-installed && docker compose -p ${quote(PROJECT)} exec -T drupal test -f /var/www/html/sites/default/files/.webminai-cron-ok && curl --fail --location --silent --show-error --max-time 10 http://127.0.0.1:${PORT}/ | grep -Fq ${MARKER}`
  built.verifyReverted = `test ! -e ${quote(SERVICE_ROOT)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)} && { ! command -v docker >/dev/null 2>&1 || ! docker ps -aq --filter label=com.docker.compose.project=${quote(PROJECT)} | grep -q .; }`
}

function nativeBaselineCommand (foundation, state, linuxContext) {
  if (!requiresEl9Streams(linuxContext)) return foundation
  const suffix = "fi; printf '%s\n' baseline-ready"
  if (!foundation.endsWith(suffix)) throw new Error('Drupal foundation baseline hook is unavailable')
  return foundation.replace(suffix, [
    'mariadb_stream=$(dnf -q module list mariadb --enabled 2>/dev/null | awk \'$1 == "mariadb" { print $2; exit }\')',
    'php_stream=$(dnf -q module list php --enabled 2>/dev/null | awk \'$1 == "php" { print $2; exit }\')',
    `printf '%s\\n' "$mariadb_stream" > ${quote(`${state}/mariadb-stream.before`)}`,
    `printf '%s\\n' "$php_stream" > ${quote(`${state}/php-stream.before`)}`,
    suffix
  ].join('; '))
}

function nativePackagesCommand (foundation, state, linuxContext, profile) {
  const requirements = `${quote(profile.phpBinary)} -r ${quote('exit(PHP_VERSION_ID >= 80300 ? 0 : 1);')}`
  const suffix = "printf '%s\n' packages-ready"
  if (!foundation.endsWith(suffix)) throw new Error('Drupal foundation package hook is unavailable')
  if (!requiresEl9Streams(linuxContext)) {
    const command = linuxContext.management.family === 'alpine'
      ? foundation.replace('set -eu; ', 'set -eu; apk add --no-cache php83-pdo php83-pdo_mysql; ')
      : foundation
    return command.replace(suffix, `${requirements}; ${suffix}`)
  }
  const prepare = [
    `mariadb_stream=$(sed -n 1p ${quote(`${state}/mariadb-stream.before`)})`,
    `php_stream=$(sed -n 1p ${quote(`${state}/php-stream.before`)})`,
    '[ -z "$mariadb_stream" ] || [ "$mariadb_stream" = 10.11 ] || [ "$mariadb_stream" = 11.8 ] || { printf \'%s\\n\' "unsupported pre-existing MariaDB module stream: $mariadb_stream" >&2; exit 1; }',
    '[ -z "$php_stream" ] || [ "$php_stream" = 8.3 ] || { printf \'%s\\n\' "unsupported pre-existing PHP module stream: $php_stream" >&2; exit 1; }',
    `[ -n "$mariadb_stream" ] || { dnf -y module enable mariadb:10.11; : > ${quote(`${state}/mariadb-stream.changed`)}; }`,
    `[ -n "$php_stream" ] || { dnf -y module enable php:8.3; : > ${quote(`${state}/php-stream.changed`)}; }`
  ].join('; ')
  return foundation.replace('set -eu; ', `set -eu; ${prepare}; `).replace(suffix, `${requirements}; ${suffix}`)
}

function enhanceNativeModuleRestore (plan, state, linuxContext) {
  if (!requiresEl9Streams(linuxContext)) return
  const restore = plan.revertCommands.find(item => item.id === 'restore-packages-services')
  restore.command = restore.command.replace(`rm -rf -- ${quote(state)}`, `if [ -e ${quote(`${state}/mariadb-stream.changed`)} ]; then dnf -y module reset mariadb; fi; if [ -e ${quote(`${state}/php-stream.changed`)} ]; then dnf -y module reset php; fi; rm -rf -- ${quote(state)}`)
}

function artifactCommand () {
  const archive = `${ARTIFACTS}/drupal.tar.gz`
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
    `if [ ! -f ${quote(`${WEB_ROOT}/core/lib/Drupal.php`)} ]; then :`,
    `work=$(mktemp -d ${quote('/var/lib/webminai/drupal-extract.XXXXXX')})`,
    'trap \'rm -rf -- "$work"\' EXIT',
    `tar -xzf ${quote(`${ARTIFACTS}/drupal.tar.gz`)} -C "$work"`,
    `[ -f "$work/drupal-${VERSION}/core/lib/Drupal.php" ]`,
    `mv "$work/drupal-${VERSION}" ${quote(WEB_ROOT)}`,
    `chown -R ${quote(`${profile.phpFpmUser}:${profile.phpFpmGroup}`)} ${quote(WEB_ROOT)}`,
    `find ${quote(WEB_ROOT)} -type d -exec chmod 0755 {} +`,
    `find ${quote(WEB_ROOT)} -type f -exec chmod 0644 {} +`,
    'trap - EXIT; rm -rf -- "$work"',
    'fi',
    "printf '%s\\n' files-ready"
  ].join('; ')
}

function installCommand (profile, state) {
  const installer = `${state}/install-drupal.php`
  const reconciler = `${state}/reconcile-drupal.php`
  return [
    'set -eu',
    `${quote(profile.phpBinary)} -r ${quote("$required=['curl','dom','filter','gd','hash','json','mbstring','openssl','pdo','pdo_mysql','session','simplexml','tokenizer','xml']; foreach ($required as $extension) { if (!extension_loaded($extension)) { fwrite(STDERR, $extension . PHP_EOL); exit(1); } }")}`,
    `install_candidate=$(mktemp); printf '%s\\n' ${installerLines().map(quote).join(' ')} > "$install_candidate"`,
    `install -o root -g root -m 0600 "$install_candidate" ${quote(installer)}`,
    'rm -f -- "$install_candidate"',
    `reconcile_candidate=$(mktemp); printf '%s\\n' ${reconcilerLines().map(quote).join(' ')} > "$reconcile_candidate"`,
    `install -o root -g root -m 0600 "$reconcile_candidate" ${quote(reconciler)}`,
    'rm -f -- "$reconcile_candidate"',
    `WEBMINAI_DRUPAL_ROOT=${quote(WEB_ROOT)} WEBMINAI_DB_HOST=${quote(profile.databaseHost)} WEBMINAI_DB_NAME=${quote(DATABASE)} WEBMINAI_DB_USER=${quote(DATABASE)} WEBMINAI_DB_PASS_FILE=${quote(`${CREDENTIALS}/db_password`)} WEBMINAI_ADMIN_PASS_FILE=${quote(`${CREDENTIALS}/admin_password`)} ${quote(profile.phpBinary)} ${quote(installer)} >/dev/null 2>&1`,
    `WEBMINAI_DRUPAL_ROOT=${quote(WEB_ROOT)} WEBMINAI_DRUPAL_URL=${quote(`http://127.0.0.1:${PORT}/`)} ${quote(profile.phpBinary)} ${quote(reconciler)} >/dev/null 2>&1`,
    `test -f ${quote(`${WEB_ROOT}/sites/default/.webminai-installed`)}`,
    `test -f ${quote(`${WEB_ROOT}/sites/default/settings.php`)}`,
    `test -f ${quote(`${WEB_ROOT}/sites/default/files/.webminai-cron-ok`)}`,
    `chown -R ${quote(`${profile.phpFpmUser}:${profile.phpFpmGroup}`)} ${quote(`${WEB_ROOT}/sites/default`)}`,
    `find ${quote(`${WEB_ROOT}/sites/default/files`)} -type d -exec chmod 0755 {} +`,
    `find ${quote(`${WEB_ROOT}/sites/default/files`)} -type f -exec chmod 0644 {} +`,
    `chmod 0555 ${quote(`${WEB_ROOT}/sites/default`)}`,
    `chmod 0440 ${quote(`${WEB_ROOT}/sites/default/settings.php`)}`,
    "printf '%s\\n' drupal-installed"
  ].join('; ')
}

function nativeVerifyCommand (profile) {
  return [
    'set -eu',
    `test -f ${quote(`${WEB_ROOT}/sites/default/.webminai-installed`)}`,
    `test -f ${quote(`${WEB_ROOT}/sites/default/settings.php`)}`,
    `test -f ${quote(`${WEB_ROOT}/sites/default/files/.webminai-cron-ok`)}`,
    `test "$(stat -c %a ${quote(`${WEB_ROOT}/sites/default/settings.php`)})" = 440`,
    `mariadb --protocol=socket -uroot -Nse ${quote(`SELECT COUNT(*) FROM ${DATABASE}.users_field_data WHERE name='webminai_admin';`)} | grep -Fxq 1`,
    `address=$(${profile.primaryAddressCommand})`,
    '[ -n "$address" ]',
    `curl --fail --location --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 --max-time 10 "http://$address:${PORT}/" | grep -Fq ${MARKER}`,
    `curl --fail --location --silent --show-error --max-time 10 "http://$address:${PORT}/user/login" | grep -Fq 'form_id'`,
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
    '      MARIADB_DATABASE: webminai_drupal_18104',
    '      MARIADB_USER: webminai_drupal_18104',
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
    '  drupal:',
    `    image: ${DRUPAL_IMAGE}`,
    '    restart: unless-stopped',
    '    depends_on:',
    '      db:',
    '        condition: service_healthy',
    '    secrets:',
    '      - db_password',
    '      - admin_password',
    '    volumes:',
    '      - drupal_data:/var/www/html',
    '      - php_run:/run/php-fpm',
    '      - ./php-fpm.conf:/usr/local/etc/php-fpm.d/zz-webminai-socket.conf:ro',
    '      - ./:/run/webminai:ro',
    '  nginx:',
    `    image: ${NGINX_IMAGE}`,
    '    restart: unless-stopped',
    '    depends_on:',
    '      - drupal',
    '    ports:',
    `      - "${PORT}:80"`,
    '    volumes:',
    '      - drupal_data:/var/www/html:ro',
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
    '  drupal_data:',
    '  php_run:'
  ]
  return [
    'set -eu',
    `install -d -o root -g root -m 0755 ${quote(SERVICE_ROOT)}`,
    `candidate=$(mktemp); printf '%s\\n' ${lines.map(quote).join(' ')} > "$candidate"`,
    `if ! cmp -s "$candidate" ${quote(`${SERVICE_ROOT}/compose.yaml`)}; then install -o root -g root -m 0644 "$candidate" ${quote(`${SERVICE_ROOT}/compose.yaml`)}; fi`,
    'rm -f -- "$candidate"',
    `fpm_candidate=$(mktemp); printf '%s\\n' ${fpmSocketConfig().map(quote).join(' ')} > "$fpm_candidate"`,
    `install -o root -g root -m 0444 "$fpm_candidate" ${quote(`${SERVICE_ROOT}/php-fpm.conf`)}`,
    'rm -f -- "$fpm_candidate"',
    `nginx_candidate=$(mktemp); printf '%s\\n' ${nginxConfig().map(quote).join(' ')} > "$nginx_candidate"`,
    `install -o root -g root -m 0444 "$nginx_candidate" ${quote(`${SERVICE_ROOT}/nginx.conf`)}`,
    'rm -f -- "$nginx_candidate"',
    `install_candidate=$(mktemp); printf '%s\\n' ${installerLines().map(quote).join(' ')} > "$install_candidate"`,
    `if ! cmp -s "$install_candidate" ${quote(`${SERVICE_ROOT}/install-drupal.php`)}; then install -o root -g root -m 0444 "$install_candidate" ${quote(`${SERVICE_ROOT}/install-drupal.php`)}; fi`,
    'rm -f -- "$install_candidate"',
    `reconcile_candidate=$(mktemp); printf '%s\\n' ${reconcilerLines().map(quote).join(' ')} > "$reconcile_candidate"`,
    `if ! cmp -s "$reconcile_candidate" ${quote(`${SERVICE_ROOT}/reconcile-drupal.php`)}; then install -o root -g root -m 0444 "$reconcile_candidate" ${quote(`${SERVICE_ROOT}/reconcile-drupal.php`)}; fi`,
    'rm -f -- "$reconcile_candidate"',
    `grep -Fq ${quote(`file: ${CREDENTIALS}/admin_password`)} ${quote(`${SERVICE_ROOT}/compose.yaml`)}`,
    `grep -Fq 'fastcgi_pass unix:/run/php-fpm/webminai.sock' ${quote(`${SERVICE_ROOT}/nginx.conf`)}`,
    `! grep -Eq '[0-9a-f]{32,}' ${quote(`${SERVICE_ROOT}/compose.yaml`)}`,
    "printf '%s\\n' compose-ready"
  ].join('; ')
}

function pullCommand (state) {
  return `set -eu; cd ${quote(SERVICE_ROOT)}; docker compose -p ${quote(PROJECT)} pull; docker image inspect ${quote(DRUPAL_IMAGE)} --format '{{.Id}}' > ${quote(`${state}/image-0.after`)}; cp ${quote(`${state}/image-0.after`)} ${quote(`${state}/image-1.after`)}; docker image inspect ${quote(NGINX_IMAGE)} --format '{{.Id}}' > ${quote(`${state}/image-2.after`)}; docker image inspect ${quote(DATABASE_IMAGE)} --format '{{.Id}}' > ${quote(`${state}/image-3.after`)}; printf '%s\\n' images-pulled`
}

function startCommand () {
  return `set -eu; cd ${quote(SERVICE_ROOT)}; docker compose -p ${quote(PROJECT)} up -d db drupal nginx; ready=; for attempt in $(seq 1 60); do if docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq db && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq drupal && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq nginx && docker compose -p ${quote(PROJECT)} exec -T drupal test -S /run/php-fpm/webminai.sock && curl --fail --location --silent --show-error --max-time 3 http://127.0.0.1:${PORT}/ >/dev/null 2>&1; then ready=yes; break; fi; sleep 2; done; [ "$ready" = yes ]; printf '%s\\n' compose-started`
}

function composeInitializeCommand (linuxContext) {
  const addressCommand = linuxContext?.applications?.wordpress?.primaryAddressCommand ?? "ip -4 -o route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i == \"src\") {print $(i+1); exit}}'"
  return [
    'set -eu',
    `cd ${quote(SERVICE_ROOT)}`,
    `if ! docker compose -p ${quote(PROJECT)} exec -T drupal test -f /var/www/html/sites/default/.webminai-installed; then docker compose -p ${quote(PROJECT)} exec -T drupal /bin/sh -c ${quote('WEBMINAI_DRUPAL_ROOT=/var/www/html WEBMINAI_DB_HOST=db WEBMINAI_DB_NAME=webminai_drupal_18104 WEBMINAI_DB_USER=webminai_drupal_18104 WEBMINAI_DB_PASS_FILE=/run/secrets/db_password WEBMINAI_ADMIN_PASS_FILE=/run/secrets/admin_password php /run/webminai/install-drupal.php >/dev/null 2>&1')}; fi`,
    `docker compose -p ${quote(PROJECT)} exec -T drupal /bin/sh -c ${quote(`WEBMINAI_DRUPAL_ROOT=/var/www/html WEBMINAI_DRUPAL_URL=http://127.0.0.1:${PORT}/ php /run/webminai/reconcile-drupal.php >/dev/null 2>&1`)}`,
    `docker compose -p ${quote(PROJECT)} exec -T drupal test -f /var/www/html/sites/default/files/.webminai-cron-ok`,
    `address=$(${addressCommand})`,
    '[ -n "$address" ]',
    `ready=; for attempt in $(seq 1 30); do if curl --fail --location --silent --show-error --max-time 3 "http://$address:${PORT}/" 2>/dev/null | grep -Fq ${MARKER}; then ready=yes; break; fi; sleep 2; done`,
    '[ "$ready" = yes ]',
    "printf '%s\\n' drupal-installed"
  ].join('; ')
}

function composeVerifyCommand (linuxContext) {
  const addressCommand = linuxContext?.applications?.wordpress?.primaryAddressCommand ?? "ip -4 -o route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i == \"src\") {print $(i+1); exit}}'"
  return `set -eu; cd ${quote(SERVICE_ROOT)}; docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq drupal; docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq nginx; docker compose -p ${quote(PROJECT)} exec -T drupal test -S /run/php-fpm/webminai.sock; docker compose -p ${quote(PROJECT)} exec -T drupal test -f /var/www/html/sites/default/.webminai-installed; docker compose -p ${quote(PROJECT)} exec -T drupal test -f /var/www/html/sites/default/settings.php; docker compose -p ${quote(PROJECT)} exec -T drupal test -f /var/www/html/sites/default/files/.webminai-cron-ok; address=$(${addressCommand}); [ -n "$address" ]; curl --fail --location --silent --show-error --max-time 10 "http://$address:${PORT}/" | grep -Fq ${MARKER}; curl --fail --location --silent --show-error --max-time 10 "http://$address:${PORT}/user/login" | grep -Fq form_id; printf '%s\\n' verification-passed`
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

function installerLines () {
  return [
    '<?php',
    'declare(strict_types=1);',
    "$root = getenv('WEBMINAI_DRUPAL_ROOT');",
    "$required = ['WEBMINAI_DB_HOST', 'WEBMINAI_DB_NAME', 'WEBMINAI_DB_USER', 'WEBMINAI_DB_PASS_FILE', 'WEBMINAI_ADMIN_PASS_FILE'];",
    "if (!$root || !is_file($root . '/autoload.php')) { fwrite(STDERR, 'invalid Drupal root' . PHP_EOL); exit(1); }",
    '$values = [];',
    'foreach ($required as $name) {',
    '    $value = getenv($name);',
    "    if ($value === false || $value === '') { fwrite(STDERR, 'missing installer input' . PHP_EOL); exit(1); }",
    '    $values[$name] = $value;',
    '}',
    "foreach (['WEBMINAI_DB_PASS_FILE', 'WEBMINAI_ADMIN_PASS_FILE'] as $name) {",
    "    if (!is_file($values[$name])) { fwrite(STDERR, 'missing protected credential file' . PHP_EOL); exit(1); }",
    '}',
    "if (is_file($root . '/sites/default/.webminai-installed')) { exit(0); }",
    "if (is_file($root . '/sites/default/settings.php')) { unlink($root . '/sites/default/settings.php'); }",
    'chdir($root);',
    "define('MAINTENANCE_MODE', 'install');",
    "$classLoader = require $root . '/autoload.php';",
    "require_once $root . '/core/includes/install.core.inc';",
    "$site = $root . '/sites/default';",
    "if (!is_dir($site . '/files') && !mkdir($site . '/files', 0775, true)) { throw new RuntimeException('cannot create Drupal files directory'); }",
    "if (!is_file($site . '/settings.php') && !copy($site . '/default.settings.php', $site . '/settings.php')) { throw new RuntimeException('cannot create Drupal settings'); }",
    'chmod($site, 0775);',
    "chmod($site . '/files', 0775);",
    "chmod($site . '/settings.php', 0664);",
    "$driver = 'Drupal\\mysql\\Driver\\Database\\mysql';",
    '$parameters = [',
    "    'interactive' => false,",
    "    'parameters' => ['profile' => 'standard', 'langcode' => 'en'],",
    "    'forms' => [",
    "        'install_settings_form' => [",
    "            'driver' => $driver,",
    '            $driver => [',
    "                'database' => $values['WEBMINAI_DB_NAME'],",
    "                'username' => $values['WEBMINAI_DB_USER'],",
    "                'password' => trim((string) file_get_contents($values['WEBMINAI_DB_PASS_FILE'])),",
    "                'host' => $values['WEBMINAI_DB_HOST'],",
    "                'port' => '3306',",
    "                'prefix' => '',",
    '            ],',
    '        ],',
    "        'install_configure_form' => [",
    `            'site_name' => '${MARKER}',`,
    "            'site_mail' => 'intentaiops@example.invalid',",
    "            'account' => [",
    "                'name' => 'webminai_admin',",
    "                'mail' => 'intentaiops@example.invalid',",
    "                'pass' => [",
    "                    'pass1' => trim((string) file_get_contents($values['WEBMINAI_ADMIN_PASS_FILE'])),",
    "                    'pass2' => trim((string) file_get_contents($values['WEBMINAI_ADMIN_PASS_FILE'])),",
    '                ],',
    '            ],',
    "            'enable_update_status_module' => null,",
    "            'enable_update_status_emails' => null,",
    '        ],',
    '    ],',
    '];',
    'install_drupal($classLoader, $parameters);',
    "file_put_contents($root . '/sites/default/.webminai-installed', 'installation-completed' . PHP_EOL, LOCK_EX);"
  ]
}

function reconcilerLines () {
  return [
    '<?php',
    'declare(strict_types=1);',
    'use Drupal\\Core\\DrupalKernel;',
    'use Symfony\\Component\\HttpFoundation\\Request;',
    "$root = getenv('WEBMINAI_DRUPAL_ROOT');",
    "$url = getenv('WEBMINAI_DRUPAL_URL') ?: 'http://127.0.0.1/';",
    "if (!$root || !is_file($root . '/sites/default/settings.php')) { fwrite(STDERR, 'Drupal is not installed' . PHP_EOL); exit(1); }",
    'chdir($root);',
    "require_once $root . '/core/includes/common.inc';",
    "$classLoader = require $root . '/autoload.php';",
    '$request = Request::create($url);',
    "$kernel = DrupalKernel::createFromRequest($request, $classLoader, 'prod');",
    '$kernel->boot();',
    '$kernel->preHandle($request);',
    '$container = $kernel->getContainer();',
    `$container->get('config.factory')->getEditable('system.site')->set('name', '${MARKER}')->save();`,
    "$cron = $container->get('cron')->run();",
    "if (!$cron) { fwrite(STDERR, 'Drupal cron did not complete' . PHP_EOL); exit(1); }",
    "$marker = $root . '/sites/default/files/.webminai-cron-ok';",
    "if (!is_file($marker)) { file_put_contents($marker, 'cron-completed' . PHP_EOL, LOCK_EX); }",
    '$kernel->shutdown();'
  ]
}

function compatibilityManifest (linuxContext, compose) {
  const identity = linuxContext.identity
  const selectedRoute = {
    id: compose ? 'drupal-compose' : 'drupal-native',
    kind: compose ? 'compose' : 'native',
    status: 'resolved',
    reason: compose
      ? 'the official pinned Drupal PHP 8.4 image and pinned MariaDB image satisfy the supported row'
      : requiresEl9Streams(linuxContext)
        ? 'reviewed PHP 8.3, nginx 1.26, and MariaDB 10.11 module streams resolve the EL9 repository defaults below Drupal minima'
        : 'the reviewed distribution PHP, nginx, and MariaDB profile satisfies Drupal 11 requirements',
    components: compose
      ? [
          { profileId: 'drupal', selectedVersion: VERSION, source: DRUPAL_IMAGE, status: 'supported' },
          { profileId: 'php-fpm', selectedVersion: '8.4', source: DRUPAL_IMAGE, status: 'supported' },
          { profileId: 'mariadb', selectedVersion: '11.8.8', source: DATABASE_IMAGE, status: 'supported' }
        ]
      : [
          { profileId: 'drupal', selectedVersion: VERSION, source: 'verified-official-archive', status: 'supported' },
          { profileId: 'php-fpm', selectedVersion: requiresEl9Streams(linuxContext) ? '8.3' : linuxContext.stackProfiles.profiles['php-fpm'].capabilities.profileVersion ?? 'runtime-preflight', source: 'reviewed-distro-profile', status: 'supported' },
          { profileId: 'nginx', selectedVersion: requiresEl9Streams(linuxContext) ? '1.26' : 'distribution-supported', source: 'reviewed-distro-profile', status: 'supported' },
          { profileId: 'mariadb', selectedVersion: requiresEl9Streams(linuxContext) ? '10.11' : 'distribution-supported', source: 'reviewed-distro-profile', status: 'supported' }
        ]
  }
  return {
    format: 'webminai-compatibility-manifest',
    version: 1,
    generatedAt: new Date().toISOString(),
    application: { id: 'drupal', version: VERSION },
    host: { fingerprint: linuxContext.fingerprint, distribution: identity.id, distributionVersion: identity.versionId, architecture: identity.architecture, family: linuxContext.management.family },
    status: 'resolved',
    selectedRoute,
    evaluatedRoutes: [selectedRoute],
    reason: selectedRoute.reason,
    officialRequirements: { php: '>=8.3.0', mariadb: '>=10.6.0' },
    artifact: { url: ARCHIVE_URL, sha1: ARCHIVE_SHA1, sha256: ARCHIVE_SHA256 },
    sources: ['https://www.drupal.org/project/drupal/releases/11.4.4', 'https://www.drupal.org/docs/getting-started/system-requirements/php-requirements', 'https://www.drupal.org/docs/getting-started/system-requirements/database-server-requirements', 'https://hub.docker.com/_/drupal']
  }
}

function applicationContract () {
  return { id: 'drupal', label: 'Drupal', project: PROJECT, port: PORT, webRoot: WEB_ROOT, artifacts: ARTIFACTS, credentials: CREDENTIALS, database: DATABASE, serviceRoot: SERVICE_ROOT, marker: MARKER, images: [DRUPAL_IMAGE, NGINX_IMAGE, DATABASE_IMAGE] }
}

function requiresEl9Streams (linuxContext) {
  return linuxContext?.management?.family === 'rhel' && ['almalinux', 'rocky', 'ol'].includes(linuxContext?.identity?.id)
}

function replaceCommand (plan, id, commandText, purpose) {
  const item = plan.commands.find(command => command.id === id)
  if (!item) throw new Error(`Drupal foundation is missing ${id}`)
  item.command = commandText
  if (purpose) item.purpose = purpose
}

function renameCommand (plan, oldId, newId, commandText, purpose) {
  const item = plan.commands.find(command => command.id === oldId)
  if (!item) throw new Error(`Drupal foundation is missing ${oldId}`)
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
    'extract-drupal': 'configure',
    'configure-php-fpm': 'configure',
    'configure-nginx': 'configure',
    'write-compose': 'configure',
    'start-compose': 'services',
    'install-drupal': 'initialize',
    'initialize-drupal': 'initialize',
    'verify-drupal': 'verify',
    'verify-compose': 'verify'
  }
  for (const item of plan.commands) item.phase = phases[item.id] ?? 'verify'
  for (const item of plan.revertCommands) item.phase = 'cleanup'
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
