import { moodleRelease } from './moodle-task.js'
import { buildFreebsdMariaDbImageCommand } from './freebsd-wordpress-task.js'
import { buildFreebsdPhpRuntimeCommand, FREEBSD_PHP_IMAGE } from './freebsd-php-runtime.js'

const RELEASE = moodleRelease()
const DATABASE_IMAGE = 'localhost/webminai-freebsd-mariadb:11.8'
const SERVICE_ROOT = '/var/db/webminai/apps/moodle'
const BUILD_ROOT = '/var/db/webminai/image-builds/moodle'
const CREDENTIALS = '/root/moodle_credentials'
const PROJECT = 'webminai-moodle-18106'
const DATABASE = 'webminai_moodle'
const MARKER = 'WEBMINAI_MOODLE_OK'

export function buildFreebsdMoodleTask (taskId, freebsdExecution) {
  if (freebsdExecution?.platform !== 'freebsd') throw new Error('FreeBSD Moodle requires a FreeBSD execution inventory')
  if (!freebsdExecution.docker?.ready && !freebsdExecution.docker?.daemonReachable) throw new Error('FreeBSD Moodle requires the reviewed Podman Suite and podman-compose substrate')
  const state = `/var/lib/webminai/task-state/${taskId}-moodle-freebsd`
  return {
    plan: {
      summary: 'Deploy a learned reversible native FreeBSD Moodle site',
      changeOverview: `Reuse shared FreeBSD runtimes to deploy digest-verified Moodle ${RELEASE.version}, an off-web data volume, and recurring cron on port 18106.`,
      modifiedFiles: [state, BUILD_ROOT, SERVICE_ROOT, CREDENTIALS],
      assumptions: ['FreeBSD 15.1 amd64 with the reviewed Podman jail substrate', `Moodle ${RELEASE.version}, PHP 8.4, nginx, and MariaDB 11.8 satisfy the resolved runtime matrix`],
      warnings: ['nginx serves only Moodle public/; moodledata and credentials are never web-accessible.', 'The cron service has no published port and no host-device access.'],
      commands: [
        item('prepare-moodle', prepare(state), 'Prepare protected credentials, code, data, database, and build directories'),
        item('build-mariadb-runtime', buildFreebsdMariaDbImageCommand(BUILD_ROOT), 'Build the shared parameterized FreeBSD MariaDB runtime', ['prepare-moodle'], 1200000, 'job'),
        item('build-php-runtime', buildFreebsdPhpRuntimeCommand(BUILD_ROOT), 'Build the shared FreeBSD PHP 8.4 and nginx runtime', ['prepare-moodle'], 1200000, 'job'),
        item('acquire-moodle', acquire(), `Acquire and SHA-256 verify Moodle ${RELEASE.version}`, ['prepare-moodle'], 300000, 'job'),
        item('deploy-moodle', deploy(), 'Start the isolated runtime and install Moodle from protected credential files', ['build-mariadb-runtime', 'build-php-runtime', 'acquire-moodle'], 1800000, 'job'),
        item('verify-moodle', verify(), 'Verify public-root isolation, database state, cron, login, and restart persistence', ['deploy-moodle'], 600000, 'job')
      ],
      revertCommands: [item('remove-moodle', remove(state), 'Remove only task-owned Moodle containers, code, data, state, and credentials', [], 900000, 'job', 'destructive')]
    },
    verifyApplied: `response=$(mktemp); trap 'rm -f -- "$response"' EXIT; ${primaryAddress()}; curl --header "Host: $address:18106" --fail --silent --show-error --max-time 20 --output "$response" http://10.89.106.3/webminai-health.txt; grep -Fq ${MARKER} "$response"`,
    verifyReverted: `test ! -e ${quote(SERVICE_ROOT)} && test ! -e ${quote(state)}`,
    stateProbe: `test -e ${quote(state)} && printf applied || printf absent`
  }
}

function prepare (state) {
  return `set -eu; test "$(uname -s)" = FreeBSD; command -v podman >/dev/null; command -v podman-compose >/dev/null; podman info >/dev/null; install -d -m 0700 ${quote(state)} ${quote(BUILD_ROOT)}; install -d -m 0755 ${quote(SERVICE_ROOT)} ${quote(`${SERVICE_ROOT}/www`)} ${quote(`${SERVICE_ROOT}/db`)}; install -d -m 0770 ${quote(`${SERVICE_ROOT}/data`)}; if [ -e ${quote(CREDENTIALS)} ]; then : > ${quote(`${state}/credentials-preexisting`)}; else install -d -m 0700 ${quote(CREDENTIALS)}; fi; for name in db_root_password db_password admin_password; do if [ ! -s ${quote(CREDENTIALS)}/$name ]; then umask 077; openssl rand -hex 30 > ${quote(CREDENTIALS)}/$name; fi; done; chmod 0600 ${quote(CREDENTIALS)}/*`
}

function acquire () {
  return `set -eu; archive=${quote(`${SERVICE_ROOT}/moodle-${RELEASE.version}.tar.gz`)}; if [ ! -f "$archive" ] || [ "$(sha256 -q "$archive" 2>/dev/null || true)" != ${quote(RELEASE.sha256)} ]; then fetch -qo "$archive.tmp" ${quote(RELEASE.url)}; [ "$(sha256 -q "$archive.tmp")" = ${quote(RELEASE.sha256)} ]; mv -f -- "$archive.tmp" "$archive"; fi; if [ ! -f ${quote(`${SERVICE_ROOT}/www/public/version.php`)} ]; then work=$(mktemp -d); trap 'rm -rf -- "$work"' EXIT; tar -xzf "$archive" -C "$work"; test -f "$work/moodle-${RELEASE.commit}/admin/cli/install.php"; test -f "$work/moodle-${RELEASE.commit}/public/index.php"; find ${quote(`${SERVICE_ROOT}/www`)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; cp -a "$work/moodle-${RELEASE.commit}/." ${quote(`${SERVICE_ROOT}/www/`)}; rm -rf -- "$work"; trap - EXIT; fi; test -f ${quote(`${SERVICE_ROOT}/www/admin/cli/install.php`)}; test -f ${quote(`${SERVICE_ROOT}/www/public/index.php`)}; find ${quote(`${SERVICE_ROOT}/www`)} -type d -exec chmod 0755 {} +; find ${quote(`${SERVICE_ROOT}/www`)} -type f -exec chmod 0644 {} +`
}

function deploy () {
  return `set -eu; root=${quote(SERVICE_ROOT)}; cat > ${quote(`${CREDENTIALS}/installer-argv.php`)} <<'PHP'
<?php
$files = ['dbpass' => getenv('WEBMINAI_DB_PASS_FILE'), 'adminpass' => getenv('WEBMINAI_ADMIN_PASSWORD_FILE')];
foreach ($files as $option => $path) {
    if (!$path) { continue; }
    if (!is_file($path)) { fwrite(STDERR, 'missing protected credential file' . PHP_EOL); exit(1); }
    $value = trim((string) file_get_contents($path));
    if ($value === '') { fwrite(STDERR, 'empty protected credential file' . PHP_EOL); exit(1); }
    $argv[] = '--' . $option . '=' . $value;
}
$argc = count($argv);
$_SERVER['argv'] = $argv;
$_SERVER['argc'] = $argc;
$GLOBALS['argv'] = $argv;
$GLOBALS['argc'] = $argc;
PHP
chmod 0600 ${quote(`${CREDENTIALS}/installer-argv.php`)}; cat > "$root/php.ini" <<'CONF'
memory_limit = 512M
max_input_vars = 5000
zlib.output_compression = On
expose_php = Off
CONF
cat > "$root/nginx.conf" <<'CONF'
user root wheel;
worker_processes 1;
events { worker_connections 256; }
http { include /usr/local/etc/nginx/mime.types; client_max_body_size 64m; server { listen 80; root /srv/app/public; index index.php index.html; location / { try_files $uri $uri/ /r.php?$query_string; } location ~ \\.php$ { try_files $uri =404; include fastcgi_params; fastcgi_pass unix:/var/run/webminai/php-fpm.sock; fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name; fastcgi_read_timeout 300; } location ~ /\\. { deny all; } } }
CONF
chmod 0644 "$root/php.ini" "$root/nginx.conf"; podman network exists ${PROJECT} || podman network create --subnet 10.89.106.0/24 --gateway 10.89.106.1 ${PROJECT} >/dev/null; cat > "$root/compose.yml" <<'YAML'
services:
  db:
    image: ${DATABASE_IMAGE}
    restart: always
    environment: { WEBMINAI_DB_NAME: ${DATABASE}, WEBMINAI_DB_USER: ${DATABASE} }
    networks: { default: { ipv4_address: 10.89.106.2 } }
    volumes: [ '${SERVICE_ROOT}/db:/var/db/mysql', '${CREDENTIALS}:/run/secrets:ro' ]
  moodle:
    image: ${FREEBSD_PHP_IMAGE}
    restart: always
    depends_on: [ db ]
    networks: { default: { ipv4_address: 10.89.106.3 } }
    ports: [ '18106:80' ]
    volumes: [ '${SERVICE_ROOT}/www:/srv/app', '${SERVICE_ROOT}/data:/var/moodledata', '${CREDENTIALS}:/run/secrets:ro', '${SERVICE_ROOT}/php.ini:/usr/local/etc/php.ini:ro', '${SERVICE_ROOT}/nginx.conf:/usr/local/etc/nginx/nginx.conf:ro' ]
  cron:
    image: ${FREEBSD_PHP_IMAGE}
    restart: always
    depends_on: [ moodle ]
    entrypoint: [ '/bin/sh', '-c', 'while :; do if [ -f /srv/app/config.php ]; then php /srv/app/admin/cli/cron.php >/dev/null 2>&1 || true; fi; sleep 60; done' ]
    networks: { default: { ipv4_address: 10.89.106.4 } }
    volumes: [ '${SERVICE_ROOT}/www:/srv/app', '${SERVICE_ROOT}/data:/var/moodledata', '${SERVICE_ROOT}/php.ini:/usr/local/etc/php.ini:ro' ]
networks:
  default: { external: true, name: ${PROJECT} }
YAML
chmod 0600 "$root/compose.yml"; cd "$root"; podman-compose -p ${PROJECT} -f compose.yml down >/dev/null 2>&1 || true; podman-compose -p ${PROJECT} -f compose.yml up -d db moodle; database=; for attempt in $(jot 120); do podman exec ${PROJECT}_db_1 sh -c 'MYSQL_PWD=$(cat /run/secrets/db_root_password) mariadb -uroot -e "SELECT 1"' >/dev/null 2>&1 && { database=yes; break; }; sleep 2; done; [ "$database" = yes ]; if [ ! -f "$root/www/.webminai-installed" ]; then ${primaryAddress()}; if ! podman exec -e WEBMINAI_DB_PASS_FILE=/run/secrets/db_password -e WEBMINAI_ADMIN_PASSWORD_FILE=/run/secrets/admin_password ${PROJECT}_moodle_1 php -d memory_limit=512M -d max_input_vars=5000 -d auto_prepend_file=/run/secrets/installer-argv.php /srv/app/admin/cli/install.php --non-interactive --agree-license --lang=en --wwwroot="http://$address:18106" --dataroot=/var/moodledata --dbtype=mariadb --dbhost=10.89.106.2 --dbname=${DATABASE} --dbuser=${DATABASE} --prefix=wmai_ --fullname=${MARKER} --shortname=${MARKER} --adminuser=webminai_admin --adminemail=intentaiops@example.invalid >/dev/null 2>&1; then echo 'Moodle installer failed' >&2; exit 1; fi; printf '%s\n' installation-completed > "$root/www/.webminai-installed"; fi; test -f "$root/www/config.php"; chmod 0640 "$root/www/config.php"; podman exec ${PROJECT}_moodle_1 php /srv/app/admin/cli/cron.php >/dev/null 2>&1; printf '%s\n' cron-completed > "$root/data/.webminai-cron-ok"; printf '%s\n' ${MARKER} > "$root/www/public/webminai-health.txt"; chmod 0644 "$root/www/public/webminai-health.txt"; podman-compose -p ${PROJECT} -f compose.yml up -d cron; ready=; for attempt in $(jot 90); do podman ps --format '{{.Names}}' | grep -Fxq ${PROJECT}_cron_1 && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]`
}

function verify () {
  return `set -eu; root=${quote(SERVICE_ROOT)}; response=$(mktemp); trap 'rm -f -- "$response"' EXIT; test -f "$root/www/.webminai-installed"; test -f "$root/www/config.php"; test -f "$root/data/.webminai-cron-ok"; test ! -e "$root/www/moodledata"; podman exec ${PROJECT}_db_1 sh -c 'MYSQL_PWD=$(cat /run/secrets/db_root_password) mariadb -uroot -Nse "SELECT COUNT(*) FROM ${DATABASE}.wmai_user WHERE username=\\"webminai_admin\\""' | grep -Fxq 1; ${primaryAddress()}; verify_http() { curl --header "Host: $address:18106" --fail --silent --show-error --max-time 20 --output "$response" http://10.89.106.3/webminai-health.txt && grep -Fq ${MARKER} "$response" && curl --header "Host: $address:18106" --fail --silent --show-error --max-time 20 --output "$response" http://10.89.106.3/login/index.php && grep -Eiq '<!DOCTYPE html|<html' "$response"; }; verify_http; podman restart ${PROJECT}_db_1 ${PROJECT}_moodle_1 ${PROJECT}_cron_1 >/dev/null; ready=; for attempt in $(jot 90); do verify_http 2>/dev/null && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]`
}

function remove (state) {
  return `set -eu; if [ -f ${quote(`${SERVICE_ROOT}/compose.yml`)} ]; then cd ${quote(SERVICE_ROOT)}; podman-compose -p ${PROJECT} -f compose.yml down >/dev/null 2>&1 || true; fi; podman network rm ${PROJECT} >/dev/null 2>&1 || true; rm -rf -- ${quote(SERVICE_ROOT)} ${quote(BUILD_ROOT)}; if [ -d ${quote(state)} ] && [ ! -e ${quote(`${state}/credentials-preexisting`)} ]; then rm -rf -- ${quote(CREDENTIALS)}; fi; rm -rf -- ${quote(state)}`
}

function primaryAddress () {
  return 'interface=$(route -n get default | awk \'/interface:/{print $2; exit}\'); address=$(ifconfig "$interface" inet | awk \'/inet /{print $2; exit}\'); [ -n "$address" ]'
}

function item (id, command, purpose, dependsOn = [], timeoutMs = 300000, executionMode = null, risk = 'change') {
  return { id, command, purpose, risk, timeoutMs, requiresSudo: true, dependsOn, ...(executionMode ? { executionMode } : {}) }
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
