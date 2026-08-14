const VERSION = '6.57.0'
const COMPOSE_VERSION = '6.56.0'
const PORT = 18110
const GHOST_PORT = 2368
const MARKER = 'WEBMINAI_GHOST_OK'
const SERVICE = 'webminai-ghost-18110'
const APP_ROOT = '/opt/webminai-ghost-18110'
const CLI_ROOT = '/opt/webminai-ghost-cli'
const DATA_ROOT = '/var/lib/webminai-ghost-18110'
const CREDENTIALS = '/root/ghost_credentials'
const SERVICE_ROOT = '/opt/webminai/services/ghost'
const PROJECT = 'webminai-ghost-18110'
const DATABASE = 'webminai_ghost_18110'
const DATABASE_USER = 'webminai_ghost'
const GHOST_IMAGE = 'ghost@sha256:5cb081c6be54af505f28cde86f209e8e43910da0a406226a9e5e98045388599b'
const MYSQL_IMAGE = 'mysql@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b'
const NGINX_IMAGE = 'nginx@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46'
const IMAGES = [GHOST_IMAGE, MYSQL_IMAGE, NGINX_IMAGE]
const DPKG_PACKAGE_FORMAT = '$' + '{binary:Package} $' + '{Version}\\n'
const DOCKER_CODENAME_FALLBACK = '$' + '{UBUNTU_CODENAME:-$VERSION_CODENAME}'
const MYSQL_ROOT_REFERENCE = '$$' + '{MYSQL_ROOT_PASSWORD}'

export function buildGhostTask (taskId, linuxContext, docker = {}) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  if (!linuxContext?.identity || !linuxContext?.management) throw new TypeError('Ghost task requires a Linux host context')
  if (docker.preferred === true) return buildComposeTask(taskId, linuxContext, docker)
  if (linuxContext.identity.id === 'ubuntu' && ['22.04', '24.04'].includes(linuxContext.identity.versionId)) {
    return buildUbuntuTask(taskId, linuxContext)
  }
  return buildCompatibilityTask(taskId, linuxContext)
}

export function ghostRelease () {
  return Object.freeze({ version: VERSION, composeVersion: COMPOSE_VERSION, images: Object.freeze([...IMAGES]) })
}

function buildCompatibilityTask (taskId, context) {
  const state = `/var/lib/webminai/task-state/${taskId}-ghost-compatibility`
  const identity = context.identity
  const report = join([
    'set -eu', `test ! -e ${quote(APP_ROOT)}`, `test ! -e ${quote(DATA_ROOT)}`, `test ! -e ${quote(CREDENTIALS)}`,
    `install -d -o root -g root -m 0700 ${quote(state)}`,
    `printf '%s\\n' ${quote(`Ghost ${VERSION} production is unsupported on ${identity.id} ${identity.versionId ?? ''} without an approved container route; Node.js 22 and Oracle MySQL 8 are required, and MariaDB or production SQLite substitutions are forbidden.`)} > ${quote(`${state}/report.txt`)}`,
    `chmod 0600 ${quote(`${state}/report.txt`)}`, `printf '%s\\n' ${quote(state)}`
  ])
  const cleanup = `set -eu; rm -rf -- ${quote(state)}; printf '%s\\n' compatibility-report-removed`
  return envelope({
    context,
    route: 'no-change-incompatible',
    overview: `Record a no-change Ghost production compatibility result for ${identity.id} ${identity.versionId ?? ''}.`,
    files: [state, `${state}/report.txt`],
    commands: [item('record-compatibility', 'preflight', report, 'Record the reviewed no-change compatibility result without installing an unsupported database stack')],
    revertCommands: [item('remove-compatibility-report', 'cleanup', cleanup, 'Remove only the task-owned compatibility report', [], 30000, undefined, 'destructive')],
    verifyApplied: `test -s ${quote(`${state}/report.txt`)} && grep -Fq 'Oracle MySQL 8' ${quote(`${state}/report.txt`)} && test ! -e ${quote(APP_ROOT)} && test ! -e ${quote(CREDENTIALS)}`,
    verifyReverted: `test ! -e ${quote(state)}`
  })
}

function buildUbuntuTask (taskId, context) {
  const state = `/var/lib/webminai/task-state/${taskId}-ghost-linux`
  const paths = ubuntuPaths()
  const commands = [
    item('capture-baseline', 'baseline', ubuntuBaseline(state, paths), 'Capture package, repository, nginx, MySQL, and task-owned path state exactly once'),
    item('install-stack', 'packages', ubuntuPackages(state), 'Install NodeSource Node.js 22, Oracle MySQL 8, nginx, and required utilities', ['capture-baseline'], 1200000, 'job'),
    item('generate-credentials', 'secrets', credentialsCommand(), 'Generate the database password on-host without emitting it', ['capture-baseline']),
    item('initialize-database', 'database', ubuntuDatabase(), 'Create the isolated MySQL database and least-privilege Ghost account', ['install-stack', 'generate-credentials'], 900000, 'job'),
    item('install-ghost', 'acquire', ubuntuGhostInstall(state), `Install Ghost ${VERSION} through the pinned official Ghost-CLI`, ['install-stack'], 3600000, 'job'),
    item('configure-ghost', 'configure', ubuntuConfigure(paths), 'Create the locked service, protected environment, and nginx reverse proxy', ['initialize-database', 'install-ghost']),
    item('verify-ghost', 'verify', ubuntuVerify(), 'Verify Ghost, MySQL persistence, nginx marker, and restart recovery', ['configure-ghost'], 1200000, 'job')
  ]
  const revertCommands = [
    item('stop-ghost', 'cleanup', ubuntuStop(paths), 'Stop and remove only the task-owned Ghost service and nginx site', [], 300000, undefined, 'destructive'),
    item('drop-database', 'cleanup', ubuntuDropDatabase(), 'Drop only the task-owned MySQL database and account', ['stop-ghost'], 300000, undefined, 'destructive'),
    item('remove-ghost-files', 'cleanup', `set -eu; rm -rf -- ${quote(APP_ROOT)} ${quote(CLI_ROOT)} ${quote(DATA_ROOT)} ${quote(CREDENTIALS)}`, 'Remove task-owned application, CLI, content, and protected credentials', ['drop-database'], 300000, undefined, 'destructive'),
    item('restore-stack', 'cleanup', ubuntuRestore(state, paths), 'Restore package, repository, nginx, and MySQL service state from the baseline', ['remove-ghost-files'], 1200000, 'job', 'destructive')
  ]
  return envelope({
    context,
    route: 'native-ubuntu-mysql8',
    overview: `Deploy Ghost ${VERSION} with Node.js 22, MySQL 8, systemd, and nginx on port ${PORT}.`,
    files: [state, APP_ROOT, CLI_ROOT, DATA_ROOT, CREDENTIALS, ...Object.values(paths)],
    commands,
    revertCommands,
    verifyApplied: ubuntuVerify(),
    verifyReverted: `test ! -e ${quote(APP_ROOT)} && test ! -e ${quote(CLI_ROOT)} && test ! -e ${quote(DATA_ROOT)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)} && test ! -e ${quote(paths.serviceFile)} && test ! -e ${quote(paths.nginxVhost)}`
  })
}

function buildComposeTask (taskId, context, docker) {
  if (!docker.ready && docker.installMethod !== 'official-apt') throw new Error('learned Ghost Compose setup requires Docker ready or the reviewed official apt route')
  const state = `/var/lib/webminai/task-state/${taskId}-ghost-compose`
  const commands = [
    item('capture-baseline', 'baseline', composeBaseline(state), 'Capture Docker, image, service, and task-path state exactly once'),
    item('prepare-docker', 'packages', prepareDocker(state), 'Install Docker and Compose only when the reviewed host route requires them', ['capture-baseline'], 900000, 'job'),
    item('generate-credentials', 'secrets', credentialsCommand(), 'Generate MySQL credentials on-host without emitting them', ['capture-baseline']),
    item('write-compose', 'configure', writeCompose(), 'Write the digest-pinned Ghost, MySQL, and nginx Compose project', ['prepare-docker', 'generate-credentials']),
    item('start-compose', 'services', startCompose(), 'Pull and start the production Ghost and MySQL services with bounded readiness', ['write-compose'], 2700000, 'job'),
    item('verify-compose', 'verify', verifyCompose(), 'Verify Ghost version, MySQL persistence, marker access, and restart recovery', ['start-compose'], 1200000, 'job')
  ]
  const revertCommands = [
    item('remove-compose-project', 'cleanup', removeCompose(state), 'Remove only the task-owned containers, volumes, network, and newly pulled images', [], 1200000, 'job', 'destructive'),
    item('remove-compose-files', 'cleanup', `set -eu; rm -rf -- ${quote(SERVICE_ROOT)} ${quote(CREDENTIALS)}`, 'Remove task-owned Compose files and protected credentials', ['remove-compose-project'], 300000, undefined, 'destructive'),
    item('restore-docker', 'cleanup', restoreDocker(state), 'Restore Docker package and service state when Docker was introduced by this task', ['remove-compose-files'], 900000, 'job', 'destructive')
  ]
  return envelope({
    context,
    route: 'compose-mysql8',
    overview: `Deploy official Ghost ${COMPOSE_VERSION}, MySQL 8, and nginx through digest-pinned Compose on port ${PORT}.`,
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
      summary: route === 'no-change-incompatible' ? 'Record Ghost production compatibility result' : `Deploy a learned reversible ${route.startsWith('compose') ? 'Ghost Compose' : 'native Ghost'} service`,
      changeOverview: overview,
      modifiedFiles: files,
      assumptions: [
        `Authoritative Linux profile: ${identity.id} ${identity.versionId ?? ''}`.trim(),
        `Resolved Ghost matrix: native ${VERSION} or official Compose ${COMPOSE_VERSION}, Node.js 22, and Oracle MySQL 8.`,
        'Database credentials are generated on-host and only protected paths are included in plans and logs.'
      ],
      warnings: route === 'no-change-incompatible'
        ? ['No application is installed because this host lacks an approved Ghost production route; MariaDB and production SQLite substitutions are forbidden.']
        : [`This controlled validation publishes TCP port ${PORT} through nginx and does not configure public DNS or TLS.`],
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
    application: { id: 'ghost', version: route.startsWith('compose') ? COMPOSE_VERSION : VERSION },
    host: { fingerprint: context.fingerprint, distribution: context.identity.id, distributionVersion: context.identity.versionId, architecture: context.identity.architecture, family: context.management.family },
    selectedRoute: { id: route, status: route === 'no-change-incompatible' ? 'unsupported' : 'supported' },
    components: [
      { profileId: 'nodejs', selectedVersion: route.startsWith('compose') ? 'image-managed' : '22', source: route.startsWith('compose') ? 'official-container-image' : 'signed-nodesource', status: route === 'no-change-incompatible' ? 'unavailable' : 'supported' },
      { profileId: 'mysql', selectedVersion: '8', source: route.startsWith('compose') ? 'official-container-image' : 'ubuntu-package', status: route === 'no-change-incompatible' ? 'unavailable' : 'supported' },
      { profileId: 'nginx', selectedVersion: 'distribution-or-image', source: 'reviewed-profile', status: route === 'no-change-incompatible' ? 'not-selected' : 'supported' }
    ]
  }
}

function ubuntuPaths () {
  return {
    serviceFile: `/etc/systemd/system/${SERVICE}.service`,
    nginxVhost: `/etc/nginx/sites-available/${SERVICE}.conf`,
    nginxEnableLink: `/etc/nginx/sites-enabled/${SERVICE}.conf`,
    nodeKey: '/usr/share/keyrings/nodesource.gpg',
    nodeSource: '/etc/apt/sources.list.d/nodesource.sources',
    nodePreference: '/etc/apt/preferences.d/nodejs',
    nsolidPreference: '/etc/apt/preferences.d/nsolid'
  }
}

function ubuntuBaseline (state, paths) {
  const owned = [APP_ROOT, CLI_ROOT, DATA_ROOT, CREDENTIALS, paths.serviceFile, paths.nginxVhost, paths.nginxEnableLink]
  const preserved = [paths.nodeKey, paths.nodeSource, paths.nodePreference, paths.nsolidPreference]
  return join([
    'set -eu', `if [ ! -s ${quote(`${state}/packages.before`)} ]; then`, ...owned.map(path => `test ! -e ${quote(path)}`),
    `install -d -o root -g root -m 0700 ${quote(`${state}/backup`)}`,
    `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(`${state}/packages.before`)}`,
    `systemctl is-active --quiet nginx 2>/dev/null && : > ${quote(`${state}/nginx.active`)} || true`,
    `systemctl is-enabled --quiet nginx 2>/dev/null && : > ${quote(`${state}/nginx.enabled`)} || true`,
    `systemctl is-active --quiet mysql 2>/dev/null && : > ${quote(`${state}/mysql.active`)} || true`,
    `systemctl is-enabled --quiet mysql 2>/dev/null && : > ${quote(`${state}/mysql.enabled`)} || true`,
    ...preserved.map((path, index) => `if [ -e ${quote(path)} ]; then cp -a -- ${quote(path)} ${quote(`${state}/backup/${index}`)}; : > ${quote(`${state}/backup-${index}.existed`)}; fi`),
    'fi', 'printf \'%s\\n\' baseline-ready'
  ])
}

function ubuntuPackages (state) {
  return join([
    'set -eu', 'export DEBIAN_FRONTEND=noninteractive', 'apt-get update', 'apt-get install -y ca-certificates curl gnupg nginx mysql-server openssl',
    'if ! node -e "const [a,b,c]=process.versions.node.split(\'.\').map(Number);process.exit(a===22&&(b>23||(b===23&&c>=1))?0:1)" >/dev/null 2>&1; then',
    'install -d -o root -g root -m 0755 /usr/share/keyrings',
    'curl --fail --location --silent --show-error https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes --output /usr/share/keyrings/nodesource.gpg',
    'chmod 0644 /usr/share/keyrings/nodesource.gpg',
    "arch=$(dpkg --print-architecture); printf '%s\\n' 'Types: deb' 'URIs: https://deb.nodesource.com/node_22.x' 'Suites: nodistro' 'Components: main' \"Architectures: $arch\" 'Signed-By: /usr/share/keyrings/nodesource.gpg' > /etc/apt/sources.list.d/nodesource.sources",
    "printf '%s\\n' 'Package: nodejs' 'Pin: origin deb.nodesource.com' 'Pin-Priority: 600' > /etc/apt/preferences.d/nodejs",
    "printf '%s\\n' 'Package: nsolid' 'Pin: origin deb.nodesource.com' 'Pin-Priority: 600' > /etc/apt/preferences.d/nsolid",
    'apt-get update', 'apt-get install -y nodejs', 'fi',
    'node -e "const [a,b,c]=process.versions.node.split(\'.\').map(Number);process.exit(a===22&&(b>23||(b===23&&c>=1))?0:1)"',
    'npm --version >/dev/null', 'mysqld --version | grep -Eq \'Ver 8\\.0\' || { printf \'Ghost production requires Oracle MySQL 8.0\\n\' >&2; exit 1; }',
    'systemctl enable --now mysql', 'systemctl enable --now nginx',
    `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(`${state}/packages.after`)}`,
    `LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} > ${quote(`${state}/packages.added`)} || true`,
    'printf \'%s\\n\' stack-ready'
  ])
}

function credentialsCommand () {
  return join([
    'set -eu', 'umask 077', `install -d -o root -g root -m 0700 ${quote(CREDENTIALS)}`,
    `[ -s ${quote(`${CREDENTIALS}/database_password`)} ] || openssl rand -hex 32 > ${quote(`${CREDENTIALS}/database_password`)}`,
    `[ -s ${quote(`${CREDENTIALS}/database_root_password`)} ] || openssl rand -hex 32 > ${quote(`${CREDENTIALS}/database_root_password`)}`,
    `chmod 0600 ${quote(`${CREDENTIALS}/database_password`)} ${quote(`${CREDENTIALS}/database_root_password`)}`,
    `printf '%s\\n' ${quote(CREDENTIALS)}`
  ])
}

function ubuntuDatabase () {
  return join([
    'set -eu', 'ready=', 'for attempt in $(seq 1 60); do mysqladmin ping --silent >/dev/null 2>&1 && ready=yes && break; sleep 2; done', '[ "$ready" = yes ]',
    `password=$(cat ${quote(`${CREDENTIALS}/database_password`)})`,
    `mysql --batch --skip-column-names -e "CREATE DATABASE IF NOT EXISTS ${DATABASE} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; CREATE USER IF NOT EXISTS '${DATABASE_USER}'@'127.0.0.1' IDENTIFIED BY '$password'; ALTER USER '${DATABASE_USER}'@'127.0.0.1' IDENTIFIED BY '$password'; GRANT ALL PRIVILEGES ON ${DATABASE}.* TO '${DATABASE_USER}'@'127.0.0.1'; FLUSH PRIVILEGES;"`,
    `MYSQL_PWD="$password" mysql --protocol=TCP -h 127.0.0.1 -u ${DATABASE_USER} ${DATABASE} -e 'SELECT 1' >/dev/null`, 'printf \'%s\\n\' database-ready'
  ])
}

function ubuntuGhostInstall (state) {
  return join([
    'set -eu', 'umask 022', `id webminai-ghost >/dev/null 2>&1 || useradd -r -d ${quote(DATA_ROOT)} -s /usr/sbin/nologin webminai-ghost`,
    `install -d -o webminai-ghost -g webminai-ghost -m 0750 ${quote(DATA_ROOT)}`, `install -d -o webminai-ghost -g webminai-ghost -m 0755 ${quote(APP_ROOT)}`, `install -d -o webminai-ghost -g webminai-ghost -m 0755 ${quote(`${state}/npm-cache`)}`,
    `if [ ! -x ${quote(`${CLI_ROOT}/bin/ghost`)} ]; then npm_config_cache=${quote(`${state}/npm-cache`)} npm install --global --prefix ${quote(CLI_ROOT)} --omit=dev --no-audit --no-fund --loglevel=error ghost-cli@1.29.1; fi`,
    `if [ ! -x ${quote(`${CLI_ROOT}/bin/pnpm`)} ]; then npm_config_cache=${quote(`${state}/npm-cache`)} npm install --global --prefix ${quote(CLI_ROOT)} --omit=dev --no-audit --no-fund --loglevel=error pnpm@11.15.1; fi`,
    `if [ ! -f ${quote(`${APP_ROOT}/current/package.json`)} ]; then chown webminai-ghost:webminai-ghost ${quote(APP_ROOT)}; runuser -u webminai-ghost -- env HOME=${quote(DATA_ROOT)} PATH=${quote(`${CLI_ROOT}/bin:/usr/bin:/bin`)} npm_config_cache=${quote(`${state}/npm-cache`)} ${quote(`${CLI_ROOT}/bin/ghost`)} install ${quote(VERSION)} --dir ${quote(APP_ROOT)} --no-prompt --no-setup --no-start --no-stack --no-color; fi`,
    `node -p "require('${APP_ROOT}/current/package.json').version" | grep -Fx ${quote(VERSION)}`, 'printf \'%s\\n\' ghost-installed'
  ])
}

function ubuntuConfigure (paths) {
  const config = JSON.stringify({ url: `http://__PRIMARY__:${PORT}/blog/`, server: { host: '127.0.0.1', port: GHOST_PORT }, database: { client: 'mysql', connection: { host: '127.0.0.1', port: 3306, user: DATABASE_USER, database: DATABASE } }, paths: { contentPath: `${DATA_ROOT}/content` }, privacy: { useUpdateCheck: false } }, null, 2)
  const unit = ['[Unit]', 'Description=Intent AI Ops Ghost validation service', 'After=network-online.target mysql.service', 'Wants=network-online.target', 'Requires=mysql.service', '', '[Service]', 'Type=simple', 'User=webminai-ghost', 'Group=webminai-ghost', `WorkingDirectory=${APP_ROOT}`, 'Environment=NODE_ENV=production', `EnvironmentFile=${CREDENTIALS}/service.env`, `ExecStart=/usr/bin/node ${APP_ROOT}/current/index.js`, 'Restart=on-failure', 'RestartSec=5', 'NoNewPrivileges=true', 'PrivateTmp=true', '', '[Install]', 'WantedBy=multi-user.target'].join('\n')
  const nginx = ['server {', `    listen ${PORT};`, '    server_name _;', '    location = / { default_type text/plain; return 200 "' + MARKER + '\\n"; }', '    location /blog/ {', `        proxy_pass http://127.0.0.1:${GHOST_PORT};`, '        proxy_set_header Host $host;', '        proxy_set_header X-Real-IP $remote_addr;', '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;', '        proxy_set_header X-Forwarded-Proto $scheme;', '    }', '}'].join('\n')
  return join([
    'set -eu', `id webminai-ghost >/dev/null 2>&1 || useradd -r -d ${quote(DATA_ROOT)} -s /usr/sbin/nologin webminai-ghost`,
    `install -d -o webminai-ghost -g webminai-ghost -m 0750 ${quote(DATA_ROOT)} ${quote(`${DATA_ROOT}/content`)}`,
    `if [ ! -d ${quote(`${DATA_ROOT}/content/themes/source`)} ]; then cp -a ${quote(`${APP_ROOT}/content/`)}. ${quote(`${DATA_ROOT}/content/`)}; fi`, `chown -R webminai-ghost:webminai-ghost ${quote(`${DATA_ROOT}/content`)}`,
    `password=$(cat ${quote(`${CREDENTIALS}/database_password`)})`, `chgrp webminai-ghost ${quote(CREDENTIALS)}`, `chmod 0710 ${quote(CREDENTIALS)}`,
    `umask 077; printf 'database__connection__password=%s\\n' "$password" > ${quote(`${CREDENTIALS}/service.env`)}`, `chown root:webminai-ghost ${quote(`${CREDENTIALS}/service.env`)}`, `chmod 0640 ${quote(`${CREDENTIALS}/service.env`)}`,
    "primary=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (field=1; field<=NF; field++) if ($field == \"src\") { print $(field+1); exit }}' || true)", "[ -n \"$primary\" ] || primary=$(hostname -I 2>/dev/null | awk '{print $1}')", "case \"$primary\" in ''|*[!0-9a-fA-F:.]*) printf 'could not resolve a safe primary address\\n' >&2; exit 1;; esac",
    `printf '%s\\n' ${config.split('\n').map(quote).join(' ')} | sed "s/__PRIMARY__/$primary/" > ${quote(`${APP_ROOT}/config.production.json`)}`, `chown webminai-ghost:webminai-ghost ${quote(`${APP_ROOT}/config.production.json`)}`, `chmod 0640 ${quote(`${APP_ROOT}/config.production.json`)}`,
    `printf '%s\\n' ${unit.split('\n').map(quote).join(' ')} > ${quote(paths.serviceFile)}`, `chmod 0644 ${quote(paths.serviceFile)}`,
    `printf '%s\\n' ${nginx.split('\n').map(quote).join(' ')} > ${quote(paths.nginxVhost)}`, `chmod 0644 ${quote(paths.nginxVhost)}`, `ln -sfn ${quote(paths.nginxVhost)} ${quote(paths.nginxEnableLink)}`,
    'systemctl daemon-reload', `systemctl enable --now ${quote(SERVICE)}`, 'nginx -t', 'systemctl reload nginx', 'printf \'%s\\n\' configured'
  ])
}

function ubuntuVerify () {
  return join([
    'set -eu', waitUrl(`http://127.0.0.1:${GHOST_PORT}/blog/`, 180),
    `test -d ${quote(`${DATA_ROOT}/content`)}`, `password=$(cat ${quote(`${CREDENTIALS}/database_password`)})`,
    `MYSQL_PWD="$password" mysql --protocol=TCP -h 127.0.0.1 -u ${DATABASE_USER} ${DATABASE} --batch --skip-column-names -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DATABASE}'" | awk '$1 > 0 { ok=1 } END { exit !ok }'`,
    `curl --fail --silent --show-error --max-time 5 http://127.0.0.1:${PORT}/ | grep -Fx ${quote(MARKER)}`,
    `curl --fail --silent --show-error --max-time 10 http://127.0.0.1:${PORT}/blog/ >/dev/null`,
    `systemctl restart ${quote(SERVICE)}`, waitUrl(`http://127.0.0.1:${GHOST_PORT}/blog/`, 180), 'printf \'%s\\n\' ghost-verified'
  ])
}

function ubuntuStop (paths) {
  return join([
    'set -eu', `systemctl disable --now ${quote(SERVICE)} 2>/dev/null || true`, `rm -f -- ${quote(paths.serviceFile)}`, 'systemctl daemon-reload',
    `rm -f -- ${quote(paths.nginxEnableLink)} ${quote(paths.nginxVhost)}`, 'if command -v nginx >/dev/null 2>&1; then nginx -t', 'systemctl is-active --quiet nginx && systemctl reload nginx || true', 'fi'
  ])
}

function ubuntuDropDatabase () {
  return join(['set -eu', `if command -v mysql >/dev/null 2>&1 && mysqladmin ping --silent >/dev/null 2>&1; then mysql --batch -e "DROP DATABASE IF EXISTS ${DATABASE}; DROP USER IF EXISTS '${DATABASE_USER}'@'127.0.0.1'; FLUSH PRIVILEGES;"; fi`, 'printf \'%s\\n\' database-removed'])
}

function ubuntuRestore (state, paths) {
  const preserved = [paths.nodeKey, paths.nodeSource, paths.nodePreference, paths.nsolidPreference]
  const commands = ['set -eu', `[ -d ${quote(state)} ] || { printf '%s\n' already-reverted; exit 0; }`]
  preserved.forEach((path, index) => commands.push(`if [ -e ${quote(`${state}/backup-${index}.existed`)} ]; then rm -rf -- ${quote(path)}; cp -a -- ${quote(`${state}/backup/${index}`)} ${quote(path)}; else rm -rf -- ${quote(path)}; fi`))
  commands.push(removeDebianPackages(`${state}/packages.added`))
  commands.push(`if systemctl cat nginx >/dev/null 2>&1; then if [ -e ${quote(`${state}/nginx.enabled`)} ]; then systemctl enable nginx >/dev/null 2>&1 || true; else systemctl disable nginx >/dev/null 2>&1 || true; fi; if [ -e ${quote(`${state}/nginx.active`)} ]; then systemctl start nginx; else systemctl stop nginx 2>/dev/null || true; fi; fi`)
  commands.push(`if systemctl cat mysql >/dev/null 2>&1; then if [ -e ${quote(`${state}/mysql.enabled`)} ]; then systemctl enable mysql >/dev/null 2>&1 || true; else systemctl disable mysql >/dev/null 2>&1 || true; fi; if [ -e ${quote(`${state}/mysql.active`)} ]; then systemctl start mysql; else systemctl stop mysql 2>/dev/null || true; fi; fi`)
  commands.push('id webminai-ghost >/dev/null 2>&1 && userdel webminai-ghost 2>/dev/null || true', `rm -rf -- ${quote(state)}`)
  return join(commands)
}

function composeBaseline (state) {
  return join([
    'set -eu', `if [ ! -s ${quote(`${state}/packages.before`)} ]; then`, `test ! -e ${quote(SERVICE_ROOT)}`, `test ! -e ${quote(CREDENTIALS)}`,
    `install -d -o root -g root -m 0700 ${quote(state)}`, `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(`${state}/packages.before`)}`,
    `systemctl is-active --quiet docker 2>/dev/null && : > ${quote(`${state}/docker.active`)} || true`, `command -v docker >/dev/null 2>&1 && : > ${quote(`${state}/docker.existed`)} || true`,
    ...IMAGES.map((image, index) => `docker image inspect ${quote(image)} >/dev/null 2>&1 && : > ${quote(`${state}/image-${index}.existed`)} || true`),
    'fi', 'printf \'%s\\n\' baseline-ready'
  ])
}

function prepareDocker (state) {
  return join([
    'set -eu', 'if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then :; else',
    `[ ! -e ${quote(`${state}/docker.existed`)} ]`, 'export DEBIAN_FRONTEND=noninteractive', 'apt-get update', 'apt-get install -y ca-certificates curl',
    'install -d -m 0755 /etc/apt/keyrings', 'curl --fail --location --silent --show-error https://download.docker.com/linux/ubuntu/gpg --output /etc/apt/keyrings/docker.asc', 'chmod 0644 /etc/apt/keyrings/docker.asc',
    '. /etc/os-release', `arch=$(dpkg --print-architecture); codename=${DOCKER_CODENAME_FALLBACK}`,
    'printf \'%s\\n\' \'Types: deb\' \'URIs: https://download.docker.com/linux/ubuntu\' "Suites: $codename" \'Components: stable\' "Architectures: $arch" \'Signed-By: /etc/apt/keyrings/docker.asc\' > /etc/apt/sources.list.d/docker.sources',
    'apt-get update', 'apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin', 'systemctl start docker', 'fi',
    'docker info >/dev/null', 'docker compose version >/dev/null', `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(`${state}/packages.after`)}`,
    `LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} > ${quote(`${state}/packages.added`)} || true`
  ])
}

function writeCompose () {
  const compose = [
    'services:', '  db:', `    image: ${MYSQL_IMAGE}`, '    restart: unless-stopped', `    env_file: ${CREDENTIALS}/credentials.env`, '    environment:', `      MYSQL_DATABASE: ${DATABASE}`, `      MYSQL_USER: ${DATABASE_USER}`, '    volumes:', '      - mysql_data:/var/lib/mysql', '    healthcheck:', `      test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -u root --password=\\"${MYSQL_ROOT_REFERENCE}\\""]`, '      interval: 5s', '      timeout: 5s', '      retries: 120', '      start_period: 30s',
    '  ghost:', `    image: ${GHOST_IMAGE}`, '    restart: unless-stopped', `    env_file: ${CREDENTIALS}/credentials.env`, '    environment:', '      NODE_ENV: production', '      database__client: mysql', '      database__connection__host: db', `      database__connection__user: ${DATABASE_USER}`, `      database__connection__database: ${DATABASE}`, '    volumes:', '      - ghost_content:/var/lib/ghost/content', '    depends_on:', '      db:', '        condition: service_healthy', '    healthcheck:', `      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:${GHOST_PORT}/blog/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]`, '      interval: 5s', '      timeout: 5s', '      retries: 120', '      start_period: 30s',
    '  nginx:', `    image: ${NGINX_IMAGE}`, '    restart: unless-stopped', '    ports:', `      - "${PORT}:${PORT}"`, '    volumes:', `      - ${SERVICE_ROOT}/nginx.conf:/etc/nginx/conf.d/default.conf:ro`, '    depends_on:', '      ghost:', '        condition: service_healthy',
    'volumes:', '  mysql_data:', '  ghost_content:'
  ].join('\n')
  const nginx = ['server {', `    listen ${PORT};`, '    server_name _;', '    location = / { default_type text/plain; return 200 "' + MARKER + '\\n"; }', '    location /blog/ {', `        proxy_pass http://ghost:${GHOST_PORT};`, '        proxy_set_header Host $host;', '        proxy_set_header X-Real-IP $remote_addr;', '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;', '        proxy_set_header X-Forwarded-Proto $scheme;', '    }', '}'].join('\n')
  return join([
    'set -eu', `install -d -o root -g root -m 0755 ${quote(SERVICE_ROOT)}`,
    "primary=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (field=1; field<=NF; field++) if ($field == \"src\") { print $(field+1); exit }}' || true)", "[ -n \"$primary\" ] || primary=$(hostname -I 2>/dev/null | awk '{print $1}')", "case \"$primary\" in ''|*[!0-9a-fA-F:.]*) printf 'could not resolve a safe primary address\\n' >&2; exit 1;; esac",
    `password=$(cat ${quote(`${CREDENTIALS}/database_password`)}); root_password=$(cat ${quote(`${CREDENTIALS}/database_root_password`)})`,
    `umask 077; printf 'MYSQL_PASSWORD=%s\\nMYSQL_ROOT_PASSWORD=%s\\ndatabase__connection__password=%s\\nurl=http://%s:${PORT}/blog/\\nprivacy__useUpdateCheck=false\\n' "$password" "$root_password" "$password" "$primary" > ${quote(`${CREDENTIALS}/credentials.env`)}`, `chmod 0600 ${quote(`${CREDENTIALS}/credentials.env`)}`,
    `printf '%s\\n' ${compose.split('\n').map(quote).join(' ')} > ${quote(`${SERVICE_ROOT}/compose.yaml`)}`, `chmod 0644 ${quote(`${SERVICE_ROOT}/compose.yaml`)}`,
    `printf '%s\\n' ${nginx.split('\n').map(quote).join(' ')} > ${quote(`${SERVICE_ROOT}/nginx.conf`)}`, `chmod 0644 ${quote(`${SERVICE_ROOT}/nginx.conf`)}`,
    `docker compose -p ${quote(PROJECT)} -f ${quote(`${SERVICE_ROOT}/compose.yaml`)} config --quiet`, 'printf \'%s\\n\' compose-ready'
  ])
}

function startCompose () {
  return join(['set -eu', `docker compose -p ${quote(PROJECT)} -f ${quote(`${SERVICE_ROOT}/compose.yaml`)} pull`, `docker compose -p ${quote(PROJECT)} -f ${quote(`${SERVICE_ROOT}/compose.yaml`)} up -d`, waitCompose('db'), waitCompose('ghost'), `curl --fail --silent --show-error --max-time 5 http://127.0.0.1:${PORT}/ | grep -Fx ${quote(MARKER)}`])
}

function verifyCompose () {
  const compose = `docker compose -p ${quote(PROJECT)} -f ${quote(`${SERVICE_ROOT}/compose.yaml`)}`
  return join([
    'set -eu', waitCompose('db'), waitCompose('ghost'),
    `${compose} exec -T ghost node -p "require('/var/lib/ghost/current/package.json').version" | grep -Fx ${quote(COMPOSE_VERSION)}`,
    `${compose} exec -T db sh -c 'mysql -u root --password="$MYSQL_ROOT_PASSWORD" --batch --skip-column-names ${DATABASE} -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE()"' | awk '$1 > 0 { ok=1 } END { exit !ok }'`,
    `${compose} exec -T ghost node -e "fetch('http://127.0.0.1:${GHOST_PORT}/blog/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`,
    `curl --fail --silent --show-error --max-time 5 http://127.0.0.1:${PORT}/ | grep -Fx ${quote(MARKER)}`,
    `curl --fail --silent --show-error --max-time 10 http://127.0.0.1:${PORT}/blog/ >/dev/null`,
    'printf \'%s\\n\' ghost-verified'
  ])
}

function removeCompose (state) {
  const compose = `docker compose -p ${quote(PROJECT)} -f ${quote(`${SERVICE_ROOT}/compose.yaml`)}`
  const commands = ['set -eu', `[ -d ${quote(state)} ] || { printf '%s\n' already-reverted; exit 0; }`, `if command -v docker >/dev/null 2>&1 && [ -f ${quote(`${SERVICE_ROOT}/compose.yaml`)} ]; then ${compose} down --volumes --remove-orphans || true; fi`]
  IMAGES.forEach((image, index) => commands.push(`if command -v docker >/dev/null 2>&1 && [ ! -e ${quote(`${state}/image-${index}.existed`)} ]; then docker image rm ${quote(image)} >/dev/null 2>&1 || true; fi`))
  return join(commands)
}

function restoreDocker (state) {
  return join([
    'set -eu', `[ -d ${quote(state)} ] || { printf '%s\n' already-reverted; exit 0; }`, `if [ ! -e ${quote(`${state}/docker.existed`)} ]; then`, removeDebianPackages(`${state}/packages.added`),
    'rm -f /etc/apt/sources.list.d/docker.sources /etc/apt/keyrings/docker.asc', 'rm -rf -- /var/lib/docker /var/lib/containerd', 'fi',
    `if [ -e ${quote(`${state}/docker.active`)} ]; then systemctl start docker 2>/dev/null || true; else systemctl stop docker 2>/dev/null || true; fi`, `rm -rf -- ${quote(state)}`
  ])
}

function removeDebianPackages (list) {
  return `if [ -s ${quote(list)} ]; then packages=$(awk '{print $1}' ${quote(list)} | tr '\\n' ' '); [ -z "$packages" ] || { DEBIAN_FRONTEND=noninteractive apt-get purge -y $packages || true; DEBIAN_FRONTEND=noninteractive apt-get autoremove -y || true; }; fi`
}

function waitUrl (url, attempts) {
  return `ready=; for attempt in $(seq 1 ${attempts}); do if curl --fail --silent --show-error --max-time 3 ${quote(url)} >/dev/null 2>&1; then ready=yes; break; fi; sleep 5; done; [ "$ready" = yes ]`
}

function waitCompose (service) {
  return `ready=; for attempt in $(seq 1 180); do status=$(docker inspect ${quote(`${PROJECT}-${service}-1`)} --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null || true); [ "$status" = healthy ] && ready=yes && break; sleep 5; done; [ "$ready" = yes ]`
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
