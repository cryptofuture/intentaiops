/** @param {{taskId: number, linuxContext: any, docker?: any, application: any}} options */
export function buildLinuxPhpApplicationFoundation ({ taskId, linuxContext, docker = {}, application }) {
  validateInputs(taskId, linuxContext, application)
  return docker.preferred === true
    ? buildComposeFoundation({ taskId, linuxContext, docker, application })
    : buildNativeFoundation({ taskId, linuxContext, application })
}

function buildNativeFoundation ({ taskId, linuxContext, application }) {
  const profile = linuxPhpApplicationProfile(linuxContext, application)
  const family = linuxContext.management?.family ?? linuxContext.family
  const state = `/var/lib/webminai/task-state/${taskId}-${application.id}-linux`
  const services = [profile.mariadbService, profile.phpFpmService, profile.nginxService]
  const paths = nativePaths(application, profile, state)
  const commands = [
    item('capture-baseline', 'baseline', nativeBaseline({ state, family, profile, services, paths }), 'Capture package, service, database, and task-owned path state'),
    item('install-packages', 'packages', installPackages({ state, family, profile }), 'Install the reviewed distro-specific nginx, PHP-FPM, and MariaDB stack', ['capture-baseline'], 1800000, 'job'),
    item('verify-artifacts', 'acquire', "printf '%s\n' application-artifact-hook", 'Acquire and verify the application release', ['install-packages'], 1800000, 'job'),
    item('generate-credentials', 'secrets', credentialsCommand(application.credentials), 'Generate protected application credentials on the host', ['capture-baseline']),
    item('prepare-database', 'database', databaseCommand({ family, profile, application }), 'Initialize MariaDB and create only the task-owned database identity', ['install-packages', 'generate-credentials']),
    item('extract-application', 'configure', "printf '%s\n' application-extract-hook", 'Extract the verified application release', ['verify-artifacts']),
    item('configure-php-fpm', 'configure', phpFpmCommand(profile, application), 'Create the reviewed PHP-FPM pool and task-owned Unix socket', ['install-packages', 'extract-application']),
    item('configure-nginx', 'configure', nginxCommand({ state, profile, application }), 'Create and load the reviewed nginx virtual host', ['configure-php-fpm']),
    item('install-application', 'initialize', "printf '%s\n' application-install-hook", 'Initialize the application from protected credential paths', ['prepare-database', 'configure-nginx']),
    item('verify-application', 'verify', "printf '%s\n' application-verify-hook", 'Verify application health and restart recovery', ['install-application'])
  ]
  return {
    plan: {
      summary: `Deploy a verified native ${application.label} service`,
      changeOverview: `Compose the reviewed nginx, PHP-FPM Unix socket, MariaDB, credentials, and rollback foundations for ${application.label}.`,
      modifiedFiles: paths,
      assumptions: [`Authoritative Linux profile: ${linuxContext.identity?.id ?? family} ${linuxContext.identity?.versionId ?? ''}`.trim(), 'The application owns only its declared paths, port, database, and marker.'],
      warnings: [`This task intentionally serves HTTP on isolated port ${application.port}.`],
      requiresConfirmation: true,
      commands,
      revertCommands: nativeRevert({ state, family, profile, services, application })
    },
    verifyApplied: `curl --fail --silent --show-error --max-time 10 http://127.0.0.1:${application.port}/ | grep -Fq ${quote(application.marker)}`,
    verifyReverted: `test ! -e ${quote(application.webRoot)} && test ! -e ${quote(application.artifacts)} && test ! -e ${quote(application.credentials)}`,
    stateProbe: pathProbe(paths)
  }
}

export function linuxPhpApplicationProfile (linuxContext, application) {
  const source = linuxContext?.applications?.wordpress
  if (!source) throw new Error('Linux PHP foundation requires a WordPress stack profile')
  const replacePath = value => typeof value === 'string' ? value.replaceAll('webminai-wordpress-18101', application.project).replaceAll('wordpress', application.id) : value
  return {
    ...source,
    webRoot: application.webRoot,
    wpCliPhar: `${application.artifacts}/wp-cli.phar`,
    phpFpmPool: replacePath(source.phpFpmPool),
    phpFpmRuntimeDirectory: replacePath(source.phpFpmRuntimeDirectory),
    phpFpmListener: replacePath(source.phpFpmListener),
    nginxVhost: replacePath(source.nginxVhost),
    nginxEnableLink: replacePath(source.nginxEnableLink),
    nginxFastcgiPass: replacePath(source.nginxFastcgiPass),
    phpExtensionConfig: replacePath(source.phpExtensionConfig)
  }
}

function buildComposeFoundation ({ taskId, linuxContext, docker, application }) {
  const identity = linuxContext.identity ?? {}
  if (!['ubuntu', 'debian'].includes(identity.id)) throw new Error(`reviewed ${application.label} Compose prerequisite installation does not yet support ${identity.id ?? 'this Linux distribution'}`)
  if (!docker.ready && docker.installMethod !== 'official-apt') throw new Error(`reviewed ${application.label} Compose requires the official apt Docker route`)
  const state = `/var/lib/webminai/task-state/${taskId}-${application.id}-compose`
  const paths = [state, application.serviceRoot, `${application.serviceRoot}/compose.yaml`, `${application.serviceRoot}/php-fpm.conf`, `${application.serviceRoot}/nginx.conf`, application.credentials, '/etc/apt/keyrings/docker.asc', '/etc/apt/sources.list.d/docker.sources', '/var/lib/docker', '/var/lib/containerd']
  return {
    plan: {
      summary: `Deploy a verified ${application.label} Compose service`,
      changeOverview: `Compose reviewed Docker readiness, protected credentials, lifecycle, verification, and rollback foundations for ${application.label}.`,
      modifiedFiles: paths,
      assumptions: [`Authoritative Linux profile: ${identity.id} ${identity.versionId ?? ''}`.trim(), `Effective Docker policy: ${docker.ready ? 'ready' : `setup required through ${docker.installMethod}`}`],
      warnings: [`Docker publishes the isolated application on TCP port ${application.port}.`],
      requiresConfirmation: true,
      commands: [
        item('capture-baseline', 'baseline', composeBaseline(state, application), 'Capture Docker packages, service, images, port, and task-owned path state'),
        item('prepare-docker', 'packages', prepareDocker(state), 'Install or validate Docker Engine and Compose through the reviewed apt route', ['capture-baseline'], 1800000, 'job'),
        item('generate-credentials', 'secrets', credentialsCommand(application.credentials, ['db_password', 'db_root_password', 'admin_password']), 'Generate protected application credentials on the host', ['capture-baseline']),
        item('write-compose', 'configure', "printf '%s\n' application-compose-hook", 'Write the application Compose topology', ['prepare-docker', 'generate-credentials']),
        item('pull-images', 'acquire', composePull(state, application), 'Pull and record the pinned application images', ['write-compose'], 3600000, 'job'),
        item('start-compose', 'services', "printf '%s\n' application-start-hook", 'Start the application services with bounded readiness', ['pull-images'], 900000, 'job'),
        item('initialize-application', 'initialize', "printf '%s\n' application-initialize-hook", 'Initialize the application from protected credential paths', ['start-compose'], 1800000, 'job'),
        item('verify-compose', 'verify', "printf '%s\n' application-verify-hook", 'Verify application health and restart recovery', ['initialize-application'], 900000, 'job')
      ],
      revertCommands: composeRevert(state, application)
    },
    verifyApplied: `cd ${quote(application.serviceRoot)} && docker compose -p ${quote(application.project)} ps --status running --services | grep -q . && curl --fail --silent --show-error --max-time 10 http://127.0.0.1:${application.port}/ | grep -Fq ${quote(application.marker)}`,
    verifyReverted: `test ! -e ${quote(application.serviceRoot)} && test ! -e ${quote(application.credentials)} && test ! -e ${quote(state)} && { ! command -v docker >/dev/null 2>&1 || ! docker ps -aq --filter label=com.docker.compose.project=${quote(application.project)} | grep -q .; }`,
    stateProbe: pathProbe(paths)
  }
}

function nativeBaseline ({ state, family, profile, services, paths }) {
  return ['set -eu', `state=${quote(state)}`, 'if [ ! -s "$state/packages.before" ]; then :', `for path in ${paths.filter(path => path !== state).map(quote).join(' ')}; do [ ! -e "$path" ] || { printf 'task target already exists: %s\n' "$path" >&2; exit 1; }; done`, 'install -d -o root -g root -m 0700 "$state"', packageSnapshot(family, '"$state/packages.before"'), ...services.map((service, index) => `${serviceActive(service)} && : > "$state/service-${index}.active" || true`), '[ ! -d /var/lib/mysql/mysql ] || : > "$state/database-data.existed"', profile.nginxIncludeRequired ? `if [ -f ${quote(profile.nginxMainConfig)} ]; then cp -a ${quote(profile.nginxMainConfig)} "$state/nginx.conf.before"; fi` : ':', 'fi', "printf '%s\n' baseline-ready"].join('; ')
}

function installPackages ({ state, family, profile }) {
  const log = quote(`${state}/package-install.log`)
  return `set -eu; status=0; ( set -e; ${packageInstall(family, profile.packages)} ) > ${log} 2>&1 || status=$?; tail -n 20 ${log} || true; [ "$status" -eq 0 ] || exit "$status"; ${packageSnapshot(family, quote(`${state}/packages.after`))}; LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} | grep -Ev '^(curl|netdata|netdata-|openssh|openssh-|webminai|webminai-)' > ${quote(`${state}/packages.added`)} || true; printf '%s\n' packages-ready`
}

function credentialsCommand (root, names = ['db_password', 'admin_password']) {
  return `set -eu; umask 077; install -d -o root -g root -m 0700 ${quote(root)}; ${names.map(name => `[ -s ${quote(`${root}/${name}`)} ] || openssl rand -hex 32 > ${quote(`${root}/${name}`)}`).join('; ')}; chmod 0600 ${names.map(name => quote(`${root}/${name}`)).join(' ')}; printf '%s\n' credentials-ready`
}

function databaseCommand ({ family, profile, application }) {
  return `set -eu; initialized=; if [ ! -d /var/lib/mysql/mysql ]; then mariadb-install-db --user=mysql --basedir=/usr --datadir=/var/lib/mysql >/dev/null; initialized=yes; fi; install -d -o mysql -g mysql -m 0755 /run/mariadb /run/mysqld; if [ -n "$initialized" ] || ! ${serviceActive(profile.mariadbService)}; then ${serviceRestart(profile.mariadbService, family)}; fi; ready=; for attempt in $(seq 1 30); do mariadb --protocol=socket -uroot -e 'SELECT 1' >/dev/null 2>&1 && { ready=yes; break; }; sleep 1; done; [ "$ready" = yes ]; dbpass=$(sed -n 1p ${quote(`${application.credentials}/db_password`)}); printf "CREATE DATABASE IF NOT EXISTS ${application.database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER IF NOT EXISTS '${application.database}'@'${profile.databaseHost}' IDENTIFIED BY '%s'; ALTER USER '${application.database}'@'${profile.databaseHost}' IDENTIFIED BY '%s'; GRANT ALL PRIVILEGES ON ${application.database}.* TO '${application.database}'@'${profile.databaseHost}'; FLUSH PRIVILEGES;\n" "$dbpass" "$dbpass" | mariadb --protocol=socket -uroot >/dev/null 2>&1; printf '%s\n' database-ready`
}

function phpFpmCommand (profile, application) {
  const lines = [`[${application.project}]`, `user = ${profile.phpFpmUser}`, `group = ${profile.phpFpmGroup}`, `listen = ${profile.phpFpmListener}`, `listen.owner = ${profile.phpFpmUser}`, `listen.group = ${profile.phpFpmGroup}`, 'listen.mode = 0660', 'pm = ondemand', 'pm.max_children = 8', 'pm.process_idle_timeout = 10s', 'pm.max_requests = 500']
  const extensions = profile.phpExtensionConfig
    ? `install -d -o root -g root -m 0755 ${quote(profile.phpExtensionConfig.slice(0, profile.phpExtensionConfig.lastIndexOf('/')))}; ext_candidate=$(mktemp); printf '%s\n' ${profile.phpExtensionsToEnable.map(item => quote(`extension=${item}`)).join(' ')} > "$ext_candidate"; if ! cmp -s "$ext_candidate" ${quote(profile.phpExtensionConfig)}; then install -o root -g root -m 0644 "$ext_candidate" ${quote(profile.phpExtensionConfig)}; changed=yes; fi; rm -f -- "$ext_candidate";`
    : ''
  return `set -eu; changed=; ${extensions} install -d -o root -g root -m 0755 ${quote(profile.phpFpmPool.slice(0, profile.phpFpmPool.lastIndexOf('/')))}; install -d -o ${quote(profile.phpFpmUser)} -g ${quote(profile.phpFpmGroup)} -m 0750 ${quote(profile.phpFpmRuntimeDirectory)}; pool_candidate=$(mktemp); printf '%s\n' ${lines.map(quote).join(' ')} > "$pool_candidate"; if ! cmp -s "$pool_candidate" ${quote(profile.phpFpmPool)}; then install -o root -g root -m 0644 "$pool_candidate" ${quote(profile.phpFpmPool)}; changed=yes; fi; rm -f -- "$pool_candidate"; ${profile.phpFpmBinary} -t; if [ -n "$changed" ] || ! ${serviceActive(profile.phpFpmService)}; then ${serviceRestart(profile.phpFpmService, profileFamily(profile))}; fi; ${serviceActive(profile.phpFpmService)}; ready=; for attempt in $(seq 1 30); do if test -S ${quote(profile.phpFpmListener)}; then ready=yes; break; fi; sleep 1; done; if [ "$ready" != yes ]; then ls -ld ${quote(profile.phpFpmRuntimeDirectory)} >&2 || true; ls -la ${quote(profile.phpFpmRuntimeDirectory)} >&2 || true; exit 1; fi; printf '%s\n' php-fpm-ready`
}

function nginxCommand ({ state, profile, application }) {
  const lines = ['server {', `    listen 0.0.0.0:${application.port};`, '    server_name _;', `    root ${application.webRoot};`, '    index index.php index.html;', '    location / { try_files $uri $uri/ /index.php?$args; }', `    location ~ \\.php$ { include fastcgi_params; fastcgi_pass ${profile.nginxFastcgiPass}; fastcgi_param HTTP_HOST $http_host; fastcgi_param SERVER_PORT $server_port; fastcgi_param REQUEST_SCHEME $scheme; fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name; }`, '}']
  const include = profile.nginxIncludeRequired ? `if [ ! -f ${quote(`${state}/nginx.conf.before`)} ]; then cp -a ${quote(profile.nginxMainConfig)} ${quote(`${state}/nginx.conf.before`)}; fi; grep -Fqx ${quote(`    ${profile.nginxIncludeDirective}`)} ${quote(profile.nginxMainConfig)} || sed -i '$i\\    ${escapeSed(profile.nginxIncludeDirective)}' ${quote(profile.nginxMainConfig)};` : ''
  const link = profile.nginxEnableLink ? `ln -sfn ${quote(profile.nginxVhost)} ${quote(profile.nginxEnableLink)};` : ''
  return `set -eu; ${include} install -d -o root -g root -m 0755 ${quote(profile.nginxVhost.slice(0, profile.nginxVhost.lastIndexOf('/')))}; printf '%s\n' ${lines.map(quote).join(' ')} > ${quote(profile.nginxVhost)}; ${link} nginx -t; ${serviceRestart(profile.nginxService, profileFamily(profile))}; printf '%s\n' nginx-ready`
}

function nativeRevert ({ state, family, profile, services, application }) {
  return [
    item('remove-application-database', 'cleanup', `set +e; [ -d ${quote(state)} ] || exit 0; printf "DROP DATABASE IF EXISTS ${application.database}; DROP USER IF EXISTS '${application.database}'@'localhost'; DROP USER IF EXISTS '${application.database}'@'127.0.0.1'; FLUSH PRIVILEGES;\n" | mariadb --protocol=socket -uroot >/dev/null 2>&1 || true; exit 0`, 'Drop only the task-owned database and local users', []),
    item('remove-application-files', 'cleanup', `set -eu; rm -rf -- ${quote(application.webRoot)} ${quote(application.artifacts)} ${quote(application.credentials)} ${quote(profile.phpFpmRuntimeDirectory)}; rm -f -- ${quote(profile.phpFpmPool)} ${quote(profile.nginxVhost)} ${profile.phpExtensionConfig ? quote(profile.phpExtensionConfig) : ''} ${profile.nginxEnableLink ? quote(profile.nginxEnableLink) : ''}; ${profile.nginxIncludeRequired ? `if [ -f ${quote(`${state}/nginx.conf.before`)} ]; then cp -a ${quote(`${state}/nginx.conf.before`)} ${quote(profile.nginxMainConfig)}; fi` : ':'}; printf '%s\n' files-removed`, 'Remove only task-owned application and service configuration', ['remove-application-database']),
    item('restore-packages-services', 'cleanup', restoreCommand({ state, family, services }), 'Restore service activity and remove only task-added packages', ['remove-application-files'])
  ]
}

function composeBaseline (state, application) {
  return `set -eu; if [ ! -s ${quote(`${state}/packages.before`)} ]; then test ! -e ${quote(application.serviceRoot)}; test ! -e ${quote(application.credentials)}; install -d -o root -g root -m 0700 ${quote(state)}; ${packageSnapshot('debian', quote(`${state}/packages.before`))}; if systemctl is-active --quiet docker 2>/dev/null; then : > ${quote(`${state}/docker-service.active`)}; fi; ${application.images.map((image, index) => `if command -v docker >/dev/null 2>&1 && docker image inspect ${quote(image)} >/dev/null 2>&1; then : > ${quote(`${state}/image-${index}.existed`)}; fi`).join('; ')}; fi; printf '%s\n' baseline-ready`
}

function prepareDocker (state) {
  return `set -eu; if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then . /etc/os-release; vendor="$ID"; codename="${'$'}{UBUNTU_CODENAME:-$VERSION_CODENAME}"; arch=$(dpkg --print-architecture); env DEBIAN_FRONTEND=noninteractive apt-get update; env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl; install -d -m 0755 /etc/apt/keyrings; curl --fail --location --silent --show-error "https://download.docker.com/linux/$vendor/gpg" --output /etc/apt/keyrings/docker.asc; printf '%s\n' 'Types: deb' "URIs: https://download.docker.com/linux/$vendor" "Suites: $codename" 'Components: stable' "Architectures: $arch" 'Signed-By: /etc/apt/keyrings/docker.asc' > /etc/apt/sources.list.d/docker.sources; apt-get update; apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; systemctl start docker; fi; ${packageSnapshot('debian', quote(`${state}/packages.after`))}; LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} > ${quote(`${state}/packages.added`)} || true; docker info >/dev/null; docker compose version >/dev/null; printf '%s\n' docker-ready`
}

function composePull (state, application) {
  return `set -eu; cd ${quote(application.serviceRoot)}; docker compose -p ${quote(application.project)} --profile tools pull; ${application.images.map((image, index) => `docker image inspect ${quote(image)} --format '{{.Id}}' > ${quote(`${state}/image-${index}.after`)}`).join('; ')}; printf '%s\n' images-pulled`
}

function composeRevert (state, application) {
  return [
    item('remove-compose-project', 'cleanup', `set +e; if [ -f ${quote(`${application.serviceRoot}/compose.yaml`)} ] && command -v docker >/dev/null 2>&1; then cd ${quote(application.serviceRoot)}; docker compose -p ${quote(application.project)} down --volumes --remove-orphans; fi; exit 0`, 'Remove task-owned Compose containers, networks, and volumes'),
    item('remove-compose-images', 'cleanup', `set +e; ${application.images.map((image, index) => `[ -e ${quote(`${state}/image-${index}.existed`)} ] || docker image rm ${quote(image)} >/dev/null 2>&1 || true`).join('; ')}; exit 0`, 'Remove only images absent from the captured baseline', ['remove-compose-project']),
    item('remove-compose-files', 'cleanup', `rm -rf -- ${quote(application.serviceRoot)} ${quote(application.credentials)}`, 'Remove task-owned Compose and credential files', ['remove-compose-images']),
    item('restore-docker', 'cleanup', `set +e; ${removeAddedPackages('debian', state)}; rm -rf -- ${quote(state)}; exit 0`, 'Restore task-added Docker package state while preserving Stage 2 prerequisites', ['remove-compose-files'])
  ]
}

function restoreCommand ({ state, family, services }) {
  const restore = services.map((service, index) => `[ -e ${quote(`${state}/service-${index}.active`)} ] && ${serviceRestart(service, family)} || ${serviceStop(service, family)}`).join('; ')
  return `set +e; [ -d ${quote(state)} ] || exit 0; ${restore}; ${removeAddedPackages(family, state)}; [ -e ${quote(`${state}/database-data.existed`)} ] || rm -rf -- /var/lib/mysql /run/mysqld /run/mariadb; rm -rf -- ${quote(state)}; exit 0`
}

function packageSnapshot (family, destination) {
  if (family === 'debian') return `dpkg-query -W -f='\${binary:Package}\\n' | LC_ALL=C sort -u > ${destination}`
  if (family === 'alpine') return `apk info | LC_ALL=C sort -u > ${destination}`
  if (family === 'arch') return `pacman -Qq | LC_ALL=C sort -u > ${destination}`
  return `rpm -qa --qf '%{NAME}\\n' | LC_ALL=C sort -u > ${destination}`
}

function packageInstall (family, packages) {
  const list = packages.map(quote).join(' ')
  if (family === 'debian') return `env DEBIAN_FRONTEND=noninteractive apt-get update; env DEBIAN_FRONTEND=noninteractive apt-get install --no-upgrade -y ${list}`
  if (family === 'alpine') return `apk add --no-cache ${list}`
  if (family === 'arch') return `pacman -Sy --noconfirm --needed ${list}`
  if (family === 'suse') return `zypper --non-interactive refresh --force; zypper --non-interactive install --no-recommends ${list}`
  return `dnf -y install ${list}`
}

function removeAddedPackages (family, state) {
  const file = quote(`${state}/packages.added`)
  if (family === 'debian') return `[ ! -s ${file} ] || env DEBIAN_FRONTEND=noninteractive xargs -r apt-get purge -y -- < ${file}`
  if (family === 'alpine') return `[ ! -s ${file} ] || xargs -r apk del < ${file}`
  if (family === 'arch') return `[ ! -s ${file} ] || xargs -r pacman -Rns --noconfirm -- < ${file}`
  if (family === 'suse') return `[ ! -s ${file} ] || xargs -r zypper --non-interactive remove --clean-deps -- < ${file}`
  return `[ ! -s ${file} ] || xargs -r dnf -y remove < ${file}`
}

function serviceActive (service) { return service.endsWith('.service') ? `systemctl is-active --quiet ${quote(service)}` : `rc-service ${quote(service)} status >/dev/null 2>&1` }
function serviceRestart (service, family) { return family === 'alpine' ? `rc-service ${quote(service)} restart >/dev/null 2>&1 || rc-service ${quote(service)} start >/dev/null 2>&1` : `systemctl restart ${quote(service)}` }
function serviceStop (service, family) { return family === 'alpine' ? `rc-service ${quote(service)} stop >/dev/null 2>&1 || true` : `systemctl stop ${quote(service)} >/dev/null 2>&1 || true` }
function profileFamily (profile) { return profile.phpFpmService.endsWith('.service') ? 'systemd' : 'alpine' }
function nativePaths (application, profile, state) { return [state, application.artifacts, application.webRoot, application.credentials, profile.phpFpmRuntimeDirectory, profile.phpFpmPool, profile.nginxVhost, ...(profile.phpExtensionConfig ? [profile.phpExtensionConfig] : []), ...(profile.nginxEnableLink ? [profile.nginxEnableLink] : []), ...(profile.nginxIncludeRequired ? [profile.nginxMainConfig] : [])] }
function pathProbe (paths) { return `for path in ${paths.map(quote).join(' ')}; do if [ -e "$path" ]; then printf 'present=%s\\n' "$path"; else printf 'absent=%s\\n' "$path"; fi; done` }
function item (id, phase, command, purpose, dependsOn = [], timeoutMs = 300000, executionMode) { return { id, phase, command, purpose, risk: 'change', timeoutMs, requiresSudo: true, dependsOn, ...(executionMode ? { executionMode } : {}) } }
function escapeSed (value) { return String(value).replaceAll('\\', '\\\\').replaceAll('&', '\\&') }
function quote (value) { return `'${String(value).replaceAll("'", "'\\''")}'` }

function validateInputs (taskId, linuxContext, application) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  if (!linuxContext?.applications?.wordpress || !linuxContext?.management?.family) throw new Error('Linux PHP foundation requires a current host profile')
  for (const key of ['id', 'label', 'project', 'webRoot', 'artifacts', 'credentials', 'database', 'serviceRoot', 'marker']) if (!application?.[key]) throw new TypeError(`Linux PHP foundation application is missing ${key}`)
  if (!Number.isInteger(application.port) || application.port < 1 || application.port > 65535 || !Array.isArray(application.images)) throw new TypeError('Linux PHP foundation application has invalid port or images')
}
