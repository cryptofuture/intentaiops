import { buildFreebsdMariaDbImageCommand } from './freebsd-wordpress-task.js'
import { buildFreebsdPhpRuntimeCommand, FREEBSD_PHP_IMAGE } from './freebsd-php-runtime.js'

const VERSION = '5.4.7'
const ARCHIVE_URL = `https://update.joomla.org/releases/${VERSION}/Joomla_${VERSION}-Stable-Full_Package.tar.gz`
const ARCHIVE_SHA256 = 'd989e8a315238784b8e4ca5eef0cad3e498e989cc0b9094d341c0d997ddb8729'
const DATABASE_IMAGE = 'localhost/webminai-freebsd-mariadb:11.8'
const SERVICE_ROOT = '/var/db/webminai/apps/joomla'
const BUILD_ROOT = '/var/db/webminai/image-builds/joomla'
const CREDENTIALS = '/root/joomla_credentials'
const PROJECT = 'webminai-joomla-18103'
const DATABASE = 'webminai_joomla'
const MARKER = 'WEBMINAI_JOOMLA_OK'

export function buildFreebsdJoomlaTask (taskId, freebsdExecution) {
  if (freebsdExecution?.platform !== 'freebsd') throw new Error('FreeBSD Joomla requires a FreeBSD execution inventory')
  if (!freebsdExecution.docker?.ready && !freebsdExecution.docker?.daemonReachable) throw new Error('FreeBSD Joomla requires the reviewed Podman Suite and podman-compose substrate')
  const state = `/var/lib/webminai/task-state/${taskId}-joomla-freebsd`
  return {
    plan: {
      summary: 'Deploy a learned reversible native FreeBSD Joomla site',
      changeOverview: `Build shared native FreeBSD PHP/nginx and MariaDB runtimes, then deploy digest-verified Joomla ${VERSION} on port 18103.`,
      modifiedFiles: [state, BUILD_ROOT, SERVICE_ROOT, CREDENTIALS],
      assumptions: ['FreeBSD 15.1 amd64 with the reviewed Podman jail substrate', `Joomla ${VERSION}, PHP 8.4, nginx, and MariaDB 11.8 satisfy the resolved runtime matrix`],
      warnings: ['The shared FreeBSD runtime containers execute as container root because non-root processes cannot reliably traverse VFS jail image layers.', 'Only the isolated Joomla HTTP port is published; shared runtime images remain after rollback.'],
      commands: [
        item('prepare-joomla', prepare(state), 'Prepare task state, protected credentials, source, and build directories'),
        item('build-mariadb-runtime', buildFreebsdMariaDbImageCommand(BUILD_ROOT), 'Build the shared parameterized native FreeBSD MariaDB runtime', ['prepare-joomla'], 1200000, 'job'),
        item('build-php-runtime', buildFreebsdPhpRuntimeCommand(BUILD_ROOT), 'Build the shared native FreeBSD PHP 8.4 and nginx runtime', ['prepare-joomla'], 1200000, 'job'),
        item('acquire-joomla', acquire(), `Acquire and SHA-256 verify Joomla ${VERSION}`, ['prepare-joomla'], 300000, 'job'),
        item('deploy-joomla', deploy(), 'Start the isolated database and PHP/nginx services and initialize Joomla from protected credential files', ['build-mariadb-runtime', 'build-php-runtime', 'acquire-joomla'], 1200000, 'job'),
        item('verify-joomla', verify(), 'Verify Joomla, its database, external marker, and restart persistence', ['deploy-joomla'], 600000, 'job')
      ],
      revertCommands: [item('remove-joomla', remove(state), 'Remove only the task-owned Joomla stack, data, state, and credentials', [], 900000, 'job', 'destructive')]
    },
    verifyApplied: `${primaryAddress()}; curl --header "Host: $address:18103" --fail --location --silent --show-error --max-time 20 http://10.89.103.3/ | grep -Fq ${MARKER}`,
    verifyReverted: `test ! -e ${quote(SERVICE_ROOT)} && test ! -e ${quote(state)}`,
    stateProbe: `test -e ${quote(state)} && printf applied || printf absent`
  }
}

function prepare (state) {
  return `set -eu; test "$(uname -s)" = FreeBSD; command -v podman >/dev/null; command -v podman-compose >/dev/null; podman info >/dev/null; install -d -m 0700 ${quote(state)} ${quote(BUILD_ROOT)}; install -d -m 0755 ${quote(SERVICE_ROOT)} ${quote(`${SERVICE_ROOT}/www`)} ${quote(`${SERVICE_ROOT}/db`)}; if [ -e ${quote(CREDENTIALS)} ]; then : > ${quote(`${state}/credentials-preexisting`)}; else install -d -m 0700 ${quote(CREDENTIALS)}; fi; for name in db_root_password db_password admin_password; do if [ ! -s ${quote(CREDENTIALS)}/$name ]; then umask 077; openssl rand -hex 30 > ${quote(CREDENTIALS)}/$name; fi; done; chmod 0600 ${quote(CREDENTIALS)}/*`
}

function acquire () {
  return `set -eu; archive=${quote(`${SERVICE_ROOT}/joomla-${VERSION}.tar.gz`)}; if [ ! -f "$archive" ] || [ "$(sha256 -q "$archive" 2>/dev/null || true)" != ${quote(ARCHIVE_SHA256)} ]; then fetch -qo "$archive.tmp" ${quote(ARCHIVE_URL)}; [ "$(sha256 -q "$archive.tmp")" = ${quote(ARCHIVE_SHA256)} ]; mv -f -- "$archive.tmp" "$archive"; fi; if [ ! -f ${quote(`${SERVICE_ROOT}/www/installation/joomla.php`)} ] && [ ! -f ${quote(`${SERVICE_ROOT}/www/configuration.php`)} ]; then find ${quote(`${SERVICE_ROOT}/www`)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xzf "$archive" -C ${quote(`${SERVICE_ROOT}/www`)}; fi; test -f ${quote(`${SERVICE_ROOT}/www/installation/joomla.php`)} -o -f ${quote(`${SERVICE_ROOT}/www/configuration.php`)}; find ${quote(`${SERVICE_ROOT}/www`)} -type d -exec chmod 0755 {} +; find ${quote(`${SERVICE_ROOT}/www`)} -type f -exec chmod 0644 {} +`
}

function deploy () {
  return `set -eu; root=${quote(SERVICE_ROOT)}; cat > "$root/php.ini" <<'CONF'
zlib.output_compression = On
expose_php = Off
CONF
chmod 0644 "$root/php.ini"; podman network exists ${PROJECT} || podman network create --subnet 10.89.103.0/24 --gateway 10.89.103.1 ${PROJECT} >/dev/null; cat > "$root/compose.yml" <<'YAML'
services:
  db:
    image: ${DATABASE_IMAGE}
    restart: always
    environment: { WEBMINAI_DB_NAME: ${DATABASE}, WEBMINAI_DB_USER: ${DATABASE} }
    networks: { default: { ipv4_address: 10.89.103.2 } }
    volumes: [ '${SERVICE_ROOT}/db:/var/db/mysql', '${CREDENTIALS}:/run/secrets:ro' ]
  joomla:
    image: ${FREEBSD_PHP_IMAGE}
    restart: always
    depends_on: [ db ]
    networks: { default: { ipv4_address: 10.89.103.3 } }
    ports: [ '18103:80' ]
    volumes: [ '${SERVICE_ROOT}/www:/srv/app', '${CREDENTIALS}:/run/secrets:ro', '${SERVICE_ROOT}/php.ini:/usr/local/etc/php.ini:ro' ]
networks:
  default: { external: true, name: ${PROJECT} }
YAML
chmod 0600 "$root/compose.yml"; cat > ${quote(`${CREDENTIALS}/installer-argv.php`)} <<'PHP'
<?php
$files = ['db-pass' => getenv('WEBMINAI_DB_PASS_FILE'), 'admin-password' => getenv('WEBMINAI_ADMIN_PASSWORD_FILE')];
foreach ($files as $option => $path) {
    if (!$path || !is_file($path)) { fwrite(STDERR, 'missing protected credential file' . PHP_EOL); exit(1); }
    $value = trim((string) file_get_contents($path));
    if ($value === '') { fwrite(STDERR, 'empty protected credential file' . PHP_EOL); exit(1); }
    $_SERVER['argv'][] = '--' . $option . '=' . $value;
}
$_SERVER['argc'] = count($_SERVER['argv']);
$GLOBALS['argv'] = $_SERVER['argv'];
$GLOBALS['argc'] = $_SERVER['argc'];
PHP
chmod 0600 ${quote(`${CREDENTIALS}/installer-argv.php`)}; cd "$root"; podman-compose -p ${PROJECT} -f compose.yml down >/dev/null 2>&1 || true; podman-compose -p ${PROJECT} -f compose.yml up -d; database=; for attempt in $(jot 120); do podman exec ${PROJECT}_db_1 sh -c 'MYSQL_PWD=$(cat /run/secrets/db_root_password) mariadb -uroot -e "SELECT 1"' >/dev/null 2>&1 && { database=yes; break; }; sleep 2; done; [ "$database" = yes ]; if [ ! -f "$root/www/configuration.php" ]; then if ! podman exec -e WEBMINAI_DB_PASS_FILE=/run/secrets/db_password -e WEBMINAI_ADMIN_PASSWORD_FILE=/run/secrets/admin_password ${PROJECT}_joomla_1 php -d auto_prepend_file=/run/secrets/installer-argv.php /srv/app/installation/joomla.php install --no-interaction --site-name=${MARKER} --admin-user='Intent AI Ops Administrator' --admin-username=webminai_admin --admin-email=intentaiops@example.invalid --db-type=mysqli --db-host=10.89.103.2 --db-user=${DATABASE} --db-name=${DATABASE} --db-prefix=wmai_ --db-encryption=0 >/dev/null 2>&1; then echo 'Joomla installer failed' >&2; exit 1; fi; fi; test -f "$root/www/configuration.php"; test ! -d "$root/www/installation"; chmod 0640 "$root/www/configuration.php"; ${primaryAddress()}; ready=; for attempt in $(jot 90); do curl --header "Host: $address:18103" --fail --location --silent --show-error --max-time 10 http://10.89.103.3/ 2>/dev/null | grep -Fq ${MARKER} && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]`
}

function verify () {
  return `set -eu; root=${quote(SERVICE_ROOT)}; test -f "$root/www/configuration.php"; podman exec ${PROJECT}_db_1 sh -c 'MYSQL_PWD=$(cat /run/secrets/db_root_password) mariadb -uroot -Nse "SELECT COUNT(*) FROM ${DATABASE}.wmai_users WHERE username=\\"webminai_admin\\""' | grep -Fxq 1; ${primaryAddress()}; verify_http() { curl --header "Host: $address:18103" --fail --location --silent --show-error --max-time 20 http://10.89.103.3/ | grep -Fq ${MARKER}; }; verify_http; podman restart ${PROJECT}_db_1 ${PROJECT}_joomla_1 >/dev/null; ready=; for attempt in $(jot 90); do verify_http 2>/dev/null && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]`
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
