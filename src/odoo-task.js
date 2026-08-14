const VERSION = '19.0.20260810'
const SERIES = '19.0'
const PORT = 18112
const APP_PORT = 8069
const MARKER = 'WEBMINAI_ODOO_OK'
const SERVICE = 'webminai-odoo-18112'
const DATA_ROOT = '/var/lib/webminai-odoo-18112'
const CREDENTIALS = '/root/odoo_credentials'
const SERVICE_ROOT = '/opt/webminai/services/odoo'
const PROJECT = 'webminai-odoo-18112'
const DATABASE = 'webminai_odoo_18112'
const DATABASE_USER = 'webminai_odoo'
const DEB = `odoo_${VERSION}_all.deb`
const DEB_URL = `https://nightly.odoo.com/${SERIES}/nightly/deb/${DEB}`
const DEB_SHA256 = 'c6b65878756626cd890161e70d0a214604f7a032418558755f6ce62a8a263984'
const RPM = `odoo_${VERSION}.rpm`
const RPM_URL = `https://nightly.odoo.com/${SERIES}/nightly/rpm/${RPM}`
const RPM_SHA256 = 'fa2978cbaf1c2eef86125c602e118a61c7e23bd2c36c89151ee340ee0d500d88'
const ODOO_IMAGE = 'odoo@sha256:4872f23288454b724fd2d26c176a418276c2b3552e9aa752f9396b59d864b3a0'
const POSTGRES_IMAGE = 'postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94'
const NGINX_IMAGE = 'nginx@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46'
const IMAGES = [ODOO_IMAGE, POSTGRES_IMAGE, NGINX_IMAGE]
const DPKG_PACKAGE_FORMAT = '$' + '{binary:Package} $' + '{Version}\\n'
const DOCKER_CODENAME_FALLBACK = '$' + '{UBUNTU_CODENAME:-$VERSION_CODENAME}'

export function buildOdooTask (taskId, linuxContext, docker = {}) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  if (!linuxContext?.identity || !linuxContext?.management) throw new TypeError('Odoo task requires a Linux host context')
  if (docker.preferred === true) return buildComposeTask(taskId, linuxContext, docker)
  if (linuxContext.identity.id === 'ubuntu') return buildNativeTask(taskId, linuxContext, nativeProfile('debian'))
  return buildCompatibilityTask(taskId, linuxContext)
}

export function odooRelease () {
  return Object.freeze({ version: VERSION, debSha256: DEB_SHA256, rpmSha256: RPM_SHA256, images: Object.freeze([...IMAGES]) })
}

function buildCompatibilityTask (taskId, context) {
  const state = `/var/lib/webminai/task-state/${taskId}-odoo-compatibility`
  const identity = context.identity
  const detail = identity.id === 'fedora'
    ? `the current official RPM requires Python 3.13 distribution dependencies that Fedora ${identity.versionId ?? ''} cannot satisfy from its enabled repositories`
    : identity.id === 'debian'
      ? `the current official DEB requires python3-pypdf2, which Debian ${identity.versionId ?? ''} no longer provides`
      : 'Odoo publishes reviewed Linux packages for Debian, Ubuntu, and Fedora, but not this distribution'
  const reason = `Odoo ${SERIES} is not promoted natively on ${identity.id} ${identity.versionId ?? ''}: ${detail}, and automatic Docker is disabled for container hosts.`
  return envelope({
    context,
    route: 'no-change-incompatible',
    overview: `Record a no-change Odoo Community compatibility result for ${identity.id} ${identity.versionId ?? ''}.`,
    files: [state, `${state}/report.txt`],
    commands: [item('record-compatibility', 'preflight', join(['set -eu', ...ownedAbsent(), `install -d -o root -g root -m 0700 ${quote(state)}`, `printf '%s\\n' ${quote(reason)} > ${quote(`${state}/report.txt`)}`, `chmod 0600 ${quote(`${state}/report.txt`)}`]), 'Record the reviewed no-change compatibility result without installing an unsupported package')],
    revertCommands: [item('remove-compatibility-report', 'cleanup', `set -eu; rm -rf -- ${quote(state)}; printf '%s\\n' compatibility-report-removed`, 'Remove only the task-owned compatibility report', [], 30000, undefined, 'destructive')],
    verifyApplied: `test -s ${quote(`${state}/report.txt`)} && grep -Fq 'not promoted natively' ${quote(`${state}/report.txt`)} && test ! -e ${quote(DATA_ROOT)} && test ! -e ${quote(CREDENTIALS)}`,
    verifyReverted: `test ! -e ${quote(state)}`
  })
}

function buildNativeTask (taskId, context, profile) {
  const state = `/var/lib/webminai/task-state/${taskId}-odoo-linux`
  const paths = nativePaths(profile)
  const commands = [
    item('capture-baseline', 'baseline', nativeBaseline(state, paths, profile), 'Capture packages, PostgreSQL, nginx, and Odoo package state exactly once'),
    item('install-foundation', 'packages', nativeFoundation(state, profile), `Install nginx and PostgreSQL 13+ through the reviewed ${profile.family} route`, ['capture-baseline'], 1200000, 'job'),
    item('generate-credentials', 'secrets', credentialsCommand(), 'Generate database and master passwords on-host without emitting them', ['capture-baseline']),
    item('install-odoo', 'acquire', nativeAcquire(state, profile), `Download, checksum, and install the official Odoo Community ${VERSION} package`, ['install-foundation'], 1800000, 'job'),
    item('initialize-database', 'database', nativeDatabase(profile), 'Create the isolated PostgreSQL role with a protected generated password', ['install-foundation', 'generate-credentials']),
    item('configure-odoo', 'configure', nativeConfigure(taskId, state, paths, profile), 'Create the protected Odoo configuration, initialize its database through systemd credentials, and install systemd and nginx definitions', ['install-odoo', 'initialize-database'], 1800000, 'job'),
    item('verify-odoo', 'verify', nativeVerify(profile), 'Verify Odoo HTTP, PostgreSQL schema, data storage, version, and restart recovery', ['configure-odoo'], 1200000, 'job')
  ]
  const revertCommands = [
    item('stop-odoo', 'cleanup', nativeStop(paths), 'Stop and remove only task-owned Odoo and nginx services', [], 300000, undefined, 'destructive'),
    item('drop-database', 'cleanup', nativeDropDatabase(profile), 'Drop only the task-owned PostgreSQL database and role', ['stop-odoo'], 300000, undefined, 'destructive'),
    item('remove-odoo-files', 'cleanup', `set -eu; rm -rf -- ${quote(DATA_ROOT)} ${quote(CREDENTIALS)} /etc/odoo /var/lib/odoo`, 'Remove task-owned Odoo package configuration, data, and credentials', ['drop-database'], 300000, undefined, 'destructive'),
    item('restore-stack', 'cleanup', nativeRestore(state, profile), 'Restore package, service, cluster, and authentication state from the factual baseline', ['remove-odoo-files'], 1200000, 'job', 'destructive')
  ]
  return envelope({
    context,
    route: `native-${profile.family}-package`,
    overview: `Deploy Odoo Community ${VERSION} with PostgreSQL, systemd, and nginx on port ${PORT}.`,
    files: [state, DATA_ROOT, CREDENTIALS, '/etc/odoo', '/var/lib/odoo', paths.serviceFile, paths.bootstrapFile, paths.nginxVhost, ...(paths.nginxEnableLink ? [paths.nginxEnableLink] : []), ...(profile.hba ? [profile.hba] : [])],
    commands,
    revertCommands,
    verifyApplied: nativeVerify(profile),
    verifyReverted: `test ! -e ${quote(DATA_ROOT)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)} && test ! -e ${quote(paths.serviceFile)} && test ! -e ${quote(paths.bootstrapFile)} && test ! -e ${quote(paths.nginxVhost)}`
  })
}

function buildComposeTask (taskId, context, docker) {
  if (!docker.ready && docker.installMethod !== 'official-apt') throw new Error('learned Odoo Compose setup requires Docker ready or the reviewed official apt route')
  const state = `/var/lib/webminai/task-state/${taskId}-odoo-compose`
  const commands = [
    item('capture-baseline', 'baseline', composeBaseline(state), 'Capture Docker, image, service, and task path state exactly once'),
    item('prepare-docker', 'packages', prepareDocker(state), 'Install Docker and Compose only when the reviewed host route requires them', ['capture-baseline'], 900000, 'job'),
    item('generate-credentials', 'secrets', credentialsCommand(), 'Generate PostgreSQL and Odoo master credentials on-host without emitting them', ['capture-baseline']),
    item('write-compose', 'configure', writeCompose(), 'Write the digest-pinned Odoo, PostgreSQL, and nginx Compose project', ['prepare-docker', 'generate-credentials']),
    item('start-compose', 'services', startCompose(), 'Initialize the Odoo database and start the persistent Compose services', ['write-compose'], 2700000, 'job'),
    item('verify-compose', 'verify', verifyCompose(), 'Verify Odoo version, web client, PostgreSQL persistence, marker, and restart recovery', ['start-compose'], 1200000, 'job')
  ]
  const revertCommands = [
    item('remove-compose-project', 'cleanup', removeCompose(state), 'Remove only task-owned containers, volumes, network, and newly pulled images', [], 1200000, 'job', 'destructive'),
    item('remove-compose-files', 'cleanup', `set -eu; rm -rf -- ${quote(SERVICE_ROOT)} ${quote(CREDENTIALS)}`, 'Remove task-owned Compose files and credentials', ['remove-compose-project'], 300000, undefined, 'destructive'),
    item('restore-docker', 'cleanup', restoreDocker(state), 'Restore Docker packages and service state when introduced by this task', ['remove-compose-files'], 900000, 'job', 'destructive')
  ]
  return envelope({
    context,
    route: 'compose-postgresql',
    overview: `Deploy official Odoo Community ${SERIES}, PostgreSQL 17, and nginx through digest-pinned Compose on port ${PORT}.`,
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
      summary: route === 'no-change-incompatible' ? 'Record Odoo Community compatibility result' : `Deploy a learned reversible ${route.startsWith('compose') ? 'Odoo Compose' : 'native Odoo'} service`,
      changeOverview: overview,
      modifiedFiles: files,
      assumptions: [
        `Authoritative Linux profile: ${identity.id} ${identity.versionId ?? ''}`.trim(),
        `Resolved Odoo matrix: Community ${SERIES}, Python 3.10+, PostgreSQL 13+, and 64-bit Linux.`,
        'Database and master credentials are generated on-host and only protected paths enter plans and logs.'
      ],
      warnings: route === 'no-change-incompatible'
        ? ['No application is installed because this host lacks an upstream-packaged native route and automatic Docker is disabled for container hosts.']
        : [`This controlled validation publishes TCP port ${PORT} through nginx and does not configure public DNS, TLS, SMTP, workers, or production sizing.`],
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
    application: { id: 'odoo', version: VERSION },
    host: { fingerprint: context.fingerprint, distribution: context.identity.id, distributionVersion: context.identity.versionId, architecture: context.identity.architecture, family: context.management.family },
    selectedRoute: { id: route, status: supported ? 'supported' : 'unsupported' },
    components: [
      { profileId: 'odoo', selectedVersion: VERSION, source: route.startsWith('compose') ? 'official-container-image' : supported ? 'official-distribution-package' : 'unavailable', status: supported ? 'supported' : 'unavailable' },
      { profileId: 'postgresql', selectedVersion: route.startsWith('compose') ? '17' : '13+', source: route.startsWith('compose') ? 'official-container-image' : 'distribution-package', status: supported ? 'supported' : 'not-selected' },
      { profileId: 'nginx', selectedVersion: 'distribution-or-image', source: 'reviewed-profile', status: supported ? 'supported' : 'not-selected' }
    ]
  }
}

function nativeProfile (family) {
  if (family === 'debian') return { family, service: 'postgresql', dataRoot: '/var/lib/postgresql', package: DEB, packageUrl: DEB_URL, packageSha256: DEB_SHA256 }
  return { family, service: 'postgresql', dataRoot: '/var/lib/pgsql', hba: '/var/lib/pgsql/data/pg_hba.conf', package: RPM, packageUrl: RPM_URL, packageSha256: RPM_SHA256 }
}

function nativePaths (profile) {
  return profile.family === 'debian'
    ? { serviceFile: `/etc/systemd/system/${SERVICE}.service`, bootstrapFile: `/etc/systemd/system/${SERVICE}-bootstrap.service`, nginxVhost: `/etc/nginx/sites-available/${SERVICE}.conf`, nginxEnableLink: `/etc/nginx/sites-enabled/${SERVICE}.conf` }
    : { serviceFile: `/etc/systemd/system/${SERVICE}.service`, bootstrapFile: `/etc/systemd/system/${SERVICE}-bootstrap.service`, nginxVhost: `/etc/nginx/conf.d/${SERVICE}.conf`, nginxEnableLink: null }
}

function ownedAbsent () {
  return [DATA_ROOT, CREDENTIALS, SERVICE_ROOT].map(path => `test ! -e ${quote(path)}`)
}

function nativeBaseline (state, paths, profile) {
  const owned = [DATA_ROOT, CREDENTIALS, '/etc/odoo', '/var/lib/odoo', paths.serviceFile, paths.bootstrapFile, paths.nginxVhost, ...(paths.nginxEnableLink ? [paths.nginxEnableLink] : [])]
  const packages = profile.family === 'debian'
    ? `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(`${state}/packages.before`)}`
    : `rpm -qa --qf '%{NAME}\\n' | LC_ALL=C sort -u > ${quote(`${state}/packages.before`)}`
  return join([
    'set -eu', `if [ ! -s ${quote(`${state}/packages.before`)} ]; then`, ...owned.map(path => `test ! -e ${quote(path)}`), '! command -v odoo >/dev/null 2>&1',
    `install -d -o root -g root -m 0700 ${quote(state)}`, packages,
    `systemctl is-active --quiet nginx 2>/dev/null && : > ${quote(`${state}/nginx.active`)} || true`, `systemctl is-enabled --quiet nginx 2>/dev/null && : > ${quote(`${state}/nginx.enabled`)} || true`,
    `systemctl is-active --quiet ${quote(profile.service)} 2>/dev/null && : > ${quote(`${state}/postgres.active`)} || true`, `systemctl is-enabled --quiet ${quote(profile.service)} 2>/dev/null && : > ${quote(`${state}/postgres.enabled`)} || true`,
    `[ -e ${quote(profile.dataRoot)} ] && : > ${quote(`${state}/postgres-data.existed`)} || true`,
    ...(profile.family === 'debian' ? [`if command -v pg_lsclusters >/dev/null 2>&1; then pg_lsclusters --no-header 2>/dev/null | awk '$2 == "main" { print $1; exit }' > ${quote(`${state}/postgres-cluster.before`)}; [ -s ${quote(`${state}/postgres-cluster.before`)} ] || rm -f ${quote(`${state}/postgres-cluster.before`)}; fi`] : [`[ ! -f ${quote(profile.hba)} ] || cp -a -- ${quote(profile.hba)} ${quote(`${state}/postgres-hba.before`)}`]),
    'fi', 'printf \'%s\\n\' baseline-ready'
  ])
}

function nativeFoundation (state, profile) {
  if (profile.family === 'debian') {
    return join([
      'set -eu', 'export DEBIAN_FRONTEND=noninteractive', 'apt-get update', 'apt-get install -y ca-certificates curl nginx postgresql postgresql-client openssl',
      'major=$(pg_config --version | awk \'{ split($2, version, "."); print version[1] }\'); [ "$major" -ge 13 ]',
      'if ! pg_lsclusters --no-header 2>/dev/null | awk -v major="$major" \'$1 == major && $2 == "main" { found=1 } END { exit !found }\'; then pg_createcluster "$major" main --start; else pg_ctlcluster "$major" main start; fi',
      `if [ ! -s ${quote(`${state}/postgres-cluster.before`)} ]; then printf '%s\\n' "$major" > ${quote(`${state}/postgres-cluster.created`)}; fi`,
      'systemctl enable postgresql', 'systemctl enable --now nginx'
    ])
  }
  return join([
    'set -eu', 'dnf install -y ca-certificates curl nginx postgresql-server postgresql openssl',
    'postgres --version | awk \'{ split($3, version, "."); exit !(version[1] >= 13) }\'',
    `if [ ! -s ${quote(`${profile.dataRoot}/data/PG_VERSION`)} ]; then postgresql-setup --initdb; fi`,
    `rule='host ${DATABASE} ${DATABASE_USER} 127.0.0.1/32 scram-sha-256'; if ! grep -Fqx "$rule" ${quote(profile.hba)}; then { printf '%s\\n' "$rule"; cat ${quote(profile.hba)}; } > ${quote(`${profile.hba}.webminai-new`)}; chown postgres:postgres ${quote(`${profile.hba}.webminai-new`)}; chmod 0600 ${quote(`${profile.hba}.webminai-new`)}; mv ${quote(`${profile.hba}.webminai-new`)} ${quote(profile.hba)}; fi`,
    'systemctl enable --now postgresql', 'systemctl enable --now nginx'
  ])
}

function credentialsCommand () {
  return join([
    'set -eu', 'umask 077', `install -d -o root -g root -m 0700 ${quote(CREDENTIALS)}`,
    `[ -s ${quote(`${CREDENTIALS}/database_password`)} ] || openssl rand -hex 32 > ${quote(`${CREDENTIALS}/database_password`)}`,
    `[ -s ${quote(`${CREDENTIALS}/admin_password`)} ] || openssl rand -hex 32 > ${quote(`${CREDENTIALS}/admin_password`)}`,
    `chmod 0600 ${quote(`${CREDENTIALS}/database_password`)} ${quote(`${CREDENTIALS}/admin_password`)}`, `printf '%s\\n' ${quote(CREDENTIALS)}`
  ])
}

function nativeAcquire (state, profile) {
  const artifact = `${state}/${profile.package}`
  const install = profile.family === 'debian'
    ? `DEBIAN_FRONTEND=noninteractive apt-get install -y ${quote(artifact)}`
    : `dnf install -y ${quote(artifact)}`
  const snapshot = profile.family === 'debian'
    ? `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(`${state}/packages.after`)}`
    : `rpm -qa --qf '%{NAME}\\n' | LC_ALL=C sort -u > ${quote(`${state}/packages.after`)}`
  return join([
    'set -eu', `if ! command -v odoo >/dev/null 2>&1; then curl --fail --location --retry 5 --retry-delay 2 --silent --show-error --output ${quote(artifact)} ${quote(profile.packageUrl)}`, `printf '%s  %s\\n' ${quote(profile.packageSha256)} ${quote(artifact)} | sha256sum -c -`, install, 'fi',
    'command -v odoo >/dev/null', 'systemctl disable --now odoo 2>/dev/null || true', snapshot, `LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} > ${quote(`${state}/packages.added`)} || true`, `odoo --version | grep -F ${quote(SERIES)}`
  ])
}

function nativeDatabase (profile) {
  return join([
    'set -eu', `systemctl start ${quote(profile.service)}`, 'ready=', 'for attempt in $(seq 1 60); do runuser -u postgres -- psql -Atqc \'SELECT 1\' postgres >/dev/null 2>&1 && ready=yes && break; sleep 2; done', '[ "$ready" = yes ]',
    `password=$(cat ${quote(`${CREDENTIALS}/database_password`)})`, `runuser -u postgres -- psql -Atqc "SELECT 1 FROM pg_roles WHERE rolname='${DATABASE_USER}'" postgres | grep -Fx 1 || runuser -u postgres -- createuser --login --createdb ${quote(DATABASE_USER)}`,
    `runuser -u postgres -- psql -v ON_ERROR_STOP=1 -v password="$password" postgres <<'SQL'
ALTER ROLE ${DATABASE_USER} WITH LOGIN CREATEDB PASSWORD :'password';
SQL
:`, 'printf \'%s\\n\' role-ready'
  ])
}

function nativeConfigure (taskId, state, paths, profile) {
  const unit = ['[Unit]', 'Description=Intent AI Ops Odoo Community validation service', `After=network-online.target ${profile.service}.service`, 'Wants=network-online.target', `Requires=${profile.service}.service`, '', '[Service]', 'Type=simple', 'User=odoo', 'Group=odoo', `Environment=HOME=${DATA_ROOT}`, `LoadCredential=odoo.conf:${CREDENTIALS}/odoo.conf`, 'ExecStart=/usr/bin/odoo --config=%d/odoo.conf', 'Restart=on-failure', 'RestartSec=5', 'NoNewPrivileges=true', 'PrivateTmp=true', '', '[Install]', 'WantedBy=multi-user.target'].join('\n')
  const bootstrap = ['[Unit]', 'Description=Intent AI Ops Odoo Community database bootstrap', `After=${profile.service}.service`, `Requires=${profile.service}.service`, '', '[Service]', 'Type=oneshot', 'User=odoo', 'Group=odoo', `Environment=HOME=${DATA_ROOT}`, `LoadCredential=odoo.conf:${CREDENTIALS}/odoo.conf`, `ExecStart=/usr/bin/odoo --config=%d/odoo.conf -d ${DATABASE} -i base --without-demo=all --stop-after-init`, 'NoNewPrivileges=true', 'PrivateTmp=true'].join('\n')
  const nginx = ['server {', `    listen ${PORT};`, '    server_name _;', '    location = / { default_type text/plain; return 200 "' + MARKER + '\\n"; }', '    location /web/ {', `        proxy_pass http://127.0.0.1:${APP_PORT};`, '        proxy_set_header Host $host;', '        proxy_set_header X-Real-IP $remote_addr;', '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;', '        proxy_set_header X-Forwarded-Proto $scheme;', '    }', '}'].join('\n')
  return join([
    'set -eu', 'id odoo >/dev/null 2>&1', `install -d -o odoo -g odoo -m 0750 ${quote(DATA_ROOT)} ${quote(`${DATA_ROOT}/data`)} ${quote(`${DATA_ROOT}/addons`)}`,
    `password=$(cat ${quote(`${CREDENTIALS}/database_password`)})`, `admin=$(cat ${quote(`${CREDENTIALS}/admin_password`)})`, `chgrp odoo ${quote(CREDENTIALS)}`, `chmod 0710 ${quote(CREDENTIALS)}`,
    `umask 077; printf '%s\\n' '[options]' "admin_passwd = $admin" 'db_host = 127.0.0.1' 'db_port = 5432' 'db_user = ${DATABASE_USER}' "db_password = $password" 'db_name = ${DATABASE}' 'dbfilter = ^${DATABASE}$' 'list_db = False' 'proxy_mode = True' 'http_interface = 127.0.0.1' 'http_port = ${APP_PORT}' 'data_dir = ${DATA_ROOT}/data' > ${quote(`${CREDENTIALS}/odoo.conf`)}`,
    `chown root:odoo ${quote(`${CREDENTIALS}/odoo.conf`)}`, `chmod 0640 ${quote(`${CREDENTIALS}/odoo.conf`)}`,
    `printf '%s\\n' ${unit.split('\n').map(quote).join(' ')} > ${quote(paths.serviceFile)}`, `chmod 0644 ${quote(paths.serviceFile)}`, `printf '%s\\n' ${bootstrap.split('\n').map(quote).join(' ')} > ${quote(paths.bootstrapFile)}`, `chmod 0644 ${quote(paths.bootstrapFile)}`, `printf '%s\\n' ${nginx.split('\n').map(quote).join(' ')} > ${quote(paths.nginxVhost)}`, `chmod 0644 ${quote(paths.nginxVhost)}`,
    ...(paths.nginxEnableLink ? [`ln -sfn ${quote(paths.nginxVhost)} ${quote(paths.nginxEnableLink)}`] : []),
    'systemctl daemon-reload', `if ! systemctl start ${quote(`${SERVICE}-bootstrap.service`)}; then journalctl -u ${quote(`${SERVICE}-bootstrap.service`)} --no-pager -n 80; exit 1; fi`, `rm -f -- ${quote(paths.bootstrapFile)}`, 'systemctl daemon-reload', `systemctl enable --now ${quote(SERVICE)}`, 'nginx -t', 'systemctl reload nginx', `printf '%s\\n' ${quote(`configured-task-${taskId}`)}`
  ])
}

function nativeVerify (profile) {
  return join([
    'set -eu', waitUrl(`http://127.0.0.1:${APP_PORT}/web/login?db=${DATABASE}`, 180), `odoo --version | grep -F ${quote(SERIES)}`, `password=$(cat ${quote(`${CREDENTIALS}/database_password`)})`,
    `PGPASSWORD="$password" psql -h 127.0.0.1 -U ${quote(DATABASE_USER)} -d ${quote(DATABASE)} -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" | awk '$1 > 0 { ok=1 } END { exit !ok }'`, `test -d ${quote(`${DATA_ROOT}/data`)}`,
    `curl --fail --silent --show-error --max-time 5 http://127.0.0.1:${PORT}/ | grep -Fx ${quote(MARKER)}`, `curl --fail --silent --show-error --max-time 5 'http://127.0.0.1:${PORT}/web/login?db=${DATABASE}' | grep -F 'Odoo'`,
    `systemctl restart ${quote(SERVICE)}`, waitUrl(`http://127.0.0.1:${APP_PORT}/web/login?db=${DATABASE}`, 180), `systemctl is-active --quiet ${quote(profile.service)}`, 'printf \'%s\\n\' odoo-verified'
  ])
}

function nativeStop (paths) {
  return join([
    'set -eu', `systemctl disable --now ${quote(SERVICE)} 2>/dev/null || true`, `systemctl stop ${quote(`${SERVICE}-bootstrap.service`)} 2>/dev/null || true`, 'systemctl disable --now odoo 2>/dev/null || true', `rm -f -- ${quote(paths.serviceFile)} ${quote(paths.bootstrapFile)}`, 'systemctl daemon-reload', `rm -f -- ${quote(paths.nginxVhost)}`, ...(paths.nginxEnableLink ? [`rm -f -- ${quote(paths.nginxEnableLink)}`] : []),
    'if command -v nginx >/dev/null 2>&1; then nginx -t', 'systemctl is-active --quiet nginx && systemctl reload nginx || true', 'fi'
  ])
}

function nativeDropDatabase (profile) {
  return join([
    'set -eu', 'if command -v psql >/dev/null 2>&1 && runuser -u postgres -- psql -Atqc \'SELECT 1\' postgres >/dev/null 2>&1; then', `runuser -u postgres -- psql -v ON_ERROR_STOP=1 postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DATABASE}' AND pid <> pg_backend_pid();" >/dev/null`, `runuser -u postgres -- dropdb --if-exists ${quote(DATABASE)}`, `runuser -u postgres -- dropuser --if-exists ${quote(DATABASE_USER)}`, 'fi', 'printf \'%s\\n\' database-removed'
  ])
}

function nativeRestore (state, profile) {
  const commands = ['set -eu', `[ -d ${quote(state)} ] || { printf '%s\\n' already-reverted; exit 0; }`]
  if (profile.family === 'debian') {
    commands.push(`if [ -s ${quote(`${state}/postgres-cluster.created`)} ]; then major=$(sed -n '1p' ${quote(`${state}/postgres-cluster.created`)}); case "$major" in ''|*[!0-9]*) exit 1;; esac; command -v pg_dropcluster >/dev/null 2>&1 && pg_dropcluster --stop "$major" main || true; fi`)
    commands.push(removeDebianPackages(`${state}/packages.added`))
  } else {
    commands.push(`if [ -f ${quote(`${state}/postgres-hba.before`)} ]; then cp -a -- ${quote(`${state}/postgres-hba.before`)} ${quote(profile.hba)}; elif [ -f ${quote(profile.hba)} ]; then rule='host ${DATABASE} ${DATABASE_USER} 127.0.0.1/32 scram-sha-256'; awk -v rule="$rule" '$0 != rule' ${quote(profile.hba)} > ${quote(`${profile.hba}.webminai-new`)}; chown postgres:postgres ${quote(`${profile.hba}.webminai-new`)}; chmod 0600 ${quote(`${profile.hba}.webminai-new`)}; mv ${quote(`${profile.hba}.webminai-new`)} ${quote(profile.hba)}; fi`)
    commands.push(`if [ -s ${quote(`${state}/packages.added`)} ]; then packages=$(grep -Ev '^(netdata|openssh|curl|ca-certificates)$' ${quote(`${state}/packages.added`)} | tr '\\n' ' '); [ -z "$packages" ] || dnf remove -y $packages || true; fi`)
  }
  commands.push(`if [ ! -e ${quote(`${state}/postgres-data.existed`)} ]; then rm -rf -- ${quote(profile.dataRoot)}; fi`)
  commands.push(`if [ -e ${quote(`${state}/nginx.enabled`)} ]; then systemctl enable nginx >/dev/null 2>&1 || true; else systemctl disable nginx >/dev/null 2>&1 || true; fi`, `if [ -e ${quote(`${state}/nginx.active`)} ]; then systemctl start nginx; else systemctl stop nginx 2>/dev/null || true; fi`)
  commands.push(`if [ -e ${quote(`${state}/postgres.enabled`)} ]; then systemctl enable ${quote(profile.service)} >/dev/null 2>&1 || true; else systemctl disable ${quote(profile.service)} >/dev/null 2>&1 || true; fi`, `if [ -e ${quote(`${state}/postgres.active`)} ]; then systemctl start ${quote(profile.service)}; else systemctl stop ${quote(profile.service)} 2>/dev/null || true; fi`, `rm -rf -- ${quote(state)}`)
  return join(commands)
}

function composeBaseline (state) {
  return join([
    'set -eu', `if [ ! -s ${quote(`${state}/packages.before`)} ]; then`, `test ! -e ${quote(SERVICE_ROOT)}`, `test ! -e ${quote(CREDENTIALS)}`, `install -d -o root -g root -m 0700 ${quote(state)}`, `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(`${state}/packages.before`)}`,
    `systemctl is-active --quiet docker 2>/dev/null && : > ${quote(`${state}/docker.active`)} || true`, `command -v docker >/dev/null 2>&1 && : > ${quote(`${state}/docker.existed`)} || true`, ...IMAGES.map((image, index) => `docker image inspect ${quote(image)} >/dev/null 2>&1 && : > ${quote(`${state}/image-${index}.existed`)} || true`), 'fi', 'printf \'%s\\n\' baseline-ready'
  ])
}

function prepareDocker (state) {
  return join([
    'set -eu', 'if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then :; else', `[ ! -e ${quote(`${state}/docker.existed`)} ]`, 'export DEBIAN_FRONTEND=noninteractive', 'apt-get update', 'apt-get install -y ca-certificates curl', 'install -d -m 0755 /etc/apt/keyrings', 'curl --fail --location --silent --show-error https://download.docker.com/linux/ubuntu/gpg --output /etc/apt/keyrings/docker.asc', 'chmod 0644 /etc/apt/keyrings/docker.asc', '. /etc/os-release', `arch=$(dpkg --print-architecture); codename=${DOCKER_CODENAME_FALLBACK}`, 'printf \'%s\\n\' \'Types: deb\' \'URIs: https://download.docker.com/linux/ubuntu\' "Suites: $codename" \'Components: stable\' "Architectures: $arch" \'Signed-By: /etc/apt/keyrings/docker.asc\' > /etc/apt/sources.list.d/docker.sources', 'apt-get update', 'apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin', 'systemctl start docker', 'fi',
    'docker info >/dev/null', 'docker compose version >/dev/null', `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(`${state}/packages.after`)}`, `LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} > ${quote(`${state}/packages.added`)} || true`
  ])
}

function writeCompose () {
  const compose = [
    'services:', '  db:', `    image: ${POSTGRES_IMAGE}`, '    restart: unless-stopped', '    environment:', `      POSTGRES_DB: ${DATABASE}`, `      POSTGRES_USER: ${DATABASE_USER}`, '      POSTGRES_PASSWORD_FILE: /run/secrets/database_password', '    secrets:', '      - database_password', '    volumes:', '      - postgres_data:/var/lib/postgresql/data', '    healthcheck:', `      test: ["CMD-SHELL", "pg_isready -U ${DATABASE_USER} -d ${DATABASE}"]`, '      interval: 5s', '      timeout: 5s', '      retries: 120', '      start_period: 20s',
    '  init-config:', `    image: ${ODOO_IMAGE}`, '    user: "0"', '    entrypoint: ["/bin/bash", "-ec"]', '    command:', '      - |', '        umask 077', '        admin=$$(cat /run/secrets/admin_password)', '        password=$$(cat /run/secrets/database_password)', '        printf "%s\\n" "[options]" "admin_passwd = $$admin" "db_host = db" "db_port = 5432" "db_user = ' + DATABASE_USER + '" "db_password = $$password" "db_name = ' + DATABASE + '" "dbfilter = ^' + DATABASE + '$$" "list_db = False" "proxy_mode = True" "http_interface = 0.0.0.0" "http_port = ' + APP_PORT + '" "data_dir = /var/lib/odoo" > /etc/odoo/odoo.conf', '        chown odoo:odoo /etc/odoo/odoo.conf', '        chmod 0600 /etc/odoo/odoo.conf', '    secrets:', '      - admin_password', '      - database_password', '    volumes:', '      - odoo_config:/etc/odoo',
    '  app:', `    image: ${ODOO_IMAGE}`, '    restart: unless-stopped', '    volumes:', '      - odoo_config:/etc/odoo', '      - odoo_data:/var/lib/odoo', '      - odoo_addons:/mnt/extra-addons', '    depends_on:', '      db:', '        condition: service_healthy', '      init-config:', '        condition: service_completed_successfully',
    '  nginx:', `    image: ${NGINX_IMAGE}`, '    restart: unless-stopped', '    ports:', `      - "${PORT}:${PORT}"`, '    volumes:', `      - ${SERVICE_ROOT}/nginx.conf:/etc/nginx/conf.d/default.conf:ro`, '    depends_on:', '      app:', '        condition: service_started',
    'secrets:', '  database_password:', `    file: ${CREDENTIALS}/database_password`, '  admin_password:', `    file: ${CREDENTIALS}/admin_password`,
    'volumes:', '  postgres_data:', '  odoo_config:', '  odoo_data:', '  odoo_addons:'
  ].join('\n')
  const nginx = ['server {', `    listen ${PORT};`, '    server_name _;', '    location = / { default_type text/plain; return 200 "' + MARKER + '\\n"; }', '    location /web/ {', `        proxy_pass http://app:${APP_PORT};`, '        proxy_set_header Host $host;', '        proxy_set_header X-Real-IP $remote_addr;', '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;', '        proxy_set_header X-Forwarded-Proto $scheme;', '    }', '}'].join('\n')
  return join([
    'set -eu', `install -d -o root -g root -m 0755 ${quote(SERVICE_ROOT)}`, `printf '%s\\n' ${compose.split('\n').map(quote).join(' ')} > ${quote(`${SERVICE_ROOT}/compose.yaml`)}`, `chmod 0644 ${quote(`${SERVICE_ROOT}/compose.yaml`)}`, `printf '%s\\n' ${nginx.split('\n').map(quote).join(' ')} > ${quote(`${SERVICE_ROOT}/nginx.conf`)}`, `chmod 0644 ${quote(`${SERVICE_ROOT}/nginx.conf`)}`, `docker compose -p ${quote(PROJECT)} -f ${quote(`${SERVICE_ROOT}/compose.yaml`)} config --quiet`, 'printf \'%s\\n\' compose-ready'
  ])
}

function startCompose () {
  const compose = `docker compose -p ${quote(PROJECT)} -f ${quote(`${SERVICE_ROOT}/compose.yaml`)}`
  return join([
    'set -eu', `${compose} pull`, `${compose} up -d db`, waitCompose('db'), `${compose} run --rm app odoo -d ${quote(DATABASE)} -i base --without-demo=all --stop-after-init`, `${compose} up -d`, waitOdoo(), `curl --fail --silent --show-error --max-time 5 http://127.0.0.1:${PORT}/ | grep -Fx ${quote(MARKER)}`
  ])
}

function verifyCompose () {
  const compose = `docker compose -p ${quote(PROJECT)} -f ${quote(`${SERVICE_ROOT}/compose.yaml`)}`
  return join([
    'set -eu', waitCompose('db'), waitOdoo(), `${compose} exec -T app odoo --version | grep -F ${quote(SERIES)}`, `${compose} exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema=\\$\\$public\\$\\$"' | awk '$1 > 0 { ok=1 } END { exit !ok }'`,
    `curl --fail --silent --show-error --max-time 5 http://127.0.0.1:${PORT}/ | grep -Fx ${quote(MARKER)}`, `curl --fail --silent --show-error --max-time 5 'http://127.0.0.1:${PORT}/web/login?db=${DATABASE}' | grep -F 'Odoo'`, 'printf \'%s\\n\' odoo-verified'
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
    'set -eu', `[ -d ${quote(state)} ] || { printf '%s\\n' already-reverted; exit 0; }`, `if [ ! -e ${quote(`${state}/docker.existed`)} ]; then`, removeDebianPackages(`${state}/packages.added`), 'rm -f /etc/apt/sources.list.d/docker.sources /etc/apt/keyrings/docker.asc', 'rm -rf -- /var/lib/docker /var/lib/containerd', 'fi', `if [ -e ${quote(`${state}/docker.active`)} ]; then systemctl start docker 2>/dev/null || true; else systemctl stop docker 2>/dev/null || true; fi`, `rm -rf -- ${quote(state)}`
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

function waitOdoo () {
  return `ready=; for attempt in $(seq 1 180); do if curl --fail --silent --max-time 5 'http://127.0.0.1:${PORT}/web/login?db=${DATABASE}' | grep -F 'Odoo' >/dev/null; then ready=yes; break; fi; sleep 5; done; [ "$ready" = yes ]`
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
