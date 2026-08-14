const VERSION = '2.4.8-p5'
const ARCHIVE_SHA256 = 'c3da9206254d8c7bc383f7a0187b07671d0fc7c1a5e6a11307fe6c2b57d8c8b9'
const APP_ROOT = '/usr/local/lib/webminai-magento-18108'
const DATA_ROOT = '/var/db/webminai-magento-18108'
const CREDENTIALS = '/root/magento_credentials'
const DATABASE = 'webminai_magento_18108'
const DATABASE_USER = 'webminai_magento'
const MYSQL_RC = '/usr/local/etc/rc.d/webminai_magento_mysql'
const NGINX_CONFIG = '/usr/local/etc/nginx/nginx.conf'
const PHP_FPM_CONFIG = '/usr/local/etc/php-fpm.d/www.conf'
const PHP_CONFIG = '/usr/local/etc/php.ini'
const OPENSEARCH_CONFIG = '/usr/local/etc/opensearch/opensearch.yml'
const OPENSEARCH_JVM = '/usr/local/etc/opensearch/jvm.options.d/webminai.options'
const VALKEY_CONFIG = '/usr/local/etc/valkey.conf'
const CRON_CONFIG = '/etc/cron.d/webminai_magento'
const MARKER = 'WEBMINAI_MAGENTO_OK'

export function buildFreebsdMagentoTask (taskId, freebsdExecution) {
  if (freebsdExecution?.platform !== 'freebsd') throw new Error('FreeBSD Magento requires a FreeBSD execution inventory')
  const state = `/var/lib/webminai/task-state/${taskId}-magento-freebsd`
  return {
    plan: {
      summary: 'Deploy a learned reversible native FreeBSD Magento Open Source store',
      changeOverview: `Build checksum-pinned Magento Open Source ${VERSION} with PHP 8.4-FPM, MariaDB 11.4, OpenSearch 2.19, Valkey 8.1, cron, and nginx on port 18108.`,
      modifiedFiles: [state, APP_ROOT, DATA_ROOT, CREDENTIALS, MYSQL_RC, NGINX_CONFIG, PHP_FPM_CONFIG, PHP_CONFIG, OPENSEARCH_CONFIG, OPENSEARCH_JVM, VALKEY_CONFIG, CRON_CONFIG],
      assumptions: ['FreeBSD 15.1 amd64 with pkg and rc.d', 'The controlled lab has at least two CPU threads, 2 GB RAM, 1 GB swap, and sufficient disk for the resolved native stack.'],
      warnings: ['Adobe Commerce supports Linux rather than FreeBSD. This is an Intent AI Ops-tested source adaptation of Magento Open Source.', 'OpenSearch is restricted to loopback and tuned to a 384 MB heap for this controlled test; production sizing requires a separate capacity review.'],
      commands: [
        item('prepare-magento', prepare(state), 'Capture package and identity baselines and generate administrator and database credentials on-host'),
        item('install-magento-runtime', installRuntime(state), 'Install exact PHP, Composer, MariaDB, OpenSearch, Valkey, nginx, and required extensions', ['prepare-magento'], 3600000, 'job'),
        item('install-magento-source', installSource(state), `Acquire checksum-pinned Magento ${VERSION} and install its locked production dependencies`, ['install-magento-runtime'], 3600000, 'job'),
        item('initialize-magento-services', initializeServices(), 'Initialize isolated MariaDB, OpenSearch, and Valkey state without exposing credentials', ['install-magento-runtime', 'prepare-magento'], 1800000, 'job'),
        item('configure-magento-runtime', configureRuntime(), 'Configure a PHP-FPM Unix socket, nginx, and recurring Magento cron', ['install-magento-source', 'initialize-magento-services'], 900000, 'job'),
        item('initialize-magento', initializeMagento(state), 'Install Magento with protected inputs and create the real CMS marker', ['configure-magento-runtime'], 3600000, 'job'),
        item('verify-magento', verify(), 'Verify Magento CLI, database, search, cache, Unix socket, cron, HTTP, and restart recovery', ['initialize-magento'], 1800000, 'job')
      ],
      revertCommands: [item('remove-magento', remove(state), 'Remove only task-owned Magento services, credentials, identities, and packages', [], 1800000, 'job', 'destructive')]
    },
    verifyApplied: `set -eu; ${primaryAddress()}; curl --fail --location --silent --show-error --max-time 30 http://$address:18108/ | grep -F ${quote(MARKER)} >/dev/null`,
    verifyReverted: `test ! -e ${quote(APP_ROOT)} && test ! -e ${quote(DATA_ROOT)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)} && ! pkg info -e php84 >/dev/null 2>&1 && ! pkg info -e mariadb114-server >/dev/null 2>&1 && ! pkg info -e opensearch219 >/dev/null 2>&1`,
    stateProbe: `test -e ${quote(state)} && printf applied || printf absent`
  }
}

function prepare (state) {
  return `[ ! -d ${quote(state)} ] || exit 0; ${prepareFresh(state)}`
}

function prepareFresh (state) {
  return `set -eu; test "$(uname -s)" = FreeBSD; for package in php84 php84-composer mariadb114-server opensearch219 valkey8 nginx; do pkg info -e "$package" >/dev/null 2>&1 && { echo "pre-existing $package is outside task ownership" >&2; exit 1; } || true; done; for path in ${quote(APP_ROOT)} ${quote(DATA_ROOT)} ${quote(MYSQL_RC)} ${quote(CRON_CONFIG)}; do test ! -e "$path"; done; install -d -m 0700 ${quote(state)}; pkg query -a '%n' | LC_ALL=C sort -u > ${quote(`${state}/packages.before`)}; for identity in webminai_magento mysql opensearch valkey; do pw usershow "$identity" >/dev/null 2>&1 && : > ${quote(state)}/user-$identity-preexisting || true; pw groupshow "$identity" >/dev/null 2>&1 && : > ${quote(state)}/group-$identity-preexisting || true; done; if [ -e ${quote(CREDENTIALS)} ]; then : > ${quote(`${state}/credentials-preexisting`)}; else install -d -m 0700 ${quote(CREDENTIALS)}; fi; for name in database_password admin_password; do if [ ! -s ${quote(CREDENTIALS)}/$name ]; then umask 077; openssl rand -hex 32 > ${quote(CREDENTIALS)}/$name; : > ${quote(state)}/credential-$name-created; fi; done; if [ ! -s ${quote(`${CREDENTIALS}/admin_username`)} ]; then umask 077; printf 'admin_%s\n' "$(openssl rand -hex 8)" > ${quote(`${CREDENTIALS}/admin_username`)}; : > ${quote(`${state}/credential-admin_username-created`)}; fi; chmod 0600 ${quote(CREDENTIALS)}/*`
}

function installRuntime (state) {
  const extensions = ['bcmath', 'ctype', 'curl', 'dom', 'fileinfo', 'filter', 'ftp', 'gd', 'iconv', 'intl', 'mbstring', 'mysqli', 'opcache', 'pdo', 'pdo_mysql', 'phar', 'posix', 'session', 'simplexml', 'soap', 'sockets', 'sodium', 'tokenizer', 'xml', 'xmlreader', 'xmlwriter', 'xsl', 'zip', 'zlib'].map(name => `php84-${name}-8.4.24`).join(' ')
  return `set -eu; env ASSUME_ALWAYS_YES=yes pkg install -y php84-8.4.24 php84-composer-2.10.2 ${extensions} mariadb114-server-11.4.12 opensearch219-2.19.5 valkey8-8.1.8 nginx; pkg query -a '%n' | LC_ALL=C sort -u > ${quote(`${state}/packages.after`)}; LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} > ${quote(`${state}/packages.added`)}; php -r 'exit(PHP_VERSION_ID >= 80400 && PHP_VERSION_ID < 80500 ? 0 : 1);'; COMPOSER_ALLOW_SUPERUSER=1 composer --version | grep -F '2.10.2'; /usr/local/libexec/mariadbd --version | grep -F '11.4.12'; /usr/local/lib/opensearch/bin/opensearch --version | grep -F '2.19.5'; valkey-server --version | grep -F '8.1.8'`
}

function installSource (state) {
  const installed = `${state}/application-installed`
  return `if [ -e ${quote(installed)} ]; then cd ${quote(APP_ROOT)}; php bin/magento --version | grep -F ${quote(VERSION)}; exit 0; fi; ${installSourceFresh(state)}; : > ${quote(installed)}`
}

function installSourceFresh (state) {
  const archive = `${state}/magento-${VERSION}.tar.gz`
  return `set -eu; rm -rf -- ${quote(APP_ROOT)}; install -d -o root -g wheel -m 0755 ${quote(APP_ROOT)}; curl --fail --location --silent --show-error https://github.com/magento/magento2/archive/refs/tags/${VERSION}.tar.gz --output ${quote(archive)}; [ "$(sha256 -q ${quote(archive)})" = ${quote(ARCHIVE_SHA256)} ]; tar -xzf ${quote(archive)} -C ${quote(APP_ROOT)} --strip-components 1; cd ${quote(APP_ROOT)}; export COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_CACHE_DIR=${quote(`${state}/composer-cache`)}; composer install --no-dev --prefer-dist --no-interaction --no-progress --no-ansi --optimize-autoloader; rm -rf -- ${quote(`${state}/composer-cache`)}; php bin/magento --version | grep -F ${quote(VERSION)}; chmod -R a+rX ${quote(APP_ROOT)}`
}

function initializeServices () {
  return `set -eu; pw groupshow webminai_magento >/dev/null 2>&1 || pw groupadd webminai_magento; pw usershow webminai_magento >/dev/null 2>&1 || pw useradd webminai_magento -g webminai_magento -d ${quote(DATA_ROOT)} -s /usr/sbin/nologin -c 'Intent AI Ops Magento'; install -d -o root -g wheel -m 0755 ${quote(DATA_ROOT)}; install -d -o mysql -g mysql -m 0750 ${quote(`${DATA_ROOT}/mysql`)} ${quote(`${DATA_ROOT}/mysql-run`)}; cat > ${quote(`${DATA_ROOT}/my.cnf`)} <<'CONF'
[mariadbd]
user=mysql
datadir=${DATA_ROOT}/mysql
bind-address=127.0.0.1
port=53308
socket=${DATA_ROOT}/mysql-run/mysql.sock
pid-file=${DATA_ROOT}/mysql-run/mysql.pid
log-error=${DATA_ROOT}/mysql/mariadb.log
skip-name-resolve
character-set-server=utf8mb4
collation-server=utf8mb4_unicode_ci
innodb-buffer-pool-size=128M
max-connections=50
CONF
chown mysql:mysql ${quote(`${DATA_ROOT}/my.cnf`)}; chmod 0640 ${quote(`${DATA_ROOT}/my.cnf`)}; cat > ${quote(MYSQL_RC)} <<'RC'
#!/bin/sh
# PROVIDE: webminai_magento_mysql
# REQUIRE: NETWORKING
# KEYWORD: shutdown
. /etc/rc.subr
name=webminai_magento_mysql
rcvar=webminai_magento_mysql_enable
pidfile=${DATA_ROOT}/mysql-run/mariadb-supervisor.pid
procname=/usr/local/libexec/mariadbd
command=/usr/sbin/daemon
command_args="-u mysql -p $pidfile -o ${DATA_ROOT}/mysql/mariadb-service.log -m 3 -f /usr/local/libexec/mariadbd --defaults-file=${DATA_ROOT}/my.cnf"
load_rc_config $name
: \${webminai_magento_mysql_enable:=YES}
run_rc_command "$1"
RC
chmod 0755 ${quote(MYSQL_RC)}; if [ ! -d ${quote(`${DATA_ROOT}/mysql/mysql`)} ]; then mariadb-install-db --defaults-file=${quote(`${DATA_ROOT}/my.cnf`)} --user=mysql >/dev/null; fi; service webminai_magento_mysql status >/dev/null 2>&1 && service webminai_magento_mysql restart || service webminai_magento_mysql start; ${waitMariaDb()}; password=$(cat ${quote(`${CREDENTIALS}/database_password`)}); umask 077; cat > ${quote(`${DATA_ROOT}/bootstrap.sql`)} <<SQL
CREATE DATABASE IF NOT EXISTS ${DATABASE} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DATABASE_USER}'@'127.0.0.1' IDENTIFIED BY '$password';
ALTER USER '${DATABASE_USER}'@'127.0.0.1' IDENTIFIED BY '$password';
GRANT ALL PRIVILEGES ON ${DATABASE}.* TO '${DATABASE_USER}'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
mariadb --protocol=SOCKET --socket=${quote(`${DATA_ROOT}/mysql-run/mysql.sock`)} < ${quote(`${DATA_ROOT}/bootstrap.sql`)}; rm -f -- ${quote(`${DATA_ROOT}/bootstrap.sql`)}; install -d -o opensearch -g opensearch -m 0750 ${quote(`${DATA_ROOT}/opensearch`)} ${quote(`${DATA_ROOT}/opensearch-logs`)}; install -d -o opensearch -g opensearch -m 0750 /usr/local/etc/opensearch/jvm.options.d; cat > ${quote(OPENSEARCH_CONFIG)} <<'CONF'
cluster.name: webminai-magento
node.name: webminai-magento
path.data: ${DATA_ROOT}/opensearch
path.logs: ${DATA_ROOT}/opensearch-logs
network.host: 127.0.0.1
http.port: 19208
discovery.type: single-node
plugins.security.disabled: true
cluster.routing.allocation.disk.threshold_enabled: false
CONF
printf '%s\n' '-Xms384m' '-Xmx384m' > ${quote(OPENSEARCH_JVM)}; chown -R opensearch:opensearch /usr/local/etc/opensearch ${quote(`${DATA_ROOT}/opensearch`)} ${quote(`${DATA_ROOT}/opensearch-logs`)}; service opensearch status >/dev/null 2>&1 && service opensearch restart || service opensearch onestart; ${waitOpenSearch()}; install -d -o valkey -g valkey -m 0750 ${quote(`${DATA_ROOT}/valkey`)}; cat > ${quote(VALKEY_CONFIG)} <<'CONF'
bind 127.0.0.1
port 16379
daemonize yes
pidfile /var/run/valkey/valkey.pid
dir ${DATA_ROOT}/valkey
save ""
appendonly no
maxmemory 64mb
maxmemory-policy allkeys-lru
CONF
chown valkey:valkey ${quote(VALKEY_CONFIG)}; chmod 0640 ${quote(VALKEY_CONFIG)}; service valkey status >/dev/null 2>&1 && service valkey restart || service valkey onestart; ready=; for attempt in $(jot 60); do valkey-cli -p 16379 ping 2>/dev/null | grep -Fxq PONG && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]`
}

function configureRuntime () {
  return `set -eu; install -d -o webminai_magento -g www -m 0750 ${quote(`${DATA_ROOT}/php-run`)}; install -d -o webminai_magento -g webminai_magento -m 0770 ${quote(`${APP_ROOT}/generated`)} ${quote(`${APP_ROOT}/pub/static`)} ${quote(`${APP_ROOT}/pub/media`)} ${quote(`${APP_ROOT}/var`)} ${quote(`${APP_ROOT}/app/etc`)}; chown -R webminai_magento:webminai_magento ${quote(`${APP_ROOT}/generated`)} ${quote(`${APP_ROOT}/pub/static`)} ${quote(`${APP_ROOT}/pub/media`)} ${quote(`${APP_ROOT}/var`)} ${quote(`${APP_ROOT}/app/etc`)}; cat > ${quote(PHP_CONFIG)} <<'CONF'
memory_limit=2G
max_execution_time=1800
date.timezone=UTC
realpath_cache_size=10M
opcache.enable=1
opcache.enable_cli=1
CONF
cat > ${quote(PHP_FPM_CONFIG)} <<'CONF'
[www]
user = webminai_magento
group = webminai_magento
listen = ${DATA_ROOT}/php-run/php-fpm.sock
listen.owner = www
listen.group = www
listen.mode = 0660
pm = dynamic
pm.max_children = 2
pm.start_servers = 1
pm.min_spare_servers = 1
pm.max_spare_servers = 1
clear_env = no
CONF
cat > ${quote(NGINX_CONFIG)} <<'CONF'
user www www;
worker_processes 1;
events { worker_connections 256; }
http { upstream fastcgi_backend { server unix:${DATA_ROOT}/php-run/php-fpm.sock; } server { listen 18108; server_name _; set $MAGE_ROOT ${APP_ROOT}; set $MAGE_DEBUG_SHOW_ARGS 0; include ${APP_ROOT}/nginx.conf.sample; } }
CONF
cat > ${quote(CRON_CONFIG)} <<'CONF'
* * * * * webminai_magento /usr/local/bin/php ${APP_ROOT}/bin/magento cron:run --no-ansi --quiet >/dev/null 2>&1
CONF
chmod 0644 ${quote(PHP_CONFIG)} ${quote(PHP_FPM_CONFIG)} ${quote(NGINX_CONFIG)} ${quote(CRON_CONFIG)}; php-fpm -t; nginx -t; service php_fpm status >/dev/null 2>&1 && service php_fpm restart || service php_fpm onestart; service nginx status >/dev/null 2>&1 && service nginx onerestart || service nginx onestart; service cron restart`
}

function initializeMagento (state) {
  const initialized = `${state}/application-initialized`
  return `if [ -e ${quote(initialized)} ]; then cd ${quote(APP_ROOT)}; php bin/magento --version | grep -F ${quote(VERSION)}; exit 0; fi; ${initializeMagentoFresh()}; : > ${quote(initialized)}`
}

function initializeMagentoFresh () {
  const installer = `${DATA_ROOT}/installer-argv.php`
  const marker = `${DATA_ROOT}/marker.php`
  return String.raw`set -eu; ${primaryAddress()}; install -o webminai_magento -g webminai_magento -m 0400 ${quote(`${CREDENTIALS}/database_password`)} ${quote(`${DATA_ROOT}/database_password`)}; install -o webminai_magento -g webminai_magento -m 0400 ${quote(`${CREDENTIALS}/admin_username`)} ${quote(`${DATA_ROOT}/admin_username`)}; install -o webminai_magento -g webminai_magento -m 0400 ${quote(`${CREDENTIALS}/admin_password`)} ${quote(`${DATA_ROOT}/admin_password`)}; cat > ${quote(installer)} <<'PHP'
<?php
$files = ['db-password' => '${DATA_ROOT}/database_password', 'admin-user' => '${DATA_ROOT}/admin_username', 'admin-password' => '${DATA_ROOT}/admin_password'];
foreach ($files as $option => $path) { $argv[] = '--' . $option . '=' . trim((string) file_get_contents($path)); }
$argc = count($argv); $_SERVER['argv'] = $argv; $_SERVER['argc'] = $argc; $GLOBALS['argv'] = $argv; $GLOBALS['argc'] = $argc;
PHP
chown webminai_magento:webminai_magento ${quote(installer)}; chmod 0400 ${quote(installer)}; cd ${quote(APP_ROOT)}; if [ ! -s app/etc/env.php ]; then su -m webminai_magento -c "WEBMINAI_MAGENTO_URL=http://$address:18108/ php -d memory_limit=2G -d auto_prepend_file=${installer} bin/magento setup:install --no-interaction --no-ansi --quiet --cleanup-database --base-url=\"http://$address:18108/\" --db-host=127.0.0.1:53308 --db-name=${DATABASE} --db-user=${DATABASE_USER} --backend-frontname=webminai_admin --admin-firstname=Intent AI Ops --admin-lastname=Administrator --admin-email=intentaiops@example.invalid --language=en_US --currency=USD --timezone=UTC --use-rewrites=1 --search-engine=opensearch --opensearch-host=127.0.0.1 --opensearch-port=19208 --opensearch-enable-auth=0 --session-save=redis --session-save-redis-host=127.0.0.1 --session-save-redis-port=16379 --session-save-redis-db=2 --cache-backend=redis --cache-backend-redis-server=127.0.0.1 --cache-backend-redis-port=16379 --cache-backend-redis-db=0 --page-cache=redis --page-cache-redis-server=127.0.0.1 --page-cache-redis-port=16379 --page-cache-redis-db=1" >/dev/null; fi; rm -f -- ${quote(`${DATA_ROOT}/database_password`)} ${quote(`${DATA_ROOT}/admin_username`)} ${quote(`${DATA_ROOT}/admin_password`)} ${quote(installer)}; su -m webminai_magento -c 'cd ${APP_ROOT} && php -d memory_limit=2G bin/magento setup:di:compile --no-ansi --quiet' >/dev/null; su -m webminai_magento -c 'cd ${APP_ROOT} && php -d memory_limit=2G bin/magento setup:static-content:deploy -f en_US --no-ansi --quiet' >/dev/null; cat > ${quote(marker)} <<'PHP'
<?php
use Magento\Framework\App\Bootstrap;
require '${APP_ROOT}/app/bootstrap.php';
$bootstrap = Bootstrap::create(BP, $_SERVER);
$objectManager = $bootstrap->getObjectManager();
$objectManager->get(Magento\Framework\App\State::class)->setAreaCode('adminhtml');
$page = $objectManager->create(Magento\Cms\Model\Page::class)->getCollection()->addFieldToFilter('identifier', 'home')->getFirstItem();
if (!$page->getId()) { throw new RuntimeException('home page missing'); }
$page->setTitle('${MARKER}')->setContent('<main><h1>${MARKER}</h1></main>')->setIsActive(true)->save();
PHP
chown webminai_magento:webminai_magento ${quote(marker)}; su -m webminai_magento -c 'cd ${APP_ROOT} && php ${marker}' >/dev/null; rm -f -- ${quote(marker)}; su -m webminai_magento -c 'cd ${APP_ROOT} && php bin/magento indexer:reindex --no-ansi --quiet' >/dev/null; su -m webminai_magento -c 'cd ${APP_ROOT} && php bin/magento cache:flush --no-ansi --quiet' >/dev/null; ${waitMagento()}`
}

function verify () {
  return `set -eu; cd ${quote(APP_ROOT)}; php bin/magento --version | grep -F ${quote(VERSION)}; test -S ${quote(`${DATA_ROOT}/php-run/php-fpm.sock`)}; ${waitMariaDb()}; ${waitOpenSearch()}; valkey-cli -p 16379 ping | grep -Fxq PONG; password=$(cat ${quote(`${CREDENTIALS}/database_password`)}); MYSQL_PWD="$password" mariadb --protocol=TCP -h 127.0.0.1 -P 53308 -u ${DATABASE_USER} ${DATABASE} --batch --skip-column-names -e "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE()), (SELECT COUNT(*) FROM admin_user), (SELECT COUNT(*) FROM cms_page WHERE title='${MARKER}')" | awk '$1 > 300 && $2 > 0 && $3 > 0 { ok=1 } END { exit !ok }'; php bin/magento indexer:status --no-ansi | grep -Fq Ready; ${waitMagento()}; service webminai_magento_mysql restart; ${waitMariaDb()}; service opensearch onerestart; ${waitOpenSearch()}; service valkey onerestart; service php_fpm onerestart; service nginx onerestart; ${waitMagento()}; service cron status >/dev/null`
}

function remove (state) {
  return `set -eu; service nginx onestop >/dev/null 2>&1 || true; service php_fpm onestop >/dev/null 2>&1 || true; service valkey onestop >/dev/null 2>&1 || true; service opensearch onestop >/dev/null 2>&1 || true; service webminai_magento_mysql stop >/dev/null 2>&1 || true; rm -f -- ${quote(MYSQL_RC)} ${quote(NGINX_CONFIG)} ${quote(PHP_FPM_CONFIG)} ${quote(PHP_CONFIG)} ${quote(OPENSEARCH_CONFIG)} ${quote(OPENSEARCH_JVM)} ${quote(VALKEY_CONFIG)} ${quote(CRON_CONFIG)}; rm -rf -- ${quote(APP_ROOT)} ${quote(DATA_ROOT)}; if [ -d ${quote(state)} ]; then for name in database_password admin_password admin_username; do [ ! -e ${quote(state)}/credential-$name-created ] || rm -f -- ${quote(CREDENTIALS)}/$name; done; [ -e ${quote(`${state}/credentials-preexisting`)} ] || rm -rf -- ${quote(CREDENTIALS)}; fi; if [ -s ${quote(`${state}/packages.added`)} ]; then while IFS= read -r package; do [ -z "$package" ] || env ASSUME_ALWAYS_YES=yes pkg delete -f -y "$package"; done < ${quote(`${state}/packages.added`)}; fi; if [ -d ${quote(state)} ]; then for identity in webminai_magento mysql opensearch valkey; do [ -e ${quote(state)}/user-$identity-preexisting ] || pw userdel "$identity" >/dev/null 2>&1 || true; [ -e ${quote(state)}/group-$identity-preexisting ] || pw groupdel "$identity" >/dev/null 2>&1 || true; done; fi; rm -rf -- ${quote(state)}`
}

function waitMariaDb () {
  return `ready=; for attempt in $(jot 120); do mariadb-admin --protocol=SOCKET --socket=${DATA_ROOT}/mysql-run/mysql.sock ping --silent >/dev/null 2>&1 && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]`
}

function waitOpenSearch () {
  return 'ready=; for attempt in $(jot 180); do curl --fail --silent --show-error --max-time 3 http://127.0.0.1:19208/_cluster/health >/dev/null 2>&1 && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]'
}

function waitMagento () {
  return `ready=; for attempt in $(jot 180); do response=$(mktemp); if curl --fail --location --silent --show-error --max-time 10 http://127.0.0.1:18108/ --output "$response" 2>/dev/null && grep -F ${quote(MARKER)} "$response" >/dev/null; then rm -f -- "$response"; ready=yes; break; fi; rm -f -- "$response"; sleep 3; done; [ "$ready" = yes ]`
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
