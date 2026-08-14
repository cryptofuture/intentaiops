import { drupalComposeAssets, drupalRelease } from './drupal-task.js'
import { buildFreebsdMariaDbImageCommand } from './freebsd-wordpress-task.js'
import { buildFreebsdPhpRuntimeCommand, FREEBSD_PHP_IMAGE } from './freebsd-php-runtime.js'

const RELEASE = drupalRelease()
const ASSETS = drupalComposeAssets()
const DATABASE_IMAGE = 'localhost/webminai-freebsd-mariadb:11.8'
const SERVICE_ROOT = '/var/db/webminai/apps/drupal'
const BUILD_ROOT = '/var/db/webminai/image-builds/drupal'
const CREDENTIALS = '/root/drupal_credentials'
const PROJECT = 'webminai-drupal-18104'
const DATABASE = 'webminai_drupal'
const MARKER = 'WEBMINAI_DRUPAL_OK'

export function buildFreebsdDrupalTask (taskId, freebsdExecution) {
  if (freebsdExecution?.platform !== 'freebsd') throw new Error('FreeBSD Drupal requires a FreeBSD execution inventory')
  if (!freebsdExecution.docker?.ready && !freebsdExecution.docker?.daemonReachable) throw new Error('FreeBSD Drupal requires the reviewed Podman Suite and podman-compose substrate')
  const state = `/var/lib/webminai/task-state/${taskId}-drupal-freebsd`
  return {
    plan: {
      summary: 'Deploy a learned reversible native FreeBSD Drupal site',
      changeOverview: `Reuse the shared FreeBSD PHP/nginx and MariaDB runtimes to deploy digest-verified Drupal ${RELEASE.version} on port 18104.`,
      modifiedFiles: [state, BUILD_ROOT, SERVICE_ROOT, CREDENTIALS],
      assumptions: ['FreeBSD 15.1 amd64 with the reviewed Podman jail substrate', `Drupal ${RELEASE.version}, PHP 8.4, nginx, and MariaDB 11.8 satisfy the resolved runtime matrix`],
      warnings: ['Only the isolated Drupal HTTP port is published.', 'Shared runtime images remain after rollback; all application data and protected credentials are task-owned.'],
      commands: [
        item('prepare-drupal', prepare(state), 'Prepare protected credentials and task-owned directories'),
        item('build-mariadb-runtime', buildFreebsdMariaDbImageCommand(BUILD_ROOT), 'Build the shared parameterized FreeBSD MariaDB runtime', ['prepare-drupal'], 1200000, 'job'),
        item('build-php-runtime', buildFreebsdPhpRuntimeCommand(BUILD_ROOT), 'Build the shared FreeBSD PHP 8.4 and nginx runtime', ['prepare-drupal'], 1200000, 'job'),
        item('acquire-drupal', acquire(), `Acquire and SHA-256 verify Drupal ${RELEASE.version}`, ['prepare-drupal'], 300000, 'job'),
        item('deploy-drupal', deploy(), 'Start the isolated runtime and initialize Drupal from protected credential files', ['build-mariadb-runtime', 'build-php-runtime', 'acquire-drupal'], 1200000, 'job'),
        item('verify-drupal', verify(), 'Verify Drupal, clean URLs, database state, cron marker, and restart persistence', ['deploy-drupal'], 600000, 'job')
      ],
      revertCommands: [item('remove-drupal', remove(state), 'Remove only task-owned Drupal containers, data, state, and credentials', [], 900000, 'job', 'destructive')]
    },
    verifyApplied: `response=$(mktemp); trap 'rm -f -- "$response"' EXIT; ${primaryAddress()}; curl --header "Host: $address:18104" --fail --location --silent --show-error --max-time 20 --output "$response" http://10.89.104.3/; grep -Fq ${MARKER} "$response"`,
    verifyReverted: `test ! -e ${quote(SERVICE_ROOT)} && test ! -e ${quote(state)}`,
    stateProbe: `test -e ${quote(state)} && printf applied || printf absent`
  }
}

function prepare (state) {
  return `set -eu; test "$(uname -s)" = FreeBSD; command -v podman >/dev/null; command -v podman-compose >/dev/null; podman info >/dev/null; install -d -m 0700 ${quote(state)} ${quote(BUILD_ROOT)}; install -d -m 0755 ${quote(SERVICE_ROOT)} ${quote(`${SERVICE_ROOT}/www`)} ${quote(`${SERVICE_ROOT}/db`)}; if [ -e ${quote(CREDENTIALS)} ]; then : > ${quote(`${state}/credentials-preexisting`)}; else install -d -m 0700 ${quote(CREDENTIALS)}; fi; for name in db_root_password db_password admin_password; do if [ ! -s ${quote(CREDENTIALS)}/$name ]; then umask 077; openssl rand -hex 30 > ${quote(CREDENTIALS)}/$name; fi; done; chmod 0600 ${quote(CREDENTIALS)}/*`
}

function acquire () {
  return `set -eu; archive=${quote(`${SERVICE_ROOT}/drupal-${RELEASE.version}.tar.gz`)}; if [ ! -f "$archive" ] || [ "$(sha256 -q "$archive" 2>/dev/null || true)" != ${quote(RELEASE.sha256)} ]; then fetch -qo "$archive.tmp" ${quote(RELEASE.url)}; [ "$(sha256 -q "$archive.tmp")" = ${quote(RELEASE.sha256)} ]; mv -f -- "$archive.tmp" "$archive"; fi; if [ ! -f ${quote(`${SERVICE_ROOT}/www/core/lib/Drupal.php`)} ]; then work=$(mktemp -d); trap 'rm -rf -- "$work"' EXIT; tar -xzf "$archive" -C "$work"; test -f "$work/drupal-${RELEASE.version}/core/lib/Drupal.php"; find ${quote(`${SERVICE_ROOT}/www`)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; cp -a "$work/drupal-${RELEASE.version}/." ${quote(`${SERVICE_ROOT}/www/`)}; rm -rf -- "$work"; trap - EXIT; fi; test -f ${quote(`${SERVICE_ROOT}/www/core/lib/Drupal.php`)}; find ${quote(`${SERVICE_ROOT}/www`)} -type d -exec chmod 0755 {} +; find ${quote(`${SERVICE_ROOT}/www`)} -type f -exec chmod 0644 {} +`
}

function deploy () {
  const installer = shellFile(ASSETS.installer, `${CREDENTIALS}/install-drupal.php`)
  const reconciler = shellFile(ASSETS.reconciler, `${CREDENTIALS}/reconcile-drupal.php`)
  return `set -eu; root=${quote(SERVICE_ROOT)}; ${installer}; ${reconciler}; chmod 0600 ${quote(CREDENTIALS)}/*.php; podman network exists ${PROJECT} || podman network create --subnet 10.89.104.0/24 --gateway 10.89.104.1 ${PROJECT} >/dev/null; cat > "$root/compose.yml" <<'YAML'
services:
  db:
    image: ${DATABASE_IMAGE}
    restart: always
    environment: { WEBMINAI_DB_NAME: ${DATABASE}, WEBMINAI_DB_USER: ${DATABASE} }
    networks: { default: { ipv4_address: 10.89.104.2 } }
    volumes: [ '${SERVICE_ROOT}/db:/var/db/mysql', '${CREDENTIALS}:/run/secrets:ro' ]
  drupal:
    image: ${FREEBSD_PHP_IMAGE}
    restart: always
    depends_on: [ db ]
    networks: { default: { ipv4_address: 10.89.104.3 } }
    ports: [ '18104:80' ]
    volumes: [ '${SERVICE_ROOT}/www:/srv/app', '${CREDENTIALS}:/run/secrets:ro' ]
networks:
  default: { external: true, name: ${PROJECT} }
YAML
chmod 0600 "$root/compose.yml"; cd "$root"; podman-compose -p ${PROJECT} -f compose.yml down >/dev/null 2>&1 || true; podman-compose -p ${PROJECT} -f compose.yml up -d; database=; for attempt in $(jot 120); do podman exec ${PROJECT}_db_1 sh -c 'MYSQL_PWD=$(cat /run/secrets/db_root_password) mariadb -uroot -e "SELECT 1"' >/dev/null 2>&1 && { database=yes; break; }; sleep 2; done; [ "$database" = yes ]; if [ ! -f "$root/www/sites/default/.webminai-installed" ]; then if ! podman exec -e WEBMINAI_DRUPAL_ROOT=/srv/app -e WEBMINAI_DB_HOST=10.89.104.2 -e WEBMINAI_DB_NAME=${DATABASE} -e WEBMINAI_DB_USER=${DATABASE} -e WEBMINAI_DB_PASS_FILE=/run/secrets/db_password -e WEBMINAI_ADMIN_PASS_FILE=/run/secrets/admin_password ${PROJECT}_drupal_1 php /run/secrets/install-drupal.php >/dev/null 2>&1; then echo 'Drupal installer failed' >&2; exit 1; fi; fi; podman exec -e WEBMINAI_DRUPAL_ROOT=/srv/app -e WEBMINAI_DRUPAL_URL=http://127.0.0.1:18104/ ${PROJECT}_drupal_1 php /run/secrets/reconcile-drupal.php >/dev/null 2>&1; test -f "$root/www/sites/default/.webminai-installed"; test -f "$root/www/sites/default/files/.webminai-cron-ok"; chmod 0555 "$root/www/sites/default"; chmod 0440 "$root/www/sites/default/settings.php"; ${primaryAddress()}; ready=; for attempt in $(jot 90); do curl --header "Host: $address:18104" --fail --location --silent --show-error --max-time 10 http://10.89.104.3/ 2>/dev/null | grep -Fq ${MARKER} && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]`
}

function verify () {
  return `set -eu; root=${quote(SERVICE_ROOT)}; test -f "$root/www/sites/default/.webminai-installed"; test -f "$root/www/sites/default/files/.webminai-cron-ok"; test "$(stat -f %Lp "$root/www/sites/default/settings.php")" = 440; podman exec ${PROJECT}_db_1 sh -c 'MYSQL_PWD=$(cat /run/secrets/db_root_password) mariadb -uroot -Nse "SELECT COUNT(*) FROM ${DATABASE}.users_field_data WHERE name=\\"webminai_admin\\""' | grep -Fxq 1; ${primaryAddress()}; verify_http() { curl --header "Host: $address:18104" --fail --location --silent --show-error --max-time 20 http://10.89.104.3/ | grep -Fq ${MARKER} && curl --header "Host: $address:18104" --fail --location --silent --show-error --max-time 20 http://10.89.104.3/user/login | grep -Fq form_id; }; verify_http; podman restart ${PROJECT}_db_1 ${PROJECT}_drupal_1 >/dev/null; ready=; for attempt in $(jot 90); do verify_http 2>/dev/null && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]`
}

function remove (state) {
  return `set -eu; if [ -f ${quote(`${SERVICE_ROOT}/compose.yml`)} ]; then cd ${quote(SERVICE_ROOT)}; podman-compose -p ${PROJECT} -f compose.yml down >/dev/null 2>&1 || true; fi; podman network rm ${PROJECT} >/dev/null 2>&1 || true; rm -rf -- ${quote(SERVICE_ROOT)} ${quote(BUILD_ROOT)}; if [ -d ${quote(state)} ] && [ ! -e ${quote(`${state}/credentials-preexisting`)} ]; then rm -rf -- ${quote(CREDENTIALS)}; fi; rm -rf -- ${quote(state)}`
}

function shellFile (lines, path) {
  return `printf '%s\\n' ${lines.map(quote).join(' ')} > ${quote(path)}`
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
