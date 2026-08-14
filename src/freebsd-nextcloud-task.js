import { buildFreebsdMariaDbImageCommand } from './freebsd-wordpress-task.js'
import { buildFreebsdPhpRuntimeCommand, FREEBSD_PHP_IMAGE } from './freebsd-php-runtime.js'

const RELEASE = Object.freeze({
  version: '33.0.7',
  url: 'https://download.nextcloud.com/server/releases/nextcloud-33.0.7.tar.bz2',
  sha256: 'bae1a82fcbbf4d69994d2d58d4e815166fbf4fed5ad3a55121f38ce07ede9913'
})
const DATABASE_IMAGE = 'localhost/webminai-freebsd-mariadb:11.8'
const SERVICE_ROOT = '/var/db/webminai/apps/nextcloud'
const BUILD_ROOT = '/var/db/webminai/image-builds/nextcloud'
const CREDENTIALS = '/root/nextcloud_credentials'
const PROJECT = 'webminai-nextcloud-18107'
const DATABASE = 'webminai_nextcloud'
const MARKER = 'WEBMINAI_NEXTCLOUD_OK'

export function buildFreebsdNextcloudTask (taskId, freebsdExecution) {
  if (freebsdExecution?.platform !== 'freebsd') throw new Error('FreeBSD Nextcloud requires a FreeBSD execution inventory')
  if (!freebsdExecution.docker?.ready && !freebsdExecution.docker?.daemonReachable) throw new Error('FreeBSD Nextcloud requires the reviewed Podman Suite and podman-compose substrate')
  const state = `/var/lib/webminai/task-state/${taskId}-nextcloud-freebsd`
  return {
    plan: {
      summary: 'Deploy a learned reversible native FreeBSD Nextcloud instance',
      changeOverview: `Reuse shared FreeBSD runtimes to deploy digest-verified Nextcloud ${RELEASE.version}, isolated storage, trusted-domain configuration, and recurring background jobs on port 18107.`,
      modifiedFiles: [state, BUILD_ROOT, SERVICE_ROOT, CREDENTIALS],
      assumptions: ['FreeBSD 15.1 amd64 with the reviewed Podman jail substrate', `Nextcloud ${RELEASE.version}, PHP 8.4, nginx, and MariaDB 11.8 satisfy the resolved runtime matrix`],
      warnings: ['Application data and credentials remain outside the web root.', 'Only the selected external test address is added as a trusted domain.'],
      commands: [
        item('prepare-nextcloud', prepare(state), 'Prepare protected credentials, application, data, database, and build directories'),
        item('build-mariadb-runtime', buildFreebsdMariaDbImageCommand(BUILD_ROOT), 'Build the shared parameterized FreeBSD MariaDB runtime', ['prepare-nextcloud'], 1200000, 'job'),
        item('build-php-runtime', buildFreebsdPhpRuntimeCommand(BUILD_ROOT), 'Build the shared FreeBSD PHP 8.4 and nginx runtime', ['prepare-nextcloud'], 1200000, 'job'),
        item('acquire-nextcloud', acquire(), `Acquire and SHA-256 verify Nextcloud ${RELEASE.version}`, ['prepare-nextcloud'], 600000, 'job'),
        item('deploy-nextcloud', deploy(), 'Start the isolated runtime and initialize Nextcloud from protected credential files', ['build-mariadb-runtime', 'build-php-runtime', 'acquire-nextcloud'], 1800000, 'job'),
        item('verify-nextcloud', verify(), 'Verify status, ownership marker, database, data, cron, trusted domain, and restart persistence', ['deploy-nextcloud'], 600000, 'job')
      ],
      revertCommands: [item('remove-nextcloud', remove(state), 'Remove only task-owned Nextcloud containers, code, data, state, and credentials', [], 900000, 'job', 'destructive')]
    },
    verifyApplied: `response=$(mktemp); trap 'rm -f -- "$response"' EXIT; ${primaryAddress()}; curl --header "Host: $address:18107" --fail --silent --show-error --max-time 20 --output "$response" http://10.89.107.3/status.php; grep -Eq '"installed"[[:space:]]*:[[:space:]]*true' "$response"; curl --header "Host: $address:18107" --fail --silent --show-error --max-time 20 --output "$response" http://10.89.107.3/webminai-health.txt; grep -Fq ${MARKER} "$response"`,
    verifyReverted: `test ! -e ${quote(SERVICE_ROOT)} && test ! -e ${quote(state)}`,
    stateProbe: `test -e ${quote(state)} && printf applied || printf absent`
  }
}

function prepare (state) {
  return `set -eu; test "$(uname -s)" = FreeBSD; command -v podman >/dev/null; command -v podman-compose >/dev/null; podman info >/dev/null; install -d -m 0700 ${quote(state)} ${quote(BUILD_ROOT)}; install -d -m 0755 ${quote(SERVICE_ROOT)} ${quote(`${SERVICE_ROOT}/www`)} ${quote(`${SERVICE_ROOT}/db`)}; install -d -m 0770 ${quote(`${SERVICE_ROOT}/data`)}; if [ -e ${quote(CREDENTIALS)} ]; then : > ${quote(`${state}/credentials-preexisting`)}; else install -d -m 0700 ${quote(CREDENTIALS)}; fi; for name in db_root_password db_password admin_password; do if [ ! -s ${quote(CREDENTIALS)}/$name ]; then umask 077; openssl rand -hex 30 > ${quote(CREDENTIALS)}/$name; fi; done; chmod 0600 ${quote(CREDENTIALS)}/*`
}

function acquire () {
  return `set -eu; archive=${quote(`${SERVICE_ROOT}/nextcloud-${RELEASE.version}.tar.bz2`)}; if [ ! -f "$archive" ] || [ "$(sha256 -q "$archive" 2>/dev/null || true)" != ${quote(RELEASE.sha256)} ]; then fetch -qo "$archive.tmp" ${quote(RELEASE.url)}; [ "$(sha256 -q "$archive.tmp")" = ${quote(RELEASE.sha256)} ]; mv -f -- "$archive.tmp" "$archive"; fi; if [ ! -f ${quote(`${SERVICE_ROOT}/www/occ`)} ]; then work=$(mktemp -d); trap 'rm -rf -- "$work"' EXIT; tar -xjf "$archive" -C "$work"; test -f "$work/nextcloud/occ"; find ${quote(`${SERVICE_ROOT}/www`)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; cp -a "$work/nextcloud/." ${quote(`${SERVICE_ROOT}/www/`)}; fi; test -f ${quote(`${SERVICE_ROOT}/www/occ`)}; rm -rf -- ${quote(`${SERVICE_ROOT}/www/data`)}; find ${quote(`${SERVICE_ROOT}/www`)} -type d -exec chmod 0755 {} +; find ${quote(`${SERVICE_ROOT}/www`)} -type f -exec chmod 0644 {} +`
}

function deploy () {
  return `set -eu; root=${quote(SERVICE_ROOT)}; cat > ${quote(`${CREDENTIALS}/installer-argv.php`)} <<'PHP'
<?php
$files = ['database-pass' => getenv('WEBMINAI_DB_PASS_FILE'), 'admin-pass' => getenv('WEBMINAI_ADMIN_PASSWORD_FILE')];
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
upload_max_filesize = 128M
post_max_size = 128M
max_execution_time = 300
opcache.enable = 1
expose_php = Off
CONF
cat > "$root/nginx.conf" <<'CONF'
user root wheel;
worker_processes 1;
events { worker_connections 256; }
http { include /usr/local/etc/nginx/mime.types; client_max_body_size 128m; server { listen 80; root /srv/app; index index.php index.html; location = /robots.txt { allow all; log_not_found off; access_log off; } location ^~ /.well-known { location = /.well-known/carddav { return 301 /remote.php/dav/; } location = /.well-known/caldav { return 301 /remote.php/dav/; } return 301 /index.php$request_uri; } location / { try_files $uri $uri/ /index.php$request_uri; } location ~ \\.php(?:$|/) { fastcgi_split_path_info ^(.+?\\.php)(/.*)$; try_files $fastcgi_script_name =404; include fastcgi_params; fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name; fastcgi_param PATH_INFO $fastcgi_path_info; fastcgi_pass unix:/var/run/webminai/php-fpm.sock; fastcgi_read_timeout 300; } location ~ ^/(?:config|data|lib|3rdparty|templates|tests)(?:$|/) { deny all; } location ~ /\\. { deny all; } } }
CONF
chmod 0644 "$root/php.ini" "$root/nginx.conf"; podman network exists ${PROJECT} || podman network create --subnet 10.89.107.0/24 --gateway 10.89.107.1 ${PROJECT} >/dev/null; cat > "$root/compose.yml" <<'YAML'
services:
  db:
    image: ${DATABASE_IMAGE}
    restart: always
    environment: { WEBMINAI_DB_NAME: ${DATABASE}, WEBMINAI_DB_USER: ${DATABASE} }
    networks: { default: { ipv4_address: 10.89.107.2 } }
    volumes: [ '${SERVICE_ROOT}/db:/var/db/mysql', '${CREDENTIALS}:/run/secrets:ro' ]
  nextcloud:
    image: ${FREEBSD_PHP_IMAGE}
    restart: always
    depends_on: [ db ]
    networks: { default: { ipv4_address: 10.89.107.3 } }
    ports: [ '18107:80' ]
    volumes: [ '${SERVICE_ROOT}/www:/srv/app', '${SERVICE_ROOT}/data:/var/nextcloud-data', '${CREDENTIALS}:/run/secrets:ro', '${SERVICE_ROOT}/php.ini:/usr/local/etc/php.ini:ro', '${SERVICE_ROOT}/nginx.conf:/usr/local/etc/nginx/nginx.conf:ro' ]
  cron:
    image: ${FREEBSD_PHP_IMAGE}
    restart: always
    depends_on: [ nextcloud ]
    entrypoint: [ '/bin/sh', '-c', 'while :; do if [ -f /srv/app/config/config.php ]; then php -f /srv/app/cron.php >/dev/null 2>&1 || true; fi; sleep 300; done' ]
    networks: { default: { ipv4_address: 10.89.107.4 } }
    volumes: [ '${SERVICE_ROOT}/www:/srv/app', '${SERVICE_ROOT}/data:/var/nextcloud-data', '${SERVICE_ROOT}/php.ini:/usr/local/etc/php.ini:ro' ]
networks:
  default: { external: true, name: ${PROJECT} }
YAML
chmod 0600 "$root/compose.yml"; cd "$root"; podman-compose -p ${PROJECT} -f compose.yml down >/dev/null 2>&1 || true; podman-compose -p ${PROJECT} -f compose.yml up -d db nextcloud; database=; for attempt in $(jot 120); do podman exec ${PROJECT}_db_1 sh -c 'MYSQL_PWD=$(cat /run/secrets/db_root_password) mariadb -uroot -e "SELECT 1"' >/dev/null 2>&1 && { database=yes; break; }; sleep 2; done; [ "$database" = yes ]; ${primaryAddress()}; if [ ! -f "$root/www/config/config.php" ]; then podman exec -e WEBMINAI_DB_PASS_FILE=/run/secrets/db_password -e WEBMINAI_ADMIN_PASSWORD_FILE=/run/secrets/admin_password ${PROJECT}_nextcloud_1 php -d auto_prepend_file=/run/secrets/installer-argv.php /srv/app/occ maintenance:install --database=mysql --database-host=10.89.107.2 --database-name=${DATABASE} --database-user=${DATABASE} --admin-user=webminai_admin --data-dir=/var/nextcloud-data >/dev/null; fi; podman exec ${PROJECT}_nextcloud_1 php /srv/app/occ config:system:get datadirectory | grep -Fxq /var/nextcloud-data; rm -rf -- "$root/www/data"; podman exec ${PROJECT}_nextcloud_1 php /srv/app/occ config:system:set trusted_domains 0 --value="$address" >/dev/null; podman exec ${PROJECT}_nextcloud_1 php /srv/app/occ config:app:set theming name --value=${MARKER} >/dev/null; podman exec ${PROJECT}_nextcloud_1 php /srv/app/occ background:cron >/dev/null; podman exec ${PROJECT}_nextcloud_1 php -f /srv/app/cron.php >/dev/null; printf '%s\n' cron-completed > "$root/data/.webminai-cron-ok"; printf '%s\n' ${MARKER} > "$root/www/webminai-health.txt"; chmod 0644 "$root/www/webminai-health.txt"; chmod 0640 "$root/www/config/config.php"; podman-compose -p ${PROJECT} -f compose.yml up -d cron`
}

function verify () {
  return `set -eu; root=${quote(SERVICE_ROOT)}; response=$(mktemp); trap 'rm -f -- "$response"' EXIT; test -f "$root/www/config/config.php"; test -f "$root/data/.webminai-cron-ok"; test ! -e "$root/www/data"; podman exec ${PROJECT}_nextcloud_1 php /srv/app/occ config:system:get datadirectory | grep -Fxq /var/nextcloud-data; podman exec ${PROJECT}_db_1 sh -c 'MYSQL_PWD=$(cat /run/secrets/db_root_password) mariadb -uroot -Nse "SELECT COUNT(*) FROM ${DATABASE}.oc_users WHERE uid=\\"webminai_admin\\""' | grep -Fxq 1; podman exec ${PROJECT}_nextcloud_1 php /srv/app/occ status --output=json | grep -Eq '"installed"[[:space:]]*:[[:space:]]*true'; podman exec ${PROJECT}_nextcloud_1 php /srv/app/occ config:app:get theming name | grep -Fxq ${MARKER}; ${primaryAddress()}; verify_http() { curl --header "Host: $address:18107" --fail --silent --show-error --max-time 20 --output "$response" http://10.89.107.3/status.php && grep -Eq '"installed"[[:space:]]*:[[:space:]]*true' "$response" && curl --header "Host: $address:18107" --fail --silent --show-error --max-time 20 --output "$response" http://10.89.107.3/webminai-health.txt && grep -Fq ${MARKER} "$response"; }; verify_http; podman restart ${PROJECT}_db_1 ${PROJECT}_nextcloud_1 ${PROJECT}_cron_1 >/dev/null; ready=; for attempt in $(jot 90); do verify_http 2>/dev/null && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]`
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
