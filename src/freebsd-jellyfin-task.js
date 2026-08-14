const VERSION = '10.11.11'
const SERVICE_ROOT = '/var/db/webminai-jellyfin-18113'
const CREDENTIALS = '/root/jellyfin_credentials'
const RC_CONFIG = '/etc/rc.conf.d/jellyfin'
const NGINX_CONFIG = '/usr/local/etc/nginx/nginx.conf'
const MARKER = 'WEBMINAI_JELLYFIN_OK'

export function buildFreebsdJellyfinTask (taskId, freebsdExecution) {
  if (freebsdExecution?.platform !== 'freebsd') throw new Error('FreeBSD Jellyfin requires a FreeBSD execution inventory')
  const state = `/var/lib/webminai/task-state/${taskId}-jellyfin-freebsd`
  return {
    plan: {
      summary: 'Deploy a learned reversible native FreeBSD Jellyfin server',
      changeOverview: `Install the native FreeBSD Jellyfin ${VERSION} package with isolated configuration, cache, media, protected onboarding credentials, and nginx on port 18113.`,
      modifiedFiles: [state, SERVICE_ROOT, CREDENTIALS, RC_CONFIG, NGINX_CONFIG],
      assumptions: ['FreeBSD 15.1 amd64 with pkg and rc.d', `The FreeBSD latest repository supplies Jellyfin ${VERSION}, matching the promoted application release`],
      warnings: ['The controlled route uses empty media and does not enable discovery, hardware acceleration, transcoding tests, TLS, or public remote access.'],
      commands: [
        item('prepare-jellyfin', prepare(state), 'Capture the package baseline and prepare isolated directories and protected onboarding credentials'),
        item('install-jellyfin-runtime', installRuntime(state), `Install the native FreeBSD Jellyfin ${VERSION} and nginx packages`, ['prepare-jellyfin'], 1800000, 'job'),
        item('deploy-jellyfin', deploy(), 'Configure rc.d, start Jellyfin and nginx, and initialize from protected credentials', ['install-jellyfin-runtime'], 900000, 'job'),
        item('verify-jellyfin', verify(), 'Verify version, marker, web UI, database, ownership, and restart recovery', ['deploy-jellyfin'], 600000, 'job')
      ],
      revertCommands: [item('remove-jellyfin', remove(state), 'Remove only task-owned Jellyfin containers, storage, state, and credentials', [], 600000, 'job', 'destructive')]
    },
    verifyApplied: `${primaryAddress()}; response=$(mktemp); trap 'rm -f -- "$response"' EXIT; curl --fail --silent --show-error --max-time 20 --output "$response" http://$address:18113/; grep -Fxq ${MARKER} "$response"; curl --fail --silent --show-error --max-time 20 --output "$response" http://$address:18113/jellyfin/System/Info/Public; grep -Fq '"Version":"${VERSION}"' "$response"`,
    verifyReverted: `test ! -e ${quote(SERVICE_ROOT)} && test ! -e ${quote(state)} && ! pkg info -e jellyfin >/dev/null 2>&1 && ! pkg info -e nginx >/dev/null 2>&1`,
    stateProbe: `test -e ${quote(state)} && printf applied || printf absent`
  }
}

function prepare (state) {
  return `[ ! -d ${quote(state)} ] || exit 0; ${prepareFresh(state)}`
}

function prepareFresh (state) {
  return `set -eu; test "$(uname -s)" = FreeBSD; command -v pkg >/dev/null; test ! -e ${quote(SERVICE_ROOT)}; test ! -e ${quote(RC_CONFIG)}; pkg info -e jellyfin >/dev/null 2>&1 && { echo 'pre-existing Jellyfin package is outside task ownership' >&2; exit 1; } || true; pkg info -e nginx >/dev/null 2>&1 && { echo 'pre-existing nginx package is outside task ownership' >&2; exit 1; } || true; install -d -m 0700 ${quote(state)}; pkg query -a '%n' | LC_ALL=C sort -u > ${quote(`${state}/packages.before`)}; install -d -m 0755 ${quote(SERVICE_ROOT)} ${quote(`${SERVICE_ROOT}/config`)} ${quote(`${SERVICE_ROOT}/cache`)} ${quote(`${SERVICE_ROOT}/data`)} ${quote(`${SERVICE_ROOT}/logs`)} ${quote(`${SERVICE_ROOT}/media`)} ${quote(`${SERVICE_ROOT}/run`)}; if [ -e ${quote(CREDENTIALS)} ]; then : > ${quote(`${state}/credentials-preexisting`)}; else install -d -m 0700 ${quote(CREDENTIALS)}; fi; [ -s ${quote(`${CREDENTIALS}/admin_username`)} ] || { umask 077; printf 'webminai_%s\n' "$(openssl rand -hex 8)" > ${quote(`${CREDENTIALS}/admin_username`)}; }; [ -s ${quote(`${CREDENTIALS}/admin_password`)} ] || { umask 077; openssl rand -hex 32 > ${quote(`${CREDENTIALS}/admin_password`)}; }; chmod 0600 ${quote(CREDENTIALS)}/*`
}

function installRuntime (state) {
  return `set -eu; env ASSUME_ALWAYS_YES=yes pkg install -y jellyfin-${VERSION} nginx curl ca_root_nss; [ "$(pkg query '%v' jellyfin)" = ${VERSION} ]; pkg query -a '%n' | LC_ALL=C sort -u > ${quote(`${state}/packages.after`)}; LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} > ${quote(`${state}/packages.added`)}`
}

function deploy () {
  return `set -eu; root=${quote(SERVICE_ROOT)}; chown -R jellyfin:jellyfin "$root/config" "$root/cache" "$root/data" "$root/logs" "$root/media" "$root/run"; chmod 0750 "$root/config" "$root/cache" "$root/data" "$root/logs" "$root/run"; chmod 0755 "$root/media"; install -d -m 0755 ${quote('/etc/rc.conf.d')}; cat > ${quote(RC_CONFIG)} <<'CONF'
jellyfin_enable="YES"
jellyfin_data_dir="${SERVICE_ROOT}/data"
jellyfin_cache_dir="${SERVICE_ROOT}/cache"
jellyfin_pid_dir="${SERVICE_ROOT}/run"
jellyfin_extraargs="--configdir ${SERVICE_ROOT}/config --logdir ${SERVICE_ROOT}/logs --webdir /usr/local/jellyfin/jellyfin-web"
CONF
cat > ${quote(NGINX_CONFIG)} <<'CONF'
user root wheel;
worker_processes 1;
events { worker_connections 256; }
http { server { listen 18113; location = / { default_type text/plain; return 200 "${MARKER}\\n"; } location /jellyfin/ { proxy_pass http://127.0.0.1:8096/; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; } } }
CONF
chmod 0644 ${quote(RC_CONFIG)} ${quote(NGINX_CONFIG)}; service jellyfin status >/dev/null 2>&1 || service jellyfin start; ready=; if [ -e ${quote(`${CREDENTIALS}/initialized`)} ]; then readiness_url=http://127.0.0.1:8096/health; else readiness_url=http://127.0.0.1:8096/Startup/Configuration; fi; for attempt in $(jot 180); do curl --fail --silent --show-error --max-time 3 "$readiness_url" >/dev/null 2>&1 && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]; if [ ! -e ${quote(`${CREDENTIALS}/initialized`)} ]; then username=$(cat ${quote(`${CREDENTIALS}/admin_username`)}); password=$(cat ${quote(`${CREDENTIALS}/admin_password`)}); curl --fail --silent --show-error http://127.0.0.1:8096/Startup/User >/dev/null; curl --fail --silent --show-error --request POST --header 'Content-Type: application/json' --data ${quote(`{"ServerName":"${MARKER}","UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"}`)} http://127.0.0.1:8096/Startup/Configuration >/dev/null; curl --fail --silent --show-error --request POST --header 'Content-Type: application/json' --data "{\\"Name\\":\\"$username\\",\\"Password\\":\\"$password\\"}" http://127.0.0.1:8096/Startup/User >/dev/null; curl --fail --silent --show-error --request POST --header 'Content-Type: application/json' --data ${quote('{"EnableRemoteAccess":false,"EnableAutomaticPortMapping":false}')} http://127.0.0.1:8096/Startup/RemoteAccess >/dev/null; curl --fail --silent --show-error --request POST http://127.0.0.1:8096/Startup/Complete >/dev/null; : > ${quote(`${CREDENTIALS}/initialized`)}; chmod 0600 ${quote(`${CREDENTIALS}/initialized`)}; fi; nginx -t; if service nginx status >/dev/null 2>&1; then service nginx onerestart; else service nginx onestart; fi; curl --fail --silent --show-error http://127.0.0.1:8096/System/Info/Public | grep -Fq ${MARKER}`
}

function verify () {
  return `set -eu; response=$(mktemp); trap 'rm -f -- "$response"' EXIT; curl --fail --silent --show-error --max-time 20 --output "$response" http://127.0.0.1:8096/System/Info/Public; grep -Fq '"Version":"${VERSION}"' "$response"; grep -Fq ${MARKER} "$response"; curl --fail --silent --show-error --max-time 20 --output "$response" http://127.0.0.1:8096/web/; grep -Fiq jellyfin "$response"; find ${quote(`${SERVICE_ROOT}/data`)} -maxdepth 2 -type f -name '*.db' | grep -q .; [ "$(stat -f '%Lp' ${quote(CREDENTIALS)})" = 700 ]; service jellyfin restart; service nginx onerestart; ready=; for attempt in $(jot 120); do curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8096/health >/dev/null 2>&1 && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]; service jellyfin status >/dev/null; service nginx status >/dev/null`
}

function remove (state) {
  return `set -eu; service nginx onestop >/dev/null 2>&1 || true; service jellyfin stop >/dev/null 2>&1 || true; rm -f -- ${quote(RC_CONFIG)} ${quote(NGINX_CONFIG)}; rm -rf -- ${quote(SERVICE_ROOT)}; if [ -d ${quote(state)} ] && [ ! -e ${quote(`${state}/credentials-preexisting`)} ]; then rm -rf -- ${quote(CREDENTIALS)}; fi; if [ -s ${quote(`${state}/packages.added`)} ]; then packages=$(tr '\n' ' ' < ${quote(`${state}/packages.added`)}); [ -z "$packages" ] || env ASSUME_ALWAYS_YES=yes pkg delete -y $packages; fi; rm -rf -- ${quote(state)}`
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
