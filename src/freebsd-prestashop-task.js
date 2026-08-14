import { prestaShopComposeAssets, prestaShopRelease } from './prestashop-task.js'
import { buildFreebsdMariaDbImageCommand } from './freebsd-wordpress-task.js'
import { buildFreebsdPhpRuntimeCommand, FREEBSD_PHP_IMAGE } from './freebsd-php-runtime.js'

const RELEASE = prestaShopRelease()
const ASSETS = prestaShopComposeAssets()
const DATABASE_IMAGE = 'localhost/webminai-freebsd-mariadb:11.8'
const SERVICE_ROOT = '/var/db/webminai/apps/prestashop'
const BUILD_ROOT = '/var/db/webminai/image-builds/prestashop'
const CREDENTIALS = '/root/prestashop_credentials'
const PROJECT = 'webminai-prestashop-18105'
const DATABASE = 'webminai_prestashop'
const MARKER = 'WEBMINAI_PRESTASHOP_OK'

export function buildFreebsdPrestaShopTask (taskId, freebsdExecution) {
  if (freebsdExecution?.platform !== 'freebsd') throw new Error('FreeBSD PrestaShop requires a FreeBSD execution inventory')
  if (!freebsdExecution.docker?.ready && !freebsdExecution.docker?.daemonReachable) throw new Error('FreeBSD PrestaShop requires the reviewed Podman Suite and podman-compose substrate')
  const state = `/var/lib/webminai/task-state/${taskId}-prestashop-freebsd`
  return {
    plan: {
      summary: 'Deploy a learned reversible native FreeBSD PrestaShop store',
      changeOverview: `Reuse shared FreeBSD runtimes and the reviewed phased installer to deploy digest-verified PrestaShop ${RELEASE.version} on port 18105.`,
      modifiedFiles: [state, BUILD_ROOT, SERVICE_ROOT, CREDENTIALS],
      assumptions: ['FreeBSD 15.1 amd64 with the reviewed Podman jail substrate', `PrestaShop ${RELEASE.version}, PHP 8.4, nginx, and MariaDB 11.8 satisfy the resolved runtime matrix`],
      warnings: ['Only the isolated PrestaShop HTTP port is published.', 'The installation is deliberately minimal and does not configure payment, mail, tax, or shipping integrations.'],
      commands: [
        item('prepare-prestashop', prepare(state), 'Prepare protected credentials and task-owned directories'),
        item('build-mariadb-runtime', buildFreebsdMariaDbImageCommand(BUILD_ROOT), 'Build the shared parameterized FreeBSD MariaDB runtime', ['prepare-prestashop'], 1200000, 'job'),
        item('build-php-runtime', buildFreebsdPhpRuntimeCommand(BUILD_ROOT), 'Build the shared FreeBSD PHP 8.4 and nginx runtime', ['prepare-prestashop'], 1200000, 'job'),
        item('acquire-prestashop', acquire(), `Acquire and verify the outer PrestaShop ${RELEASE.version} distribution`, ['prepare-prestashop'], 300000, 'job'),
        item('start-prestashop', start(), 'Start the isolated MariaDB and PHP/nginx runtime and extract the verified inner distribution', ['build-mariadb-runtime', 'build-php-runtime', 'acquire-prestashop'], 600000, 'job'),
        item('initialize-prestashop-database', installStep('database'), 'Initialize the PrestaShop database using protected credential-file inputs', ['start-prestashop'], 1200000, 'job'),
        item('initialize-prestashop-modules', installStep('modules', 'ps_linklist'), 'Install the reviewed storefront module batch', ['initialize-prestashop-database'], 1200000, 'job'),
        item('initialize-prestashop-theme', installStep('theme,postInstall'), 'Install the classic theme and run its post-install phase', ['initialize-prestashop-modules'], 1200000, 'job'),
        item('finalize-prestashop', finalize(), 'Finalize installation and remove the public installer', ['initialize-prestashop-theme'], 1200000, 'job'),
        item('verify-prestashop', verify(), 'Verify configuration, database administrator, HTTP marker, and restart persistence', ['finalize-prestashop'], 600000, 'job')
      ],
      revertCommands: [item('remove-prestashop', remove(state), 'Remove only task-owned PrestaShop containers, data, state, and credentials', [], 900000, 'job', 'destructive')]
    },
    verifyApplied: `response=$(mktemp); trap 'rm -f -- "$response"' EXIT; ${primaryAddress()}; curl --header "Host: $address:18105" --fail --location --silent --show-error --max-time 20 --output "$response" http://10.89.105.3/; grep -Fq ${MARKER} "$response"`,
    verifyReverted: `test ! -e ${quote(SERVICE_ROOT)} && test ! -e ${quote(state)}`,
    stateProbe: `test -e ${quote(state)} && printf applied || printf absent`
  }
}

function prepare (state) {
  return `set -eu; test "$(uname -s)" = FreeBSD; command -v podman >/dev/null; command -v podman-compose >/dev/null; podman info >/dev/null; install -d -m 0700 ${quote(state)} ${quote(BUILD_ROOT)}; install -d -m 0755 ${quote(SERVICE_ROOT)} ${quote(`${SERVICE_ROOT}/www`)} ${quote(`${SERVICE_ROOT}/db`)}; if [ -e ${quote(CREDENTIALS)} ]; then : > ${quote(`${state}/credentials-preexisting`)}; else install -d -m 0700 ${quote(CREDENTIALS)}; fi; for name in db_root_password db_password admin_password; do if [ ! -s ${quote(CREDENTIALS)}/$name ]; then umask 077; openssl rand -hex 30 > ${quote(CREDENTIALS)}/$name; fi; done; chmod 0600 ${quote(CREDENTIALS)}/*`
}

function acquire () {
  return `set -eu; archive=${quote(`${CREDENTIALS}/prestashop-${RELEASE.version}.zip`)}; if [ ! -f "$archive" ] || [ "$(sha256 -q "$archive" 2>/dev/null || true)" != ${quote(RELEASE.sha256)} ]; then fetch -qo "$archive.tmp" ${quote(RELEASE.url)}; [ "$(md5 -q "$archive.tmp")" = ${quote(RELEASE.md5)} ]; [ "$(sha256 -q "$archive.tmp")" = ${quote(RELEASE.sha256)} ]; mv -f -- "$archive.tmp" "$archive"; fi; chmod 0600 "$archive"`
}

function start () {
  return `[ ! -f ${quote(`${SERVICE_ROOT}/www/.webminai-installed`)} ] || { cd ${quote(SERVICE_ROOT)}; podman-compose -p ${PROJECT} -f compose.yml up -d; database=; for attempt in $(jot 120); do podman exec ${PROJECT}_db_1 sh -c 'MYSQL_PWD=$(cat /run/secrets/db_root_password) mariadb -uroot -e "SELECT 1"' >/dev/null 2>&1 && { database=yes; break; }; sleep 2; done; [ "$database" = yes ]; exit 0; }; ${startFresh()}`
}

function startFresh () {
  const bootstrap = shellFile(ASSETS.installer, `${CREDENTIALS}/installer-argv.php`)
  return `set -eu; root=${quote(SERVICE_ROOT)}; ${bootstrap}; chmod 0600 ${quote(`${CREDENTIALS}/installer-argv.php`)}; podman network exists ${PROJECT} || podman network create --subnet 10.89.105.0/24 --gateway 10.89.105.1 ${PROJECT} >/dev/null; cat > "$root/compose.yml" <<'YAML'
services:
  db:
    image: ${DATABASE_IMAGE}
    restart: always
    environment: { WEBMINAI_DB_NAME: ${DATABASE}, WEBMINAI_DB_USER: ${DATABASE} }
    networks: { default: { ipv4_address: 10.89.105.2 } }
    volumes: [ '${SERVICE_ROOT}/db:/var/db/mysql', '${CREDENTIALS}:/run/secrets:ro' ]
  prestashop:
    image: ${FREEBSD_PHP_IMAGE}
    restart: always
    depends_on: [ db ]
    networks: { default: { ipv4_address: 10.89.105.3 } }
    ports: [ '18105:80' ]
    volumes: [ '${SERVICE_ROOT}/www:/srv/app', '${CREDENTIALS}:/run/secrets:ro' ]
networks:
  default: { external: true, name: ${PROJECT} }
YAML
chmod 0600 "$root/compose.yml"; cd "$root"; podman-compose -p ${PROJECT} -f compose.yml down >/dev/null 2>&1 || true; podman-compose -p ${PROJECT} -f compose.yml up -d; database=; for attempt in $(jot 120); do podman exec ${PROJECT}_db_1 sh -c 'MYSQL_PWD=$(cat /run/secrets/db_root_password) mariadb -uroot -e "SELECT 1"' >/dev/null 2>&1 && { database=yes; break; }; sleep 2; done; [ "$database" = yes ]; if [ ! -f "$root/www/index.php" ]; then podman exec ${PROJECT}_prestashop_1 php -r '$outer=new ZipArchive(); if ($outer->open("/run/secrets/prestashop-${RELEASE.version}.zip") !== true || !$outer->extractTo("/srv/app", ["prestashop.zip"])) { exit(1); } $outer->close(); if (hash_file("sha256", "/srv/app/prestashop.zip") !== "${RELEASE.innerSha256}") { exit(1); } $inner=new ZipArchive(); if ($inner->open("/srv/app/prestashop.zip") !== true || !$inner->extractTo("/srv/app")) { exit(1); } $inner->close(); unlink("/srv/app/prestashop.zip");'; fi; test -f "$root/www/index.php"; test -f "$root/www/install/index_cli.php"; find "$root/www" -type d -exec chmod 0755 {} +; find "$root/www" -type f -exec chmod 0644 {} +`
}

function installStep (step, modules = null) {
  return `set -eu; root=${quote(SERVICE_ROOT)}; [ ! -f "$root/www/.webminai-installed" ] || exit 0; ${primaryAddress()}; podman exec -e WEBMINAI_DB_PASS_FILE=/run/secrets/db_password -e WEBMINAI_ADMIN_PASSWORD_FILE=/run/secrets/admin_password ${PROJECT}_prestashop_1 php -d memory_limit=-1 -d auto_prepend_file=/run/secrets/installer-argv.php /srv/app/install/index_cli.php --step=${quote(step)}${modules ? ` --modules=${quote(modules)}` : ''} --domain="$address:18105" --db_server=10.89.105.2 --db_user=${DATABASE} --db_name=${DATABASE} --db_clear=1 --prefix=wmai_ --name=${MARKER} --email=intentaiops@example.invalid --firstname=Intent AI Ops --lastname=Administrator --country=us --timezone=Etc/UTC --fixtures=0 --rewrite=1 >/dev/null 2>&1`
}

function finalize () {
  return `${installStep('finalize')}; root=${quote(SERVICE_ROOT)}; rm -rf -- "$root/www/install"; printf '%s\n' installation-completed > "$root/www/.webminai-installed"; test -f "$root/www/app/config/parameters.php"; chmod 0640 "$root/www/app/config/parameters.php"`
}

function verify () {
  return `set -eu; root=${quote(SERVICE_ROOT)}; test -f "$root/www/.webminai-installed"; test -f "$root/www/app/config/parameters.php"; test ! -d "$root/www/install"; test "$(stat -f %Lp "$root/www/app/config/parameters.php")" = 640; podman exec ${PROJECT}_db_1 sh -c 'MYSQL_PWD=$(cat /run/secrets/db_root_password) mariadb -uroot -Nse "SELECT COUNT(*) FROM ${DATABASE}.wmai_employee WHERE email=\\"intentaiops@example.invalid\\""' | grep -Fxq 1; ${primaryAddress()}; verify_http() { response=$(mktemp); curl --header "Host: $address:18105" --fail --location --silent --show-error --max-time 20 --output "$response" http://10.89.105.3/ && grep -Fq ${MARKER} "$response"; code=$?; rm -f -- "$response"; return "$code"; }; verify_http; podman restart ${PROJECT}_db_1 ${PROJECT}_prestashop_1 >/dev/null; ready=; for attempt in $(jot 90); do verify_http 2>/dev/null && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]`
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
