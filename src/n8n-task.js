const VERSION = '2.33.7'
const PORT = 18109
const N8N_PORT = 5678
const MARKER = 'WEBMINAI_N8N_OK'
const SERVICE = 'webminai-n8n-18109'
const APP_ROOT = '/opt/webminai-n8n-18109'
const DATA_ROOT = '/var/lib/webminai-n8n-18109'
const CREDENTIALS = '/root/n8n_credentials'
const SERVICE_ROOT = '/opt/webminai/services/n8n'
const PROJECT = 'webminai-n8n-18109'
const SWAP_FILE = '/var/lib/webminai/webminai-n8n-18109.swap'
const N8N_IMAGE = `docker.n8n.io/n8nio/n8n:${VERSION}`
const NGINX_IMAGE = 'nginx:1.30.4-alpine'
const DPKG_PACKAGE_FORMAT = '$' + '{binary:Package}\\n'
const DOCKER_CODENAME_FALLBACK = '$' + '{UBUNTU_CODENAME:-$VERSION_CODENAME}'

export function buildN8nTask (taskId, linuxContext, docker = {}) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  if (!linuxContext?.identity || !linuxContext?.management) throw new TypeError('n8n task requires a Linux host context')
  return docker.preferred === true
    ? buildComposeTask(taskId, linuxContext, docker)
    : buildNativeTask(taskId, linuxContext)
}

export function n8nRelease () {
  return Object.freeze({ version: VERSION, image: N8N_IMAGE, nginxImage: NGINX_IMAGE })
}

function buildNativeTask (taskId, context) {
  const family = context.management.family
  const supported = new Set(['debian', 'alpine', 'arch', 'rhel', 'suse'])
  if (!supported.has(family)) throw new Error(`learned native n8n setup does not support ${family}`)
  const state = `/var/lib/webminai/task-state/${taskId}-n8n-linux`
  const profile = nativeProfile(context)
  const commands = [
    item('capture-baseline', 'baseline', nativeBaseline(state, profile), 'Capture package, repository, nginx, and task-owned path state exactly once'),
    item('install-runtime', 'packages', nativePackages(state, context, profile), `Install the reviewed ${profile.nodeDescription}, nginx, and required utilities`, ['capture-baseline'], 1800000, 'job'),
    item('install-n8n', 'acquire', nativeNpmInstall(state, profile), `Install n8n ${VERSION} into an isolated application prefix`, ['install-runtime'], 3600000, 'job'),
    item('generate-credentials', 'secrets', nativeCredentials(), 'Generate the n8n encryption key on-host without emitting it', ['capture-baseline']),
    item('configure-services', 'configure', nativeConfigure(profile), 'Create the locked service account, n8n service, and isolated nginx marker vhost', ['install-n8n', 'generate-credentials']),
    item('verify-n8n', 'verify', nativeVerify(profile), 'Verify n8n health, SQLite persistence, and the nginx marker', ['configure-services'], 900000, 'job')
  ]
  const revertCommands = [
    item('stop-n8n', 'cleanup', nativeStop(profile), 'Stop and remove only the task-owned n8n service and nginx vhost', [], 300000, undefined, 'destructive'),
    item('remove-n8n-files', 'cleanup', `set -eu; rm -rf -- ${quote(APP_ROOT)} ${quote(DATA_ROOT)} ${quote(CREDENTIALS)}`, 'Remove task-owned application data and protected credentials', ['stop-n8n'], 300000, undefined, 'destructive'),
    item('restore-packages', 'cleanup', nativeRestore(state, context, profile), 'Restore package, NodeSource repository, and nginx service state from the baseline', ['remove-n8n-files'], 900000, 'job', 'destructive')
  ]
  return taskEnvelope({
    context,
    state,
    route: `native-${family}`,
    overview: `Install n8n ${VERSION} with ${profile.nodeDescription}, an isolated service, SQLite persistence, and nginx on port ${PORT}.`,
    files: [state, APP_ROOT, DATA_ROOT, CREDENTIALS, profile.serviceFile, profile.nginxVhost, ...profile.repositoryPaths],
    commands,
    revertCommands,
    verifyApplied: nativeVerify(profile),
    verifyReverted: `test ! -e ${quote(APP_ROOT)} && test ! -e ${quote(DATA_ROOT)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)} && test ! -e ${quote(profile.serviceFile)} && test ! -e ${quote(profile.nginxVhost)}`
  })
}

function buildComposeTask (taskId, context, docker) {
  if (!docker.ready && docker.installMethod !== 'official-apt') throw new Error('learned n8n Compose setup requires Docker ready or the reviewed official apt route')
  const state = `/var/lib/webminai/task-state/${taskId}-n8n-compose`
  const commands = [
    item('capture-baseline', 'baseline', composeBaseline(state), 'Capture Docker, image, service, and task-path state exactly once'),
    item('prepare-docker', 'packages', prepareDocker(state), 'Install Docker and Compose only when the reviewed host route requires them', ['capture-baseline'], 900000, 'job'),
    item('generate-credentials', 'secrets', composeCredentials(), 'Generate the n8n encryption key on-host without emitting it', ['capture-baseline']),
    item('write-compose', 'configure', writeCompose(), 'Write the reviewed n8n and nginx Compose project using a protected secret file', ['prepare-docker', 'generate-credentials']),
    item('prepare-n8n-swap', 'services', prepareComposeSwap(state), 'Provide reversible task-owned memory headroom for n8n startup and restart verification', ['write-compose']),
    item('start-compose', 'services', startCompose(state), 'Pull and start the pinned n8n and nginx services with bounded readiness', ['prepare-n8n-swap'], 2700000, 'job'),
    item('verify-compose', 'verify', verifyCompose(), 'Verify n8n health, SQLite persistence, and the nginx marker without mutating runtime state', ['start-compose'], 900000, 'job')
  ]
  const revertCommands = [
    item('remove-compose-project', 'cleanup', removeCompose(state), 'Remove only the task-owned Compose project, volume, and newly pulled images', [], 900000, 'job', 'destructive'),
    item('remove-n8n-swap', 'cleanup', removeComposeSwap(state), 'Disable and remove only the task-owned n8n swap file', ['remove-compose-project'], 300000, undefined, 'destructive'),
    item('remove-compose-files', 'cleanup', `set -eu; rm -rf -- ${quote(SERVICE_ROOT)} ${quote(CREDENTIALS)}`, 'Remove task-owned Compose files and protected credentials', ['remove-n8n-swap'], 300000, undefined, 'destructive'),
    item('restore-docker', 'cleanup', restoreDocker(state), 'Restore Docker package and service state when Docker was introduced by this task', ['remove-compose-files'], 900000, 'job', 'destructive')
  ]
  return taskEnvelope({
    context,
    state,
    route: 'compose-sqlite',
    overview: `Deploy n8n ${VERSION} and nginx through Compose with SQLite persistence on port ${PORT}.`,
    files: [state, SERVICE_ROOT, `${SERVICE_ROOT}/compose.yaml`, `${SERVICE_ROOT}/nginx.conf`, CREDENTIALS, SWAP_FILE],
    commands,
    revertCommands,
    verifyApplied: verifyCompose(),
    verifyReverted: `test ! -e ${quote(SERVICE_ROOT)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)} && test ! -e ${quote(SWAP_FILE)} && { ! command -v docker >/dev/null 2>&1 || ! docker ps -aq --filter label=com.docker.compose.project=${quote(PROJECT)} | grep -q .; }`
  })
}

function taskEnvelope ({ context, state, route, overview, files, commands, revertCommands, verifyApplied, verifyReverted }) {
  const identity = context.identity
  return {
    plan: {
      summary: `Deploy a learned reversible ${route.startsWith('compose') ? 'n8n Compose' : 'native n8n'} service`,
      changeOverview: overview,
      modifiedFiles: files,
      assumptions: [
        `Authoritative Linux profile: ${identity.id} ${identity.versionId ?? ''}`.trim(),
        `Resolved application/runtime matrix: n8n ${VERSION} on Node.js 22.22+ or 24.x.`,
        'The encryption key is generated on-host and only its protected path is included in plans and logs.'
      ],
      warnings: [`This controlled validation publishes only the nginx marker on TCP port ${PORT}; n8n itself remains loopback-only or Compose-internal.`],
      requiresConfirmation: true,
      compatibilityManifest: {
        format: 'webminai-compatibility-manifest',
        version: 1,
        application: { id: 'n8n', version: VERSION },
        host: { fingerprint: context.fingerprint, distribution: identity.id, distributionVersion: identity.versionId, architecture: identity.architecture, family: context.management.family },
        selectedRoute: { id: route, status: 'supported' },
        components: [{ profileId: 'nodejs', selectedVersion: route.startsWith('compose') ? 'image-managed' : '22-or-24', source: route.startsWith('compose') ? 'official-container-image' : 'reviewed-distro-or-nodesource-route', status: 'supported' }, { profileId: 'nginx', selectedVersion: 'distribution-or-image', source: 'reviewed-profile', status: 'supported' }]
      },
      commands,
      revertCommands
    },
    verifyApplied,
    verifyReverted,
    stateProbe: `for path in ${files.map(quote).join(' ')}; do if [ -e "$path" ]; then printf 'present=%s\\n' "$path"; else printf 'absent=%s\\n' "$path"; fi; done`
  }
}

function nativeProfile (context) {
  const family = context.management.family
  const wordpress = context.applications?.wordpress ?? {}
  const systemd = context.management.serviceManager === 'systemd'
  if (!systemd && family !== 'alpine') throw new Error(`unsupported n8n service manager: ${context.management.serviceManager}`)
  const values = {
    family,
    systemd,
    nodeDescription: family === 'arch' ? 'distribution Node.js 22 LTS runtime' : family === 'alpine' || family === 'suse' ? 'distribution Node.js 24 runtime' : 'NodeSource Node.js 24 runtime',
    serviceFile: systemd ? `/etc/systemd/system/${SERVICE}.service` : `/etc/init.d/${SERVICE}`,
    nginxService: wordpress.nginxService ?? (systemd ? 'nginx.service' : 'nginx'),
    nginxVhost: wordpress.nginxVhost
      ? wordpress.nginxVhost.replace('webminai-wordpress-18101', SERVICE)
      : family === 'alpine' ? `/etc/nginx/http.d/${SERVICE}.conf` : `/etc/nginx/conf.d/${SERVICE}.conf`,
    nginxEnableLink: wordpress.nginxEnableLink ? wordpress.nginxEnableLink.replace('webminai-wordpress-18101', SERVICE) : null,
    repositoryPaths: [],
    nginxIncludeRequired: family === 'arch'
  }
  if (family === 'debian') values.repositoryPaths = ['/usr/share/keyrings/nodesource.gpg', '/etc/apt/sources.list.d/nodesource.sources', '/etc/apt/preferences.d/nodejs', '/etc/apt/preferences.d/nsolid']
  if (family === 'rhel') values.repositoryPaths = ['/etc/yum.repos.d/nodesource-nodejs.repo', '/etc/pki/rpm-gpg/NODESOURCE-NSOLID-GPG-SIGNING-KEY-EL']
  if (family === 'arch') values.repositoryPaths = ['/etc/nginx/nginx.conf']
  return values
}

function nativeBaseline (state, profile) {
  const paths = [APP_ROOT, DATA_ROOT, CREDENTIALS, profile.serviceFile, profile.nginxVhost, ...(profile.nginxEnableLink ? [profile.nginxEnableLink] : [])]
  return join([
    'set -eu', `if [ ! -s ${quote(`${state}/packages.before`)} ]; then`, ...paths.map(path => `test ! -e ${quote(path)}`),
    `install -d -o root -g root -m 0700 ${quote(`${state}/repo-backup`)}`,
    `${packageList(profile.family)} > ${quote(`${state}/packages.before`)}`,
    serviceActive(profile.nginxService, profile.systemd, `${state}/nginx.active`),
    serviceEnabled(profile.nginxService, profile.systemd, `${state}/nginx.enabled`),
    ...profile.repositoryPaths.map((path, index) => `if [ -e ${quote(path)} ]; then cp -a -- ${quote(path)} ${quote(`${state}/repo-backup/${index}`)}; : > ${quote(`${state}/repo-${index}.existed`)}; fi`),
    'fi', "printf '%s\\n' baseline-ready"
  ])
}

function nativePackages (state, context, profile) {
  const family = profile.family
  const install = family === 'debian'
    ? debianPackages(profile)
    : family === 'rhel'
      ? rpmPackages()
      : family === 'alpine'
        ? 'apk add --no-cache ca-certificates curl openssl nginx nodejs npm shadow su-exec build-base python3'
        : family === 'arch'
          ? 'pacman -Sy --noconfirm --needed ca-certificates curl openssl nginx nodejs-lts-jod npm base-devel python'
          : 'zypper --non-interactive refresh; zypper --non-interactive install -y ca-certificates curl openssl nginx nodejs24 npm24 shadow gcc gcc-c++ make python3'
  return join([
    'set -eu', install,
    `node -e ${quote("const [major,minor]=process.versions.node.split('.').map(Number); if (!((major===22&&minor>=22)||major===24)) process.exit(1)")}`,
    'npm --version >/dev/null', 'nginx -v',
    `${packageList(family)} > ${quote(`${state}/packages.after`)}`,
    `LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} | grep -Ev '^(netdata|openssh|webminai)(-|$)' > ${quote(`${state}/packages.added`)} || true`,
    "printf '%s\\n' runtime-ready"
  ])
}

function debianPackages (profile) {
  return join([
    'export DEBIAN_FRONTEND=noninteractive', 'apt-get update', 'apt-get install -y ca-certificates curl gnupg nginx build-essential python3',
    'if ! node -e "const [a,b]=process.versions.node.split(\'.\').map(Number);process.exit(((a===22&&b>=22)||a===24)?0:1)" >/dev/null 2>&1; then',
    'install -d -o root -g root -m 0755 /usr/share/keyrings',
    'curl --fail --location --silent --show-error https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes --output /usr/share/keyrings/nodesource.gpg',
    'chmod 0644 /usr/share/keyrings/nodesource.gpg',
    "arch=$(dpkg --print-architecture); printf '%s\\n' 'Types: deb' 'URIs: https://deb.nodesource.com/node_24.x' 'Suites: nodistro' 'Components: main' \"Architectures: $arch\" 'Signed-By: /usr/share/keyrings/nodesource.gpg' > /etc/apt/sources.list.d/nodesource.sources",
    "printf '%s\\n' 'Package: nodejs' 'Pin: origin deb.nodesource.com' 'Pin-Priority: 600' > /etc/apt/preferences.d/nodejs",
    "printf '%s\\n' 'Package: nsolid' 'Pin: origin deb.nodesource.com' 'Pin-Priority: 600' > /etc/apt/preferences.d/nsolid",
    'apt-get update', 'apt-get install -y nodejs', 'fi'
  ])
}

function rpmPackages () {
  return join([
    'dnf install -y ca-certificates curl gnupg2 nginx gcc gcc-c++ make python3',
    'if ! node -e "const [a,b]=process.versions.node.split(\'.\').map(Number);process.exit(((a===22&&b>=22)||a===24)?0:1)" >/dev/null 2>&1; then',
    'curl --fail --location --silent --show-error https://rpm.nodesource.com/gpgkey/ns-operations-public.key --output /etc/pki/rpm-gpg/NODESOURCE-NSOLID-GPG-SIGNING-KEY-EL',
    "printf '%s\\n' '[nodesource-nodejs]' 'name=Node.js Packages for Linux RPM based distros - $basearch' 'baseurl=https://rpm.nodesource.com/pub_24.x/nodistro/nodejs/$basearch' 'priority=9' 'enabled=1' 'gpgcheck=1' 'gpgkey=file:///etc/pki/rpm-gpg/NODESOURCE-NSOLID-GPG-SIGNING-KEY-EL' 'module_hotfixes=1' > /etc/yum.repos.d/nodesource-nodejs.repo",
    'dnf clean expire-cache', 'dnf install -y nodejs', 'fi'
  ])
}

function nativeNpmInstall (state, profile) {
  const ensureSqlite = profile.family === 'arch'
    ? `cd ${quote(APP_ROOT)}; if ! node -e ${quote("require('sqlite3')")}; then npm install-scripts approve sqlite3; npm_config_cache=${quote(`${state}/npm-cache`)} npm rebuild sqlite3 --loglevel=error; node -e ${quote("require('sqlite3')")}; fi`
    : `cd ${quote(APP_ROOT)}; node -e ${quote("require('sqlite3')")}`
  return join([
    'set -eu', 'umask 022', `install -d -o root -g root -m 0755 ${quote(APP_ROOT)}`, `install -d -o root -g root -m 0755 ${quote(`${state}/npm-cache`)}`,
    `if [ ! -x ${quote(`${APP_ROOT}/node_modules/.bin/n8n`)} ]; then npm_config_cache=${quote(`${state}/npm-cache`)} npm --prefix ${quote(APP_ROOT)} install --omit=dev --no-audit --no-fund --loglevel=error ${quote(`n8n@${VERSION}`)}; fi`,
    ensureSqlite,
    `chmod -R a+rX ${quote(APP_ROOT)}`,
    `${quote(`${APP_ROOT}/node_modules/.bin/n8n`)} --version | grep -Fx ${quote(VERSION)}`, "printf '%s\\n' n8n-installed"
  ])
}

function nativeCredentials () {
  return join(['set -eu', 'umask 077', `install -d -o root -g root -m 0700 ${quote(CREDENTIALS)}`, `[ -s ${quote(`${CREDENTIALS}/encryption_key`)} ] || openssl rand -hex 32 > ${quote(`${CREDENTIALS}/encryption_key`)}`, `chmod 0600 ${quote(`${CREDENTIALS}/encryption_key`)}`, `printf '%s\\n' ${quote(CREDENTIALS)}`])
}

function nativeConfigure (profile) {
  const nginx = [
    'server {', `    listen ${PORT};`, '    server_name _;', '    default_type text/plain;', `    location = / { return 200 "${MARKER}\\n"; }`, '}'
  ].join('\n')
  const systemd = [
    '[Unit]', 'Description=Intent AI Ops n8n validation service', 'After=network-online.target', 'Wants=network-online.target', '', '[Service]', 'Type=simple', 'User=webminai-n8n', 'Group=webminai-n8n', `Environment=HOME=${DATA_ROOT}`, `Environment=N8N_USER_FOLDER=${DATA_ROOT}`, `Environment=N8N_PORT=${N8N_PORT}`, 'Environment=N8N_LISTEN_ADDRESS=127.0.0.1', 'Environment=N8N_DIAGNOSTICS_ENABLED=false', 'Environment=N8N_VERSION_NOTIFICATIONS_ENABLED=false', 'Environment=N8N_SECURE_COOKIE=false', `EnvironmentFile=${CREDENTIALS}/service.env`, `ExecStart=${APP_ROOT}/node_modules/.bin/n8n start`, 'Restart=on-failure', 'RestartSec=3', 'NoNewPrivileges=true', 'PrivateTmp=true', '', '[Install]', 'WantedBy=multi-user.target'
  ].join('\n')
  const openrc = [
    '#!/sbin/openrc-run', `name="${SERVICE}"`, `command="${APP_ROOT}/start-openrc.sh"`, 'command_background=true', `pidfile="/run/${SERVICE}.pid"`, 'output_log="/var/log/webminai-n8n.log"', 'error_log="/var/log/webminai-n8n.log"', 'depend() { need net; }'
  ].join('\n')
  const alpineWrapper = [
    '#!/bin/sh', 'set -eu', `export N8N_ENCRYPTION_KEY="$(cat ${CREDENTIALS}/encryption_key)"`, `export HOME=${DATA_ROOT}`, `export N8N_USER_FOLDER=${DATA_ROOT}`, `export N8N_PORT=${N8N_PORT}`, 'export N8N_LISTEN_ADDRESS=127.0.0.1', 'export N8N_DIAGNOSTICS_ENABLED=false', 'export N8N_VERSION_NOTIFICATIONS_ENABLED=false', 'export N8N_SECURE_COOKIE=false', `exec su-exec webminai-n8n:webminai-n8n ${APP_ROOT}/node_modules/.bin/n8n start`
  ].join('\n')
  const pieces = [
    'set -eu', 'id webminai-n8n >/dev/null 2>&1 || useradd -r -d ' + quote(DATA_ROOT) + ' -s /usr/sbin/nologin webminai-n8n 2>/dev/null || adduser -S -D -H -h ' + quote(DATA_ROOT) + ' -s /sbin/nologin webminai-n8n',
    `install -d -o webminai-n8n -g webminai-n8n -m 0700 ${quote(DATA_ROOT)}`,
    `key=$(cat ${quote(`${CREDENTIALS}/encryption_key`)}); umask 077; printf 'N8N_ENCRYPTION_KEY=%s\\n' "$key" > ${quote(`${CREDENTIALS}/service.env`)}`,
    `printf '%s\\n' ${nginx.split('\n').map(quote).join(' ')} > ${quote(profile.nginxVhost)}`, `chmod 0644 ${quote(profile.nginxVhost)}`
  ]
  if (profile.nginxIncludeRequired) pieces.push("grep -Fq 'include /etc/nginx/conf.d/*.conf;' /etc/nginx/nginx.conf || sed -i '/^[[:space:]]*http[[:space:]]*{/a\\    include /etc/nginx/conf.d/*.conf;' /etc/nginx/nginx.conf")
  if (profile.nginxEnableLink) pieces.push(`ln -sfn ${quote(profile.nginxVhost)} ${quote(profile.nginxEnableLink)}`)
  if (profile.systemd) {
    pieces.push(`printf '%s\\n' ${systemd.split('\n').map(quote).join(' ')} > ${quote(profile.serviceFile)}`, `chmod 0644 ${quote(profile.serviceFile)}`, 'systemctl daemon-reload', `systemctl enable --now ${quote(SERVICE)}`, 'nginx -t', startOrReload(profile.nginxService, true))
  } else {
    pieces.push(`printf '%s\\n' ${alpineWrapper.split('\n').map(quote).join(' ')} > ${quote(`${APP_ROOT}/start-openrc.sh`)}`, `chmod 0755 ${quote(`${APP_ROOT}/start-openrc.sh`)}`, `printf '%s\\n' ${openrc.split('\n').map(quote).join(' ')} > ${quote(profile.serviceFile)}`, `chmod 0755 ${quote(profile.serviceFile)}`, `rc-update add ${quote(SERVICE)} default >/dev/null`, `rc-service ${quote(SERVICE)} start >/dev/null`, 'nginx -t', startOrReload(profile.nginxService, false))
  }
  return join(pieces)
}

function nativeVerify (profile) {
  return join(['set -eu', waitHealth(), `test -s ${quote(`${DATA_ROOT}/.n8n/database.sqlite`)}`, `curl --fail --silent --show-error --max-time 5 http://127.0.0.1:${PORT}/ | grep -Fx ${quote(MARKER)}`, "printf '%s\\n' n8n-verified"])
}

function nativeStop (profile) {
  const commands = ['set -eu']
  if (profile.systemd) commands.push(`systemctl disable --now ${quote(SERVICE)} 2>/dev/null || true`, `rm -f -- ${quote(profile.serviceFile)}`, 'systemctl daemon-reload')
  else commands.push(`rc-service ${quote(SERVICE)} stop >/dev/null 2>&1 || true`, `rc-update del ${quote(SERVICE)} default >/dev/null 2>&1 || true`, `rm -f -- ${quote(profile.serviceFile)}`)
  commands.push(`rm -f -- ${quote(profile.nginxVhost)}`)
  if (profile.nginxEnableLink) commands.push(`rm -f -- ${quote(profile.nginxEnableLink)}`)
  commands.push('if command -v nginx >/dev/null 2>&1; then nginx -t', reloadIfActive(profile.nginxService, profile.systemd), 'fi')
  return join(commands)
}

function nativeRestore (state, context, profile) {
  const commands = ['set -eu']
  profile.repositoryPaths.forEach((path, index) => commands.push(`if [ -e ${quote(`${state}/repo-${index}.existed`)} ]; then rm -rf -- ${quote(path)}; cp -a -- ${quote(`${state}/repo-backup/${index}`)} ${quote(path)}; else rm -rf -- ${quote(path)}; fi`))
  commands.push(`if [ -s ${quote(`${state}/packages.before`)} ]; then ${packageList(profile.family)} > ${quote(`${state}/packages.current`)}; LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.current`)} | grep -Ev '^(netdata|openssh|webminai)(-|$)' > ${quote(`${state}/packages.added`)} || true; fi`)
  commands.push(removeAddedPackages(profile.family, `${state}/packages.added`))
  if (profile.systemd) commands.push(`if systemctl cat ${quote(profile.nginxService)} >/dev/null 2>&1; then if [ -e ${quote(`${state}/nginx.enabled`)} ]; then systemctl enable ${quote(profile.nginxService)} >/dev/null 2>&1 || true; else systemctl disable ${quote(profile.nginxService)} >/dev/null 2>&1 || true; fi; if [ -e ${quote(`${state}/nginx.active`)} ]; then systemctl start ${quote(profile.nginxService)}; else systemctl stop ${quote(profile.nginxService)} 2>/dev/null || true; fi; fi`)
  else commands.push(`if [ -e ${quote(`${state}/nginx.enabled`)} ]; then rc-update add nginx default >/dev/null 2>&1 || true; else rc-update del nginx default >/dev/null 2>&1 || true; fi`, `if [ -e ${quote(`${state}/nginx.active`)} ]; then rc-service nginx start >/dev/null; else rc-service nginx stop >/dev/null 2>&1 || true; fi`)
  commands.push('id webminai-n8n >/dev/null 2>&1 && { userdel webminai-n8n 2>/dev/null || deluser webminai-n8n 2>/dev/null || true; } || true', `rm -rf -- ${quote(state)}`)
  return join(commands)
}

function composeBaseline (state) {
  return join(['set -eu', `if [ ! -s ${quote(`${state}/packages.before`)} ]; then`, `test ! -e ${quote(SERVICE_ROOT)}`, `test ! -e ${quote(CREDENTIALS)}`, `install -d -o root -g root -m 0700 ${quote(state)}`, `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(`${state}/packages.before`)}`, `systemctl is-active --quiet docker 2>/dev/null && : > ${quote(`${state}/docker.active`)} || true`, `command -v docker >/dev/null 2>&1 && : > ${quote(`${state}/docker.existed`)} || true`, `docker image inspect ${quote(N8N_IMAGE)} >/dev/null 2>&1 && : > ${quote(`${state}/n8n-image.existed`)} || true`, `docker image inspect ${quote(NGINX_IMAGE)} >/dev/null 2>&1 && : > ${quote(`${state}/nginx-image.existed`)} || true`, 'fi', 'printf \'%s\\n\' baseline-ready'])
}

function prepareDocker (state) {
  return join(['set -eu', 'if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then :; else', `[ ! -e ${quote(`${state}/docker.existed`)} ]`, 'export DEBIAN_FRONTEND=noninteractive', 'apt-get update', 'apt-get install -y ca-certificates curl', 'install -d -m 0755 /etc/apt/keyrings', 'curl --fail --location --silent --show-error https://download.docker.com/linux/ubuntu/gpg --output /etc/apt/keyrings/docker.asc', 'chmod 0644 /etc/apt/keyrings/docker.asc', '. /etc/os-release', `arch=$(dpkg --print-architecture); codename=${DOCKER_CODENAME_FALLBACK}`, 'printf \'%s\\n\' \'Types: deb\' \'URIs: https://download.docker.com/linux/ubuntu\' "Suites: $codename" \'Components: stable\' "Architectures: $arch" \'Signed-By: /etc/apt/keyrings/docker.asc\' > /etc/apt/sources.list.d/docker.sources', 'apt-get update', 'apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin', 'systemctl start docker', 'fi', 'docker info >/dev/null', 'docker compose version >/dev/null', `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(`${state}/packages.after`)}`, `LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} > ${quote(`${state}/packages.added`)} || true`])
}

function composeCredentials () {
  return join(['set -eu', 'umask 077', `install -d -o root -g root -m 0700 ${quote(CREDENTIALS)}`, `[ -s ${quote(`${CREDENTIALS}/encryption_key`)} ] || openssl rand -hex 32 > ${quote(`${CREDENTIALS}/encryption_key`)}`, `chmod 0600 ${quote(`${CREDENTIALS}/encryption_key`)}`, `printf '%s\\n' ${quote(CREDENTIALS)}`])
}

function prepareComposeSwap (state) {
  return join(['set -eu', `if [ ! -e ${quote(`${state}/swap-created`)} ]; then test ! -e ${quote(SWAP_FILE)}; fallocate -l 1G ${quote(SWAP_FILE)}; chmod 0600 ${quote(SWAP_FILE)}; mkswap ${quote(SWAP_FILE)} >/dev/null; swapon ${quote(SWAP_FILE)}; : > ${quote(`${state}/swap-created`)}; fi`, `grep -Fq ${quote(SWAP_FILE)} /proc/swaps`, "printf '%s\\n' swap-ready"])
}

function removeComposeSwap (state) {
  return join(['set -eu', `if [ -d ${quote(state)} ]; then if grep -Fq ${quote(SWAP_FILE)} /proc/swaps; then swapoff ${quote(SWAP_FILE)}; fi; rm -f -- ${quote(SWAP_FILE)}; fi`, `test ! -e ${quote(SWAP_FILE)}`, "printf '%s\\n' swap-removed"])
}

function writeCompose () {
  const compose = [
    'services:', '  n8n:', `    image: ${N8N_IMAGE}`, '    restart: unless-stopped', '    user: root', '    entrypoint: ["/bin/sh", "-c"]', '    command: ["export N8N_ENCRYPTION_KEY=$$(cat /run/secrets/encryption_key); chown -R node:node /home/node/.n8n; exec su -p -s /bin/sh node -c \'exec /docker-entrypoint.sh start\'"]', '    environment:', '      HOME: /home/node', '      NODE_OPTIONS: --max-old-space-size=384', '      N8N_USER_FOLDER: /home/node', '      N8N_PORT: "5678"', '      N8N_LISTEN_ADDRESS: 0.0.0.0', '      N8N_DIAGNOSTICS_ENABLED: "false"', '      N8N_VERSION_NOTIFICATIONS_ENABLED: "false"', '      N8N_SECURE_COOKIE: "false"', '    secrets: [encryption_key]', '    volumes: [n8n_data:/home/node/.n8n]', '    healthcheck:', '      test: ["CMD", "node", "-e", "fetch(\'http://127.0.0.1:5678/healthz\').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]', '      interval: 5s', '      timeout: 5s', '      retries: 120', '  nginx:', `    image: ${NGINX_IMAGE}`, '    restart: unless-stopped', '    depends_on:', '      n8n: { condition: service_healthy }', `    ports: ["${PORT}:80"]`, '    volumes:', '      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro', 'secrets:', `  encryption_key: { file: ${CREDENTIALS}/encryption_key }`, 'volumes:', '  n8n_data:'
  ].join('\n')
  const nginx = ['server {', '  listen 80;', '  server_name _;', '  default_type text/plain;', `  location = / { return 200 "${MARKER}\\n"; }`, '}'].join('\n')
  return join(['set -eu', `install -d -o root -g root -m 0700 ${quote(SERVICE_ROOT)}`, `printf '%s\\n' ${compose.split('\n').map(quote).join(' ')} > ${quote(`${SERVICE_ROOT}/compose.yaml`)}`, `printf '%s\\n' ${nginx.split('\n').map(quote).join(' ')} > ${quote(`${SERVICE_ROOT}/nginx.conf`)}`, `chmod 0600 ${quote(`${SERVICE_ROOT}/compose.yaml`)} ${quote(`${SERVICE_ROOT}/nginx.conf`)}`, `cd ${quote(SERVICE_ROOT)}`, `docker compose -p ${quote(PROJECT)} config --quiet`])
}

function startCompose (state) {
  return join(['set -eu', `cd ${quote(SERVICE_ROOT)}`, `docker compose -p ${quote(PROJECT)} pull`, `docker compose -p ${quote(PROJECT)} up -d`, `docker image inspect ${quote(N8N_IMAGE)} --format '{{.Id}}' > ${quote(`${state}/n8n-image.id`)}`, `docker image inspect ${quote(NGINX_IMAGE)} --format '{{.Id}}' > ${quote(`${state}/nginx-image.id`)}`, waitCompose(), "printf '%s\\n' compose-ready"])
}

function verifyCompose () {
  return join(['set -eu', `cd ${quote(SERVICE_ROOT)}`, waitCompose(), `docker compose -p ${quote(PROJECT)} exec -T n8n test -s /home/node/.n8n/database.sqlite`, `curl --fail --silent --show-error --max-time 5 http://127.0.0.1:${PORT}/ | grep -Fx ${quote(MARKER)}`, "printf '%s\\n' n8n-verified"])
}

function removeCompose (state) {
  return join(['set -eu', `if [ -f ${quote(`${SERVICE_ROOT}/compose.yaml`)} ]; then cd ${quote(SERVICE_ROOT)}; docker compose -p ${quote(PROJECT)} down --volumes --remove-orphans; fi`, `if [ ! -e ${quote(`${state}/n8n-image.existed`)} ] && [ -s ${quote(`${state}/n8n-image.id`)} ] && [ "$(docker image inspect ${quote(N8N_IMAGE)} --format '{{.Id}}' 2>/dev/null || true)" = "$(cat ${quote(`${state}/n8n-image.id`)})" ]; then docker image rm ${quote(N8N_IMAGE)} >/dev/null 2>&1 || true; fi`, `if [ ! -e ${quote(`${state}/nginx-image.existed`)} ] && [ -s ${quote(`${state}/nginx-image.id`)} ] && [ "$(docker image inspect ${quote(NGINX_IMAGE)} --format '{{.Id}}' 2>/dev/null || true)" = "$(cat ${quote(`${state}/nginx-image.id`)})" ]; then docker image rm ${quote(NGINX_IMAGE)} >/dev/null 2>&1 || true; fi`])
}

function restoreDocker (state) {
  return join(['set -eu', `if [ ! -e ${quote(`${state}/docker.existed`)} ]; then`, `if [ -s ${quote(`${state}/packages.added`)} ]; then xargs -r apt-get purge -y < ${quote(`${state}/packages.added`)}; fi`, 'rm -f /etc/apt/sources.list.d/docker.sources /etc/apt/keyrings/docker.asc', 'apt-get autoremove -y', 'rm -rf /var/lib/docker /var/lib/containerd /etc/docker', `elif [ -e ${quote(`${state}/docker.active`)} ]; then systemctl start docker; else systemctl stop docker 2>/dev/null || true; fi`, `rm -rf -- ${quote(state)}`])
}

function waitHealth () {
  return `ready=; for attempt in $(seq 1 120); do if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:${N8N_PORT}/healthz >/dev/null 2>&1; then ready=yes; break; fi; sleep 5; done; [ "$ready" = yes ]`
}

function waitCompose () {
  return `ready=; for attempt in $(seq 1 120); do status=$(docker inspect ${quote(`${PROJECT}-n8n-1`)} --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || true); [ "$status" = healthy ] && ready=yes && break; sleep 5; done; [ "$ready" = yes ]`
}

function packageList (family) {
  if (family === 'debian') return `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u`
  if (family === 'alpine') return 'apk info | LC_ALL=C sort -u'
  if (family === 'arch') return 'pacman -Qq | LC_ALL=C sort -u'
  return 'rpm -qa --qf=\'%{NAME}\\n\' | LC_ALL=C sort -u'
}

function removeAddedPackages (family, file) {
  if (family === 'debian') return `if [ -s ${quote(file)} ]; then export DEBIAN_FRONTEND=noninteractive; xargs -r apt-get purge -y < ${quote(file)}; apt-get autoremove -y; fi`
  if (family === 'alpine') return `if [ -s ${quote(file)} ]; then xargs -r apk del < ${quote(file)}; fi`
  if (family === 'arch') return `if [ -s ${quote(file)} ]; then xargs -r pacman -Rns --noconfirm < ${quote(file)}; fi`
  if (family === 'suse') return `if [ -s ${quote(file)} ]; then xargs -r zypper --non-interactive remove -u -y < ${quote(file)}; fi`
  return `if [ -s ${quote(file)} ]; then installed=; while IFS= read -r package; do [ -z "$package" ] || ! rpm -q -- "$package" >/dev/null 2>&1 || installed="$installed $package"; done < ${quote(file)}; [ -z "$installed" ] || dnf remove -y $installed; fi`
}

function serviceActive (service, systemd, marker) {
  return systemd ? `systemctl is-active --quiet ${quote(service)} 2>/dev/null && : > ${quote(marker)} || true` : `rc-service ${quote(service)} status >/dev/null 2>&1 && : > ${quote(marker)} || true`
}

function serviceEnabled (service, systemd, marker) {
  return systemd ? `systemctl is-enabled --quiet ${quote(service)} 2>/dev/null && : > ${quote(marker)} || true` : `rc-update show default 2>/dev/null | grep -Eq '(^|[[:space:]])${service}([[:space:]]|$)' && : > ${quote(marker)} || true`
}

function startOrReload (service, systemd) {
  return systemd ? `if systemctl is-active --quiet ${quote(service)}; then systemctl reload ${quote(service)}; else systemctl start ${quote(service)}; fi` : `if rc-service ${quote(service)} status >/dev/null 2>&1; then rc-service ${quote(service)} reload >/dev/null; else rc-service ${quote(service)} start >/dev/null; fi`
}

function reloadIfActive (service, systemd) {
  return systemd ? `systemctl is-active --quiet ${quote(service)} && systemctl reload ${quote(service)} || true` : `rc-service ${quote(service)} status >/dev/null 2>&1 && rc-service ${quote(service)} reload >/dev/null || true`
}

function item (id, phase, command, purpose, dependsOn = [], timeoutMs = 300000, executionMode, risk = 'change') {
  return { id, phase, command, purpose, risk, timeoutMs, requiresSudo: true, dependsOn, ...(executionMode ? { executionMode } : {}) }
}

function join (parts) {
  return parts.filter(Boolean).join('; ')
    .replaceAll('then; ', 'then ')
    .replaceAll('else; ', 'else ')
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
