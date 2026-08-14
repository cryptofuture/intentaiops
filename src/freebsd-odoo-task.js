const COMMIT = '57ffa1abb6e1ed481b8bccc5db5534ea0ad2c6b5'
const ARCHIVE_SHA256 = '8b50552e622426f7260e9dd47feaeeb0c47900c7b7ce56a3101d1cb7a74f8580'
const APP_ROOT = '/usr/local/lib/webminai-odoo-18112'
const DATA_ROOT = '/var/db/webminai-odoo-18112'
const CREDENTIALS = '/root/odoo_credentials'
const ODOO_RC = '/usr/local/etc/rc.d/webminai_odoo'
const POSTGRES_RC = '/usr/local/etc/rc.d/webminai_odoo_postgresql'
const NGINX_CONFIG = '/usr/local/etc/nginx/nginx.conf'
const DATABASE = 'webminai_odoo_18112'
const DATABASE_USER = 'webminai_odoo'
const MARKER = 'WEBMINAI_ODOO_OK'

export function buildFreebsdOdooTask (taskId, freebsdExecution) {
  if (freebsdExecution?.platform !== 'freebsd') throw new Error('FreeBSD Odoo requires a FreeBSD execution inventory')
  const state = `/var/lib/webminai/task-state/${taskId}-odoo-freebsd`
  return {
    plan: {
      summary: 'Deploy a learned reversible native FreeBSD Odoo Community service',
      changeOverview: `Install pinned Odoo Community 19.0 source ${COMMIT.slice(0, 12)} with Python 3.12, isolated PostgreSQL 17, rc.d, protected credentials, and nginx on port 18112.`,
      modifiedFiles: [state, APP_ROOT, DATA_ROOT, CREDENTIALS, ODOO_RC, POSTGRES_RC, NGINX_CONFIG],
      assumptions: ['FreeBSD 15.1 amd64 with pkg and rc.d', 'Odoo 19 supports Python 3.10+ and PostgreSQL 13+; the pinned branch requirements include Python 3.12 selectors.'],
      warnings: ['Odoo documents Linux, Windows, and macOS source installation but not FreeBSD. This learned native route is Intent AI Ops-tested and not an upstream-supported FreeBSD package.', 'PDF header/footer rendering is not tested because the upstream-compatible wkhtmltopdf build is unavailable in this isolated lab route.'],
      commands: [
        item('prepare-odoo', prepare(state), 'Capture package and identity baselines and generate database and administrator credentials on-host'),
        item('install-odoo-runtime', installRuntime(state), 'Install exact Python 3.12, PostgreSQL 17, nginx, and native build dependencies', ['prepare-odoo'], 3600000, 'job'),
        item('install-odoo-application', installApplication(state), 'Install checksum-pinned Odoo Community source and its exact Python dependency matrix in an isolated virtual environment', ['install-odoo-runtime'], 3600000, 'job'),
        item('initialize-odoo-database', initializeDatabase(), 'Initialize isolated PostgreSQL and the least-privilege Odoo database role', ['install-odoo-runtime', 'prepare-odoo'], 900000, 'job'),
        item('configure-odoo', configure(), 'Initialize the Odoo database and administrator, then create rc.d and nginx services', ['install-odoo-application', 'initialize-odoo-database'], 1200000, 'job'),
        item('verify-odoo', verify(), 'Verify Odoo release, database state, HTTP marker, and restart recovery', ['configure-odoo'], 900000, 'job')
      ],
      revertCommands: [item('remove-odoo', remove(state), 'Remove only task-owned Odoo, PostgreSQL, credentials, identities, and packages', [], 1800000, 'job', 'destructive')]
    },
    verifyApplied: `set -eu; ${primaryAddress()}; curl --fail --silent --show-error --max-time 20 http://$address:18112/ | grep -Fx ${MARKER}; curl --fail --location --silent --show-error --max-time 20 http://$address:18112/odoo/web/login >/dev/null`,
    verifyReverted: `test ! -e ${quote(APP_ROOT)} && test ! -e ${quote(DATA_ROOT)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)} && ! pkg info -e postgresql17-server >/dev/null 2>&1 && ! pkg info -e nginx >/dev/null 2>&1`,
    stateProbe: `test -e ${quote(state)} && printf applied || printf absent`
  }
}

function prepare (state) {
  return `[ ! -d ${quote(state)} ] || exit 0; ${prepareFresh(state)}`
}

function prepareFresh (state) {
  return `set -eu; test "$(uname -s)" = FreeBSD; for package in postgresql17-server nginx; do pkg info -e "$package" >/dev/null 2>&1 && { echo "pre-existing $package is outside task ownership" >&2; exit 1; } || true; done; for path in ${quote(APP_ROOT)} ${quote(DATA_ROOT)} ${quote(ODOO_RC)} ${quote(POSTGRES_RC)}; do test ! -e "$path"; done; install -d -m 0700 ${quote(state)}; pkg query -a '%n' | LC_ALL=C sort -u > ${quote(`${state}/packages.before`)}; for identity in webminai_odoo postgres; do pw usershow "$identity" >/dev/null 2>&1 && : > ${quote(state)}/user-$identity-preexisting || true; pw groupshow "$identity" >/dev/null 2>&1 && : > ${quote(state)}/group-$identity-preexisting || true; done; if [ -e ${quote(CREDENTIALS)} ]; then : > ${quote(`${state}/credentials-preexisting`)}; else install -d -m 0700 ${quote(CREDENTIALS)}; fi; for name in database_password admin_password master_password; do if [ ! -s ${quote(CREDENTIALS)}/$name ]; then umask 077; openssl rand -hex 32 > ${quote(CREDENTIALS)}/$name; : > ${quote(state)}/credential-$name-created; fi; done; if [ ! -s ${quote(`${CREDENTIALS}/admin_username`)} ]; then umask 077; printf 'webminai_%s\n' "$(openssl rand -hex 8)" > ${quote(`${CREDENTIALS}/admin_username`)}; : > ${quote(`${state}/credential-admin_username-created`)}; fi; chmod 0600 ${quote(CREDENTIALS)}/*`
}

function installRuntime (state) {
  return `set -eu; env ASSUME_ALWAYS_YES=yes pkg install -y python312 py312-pip-23.3.2_4 postgresql17-server-17.10 nginx git gmake pkgconf rust openldap26-client cyrus-sasl libxml2 libxslt jpeg-turbo freetype2 libffi libev; pkg query -a '%n' | LC_ALL=C sort -u > ${quote(`${state}/packages.after`)}; LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} > ${quote(`${state}/packages.added`)}; python3.12 -c 'import sys; assert sys.version_info[:2] == (3, 12)'; postgres --version | grep -F '17.10'`
}

function installApplication (state) {
  const archive = `${state}/odoo-${COMMIT}.tar.gz`
  return `set -eu; rm -rf -- ${quote(APP_ROOT)}; install -d -o root -g wheel -m 0755 ${quote(APP_ROOT)}; curl --fail --location --silent --show-error https://github.com/odoo/odoo/archive/${COMMIT}.tar.gz --output ${quote(archive)}; [ "$(sha256 -q ${quote(archive)})" = ${quote(ARCHIVE_SHA256)} ]; tar -xzf ${quote(archive)} -C ${quote(APP_ROOT)} --strip-components 1; python3.12 -m venv ${quote(`${APP_ROOT}/venv`)}; export CFLAGS='-I/usr/local/include' CPPFLAGS='-I/usr/local/include' LDFLAGS='-L/usr/local/lib' MAKE=gmake PIP_CACHE_DIR=${quote(`${state}/pip-cache`)} GEVENTSETUP_EMBED_LIBEV=0; ${quote(`${APP_ROOT}/venv/bin/pip`)} install --disable-pip-version-check --no-input --upgrade pip setuptools wheel; ${quote(`${APP_ROOT}/venv/bin/pip`)} install --disable-pip-version-check --no-input 'Cython==0.29.37' 'greenlet==3.0.3'; ${quote(`${APP_ROOT}/venv/bin/pip`)} install --disable-pip-version-check --no-input --no-build-isolation 'gevent==24.2.1'; ${quote(`${APP_ROOT}/venv/bin/pip`)} install --disable-pip-version-check --no-input -r ${quote(`${APP_ROOT}/requirements.txt`)}; rm -rf -- ${quote(`${state}/pip-cache`)}; ${quote(`${APP_ROOT}/venv/bin/python`)} ${quote(`${APP_ROOT}/odoo-bin`)} --version | grep -F 'Odoo Server 19.0'; chmod -R a+rX ${quote(APP_ROOT)}`
}

function initializeDatabase () {
  return `set -eu; root=${quote(DATA_ROOT)}; install -d -o root -g wheel -m 0755 "$root"; install -d -o postgres -g postgres -m 0700 "$root/postgres"; install -d -o postgres -g postgres -m 0750 "$root/postgres-run"; if [ ! -s "$root/postgres/PG_VERSION" ]; then su -m postgres -c '/usr/local/bin/initdb -D ${DATA_ROOT}/postgres --encoding=UTF8 --locale=C --auth-local=trust --auth-host=scram-sha-256' >/dev/null; cat >> "$root/postgres/postgresql.conf" <<'CONF'
listen_addresses = '127.0.0.1'
port = 55433
unix_socket_directories = '${DATA_ROOT}/postgres-run'
password_encryption = 'scram-sha-256'
CONF
printf '%s\n' 'host ${DATABASE} ${DATABASE_USER} 127.0.0.1/32 scram-sha-256' >> "$root/postgres/pg_hba.conf"; fi; cat > ${quote(POSTGRES_RC)} <<'RC'
#!/bin/sh
# PROVIDE: webminai_odoo_postgresql
# REQUIRE: NETWORKING
# KEYWORD: shutdown
. /etc/rc.subr
name=webminai_odoo_postgresql
rcvar=webminai_odoo_postgresql_enable
start_cmd=webminai_odoo_postgresql_start
stop_cmd=webminai_odoo_postgresql_stop
status_cmd=webminai_odoo_postgresql_status
webminai_odoo_postgresql_start() { su -m postgres -c '/usr/local/bin/pg_ctl -D ${DATA_ROOT}/postgres -w start'; }
webminai_odoo_postgresql_stop() { su -m postgres -c '/usr/local/bin/pg_ctl -D ${DATA_ROOT}/postgres -w stop -m fast'; }
webminai_odoo_postgresql_status() { su -m postgres -c '/usr/local/bin/pg_ctl -D ${DATA_ROOT}/postgres status'; }
load_rc_config $name
: \${webminai_odoo_postgresql_enable:=YES}
run_rc_command "$1"
RC
chmod 0755 ${quote(POSTGRES_RC)}; service webminai_odoo_postgresql status >/dev/null 2>&1 || service webminai_odoo_postgresql start; password=$(cat ${quote(`${CREDENTIALS}/database_password`)}); if printf "%s\n" "SELECT 1 FROM pg_roles WHERE rolname='${DATABASE_USER}'" | su -m postgres -c '/usr/local/bin/psql -p 55433 -h ${DATA_ROOT}/postgres-run -At postgres' | grep -Fxq 1; then action=ALTER; else action=CREATE; fi; umask 077; printf "%s ROLE ${DATABASE_USER} LOGIN CREATEDB PASSWORD '%s';\n" "$action" "$password" > "$root/bootstrap.sql"; chown postgres:postgres "$root/bootstrap.sql"; su -m postgres -c '/usr/local/bin/psql -p 55433 -h ${DATA_ROOT}/postgres-run -v ON_ERROR_STOP=1 -f ${DATA_ROOT}/bootstrap.sql postgres' >/dev/null; rm -f -- "$root/bootstrap.sql"`
}

function configure () {
  return `export CRYPTOGRAPHY_OPENSSL_NO_LEGACY=1; ${configureWithCompatibleOpenSsl()}`
}

function configureWithCompatibleOpenSsl () {
  return `set -eu; pw groupshow webminai_odoo >/dev/null 2>&1 || pw groupadd webminai_odoo; pw usershow webminai_odoo >/dev/null 2>&1 || pw useradd webminai_odoo -g webminai_odoo -d ${quote(DATA_ROOT)} -s /usr/sbin/nologin -c 'Intent AI Ops Odoo'; install -d -o webminai_odoo -g webminai_odoo -m 0750 ${quote(`${DATA_ROOT}/data`)} ${quote(`${DATA_ROOT}/run`)}; password=$(cat ${quote(`${CREDENTIALS}/database_password`)}); master=$(cat ${quote(`${CREDENTIALS}/master_password`)}); cat > ${quote(`${DATA_ROOT}/odoo.conf`)} <<CONF
[options]
admin_passwd = $master
db_host = 127.0.0.1
db_port = 55433
db_user = ${DATABASE_USER}
db_password = $password
db_name = ${DATABASE}
data_dir = ${DATA_ROOT}/data
addons_path = ${APP_ROOT}/addons
http_interface = 127.0.0.1
http_port = 8069
proxy_mode = True
list_db = False
without_demo = all
CONF
chown webminai_odoo:webminai_odoo ${quote(`${DATA_ROOT}/odoo.conf`)}; chmod 0600 ${quote(`${DATA_ROOT}/odoo.conf`)}; su -m webminai_odoo -c '${APP_ROOT}/venv/bin/python ${APP_ROOT}/odoo-bin -c ${DATA_ROOT}/odoo.conf -d ${DATABASE} -i base --stop-after-init --without-demo=all' >/dev/null; install -o webminai_odoo -g webminai_odoo -m 0400 ${quote(`${CREDENTIALS}/admin_username`)} ${quote(`${DATA_ROOT}/admin_username`)}; install -o webminai_odoo -g webminai_odoo -m 0400 ${quote(`${CREDENTIALS}/admin_password`)} ${quote(`${DATA_ROOT}/admin_password`)}; cat > ${quote(`${DATA_ROOT}/set-admin.py`)} <<'PY'
username = open('${DATA_ROOT}/admin_username').read().strip()
password = open('${DATA_ROOT}/admin_password').read().strip()
env.ref('base.user_admin').write({'login': username, 'password': password})
env.cr.commit()
PY
chown webminai_odoo:webminai_odoo ${quote(`${DATA_ROOT}/set-admin.py`)}; chmod 0400 ${quote(`${DATA_ROOT}/set-admin.py`)}; su -m webminai_odoo -c '${APP_ROOT}/venv/bin/python ${APP_ROOT}/odoo-bin shell -c ${DATA_ROOT}/odoo.conf -d ${DATABASE} < ${DATA_ROOT}/set-admin.py' >/dev/null; rm -f -- ${quote(`${DATA_ROOT}/admin_username`)} ${quote(`${DATA_ROOT}/admin_password`)} ${quote(`${DATA_ROOT}/set-admin.py`)}; cat > ${quote(ODOO_RC)} <<'RC'
#!/bin/sh
# PROVIDE: webminai_odoo
# REQUIRE: webminai_odoo_postgresql
# KEYWORD: shutdown
. /etc/rc.subr
export CRYPTOGRAPHY_OPENSSL_NO_LEGACY=1
name=webminai_odoo
rcvar=webminai_odoo_enable
pidfile=${DATA_ROOT}/run/odoo.pid
procname=${APP_ROOT}/venv/bin/python
command=/usr/sbin/daemon
command_args="-u webminai_odoo -p $pidfile -o ${DATA_ROOT}/odoo.log -m 3 -f ${APP_ROOT}/venv/bin/python ${APP_ROOT}/odoo-bin -c ${DATA_ROOT}/odoo.conf"
load_rc_config $name
: \${webminai_odoo_enable:=YES}
run_rc_command "$1"
RC
chmod 0755 ${quote(ODOO_RC)}; cat > ${quote(NGINX_CONFIG)} <<'CONF'
user www www;
worker_processes 1;
events { worker_connections 256; }
http { server { listen 18112; location = / { default_type text/plain; return 200 "${MARKER}\n"; } location /odoo/ { proxy_pass http://127.0.0.1:8069/; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; } } }
CONF
chmod 0644 ${quote(NGINX_CONFIG)}; service webminai_odoo status >/dev/null 2>&1 && service webminai_odoo restart || service webminai_odoo start; ${waitOdoo()}; nginx -t; service nginx status >/dev/null 2>&1 && service nginx onerestart || service nginx onestart`
}

function verify () {
  return `set -eu; ${quote(`${APP_ROOT}/venv/bin/python`)} ${quote(`${APP_ROOT}/odoo-bin`)} --version | grep -F 'Odoo Server 19.0'; ${waitOdoo()}; password=$(cat ${quote(`${CREDENTIALS}/database_password`)}); PGPASSWORD="$password" psql -h 127.0.0.1 -p 55433 -U ${DATABASE_USER} -d ${DATABASE} -Atqc "SELECT count(*) FROM ir_module_module" | awk '$1 > 0 { ok=1 } END { exit !ok }'; curl --fail --silent --show-error http://127.0.0.1:18112/ | grep -Fx ${quote(MARKER)}; curl --fail --location --silent --show-error http://127.0.0.1:18112/odoo/web/login >/dev/null; service webminai_odoo restart; ${waitOdoo()}; service webminai_odoo_postgresql restart; service webminai_odoo restart; ${waitOdoo()}`
}

function remove (state) {
  return `set -eu; service nginx onestop >/dev/null 2>&1 || true; service webminai_odoo stop >/dev/null 2>&1 || true; service webminai_odoo_postgresql stop >/dev/null 2>&1 || true; rm -f -- ${quote(ODOO_RC)} ${quote(POSTGRES_RC)} ${quote(NGINX_CONFIG)}; rm -rf -- ${quote(APP_ROOT)} ${quote(DATA_ROOT)}; if [ -d ${quote(state)} ]; then for name in database_password admin_password master_password admin_username; do [ ! -e ${quote(state)}/credential-$name-created ] || rm -f -- ${quote(CREDENTIALS)}/$name; done; [ -e ${quote(`${state}/credentials-preexisting`)} ] || rm -rf -- ${quote(CREDENTIALS)}; fi; if [ -s ${quote(`${state}/packages.added`)} ]; then while IFS= read -r package; do [ -z "$package" ] || env ASSUME_ALWAYS_YES=yes pkg delete -f -y "$package"; done < ${quote(`${state}/packages.added`)}; fi; if [ -d ${quote(state)} ]; then for identity in webminai_odoo postgres; do [ -e ${quote(state)}/user-$identity-preexisting ] || pw userdel "$identity" >/dev/null 2>&1 || true; [ -e ${quote(state)}/group-$identity-preexisting ] || pw groupdel "$identity" >/dev/null 2>&1 || true; done; fi; rmdir /usr/local/etc/nginx >/dev/null 2>&1 || true; rm -rf -- ${quote(state)}`
}

function waitOdoo () {
  return 'ready=; for attempt in $(jot 180); do curl --fail --location --silent --show-error --max-time 3 http://127.0.0.1:8069/web/login >/dev/null 2>&1 && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]'
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
