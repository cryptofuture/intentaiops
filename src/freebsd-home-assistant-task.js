const VERSION = '2026.8.1'
const ARCHIVE_SHA256 = 'c7486708ad3ce67284b40205ca91e38b2a83245dafc7422c9e35879dbd9620c1'
const APP_ROOT = '/usr/local/lib/webminai-home-assistant-18115'
const DATA_ROOT = '/var/db/webminai-home-assistant-18115'
const CREDENTIALS = '/root/home_assistant_credentials'
const RC_SCRIPT = '/usr/local/etc/rc.d/webminai_home_assistant'
const NGINX_CONFIG = '/usr/local/etc/nginx/nginx.conf'
const MARKER = 'WEBMINAI_HOME_ASSISTANT_OK'

export function buildFreebsdHomeAssistantTask (taskId, freebsdExecution) {
  if (freebsdExecution?.platform !== 'freebsd') throw new Error('FreeBSD Home Assistant requires a FreeBSD execution inventory')
  const state = `/var/lib/webminai/task-state/${taskId}-home-assistant-freebsd`
  return {
    plan: {
      summary: 'Deploy a learned reversible native FreeBSD Home Assistant Core service',
      changeOverview: `Build checksum-pinned Home Assistant Core ${VERSION} with Python 3.14, isolated configuration, protected onboarding credentials, rc.d, and nginx on port 18115.`,
      modifiedFiles: [state, APP_ROOT, DATA_ROOT, CREDENTIALS, RC_SCRIPT, NGINX_CONFIG],
      assumptions: ['FreeBSD 15.1 amd64 with pkg and rc.d', 'The task intentionally disables cloud connectivity, device discovery, and host hardware access in this controlled application test.'],
      warnings: ['Home Assistant supports Home Assistant OS and Home Assistant Container for production, not a native FreeBSD Core installation. This is an Intent AI Ops-tested source adaptation.', 'The Nabu Casa compatibility module is installed because Home Assistant Core imports its URL helpers, but cloud connectivity and its unused grpc transport are not installed or configured.', 'No privileged mode, host networking, D-Bus, USB, Bluetooth, or real-device integration is configured.'],
      commands: [
        item('prepare-home-assistant', prepare(state), 'Capture package and identity baselines and generate administrator credentials on-host'),
        item('install-home-assistant-runtime', installRuntime(state), 'Install exact Python 3.14, nginx, Rust, and native dependency build libraries', ['prepare-home-assistant'], 1800000, 'job'),
        item('install-home-assistant-application', installApplication(state), `Build checksum-pinned Home Assistant Core ${VERSION} and its exact dependency matrix`, ['install-home-assistant-runtime'], 3600000, 'job'),
        item('configure-home-assistant', configure(), 'Create the isolated identity, configuration, rc.d service, and nginx proxy', ['install-home-assistant-application', 'prepare-home-assistant'], 900000, 'job'),
        item('initialize-home-assistant', initialize(), 'Complete onboarding using protected host-generated credentials', ['configure-home-assistant'], 900000, 'job'),
        item('verify-home-assistant', verify(), 'Verify version, onboarding, SQLite persistence, external marker, and restart recovery', ['initialize-home-assistant'], 900000, 'job')
      ],
      revertCommands: [item('remove-home-assistant', remove(state), 'Remove only task-owned Home Assistant, credentials, service identity, and packages', [], 1800000, 'job', 'destructive')]
    },
    verifyApplied: `set -eu; ${primaryAddress()}; curl --fail --silent --show-error --max-time 20 http://$address:18115/ | grep -Fx ${MARKER}; curl --fail --silent --show-error --max-time 20 http://$address:18115/homeassistant/ | grep -Fi 'home assistant'`,
    verifyReverted: `test ! -e ${quote(APP_ROOT)} && test ! -e ${quote(DATA_ROOT)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)} && ! pkg info -e python314 >/dev/null 2>&1 && ! pkg info -e nginx >/dev/null 2>&1`,
    stateProbe: `test -e ${quote(state)} && printf applied || printf absent`
  }
}

function prepare (state) {
  return `[ ! -d ${quote(state)} ] || exit 0; ${prepareFresh(state)}`
}

function prepareFresh (state) {
  return `set -eu; test "$(uname -s)" = FreeBSD; for package in python314 nginx; do pkg info -e "$package" >/dev/null 2>&1 && { echo "pre-existing $package is outside task ownership" >&2; exit 1; } || true; done; for path in ${quote(APP_ROOT)} ${quote(DATA_ROOT)} ${quote(RC_SCRIPT)}; do test ! -e "$path"; done; install -d -m 0700 ${quote(state)}; pkg query -a '%n' | LC_ALL=C sort -u > ${quote(`${state}/packages.before`)}; pw usershow webminai_homeassistant >/dev/null 2>&1 && : > ${quote(`${state}/user-preexisting`)} || true; pw groupshow webminai_homeassistant >/dev/null 2>&1 && : > ${quote(`${state}/group-preexisting`)} || true; if [ -e ${quote(CREDENTIALS)} ]; then : > ${quote(`${state}/credentials-preexisting`)}; else install -d -m 0700 ${quote(CREDENTIALS)}; fi; if [ ! -s ${quote(`${CREDENTIALS}/admin_username`)} ]; then umask 077; printf 'webminai_%s\n' "$(openssl rand -hex 8)" > ${quote(`${CREDENTIALS}/admin_username`)}; : > ${quote(`${state}/admin-username-created`)}; fi; if [ ! -s ${quote(`${CREDENTIALS}/admin_password`)} ]; then umask 077; openssl rand -hex 32 > ${quote(`${CREDENTIALS}/admin_password`)}; : > ${quote(`${state}/admin-password-created`)}; fi; chmod 0600 ${quote(CREDENTIALS)}/*`
}

function installRuntime (state) {
  return `set -eu; env ASSUME_ALWAYS_YES=yes pkg install -y python314-3.14.7 py314-sqlite3-3.14.7_10 nginx rust pkgconf gmake cmake meson ninja libffi jpeg-turbo openjpeg webp tiff freetype2 lcms2 libyaml; pkg query -a '%n' | LC_ALL=C sort -u > ${quote(`${state}/packages.after`)}; LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} > ${quote(`${state}/packages.added`)}; python3.14 -c 'import sqlite3,sys; assert sys.version_info >= (3, 14, 2); assert sqlite3.sqlite_version'`
}

function installApplication (state) {
  const installed = `${state}/application-installed`
  return `if [ -e ${quote(installed)} ]; then ${quote(`${APP_ROOT}/venv/bin/python`)} -c 'from homeassistant.const import __version__; assert __version__ == "${VERSION}"'; exit 0; fi; ${installApplicationFresh(state)}; : > ${quote(installed)}`
}

function installApplicationFresh (state) {
  const archive = `${state}/home-assistant-${VERSION}.tar.gz`
  return `set -eu; rm -rf -- ${quote(APP_ROOT)}; install -d -o root -g wheel -m 0755 ${quote(APP_ROOT)}; curl --fail --location --silent --show-error https://github.com/home-assistant/core/archive/refs/tags/${VERSION}.tar.gz --output ${quote(archive)}; [ "$(sha256 -q ${quote(archive)})" = ${quote(ARCHIVE_SHA256)} ]; tar -xzf ${quote(archive)} -C ${quote(APP_ROOT)} --strip-components 1; awk '!/^hass-nabucasa==/' ${quote(`${APP_ROOT}/requirements.txt`)} > ${quote(`${APP_ROOT}/requirements-freebsd.txt`)}; ! grep -q '^hass-nabucasa==' ${quote(`${APP_ROOT}/requirements-freebsd.txt`)}; python3.14 -m venv ${quote(`${APP_ROOT}/venv`)}; export PATH=${quote(`${APP_ROOT}/venv/bin`)}:$PATH CFLAGS='-I/usr/local/include' CPPFLAGS='-I/usr/local/include' LDFLAGS='-L/usr/local/lib' MAKE=gmake CARGO_HOME=${quote(`${state}/cargo`)} PIP_CACHE_DIR=${quote(`${state}/pip-cache`)} CARGO_BUILD_JOBS=1 CARGO_PROFILE_RELEASE_LTO=off CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16; pip install --disable-pip-version-check --no-input --upgrade pip setuptools wheel; pip install --disable-pip-version-check --no-input 'meson-python==0.20.0' 'Cython==3.2.9' 'pyproject-metadata==0.12.1'; pip install --disable-pip-version-check --no-input --no-build-isolation 'numpy==2.3.2'; pip install --disable-pip-version-check --no-input 'uv==0.11.31'; pip install --disable-pip-version-check --no-input -r ${quote(`${APP_ROOT}/requirements-freebsd.txt`)}; pip install --disable-pip-version-check --no-input 'acme==5.4.0' 'aiohasupervisor==0.6.0' 'gTTS==2.5.4' 'icmplib>=3,<4' 'josepy>=2,<3' 'pycognito==2024.5.1' 'snitun==0.45.1' 'sentence-stream>=1.2.0,<2'; pip install --disable-pip-version-check --no-input --no-deps 'hass-nabucasa==2.2.0' 'home-assistant-frontend==20260729.6'; pip install --disable-pip-version-check --no-input --no-deps ${quote(APP_ROOT)}; cd ${quote(APP_ROOT)}; printf 'onboarding\n' | venv/bin/python -m script.translations develop >/dev/null; test -s homeassistant/components/onboarding/translations/en.json; rm -rf -- ${quote(`${state}/cargo`)} ${quote(`${state}/pip-cache`)}; ${quote(`${APP_ROOT}/venv/bin/python`)} -c 'from homeassistant.const import __version__; assert __version__ == "${VERSION}"'; ${quote(`${APP_ROOT}/venv/bin/python`)} -c 'from hass_nabucasa import remote; assert remote is not None'; chmod -R a+rX ${quote(APP_ROOT)}`
}

function configure () {
  return `set -eu; chmod -R a+rX ${quote(APP_ROOT)}; pw groupshow webminai_homeassistant >/dev/null 2>&1 || pw groupadd webminai_homeassistant; pw usershow webminai_homeassistant >/dev/null 2>&1 || pw useradd webminai_homeassistant -g webminai_homeassistant -d ${quote(DATA_ROOT)} -s /usr/sbin/nologin -c 'Intent AI Ops Home Assistant'; install -d -o webminai_homeassistant -g webminai_homeassistant -m 0750 ${quote(DATA_ROOT)} ${quote(`${DATA_ROOT}/run`)}; cat > ${quote(`${APP_ROOT}/webminai_freebsd.py`)} <<'PY'
from homeassistant import __main__
__main__.validate_os = lambda: None
raise SystemExit(__main__.main())
PY
chmod 0644 ${quote(`${APP_ROOT}/webminai_freebsd.py`)}; cat > ${quote(`${DATA_ROOT}/configuration.yaml`)} <<'CONF'
homeassistant:
  name: ${MARKER}
  latitude: 0
  longitude: 0
  elevation: 0
  unit_system: metric
  time_zone: Etc/UTC
frontend:
api:
config:
history:
logbook:
recorder:
http:
  server_host: 127.0.0.1
  server_port: 8123
  use_x_forwarded_for: true
  trusted_proxies:
    - 127.0.0.1
CONF
chown webminai_homeassistant:webminai_homeassistant ${quote(`${DATA_ROOT}/configuration.yaml`)}; chmod 0640 ${quote(`${DATA_ROOT}/configuration.yaml`)}; cat > ${quote(RC_SCRIPT)} <<'RC'
#!/bin/sh
# PROVIDE: webminai_home_assistant
# REQUIRE: NETWORKING
# KEYWORD: shutdown
. /etc/rc.subr
name=webminai_home_assistant
rcvar=webminai_home_assistant_enable
pidfile=${DATA_ROOT}/run/home-assistant.pid
procname=${APP_ROOT}/venv/bin/python
command=/usr/sbin/daemon
command_args="-u webminai_homeassistant -p $pidfile -o ${DATA_ROOT}/service.log -m 3 -f ${APP_ROOT}/venv/bin/python ${APP_ROOT}/webminai_freebsd.py --skip-pip --log-file ${DATA_ROOT}/core.log --config ${DATA_ROOT}"
load_rc_config $name
: \${webminai_home_assistant_enable:=YES}
run_rc_command "$1"
RC
chmod 0755 ${quote(RC_SCRIPT)}; cat > ${quote(NGINX_CONFIG)} <<'CONF'
user www www;
worker_processes 1;
events { worker_connections 256; }
http { map $http_upgrade $connection_upgrade { default upgrade; '' close; } server { listen 18115; location = / { default_type text/plain; return 200 "${MARKER}\n"; } location /homeassistant/ { proxy_pass http://127.0.0.1:8123/; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $connection_upgrade; } location /api/ { proxy_pass http://127.0.0.1:8123/api/; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; } location /auth/ { proxy_pass http://127.0.0.1:8123/auth/; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; } } }
CONF
chmod 0644 ${quote(NGINX_CONFIG)}; service webminai_home_assistant status >/dev/null 2>&1 && service webminai_home_assistant restart || service webminai_home_assistant start; ${waitHomeAssistant()}; nginx -t; service nginx status >/dev/null 2>&1 && service nginx onerestart || service nginx onestart`
}

function initialize () {
  const base = 'http://127.0.0.1:18115'
  const clientId = `${base}/`
  const parse = `${APP_ROOT}/venv/bin/python -c`
  return `set -eu; if [ ! -e ${quote(`${CREDENTIALS}/initialized`)} ]; then username=$(cat ${quote(`${CREDENTIALS}/admin_username`)}); password=$(cat ${quote(`${CREDENTIALS}/admin_password`)}); payload=$(printf '{"client_id":"%s","name":"%s","username":"%s","password":"%s","language":"en"}' ${quote(clientId)} ${quote(MARKER)} "$username" "$password"); response=$(curl --fail --silent --show-error --request POST --header 'Content-Type: application/json' --data "$payload" ${quote(`${base}/api/onboarding/users`)}); code=$(printf '%s' "$response" | ${parse} ${quote("import json,sys; print(json.load(sys.stdin)['auth_code'])")}); token_response=$(curl --fail --silent --show-error --request POST --data-urlencode 'grant_type=authorization_code' --data-urlencode "code=$code" --data-urlencode ${quote(`client_id=${clientId}`)} ${quote(`${base}/auth/token`)}); token=$(printf '%s' "$token_response" | ${parse} ${quote("import json,sys; print(json.load(sys.stdin)['access_token'])")}); curl --fail --silent --show-error --request POST --header "Authorization: Bearer $token" ${quote(`${base}/api/onboarding/core_config`)} >/dev/null; curl --fail --silent --show-error --request POST --header "Authorization: Bearer $token" --header 'Content-Type: application/json' --data ${quote(`{"client_id":"${clientId}","redirect_uri":"${clientId}"}`)} ${quote(`${base}/api/onboarding/integration`)} >/dev/null; curl --fail --silent --show-error --request POST --header "Authorization: Bearer $token" ${quote(`${base}/api/onboarding/analytics`)} >/dev/null; : > ${quote(`${CREDENTIALS}/initialized`)}; chmod 0600 ${quote(`${CREDENTIALS}/initialized`)}; fi; ready=; for attempt in $(jot 60); do test -s ${quote(`${DATA_ROOT}/.storage/auth`)} && { ready=yes; break; }; sleep 1; done; [ "$ready" = yes ]; test -e ${quote(`${CREDENTIALS}/initialized`)}`
}

function verify () {
  return `set -eu; ${quote(`${APP_ROOT}/venv/bin/python`)} -c 'from homeassistant.const import __version__; assert __version__ == "${VERSION}"'; ${waitHomeAssistant()}; ${waitPublic()}; test -e ${quote(`${CREDENTIALS}/initialized`)}; test -s ${quote(`${DATA_ROOT}/home-assistant_v2.db`)}; test -s ${quote(`${DATA_ROOT}/.storage/auth`)}; service webminai_home_assistant stop >/dev/null 2>&1 || true; service webminai_home_assistant start; ${waitHomeAssistant()}; service nginx onestop >/dev/null 2>&1 || true; service nginx onestart; ${waitPublic()}; service webminai_home_assistant status >/dev/null; service nginx status >/dev/null`
}

function remove (state) {
  return `set -eu; service nginx onestop >/dev/null 2>&1 || true; service webminai_home_assistant stop >/dev/null 2>&1 || true; rm -f -- ${quote(RC_SCRIPT)} ${quote(NGINX_CONFIG)}; rm -rf -- ${quote(APP_ROOT)} ${quote(DATA_ROOT)}; if [ -d ${quote(state)} ]; then [ ! -e ${quote(`${state}/admin-username-created`)} ] || rm -f -- ${quote(`${CREDENTIALS}/admin_username`)}; [ ! -e ${quote(`${state}/admin-password-created`)} ] || rm -f -- ${quote(`${CREDENTIALS}/admin_password`)}; [ -e ${quote(`${state}/credentials-preexisting`)} ] || rm -rf -- ${quote(CREDENTIALS)}; fi; if [ -s ${quote(`${state}/packages.added`)} ]; then while IFS= read -r package; do [ -z "$package" ] || env ASSUME_ALWAYS_YES=yes pkg delete -f -y "$package"; done < ${quote(`${state}/packages.added`)}; fi; if [ -d ${quote(state)} ]; then [ -e ${quote(`${state}/user-preexisting`)} ] || pw userdel webminai_homeassistant >/dev/null 2>&1 || true; [ -e ${quote(`${state}/group-preexisting`)} ] || pw groupdel webminai_homeassistant >/dev/null 2>&1 || true; fi; rmdir /usr/local/etc/nginx >/dev/null 2>&1 || true; rm -rf -- ${quote(state)}`
}

function waitHomeAssistant () {
  return 'ready=; for attempt in $(jot 360); do curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8123/ >/dev/null 2>&1 && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]'
}

function waitPublic () {
  return `ready=; for attempt in $(jot 90); do marker=$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:18115/ 2>/dev/null || true); page=$(curl --fail --silent --show-error --max-time 5 http://127.0.0.1:18115/homeassistant/ 2>/dev/null || true); [ "$marker" = ${quote(MARKER)} ] && printf '%s' "$page" | grep -Fi 'home assistant' >/dev/null && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]`
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
