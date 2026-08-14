const VERSION = '2026.8.1'
const PORT = 18115
const APP_PORT = 8123
const MARKER = 'WEBMINAI_HOME_ASSISTANT_OK'
const DATA_ROOT = '/var/lib/webminai-home-assistant-18115'
const CREDENTIALS = '/root/home_assistant_credentials'
const SERVICE_ROOT = '/opt/webminai/services/home-assistant'
const PROJECT = 'webminai-home-assistant-18115'
const HOME_ASSISTANT_IMAGE = 'ghcr.io/home-assistant/home-assistant@sha256:6340a3de3917a9b19368e767310a96dd090f6a19aca8aeadf87fd1145cec9682'
const NGINX_IMAGE = 'nginx@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46'
const IMAGES = [HOME_ASSISTANT_IMAGE, NGINX_IMAGE]
const DPKG_PACKAGE_FORMAT = '$' + '{binary:Package} $' + '{Version}\\n'
const DOCKER_CODENAME_FALLBACK = '$' + '{UBUNTU_CODENAME:-$VERSION_CODENAME}'

export function buildHomeAssistantTask (taskId, linuxContext, docker = {}) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  if (!linuxContext?.identity || !linuxContext?.management) throw new TypeError('Home Assistant task requires a Linux host context')
  if (docker.preferred === true) return buildComposeTask(taskId, linuxContext, docker)
  return buildCompatibilityTask(taskId, linuxContext)
}

export function homeAssistantRelease () {
  return Object.freeze({ version: VERSION, images: Object.freeze([...IMAGES]) })
}

function buildCompatibilityTask (taskId, context) {
  const state = `/var/lib/webminai/task-state/${taskId}-home-assistant-compatibility`
  const identity = context.identity
  const reason = `Home Assistant ${VERSION} is not installed natively on ${identity.id} ${identity.versionId ?? ''}: current supported installation methods are Home Assistant OS and Home Assistant Container, while Docker is auto-disabled for this container host.`
  const files = [state, `${state}/report.txt`]
  return envelope({
    context,
    route: 'no-change-container-required',
    overview: `Record a no-change Home Assistant compatibility result for ${identity.id} ${identity.versionId ?? ''}.`,
    files,
    commands: [item('record-compatibility', 'preflight', join(['set -eu', ...ownedAbsent(), `install -d -o root -g root -m 0700 ${quote(state)}`, `printf '%s\\n' ${quote(reason)} > ${quote(`${state}/report.txt`)}`, `chmod 0600 ${quote(`${state}/report.txt`)}`]), 'Record the supported-installation result without creating an unsupported Python environment')],
    revertCommands: [item('remove-compatibility-report', 'cleanup', `set -eu; rm -rf -- ${quote(state)}; printf '%s\\n' compatibility-report-removed`, 'Remove only the task-owned compatibility report', [], 30000, undefined, 'destructive')],
    verifyApplied: `test -s ${quote(`${state}/report.txt`)} && grep -Fq 'supported installation methods' ${quote(`${state}/report.txt`)} && test ! -e ${quote(DATA_ROOT)} && test ! -e ${quote(CREDENTIALS)}`,
    verifyReverted: `test ! -e ${quote(state)}`
  })
}

function buildComposeTask (taskId, context, docker) {
  if (!docker.ready && docker.installMethod !== 'official-apt') throw new Error('learned Home Assistant Container setup requires Docker ready or the reviewed official apt route')
  const state = `/var/lib/webminai/task-state/${taskId}-home-assistant-compose`
  const files = [state, SERVICE_ROOT, `${SERVICE_ROOT}/compose.yaml`, `${SERVICE_ROOT}/nginx.conf`, DATA_ROOT, `${DATA_ROOT}/configuration.yaml`, CREDENTIALS]
  const commands = [
    item('capture-baseline', 'baseline', composeBaseline(state), 'Capture Docker, image, service, port, and task path state exactly once'),
    item('prepare-docker', 'packages', prepareDocker(state), 'Install Docker and Compose only when the reviewed host route requires them', ['capture-baseline'], 900000, 'job'),
    item('generate-credentials', 'secrets', credentialsCommand(), 'Generate the initial administrator name and password on-host without emitting them', ['capture-baseline']),
    item('write-compose', 'configure', writeCompose(), 'Write the digest-pinned isolated Home Assistant and nginx Compose project', ['prepare-docker', 'generate-credentials']),
    item('start-compose', 'services', startCompose(), 'Start Home Assistant and nginx with bounded first-start readiness', ['write-compose'], 1800000, 'job'),
    item('initialize-home-assistant', 'initialize', initializeHomeAssistant(), 'Complete onboarding from protected host-generated administrator credentials', ['start-compose'], 900000, 'job'),
    item('verify-compose', 'verify', verifyCompose(), 'Verify version, onboarding, web UI, SQLite persistence, marker, and restart recovery', ['initialize-home-assistant'], 900000, 'job')
  ]
  const revertCommands = [
    item('remove-compose-project', 'cleanup', removeCompose(state), 'Remove only task-owned containers, network, and newly pulled images', [], 1200000, 'job', 'destructive'),
    item('remove-compose-files', 'cleanup', `set -eu; rm -rf -- ${quote(SERVICE_ROOT)} ${quote(DATA_ROOT)} ${quote(CREDENTIALS)}`, 'Remove task-owned configuration, database, Compose files, and credentials', ['remove-compose-project'], 300000, undefined, 'destructive'),
    item('restore-docker', 'cleanup', restoreDocker(state), 'Restore Docker package and service state when introduced by this task', ['remove-compose-files'], 900000, 'job', 'destructive')
  ]
  return envelope({
    context,
    route: 'compose-official-isolated',
    overview: `Deploy Home Assistant Container ${VERSION} without privileged mode, host networking, D-Bus, or device access on port ${PORT}.`,
    files,
    commands,
    revertCommands,
    verifyApplied: verifyCompose(),
    verifyReverted: `test ! -e ${quote(SERVICE_ROOT)} && test ! -e ${quote(DATA_ROOT)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)} && { ! command -v docker >/dev/null 2>&1 || ! docker ps -aq --filter label=com.docker.compose.project=${quote(PROJECT)} | grep -q .; }`
  })
}

function envelope ({ context, route, overview, files, commands, revertCommands, verifyApplied, verifyReverted }) {
  const identity = context.identity
  const supported = route.startsWith('compose')
  return {
    plan: {
      summary: supported ? 'Deploy a learned reversible Home Assistant Container service' : 'Record Home Assistant compatibility result',
      changeOverview: overview,
      modifiedFiles: files,
      assumptions: [
        `Authoritative Linux profile: ${identity.id} ${identity.versionId ?? ''}`.trim(),
        `Resolved Home Assistant matrix: stable ${VERSION}; Home Assistant OS and Home Assistant Container are the supported installation methods.`,
        'Administrator credentials are generated on-host and only protected paths enter plans and logs.'
      ],
      warnings: supported
        ? [`This controlled validation publishes TCP port ${PORT} through nginx and deliberately disables privileged mode, host networking, D-Bus, device mappings, and real-device discovery.`]
        : ['No application is installed because Home Assistant Core host installation is no longer supported and Docker is disabled for this container host.'],
      requiresConfirmation: true,
      compatibilityManifest: compatibilityManifest(context, route),
      commands,
      revertCommands
    },
    verifyApplied,
    verifyReverted,
    stateProbe: `for path in ${files.map(quote).join(' ')}; do if [ -e "$path" ]; then printf 'present=%s\\n' "$path"; else printf 'absent=%s\\n' "$path"; fi; done`
  }
}

function compatibilityManifest (context, route) {
  const supported = route.startsWith('compose')
  return {
    format: 'webminai-compatibility-manifest',
    version: 1,
    application: { id: 'home-assistant', version: VERSION },
    host: { fingerprint: context.fingerprint, distribution: context.identity.id, distributionVersion: context.identity.versionId, architecture: context.identity.architecture, family: context.management.family },
    selectedRoute: { id: route, status: supported ? 'supported' : 'unsupported' },
    components: [
      { profileId: 'home-assistant', selectedVersion: VERSION, source: supported ? 'official-container-image' : 'unavailable', status: supported ? 'supported' : 'unavailable' },
      { profileId: 'nginx', selectedVersion: 'digest-pinned', source: supported ? 'official-container-image' : 'not-selected', status: supported ? 'supported' : 'not-selected' }
    ]
  }
}

function ownedAbsent () {
  return [DATA_ROOT, CREDENTIALS, SERVICE_ROOT].map(path => `test ! -e ${quote(path)}`)
}

function composeBaseline (state) {
  return join([
    'set -eu', `if [ ! -s ${quote(`${state}/packages.before`)} ]; then`, ...ownedAbsent(), `install -d -o root -g root -m 0700 ${quote(state)}`, `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(`${state}/packages.before`)}`, `systemctl is-active --quiet docker 2>/dev/null && : > ${quote(`${state}/docker.active`)} || true`, `command -v docker >/dev/null 2>&1 && : > ${quote(`${state}/docker.existed`)} || true`, ...IMAGES.map((image, index) => `docker image inspect ${quote(image)} >/dev/null 2>&1 && : > ${quote(`${state}/image-${index}.existed`)} || true`), 'fi', 'printf \'%s\\n\' baseline-ready'
  ])
}

function prepareDocker (state) {
  return join([
    'set -eu', 'if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then :; else', `[ ! -e ${quote(`${state}/docker.existed`)} ]`, 'export DEBIAN_FRONTEND=noninteractive', 'apt-get update', 'apt-get install -y ca-certificates curl', 'install -d -m 0755 /etc/apt/keyrings', 'curl --fail --location --silent --show-error https://download.docker.com/linux/ubuntu/gpg --output /etc/apt/keyrings/docker.asc', 'chmod 0644 /etc/apt/keyrings/docker.asc', '. /etc/os-release', `arch=$(dpkg --print-architecture); codename=${DOCKER_CODENAME_FALLBACK}`, 'printf \'%s\\n\' \'Types: deb\' \'URIs: https://download.docker.com/linux/ubuntu\' "Suites: $codename" \'Components: stable\' "Architectures: $arch" \'Signed-By: /etc/apt/keyrings/docker.asc\' > /etc/apt/sources.list.d/docker.sources', 'apt-get update', 'apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin', 'systemctl start docker', 'fi', 'docker info >/dev/null', 'docker compose version >/dev/null', `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(`${state}/packages.after`)}`, `LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} > ${quote(`${state}/packages.added`)} || true`
  ])
}

function credentialsCommand () {
  return join([
    'set -eu', 'umask 077', `install -d -o root -g root -m 0700 ${quote(CREDENTIALS)}`, `[ -s ${quote(`${CREDENTIALS}/admin_username`)} ] || { printf 'webminai_%s\\n' "$(openssl rand -hex 8)" > ${quote(`${CREDENTIALS}/admin_username`)}; }`, `[ -s ${quote(`${CREDENTIALS}/admin_password`)} ] || openssl rand -hex 32 > ${quote(`${CREDENTIALS}/admin_password`)}`, `chmod 0600 ${quote(`${CREDENTIALS}/admin_username`)} ${quote(`${CREDENTIALS}/admin_password`)}`, `printf '%s\\n' ${quote(CREDENTIALS)}`
  ])
}

function writeCompose () {
  const compose = [
    'services:', '  app:', `    image: ${HOME_ASSISTANT_IMAGE}`, '    restart: unless-stopped', '    environment:', '      TZ: Etc/UTC', '    volumes:', `      - ${DATA_ROOT}:/config`, '      - /etc/localtime:/etc/localtime:ro', '    healthcheck:', '      test: ["CMD", "python3", "-c", "import urllib.request; urllib.request.urlopen(\'http://127.0.0.1:8123/\', timeout=5).read()"]', '      interval: 5s', '      timeout: 8s', '      retries: 180', '      start_period: 30s',
    '  nginx:', `    image: ${NGINX_IMAGE}`, '    restart: unless-stopped', '    ports:', `      - "${PORT}:${PORT}"`, '    volumes:', `      - ${SERVICE_ROOT}/nginx.conf:/etc/nginx/conf.d/default.conf:ro`, '    depends_on:', '      app:', '        condition: service_healthy'
  ].join('\\n')
  const configuration = ['homeassistant:', `  name: ${MARKER}`, '  latitude: 0', '  longitude: 0', '  elevation: 0', '  unit_system: metric', '  time_zone: Etc/UTC', '', 'frontend:', 'api:', 'config:', 'history:', 'logbook:', 'recorder:', '', 'http:', '  server_host: 0.0.0.0', `  server_port: ${APP_PORT}`, '  use_x_forwarded_for: true', '  trusted_proxies:', '    - 172.16.0.0/12'].join('\\n')
  const nginx = nginxConfig()
  return join([
    'set -eu', `install -d -o root -g root -m 0755 ${quote(SERVICE_ROOT)}`, `install -d -o root -g root -m 0750 ${quote(DATA_ROOT)}`, `printf '%s\\n' ${compose.split('\\n').map(quote).join(' ')} > ${quote(`${SERVICE_ROOT}/compose.yaml`)}`, `chmod 0644 ${quote(`${SERVICE_ROOT}/compose.yaml`)}`, `printf '%s\\n' ${configuration.split('\\n').map(quote).join(' ')} > ${quote(`${DATA_ROOT}/configuration.yaml`)}`, `chmod 0640 ${quote(`${DATA_ROOT}/configuration.yaml`)}`, `printf '%s\\n' ${nginx.split('\\n').map(quote).join(' ')} > ${quote(`${SERVICE_ROOT}/nginx.conf`)}`, `chmod 0644 ${quote(`${SERVICE_ROOT}/nginx.conf`)}`, `docker compose -p ${quote(PROJECT)} -f ${quote(`${SERVICE_ROOT}/compose.yaml`)} config --quiet`, 'printf \'%s\\n\' compose-ready'
  ])
}

function startCompose () {
  const compose = composeCommand()
  return join(['set -eu', `${compose} pull`, `${compose} up -d`, waitCompose(), waitUrl(`http://127.0.0.1:${PORT}/homeassistant/`, 240), `curl --fail --silent --show-error http://127.0.0.1:${PORT}/ | grep -Fx ${quote(MARKER)}`])
}

function initializeHomeAssistant () {
  const base = `http://127.0.0.1:${PORT}`
  const compose = composeCommand()
  const clientId = `${base}/`
  return join([
    'set -eu', `if [ ! -e ${quote(`${CREDENTIALS}/initialized`)} ]; then`, waitUrl(`${base}/api/onboarding`, 240), `username=$(cat ${quote(`${CREDENTIALS}/admin_username`)})`, `password=$(cat ${quote(`${CREDENTIALS}/admin_password`)})`, `response=$(curl --fail --silent --show-error --request POST --header 'Content-Type: application/json' --data "{\\"client_id\\":\\"${clientId}\\",\\"name\\":\\"${MARKER}\\",\\"username\\":\\"$username\\",\\"password\\":\\"$password\\",\\"language\\":\\"en\\"}" ${quote(`${base}/api/onboarding/users`)})`, `code=$(printf '%s' "$response" | ${compose} exec -T app python3 -c ${quote("import json,sys; print(json.load(sys.stdin)['auth_code'])")})`, `token_response=$(curl --fail --silent --show-error --request POST --data-urlencode 'grant_type=authorization_code' --data-urlencode "code=$code" --data-urlencode ${quote(`client_id=${clientId}`)} ${quote(`${base}/auth/token`)})`, `token=$(printf '%s' "$token_response" | ${compose} exec -T app python3 -c ${quote("import json,sys; print(json.load(sys.stdin)['access_token'])")})`, `curl --fail --silent --show-error --request POST --header "Authorization: Bearer $token" ${quote(`${base}/api/onboarding/core_config`)} >/dev/null`, `curl --fail --silent --show-error --request POST --header "Authorization: Bearer $token" --header 'Content-Type: application/json' --data ${quote(`{"client_id":"${clientId}","redirect_uri":"${clientId}"}`)} ${quote(`${base}/api/onboarding/integration`)} >/dev/null`, `curl --fail --silent --show-error --request POST --header "Authorization: Bearer $token" ${quote(`${base}/api/onboarding/analytics`)} >/dev/null`, `: > ${quote(`${CREDENTIALS}/initialized`)}`, `chmod 0600 ${quote(`${CREDENTIALS}/initialized`)}`, 'fi', `curl --fail --silent --show-error ${quote(`${base}/api/onboarding`)} | ${compose} exec -T app python3 -c ${quote("import json,sys; assert all(step['done'] for step in json.load(sys.stdin))")}`, 'printf \'%s\\n\' initialized'
  ])
}

function verifyCompose () {
  const compose = composeCommand()
  return join([
    'set -eu', waitCompose(), waitUrl(`http://127.0.0.1:${PORT}/homeassistant/`, 180), `${compose} exec -T app python3 -c ${quote('from homeassistant.const import __version__; print(__version__)')} | grep -Fx ${quote(VERSION)}`, `curl --fail --silent --show-error http://127.0.0.1:${PORT}/ | grep -Fx ${quote(MARKER)}`, `curl --fail --silent --show-error http://127.0.0.1:${PORT}/homeassistant/ | grep -Fi 'home assistant'`, `curl --fail --silent --show-error http://127.0.0.1:${PORT}/api/onboarding | ${compose} exec -T app python3 -c ${quote("import json,sys; assert all(step['done'] for step in json.load(sys.stdin))")}`, `test -s ${quote(`${DATA_ROOT}/home-assistant_v2.db`)}`, `test -s ${quote(`${DATA_ROOT}/.storage/auth`)}`, `grep -Fq ${quote(MARKER)} ${quote(`${DATA_ROOT}/configuration.yaml`)}`, `test "$(stat -c '%a' ${quote(CREDENTIALS)})" = 700`, 'printf \'%s\\n\' home-assistant-verified'
  ])
}

function removeCompose (state) {
  const compose = composeCommand()
  const commands = ['set -eu', `[ -d ${quote(state)} ] || { printf '%s\\n' already-reverted; exit 0; }`, `if command -v docker >/dev/null 2>&1 && [ -f ${quote(`${SERVICE_ROOT}/compose.yaml`)} ]; then ${compose} down --remove-orphans || true; fi`]
  IMAGES.forEach((image, index) => commands.push(`if command -v docker >/dev/null 2>&1 && [ ! -e ${quote(`${state}/image-${index}.existed`)} ]; then docker image rm ${quote(image)} >/dev/null 2>&1 || true; fi`))
  return join(commands)
}

function restoreDocker (state) {
  return join([
    'set -eu', `[ -d ${quote(state)} ] || { printf '%s\\n' already-reverted; exit 0; }`, `if [ ! -e ${quote(`${state}/docker.existed`)} ]; then`, removeDebianPackages(`${state}/packages.added`), 'rm -f /etc/apt/sources.list.d/docker.sources /etc/apt/keyrings/docker.asc', 'rm -rf -- /var/lib/docker /var/lib/containerd', 'fi', `if [ -e ${quote(`${state}/docker.active`)} ]; then systemctl start docker 2>/dev/null || true; else systemctl stop docker 2>/dev/null || true; fi`, `rm -rf -- ${quote(state)}`
  ])
}

function nginxConfig () {
  return ['server {', `    listen ${PORT};`, '    server_name _;', '    location = / { default_type text/plain; return 200 "' + MARKER + '\\n"; }', '    location /homeassistant/ {', `        proxy_pass http://app:${APP_PORT}/;`, '        proxy_http_version 1.1;', '        proxy_set_header Host $host;', '        proxy_set_header X-Real-IP $remote_addr;', '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;', '        proxy_set_header X-Forwarded-Proto $scheme;', '        proxy_set_header Upgrade $http_upgrade;', '        proxy_set_header Connection "upgrade";', '    }', '    location / {', `        proxy_pass http://app:${APP_PORT};`, '        proxy_http_version 1.1;', '        proxy_set_header Host $host;', '        proxy_set_header X-Real-IP $remote_addr;', '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;', '        proxy_set_header X-Forwarded-Proto $scheme;', '        proxy_set_header Upgrade $http_upgrade;', '        proxy_set_header Connection "upgrade";', '    }', '}'].join('\\n')
}

function removeDebianPackages (list) {
  return `if [ -s ${quote(list)} ]; then packages=$(awk '{print $1}' ${quote(list)} | grep -Ev '^(netdata|openssh|curl|ca-certificates)(:|$)' | tr '\\n' ' '); [ -z "$packages" ] || DEBIAN_FRONTEND=noninteractive apt-get purge -y $packages || true; fi`
}

function composeCommand () {
  return `docker compose -p ${quote(PROJECT)} -f ${quote(`${SERVICE_ROOT}/compose.yaml`)}`
}

function waitUrl (url, attempts) {
  return `ready=; for attempt in $(seq 1 ${attempts}); do if curl --fail --silent --show-error --max-time 5 ${quote(url)} >/dev/null 2>&1; then ready=yes; break; fi; sleep 2; done; [ "$ready" = yes ]`
}

function waitCompose () {
  return `ready=; for attempt in $(seq 1 240); do status=$(docker inspect ${quote(`${PROJECT}-app-1`)} --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || true); [ "$status" = healthy ] && ready=yes && break; sleep 5; done; [ "$ready" = yes ]`
}

function item (id, phase, command, purpose, dependsOn = [], timeoutMs = 300000, executionMode, risk = 'change') {
  return { id, phase, command, purpose, risk, timeoutMs, requiresSudo: true, dependsOn, ...(executionMode ? { executionMode } : {}) }
}

function join (parts) {
  return parts.filter(Boolean).join('; ').replaceAll('then; ', 'then ').replaceAll('else; ', 'else ')
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
