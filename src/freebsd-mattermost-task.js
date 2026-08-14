const VERSION = '11.7.3'
const PACKAGE_VERSION = '11.7.3_1'
const SERVICE_ROOT = '/var/db/webminai-mattermost-18111'
const CREDENTIALS = '/root/mattermost_credentials'
const MATTERMOST_RC = '/usr/local/etc/rc.d/webminai_mattermost'
const POSTGRES_RC = '/etc/rc.conf.d/postgresql'
const NGINX_CONFIG = '/usr/local/etc/nginx/nginx.conf'
const DATABASE = 'webminai_mattermost'
const DATABASE_USER = 'webminai_mattermost'
const MARKER = 'WEBMINAI_MATTERMOST_OK'

export function buildFreebsdMattermostTask (taskId, freebsdExecution) {
  if (freebsdExecution?.platform !== 'freebsd') throw new Error('FreeBSD Mattermost requires a FreeBSD execution inventory')
  const state = `/var/lib/webminai/task-state/${taskId}-mattermost-freebsd`
  return {
    plan: {
      summary: 'Deploy a learned reversible native FreeBSD Mattermost server',
      changeOverview: `Install FreeBSD-port Mattermost ${VERSION}, PostgreSQL 17, and nginx with protected bootstrap credentials on port 18111.`,
      modifiedFiles: [state, SERVICE_ROOT, CREDENTIALS, MATTERMOST_RC, POSTGRES_RC, NGINX_CONFIG],
      assumptions: ['FreeBSD 15.1 amd64 with pkg and rc.d', `FreeBSD package ${PACKAGE_VERSION} is the newest native Mattermost port currently available`],
      warnings: ['The FreeBSD port trails the ismet container release 11.7.8; this route is promoted independently as the current native FreeBSD version.', 'The controlled deployment does not configure SMTP, Calls, TLS, plugins, or public DNS.'],
      commands: [
        item('prepare-mattermost', prepare(state), 'Capture the package baseline and generate protected database and administrator credentials'),
        item('install-mattermost-runtime', installRuntime(state), 'Install exact Mattermost, PostgreSQL 17, nginx, and client packages', ['prepare-mattermost'], 1800000, 'job'),
        item('initialize-mattermost-database', initializeDatabase(), 'Initialize the isolated PostgreSQL cluster, role, and database from protected credentials', ['install-mattermost-runtime'], 900000, 'job'),
        item('configure-mattermost', configure(), 'Create the root-owned rc.d launcher, isolated storage, and nginx proxy', ['initialize-mattermost-database'], 600000, 'job'),
        item('initialize-mattermost-admin', initializeAdmin(), 'Create and promote the initial administrator without logging its password', ['configure-mattermost'], 600000, 'job'),
        item('verify-mattermost', verify(), 'Verify API health, database migrations, administrator, storage, and restart recovery', ['initialize-mattermost-admin'], 600000, 'job')
      ],
      revertCommands: [item('remove-mattermost', remove(state), 'Remove only task-owned Mattermost, PostgreSQL, proxy, packages, state, and credentials', [], 900000, 'job', 'destructive')]
    },
    verifyApplied: `${primaryAddress()}; response=$(mktemp); trap 'rm -f -- "$response"' EXIT; curl --fail --silent --show-error --max-time 20 --output "$response" http://$address:18111/; grep -Fxq ${MARKER} "$response"; curl --fail --silent --show-error --max-time 20 --output "$response" http://$address:18111/api/v4/system/ping; grep -Fq '"status":"OK"' "$response"`,
    verifyReverted: `test ! -e ${quote(SERVICE_ROOT)} && test ! -e ${quote(state)} && ! pkg info -e mattermost-server >/dev/null 2>&1`,
    stateProbe: `test -e ${quote(state)} && printf applied || printf absent`
  }
}

function prepare (state) {
  return `[ ! -d ${quote(state)} ] || exit 0; ${prepareFresh(state)}`
}

function prepareFresh (state) {
  return `set -eu; test "$(uname -s)" = FreeBSD; for package in mattermost-server postgresql17-server postgresql17-client nginx; do pkg info -e "$package" >/dev/null 2>&1 && { echo "pre-existing $package is outside task ownership" >&2; exit 1; } || true; done; for path in ${quote(SERVICE_ROOT)} ${quote(MATTERMOST_RC)} ${quote(POSTGRES_RC)}; do test ! -e "$path"; done; install -d -m 0700 ${quote(state)}; pkg query -a '%n' | LC_ALL=C sort -u > ${quote(`${state}/packages.before`)}; for identity in mattermost postgres; do pw usershow "$identity" >/dev/null 2>&1 && : > ${quote(state)}/user-$identity-preexisting || true; pw groupshow "$identity" >/dev/null 2>&1 && : > ${quote(state)}/group-$identity-preexisting || true; done; install -d -m 0755 ${quote(SERVICE_ROOT)}; if [ -e ${quote(CREDENTIALS)} ]; then : > ${quote(`${state}/credentials-preexisting`)}; else install -d -m 0700 ${quote(CREDENTIALS)}; fi; for name in database_password admin_password; do if [ ! -s ${quote(CREDENTIALS)}/$name ]; then umask 077; openssl rand -hex 32 > ${quote(CREDENTIALS)}/$name; : > ${quote(state)}/credential-$name-created; fi; done; chmod 0600 ${quote(CREDENTIALS)}/*`
}

function installRuntime (state) {
  return `set -eu; env ASSUME_ALWAYS_YES=yes pkg install -y mattermost-server-${PACKAGE_VERSION} postgresql17-server postgresql17-client nginx curl ca_root_nss; [ "$(pkg query '%v' mattermost-server)" = ${PACKAGE_VERSION} ]; pkg query -a '%n' | LC_ALL=C sort -u > ${quote(`${state}/packages.after`)}; LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} > ${quote(`${state}/packages.added`)}`
}

function initializeDatabase () {
  return `set -eu; root=${quote(SERVICE_ROOT)}; install -d -o postgres -g postgres -m 0700 "$root/db"; install -d -o postgres -g postgres -m 0750 "$root/pg-run"; cat > ${quote(POSTGRES_RC)} <<'CONF'
postgresql_enable="YES"
postgresql_data="${SERVICE_ROOT}/db"
CONF
chmod 0644 ${quote(POSTGRES_RC)}; if [ ! -s "$root/db/PG_VERSION" ]; then su -m postgres -c '/usr/local/bin/initdb -D ${SERVICE_ROOT}/db --encoding=UTF8 --locale=C --auth-local=trust --auth-host=scram-sha-256' >/dev/null; fi; cat >> "$root/db/postgresql.conf" <<'CONF'
listen_addresses = '127.0.0.1'
port = 55432
unix_socket_directories = '${SERVICE_ROOT}/pg-run'
password_encryption = 'scram-sha-256'
CONF
printf '%s\n' 'host ${DATABASE} ${DATABASE_USER} 127.0.0.1/32 scram-sha-256' >> "$root/db/pg_hba.conf"; service postgresql status >/dev/null 2>&1 || service postgresql start; password=$(cat ${quote(`${CREDENTIALS}/database_password`)}); if printf "%s\n" "SELECT 1 FROM pg_roles WHERE rolname='${DATABASE_USER}'" | su -m postgres -c '/usr/local/bin/psql -p 55432 -h ${SERVICE_ROOT}/pg-run -At postgres' | grep -Fxq 1; then role_action=ALTER; else role_action=CREATE; fi; umask 077; printf "%s ROLE ${DATABASE_USER} LOGIN PASSWORD '%s';\n" "$role_action" "$password" > "$root/bootstrap.sql"; chown postgres:postgres "$root/bootstrap.sql"; su -m postgres -c '/usr/local/bin/psql -p 55432 -h ${SERVICE_ROOT}/pg-run -v ON_ERROR_STOP=1 -f ${SERVICE_ROOT}/bootstrap.sql postgres' >/dev/null; rm -f -- "$root/bootstrap.sql"; printf "%s\n" "SELECT 1 FROM pg_database WHERE datname='${DATABASE}'" | su -m postgres -c '/usr/local/bin/psql -p 55432 -h ${SERVICE_ROOT}/pg-run -At postgres' | grep -Fxq 1 || su -m postgres -c '/usr/local/bin/createdb -p 55432 -h ${SERVICE_ROOT}/pg-run -O ${DATABASE_USER} ${DATABASE}'; PGPASSWORD="$password" /usr/local/bin/psql -h 127.0.0.1 -p 55432 -U ${DATABASE_USER} -d ${DATABASE} -Atqc 'SELECT 1' | grep -Fxq 1`
}

function configure () {
  return `set -eu; root=${quote(SERVICE_ROOT)}; install -d -o mattermost -g mattermost -m 0750 "$root/data" "$root/logs" "$root/plugins" "$root/client" "$root/client/plugins" "$root/run"; if [ ! -e "$root/config.json" ]; then install -o mattermost -g mattermost -m 0600 /usr/local/etc/mattermost/config.json.sample "$root/config.json"; fi; cat > ${quote(MATTERMOST_RC)} <<'RC'
#!/bin/sh
# PROVIDE: webminai_mattermost
# REQUIRE: postgresql
# KEYWORD: shutdown
. /etc/rc.subr
name=webminai_mattermost
rcvar=webminai_mattermost_enable
pidfile=${SERVICE_ROOT}/run/mattermost.pid
procname=/usr/local/bin/mattermostd
command=/usr/sbin/daemon
start_precmd=webminai_mattermost_precmd
webminai_mattermost_chdir=/usr/local/www/mattermost
webminai_mattermost_precmd() {
  password=$(cat ${CREDENTIALS}/database_password) || return 1
  export MM_SERVICESETTINGS_LISTENADDRESS=127.0.0.1:8065
  export MM_SERVICESETTINGS_SITEURL=http://127.0.0.1:18111
  export MM_SERVICESETTINGS_ENABLELOCALMODE=true
  export MM_SQLSETTINGS_DRIVERNAME=postgres
  export MM_SQLSETTINGS_DATASOURCE="postgres://${DATABASE_USER}:$password@127.0.0.1:55432/${DATABASE}?sslmode=disable&connect_timeout=10"
  export MM_FILESETTINGS_DIRECTORY=${SERVICE_ROOT}/data
  export MM_PLUGINSETTINGS_DIRECTORY=${SERVICE_ROOT}/plugins
  export MM_PLUGINSETTINGS_CLIENTDIRECTORY=${SERVICE_ROOT}/client/plugins
  command_args="-u mattermost -p $pidfile -f /usr/local/bin/mattermostd server --config=${SERVICE_ROOT}/config.json"
}
load_rc_config $name
: \${webminai_mattermost_enable:=YES}
run_rc_command "$1"
RC
chmod 0755 ${quote(MATTERMOST_RC)}; cat > ${quote(NGINX_CONFIG)} <<'CONF'
user www www;
worker_processes 1;
events { worker_connections 256; }
http { server { listen 18111; location = / { default_type text/plain; return 200 "${MARKER}\\n"; } location /api/ { proxy_pass http://127.0.0.1:8065; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; } } }
CONF
chmod 0644 ${quote(NGINX_CONFIG)}; service webminai_mattermost status >/dev/null 2>&1 || service webminai_mattermost start; ready=; for attempt in $(jot 180); do curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8065/api/v4/system/ping >/dev/null 2>&1 && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]; nginx -t; service nginx status >/dev/null 2>&1 || service nginx onestart`
}

function initializeAdmin () {
  return `set -eu; root=${quote(SERVICE_ROOT)}; password=$(cat ${quote(`${CREDENTIALS}/admin_password`)}); umask 077; printf '{"email":"intentaiops@example.invalid","username":"webminai_admin","password":"%s"}\n' "$password" > ${quote(`${CREDENTIALS}/admin.json`)}; if ! printf "%s\n" "SELECT 1 FROM users WHERE username='webminai_admin'" | su -m postgres -c '/usr/local/bin/psql -p 55432 -h ${SERVICE_ROOT}/pg-run -d ${DATABASE} -At' | grep -Fxq 1; then curl --fail --silent --show-error --request POST --header 'Content-Type: application/json' --data-binary @${quote(`${CREDENTIALS}/admin.json`)} http://127.0.0.1:8065/api/v4/users >/dev/null; fi; printf "%s\n" "UPDATE users SET roles='system_user system_admin' WHERE username='webminai_admin'" | su -m postgres -c '/usr/local/bin/psql -p 55432 -h ${SERVICE_ROOT}/pg-run -d ${DATABASE}' >/dev/null; chmod 0600 ${quote(`${CREDENTIALS}/admin.json`)}`
}

function verify () {
  return `set -eu; response=$(mktemp); trap 'rm -f -- "$response"' EXIT; su -m mattermost -c '/usr/local/bin/mattermostd version' | grep -F ${VERSION}; curl --fail --silent --show-error --output "$response" http://127.0.0.1:8065/api/v4/system/ping; grep -Fq '"status":"OK"' "$response"; printf "%s\n" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" | su -m postgres -c '/usr/local/bin/psql -p 55432 -h ${SERVICE_ROOT}/pg-run -d ${DATABASE} -At' | awk '$1 > 0 { ok=1 } END { exit !ok }'; printf "%s\n" "SELECT count(*) FROM users WHERE username='webminai_admin' AND roles LIKE '%system_admin%'" | su -m postgres -c '/usr/local/bin/psql -p 55432 -h ${SERVICE_ROOT}/pg-run -d ${DATABASE} -At' | grep -Fxq 1; service webminai_mattermost stop >/dev/null 2>&1 || true; stopped=; for attempt in $(jot 30); do sockstat -4 -l | grep -q ':8065 ' || { stopped=yes; break; }; sleep 1; done; [ "$stopped" = yes ]; rm -f -- ${SERVICE_ROOT}/run/mattermost.pid; service webminai_mattermost start; ready=; for attempt in $(jot 180); do curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8065/api/v4/system/ping >/dev/null 2>&1 && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]; service postgresql status >/dev/null; service nginx status >/dev/null`
}

function remove (state) {
  return `set -eu; service nginx onestop >/dev/null 2>&1 || true; service webminai_mattermost stop >/dev/null 2>&1 || true; service postgresql stop >/dev/null 2>&1 || true; rm -f -- ${quote(MATTERMOST_RC)} ${quote(POSTGRES_RC)} ${quote(NGINX_CONFIG)}; rm -rf -- ${quote(SERVICE_ROOT)}; if [ -d ${quote(state)} ]; then for name in database_password admin_password; do [ ! -e ${quote(state)}/credential-$name-created ] || rm -f -- ${quote(CREDENTIALS)}/$name; done; if [ ! -e ${quote(`${state}/credentials-preexisting`)} ]; then rm -rf -- ${quote(CREDENTIALS)}; fi; fi; if [ -s ${quote(`${state}/packages.added`)} ]; then packages=$(tr '\n' ' ' < ${quote(`${state}/packages.added`)}); [ -z "$packages" ] || env ASSUME_ALWAYS_YES=yes pkg delete -y $packages; fi; if [ -d ${quote(state)} ]; then for identity in mattermost postgres; do [ -e ${quote(state)}/user-$identity-preexisting ] || pw userdel "$identity" >/dev/null 2>&1 || true; [ -e ${quote(state)}/group-$identity-preexisting ] || pw groupdel "$identity" >/dev/null 2>&1 || true; done; fi; rm -rf -- ${quote(state)}`
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
