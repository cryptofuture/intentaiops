const VERSION = '11.7.8'
const PORT = 18111
const APP_PORT = 8065
const MARKER = 'WEBMINAI_MATTERMOST_OK'
const SERVICE = 'webminai-mattermost-18111'
const APP_ROOT = '/opt/webminai-mattermost-18111'
const DATA_ROOT = '/var/lib/webminai-mattermost-18111'
const CREDENTIALS = '/root/mattermost_credentials'
const SERVICE_ROOT = '/opt/webminai/services/mattermost'
const PROJECT = 'webminai-mattermost-18111'
const DATABASE = 'webminai_mattermost_18111'
const DATABASE_USER = 'webminai_mattermost'
const ARCHIVE = `mattermost-team-${VERSION}-linux-amd64.tar.gz`
const ARCHIVE_URL = `https://releases.mattermost.com/${VERSION}/${ARCHIVE}`
const ARCHIVE_SHA256 = '0fc1637ca6cec0a53fc7112a22f67651dba50fe3667e5ed957acf0d3bbb9da93'
const MATTERMOST_IMAGE = 'mattermost/mattermost-team-edition@sha256:65c8e3fa5122307b833eb08d3ea402b2f829a0fd43a82f6e2ccea0e14225c970'
const POSTGRES_IMAGE = 'postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94'
const NGINX_IMAGE = 'nginx@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46'
const IMAGES = [MATTERMOST_IMAGE, POSTGRES_IMAGE, NGINX_IMAGE]
const DPKG_PACKAGE_FORMAT = '$' + '{binary:Package} $' + '{Version}\\n'
const DOCKER_CODENAME_FALLBACK = '$' + '{UBUNTU_CODENAME:-$VERSION_CODENAME}'

export function buildMattermostTask (taskId, linuxContext, docker = {}) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  if (!linuxContext?.identity || !linuxContext?.management) throw new TypeError('Mattermost task requires a Linux host context')
  if (docker.preferred === true) return buildComposeTask(taskId, linuxContext, docker)
  const id = linuxContext.identity.id
  if (['ubuntu', 'debian'].includes(id)) return buildNativeTask(taskId, linuxContext, nativeProfile('debian'))
  if (['almalinux', 'rocky', 'ol'].includes(id)) return buildNativeTask(taskId, linuxContext, nativeProfile('rhel'))
  return buildCompatibilityTask(taskId, linuxContext)
}

export function mattermostRelease () {
  return Object.freeze({ version: VERSION, archiveSha256: ARCHIVE_SHA256, images: Object.freeze([...IMAGES]) })
}

function buildCompatibilityTask (taskId, context) {
  const state = `/var/lib/webminai/task-state/${taskId}-mattermost-compatibility`
  const identity = context.identity
  const reason = `Mattermost ${VERSION} production is not promoted on ${identity.id} ${identity.versionId ?? ''}: upstream production support does not include this distribution and automatic Docker is disabled for container hosts.`
  return envelope({
    context,
    route: 'no-change-incompatible',
    overview: `Record a no-change Mattermost production compatibility result for ${identity.id} ${identity.versionId ?? ''}.`,
    files: [state, `${state}/report.txt`],
    commands: [item('record-compatibility', 'preflight', join(['set -eu', ...ownedAbsent(), `install -d -o root -g root -m 0700 ${quote(state)}`, `printf '%s\\n' ${quote(reason)} > ${quote(`${state}/report.txt`)}`, `chmod 0600 ${quote(`${state}/report.txt`)}`]), 'Record the reviewed no-change compatibility result without installing an unsupported production stack')],
    revertCommands: [item('remove-compatibility-report', 'cleanup', `set -eu; rm -rf -- ${quote(state)}; printf '%s\\n' compatibility-report-removed`, 'Remove only the task-owned compatibility report', [], 30000, undefined, 'destructive')],
    verifyApplied: `test -s ${quote(`${state}/report.txt`)} && grep -Fq 'upstream production support' ${quote(`${state}/report.txt`)} && test ! -e ${quote(APP_ROOT)} && test ! -e ${quote(CREDENTIALS)}`,
    verifyReverted: `test ! -e ${quote(state)}`
  })
}

function buildNativeTask (taskId, context, profile) {
  const state = `/var/lib/webminai/task-state/${taskId}-mattermost-linux`
  const paths = nativePaths(profile)
  const commands = [
    item('capture-baseline', 'baseline', nativeBaseline(state, paths, profile), 'Capture packages, services, repository stream, and task-owned paths exactly once'),
    item('install-stack', 'packages', nativePackages(state, profile), `Install nginx and PostgreSQL ${profile.postgresMajor}+ through the reviewed ${profile.family} route`, ['capture-baseline'], 1200000, 'job'),
    item('generate-credentials', 'secrets', credentialsCommand(), 'Generate the PostgreSQL password on-host without emitting it', ['capture-baseline']),
    item('initialize-database', 'database', nativeDatabase(profile), 'Initialize PostgreSQL and create the isolated Mattermost database role', ['install-stack', 'generate-credentials']),
    item('install-mattermost', 'acquire', nativeAcquire(state), `Download, checksum, and install the official Mattermost Team Edition ${VERSION} tarball`, ['install-stack'], 1800000, 'job'),
    item('configure-mattermost', 'configure', nativeConfigure(paths, profile), 'Create protected runtime configuration, systemd service, storage, and nginx proxy', ['initialize-database', 'install-mattermost']),
    item('verify-mattermost', 'verify', nativeVerify(profile), 'Verify Mattermost health, PostgreSQL persistence, version, marker, and restart recovery', ['configure-mattermost'], 1200000, 'job')
  ]
  const revertCommands = [
    item('stop-mattermost', 'cleanup', nativeStop(paths), 'Stop and remove only the task-owned Mattermost service and nginx site', [], 300000, undefined, 'destructive'),
    item('drop-database', 'cleanup', nativeDropDatabase(profile), 'Drop only the task-owned PostgreSQL database and role', ['stop-mattermost'], 300000, undefined, 'destructive'),
    item('remove-mattermost-files', 'cleanup', `set -eu; rm -rf -- ${quote(APP_ROOT)} ${quote(DATA_ROOT)} ${quote(CREDENTIALS)}`, 'Remove task-owned application, persistent data, and credentials', ['drop-database'], 300000, undefined, 'destructive'),
    item('restore-stack', 'cleanup', nativeRestore(state, paths, profile), 'Restore package, service, and module state from the factual baseline', ['remove-mattermost-files'], 1200000, 'job', 'destructive')
  ]
  return envelope({
    context,
    route: `native-${profile.family}-postgresql`,
    overview: `Deploy Mattermost Team Edition ${VERSION} with PostgreSQL, systemd, and nginx on port ${PORT}.`,
    files: [state, APP_ROOT, DATA_ROOT, CREDENTIALS, paths.serviceFile, paths.nginxVhost, ...(paths.nginxEnableLink ? [paths.nginxEnableLink] : []), ...(profile.hba ? [profile.hba] : [])],
    commands,
    revertCommands,
    verifyApplied: nativeVerify(profile),
    verifyReverted: `test ! -e ${quote(APP_ROOT)} && test ! -e ${quote(DATA_ROOT)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)} && test ! -e ${quote(paths.serviceFile)} && test ! -e ${quote(paths.nginxVhost)}`
  })
}

function buildComposeTask (taskId, context, docker) {
  if (!docker.ready && docker.installMethod !== 'official-apt') throw new Error('learned Mattermost Compose setup requires Docker ready or the reviewed official apt route')
  const state = `/var/lib/webminai/task-state/${taskId}-mattermost-compose`
  const commands = [
    item('capture-baseline', 'baseline', composeBaseline(state), 'Capture Docker, images, service state, and task paths exactly once'),
    item('prepare-docker', 'packages', prepareDocker(state), 'Install Docker and Compose only when the reviewed host route requires them', ['capture-baseline'], 900000, 'job'),
    item('generate-credentials', 'secrets', credentialsCommand(), 'Generate PostgreSQL credentials on-host without emitting them', ['capture-baseline']),
    item('write-compose', 'configure', writeCompose(), 'Write the digest-pinned Mattermost, PostgreSQL, and nginx Compose project', ['prepare-docker', 'generate-credentials']),
    item('start-compose', 'services', startCompose(), 'Pull and start Mattermost with bounded PostgreSQL and application readiness', ['write-compose'], 2700000, 'job'),
    item('verify-compose', 'verify', verifyCompose(), 'Verify Mattermost version, API health, PostgreSQL persistence, marker, and restart recovery', ['start-compose'], 1200000, 'job')
  ]
  const revertCommands = [
    item('remove-compose-project', 'cleanup', removeCompose(state), 'Remove only task-owned containers, volumes, network, and newly pulled images', [], 1200000, 'job', 'destructive'),
    item('remove-compose-files', 'cleanup', `set -eu; rm -rf -- ${quote(SERVICE_ROOT)} ${quote(CREDENTIALS)}`, 'Remove task-owned Compose files and credentials', ['remove-compose-project'], 300000, undefined, 'destructive'),
    item('restore-docker', 'cleanup', restoreDocker(state), 'Restore Docker package and service state when introduced by this task', ['remove-compose-files'], 900000, 'job', 'destructive')
  ]
  return envelope({
    context,
    route: 'compose-postgresql',
    overview: `Deploy official Mattermost Team Edition ${VERSION}, PostgreSQL 17, and nginx through digest-pinned Compose on port ${PORT}.`,
    files: [state, SERVICE_ROOT, `${SERVICE_ROOT}/compose.yaml`, `${SERVICE_ROOT}/nginx.conf`, CREDENTIALS],
    commands,
    revertCommands,
    verifyApplied: verifyCompose(),
    verifyReverted: `test ! -e ${quote(SERVICE_ROOT)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)} && { ! command -v docker >/dev/null 2>&1 || ! docker ps -aq --filter label=com.docker.compose.project=${quote(PROJECT)} | grep -q .; }`
  })
}

function envelope ({ context, route, overview, files, commands, revertCommands, verifyApplied, verifyReverted }) {
  const identity = context.identity
  return {
    plan: {
      summary: route === 'no-change-incompatible' ? 'Record Mattermost production compatibility result' : `Deploy a learned reversible ${route.startsWith('compose') ? 'Mattermost Compose' : 'native Mattermost'} service`,
      changeOverview: overview,
      modifiedFiles: files,
      assumptions: [
        `Authoritative Linux profile: ${identity.id} ${identity.versionId ?? ''}`.trim(),
        `Resolved Mattermost matrix: Team Edition ${VERSION}, 64-bit x86 Linux, and PostgreSQL 14+.`,
        'Database credentials are generated on-host and only protected paths are included in plans and logs.'
      ],
      warnings: route === 'no-change-incompatible'
        ? ['No application is installed because this host lacks an upstream-supported native route and automatic Docker is disabled for container hosts.']
        : [`This controlled validation publishes TCP port ${PORT} through nginx and does not configure public DNS, TLS, SMTP, or Calls.`],
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
  return {
    format: 'webminai-compatibility-manifest',
    version: 1,
    application: { id: 'mattermost', version: VERSION },
    host: { fingerprint: context.fingerprint, distribution: context.identity.id, distributionVersion: context.identity.versionId, architecture: context.identity.architecture, family: context.management.family },
    selectedRoute: { id: route, status: route === 'no-change-incompatible' ? 'unsupported' : 'supported' },
    components: [
      { profileId: 'mattermost', selectedVersion: VERSION, source: route.startsWith('compose') ? 'official-container-image' : 'official-checksummed-tarball', status: route === 'no-change-incompatible' ? 'unavailable' : 'supported' },
      { profileId: 'postgresql', selectedVersion: route.startsWith('compose') ? '17' : '14+', source: route.startsWith('compose') ? 'official-container-image' : 'distribution-package', status: route === 'no-change-incompatible' ? 'not-selected' : 'supported' },
      { profileId: 'nginx', selectedVersion: 'distribution-or-image', source: 'reviewed-profile', status: route === 'no-change-incompatible' ? 'not-selected' : 'supported' }
    ]
  }
}

function nativeProfile (family) {
  if (family === 'debian') return { family, postgresMajor: 14, packageManager: 'apt', service: 'postgresql', dataRoot: '/var/lib/postgresql' }
  return { family, postgresMajor: 16, packageManager: 'dnf', service: 'postgresql', dataRoot: '/var/lib/pgsql', hba: '/var/lib/pgsql/data/pg_hba.conf' }
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
  const packageSnapshot = profile.family === 'debian'
    ? `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(`${state}/packages.before`)}`
    : `rpm -qa --qf '%{NAME}\\n' | LC_ALL=C sort -u > ${quote(`${state}/packages.before`)}`
  return join([
    'set -eu', `if [ ! -s ${quote(`${state}/packages.before`)} ]; then`, ...owned.map(path => `test ! -e ${quote(path)}`),
    `install -d -o root -g root -m 0700 ${quote(state)}`, packageSnapshot,
    `systemctl is-active --quiet nginx 2>/dev/null && : > ${quote(`${state}/nginx.active`)} || true`, `systemctl is-enabled --quiet nginx 2>/dev/null && : > ${quote(`${state}/nginx.enabled`)} || true`,
    `systemctl is-active --quiet ${quote(profile.service)} 2>/dev/null && : > ${quote(`${state}/postgres.active`)} || true`, `systemctl is-enabled --quiet ${quote(profile.service)} 2>/dev/null && : > ${quote(`${state}/postgres.enabled`)} || true`,
    `[ -e ${quote(profile.dataRoot)} ] && : > ${quote(`${state}/postgres-data.existed`)} || true`,
    ...(profile.family === 'debian' ? [`if command -v pg_lsclusters >/dev/null 2>&1; then pg_lsclusters --no-header 2>/dev/null | awk '$2 == "main" { print $1; exit }' > ${quote(`${state}/postgres-cluster.before`)}; [ -s ${quote(`${state}/postgres-cluster.before`)} ] || rm -f ${quote(`${state}/postgres-cluster.before`)}; fi`] : []),
    ...(profile.family === 'rhel' ? [`dnf -q module list --enabled postgresql 2>/dev/null | awk '$1 == "postgresql" { print $2; exit }' > ${quote(`${state}/postgres-module.before`)} || true`, `[ ! -f ${quote(profile.hba)} ] || cp -a -- ${quote(profile.hba)} ${quote(`${state}/postgres-hba.before`)}`] : []),
    'fi', 'printf \'%s\\n\' baseline-ready'
  ])
}

function nativePackages (state, profile) {
  if (profile.family === 'debian') {
    return join([
      'set -eu', 'export DEBIAN_FRONTEND=noninteractive', 'apt-get update', 'apt-get install -y ca-certificates curl tar gzip nginx postgresql postgresql-client openssl',
      `major=$(pg_config --version | awk '{ split($2, version, "."); print version[1] }'); [ "$major" -ge ${profile.postgresMajor} ]`,
      'if ! pg_lsclusters --no-header 2>/dev/null | awk -v major="$major" \'$1 == major && $2 == "main" { found=1 } END { exit !found }\'; then pg_createcluster "$major" main --start; else pg_ctlcluster "$major" main start; fi',
      `if [ ! -s ${quote(`${state}/postgres-cluster.before`)} ]; then printf '%s\\n' "$major" > ${quote(`${state}/postgres-cluster.created`)}; fi`,
      'systemctl enable postgresql', 'systemctl enable --now nginx',
      `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(`${state}/packages.after`)}`, `LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} > ${quote(`${state}/packages.added`)} || true`
    ])
  }
  return join([
    'set -eu', `dnf -y module enable postgresql:${profile.postgresMajor}`, 'dnf install -y ca-certificates curl tar gzip nginx postgresql-server postgresql openssl',
    `postgres --version | awk '{ split($3, version, "."); exit !(version[1] >= ${profile.postgresMajor}) }'`,
    `if [ ! -s ${quote(`${profile.dataRoot}/data/PG_VERSION`)} ]; then postgresql-setup --initdb; fi`,
    `rule='host ${DATABASE} ${DATABASE_USER} 127.0.0.1/32 scram-sha-256'; if ! grep -Fqx "$rule" ${quote(profile.hba)}; then { printf '%s\\n' "$rule"; cat ${quote(profile.hba)}; } > ${quote(`${profile.hba}.webminai-new`)}; chown postgres:postgres ${quote(`${profile.hba}.webminai-new`)}; chmod 0600 ${quote(`${profile.hba}.webminai-new`)}; mv ${quote(`${profile.hba}.webminai-new`)} ${quote(profile.hba)}; fi`,
    'systemctl enable --now postgresql', 'systemctl enable --now nginx',
    `rpm -qa --qf '%{NAME}\\n' | LC_ALL=C sort -u > ${quote(`${state}/packages.after`)}`, `LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} > ${quote(`${state}/packages.added`)} || true`
  ])
}

function credentialsCommand () {
  return join([
    'set -eu', 'umask 077', `install -d -o root -g root -m 0700 ${quote(CREDENTIALS)}`,
    `[ -s ${quote(`${CREDENTIALS}/database_password`)} ] || openssl rand -hex 32 > ${quote(`${CREDENTIALS}/database_password`)}`,
    `chmod 0600 ${quote(`${CREDENTIALS}/database_password`)}`, `printf '%s\\n' ${quote(CREDENTIALS)}`
  ])
}

function nativeDatabase (profile) {
  return join([
    'set -eu', `systemctl start ${quote(profile.service)}`, 'ready=', 'for attempt in $(seq 1 60); do runuser -u postgres -- psql -Atqc \'SELECT 1\' postgres >/dev/null 2>&1 && ready=yes && break; sleep 2; done', '[ "$ready" = yes ]',
    `password=$(cat ${quote(`${CREDENTIALS}/database_password`)})`,
    `runuser -u postgres -- psql -Atqc "SELECT 1 FROM pg_roles WHERE rolname='${DATABASE_USER}'" postgres | grep -Fx 1 || runuser -u postgres -- createuser --login ${quote(DATABASE_USER)}`,
    `runuser -u postgres -- psql -v ON_ERROR_STOP=1 -v password="$password" postgres <<'SQL'
ALTER ROLE ${DATABASE_USER} WITH LOGIN PASSWORD :'password';
SQL
:`,
    `runuser -u postgres -- psql -Atqc "SELECT 1 FROM pg_database WHERE datname='${DATABASE}'" postgres | grep -Fx 1 || runuser -u postgres -- createdb -O ${quote(DATABASE_USER)} ${quote(DATABASE)}`,
    `PGPASSWORD="$password" psql -h 127.0.0.1 -U ${quote(DATABASE_USER)} -d ${quote(DATABASE)} -Atqc 'SELECT 1' | grep -Fx 1`, 'printf \'%s\\n\' database-ready'
  ])
}

function nativeAcquire (state) {
  const artifact = `${state}/${ARCHIVE}`
  return join([
    'set -eu', `if [ ! -x ${quote(`${APP_ROOT}/bin/mattermost`)} ]; then`, `rm -rf -- ${quote(`${APP_ROOT}.new`)}`, `install -d -o root -g root -m 0755 ${quote(`${APP_ROOT}.new`)}`,
    `if [ ! -s ${quote(artifact)} ] || ! printf '%s  %s\\n' ${quote(ARCHIVE_SHA256)} ${quote(artifact)} | sha256sum -c - >/dev/null 2>&1; then rm -f -- ${quote(artifact)}; curl --fail --location --retry 5 --retry-delay 2 --silent --show-error --output ${quote(artifact)} ${quote(ARCHIVE_URL)}; fi`,
    `printf '%s  %s\\n' ${quote(ARCHIVE_SHA256)} ${quote(artifact)} | sha256sum -c -`, `tar -xzf ${quote(artifact)} -C ${quote(`${APP_ROOT}.new`)} --strip-components=1`,
    `test -x ${quote(`${APP_ROOT}.new/bin/mattermost`)}`, `mv ${quote(`${APP_ROOT}.new`)} ${quote(APP_ROOT)}`, 'fi',
    `${quote(`${APP_ROOT}/bin/mattermost`)} version | grep -F ${quote(VERSION)}`, 'printf \'%s\\n\' mattermost-installed'
  ])
}

function nativeConfigure (paths, profile) {
  const unit = ['[Unit]', 'Description=Intent AI Ops Mattermost validation service', `After=network-online.target ${profile.service}.service`, 'Wants=network-online.target', `Requires=${profile.service}.service`, '', '[Service]', 'Type=simple', 'User=webminai-mattermost', 'Group=webminai-mattermost', `WorkingDirectory=${APP_ROOT}`, `EnvironmentFile=${CREDENTIALS}/service.env`, `ExecStart=${APP_ROOT}/bin/mattermost`, 'Restart=on-failure', 'RestartSec=5', 'LimitNOFILE=49152', 'NoNewPrivileges=true', 'PrivateTmp=true', '', '[Install]', 'WantedBy=multi-user.target'].join('\n')
  const nginx = ['server {', `    listen ${PORT};`, '    server_name _;', '    location = / { default_type text/plain; return 200 "' + MARKER + '\\n"; }', '    location /api/ {', `        proxy_pass http://127.0.0.1:${APP_PORT};`, '        proxy_set_header Host $host;', '        proxy_set_header X-Real-IP $remote_addr;', '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;', '        proxy_set_header X-Forwarded-Proto $scheme;', '    }', '}'].join('\n')
  return join([
    'set -eu', `id webminai-mattermost >/dev/null 2>&1 || useradd -r -d ${quote(DATA_ROOT)} -s /usr/sbin/nologin webminai-mattermost`,
    `install -d -o webminai-mattermost -g webminai-mattermost -m 0750 ${quote(DATA_ROOT)} ${quote(`${DATA_ROOT}/data`)} ${quote(`${DATA_ROOT}/logs`)} ${quote(`${DATA_ROOT}/plugins`)} ${quote(`${DATA_ROOT}/client/plugins`)}`,
    `chown -R webminai-mattermost:webminai-mattermost ${quote(APP_ROOT)} ${quote(DATA_ROOT)}`, `password=$(cat ${quote(`${CREDENTIALS}/database_password`)})`,
    "primary=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (field=1; field<=NF; field++) if ($field == \"src\") { print $(field+1); exit }}' || true)", "[ -n \"$primary\" ] || primary=$(hostname -I 2>/dev/null | awk '{print $1}')", "case \"$primary\" in ''|*[!0-9a-fA-F:.]*) printf 'could not resolve a safe primary address\\n' >&2; exit 1;; esac",
    `chgrp webminai-mattermost ${quote(CREDENTIALS)}`, `chmod 0710 ${quote(CREDENTIALS)}`,
    `umask 077; printf 'MM_SERVICESETTINGS_LISTENADDRESS=127.0.0.1:${APP_PORT}\\nMM_SERVICESETTINGS_SITEURL=http://%s:${PORT}\\nMM_SQLSETTINGS_DRIVERNAME=postgres\\nMM_SQLSETTINGS_DATASOURCE=postgres://${DATABASE_USER}:%s@127.0.0.1:5432/${DATABASE}?sslmode=disable&connect_timeout=10\\nMM_FILESETTINGS_DIRECTORY=${DATA_ROOT}/data\\nMM_PLUGINSETTINGS_DIRECTORY=${DATA_ROOT}/plugins\\nMM_PLUGINSETTINGS_CLIENTDIRECTORY=${DATA_ROOT}/client/plugins\\nMM_LOGSETTINGS_ENABLEFILE=false\\nMM_LOGSETTINGS_ENABLECONSOLE=true\\n' "$primary" "$password" > ${quote(`${CREDENTIALS}/service.env`)}`,
    `chown root:webminai-mattermost ${quote(`${CREDENTIALS}/service.env`)}`, `chmod 0640 ${quote(`${CREDENTIALS}/service.env`)}`,
    `printf '%s\\n' ${unit.split('\n').map(quote).join(' ')} > ${quote(paths.serviceFile)}`, `chmod 0644 ${quote(paths.serviceFile)}`,
    `printf '%s\\n' ${nginx.split('\n').map(quote).join(' ')} > ${quote(paths.nginxVhost)}`, `chmod 0644 ${quote(paths.nginxVhost)}`,
    ...(paths.nginxEnableLink ? [`ln -sfn ${quote(paths.nginxVhost)} ${quote(paths.nginxEnableLink)}`] : []),
    'systemctl daemon-reload', `systemctl enable --now ${quote(SERVICE)}`, 'nginx -t', 'systemctl reload nginx', 'printf \'%s\\n\' configured'
  ])
}

function nativeVerify (profile) {
  return join([
    'set -eu', waitUrl(`http://127.0.0.1:${APP_PORT}/api/v4/system/ping`, 180),
    `${quote(`${APP_ROOT}/bin/mattermost`)} version | grep -F ${quote(VERSION)}`, `password=$(cat ${quote(`${CREDENTIALS}/database_password`)})`,
    `PGPASSWORD="$password" psql -h 127.0.0.1 -U ${quote(DATABASE_USER)} -d ${quote(DATABASE)} -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" | awk '$1 > 0 { ok=1 } END { exit !ok }'`,
    `curl --fail --silent --show-error --max-time 5 http://127.0.0.1:${PORT}/ | grep -Fx ${quote(MARKER)}`,
    `curl --fail --silent --show-error --max-time 5 http://127.0.0.1:${PORT}/api/v4/system/ping | grep -F 'OK'`,
    `systemctl restart ${quote(SERVICE)}`, waitUrl(`http://127.0.0.1:${APP_PORT}/api/v4/system/ping`, 180), `systemctl is-active --quiet ${quote(profile.service)}`, 'printf \'%s\\n\' mattermost-verified'
  ])
}

function nativeStop (paths) {
  return join([
    'set -eu', `systemctl disable --now ${quote(SERVICE)} 2>/dev/null || true`, `rm -f -- ${quote(paths.serviceFile)}`, 'systemctl daemon-reload',
    `rm -f -- ${quote(paths.nginxVhost)}`, ...(paths.nginxEnableLink ? [`rm -f -- ${quote(paths.nginxEnableLink)}`] : []),
    'if command -v nginx >/dev/null 2>&1; then nginx -t', 'systemctl is-active --quiet nginx && systemctl reload nginx || true', 'fi'
  ])
}

function nativeDropDatabase (profile) {
  return join([
    'set -eu', 'if command -v psql >/dev/null 2>&1 && runuser -u postgres -- psql -Atqc \'SELECT 1\' postgres >/dev/null 2>&1; then',
    `runuser -u postgres -- psql -v ON_ERROR_STOP=1 postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DATABASE}' AND pid <> pg_backend_pid();" >/dev/null`,
    `runuser -u postgres -- dropdb --if-exists ${quote(DATABASE)}`, `runuser -u postgres -- dropuser --if-exists ${quote(DATABASE_USER)}`, 'fi', 'printf \'%s\\n\' database-removed'
  ])
}

function nativeRestore (state, paths, profile) {
  const removePackages = profile.family === 'debian'
    ? `if [ -s ${quote(`${state}/packages.added`)} ]; then packages=$(awk '{print $1}' ${quote(`${state}/packages.added`)} | grep -Ev '^(netdata|openssh|curl|ca-certificates)(:|$)' | tr '\\n' ' '); [ -z "$packages" ] || DEBIAN_FRONTEND=noninteractive apt-get purge -y $packages || true; fi`
    : `if [ -s ${quote(`${state}/packages.added`)} ]; then packages=$(grep -Ev '^(netdata|openssh|curl|ca-certificates)$' ${quote(`${state}/packages.added`)} | tr '\\n' ' '); [ -z "$packages" ] || dnf remove -y $packages || true; fi`
  const commands = ['set -eu', `[ -d ${quote(state)} ] || { printf '%s\\n' already-reverted; exit 0; }`]
  if (profile.family === 'debian') {
    commands.push(`if [ -s ${quote(`${state}/postgres-cluster.created`)} ]; then major=$(sed -n '1p' ${quote(`${state}/postgres-cluster.created`)}); case "$major" in ''|*[!0-9]*) exit 1;; esac; command -v pg_dropcluster >/dev/null 2>&1 && pg_dropcluster --stop "$major" main || true; fi`)
  } else {
    commands.push(`if [ -f ${quote(`${state}/postgres-hba.before`)} ]; then cp -a -- ${quote(`${state}/postgres-hba.before`)} ${quote(profile.hba)}; elif [ -f ${quote(profile.hba)} ]; then rule='host ${DATABASE} ${DATABASE_USER} 127.0.0.1/32 scram-sha-256'; awk -v rule="$rule" '$0 != rule' ${quote(profile.hba)} > ${quote(`${profile.hba}.webminai-new`)}; chown postgres:postgres ${quote(`${profile.hba}.webminai-new`)}; chmod 0600 ${quote(`${profile.hba}.webminai-new`)}; mv ${quote(`${profile.hba}.webminai-new`)} ${quote(profile.hba)}; fi`)
  }
  commands.push(removePackages)
  if (profile.family === 'rhel') {
    commands.push('dnf -y module reset postgresql >/dev/null 2>&1 || true', `stream=$(sed -n '1p' ${quote(`${state}/postgres-module.before`)} 2>/dev/null || true)`, '[ -z "$stream" ] || dnf -y module enable "postgresql:$stream" >/dev/null')
  }
  commands.push(`if [ ! -e ${quote(`${state}/postgres-data.existed`)} ]; then rm -rf -- ${quote(profile.dataRoot)}; fi`)
  commands.push(`if [ -e ${quote(`${state}/nginx.enabled`)} ]; then systemctl enable nginx >/dev/null 2>&1 || true; else systemctl disable nginx >/dev/null 2>&1 || true; fi`, `if [ -e ${quote(`${state}/nginx.active`)} ]; then systemctl start nginx; else systemctl stop nginx 2>/dev/null || true; fi`)
  commands.push(`if [ -e ${quote(`${state}/postgres.enabled`)} ]; then systemctl enable ${quote(profile.service)} >/dev/null 2>&1 || true; else systemctl disable ${quote(profile.service)} >/dev/null 2>&1 || true; fi`, `if [ -e ${quote(`${state}/postgres.active`)} ]; then systemctl start ${quote(profile.service)}; else systemctl stop ${quote(profile.service)} 2>/dev/null || true; fi`)
  commands.push('id webminai-mattermost >/dev/null 2>&1 && userdel webminai-mattermost 2>/dev/null || true', `rm -rf -- ${quote(state)}`)
  return join(commands)
}

function composeBaseline (state) {
  return join([
    'set -eu', `if [ ! -s ${quote(`${state}/packages.before`)} ]; then`, `test ! -e ${quote(SERVICE_ROOT)}`, `test ! -e ${quote(CREDENTIALS)}`,
    `install -d -o root -g root -m 0700 ${quote(state)}`, `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(`${state}/packages.before`)}`,
    `systemctl is-active --quiet docker 2>/dev/null && : > ${quote(`${state}/docker.active`)} || true`, `command -v docker >/dev/null 2>&1 && : > ${quote(`${state}/docker.existed`)} || true`,
    ...IMAGES.map((image, index) => `docker image inspect ${quote(image)} >/dev/null 2>&1 && : > ${quote(`${state}/image-${index}.existed`)} || true`), 'fi', 'printf \'%s\\n\' baseline-ready'
  ])
}

function prepareDocker (state) {
  return join([
    'set -eu', 'if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then :; else',
    `[ ! -e ${quote(`${state}/docker.existed`)} ]`, 'export DEBIAN_FRONTEND=noninteractive', 'apt-get update', 'apt-get install -y ca-certificates curl',
    'install -d -m 0755 /etc/apt/keyrings', 'curl --fail --location --silent --show-error https://download.docker.com/linux/ubuntu/gpg --output /etc/apt/keyrings/docker.asc', 'chmod 0644 /etc/apt/keyrings/docker.asc',
    '. /etc/os-release', `arch=$(dpkg --print-architecture); codename=${DOCKER_CODENAME_FALLBACK}`, 'printf \'%s\\n\' \'Types: deb\' \'URIs: https://download.docker.com/linux/ubuntu\' "Suites: $codename" \'Components: stable\' "Architectures: $arch" \'Signed-By: /etc/apt/keyrings/docker.asc\' > /etc/apt/sources.list.d/docker.sources',
    'apt-get update', 'apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin', 'systemctl start docker', 'fi',
    'docker info >/dev/null', 'docker compose version >/dev/null', `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(`${state}/packages.after`)}`, `LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} > ${quote(`${state}/packages.added`)} || true`
  ])
}

function writeCompose () {
  const compose = [
    'services:', '  db:', `    image: ${POSTGRES_IMAGE}`, '    restart: unless-stopped', `    env_file: ${CREDENTIALS}/credentials.env`, '    environment:', `      POSTGRES_DB: ${DATABASE}`, `      POSTGRES_USER: ${DATABASE_USER}`, '    volumes:', '      - postgres_data:/var/lib/postgresql/data', '    healthcheck:', `      test: ["CMD-SHELL", "pg_isready -U ${DATABASE_USER} -d ${DATABASE}"]`, '      interval: 5s', '      timeout: 5s', '      retries: 120', '      start_period: 20s',
    '  app:', `    image: ${MATTERMOST_IMAGE}`, '    restart: unless-stopped', `    env_file: ${CREDENTIALS}/credentials.env`, '    environment:', '      MM_SQLSETTINGS_DRIVERNAME: postgres', '      MM_SERVICESETTINGS_LISTENADDRESS: :8065', '      MM_FILESETTINGS_DIRECTORY: /mattermost/data', '      MM_LOGSETTINGS_ENABLEFILE: "false"', '      MM_LOGSETTINGS_ENABLECONSOLE: "true"', '    volumes:', '      - mattermost_config:/mattermost/config', '      - mattermost_data:/mattermost/data', '      - mattermost_logs:/mattermost/logs', '      - mattermost_plugins:/mattermost/plugins', '      - mattermost_client_plugins:/mattermost/client/plugins', '      - mattermost_bleve:/mattermost/bleve-indexes', '    depends_on:', '      db:', '        condition: service_healthy', '    healthcheck:', '      disable: true',
    '  nginx:', `    image: ${NGINX_IMAGE}`, '    restart: unless-stopped', '    ports:', `      - "${PORT}:${PORT}"`, '    volumes:', `      - ${SERVICE_ROOT}/nginx.conf:/etc/nginx/conf.d/default.conf:ro`, '    depends_on:', '      app:', '        condition: service_started',
    'volumes:', '  postgres_data:', '  mattermost_config:', '  mattermost_data:', '  mattermost_logs:', '  mattermost_plugins:', '  mattermost_client_plugins:', '  mattermost_bleve:'
  ].join('\n')
  const nginx = ['server {', `    listen ${PORT};`, '    server_name _;', '    location = / { default_type text/plain; return 200 "' + MARKER + '\\n"; }', '    location /api/ {', `        proxy_pass http://app:${APP_PORT};`, '        proxy_set_header Host $host;', '        proxy_set_header X-Real-IP $remote_addr;', '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;', '        proxy_set_header X-Forwarded-Proto $scheme;', '    }', '}'].join('\n')
  return join([
    'set -eu', `install -d -o root -g root -m 0755 ${quote(SERVICE_ROOT)}`, `password=$(cat ${quote(`${CREDENTIALS}/database_password`)})`,
    "primary=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (field=1; field<=NF; field++) if ($field == \"src\") { print $(field+1); exit }}' || true)", "[ -n \"$primary\" ] || primary=$(hostname -I 2>/dev/null | awk '{print $1}')", "case \"$primary\" in ''|*[!0-9a-fA-F:.]*) printf 'could not resolve a safe primary address\\n' >&2; exit 1;; esac",
    `umask 077; printf 'POSTGRES_PASSWORD=%s\\nMM_SQLSETTINGS_DATASOURCE=postgres://${DATABASE_USER}:%s@db:5432/${DATABASE}?sslmode=disable&connect_timeout=10\\nMM_SERVICESETTINGS_SITEURL=http://%s:${PORT}\\n' "$password" "$password" "$primary" > ${quote(`${CREDENTIALS}/credentials.env`)}`, `chmod 0600 ${quote(`${CREDENTIALS}/credentials.env`)}`,
    `printf '%s\\n' ${compose.split('\n').map(quote).join(' ')} > ${quote(`${SERVICE_ROOT}/compose.yaml`)}`, `chmod 0644 ${quote(`${SERVICE_ROOT}/compose.yaml`)}`,
    `printf '%s\\n' ${nginx.split('\n').map(quote).join(' ')} > ${quote(`${SERVICE_ROOT}/nginx.conf`)}`, `chmod 0644 ${quote(`${SERVICE_ROOT}/nginx.conf`)}`,
    `docker compose -p ${quote(PROJECT)} -f ${quote(`${SERVICE_ROOT}/compose.yaml`)} config --quiet`, 'printf \'%s\\n\' compose-ready'
  ])
}

function startCompose () {
  return join(['set -eu', `docker compose -p ${quote(PROJECT)} -f ${quote(`${SERVICE_ROOT}/compose.yaml`)} pull`, `docker compose -p ${quote(PROJECT)} -f ${quote(`${SERVICE_ROOT}/compose.yaml`)} up -d`, waitCompose('db'), waitMattermostApi(), `curl --fail --silent --show-error --max-time 5 http://127.0.0.1:${PORT}/ | grep -Fx ${quote(MARKER)}`])
}

function verifyCompose () {
  const compose = `docker compose -p ${quote(PROJECT)} -f ${quote(`${SERVICE_ROOT}/compose.yaml`)}`
  return join([
    'set -eu', waitCompose('db'), waitMattermostApi(), `${compose} exec -T app mattermost version | grep -F ${quote(VERSION)}`,
    `${compose} exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema=\\$\\$public\\$\\$"' | awk '$1 > 0 { ok=1 } END { exit !ok }'`,
    `curl --fail --silent --show-error --max-time 5 http://127.0.0.1:${PORT}/ | grep -Fx ${quote(MARKER)}`, `curl --fail --silent --show-error --max-time 5 http://127.0.0.1:${PORT}/api/v4/system/ping | grep -F 'OK'`,
    'printf \'%s\\n\' mattermost-verified'
  ])
}

function removeCompose (state) {
  const compose = `docker compose -p ${quote(PROJECT)} -f ${quote(`${SERVICE_ROOT}/compose.yaml`)}`
  const commands = ['set -eu', `[ -d ${quote(state)} ] || { printf '%s\\n' already-reverted; exit 0; }`, `if command -v docker >/dev/null 2>&1 && [ -f ${quote(`${SERVICE_ROOT}/compose.yaml`)} ]; then ${compose} down --volumes --remove-orphans || true; fi`]
  IMAGES.forEach((image, index) => commands.push(`if command -v docker >/dev/null 2>&1 && [ ! -e ${quote(`${state}/image-${index}.existed`)} ]; then docker image rm ${quote(image)} >/dev/null 2>&1 || true; fi`))
  return join(commands)
}

function restoreDocker (state) {
  return join([
    'set -eu', `[ -d ${quote(state)} ] || { printf '%s\\n' already-reverted; exit 0; }`, `if [ ! -e ${quote(`${state}/docker.existed`)} ]; then`, removeDebianPackages(`${state}/packages.added`),
    'rm -f /etc/apt/sources.list.d/docker.sources /etc/apt/keyrings/docker.asc', 'rm -rf -- /var/lib/docker /var/lib/containerd', 'fi',
    `if [ -e ${quote(`${state}/docker.active`)} ]; then systemctl start docker 2>/dev/null || true; else systemctl stop docker 2>/dev/null || true; fi`, `rm -rf -- ${quote(state)}`
  ])
}

function removeDebianPackages (list) {
  return `if [ -s ${quote(list)} ]; then packages=$(awk '{print $1}' ${quote(list)} | grep -Ev '^(netdata|openssh|curl|ca-certificates)(:|$)' | tr '\\n' ' '); [ -z "$packages" ] || DEBIAN_FRONTEND=noninteractive apt-get purge -y $packages || true; fi`
}

function waitUrl (url, attempts) {
  return `ready=; for attempt in $(seq 1 ${attempts}); do if curl --fail --silent --show-error --max-time 3 ${quote(url)} >/dev/null 2>&1; then ready=yes; break; fi; sleep 5; done; [ "$ready" = yes ]`
}

function waitCompose (service) {
  return `ready=; for attempt in $(seq 1 180); do status=$(docker inspect ${quote(`${PROJECT}-${service}-1`)} --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || true); [ "$status" = healthy ] && ready=yes && break; sleep 5; done; [ "$ready" = yes ]`
}

function waitMattermostApi () {
  return `ready=; for attempt in $(seq 1 180); do if curl --fail --silent --max-time 5 http://127.0.0.1:${PORT}/api/v4/system/ping | grep -F 'OK' >/dev/null; then ready=yes; break; fi; sleep 5; done; [ "$ready" = yes ]`
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
