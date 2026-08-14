const VERSION = '6.57.0'
const APP_ROOT = '/usr/local/lib/webminai-ghost-18110'
const DATA_ROOT = '/var/db/webminai-ghost-18110'
const CREDENTIALS = '/root/ghost_credentials'
const GHOST_RC = '/usr/local/etc/rc.d/webminai_ghost'
const MYSQL_RC = '/usr/local/etc/rc.d/webminai_ghost_mysql'
const NGINX_CONFIG = '/usr/local/etc/nginx/nginx.conf'
const DATABASE = 'webminai_ghost_18110'
const DATABASE_USER = 'webminai_ghost'
const MARKER = 'WEBMINAI_GHOST_OK'
const ARCHIVE_SHA256 = 'e2022f6b054b77722de98817c042a9fb1d2156ba4dc75dc36ec9ba0c2688c40c'

export function buildFreebsdGhostTask (taskId, freebsdExecution) {
  if (freebsdExecution?.platform !== 'freebsd') throw new Error('FreeBSD Ghost requires a FreeBSD execution inventory')
  const state = `/var/lib/webminai/task-state/${taskId}-ghost-freebsd`
  return {
    plan: {
      summary: 'Deploy a learned reversible native FreeBSD Ghost site',
      changeOverview: `Install Ghost ${VERSION} with FreeBSD Node.js 22, isolated Oracle MySQL 8 data, rc.d services, protected database credentials, and nginx on port 18110.`,
      modifiedFiles: [state, APP_ROOT, DATA_ROOT, CREDENTIALS, GHOST_RC, MYSQL_RC, NGINX_CONFIG],
      assumptions: ['FreeBSD 15.1 amd64 with pkg and rc.d', 'The selected FreeBSD Node.js 22 and Oracle MySQL 8 packages satisfy the Ghost 6 production runtime matrix.'],
      warnings: ['Ghost officially supports Ubuntu 24 for production. This learned native FreeBSD route is community-tested by Intent AI Ops and is not an upstream-supported Ghost platform.', 'This controlled validation publishes the marker and Ghost under TCP port 18110 without DNS or TLS.'],
      commands: [
        item('prepare-ghost', prepare(state), 'Capture package and identity baselines and generate the database password on-host'),
        item('install-ghost-runtime', installRuntime(state), 'Install exact FreeBSD Node.js 22, Oracle MySQL 8, nginx, and native build prerequisites', ['prepare-ghost'], 1800000, 'job'),
        item('install-ghost-application', installApplication(state), `Install exact Ghost ${VERSION} from the npm registry and validate the packaged runtime`, ['install-ghost-runtime'], 3600000, 'job'),
        item('initialize-ghost-database', initializeDatabase(), 'Initialize isolated MySQL storage and the least-privilege Ghost database account', ['install-ghost-runtime', 'prepare-ghost'], 900000, 'job'),
        item('configure-ghost', configure(), 'Create the isolated Ghost identity, rc.d service, content storage, and nginx reverse proxy', ['install-ghost-application', 'initialize-ghost-database'], 900000, 'job'),
        item('verify-ghost', verify(), 'Verify Ghost version, MySQL persistence, web UI, external marker, and restart recovery', ['configure-ghost'], 900000, 'job')
      ],
      revertCommands: [item('remove-ghost', remove(state), 'Remove only task-owned Ghost services, storage, credentials, identities, and packages', [], 1800000, 'job', 'destructive')]
    },
    verifyApplied: `set -eu; ${primaryAddress()}; response=$(mktemp); trap 'rm -f -- "$response"' EXIT; curl --fail --silent --show-error --max-time 20 --output "$response" http://$address:18110/; grep -Fxq ${MARKER} "$response"; curl --fail --location --silent --show-error --max-time 20 http://$address:18110/blog/ >/dev/null`,
    verifyReverted: `test ! -e ${quote(APP_ROOT)} && test ! -e ${quote(DATA_ROOT)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)} && ! pkg info -e node22 >/dev/null 2>&1 && ! pkg info -e mysql80-server >/dev/null 2>&1 && ! pkg info -e nginx >/dev/null 2>&1`,
    stateProbe: `test -e ${quote(state)} && printf applied || printf absent`
  }
}

function prepare (state) {
  return `[ ! -d ${quote(state)} ] || exit 0; ${prepareFresh(state)}`
}

function prepareFresh (state) {
  return `set -eu; test "$(uname -s)" = FreeBSD; for package in node22 npm-node22 mysql80-server nginx; do pkg info -e "$package" >/dev/null 2>&1 && { echo "pre-existing $package is outside task ownership" >&2; exit 1; } || true; done; for path in ${quote(APP_ROOT)} ${quote(DATA_ROOT)} ${quote(GHOST_RC)} ${quote(MYSQL_RC)}; do test ! -e "$path"; done; install -d -m 0700 ${quote(state)}; pkg query -a '%n' | LC_ALL=C sort -u > ${quote(`${state}/packages.before`)}; for identity in webminai_ghost mysql; do pw usershow "$identity" >/dev/null 2>&1 && : > ${quote(state)}/user-$identity-preexisting || true; pw groupshow "$identity" >/dev/null 2>&1 && : > ${quote(state)}/group-$identity-preexisting || true; done; if [ -e ${quote(CREDENTIALS)} ]; then : > ${quote(`${state}/credentials-preexisting`)}; else install -d -m 0700 ${quote(CREDENTIALS)}; fi; if [ ! -s ${quote(`${CREDENTIALS}/database_password`)} ]; then umask 077; openssl rand -hex 32 > ${quote(`${CREDENTIALS}/database_password`)}; : > ${quote(`${state}/credential-created`)}; fi; chmod 0600 ${quote(`${CREDENTIALS}/database_password`)}`
}

function installRuntime (state) {
  return `set -eu; env ASSUME_ALWAYS_YES=yes pkg install -y node22-22.23.1 npm-node22-11.18.0 mysql80-server-8.0.46 nginx python312 gmake pkgconf; pkg query -a '%n' | LC_ALL=C sort -u > ${quote(`${state}/packages.after`)}; LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} > ${quote(`${state}/packages.added`)}; node -e 'const [major,minor,patch]=process.versions.node.split(".").map(Number); process.exit(major === 22 && (minor > 23 || minor === 23 && patch >= 1) ? 0 : 1)'; /usr/local/libexec/mysqld --version | grep -F 'Ver 8.0'`
}

function installApplication (state) {
  const archive = `${state}/ghost-${VERSION}.tgz`
  return `set -eu; rm -rf -- ${quote(APP_ROOT)}; install -d -o root -g wheel -m 0755 ${quote(APP_ROOT)}; install -d -o root -g wheel -m 0755 ${quote(`${state}/npm-cache`)} ${quote(`${state}/node-gyp`)} ${quote(`${state}/pnpm-store`)} ${quote(`${state}/corepack`)}; curl --fail --location --silent --show-error https://registry.npmjs.org/ghost/-/ghost-${VERSION}.tgz --output ${quote(archive)}; [ "$(sha256 -q ${quote(archive)})" = ${quote(ARCHIVE_SHA256)} ]; tar -xzf ${quote(archive)} -C ${quote(APP_ROOT)} --strip-components 1; export npm_config_cache=${quote(`${state}/npm-cache`)} npm_config_devdir=${quote(`${state}/node-gyp`)} npm_config_python=/usr/local/bin/python3.12 COREPACK_HOME=${quote(`${state}/corepack`)}; cd ${quote(APP_ROOT)}; corepack pnpm install --prod --frozen-lockfile --store-dir ${quote(`${state}/pnpm-store`)}; corepack pnpm add --prod --save-exact --ignore-workspace-root-check --store-dir ${quote(`${state}/pnpm-store`)} @img/sharp-freebsd-wasm32@0.35.3; node -p "require('./package.json').version" | grep -Fx ${quote(VERSION)}; node -e "require('mysql2'); require('sharp')"; chmod -R a+rX ${quote(APP_ROOT)}`
}

function initializeDatabase () {
  return `install -d -o root -g wheel -m 0755 ${quote(DATA_ROOT)}; [ -e ${quote(`${DATA_ROOT}/mysql.log`)} ] || install -o mysql -g mysql -m 0640 /dev/null ${quote(`${DATA_ROOT}/mysql.log`)}; ${initializeDatabaseFresh()}`
}

function initializeDatabaseFresh () {
  return `set -eu; root=${quote(DATA_ROOT)}; for old_pidfile in "$root/run/mysql.pid"; do if [ -s "$old_pidfile" ]; then old_pid=$(cat "$old_pidfile"); kill "$old_pid" >/dev/null 2>&1 || true; for attempt in $(jot 30); do kill -0 "$old_pid" >/dev/null 2>&1 || break; sleep 1; done; fi; done; install -d -o root -g wheel -m 0755 "$root"; install -d -o mysql -g mysql -m 0750 "$root/mysql" "$root/mysql-run"; cat > ${quote(`${DATA_ROOT}/my.cnf`)} <<'CONF'
[mysqld]
user=mysql
datadir=${DATA_ROOT}/mysql
bind-address=127.0.0.1
port=53306
socket=${DATA_ROOT}/mysql-run/mysql.sock
pid-file=${DATA_ROOT}/mysql-run/mysql.pid
log-error=${DATA_ROOT}/mysql.log
skip-name-resolve
character-set-server=utf8mb4
collation-server=utf8mb4_0900_ai_ci
CONF
chown mysql:mysql ${quote(`${DATA_ROOT}/my.cnf`)}; chmod 0640 ${quote(`${DATA_ROOT}/my.cnf`)}; cat > ${quote(MYSQL_RC)} <<'RC'
#!/bin/sh
# PROVIDE: webminai_ghost_mysql
# REQUIRE: NETWORKING
# KEYWORD: shutdown
. /etc/rc.subr
name=webminai_ghost_mysql
rcvar=webminai_ghost_mysql_enable
pidfile=${DATA_ROOT}/mysql-run/mysql.pid
command=/usr/local/libexec/mysqld
command_args="--defaults-file=${DATA_ROOT}/my.cnf --daemonize"
load_rc_config $name
: \${webminai_ghost_mysql_enable:=YES}
run_rc_command "$1"
RC
chmod 0755 ${quote(MYSQL_RC)}; if [ ! -s "$root/mysql/auto.cnf" ]; then /usr/local/libexec/mysqld --defaults-file="$root/my.cnf" --initialize-insecure; fi; if service webminai_ghost_mysql status >/dev/null 2>&1; then service webminai_ghost_mysql restart; else service webminai_ghost_mysql start; fi; ready=; for attempt in $(jot 120); do mysqladmin --protocol=TCP -h 127.0.0.1 -P 53306 ping --silent >/dev/null 2>&1 && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]; password=$(cat ${quote(`${CREDENTIALS}/database_password`)}); umask 077; cat > "$root/bootstrap.sql" <<SQL
CREATE DATABASE IF NOT EXISTS ${DATABASE} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS '${DATABASE_USER}'@'127.0.0.1' IDENTIFIED BY '$password';
ALTER USER '${DATABASE_USER}'@'127.0.0.1' IDENTIFIED BY '$password';
GRANT ALL PRIVILEGES ON ${DATABASE}.* TO '${DATABASE_USER}'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
mysql --protocol=SOCKET --socket="$root/mysql-run/mysql.sock" < "$root/bootstrap.sql"; rm -f -- "$root/bootstrap.sql"`
}

function configure () {
  return `set -eu; pw groupshow webminai_ghost >/dev/null 2>&1 || pw groupadd webminai_ghost; pw usershow webminai_ghost >/dev/null 2>&1 || pw useradd webminai_ghost -g webminai_ghost -d ${quote(DATA_ROOT)} -s /usr/sbin/nologin -c 'Intent AI Ops Ghost'; chown root:wheel ${quote(DATA_ROOT)}; chmod 0755 ${quote(DATA_ROOT)}; install -d -o webminai_ghost -g webminai_ghost -m 0750 ${quote(`${DATA_ROOT}/content`)} ${quote(`${DATA_ROOT}/ghost-run`)}; if [ ! -e ${quote(`${DATA_ROOT}/content/themes/source`)} ]; then cp -a ${quote(`${APP_ROOT}/content`)}//. ${quote(`${DATA_ROOT}/content`)}//; fi; chown -R webminai_ghost:webminai_ghost ${quote(`${DATA_ROOT}/content`)} ${quote(`${DATA_ROOT}/ghost-run`)}; ${primaryAddress()}; password=$(cat ${quote(`${CREDENTIALS}/database_password`)}); umask 077; cat > ${quote(`${APP_ROOT}/config.production.json`)} <<JSON
{"url":"http://$address:18110/blog/","server":{"host":"127.0.0.1","port":2368},"database":{"client":"mysql","connection":{"host":"127.0.0.1","port":53306,"user":"${DATABASE_USER}","password":"$password","database":"${DATABASE}"}},"paths":{"contentPath":"${DATA_ROOT}/content"},"logging":{"transports":["file"]},"privacy":{"useUpdateCheck":false}}
JSON
chown webminai_ghost:webminai_ghost ${quote(`${APP_ROOT}/config.production.json`)}; chmod 0600 ${quote(`${APP_ROOT}/config.production.json`)}; cat > ${quote(GHOST_RC)} <<'RC'
#!/bin/sh
# PROVIDE: webminai_ghost
# REQUIRE: webminai_ghost_mysql
# KEYWORD: shutdown
. /etc/rc.subr
name=webminai_ghost
rcvar=webminai_ghost_enable
pidfile=${DATA_ROOT}/ghost-run/ghost.pid
procname=/usr/local/bin/node
command=/usr/sbin/daemon
webminai_ghost_chdir=${APP_ROOT}
command_args="-u webminai_ghost -p $pidfile -o ${DATA_ROOT}/ghost.log -m 3 -f /usr/local/bin/node index.js"
start_precmd=webminai_ghost_precmd
webminai_ghost_precmd() { export NODE_ENV=production; }
load_rc_config $name
: \${webminai_ghost_enable:=YES}
run_rc_command "$1"
RC
chmod 0755 ${quote(GHOST_RC)}; cat > ${quote(NGINX_CONFIG)} <<'CONF'
user www www;
worker_processes 1;
events { worker_connections 256; }
http { server { listen 18110; location = / { default_type text/plain; return 200 "${MARKER}\n"; } location /blog/ { proxy_pass http://127.0.0.1:2368; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; } } }
CONF
chmod 0644 ${quote(NGINX_CONFIG)}; if service webminai_ghost status >/dev/null 2>&1; then service webminai_ghost restart; else service webminai_ghost start; fi; ${waitGhost()}; nginx -t; service nginx status >/dev/null 2>&1 && service nginx onerestart || service nginx onestart`
}

function verify () {
  return `set -eu; cd ${quote(APP_ROOT)}; node -p "require('./package.json').version" | grep -Fx ${quote(VERSION)}; ${waitGhost()}; password=$(cat ${quote(`${CREDENTIALS}/database_password`)}); MYSQL_PWD="$password" mysql --protocol=TCP -h 127.0.0.1 -P 53306 -u ${DATABASE_USER} ${DATABASE} --batch --skip-column-names -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE()" | awk '$1 > 0 { ok=1 } END { exit !ok }'; curl --fail --silent --show-error --max-time 5 http://127.0.0.1:18110/ | grep -Fx ${quote(MARKER)}; curl --fail --location --silent --show-error --max-time 20 http://127.0.0.1:18110/blog/ >/dev/null; service webminai_ghost restart; ${waitGhost()}; service webminai_ghost_mysql restart; ready=; for attempt in $(jot 120); do mysqladmin --protocol=TCP -h 127.0.0.1 -P 53306 ping --silent >/dev/null 2>&1 && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]; service webminai_ghost restart; ${waitGhost()}; service nginx status >/dev/null`
}

function remove (state) {
  return `set -eu; service nginx onestop >/dev/null 2>&1 || true; service webminai_ghost stop >/dev/null 2>&1 || true; service webminai_ghost_mysql stop >/dev/null 2>&1 || true; rm -f -- ${quote(GHOST_RC)} ${quote(MYSQL_RC)} ${quote(NGINX_CONFIG)}; rm -rf -- ${quote(APP_ROOT)} ${quote(DATA_ROOT)}; if [ -d ${quote(state)} ]; then [ ! -e ${quote(`${state}/credential-created`)} ] || rm -f -- ${quote(`${CREDENTIALS}/database_password`)}; [ -e ${quote(`${state}/credentials-preexisting`)} ] || rm -rf -- ${quote(CREDENTIALS)}; fi; if [ -s ${quote(`${state}/packages.added`)} ]; then while IFS= read -r package; do [ -z "$package" ] || env ASSUME_ALWAYS_YES=yes pkg delete -f -y "$package"; done < ${quote(`${state}/packages.added`)}; fi; if [ -d ${quote(state)} ]; then for identity in webminai_ghost mysql; do [ -e ${quote(state)}/user-$identity-preexisting ] || pw userdel "$identity" >/dev/null 2>&1 || true; [ -e ${quote(state)}/group-$identity-preexisting ] || pw groupdel "$identity" >/dev/null 2>&1 || true; done; fi; rmdir /usr/local/etc/nginx >/dev/null 2>&1 || true; rm -rf -- ${quote(state)}`
}

function waitGhost () {
  return 'ready=; for attempt in $(jot 180); do curl --fail --location --silent --show-error --max-time 3 http://127.0.0.1:2368/blog/ >/dev/null 2>&1 && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]'
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
