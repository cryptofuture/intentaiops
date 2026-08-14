const SITE = 'webminai-wordpress-18101'
const WEB_ROOT = `/srv/${SITE}`
const ARTIFACTS = `/var/lib/webminai/${SITE}`
const CREDENTIALS = '/root/wordpress_credentials'
const DATABASE = 'webminai_wordpress_18101'

export function buildWordpressLinuxTask (taskId, linuxContext) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  const profile = linuxContext?.applications?.wordpress
  const family = linuxContext?.management?.family ?? linuxContext?.family
  if (!profile || !family) throw new Error('learned WordPress task requires a current Linux host context')
  assertProfile(profile)
  const state = `/var/lib/webminai/task-state/${taskId}-wordpress-linux`
  const services = [profile.mariadbService, profile.phpFpmService, profile.nginxService]
  const modifiedFiles = [
    state,
    ARTIFACTS,
    WEB_ROOT,
    CREDENTIALS,
    profile.phpFpmRuntimeDirectory,
    profile.phpFpmPool,
    profile.nginxVhost,
    ...(profile.phpExtensionConfig ? [profile.phpExtensionConfig] : []),
    ...(profile.nginxEnableLink ? [profile.nginxEnableLink] : []),
    ...(profile.nginxIncludeRequired ? [profile.nginxMainConfig] : [])
  ]
  const commands = [
    command('capture-baseline', baselineCommand({ state, family, profile, services }), 'Capture package, service, database, and path state before changing the host'),
    command('install-packages', installPackagesCommand({ state, family, profile }), 'Install the reviewed distro-specific native WordPress stack', ['capture-baseline']),
    command('verify-artifacts', artifactCommand(), 'Download and verify official WordPress and WP-CLI artifacts', ['install-packages']),
    command('generate-credentials', credentialsCommand(), 'Generate protected task-owned database and administrator credentials on the host', ['capture-baseline']),
    command('prepare-database', databaseCommand({ family, profile }), 'Initialize MariaDB, wait for readiness, and create only the task-owned database identity', ['install-packages', 'generate-credentials']),
    command('extract-wordpress', extractCommand(profile), 'Extract verified WordPress core with explicit application ownership and permissions', ['verify-artifacts']),
    command('configure-php-fpm', phpFpmCommand(profile), 'Create the reviewed PHP-FPM pool and start its task-owned Unix socket', ['install-packages', 'extract-wordpress']),
    command('configure-nginx', nginxCommand({ state, profile }), 'Create and load the reviewed nginx virtual host on port 18101', ['configure-php-fpm']),
    command('install-wordpress', wordpressCommand(profile), 'Configure and install WordPress using protected stdin prompts', ['prepare-database', 'configure-nginx']),
    command('publish-and-verify', publishCommand(profile), 'Publish the marker page and verify database, HTTP, and restart persistence', ['install-wordpress'])
  ]
  const revertCommands = [
    command('remove-wordpress-database', removeDatabaseCommand(state), 'Drop only the task-owned WordPress database and local users'),
    command('remove-wordpress-files', removeFilesCommand({ state, profile }), 'Remove task-owned site, credentials, artifacts, and configuration, restoring nginx main configuration', ['remove-wordpress-database']),
    command('restore-packages-services', restoreCommand({ state, family, profile, services }), 'Restore service activity, package state, and database data-directory baseline', ['remove-wordpress-files'])
  ]
  return {
    plan: {
      summary: 'Deploy a learned reversible native WordPress site',
      changeOverview: 'Use the verified distro profile to deploy nginx, PHP-FPM, MariaDB, and WordPress on port 18101 with host-generated protected credentials.',
      modifiedFiles,
      assumptions: [
        `Authoritative Linux profile: ${linuxContext.identity?.id ?? family} ${linuxContext.identity?.versionId ?? ''}`.trim(),
        'Docker is disabled for this native fleet validation.',
        'Task-owned paths and database identities must be absent before execution.'
      ],
      warnings: ['This learned task executes as root and intentionally serves HTTP on isolated test port 18101.'],
      requiresConfirmation: true,
      commands,
      revertCommands
    },
    verifyApplied: `test -S ${quote(profile.phpFpmListener)} && ${profile.phpBinary} ${quote(profile.wpCliPhar)} --allow-root --path=${quote(profile.webRoot)} core is-installed >/dev/null && curl --fail --silent --show-error --max-time 10 http://127.0.0.1:18101/ | grep -Fq WEBMINAI_WORDPRESS_OK`,
    verifyReverted: `test ! -e ${quote(WEB_ROOT)} && test ! -e ${quote(ARTIFACTS)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(profile.phpFpmRuntimeDirectory)} && test ! -e ${quote(profile.phpFpmPool)} && test ! -e ${quote(profile.nginxVhost)} && test ! -e ${quote(state)}`,
    stateProbe: `for path in ${[WEB_ROOT, ARTIFACTS, CREDENTIALS, profile.phpFpmRuntimeDirectory, profile.phpFpmPool, profile.nginxVhost, state].map(quote).join(' ')}; do if [ -e "$path" ]; then printf 'present=%s\n' "$path"; else printf 'absent=%s\n' "$path"; fi; done`
  }
}

function baselineCommand ({ state, family, profile, services }) {
  const targets = [WEB_ROOT, ARTIFACTS, CREDENTIALS, profile.phpFpmRuntimeDirectory, profile.phpFpmPool, profile.nginxVhost, ...(profile.phpExtensionConfig ? [profile.phpExtensionConfig] : [])]
  return [
    'set -eu',
    `state=${quote(state)}`,
    'if [ ! -s "$state/packages.before" ]; then :',
    `for path in ${targets.map(quote).join(' ')}; do [ ! -e "$path" ] || { printf 'task target already exists: %s\n' "$path" >&2; exit 1; }; done`,
    'install -d -o root -g root -m 0700 "$state"',
    packageSnapshot(family, '"$state/packages.before"'),
    ...services.map((service, index) => `${serviceActive(service)} && : > "$state/service-${index}.active" || true`),
    '[ ! -d /var/lib/mysql/mysql ] || : > "$state/database-data.existed"',
    profile.nginxIncludeRequired ? `if [ -f ${quote(profile.nginxMainConfig)} ]; then cp -a ${quote(profile.nginxMainConfig)} "$state/nginx.conf.before"; fi` : ':',
    'fi',
    "printf '%s\n' baseline-ready"
  ].join('; ')
}

function installPackagesCommand ({ state, family, profile }) {
  return [
    'set -eu',
    installPackages(family, profile.packages),
    packageSnapshot(family, '"$state/packages.after"'.replace('$state', state)),
    `LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} | grep -Ev '^(curl|netdata|netdata-|openssh|openssh-|webminai|webminai-)' > ${quote(`${state}/packages.added`)} || true`,
    "printf '%s\n' packages-ready"
  ].join('; ')
}

function artifactCommand () {
  return [
    'set -eu',
    `install -d -o root -g root -m 0755 ${quote(ARTIFACTS)}`,
    `if [ -s ${quote(`${ARTIFACTS}/wordpress.tar.gz`)} ] && [ -s ${quote(`${ARTIFACTS}/wordpress.tar.gz.sha1`)} ] && [ -s ${quote(`${ARTIFACTS}/wp-cli.phar`)} ] && [ -s ${quote(`${ARTIFACTS}/wp-cli.phar.sha512`)} ]; then wp_expected=$(tr -d '\r\n' < ${quote(`${ARTIFACTS}/wordpress.tar.gz.sha1`)}); wp_actual=$(sha1sum ${quote(`${ARTIFACTS}/wordpress.tar.gz`)} | awk '{print $1}'); cli_expected=$(tr -d '\r\n' < ${quote(`${ARTIFACTS}/wp-cli.phar.sha512`)}); cli_actual=$(sha512sum ${quote(`${ARTIFACTS}/wp-cli.phar`)} | awk '{print $1}'); if [ "$wp_actual" = "$wp_expected" ] && [ "$cli_actual" = "$cli_expected" ]; then printf '%s\n' artifacts-already-verified; exit 0; fi; fi`,
    `curl --fail --location --silent --show-error --output ${quote(`${ARTIFACTS}/wordpress.tar.gz`)} https://wordpress.org/latest.tar.gz`,
    `curl --fail --location --silent --show-error --output ${quote(`${ARTIFACTS}/wordpress.tar.gz.sha1`)} https://wordpress.org/latest.tar.gz.sha1`,
    `expected=$(tr -d '\\r\\n' < ${quote(`${ARTIFACTS}/wordpress.tar.gz.sha1`)})`,
    'printf \'%s\' "$expected" | grep -Eq \'^[0-9A-Fa-f]{40}$\'',
    `actual=$(sha1sum ${quote(`${ARTIFACTS}/wordpress.tar.gz`)} | awk '{print $1}')`,
    '[ "$actual" = "$expected" ]',
    `curl --fail --location --silent --show-error --output ${quote(`${ARTIFACTS}/wp-cli.phar`)} https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar`,
    `curl --fail --location --silent --show-error --output ${quote(`${ARTIFACTS}/wp-cli.phar.sha512`)} https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar.sha512`,
    `expected=$(tr -d '\\r\\n' < ${quote(`${ARTIFACTS}/wp-cli.phar.sha512`)})`,
    'printf \'%s\' "$expected" | grep -Eq \'^[0-9A-Fa-f]{128}$\'',
    `actual=$(sha512sum ${quote(`${ARTIFACTS}/wp-cli.phar`)} | awk '{print $1}')`,
    '[ "$actual" = "$expected" ]',
    `chmod 0755 ${quote(`${ARTIFACTS}/wp-cli.phar`)}`,
    'printf \'%s\n\' artifacts-verified'
  ].join('; ')
}

function credentialsCommand () {
  return `set -eu; umask 077; install -d -o root -g root -m 0700 ${quote(CREDENTIALS)}; [ -s ${quote(`${CREDENTIALS}/db_password`)} ] || openssl rand -hex 32 > ${quote(`${CREDENTIALS}/db_password`)}; [ -s ${quote(`${CREDENTIALS}/admin_password`)} ] || openssl rand -hex 32 > ${quote(`${CREDENTIALS}/admin_password`)}; chmod 0600 ${quote(`${CREDENTIALS}/db_password`)} ${quote(`${CREDENTIALS}/admin_password`)}; printf '%s\n' credentials-ready`
}

function databaseCommand ({ family, profile }) {
  const databaseHost = profile.databaseHost
  return [
    'set -eu',
    'initialized=; if [ ! -d /var/lib/mysql/mysql ]; then mariadb-install-db --user=mysql --basedir=/usr --datadir=/var/lib/mysql >/dev/null; initialized=yes; fi',
    'install -d -o mysql -g mysql -m 0755 /run/mariadb /run/mysqld',
    `if [ -n "$initialized" ] || ! ${serviceActive(profile.mariadbService)}; then ${serviceRestart(profile.mariadbService, family)}; fi`,
    "ready=; for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do if mariadb --protocol=socket -uroot -e 'SELECT 1' >/dev/null 2>&1; then ready=yes; break; fi; sleep 1; done; [ \"$ready\" = yes ]",
    `dbpass=$(sed -n 1p ${quote(`${CREDENTIALS}/db_password`)})`,
    `printf "CREATE DATABASE IF NOT EXISTS ${DATABASE} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER IF NOT EXISTS '${DATABASE}'@'${databaseHost}' IDENTIFIED BY '%s'; ALTER USER '${DATABASE}'@'${databaseHost}' IDENTIFIED BY '%s'; GRANT ALL PRIVILEGES ON ${DATABASE}.* TO '${DATABASE}'@'${databaseHost}'; FLUSH PRIVILEGES;\n" "$dbpass" "$dbpass" | mariadb --protocol=socket -uroot >/dev/null 2>&1`,
    'printf \'%s\n\' database-ready'
  ].join('; ')
}

function extractCommand (profile) {
  return [
    'set -eu',
    `if [ ! -f ${quote(`${WEB_ROOT}/wp-includes/version.php`)} ]; then :`,
    `work=$(mktemp -d ${quote('/var/lib/webminai/wordpress-extract.XXXXXX')})`,
    'trap \'rm -rf -- "$work"\' EXIT',
    `tar -xzf ${quote(`${ARTIFACTS}/wordpress.tar.gz`)} -C "$work"`,
    '[ -d "$work/wordpress" ]',
    `mv "$work/wordpress" ${quote(WEB_ROOT)}`,
    `chown -R ${quote(`${profile.phpFpmUser}:${profile.phpFpmGroup}`)} ${quote(WEB_ROOT)}`,
    `find ${quote(WEB_ROOT)} -type d -exec chmod 0755 {} +`,
    `find ${quote(WEB_ROOT)} -type f -exec chmod 0644 {} +`,
    'trap - EXIT; rm -rf -- "$work"',
    'fi',
    'printf \'%s\n\' files-ready'
  ].join('; ')
}

function phpFpmCommand (profile) {
  const poolLines = [
    `[${SITE}]`,
    `user = ${profile.phpFpmUser}`,
    `group = ${profile.phpFpmGroup}`,
    `listen = ${profile.phpFpmListener}`,
    `listen.owner = ${profile.phpFpmUser}`,
    `listen.group = ${profile.phpFpmGroup}`,
    'listen.mode = 0660',
    'pm = ondemand',
    'pm.max_children = 8',
    'pm.process_idle_timeout = 10s',
    'pm.max_requests = 500'
  ]
  const extension = profile.phpExtensionConfig
    ? `install -d -o root -g root -m 0755 ${quote(profile.phpExtensionConfig.slice(0, profile.phpExtensionConfig.lastIndexOf('/')))}; ext_candidate=$(mktemp); printf '%s\n' ${profile.phpExtensionsToEnable.map(item => quote(`extension=${item}`)).join(' ')} > "$ext_candidate"; if ! cmp -s "$ext_candidate" ${quote(profile.phpExtensionConfig)}; then install -o root -g root -m 0644 "$ext_candidate" ${quote(profile.phpExtensionConfig)}; changed=yes; fi; rm -f -- "$ext_candidate";`
    : ''
  return `set -eu; changed=; ${extension} install -d -o root -g root -m 0755 ${quote(profile.phpFpmPool.slice(0, profile.phpFpmPool.lastIndexOf('/')))}; install -d -o ${quote(profile.phpFpmUser)} -g ${quote(profile.phpFpmGroup)} -m 0750 ${quote(profile.phpFpmRuntimeDirectory)}; pool_candidate=$(mktemp); printf '%s\n' ${poolLines.map(quote).join(' ')} > "$pool_candidate"; if ! cmp -s "$pool_candidate" ${quote(profile.phpFpmPool)}; then install -o root -g root -m 0644 "$pool_candidate" ${quote(profile.phpFpmPool)}; changed=yes; fi; rm -f -- "$pool_candidate"; ${profile.phpFpmBinary} -t; if [ -n "$changed" ] || ! ${serviceActive(profile.phpFpmService)}; then ${serviceRestart(profile.phpFpmService, profileFamily(profile))}; fi; ${serviceActive(profile.phpFpmService)}; ready=; for attempt in $(seq 1 30); do if test -S ${quote(profile.phpFpmListener)}; then ready=yes; break; fi; sleep 1; done; if [ "$ready" != yes ]; then ls -ld ${quote(profile.phpFpmRuntimeDirectory)} >&2 || true; ls -la ${quote(profile.phpFpmRuntimeDirectory)} >&2 || true; exit 1; fi; printf '%s\n' php-fpm-ready`
}

function nginxCommand ({ state, profile }) {
  const lines = [
    'server {',
    '    listen 0.0.0.0:18101;',
    '    server_name _;',
    `    root ${WEB_ROOT};`,
    '    index index.php index.html;',
    '    location / {',
    '        try_files $uri $uri/ /index.php?$args;',
    '    }',
    '    location ~ \\.php$ {',
    '        include fastcgi_params;',
    `        fastcgi_pass ${profile.nginxFastcgiPass};`,
    '        fastcgi_param HTTP_HOST $http_host;',
    '        fastcgi_param SERVER_PORT $server_port;',
    '        fastcgi_param REQUEST_SCHEME $scheme;',
    '        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;',
    '    }',
    '}'
  ]
  const include = profile.nginxIncludeRequired
    ? `if [ ! -f ${quote(`${state}/nginx.conf.before`)} ]; then cp -a ${quote(profile.nginxMainConfig)} ${quote(`${state}/nginx.conf.before`)}; fi; if ! grep -Fqx ${quote(`    ${profile.nginxIncludeDirective}`)} ${quote(profile.nginxMainConfig)}; then sed -i '$i\\    ${escapeSed(profile.nginxIncludeDirective)}' ${quote(profile.nginxMainConfig)}; changed=yes; fi;`
    : ''
  const link = profile.nginxEnableLink ? `if [ ! -L ${quote(profile.nginxEnableLink)} ]; then ln -s ${quote(profile.nginxVhost)} ${quote(profile.nginxEnableLink)}; changed=yes; fi;` : ''
  return `set -eu; changed=; ${include} install -d -o root -g root -m 0755 ${quote(profile.nginxVhost.slice(0, profile.nginxVhost.lastIndexOf('/')))}; nginx_candidate=$(mktemp); printf '%s\n' ${lines.map(quote).join(' ')} > "$nginx_candidate"; if ! cmp -s "$nginx_candidate" ${quote(profile.nginxVhost)}; then install -o root -g root -m 0644 "$nginx_candidate" ${quote(profile.nginxVhost)}; changed=yes; fi; rm -f -- "$nginx_candidate"; ${link} if [ -n "$changed" ] || ! ${serviceActive(profile.nginxService)}; then ${serviceRestart(profile.nginxService, profileFamily(profile))}; fi; ${serviceActive(profile.nginxService)}; printf '%s\n' nginx-ready`
}

function wordpressCommand (profile) {
  return [
    'set -eu',
    `address=$(${profile.primaryAddressCommand})`,
    '[ -n "$address" ]',
    'url="http://$address:18101"',
    `dbpass=$(sed -n 1p ${quote(`${CREDENTIALS}/db_password`)})`,
    `if [ ! -f ${quote(`${WEB_ROOT}/wp-config.php`)} ]; then printf '%s\n' "$dbpass" | ${quote(profile.phpBinary)} ${quote(profile.wpCliPhar)} config create --allow-root --path=${quote(profile.webRoot)} --dbname=${DATABASE} --dbuser=${DATABASE} --dbhost=${quote(profile.databaseHost)} --prompt=dbpass --skip-check >/dev/null 2>&1; fi`,
    `if ! ${quote(profile.phpBinary)} ${quote(profile.wpCliPhar)} core is-installed --allow-root --path=${quote(profile.webRoot)} >/dev/null 2>&1; then adminpass=$(sed -n 1p ${quote(`${CREDENTIALS}/admin_password`)}); printf '%s\n' "$adminpass" | ${quote(profile.phpBinary)} ${quote(profile.wpCliPhar)} core install --allow-root --path=${quote(profile.webRoot)} --url="$url" --title=${quote('Intent AI Ops WordPress 18101')} --admin_user=webminai_admin --admin_email=intentaiops@example.invalid --skip-email --prompt=admin_password >/dev/null 2>&1; fi`,
    `chown ${quote(`${profile.phpFpmUser}:${profile.phpFpmGroup}`)} ${quote(`${WEB_ROOT}/wp-config.php`)}`,
    `chmod 0640 ${quote(`${WEB_ROOT}/wp-config.php`)}`,
    "printf '%s\n' wordpress-installed"
  ].join('; ')
}

function publishCommand (profile) {
  const wp = `${quote(profile.phpBinary)} ${quote(profile.wpCliPhar)} --allow-root --path=${quote(profile.webRoot)}`
  return [
    'set -eu',
    `page=$(${wp} post list --post_type=page --name=webminai-compatibility-marker --field=ID --format=ids | awk 'NR == 1 { print; exit }')`,
    `if [ -z "$page" ]; then page=$(${wp} post create --post_type=page --post_status=publish --post_name=webminai-compatibility-marker --post_title=${quote('WebminAI Compatibility Marker')} --post_content=WEBMINAI_WORDPRESS_OK --porcelain); elif [ "$(${wp} post get "$page" --field=post_status)" != publish ] || [ "$(${wp} post get "$page" --field=post_title)" != ${quote('WebminAI Compatibility Marker')} ] || [ "$(${wp} post get "$page" --field=post_content)" != WEBMINAI_WORDPRESS_OK ]; then ${wp} post update "$page" --post_status=publish --post_title=${quote('WebminAI Compatibility Marker')} --post_content=WEBMINAI_WORDPRESS_OK >/dev/null; fi`,
    'case "$page" in \'\'|*[!0-9]*) exit 1;; esac',
    `[ "$(${wp} option get show_on_front 2>/dev/null || true)" = page ] || ${wp} option update show_on_front page >/dev/null`,
    `[ "$(${wp} option get page_on_front 2>/dev/null || true)" = "$page" ] || ${wp} option update page_on_front "$page" >/dev/null`,
    `${wp} core is-installed >/dev/null`,
    `${wp} db check >/dev/null`,
    `address=$(${profile.primaryAddressCommand})`,
    'body=$(curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 --max-time 10 "http://$address:18101/")',
    'printf \'%s\' "$body" | grep -Fq WEBMINAI_WORDPRESS_OK',
    'printf \'%s\n\' verification-passed'
  ].join('; ')
}

function removeDatabaseCommand (state) {
  return `set +e; [ -d ${quote(state)} ] || exit 0; if command -v mariadb >/dev/null 2>&1; then printf "DROP DATABASE IF EXISTS ${DATABASE}; DROP USER IF EXISTS '${DATABASE}'@'localhost'; DROP USER IF EXISTS '${DATABASE}'@'127.0.0.1'; FLUSH PRIVILEGES;\n" | mariadb --protocol=socket -uroot >/dev/null 2>&1 || true; fi; exit 0`
}

function removeFilesCommand ({ state, profile }) {
  return [
    'set -eu',
    `rm -rf -- ${quote(WEB_ROOT)} ${quote(ARTIFACTS)} ${quote(CREDENTIALS)} ${quote(profile.phpFpmRuntimeDirectory)}`,
    `rm -f -- ${quote(profile.phpFpmPool)} ${quote(profile.nginxVhost)}`,
    profile.phpExtensionConfig ? `rm -f -- ${quote(profile.phpExtensionConfig)}` : ':',
    profile.nginxEnableLink ? `rm -f -- ${quote(profile.nginxEnableLink)}` : ':',
    profile.nginxIncludeRequired ? `if [ -f ${quote(`${state}/nginx.conf.before`)} ]; then cp -a ${quote(`${state}/nginx.conf.before`)} ${quote(profile.nginxMainConfig)}; fi` : ':',
    "printf '%s\n' files-removed"
  ].join('; ')
}

function restoreCommand ({ state, family, profile, services }) {
  const restoreServices = services.map((service, index) => `if [ -e ${quote(`${state}/service-${index}.active`)} ]; then ${serviceRestart(service, family)}; else ${serviceStop(service, family)}; fi`).join('; ')
  return [
    'set +e',
    `[ -d ${quote(state)} ] || exit 0`,
    restoreServices,
    removeAddedPackages(family, state),
    `[ -e ${quote(`${state}/database-data.existed`)} ] || rm -rf -- /var/lib/mysql /run/mysqld /run/mariadb`,
    `rm -rf -- ${quote(state)}`,
    'exit 0'
  ].join('; ')
}

function packageSnapshot (family, destination) {
  if (family === 'debian') return `dpkg-query -W -f='\${binary:Package}\n' | LC_ALL=C sort -u > ${destination}`
  if (family === 'alpine') return `apk info | LC_ALL=C sort -u > ${destination}`
  if (family === 'arch') return `pacman -Qq | LC_ALL=C sort -u > ${destination}`
  return `rpm -qa --qf '%{NAME}\n' | LC_ALL=C sort -u > ${destination}`
}

function installPackages (family, packages) {
  const list = packages.map(quote).join(' ')
  if (family === 'debian') return `env DEBIAN_FRONTEND=noninteractive apt-get update; env DEBIAN_FRONTEND=noninteractive apt-get install -y ${list}`
  if (family === 'alpine') return `apk add --no-cache ${list}`
  if (family === 'arch') return `pacman -Sy --noconfirm --needed ${list}`
  if (family === 'suse') return `zypper --non-interactive refresh --force; zypper --non-interactive install --no-recommends ${list}`
  return `dnf -y install ${list}`
}

function removeAddedPackages (family, state) {
  const prepare = `filtered=${quote(`${state}/packages.remove`)}; grep -Ev '^(curl|netdata|netdata-|openssh|openssh-|webminai|webminai-)' ${quote(`${state}/packages.added`)} > "$filtered" || true; if [ -s "$filtered" ]; then `
  if (family === 'debian') return `${prepare}env DEBIAN_FRONTEND=noninteractive xargs -r apt-get purge -y -- < "$filtered"; fi`
  if (family === 'alpine') return `${prepare}xargs -r apk del < "$filtered"; fi`
  if (family === 'arch') return `${prepare}xargs -r pacman -Rns --noconfirm -- < "$filtered"; fi`
  if (family === 'suse') return `${prepare}xargs -r zypper --non-interactive remove --clean-deps -- < "$filtered"; fi`
  return `${prepare}xargs -r dnf -y remove < "$filtered"; fi`
}

function serviceActive (service) {
  if (service.endsWith('.service')) return `systemctl is-active --quiet ${quote(service)}`
  return `rc-service ${quote(service)} status >/dev/null 2>&1`
}

function serviceRestart (service, family) {
  if (family === 'alpine') return `rc-service ${quote(service)} restart >/dev/null 2>&1 || rc-service ${quote(service)} start >/dev/null 2>&1`
  return `systemctl restart ${quote(service)}`
}

function serviceStop (service, family) {
  if (family === 'alpine') return `rc-service ${quote(service)} stop >/dev/null 2>&1 || true`
  return `systemctl stop ${quote(service)} >/dev/null 2>&1 || true`
}

function profileFamily (profile) {
  return profile.phpFpmService.endsWith('.service') ? 'systemd' : 'alpine'
}

function command (id, commandText, purpose, dependsOn = []) {
  return { id, command: commandText, purpose, risk: 'change', timeoutMs: 300000, requiresSudo: true, dependsOn }
}

function assertProfile (profile) {
  const required = ['packages', 'phpBinary', 'phpFpmBinary', 'phpFpmService', 'phpFpmPool', 'phpFpmRuntimeDirectory', 'phpFpmListener', 'phpFpmUser', 'phpFpmGroup', 'nginxService', 'nginxVhost', 'mariadbService', 'databaseHost', 'primaryAddressCommand', 'wpCliPhar', 'webRoot', 'nginxFastcgiPass']
  for (const key of required) if (!profile[key]) throw new Error(`learned WordPress profile is missing ${key}`)
}

function escapeSed (value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('&', '\\&')
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
