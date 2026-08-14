const VERSION = '10.11.11'
const PORT = 18113
const APP_PORT = 8096
const MARKER = 'WEBMINAI_JELLYFIN_OK'
const SERVICE = 'webminai-jellyfin-18113'
const APP_ROOT = '/opt/webminai-jellyfin-18113'
const DATA_ROOT = '/var/lib/webminai-jellyfin-18113'
const CREDENTIALS = '/root/jellyfin_credentials'
const SERVICE_ROOT = '/opt/webminai/services/jellyfin'
const PROJECT = 'webminai-jellyfin-18113'
const PORTABLE_ARCHIVE = `jellyfin_${VERSION}-amd64.tar.gz`
const PORTABLE_URL = `https://repo.jellyfin.org/files/server/linux/latest-stable/amd64/${PORTABLE_ARCHIVE}`
const PORTABLE_SHA256 = '9f7f194a7e37777cfde0d107c088fc47e81c7904440046ac0ceb7a289546cf79'
const FFMPEG_VERSION = '7.1.4-3'
const FFMPEG_ARCHIVE = `jellyfin-ffmpeg_${FFMPEG_VERSION}_portable_linux64-gpl.tar.xz`
const FFMPEG_URL = `https://repo.jellyfin.org/files/ffmpeg/linux/7.x/${FFMPEG_VERSION}/amd64/${FFMPEG_ARCHIVE}`
const FFMPEG_SHA256 = 'cab9ff40a47e4232d231e4eb7e4e85fabfeec56c6905266bc94291fc0881f83f'
const JELLYFIN_IMAGE = 'jellyfin/jellyfin@sha256:aefb67e6a7ff1debdd154a78a7bbb780fd0c873d8639210a7f6a2016ad2b35db'
const NGINX_IMAGE = 'nginx@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46'
const IMAGES = [JELLYFIN_IMAGE, NGINX_IMAGE]
const GPG_FINGERPRINT = '4918AABC486CA052358D778D49023CD01DE21A7B'
const DPKG_PACKAGE_FORMAT = '$' + '{binary:Package} $' + '{Version}\\n'
const DPKG_VERSION_FORMAT = '$' + '{Version}'
const DOCKER_CODENAME_FALLBACK = '$' + '{UBUNTU_CODENAME:-$VERSION_CODENAME}'

export function buildJellyfinTask (taskId, linuxContext, docker = {}) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  if (!linuxContext?.identity || !linuxContext?.management) throw new TypeError('Jellyfin task requires a Linux host context')
  if (docker.preferred === true) return buildComposeTask(taskId, linuxContext, docker)
  const id = linuxContext.identity.id
  if (id === 'ubuntu') return buildNativeTask(taskId, linuxContext, packageProfile('ubuntu', 'noble', `${VERSION}+ubu2404`))
  if (id === 'debian') return buildNativeTask(taskId, linuxContext, packageProfile('debian', 'trixie', `${VERSION}+deb13`))
  if (['fedora', 'almalinux', 'rocky', 'ol', 'arch', 'opensuse-leap'].includes(id) && linuxContext.identity.architecture === 'x86_64') {
    return buildNativeTask(taskId, linuxContext, portableProfile(linuxContext.management.family))
  }
  return buildCompatibilityTask(taskId, linuxContext)
}

export function jellyfinRelease () {
  return Object.freeze({ version: VERSION, portableSha256: PORTABLE_SHA256, ffmpegVersion: FFMPEG_VERSION, ffmpegSha256: FFMPEG_SHA256, images: Object.freeze([...IMAGES]) })
}

function buildCompatibilityTask (taskId, context) {
  const state = `/var/lib/webminai/task-state/${taskId}-jellyfin-compatibility`
  const identity = context.identity
  const reason = identity.id === 'alpine'
    ? `Jellyfin ${VERSION} is not promoted on Alpine ${identity.versionId ?? ''}: its musl community packages lag the current security release and the official portable archive requires glibc.`
    : `Jellyfin ${VERSION} is not promoted on ${identity.id} ${identity.versionId ?? ''}: no reviewed native or portable route matches this platform and automatic Docker is disabled for container hosts.`
  return envelope({
    context,
    route: 'no-change-incompatible',
    overview: `Record a no-change Jellyfin compatibility result for ${identity.id} ${identity.versionId ?? ''}.`,
    files: [state, `${state}/report.txt`],
    commands: [item('record-compatibility', 'preflight', join(['set -eu', ...ownedAbsent(), `install -d -o root -g root -m 0700 ${quote(state)}`, `printf '%s\\n' ${quote(reason)} > ${quote(`${state}/report.txt`)}`, `chmod 0600 ${quote(`${state}/report.txt`)}`]), 'Record the reviewed no-change compatibility result without installing an outdated or unsupported build')],
    revertCommands: [item('remove-compatibility-report', 'cleanup', `set -eu; rm -rf -- ${quote(state)}; printf '%s\\n' compatibility-report-removed`, 'Remove only the task-owned compatibility report', [], 30000, undefined, 'destructive')],
    verifyApplied: `test -s ${quote(`${state}/report.txt`)} && grep -Fq 'not promoted' ${quote(`${state}/report.txt`)} && test ! -e ${quote(DATA_ROOT)} && test ! -e ${quote(CREDENTIALS)}`,
    verifyReverted: `test ! -e ${quote(state)}`
  })
}

function buildNativeTask (taskId, context, profile) {
  const state = `/var/lib/webminai/task-state/${taskId}-jellyfin-linux`
  const paths = nativePaths(profile)
  const commands = [
    item('capture-baseline', 'baseline', nativeBaseline(state, paths, profile), 'Capture packages, services, users, repositories, ports, and task-owned paths exactly once'),
    item('install-foundation', 'packages', nativeFoundation(state, profile), `Install nginx and the reviewed ${profile.route} Jellyfin prerequisites`, ['capture-baseline'], 1200000, 'job'),
    item('generate-credentials', 'secrets', credentialsCommand(), 'Generate the initial administrator name and password on-host without emitting them', ['capture-baseline']),
    item('install-jellyfin', 'acquire', nativeAcquire(state, profile), `Install the pinned Jellyfin ${VERSION} ${profile.route}`, ['install-foundation'], 1800000, 'job'),
    ...(!profile.package ? [item('install-jellyfin-ffmpeg', 'acquire', portableFfmpeg(state, profile), `Install the checksum-pinned Jellyfin FFmpeg ${FFMPEG_VERSION} portable archive`, ['install-jellyfin'], 1200000, 'job')] : []),
    item('configure-jellyfin', 'configure', nativeConfigure(state, paths, profile), 'Create isolated media, cache, configuration, systemd, and nginx state', [profile.package ? 'install-jellyfin' : 'install-jellyfin-ffmpeg', 'generate-credentials']),
    item('initialize-jellyfin', 'initialize', initializeJellyfin(), 'Complete the local startup wizard from protected credential files', ['configure-jellyfin']),
    item('verify-jellyfin', 'verify', nativeVerify(profile), 'Verify Jellyfin health, public system information, web UI, persistence, identity, and restart recovery', ['initialize-jellyfin'], 900000, 'job')
  ]
  const revertCommands = [
    item('stop-jellyfin', 'cleanup', nativeStop(paths), 'Stop and remove only the task-owned Jellyfin and nginx services', [], 300000, undefined, 'destructive'),
    item('remove-jellyfin-files', 'cleanup', `set -eu; rm -rf -- ${quote(APP_ROOT)} ${quote(DATA_ROOT)} ${quote(CREDENTIALS)} /etc/jellyfin /var/lib/jellyfin /var/cache/jellyfin /var/log/jellyfin`, 'Remove task-owned application, media, cache, configuration, logs, and credentials', ['stop-jellyfin'], 300000, undefined, 'destructive'),
    item('restore-foundation', 'cleanup', nativeRestore(state, profile), 'Restore packages, repository, users, and nginx state from the factual baseline', ['remove-jellyfin-files'], 1200000, 'job', 'destructive')
  ]
  return envelope({
    context,
    route: profile.route,
    overview: `Deploy Jellyfin ${VERSION} with isolated state and nginx on port ${PORT}.`,
    files: [state, APP_ROOT, DATA_ROOT, CREDENTIALS, paths.serviceFile, paths.nginxVhost, ...(paths.nginxEnableLink ? [paths.nginxEnableLink] : []), ...(profile.package ? ['/etc/apt/keyrings/jellyfin.gpg', '/etc/apt/sources.list.d/jellyfin.sources', '/etc/jellyfin', '/var/lib/jellyfin', '/var/cache/jellyfin', '/var/log/jellyfin'] : [])],
    commands,
    revertCommands,
    verifyApplied: nativeVerify(profile),
    verifyReverted: `test ! -e ${quote(APP_ROOT)} && test ! -e ${quote(DATA_ROOT)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)} && test ! -e ${quote(paths.serviceFile)} && test ! -e ${quote(paths.nginxVhost)}`
  })
}

function buildComposeTask (taskId, context, docker) {
  if (!docker.ready && docker.installMethod !== 'official-apt') throw new Error('learned Jellyfin Compose setup requires Docker ready or the reviewed official apt route')
  const state = `/var/lib/webminai/task-state/${taskId}-jellyfin-compose`
  const commands = [
    item('capture-baseline', 'baseline', composeBaseline(state), 'Capture Docker, images, services, port, and task paths exactly once'),
    item('prepare-docker', 'packages', prepareDocker(state), 'Install Docker and Compose only when the reviewed host route requires them', ['capture-baseline'], 900000, 'job'),
    item('generate-credentials', 'secrets', credentialsCommand(), 'Generate the initial administrator name and password on-host without emitting them', ['capture-baseline']),
    item('write-compose', 'configure', writeCompose(), 'Write the digest-pinned official Jellyfin and nginx Compose project with isolated empty media', ['prepare-docker', 'generate-credentials']),
    item('start-compose', 'services', startCompose(), 'Start Jellyfin and nginx with bounded health readiness', ['write-compose'], 1800000, 'job'),
    item('initialize-jellyfin', 'initialize', initializeJellyfin(), 'Complete the local startup wizard from protected credential files', ['start-compose']),
    item('verify-compose', 'verify', verifyCompose(), 'Verify Jellyfin version, health, web UI, storage, marker, and restart recovery', ['initialize-jellyfin'], 900000, 'job')
  ]
  const revertCommands = [
    item('remove-compose-project', 'cleanup', removeCompose(state), 'Remove only task-owned containers, network, and newly pulled images', [], 1200000, 'job', 'destructive'),
    item('remove-compose-files', 'cleanup', `set -eu; rm -rf -- ${quote(SERVICE_ROOT)} ${quote(DATA_ROOT)} ${quote(CREDENTIALS)}`, 'Remove task-owned Compose, media, cache, configuration, and credentials', ['remove-compose-project'], 300000, undefined, 'destructive'),
    item('restore-docker', 'cleanup', restoreDocker(state), 'Restore Docker package and service state when introduced by this task', ['remove-compose-files'], 900000, 'job', 'destructive')
  ]
  return envelope({
    context,
    route: 'compose-official',
    overview: `Deploy official Jellyfin ${VERSION} and nginx through digest-pinned Compose on port ${PORT}.`,
    files: [state, SERVICE_ROOT, `${SERVICE_ROOT}/compose.yaml`, `${SERVICE_ROOT}/nginx.conf`, DATA_ROOT, CREDENTIALS],
    commands,
    revertCommands,
    verifyApplied: verifyCompose(),
    verifyReverted: `test ! -e ${quote(SERVICE_ROOT)} && test ! -e ${quote(DATA_ROOT)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)} && { ! command -v docker >/dev/null 2>&1 || ! docker ps -aq --filter label=com.docker.compose.project=${quote(PROJECT)} | grep -q .; }`
  })
}

function envelope ({ context, route, overview, files, commands, revertCommands, verifyApplied, verifyReverted }) {
  const identity = context.identity
  const supported = route !== 'no-change-incompatible'
  return {
    plan: {
      summary: supported ? `Deploy a learned reversible ${route.startsWith('compose') ? 'Jellyfin Compose' : 'native Jellyfin'} service` : 'Record Jellyfin compatibility result',
      changeOverview: overview,
      modifiedFiles: files,
      assumptions: [
        `Authoritative Linux profile: ${identity.id} ${identity.versionId ?? ''}`.trim(),
        `Resolved Jellyfin matrix: stable ${VERSION}, official Debian/Ubuntu packages, official glibc x86-64 portable archive, and official Linux container.`,
        'Administrator credentials are generated on-host and only protected paths enter plans and logs.'
      ],
      warnings: supported
        ? [`This controlled validation publishes TCP port ${PORT} through nginx with empty media and does not enable discovery, hardware acceleration, transcoding tests, TLS, or public access.`]
        : ['No application is installed because no current reviewed native route matches this host and automatic Docker is disabled for container hosts.'],
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
  const supported = route !== 'no-change-incompatible'
  return {
    format: 'webminai-compatibility-manifest',
    version: 1,
    application: { id: 'jellyfin', version: VERSION },
    host: { fingerprint: context.fingerprint, distribution: context.identity.id, distributionVersion: context.identity.versionId, architecture: context.identity.architecture, family: context.management.family },
    selectedRoute: { id: route, status: supported ? 'supported' : 'unsupported' },
    components: [
      { profileId: 'jellyfin', selectedVersion: VERSION, source: route.startsWith('compose') ? 'official-container-image' : route.startsWith('native-package') ? 'official-signed-repository' : route.startsWith('native-portable') ? 'official-checksummed-portable-archive' : 'unavailable', status: supported ? 'supported' : 'unavailable' },
      { profileId: 'nginx', selectedVersion: 'distribution-or-image', source: 'reviewed-profile', status: supported ? 'supported' : 'not-selected' }
    ]
  }
}

function packageProfile (os, suite, version) {
  return { route: `native-package-${os}`, family: 'debian', package: true, os, suite, version, user: 'jellyfin', binary: '/usr/bin/jellyfin', webdir: '/usr/share/jellyfin/web', ffmpeg: '/usr/lib/jellyfin-ffmpeg/ffmpeg' }
}

function portableProfile (family) {
  return { route: `native-portable-${family}`, family, package: false, user: 'webminai-jellyfin', binary: `${APP_ROOT}/jellyfin`, webdir: `${APP_ROOT}/jellyfin-web`, ffmpeg: `${APP_ROOT}/ffmpeg` }
}

function nativePaths (profile) {
  const name = `${SERVICE}.conf`
  return profile.family === 'debian'
    ? { serviceFile: `/etc/systemd/system/${SERVICE}.service`, nginxVhost: `/etc/nginx/sites-available/${name}`, nginxEnableLink: `/etc/nginx/sites-enabled/${name}` }
    : { serviceFile: `/etc/systemd/system/${SERVICE}.service`, nginxVhost: `/etc/nginx/conf.d/${name}`, nginxEnableLink: null }
}

function ownedAbsent () {
  return [APP_ROOT, DATA_ROOT, CREDENTIALS, SERVICE_ROOT].map(path => `test ! -e ${quote(path)}`)
}

function nativeBaseline (state, paths, profile) {
  const owned = [APP_ROOT, DATA_ROOT, CREDENTIALS, paths.serviceFile, paths.nginxVhost, ...(paths.nginxEnableLink ? [paths.nginxEnableLink] : [])]
  if (profile.package) owned.push('/etc/apt/keyrings/jellyfin.gpg', '/etc/apt/sources.list.d/jellyfin.sources', '/etc/jellyfin', '/var/lib/jellyfin', '/var/cache/jellyfin', '/var/log/jellyfin')
  const snapshot = packageSnapshot(profile, `${state}/packages.before`)
  return join([
    'set -eu', `if [ ! -s ${quote(`${state}/packages.before`)} ]; then`, ...owned.map(path => `test ! -e ${quote(path)}`), `! getent passwd ${quote(profile.user)} >/dev/null`, '! command -v jellyfin >/dev/null 2>&1', `! ss -lnt 2>/dev/null | awk '$4 ~ /:${APP_PORT}$/ { found=1 } END { exit !found }'`,
    `install -d -o root -g root -m 0700 ${quote(state)}`, snapshot, `systemctl is-active --quiet nginx 2>/dev/null && : > ${quote(`${state}/nginx.active`)} || true`, `systemctl is-enabled --quiet nginx 2>/dev/null && : > ${quote(`${state}/nginx.enabled`)} || true`, 'fi', 'printf \'%s\\n\' baseline-ready'
  ])
}

function nativeFoundation (state, profile) {
  if (profile.package) {
    const source = ['Types: deb', `URIs: https://repo.jellyfin.org/${profile.os}`, `Suites: ${profile.suite}`, 'Components: main', 'Architectures: amd64', 'Signed-By: /etc/apt/keyrings/jellyfin.gpg']
    return join([
      'set -eu', 'export DEBIAN_FRONTEND=noninteractive', 'apt-get update', 'apt-get install -y ca-certificates curl gnupg nginx openssl', `curl --fail --location --silent --show-error https://repo.jellyfin.org/jellyfin_team.gpg.key --output ${quote(`${state}/jellyfin.key`)}`, `fingerprint=$(gpg --show-keys --with-colons ${quote(`${state}/jellyfin.key`)} 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }'); [ "$fingerprint" = ${quote(GPG_FINGERPRINT)} ]`, `gpg --dearmor --yes --output /etc/apt/keyrings/jellyfin.gpg ${quote(`${state}/jellyfin.key`)}`, 'chmod 0644 /etc/apt/keyrings/jellyfin.gpg', `printf '%s\\n' ${source.map(quote).join(' ')} > /etc/apt/sources.list.d/jellyfin.sources`, 'chmod 0644 /etc/apt/sources.list.d/jellyfin.sources', 'apt-get update', 'systemctl enable --now nginx', packageSnapshot(profile, `${state}/packages.foundation`)
    ])
  }
  const install = profile.family === 'rhel'
    ? 'dnf install -y ca-certificates curl tar gzip xz icu nginx openssl'
    : profile.family === 'arch'
      ? 'pacman -S --needed --noconfirm ca-certificates curl tar gzip xz nginx openssl'
      : 'zypper --non-interactive install --no-recommends ca-certificates curl tar gzip xz nginx openssl'
  return join(['set -eu', install, 'systemctl enable --now nginx', packageSnapshot(profile, `${state}/packages.foundation`)])
}

function credentialsCommand () {
  return join([
    'set -eu', 'umask 077', `install -d -o root -g root -m 0700 ${quote(CREDENTIALS)}`, `[ -s ${quote(`${CREDENTIALS}/admin_username`)} ] || { printf 'webminai_%s\\n' "$(openssl rand -hex 8)" > ${quote(`${CREDENTIALS}/admin_username`)}; }`, `[ -s ${quote(`${CREDENTIALS}/admin_password`)} ] || openssl rand -hex 32 > ${quote(`${CREDENTIALS}/admin_password`)}`, `chmod 0600 ${quote(`${CREDENTIALS}/admin_username`)} ${quote(`${CREDENTIALS}/admin_password`)}`, `printf '%s\\n' ${quote(CREDENTIALS)}`
  ])
}

function nativeAcquire (state, profile) {
  if (profile.package) {
    return join([
      'set -eu', 'export DEBIAN_FRONTEND=noninteractive', `apt-get install -y ${quote(`jellyfin=${profile.version}`)}`, 'systemctl disable --now jellyfin 2>/dev/null || true', `[ "$(dpkg-query -W -f=${quote(DPKG_VERSION_FORMAT)} jellyfin)" = ${quote(profile.version)} ]`, `dpkg-query -W -f=${quote(`${DPKG_VERSION_FORMAT}\\n`)} jellyfin-server jellyfin-web | grep -F ${quote(VERSION)}`, packageSnapshot(profile, `${state}/packages.after`), packageAdded(profile, state)
    ])
  }
  const artifact = `${state}/${PORTABLE_ARCHIVE}`
  return join([
    'set -eu', `if ! [ -s ${quote(artifact)} ] || ! printf '%s  %s\\n' ${quote(PORTABLE_SHA256)} ${quote(artifact)} | sha256sum -c - >/dev/null 2>&1; then curl --fail --location --retry 5 --retry-delay 2 --silent --show-error --output ${quote(`${artifact}.tmp`)} ${quote(PORTABLE_URL)}; printf '%s  %s\\n' ${quote(PORTABLE_SHA256)} ${quote(`${artifact}.tmp`)} | sha256sum -c -; mv -f -- ${quote(`${artifact}.tmp`)} ${quote(artifact)}; fi`, `install -d -o root -g root -m 0755 ${quote(APP_ROOT)}`, `tar -xzf ${quote(artifact)} -C ${quote(APP_ROOT)} --strip-components=1`, `test -x ${quote(profile.binary)}`, `test -f ${quote(`${profile.webdir}/index.html`)}`, packageSnapshot(profile, `${state}/packages.after`), packageAdded(profile, state)
  ])
}

function portableFfmpeg (state, profile) {
  const artifact = `${state}/${FFMPEG_ARCHIVE}`
  return join([
    'set -eu', `if ! [ -s ${quote(artifact)} ] || ! printf '%s  %s\\n' ${quote(FFMPEG_SHA256)} ${quote(artifact)} | sha256sum -c - >/dev/null 2>&1; then curl --fail --location --retry 5 --retry-delay 2 --silent --show-error --output ${quote(`${artifact}.tmp`)} ${quote(FFMPEG_URL)}; printf '%s  %s\\n' ${quote(FFMPEG_SHA256)} ${quote(`${artifact}.tmp`)} | sha256sum -c -; mv -f -- ${quote(`${artifact}.tmp`)} ${quote(artifact)}; fi`, `tar -xJf ${quote(artifact)} -C ${quote(APP_ROOT)}`, `test -x ${quote(profile.ffmpeg)}`
  ])
}

function nativeConfigure (state, paths, profile) {
  const ffmpeg = profile.ffmpeg ? ` --ffmpeg=${profile.ffmpeg}` : ''
  const unit = ['[Unit]', 'Description=Intent AI Ops Jellyfin validation service', 'After=network-online.target', 'Wants=network-online.target', '', '[Service]', 'Type=simple', `User=${profile.user}`, `Group=${profile.user}`, `WorkingDirectory=${DATA_ROOT}`, `ExecStart=${profile.binary} --datadir=${DATA_ROOT}/data --cachedir=${DATA_ROOT}/cache --configdir=${DATA_ROOT}/config --logdir=${DATA_ROOT}/log --webdir=${profile.webdir}${ffmpeg}`, 'Restart=on-failure', 'RestartSec=5', 'NoNewPrivileges=true', 'PrivateTmp=true', 'ProtectHome=true', '', '[Install]', 'WantedBy=multi-user.target'].join('\n')
  const nginx = nginxConfig('127.0.0.1')
  return join([
    'set -eu', ...(profile.family === 'arch' ? [archNginxInclude(state)] : []), ...(profile.package ? ['id jellyfin >/dev/null 2>&1'] : [`if ! getent passwd ${quote(profile.user)} >/dev/null; then nologin=$(command -v nologin); useradd --system --home-dir ${quote(DATA_ROOT)} --shell "$nologin" ${quote(profile.user)}; fi`]), `install -d -o ${quote(profile.user)} -g ${quote(profile.user)} -m 0750 ${quote(DATA_ROOT)} ${quote(`${DATA_ROOT}/data`)} ${quote(`${DATA_ROOT}/cache`)} ${quote(`${DATA_ROOT}/config`)} ${quote(`${DATA_ROOT}/log`)}`, `install -d -o ${quote(profile.user)} -g ${quote(profile.user)} -m 0755 ${quote(`${DATA_ROOT}/media`)}`, `printf '%s\\n' ${unit.split('\n').map(quote).join(' ')} > ${quote(paths.serviceFile)}`, `chmod 0644 ${quote(paths.serviceFile)}`, `printf '%s\\n' ${nginx.split('\n').map(quote).join(' ')} > ${quote(paths.nginxVhost)}`, `chmod 0644 ${quote(paths.nginxVhost)}`, ...(paths.nginxEnableLink ? [`ln -sfn ${quote(paths.nginxVhost)} ${quote(paths.nginxEnableLink)}`] : []), 'systemctl daemon-reload', `systemctl enable --now ${quote(SERVICE)}`, 'nginx -t', 'systemctl reload nginx', waitUrlWithServiceDiagnostics(`http://127.0.0.1:${PORT}/jellyfin/health`, 180), 'printf \'%s\\n\' configured'
  ])
}

function archNginxInclude (state) {
  const config = '/etc/nginx/nginx.conf'
  const backup = `${state}/nginx.conf.before`
  const replacement = `${state}/nginx.conf.with-include`
  return `if ! grep -Fq 'include conf.d/*.conf;' ${quote(config)}; then cp -a ${quote(config)} ${quote(backup)}; sed '$d' ${quote(config)} > ${quote(replacement)}; printf '%s\\n' '    include conf.d/*.conf;' >> ${quote(replacement)}; tail -n 1 ${quote(config)} >> ${quote(replacement)}; cat ${quote(replacement)} > ${quote(config)}; : > ${quote(`${state}/nginx.include.added`)}; fi`
}

function initializeJellyfin () {
  const base = `http://127.0.0.1:${PORT}/jellyfin`
  return join([
    'set -eu', `if [ ! -e ${quote(`${CREDENTIALS}/initialized`)} ]; then`, waitUrl(`${base}/Startup/Configuration`, 180), `curl --fail --silent --show-error ${quote(`${base}/Startup/User`)} >/dev/null`, `username=$(cat ${quote(`${CREDENTIALS}/admin_username`)})`, `password=$(cat ${quote(`${CREDENTIALS}/admin_password`)})`, `curl --fail --silent --show-error --request POST --header 'Content-Type: application/json' --data ${quote(`{"ServerName":"${MARKER}","UICulture":"en-US","MetadataCountryCode":"US","PreferredMetadataLanguage":"en"}`)} ${quote(`${base}/Startup/Configuration`)} >/dev/null`, `curl --fail --silent --show-error --request POST --header 'Content-Type: application/json' --data "{\\"Name\\":\\"$username\\",\\"Password\\":\\"$password\\"}" ${quote(`${base}/Startup/User`)} >/dev/null`, `curl --fail --silent --show-error --request POST --header 'Content-Type: application/json' --data ${quote('{"EnableRemoteAccess":false,"EnableAutomaticPortMapping":false}')} ${quote(`${base}/Startup/RemoteAccess`)} >/dev/null`, `curl --fail --silent --show-error --request POST ${quote(`${base}/Startup/Complete`)} >/dev/null`, `: > ${quote(`${CREDENTIALS}/initialized`)}`, `chmod 0600 ${quote(`${CREDENTIALS}/initialized`)}`, 'fi', `curl --fail --silent --show-error ${quote(`${base}/System/Info/Public`)} | grep -F ${quote(MARKER)}`, 'printf \'%s\\n\' initialized'
  ])
}

function nativeVerify (profile) {
  return join([
    'set -eu', waitUrl(`http://127.0.0.1:${PORT}/jellyfin/health`, 120), `curl --fail --silent --show-error http://127.0.0.1:${PORT}/ | grep -Fx ${quote(MARKER)}`, `curl --fail --silent --show-error http://127.0.0.1:${PORT}/jellyfin/System/Info/Public | grep -F ${quote(`"Version":"${VERSION}"`)}`, `curl --fail --silent --show-error http://127.0.0.1:${PORT}/jellyfin/web/ | grep -Fi jellyfin`, `find ${quote(`${DATA_ROOT}/data`)} -maxdepth 2 -type f -name '*.db' | grep -q .`, `test "$(stat -c '%U' ${quote(DATA_ROOT)})" = ${quote(profile.user)}`, `test "$(stat -c '%a' ${quote(CREDENTIALS)})" = 700`, `systemctl restart ${quote(SERVICE)}`, waitUrl(`http://127.0.0.1:${PORT}/jellyfin/health`, 120), `systemctl is-active --quiet ${quote(SERVICE)}`, 'printf \'%s\\n\' jellyfin-verified'
  ])
}

function nativeStop (paths) {
  return join([
    'set -eu', `systemctl disable --now ${quote(SERVICE)} 2>/dev/null || true`, 'systemctl disable --now jellyfin 2>/dev/null || true', `rm -f -- ${quote(paths.serviceFile)} ${quote(paths.nginxVhost)}`, ...(paths.nginxEnableLink ? [`rm -f -- ${quote(paths.nginxEnableLink)}`] : []), 'systemctl daemon-reload', 'if command -v nginx >/dev/null 2>&1; then nginx -t', 'systemctl is-active --quiet nginx && systemctl reload nginx || true', 'fi'
  ])
}

function nativeRestore (state, profile) {
  const commands = ['set -eu', `[ -d ${quote(state)} ] || { printf '%s\\n' already-reverted; exit 0; }`]
  if (profile.family === 'arch') commands.push(`if [ -e ${quote(`${state}/nginx.include.added`)} ] && [ -s ${quote(`${state}/nginx.conf.before`)} ]; then cat ${quote(`${state}/nginx.conf.before`)} > /etc/nginx/nginx.conf; fi`)
  commands.push(removeAddedPackages(profile, `${state}/packages.added`))
  if (profile.package) commands.push('rm -f /etc/apt/sources.list.d/jellyfin.sources /etc/apt/keyrings/jellyfin.gpg', 'apt-get update >/dev/null 2>&1 || true')
  commands.push(`if getent passwd ${quote(profile.user)} >/dev/null; then userdel ${quote(profile.user)} 2>/dev/null || true; fi`)
  commands.push(`if [ -e ${quote(`${state}/nginx.enabled`)} ]; then systemctl enable nginx >/dev/null 2>&1 || true; else systemctl disable nginx >/dev/null 2>&1 || true; fi`, `if [ -e ${quote(`${state}/nginx.active`)} ]; then systemctl start nginx; else systemctl stop nginx 2>/dev/null || true; fi`, `rm -rf -- ${quote(state)}`)
  return join(commands)
}

function composeBaseline (state) {
  return join([
    'set -eu', `if [ ! -s ${quote(`${state}/packages.before`)} ]; then`, `test ! -e ${quote(SERVICE_ROOT)}`, `test ! -e ${quote(DATA_ROOT)}`, `test ! -e ${quote(CREDENTIALS)}`, `install -d -o root -g root -m 0700 ${quote(state)}`, `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(`${state}/packages.before`)}`, `systemctl is-active --quiet docker 2>/dev/null && : > ${quote(`${state}/docker.active`)} || true`, `command -v docker >/dev/null 2>&1 && : > ${quote(`${state}/docker.existed`)} || true`, ...IMAGES.map((image, index) => `docker image inspect ${quote(image)} >/dev/null 2>&1 && : > ${quote(`${state}/image-${index}.existed`)} || true`), 'fi', 'printf \'%s\\n\' baseline-ready'
  ])
}

function prepareDocker (state) {
  return join([
    'set -eu', 'if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then :; else', `[ ! -e ${quote(`${state}/docker.existed`)} ]`, 'export DEBIAN_FRONTEND=noninteractive', 'apt-get update', 'apt-get install -y ca-certificates curl', 'install -d -m 0755 /etc/apt/keyrings', 'curl --fail --location --silent --show-error https://download.docker.com/linux/ubuntu/gpg --output /etc/apt/keyrings/docker.asc', 'chmod 0644 /etc/apt/keyrings/docker.asc', '. /etc/os-release', `arch=$(dpkg --print-architecture); codename=${DOCKER_CODENAME_FALLBACK}`, 'printf \'%s\\n\' \'Types: deb\' \'URIs: https://download.docker.com/linux/ubuntu\' "Suites: $codename" \'Components: stable\' "Architectures: $arch" \'Signed-By: /etc/apt/keyrings/docker.asc\' > /etc/apt/sources.list.d/docker.sources', 'apt-get update', 'apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin', 'systemctl start docker', 'fi', 'docker info >/dev/null', 'docker compose version >/dev/null', `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(`${state}/packages.after`)}`, `LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} > ${quote(`${state}/packages.added`)} || true`
  ])
}

function writeCompose () {
  const compose = [
    'services:', '  app:', `    image: ${JELLYFIN_IMAGE}`, '    user: "1000:1000"', '    restart: unless-stopped', '    volumes:', `      - ${DATA_ROOT}/config:/config`, `      - ${DATA_ROOT}/cache:/cache`, `      - ${DATA_ROOT}/media:/media:ro`, '    healthcheck:', '      test: ["CMD", "curl", "--fail", "--silent", "http://127.0.0.1:8096/health"]', '      interval: 5s', '      timeout: 5s', '      retries: 120', '      start_period: 20s',
    '  nginx:', `    image: ${NGINX_IMAGE}`, '    restart: unless-stopped', '    ports:', `      - "${PORT}:${PORT}"`, '    volumes:', `      - ${SERVICE_ROOT}/nginx.conf:/etc/nginx/conf.d/default.conf:ro`, '    depends_on:', '      app:', '        condition: service_healthy'
  ].join('\n')
  const nginx = nginxConfig('app')
  return join([
    'set -eu', `install -d -o root -g root -m 0755 ${quote(SERVICE_ROOT)}`, `install -d -o 1000 -g 1000 -m 0750 ${quote(DATA_ROOT)} ${quote(`${DATA_ROOT}/config`)} ${quote(`${DATA_ROOT}/cache`)}`, `install -d -o root -g root -m 0755 ${quote(`${DATA_ROOT}/media`)}`, `printf '%s\\n' ${compose.split('\n').map(quote).join(' ')} > ${quote(`${SERVICE_ROOT}/compose.yaml`)}`, `chmod 0644 ${quote(`${SERVICE_ROOT}/compose.yaml`)}`, `printf '%s\\n' ${nginx.split('\n').map(quote).join(' ')} > ${quote(`${SERVICE_ROOT}/nginx.conf`)}`, `chmod 0644 ${quote(`${SERVICE_ROOT}/nginx.conf`)}`, `docker compose -p ${quote(PROJECT)} -f ${quote(`${SERVICE_ROOT}/compose.yaml`)} config --quiet`, 'printf \'%s\\n\' compose-ready'
  ])
}

function startCompose () {
  const compose = composeCommand()
  return join(['set -eu', `${compose} pull`, `${compose} up -d`, waitCompose(), waitUrl(`http://127.0.0.1:${PORT}/jellyfin/health`, 180), `curl --fail --silent --show-error http://127.0.0.1:${PORT}/ | grep -Fx ${quote(MARKER)}`])
}

function verifyCompose () {
  const compose = composeCommand()
  return join([
    'set -eu', waitCompose(), waitUrl(`http://127.0.0.1:${PORT}/jellyfin/health`, 120), `${compose} exec -T app /jellyfin/jellyfin --version 2>&1 | grep -F ${quote(VERSION)}`, `curl --fail --silent --show-error http://127.0.0.1:${PORT}/ | grep -Fx ${quote(MARKER)}`, `curl --fail --silent --show-error http://127.0.0.1:${PORT}/jellyfin/System/Info/Public | grep -F ${quote(`"Version":"${VERSION}"`)}`, `curl --fail --silent --show-error http://127.0.0.1:${PORT}/jellyfin/web/ | grep -Fi jellyfin`, `find ${quote(`${DATA_ROOT}/config`)} -maxdepth 2 -type f -name '*.db' | grep -q .`, 'printf \'%s\\n\' jellyfin-verified'
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

function nginxConfig (upstream) {
  return ['server {', `    listen ${PORT};`, '    server_name _;', '    location = / { default_type text/plain; return 200 "' + MARKER + '\\n"; }', '    location /jellyfin/ {', `        proxy_pass http://${upstream}:${APP_PORT}/;`, '        proxy_http_version 1.1;', '        proxy_set_header Host $host;', '        proxy_set_header X-Real-IP $remote_addr;', '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;', '        proxy_set_header X-Forwarded-Proto $scheme;', '        proxy_set_header Upgrade $http_upgrade;', '        proxy_set_header Connection "upgrade";', '    }', '}'].join('\n')
}

function packageSnapshot (profile, file) {
  if (profile.family === 'debian') return `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(file)}`
  if (profile.family === 'arch') return `pacman -Qq | LC_ALL=C sort -u > ${quote(file)}`
  if (profile.family === 'suse') return `rpm -qa --qf '%{NAME}\\n' | LC_ALL=C sort -u > ${quote(file)}`
  return `rpm -qa --qf '%{NAME}\\n' | LC_ALL=C sort -u > ${quote(file)}`
}

function packageAdded (profile, state) {
  if (profile.family === 'debian') return `LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} > ${quote(`${state}/packages.added`)} || true`
  return `LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} > ${quote(`${state}/packages.added`)} || true`
}

function removeAddedPackages (profile, list) {
  if (profile.family === 'debian') return removeDebianPackages(list)
  if (profile.family === 'arch') return `if [ -s ${quote(list)} ]; then packages=$(grep -Ev '^(netdata|openssh|curl|ca-certificates)$' ${quote(list)} | tr '\\n' ' '); [ -z "$packages" ] || pacman -Rns --noconfirm $packages || true; fi`
  if (profile.family === 'suse') return `if [ -s ${quote(list)} ]; then packages=$(grep -Ev '^(netdata|openssh|curl|ca-certificates)$' ${quote(list)} | tr '\\n' ' '); [ -z "$packages" ] || zypper --non-interactive remove --clean-deps $packages || true; fi`
  return `if [ -s ${quote(list)} ]; then packages=$(grep -Ev '^(netdata|openssh|curl|ca-certificates)$' ${quote(list)} | tr '\\n' ' '); [ -z "$packages" ] || dnf remove -y $packages || true; fi`
}

function removeDebianPackages (list) {
  return `if [ -s ${quote(list)} ]; then packages=$(awk '{print $1}' ${quote(list)} | grep -Ev '^(netdata|openssh|curl|ca-certificates)(:|$)' | tr '\\n' ' '); [ -z "$packages" ] || DEBIAN_FRONTEND=noninteractive apt-get purge -y $packages || true; fi`
}

function composeCommand () {
  return `docker compose -p ${quote(PROJECT)} -f ${quote(`${SERVICE_ROOT}/compose.yaml`)}`
}

function waitUrl (url, attempts) {
  return `ready=; for attempt in $(seq 1 ${attempts}); do if curl --fail --silent --show-error --max-time 3 ${quote(url)} >/dev/null 2>&1; then ready=yes; break; fi; sleep 2; done; [ "$ready" = yes ]`
}

function waitUrlWithServiceDiagnostics (url, attempts) {
  return `ready=; for attempt in $(seq 1 ${attempts}); do if curl --fail --silent --show-error --max-time 3 ${quote(url)} >/dev/null 2>&1; then ready=yes; break; fi; sleep 2; done; if [ "$ready" != yes ]; then systemctl show ${quote(SERVICE)} -p ActiveState -p SubState -p Result -p ExecMainStatus --no-pager 2>&1 | tail -n 8 >&2 || true; journalctl -u ${quote(SERVICE)} --no-pager -n 30 -o cat 2>&1 | tail -n 30 >&2 || true; exit 1; fi`
}

function waitCompose () {
  return `ready=; for attempt in $(seq 1 180); do status=$(docker inspect ${quote(`${PROJECT}-app-1`)} --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || true); [ "$status" = healthy ] && ready=yes && break; sleep 5; done; [ "$ready" = yes ]`
}

function item (id, phase, command, purpose, dependsOn = [], timeoutMs = 300000, executionMode, risk = 'change') {
  return { id, phase, command, purpose, risk, timeoutMs, requiresSudo: true, dependsOn, ...(executionMode ? { executionMode } : {}) }
}

function join (parts) {
  return parts.filter(Boolean).join('; ').replaceAll('then; ', 'then ').replaceAll('else; ', 'else ')
}

function quote (value) {
  return `'${String(value).replaceAll("'", '\'\\\'\'')}'`
}
