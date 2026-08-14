const VERSION = '2.33.7'
const SERVICE_ROOT = '/var/db/webminai-n8n-18109'
const APP_ROOT = '/usr/local/lib/webminai-n8n-18109'
const CREDENTIALS = '/root/n8n_credentials'
const SERVICE_RC = '/usr/local/etc/rc.d/webminai_n8n'
const NGINX_CONFIG = '/usr/local/etc/nginx/nginx.conf'
const MARKER = 'WEBMINAI_N8N_OK'
const SQLITE_SOURCE_SHA256 = '16e8a29fc022b8e80a6ebb376250a1b8e786b839b44840b0fe86e94159b84ae6'

export function buildFreebsdN8nTask (taskId, freebsdExecution) {
  if (freebsdExecution?.platform !== 'freebsd') throw new Error('FreeBSD n8n requires a FreeBSD execution inventory')
  const state = `/var/lib/webminai/task-state/${taskId}-n8n-freebsd`
  return {
    plan: {
      summary: 'Deploy a learned reversible native FreeBSD n8n service',
      changeOverview: `Install n8n ${VERSION} with FreeBSD Node.js 24, isolated SQLite state, a protected encryption key, rc.d, and nginx on port 18109.`,
      modifiedFiles: [state, APP_ROOT, SERVICE_ROOT, CREDENTIALS, SERVICE_RC, NGINX_CONFIG],
      assumptions: ['FreeBSD 15.1 amd64 with pkg and rc.d', `n8n ${VERSION} declares Node.js >=22.22 and the selected FreeBSD Node.js 24 package satisfies that range`],
      warnings: ['n8n does not publish an official FreeBSD package; this route installs the exact npm release and compiles unsupported prebuilt native dependencies from source when required.', 'Only the health-tested local service and an isolated nginx validation marker are published; workflow credentials are outside this controlled test.'],
      commands: [
        item('prepare-n8n', prepare(state), 'Capture package and identity baselines and generate the encryption key on-host'),
        item('install-n8n-runtime', installRuntime(state), 'Install exact FreeBSD Node.js 24, npm, nginx, and native build prerequisites', ['prepare-n8n'], 1800000, 'job'),
        item('install-n8n-application', installApplication(state), `Install exact n8n ${VERSION} and validate its SQLite module`, ['install-n8n-runtime'], 3600000, 'job'),
        item('configure-n8n', configure(), 'Create the isolated service identity, rc.d service, persistent data, and nginx marker', ['install-n8n-application'], 900000, 'job'),
        item('verify-n8n', verify(), 'Verify health, SQLite persistence, external marker, and restart recovery', ['configure-n8n'], 900000, 'job')
      ],
      revertCommands: [item('remove-n8n', remove(state), 'Remove only task-owned n8n service, state, credentials, identities, and packages', [], 1800000, 'job', 'destructive')]
    },
    verifyApplied: `set -eu; ${primaryAddress()}; response=$(mktemp); trap 'rm -f -- "$response"' EXIT; curl --fail --silent --show-error --max-time 20 --output "$response" http://$address:18109/; grep -Fxq ${MARKER} "$response"; curl --fail --silent --show-error --max-time 20 http://127.0.0.1:5678/healthz >/dev/null; test -s ${quote(`${SERVICE_ROOT}/.n8n/database.sqlite`)}`,
    verifyReverted: `test ! -e ${quote(APP_ROOT)} && test ! -e ${quote(SERVICE_ROOT)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)} && ! pkg info -e node24 >/dev/null 2>&1`,
    stateProbe: `test -e ${quote(state)} && printf applied || printf absent`
  }
}

function prepare (state) {
  return `[ ! -d ${quote(state)} ] || exit 0; ${prepareFresh(state)}`
}

function prepareFresh (state) {
  return `set -eu; test "$(uname -s)" = FreeBSD; for package in node24 npm-node24 nginx; do pkg info -e "$package" >/dev/null 2>&1 && { echo "pre-existing $package is outside task ownership" >&2; exit 1; } || true; done; for path in ${quote(APP_ROOT)} ${quote(SERVICE_ROOT)} ${quote(SERVICE_RC)}; do test ! -e "$path"; done; install -d -m 0700 ${quote(state)}; pkg query -a '%n' | LC_ALL=C sort -u > ${quote(`${state}/packages.before`)}; for kind in user group; do if [ "$kind" = user ]; then pw usershow webminai_n8n >/dev/null 2>&1; else pw groupshow webminai_n8n >/dev/null 2>&1; fi && : > ${quote(state)}/$kind-preexisting || true; done; if [ -e ${quote(CREDENTIALS)} ]; then : > ${quote(`${state}/credentials-preexisting`)}; else install -d -m 0700 ${quote(CREDENTIALS)}; fi; if [ ! -s ${quote(`${CREDENTIALS}/encryption_key`)} ]; then umask 077; openssl rand -hex 32 > ${quote(`${CREDENTIALS}/encryption_key`)}; : > ${quote(`${state}/credential-created`)}; fi; chmod 0600 ${quote(`${CREDENTIALS}/encryption_key`)}`
}

function installRuntime (state) {
  return `set -eu; env ASSUME_ALWAYS_YES=yes pkg install -y node24-24.18.0 npm-node24-11.18.0 nginx python311 gmake pkgconf; node -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit(major === 24 || major === 22 && minor >= 22 ? 0 : 1)'; npm --version >/dev/null; pkg query -a '%n' | LC_ALL=C sort -u > ${quote(`${state}/packages.after`)}; LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} > ${quote(`${state}/packages.added`)}`
}

function installApplication (state) {
  const installed = `${state}/application-installed`
  return `if [ -e ${quote(installed)} ]; then ${quote(`${APP_ROOT}/node_modules/.bin/n8n`)} --version | grep -Fx ${quote(VERSION)}; exit 0; fi; ${installApplicationFresh(state)}; : > ${quote(installed)}`
}

function installApplicationFresh (state) {
  const sqliteRoot = `${APP_ROOT}/node_modules/sqlite3`
  const source = `${sqliteRoot}/build/Release/obj/gen/sqlite-autoconf-3440200/sqlite3.c`
  const makefile = `${sqliteRoot}/build/node_sqlite3.target.mk`
  const patch = `const fs=require('node:fs');const crypto=require('node:crypto');const sourcePath=${JSON.stringify(source)};const makefilePath=${JSON.stringify(makefile)};let sqlite=fs.readFileSync(sourcePath,'utf8');let makefile=fs.readFileSync(makefilePath,'utf8');const digest=value=>crypto.createHash('sha256').update(value).digest('hex');if(digest(sqlite)!==${JSON.stringify(SQLITE_SOURCE_SHA256)})throw new Error('unexpected sqlite3 source checksum');const header='#ifndef SQLITE3_H';const override='#ifdef SQLITE_DQS\\n# undef SQLITE_DQS\\n#endif\\n#define SQLITE_DQS 3\\n'+header;if(sqlite.split(header).length<2)throw new Error('sqlite3 header marker missing');sqlite=sqlite.replace(header,override);const linker='LDFLAGS_Release :=';if(makefile.split(linker).length!==2)throw new Error('sqlite3 linker marker mismatch');makefile=makefile.replace(linker,linker+' -Wl,-Bsymbolic');fs.writeFileSync(sourcePath,sqlite);fs.writeFileSync(makefilePath,makefile)`
  const check = `const sqlite3=require(${JSON.stringify(`${APP_ROOT}/node_modules/sqlite3`)});const db=new sqlite3.Database(':memory:');db.all('PRAGMA compile_options',(error,rows)=>{if(error)throw error;const options=rows.map(row=>row.compile_options);db.get('SELECT "owner" value',(queryError,row)=>{if(queryError)throw queryError;db.close();if(!options.includes('DQS=3')||row.value!=='owner')process.exitCode=1})})`
  return `set -eu; install -d -o root -g wheel -m 0755 ${quote(APP_ROOT)}; install -d -o root -g wheel -m 0755 ${quote(`${state}/npm-cache`)} ${quote(`${state}/node-gyp`)}; export npm_config_cache=${quote(`${state}/npm-cache`)} npm_config_devdir=${quote(`${state}/node-gyp`)} npm_config_python=/usr/local/bin/python3.11; npm --prefix ${quote(APP_ROOT)} install --omit=dev --no-audit --no-fund --loglevel=error ${quote(`n8n@${VERSION}`)}; cd ${quote(APP_ROOT)}; node -e "require('sqlite3')"; node -e ${quote(patch)}; build=${quote(`${sqliteRoot}/build`)}; rm -f -- "$build/Release/obj.target/sqlite3/gen/sqlite-autoconf-3440200/sqlite3.o" "$build/Release/obj.target/deps/sqlite3.a" "$build/Release/sqlite3.a" "$build/Release/obj.target/node_sqlite3.node" "$build/Release/node_sqlite3.node"; gmake -C "$build" BUILDTYPE=Release -j2 >/dev/null; node -e ${quote(check)}; chmod -R a+rX ${quote(APP_ROOT)}; ${quote(`${APP_ROOT}/node_modules/.bin/n8n`)} --version | grep -Fx ${quote(VERSION)}`
}

function configure () {
  return `set -eu; pw groupshow webminai_n8n >/dev/null 2>&1 || pw groupadd webminai_n8n; pw usershow webminai_n8n >/dev/null 2>&1 || pw useradd webminai_n8n -g webminai_n8n -d ${quote(SERVICE_ROOT)} -s /usr/sbin/nologin -c 'Intent AI Ops n8n'; install -d -o webminai_n8n -g webminai_n8n -m 0700 ${quote(SERVICE_ROOT)}; cat > ${quote(SERVICE_RC)} <<'RC'
#!/bin/sh
# PROVIDE: webminai_n8n
# REQUIRE: NETWORKING
# KEYWORD: shutdown
. /etc/rc.subr
name=webminai_n8n
rcvar=webminai_n8n_enable
pidfile=${SERVICE_ROOT}/n8n.pid
procname=/usr/local/bin/node
command=/usr/sbin/daemon
webminai_n8n_chdir=${APP_ROOT}
start_precmd=webminai_n8n_precmd
webminai_n8n_precmd() {
  key=$(cat ${CREDENTIALS}/encryption_key) || return 1
  export HOME=${SERVICE_ROOT}
  export N8N_USER_FOLDER=${SERVICE_ROOT}
  export N8N_ENCRYPTION_KEY="$key"
  export N8N_PORT=5678
  export N8N_LISTEN_ADDRESS=127.0.0.1
  export N8N_DIAGNOSTICS_ENABLED=false
  export N8N_VERSION_NOTIFICATIONS_ENABLED=false
  export N8N_SECURE_COOKIE=false
  export N8N_RUNNERS_ENABLED=false
  command_args="-u webminai_n8n -p $pidfile -o ${SERVICE_ROOT}/n8n.log -m 3 ${APP_ROOT}/node_modules/.bin/n8n start"
}
load_rc_config $name
: \${webminai_n8n_enable:=YES}
run_rc_command "$1"
RC
chmod 0755 ${quote(SERVICE_RC)}; cat > ${quote(NGINX_CONFIG)} <<'CONF'
user www www;
worker_processes 1;
events { worker_connections 256; }
http { server { listen 18109; location = / { default_type text/plain; return 200 "${MARKER}\n"; } } }
CONF
chmod 0644 ${quote(NGINX_CONFIG)}; service webminai_n8n status >/dev/null 2>&1 || service webminai_n8n start; ${waitHealth()}; nginx -t; service nginx status >/dev/null 2>&1 || service nginx onestart`
}

function verify () {
  return `set -eu; ${quote(`${APP_ROOT}/node_modules/.bin/n8n`)} --version | grep -Fx ${quote(VERSION)}; ${waitHealth()}; test -s ${quote(`${SERVICE_ROOT}/.n8n/database.sqlite`)}; curl --fail --silent --show-error --max-time 5 http://127.0.0.1:18109/ | grep -Fx ${quote(MARKER)}; service webminai_n8n stop >/dev/null 2>&1 || true; stopped=; for attempt in $(jot 30); do sockstat -4 -l | grep -q ':5678 ' || { stopped=yes; break; }; sleep 1; done; [ "$stopped" = yes ]; rm -f -- ${quote(`${SERVICE_ROOT}/n8n.pid`)}; service webminai_n8n start; ${waitHealth()}; test -s ${quote(`${SERVICE_ROOT}/.n8n/database.sqlite`)}; service nginx status >/dev/null`
}

function remove (state) {
  return `set -eu; service nginx onestop >/dev/null 2>&1 || true; service webminai_n8n stop >/dev/null 2>&1 || true; rm -f -- ${quote(SERVICE_RC)} ${quote(NGINX_CONFIG)}; rm -rf -- ${quote(APP_ROOT)} ${quote(SERVICE_ROOT)}; if [ -d ${quote(state)} ]; then [ ! -e ${quote(`${state}/credential-created`)} ] || rm -f -- ${quote(`${CREDENTIALS}/encryption_key`)}; [ -e ${quote(`${state}/credentials-preexisting`)} ] || rm -rf -- ${quote(CREDENTIALS)}; fi; if [ -s ${quote(`${state}/packages.added`)} ]; then packages=$(tr '\n' ' ' < ${quote(`${state}/packages.added`)}); [ -z "$packages" ] || env ASSUME_ALWAYS_YES=yes pkg delete -y $packages; fi; rmdir /usr/local/etc/nginx >/dev/null 2>&1 || true; if [ -d ${quote(state)} ]; then [ -e ${quote(`${state}/user-preexisting`)} ] || pw userdel webminai_n8n >/dev/null 2>&1 || true; [ -e ${quote(`${state}/group-preexisting`)} ] || pw groupdel webminai_n8n >/dev/null 2>&1 || true; fi; rm -rf -- ${quote(state)}`
}

function waitHealth () {
  return 'ready=; for attempt in $(jot 180); do curl --fail --silent --show-error --max-time 3 http://127.0.0.1:5678/healthz >/dev/null 2>&1 && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]'
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
