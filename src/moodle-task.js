import { deploymentBlueprint, validateApplicationDeltaPlan } from './application-delta.js'
import { buildLinuxPhpApplicationFoundation, linuxPhpApplicationProfile } from './linux-php-foundation.js'

const VERSION = '5.2.1'
const SOURCE_COMMIT = '63e16b757ca8fee05b672a27c23ee27cc8f9fabb'
const ARCHIVE_URL = `https://codeload.github.com/moodle/moodle/tar.gz/${SOURCE_COMMIT}`
const ARCHIVE_SHA256 = 'cbbd7176c9e88a33e577666347566b557cb97ef8c48d0e40da7a980c43fd16ab'
const PHP_IMAGE = 'php:8.4.23-fpm-bookworm'
const MOODLE_IMAGE = 'webminai/moodle:5.2.1-php8.4-fpm-r2'
const NGINX_IMAGE = 'nginx:1.30.4-alpine'
const DATABASE_IMAGE = 'mariadb:11.8.8'
const PORT = 18106
const MARKER = 'WEBMINAI_MOODLE_OK'
const SITE = 'webminai-moodle-18106'
const WEB_ROOT = `/srv/${SITE}`
const DATA_ROOT = '/srv/webminai-moodledata-18106'
const ARTIFACTS = `/var/lib/webminai/${SITE}`
const CREDENTIALS = '/root/moodle_credentials'
const DATABASE = 'webminai_moodle_18106'
const SERVICE_ROOT = '/opt/webminai/services/moodle'
const PROJECT = 'webminai-moodle-18106'
const SWAP_FILE = `/var/lib/webminai/${SITE}.swap`
const EPEL_RELEASE_URL = 'https://dl.fedoraproject.org/pub/epel/epel-release-latest-9.noarch.rpm'
const EPEL_RELEASE_SHA256 = 'b434245bffd8b40ea486157e72363d08b36e38145c8f917c5c00adfca3f2101b'
const REMI_EL9_RELEASE_URL = 'https://rpms.remirepo.net/enterprise/remi-release-9.rpm'
const REMI_EL9_RELEASE_SHA256 = '3bb04ace9b538920d785d25202c48e96ad2148d98c58eb76324901c9b36034b9'
const REMI_FEDORA44_RELEASE_URL = 'https://rpms.remirepo.net/fedora/remi-release-44.rpm'
const REMI_FEDORA44_RELEASE_SHA256 = '33ec50be86b32e78fdb0b948a2c39b657c51c1391d3203972426c055c8e4860f'

export function buildMoodleTask (taskId, linuxContext, docker = {}) {
  const compose = docker.preferred === true
  const context = withMoodleExtensions(linuxContext)
  const built = buildLinuxPhpApplicationFoundation({ taskId, linuxContext: context, docker, application: applicationContract() })
  const manifest = compatibilityManifest(context, compose)

  if (compose) configureComposePlan(built, taskId, context)
  else configureNativePlan(built, taskId, context)

  assignPhases(built.plan)
  const deltaCommands = built.plan.commands.filter(item => ['extract-moodle', 'install-moodle', 'verify-moodle', 'initialize-moodle'].includes(item.id))
  validateApplicationDeltaPlan({ commands: deltaCommands, revertCommands: [] })
  built.plan.summary = `Deploy a learned reversible ${compose ? 'Moodle Compose site' : 'native Moodle site'}`
  built.plan.changeOverview = `Compose the reviewed nginx/PHP-FPM/database foundation with digest-verified Moodle ${VERSION} on port ${PORT}.`
  built.plan.assumptions = [
    `Compatibility resolved from Moodle ${VERSION}'s official PHP, database, public-root, and cron requirements before planning.`,
    compose
      ? 'The reviewed image is built from the pinned Docker Official PHP 8.4 FPM base and uses pinned nginx and MariaDB images.'
      : 'The reviewed distro profile supplies PHP 8.3 or 8.4, MariaDB 10.11+, nginx, and a task-owned recurring cron unit.',
    'Administrator and database passwords are generated on-host and consumed only from protected files.'
  ]
  built.plan.warnings = [
    `This controlled test serves HTTP on isolated port ${PORT}.`,
    'Moodle data is stored outside the nginx document root and credential values never enter plan text or process arguments.'
  ]
  built.plan.compatibilityManifest = manifest
  built.plan.modifiedFiles = [...new Set(built.plan.modifiedFiles.filter(path => !path.includes('sites/default')).concat(DATA_ROOT))]
  built.plan.applicationDelta = deploymentBlueprint({
    manifest,
    foundationPhases: [...new Set(built.plan.commands.filter(item => !deltaCommands.includes(item)).map(item => item.phase))],
    foundationPaths: built.plan.modifiedFiles.filter(path => !path.endsWith('/moodle.tar.gz'))
  })
  return built
}

export function moodleRelease () {
  return Object.freeze({ version: VERSION, commit: SOURCE_COMMIT, url: ARCHIVE_URL, sha256: ARCHIVE_SHA256, phpImage: PHP_IMAGE, image: MOODLE_IMAGE })
}

export function moodleComposeAssets () {
  return composeCommand(true)
}

function configureNativePlan (built, taskId, linuxContext) {
  const profile = taskProfile(linuxPhpApplicationProfile(linuxContext, applicationContract()))
  const state = `/var/lib/webminai/task-state/${taskId}-moodle-linux`
  if (linuxContext.management.family === 'rhel') {
    const baseline = built.plan.commands.find(item => item.id === 'capture-baseline')
    baseline.command = rhelDatabaseBaselineCommand(baseline.command, state)
    const packages = built.plan.commands.find(item => item.id === 'install-packages')
    packages.command = rhelSclRepositoryCommand(packages.command, linuxContext, state)
    extendRhelKeyOwnership(built.plan, state)
    extendRhelDatabaseRestore(built.plan, state)
  }
  replaceCommand(built.plan, 'configure-php-fpm', nativeFpmCommand(built.plan.commands.find(item => item.id === 'configure-php-fpm').command), 'Configure Moodle PHP limits on the task-owned Unix socket pool')
  replaceCommand(built.plan, 'configure-nginx', nativeNginxCommand(built.plan.commands.find(item => item.id === 'configure-nginx').command), 'Serve only Moodle public/ through nginx and the task-owned PHP-FPM Unix socket')
  replaceCommand(built.plan, 'verify-artifacts', artifactCommand(), 'Acquire and verify the exact Moodle source commit archive')
  renameCommand(built.plan, 'extract-application', 'extract-moodle', extractCommand(profile), 'Extract the verified Moodle release and create off-web-root data storage')
  renameCommand(built.plan, 'install-application', 'install-moodle', installCommand(profile, state), 'Install Moodle through its official CLI using protected credential-file indirection')
  renameCommand(built.plan, 'verify-application', 'verify-moodle')
  insertNativeCron(built.plan, profile, state, taskId)
  replaceCommand(built.plan, 'verify-moodle', nativeVerifyCommand(profile), 'Verify Moodle, database state, writable data, cron, socket, login, and the external marker')
  extendNativeRevert(built.plan, profile, state, taskId)
  built.plan.modifiedFiles.push(`${ARTIFACTS}/moodle.tar.gz`, `${WEB_ROOT}/.webminai-installer-argv.php`, `${WEB_ROOT}/config.php`, cronPath(profile))
  built.verifyApplied = `test -f ${quote(`${WEB_ROOT}/.webminai-installed`)} && test -f ${quote(`${WEB_ROOT}/config.php`)} && test -f ${quote(`${DATA_ROOT}/.webminai-cron-ok`)} && test -S ${quote(profile.phpFpmListener)} && curl --fail --location --silent --show-error --max-time 10 http://127.0.0.1:${PORT}/ | grep -Fq ${MARKER}`
  built.verifyReverted = `test ! -e ${quote(WEB_ROOT)} && test ! -e ${quote(DATA_ROOT)} && test ! -e ${quote(ARTIFACTS)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)} && test ! -e ${quote(cronPath(profile))}`
}

function configureComposePlan (built, taskId, linuxContext) {
  const state = `/var/lib/webminai/task-state/${taskId}-moodle-compose`
  const builder = `webminai-moodle-${taskId}`
  replaceCommand(built.plan, 'write-compose', composeCommand(), 'Write the reviewed Moodle PHP-FPM image build, nginx socket route, MariaDB, cron, volumes, and secrets')
  replaceCommand(built.plan, 'pull-images', buildImagesCommand(state, taskId), 'Build the digest-verified Moodle PHP-FPM image with task-scoped BuildKit state and pull pinned nginx and MariaDB images')
  const pullImages = built.plan.commands.find(item => item.id === 'pull-images')
  pullImages.executionMode = 'job'
  pullImages.timeoutMs = 45 * 60 * 1000
  delete pullImages.retry
  extendComposeBuilderCleanup(built.plan, builder)
  insertComposeSwap(built.plan, state)
  replaceCommand(built.plan, 'start-compose', startComposeCommand(), 'Start MariaDB, Moodle PHP-FPM, nginx, and recurring cron with bounded readiness')
  renameCommand(built.plan, 'initialize-application', 'initialize-moodle', composeInitializeCommand(linuxContext), 'Install Moodle through its official CLI, validate the cron CLI, and start recurring cron')
  const initializeMoodle = built.plan.commands.find(item => item.id === 'initialize-moodle')
  initializeMoodle.executionMode = 'job'
  initializeMoodle.timeoutMs = 30 * 60 * 1000
  replaceCommand(built.plan, 'verify-compose', composeVerifyCommand(linuxContext), 'Verify Compose health, data isolation, cron, socket, login, and the Moodle marker')
  built.plan.modifiedFiles.push(`${SERVICE_ROOT}/compose.yaml`, `${SERVICE_ROOT}/Dockerfile`, `${SERVICE_ROOT}/docker-entrypoint.sh`, `${SERVICE_ROOT}/php-fpm.conf`, `${SERVICE_ROOT}/php.ini`, `${SERVICE_ROOT}/nginx.conf`, `${SERVICE_ROOT}/installer-argv.php`, SWAP_FILE)
  built.plan.modifiedFiles.push('/var/www/html/public/webminai-health.txt')
  built.verifyApplied = `cd ${quote(SERVICE_ROOT)} && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq moodle && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq nginx && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq cron && docker compose -p ${quote(PROJECT)} exec -T moodle test -S /run/php-fpm/webminai.sock && docker compose -p ${quote(PROJECT)} exec -T moodle test -f /var/www/html/.webminai-installed && docker compose -p ${quote(PROJECT)} exec -T moodle test -f /var/moodledata/.webminai-cron-ok && curl --fail --location --silent --show-error --max-time 10 http://127.0.0.1:${PORT}/webminai-health.txt | grep -Fq ${MARKER}`
  built.verifyReverted = `test ! -e ${quote(SERVICE_ROOT)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)} && test ! -e ${quote(SWAP_FILE)} && { ! command -v docker >/dev/null 2>&1 || { ! docker ps -aq --filter label=com.docker.compose.project=${quote(PROJECT)} | grep -q . && ! docker buildx inspect ${quote(builder)} >/dev/null 2>&1; }; }`
}

function withMoodleExtensions (linuxContext) {
  const profile = linuxContext.applications.wordpress
  const family = linuxContext.management.family
  const extra = family === 'debian'
    ? ['php-soap']
    : family === 'alpine'
      ? ['php83-ctype', 'php83-soap', 'php83-sodium']
      : family === 'suse'
        ? ['php8-ctype', 'php8-soap', 'php8-sodium']
        : family === 'rhel'
          ? []
          : []
  const extensions = family === 'arch' ? ['soap', 'sodium'] : []
  const selectedProfile = family === 'arch'
    ? archLegacyProfile(profile)
    : family === 'rhel'
      ? rhelSclProfile(profile)
      : profile
  return {
    ...linuxContext,
    applications: {
      ...linuxContext.applications,
      wordpress: {
        ...selectedProfile,
        packages: [...new Set([...selectedProfile.packages, ...extra])],
        phpExtensionsToEnable: [...new Set([...(selectedProfile.phpExtensionsToEnable ?? []), ...extensions])]
      }
    }
  }
}

function rhelSclProfile (profile) {
  return {
    ...profile,
    packages: [
      'ca-certificates',
      'tar',
      'gzip',
      'openssl',
      'nginx',
      'mariadb-server',
      'php84',
      'php84-php-cli',
      'php84-php-fpm',
      'php84-php-mysqlnd',
      'php84-php-gd',
      'php84-php-intl',
      'php84-php-mbstring',
      'php84-php-xml',
      'php84-php-pecl-zip',
      'php84-php-soap',
      'php84-php-sodium'
    ],
    phpBinary: '/opt/remi/php84/root/usr/bin/php',
    phpFpmBinary: '/opt/remi/php84/root/usr/sbin/php-fpm',
    phpFpmService: 'php84-php-fpm.service',
    phpFpmPool: '/etc/opt/remi/php84/php-fpm.d/webminai-wordpress-18101.conf'
  }
}

function rhelDatabaseBaselineCommand (foundation, state) {
  const suffix = "fi; printf '%s\n' baseline-ready"
  if (!foundation.endsWith(suffix)) throw new Error('Moodle RPM database baseline hook is unavailable')
  return foundation.replace(suffix, [
    'mariadb_stream=$(dnf -q module list mariadb --enabled 2>/dev/null | awk \'$1 == "mariadb" { print $2; exit }\')',
    `printf '%s\\n' "$mariadb_stream" > ${quote(`${state}/mariadb-stream.before`)}`,
    suffix
  ].join('; '))
}

function rhelSclRepositoryCommand (foundation, linuxContext, state) {
  const fedora = linuxContext.identity.id === 'fedora'
  const remiUrl = fedora ? REMI_FEDORA44_RELEASE_URL : REMI_EL9_RELEASE_URL
  const remiSha256 = fedora ? REMI_FEDORA44_RELEASE_SHA256 : REMI_EL9_RELEASE_SHA256
  const remiRpm = `${ARTIFACTS}/remi-release.rpm`
  const epelRpm = `${ARTIFACTS}/epel-release.rpm`
  const setup = [
    `mariadb_stream=$(sed -n 1p ${quote(`${state}/mariadb-stream.before`)})`,
    '[ -z "$mariadb_stream" ] || [ "$mariadb_stream" = 10.11 ] || [ "$mariadb_stream" = 11.8 ] || { printf \'%s\\n\' "unsupported pre-existing MariaDB module stream: $mariadb_stream" >&2; exit 1; }',
    `[ -n "$mariadb_stream" ] || { dnf -y module enable mariadb:10.11; : > ${quote(`${state}/mariadb-stream.changed`)}; }`,
    `install -d -o root -g root -m 0755 ${quote(ARTIFACTS)}`,
    fedora ? ':' : verifiedRepositoryRpm(EPEL_RELEASE_URL, EPEL_RELEASE_SHA256, epelRpm),
    verifiedRepositoryRpm(remiUrl, remiSha256, remiRpm),
    fedora
      ? `dnf -y install ${quote(remiRpm)}`
      : `if rpm -q epel-release >/dev/null 2>&1; then dnf -y install ${quote(remiRpm)}; else dnf -y install ${quote(epelRpm)} ${quote(remiRpm)}; fi`
  ].join('; ')
  if (!foundation.startsWith('set -eu; ')) throw new Error('Moodle RPM foundation package hook is unavailable')
  return foundation.replace('set -eu; ', `set -eu; ${setup}; `)
}

function extendRhelDatabaseRestore (plan, state) {
  const restore = plan.revertCommands.find(item => item.id === 'restore-packages-services')
  const stateRemoval = `rm -rf -- ${quote(state)}`
  if (!restore?.command.includes(stateRemoval)) throw new Error('Moodle RPM database restore hook is unavailable')
  restore.command = restore.command.replace(stateRemoval, `if [ -e ${quote(`${state}/mariadb-stream.changed`)} ]; then dnf -y module reset mariadb; fi; ${stateRemoval}`)
}

function verifiedRepositoryRpm (url, sha256, destination) {
  return `if [ ! -s ${quote(destination)} ] || ! printf '%s  %s\n' ${quote(sha256)} ${quote(destination)} | sha256sum -c - >/dev/null 2>&1; then curl --fail --location --silent --show-error --output ${quote(`${destination}.tmp`)} ${quote(url)}; printf '%s  %s\n' ${quote(sha256)} ${quote(`${destination}.tmp`)} | sha256sum -c - >/dev/null; mv -f -- ${quote(`${destination}.tmp`)} ${quote(destination)}; fi`
}

function extendRhelKeyOwnership (plan, state) {
  const before = `${state}/gpg-keys.before`
  const after = `${state}/gpg-keys.after`
  const added = `${state}/gpg-keys.added`
  const snapshot = destination => `rpm -qa gpg-pubkey --qf '%{NAME}-%{VERSION}-%{RELEASE}\n' | LC_ALL=C sort -u > ${quote(destination)}`
  const baseline = plan.commands.find(item => item.id === 'capture-baseline')
  const baselineSuffix = "printf '%s\n' baseline-ready"
  if (!baseline?.command.includes(baselineSuffix)) throw new Error('Moodle RPM key baseline hook is unavailable')
  baseline.command = baseline.command.replace(baselineSuffix, `[ -s ${quote(before)} ] || ${snapshot(before)}; ${baselineSuffix}`)
  const packages = plan.commands.find(item => item.id === 'install-packages')
  const packagesSuffix = "printf '%s\n' packages-ready"
  if (!packages?.command.includes(packagesSuffix)) throw new Error('Moodle RPM key package hook is unavailable')
  packages.command = packages.command.replace(packagesSuffix, `${snapshot(after)}; LC_ALL=C comm -13 ${quote(before)} ${quote(after)} > ${quote(added)} || true; ${packagesSuffix}`)
  const restore = plan.revertCommands.find(item => item.id === 'restore-packages-services')
  const stateRemoval = `rm -rf -- ${quote(state)}`
  if (!restore?.command.includes(stateRemoval)) throw new Error('Moodle RPM key restore hook is unavailable')
  const keyCleanup = `if [ -s ${quote(added)} ]; then while IFS= read -r key; do [ -z "$key" ] || rpm -e -- "$key"; done < ${quote(added)}; fi`
  restore.command = restore.command.replace(stateRemoval, `${keyCleanup}; ${stateRemoval}`)
}

function archLegacyProfile (profile) {
  const packages = profile.packages.map(packageName => ({
    php: 'php-legacy',
    'php-fpm': 'php-legacy-fpm',
    'php-gd': 'php-legacy-gd'
  })[packageName] ?? packageName)
  packages.push('php-legacy-sodium')
  return {
    ...profile,
    packages,
    phpBinary: '/usr/bin/php-legacy',
    phpFpmBinary: '/usr/bin/php-fpm-legacy',
    phpFpmService: 'php-fpm-legacy.service',
    phpFpmPool: '/etc/php-legacy/php-fpm.d/webminai-wordpress-18101.conf',
    phpExtensionConfig: '/etc/php-legacy/conf.d/webminai-wordpress-18101.ini'
  }
}

function taskProfile (profile) {
  return Object.fromEntries(Object.entries(profile).map(([key, value]) => [key, typeof value === 'string' ? value.replaceAll('webminai-wordpress-18101', SITE).replaceAll('18101', String(PORT)) : value]))
}

function artifactCommand () {
  const archive = `${ARTIFACTS}/moodle.tar.gz`
  return [
    'set -eu',
    `install -d -o root -g root -m 0755 ${quote(ARTIFACTS)}`,
    `if [ -s ${quote(archive)} ] && printf '%s  %s\n' ${quote(ARCHIVE_SHA256)} ${quote(archive)} | sha256sum -c - >/dev/null 2>&1; then printf '%s\n' artifact-already-verified; exit 0; fi`,
    `curl --fail --location --silent --show-error --output ${quote(`${archive}.tmp`)} ${quote(ARCHIVE_URL)}`,
    `printf '%s  %s\n' ${quote(ARCHIVE_SHA256)} ${quote(`${archive}.tmp`)} | sha256sum -c - >/dev/null`,
    `mv -f -- ${quote(`${archive}.tmp`)} ${quote(archive)}`,
    "printf '%s\n' artifact-verified"
  ].join('; ')
}

function extractCommand (profile) {
  return [
    'set -eu',
    `if [ ! -f ${quote(`${WEB_ROOT}/public/version.php`)} ]; then :`,
    `work=$(mktemp -d ${quote('/var/lib/webminai/moodle-extract.XXXXXX')})`,
    'trap \'rm -rf -- "$work"\' EXIT',
    `tar -xzf ${quote(`${ARTIFACTS}/moodle.tar.gz`)} -C "$work"`,
    `[ -f "$work/moodle-${SOURCE_COMMIT}/admin/cli/install.php" ]`,
    `[ -f "$work/moodle-${SOURCE_COMMIT}/public/index.php" ]`,
    `mv "$work/moodle-${SOURCE_COMMIT}" ${quote(WEB_ROOT)}`,
    `install -d -o ${quote(profile.phpFpmUser)} -g ${quote(profile.phpFpmGroup)} -m 0770 ${quote(DATA_ROOT)}`,
    `chown -R ${quote(`${profile.phpFpmUser}:${profile.phpFpmGroup}`)} ${quote(WEB_ROOT)}`,
    `find ${quote(WEB_ROOT)} -type d -exec chmod 0755 {} +`,
    `find ${quote(WEB_ROOT)} -type f -exec chmod 0644 {} +`,
    'trap - EXIT; rm -rf -- "$work"',
    'fi',
    `test -d ${quote(DATA_ROOT)}`,
    "printf '%s\n' files-ready"
  ].join('; ')
}

function nativeFpmCommand (foundation) {
  const anchor = quote('pm.max_requests = 500')
  if (!foundation.includes(anchor)) throw new Error('Moodle PHP-FPM foundation hook is unavailable')
  return foundation.replace(anchor, `${anchor} ${quote('php_admin_value[max_input_vars] = 5000')} ${quote('php_admin_value[memory_limit] = 256M')}`)
}

function nativeNginxCommand (foundation) {
  const root = `root ${WEB_ROOT};`
  if (!foundation.includes(root)) throw new Error('Moodle nginx foundation root hook is unavailable')
  return foundation
    .replace(root, `root ${WEB_ROOT}/public;`)
    .replace('try_files $uri $uri/ /index.php?$args;', 'try_files $uri $uri/ /r.php?$query_string;')
}

function installCommand (profile, state) {
  const bootstrap = `${WEB_ROOT}/.webminai-installer-argv.php`
  const install = `WEBMINAI_DB_PASS_FILE=${quote(`${CREDENTIALS}/db_password`)} ${quote(profile.phpBinary)} -d memory_limit=512M -d max_input_vars=5000 -d auto_prepend_file=${quote(bootstrap)} ${quote(`${WEB_ROOT}/admin/cli/install.php`)} --non-interactive --agree-license --skip-database --lang=en --wwwroot="$WEBMINAI_MOODLE_URL" --dataroot=${quote(DATA_ROOT)} --dbtype=mariadb --dbhost=${quote(profile.databaseHost)} --dbname=${quote(DATABASE)} --dbuser=${quote(DATABASE)} --prefix=wmai_`
  return [
    'set -eu',
    `${quote(profile.phpBinary)} -r ${quote("$required=['ctype','curl','dom','gd','iconv','intl','json','mbstring','mysqli','openssl','simplexml','sodium','xml','zip']; foreach ($required as $extension) { if (!extension_loaded($extension)) { fwrite(STDERR, 'PHP_EXTENSION_MISSING:' . $extension . PHP_EOL); exit(1); } } exit(PHP_VERSION_ID >= 80300 && PHP_VERSION_ID < 80500 ? 0 : 1);")}`,
    `if [ ! -f ${quote(`${WEB_ROOT}/config.php`)} ]; then :`,
    `bootstrap_candidate=$(mktemp); printf '%s\n' ${installerBootstrapLines().map(quote).join(' ')} > "$bootstrap_candidate"`,
    `install -o root -g ${quote(profile.phpFpmGroup)} -m 0440 "$bootstrap_candidate" ${quote(bootstrap)}`,
    'rm -f -- "$bootstrap_candidate"',
    `address=$(${profile.primaryAddressCommand})`,
    '[ -n "$address" ]',
    `export WEBMINAI_MOODLE_URL="http://$address:${PORT}"`,
    `install_log=${quote(`${state}/install-moodle.log`)}`,
    `if ! /bin/sh -c ${quote(install)} > "$install_log" 2>&1; then sed -E -e 's/(pass(word)?|secret|token)[^[:space:]]*/[redacted]/Ig' -e 's/[[:alnum:]_+\\/=.-]{32,}/[redacted]/g' "$install_log" | tail -80 >&2; exit 1; fi`,
    'rm -f -- "$install_log"',
    `chown -R ${quote(`${profile.phpFpmUser}:${profile.phpFpmGroup}`)} ${quote(WEB_ROOT)} ${quote(DATA_ROOT)}`,
    'fi',
    `test -f ${quote(`${WEB_ROOT}/config.php`)}`,
    `chmod 0640 ${quote(`${WEB_ROOT}/config.php`)}`,
    "printf '%s\n' moodle-configured"
  ].join('; ')
}

function insertNativeCron (plan, profile, state, taskId) {
  const verifyIndex = plan.commands.findIndex(command => command.id === 'verify-moodle')
  if (verifyIndex < 0) throw new Error('Moodle foundation is missing verify-moodle')
  const install = plan.commands.find(command => command.id === 'install-moodle')
  const rawDatabaseSteps = nativeDatabaseInstallSteps(profile, state, taskId)
  const databaseSteps = rawDatabaseSteps.map((step, index) => ({
    ...install,
    ...step,
    dependsOn: [index === 0 ? 'install-moodle' : rawDatabaseSteps[index - 1].id]
  }))
  const cron = {
    ...install,
    id: 'configure-moodle-cron',
    purpose: 'Configure and execute the task-owned recurring Moodle cron job',
    command: nativeCronCommand(profile, state),
    dependsOn: [databaseSteps.at(-1).id]
  }
  plan.commands.splice(verifyIndex, 0, ...databaseSteps, cron)
  plan.commands[verifyIndex + databaseSteps.length + 1].dependsOn = ['configure-moodle-cron']
}

function nativeDatabaseInstallSteps (profile, state, taskId) {
  const bootstrap = `${WEB_ROOT}/.webminai-installer-argv.php`
  const log = `${state}/install-moodle-database.log`
  const result = `${state}/install-moodle-database.exit`
  const pid = `${state}/install-moodle-database.pid`
  const unit = `webminai-moodle-install-${taskId}.service`
  const install = `WEBMINAI_ADMIN_PASSWORD_FILE=${quote(`${CREDENTIALS}/admin_password`)} ${quote(profile.phpBinary)} -d memory_limit=512M -d max_input_vars=5000 -d auto_prepend_file=${quote(bootstrap)} ${quote(`${WEB_ROOT}/admin/cli/install_database.php`)} --agree-license --lang=en --fullname=${quote(MARKER)} --shortname=${quote(MARKER)} --adminuser=webminai_admin --adminemail=intentaiops@example.invalid`
  const job = [
    'set +e',
    `${install} > ${quote(log)} 2>&1`,
    'status=$?',
    `if [ "$status" -eq 0 ]; then rm -f -- ${quote(bootstrap)}; printf '%s\n' installation-completed > ${quote(`${WEB_ROOT}/.webminai-installed`)}; chown -R ${quote(`${profile.phpFpmUser}:${profile.phpFpmGroup}`)} ${quote(WEB_ROOT)} ${quote(DATA_ROOT)}; fi`,
    `printf '%s\n' "$status" > ${quote(`${result}.tmp`)}`,
    `mv -f -- ${quote(`${result}.tmp`)} ${quote(result)}`,
    'exit "$status"'
  ].join('; ')
  const launch = profile.phpFpmService.endsWith('.service')
    ? `systemctl reset-failed ${quote(unit)} >/dev/null 2>&1 || true; systemd-run --quiet --collect --unit=${quote(unit)} --property=RuntimeMaxSec=720s /bin/sh -c ${quote(job)} >/dev/null 2>&1`
    : `start-stop-daemon --start --background --make-pidfile --pidfile ${quote(pid)} --startas /bin/sh -- -c ${quote(job)} >/dev/null 2>&1`
  const start = [
    'set -eu',
    `if [ ! -f ${quote(`${WEB_ROOT}/.webminai-installed`)} ]; then :`,
    `rm -f -- ${quote(result)} ${quote(`${result}.tmp`)} ${quote(log)} ${quote(pid)}`,
    launch,
    'fi',
    "printf '%s\n' moodle-database-started"
  ].join('; ')
  return [
    { id: 'install-moodle-database', purpose: 'Start the task-owned bounded Moodle schema and administrator installation job', command: start },
    {
      id: 'install-moodle-database-wait',
      purpose: 'Probe until the bounded Moodle database installation job finishes successfully',
      command: databaseWaitCommand(result, log),
      timeoutMs: 30000,
      retry: { attempts: 73, intervalMs: 10000, exitCodes: [75] }
    }
  ]
}

function databaseWaitCommand (result, log) {
  return [
    'set -eu',
    `[ -f ${quote(result)} ] || { printf '%s\n' MOODLE_DATABASE_INSTALL_PENDING >&2; exit 75; }`,
    `status=$(sed -n 1p ${quote(result)})`,
    `if [ "$status" != 0 ]; then sed -E -e 's/(pass(word)?|secret|token)[^[:space:]]*/[redacted]/Ig' -e 's/[[:alnum:]_+\\/=.-]{32,}/[redacted]/g' ${quote(log)} | tail -80 >&2; exit 1; fi`,
    `test -f ${quote(`${WEB_ROOT}/.webminai-installed`)}`,
    "printf '%s\n' moodle-database-ready"
  ].join('; ')
}

function nativeCronCommand (profile, state) {
  const execution = `${quote(profile.phpBinary)} ${quote(`${WEB_ROOT}/admin/cli/cron.php`)} --keep-alive=0 >/dev/null 2>&1 && touch ${quote(`${DATA_ROOT}/.webminai-cron-ok`)}`
  if (profile.phpFpmService.endsWith('.service')) {
    const service = `/etc/systemd/system/${SITE}-cron.service`
    const timer = `/etc/systemd/system/${SITE}-cron.timer`
    const owned = `${state}/cron-owned`
    const serviceLines = ['[Unit]', 'Description=Intent AI Ops Moodle cron', '[Service]', 'Type=oneshot', `User=${profile.phpFpmUser}`, `Group=${profile.phpFpmGroup}`, `ExecStart=/bin/sh -c ${quote(execution)}`]
    const timerLines = ['[Unit]', 'Description=Run Intent AI Ops Moodle cron every minute', '[Timer]', 'OnBootSec=1min', 'OnUnitActiveSec=1min', `Unit=${SITE}-cron.service`, '[Install]', 'WantedBy=timers.target']
    return `set -eu; if [ ! -e ${quote(owned)} ]; then test ! -e ${quote(service)}; test ! -e ${quote(timer)}; : > ${quote(owned)}; fi; ${writeCandidate(service, serviceLines, '0644')}; ${writeCandidate(timer, timerLines, '0644')}; systemctl daemon-reload; systemctl enable --now ${quote(`${SITE}-cron.timer`)} >/dev/null; systemctl start ${quote(`${SITE}-cron.service`)}; test -f ${quote(`${DATA_ROOT}/.webminai-cron-ok`)}; printf '%s\n' cron-ready`
  }
  const periodic = cronPath(profile)
  const owned = `${state}/cron-owned`
  const lines = ['#!/bin/sh', `su -s /bin/sh -c ${quote(execution)} ${quote(profile.phpFpmUser)}`]
  return `set -eu; if [ ! -e ${quote(owned)} ]; then if rc-service crond status >/dev/null 2>&1; then : > ${quote(`${state}/crond-active.before`)}; fi; if rc-update show default 2>/dev/null | grep -Eq '^[[:space:]]*crond([[:space:]]|$)'; then : > ${quote(`${state}/crond-enabled.before`)}; fi; test ! -e ${quote(periodic)}; : > ${quote(owned)}; fi; printf '%s\n' ${lines.map(quote).join(' ')} > ${quote(periodic)}; chmod 0755 ${quote(periodic)}; rc-update add crond default >/dev/null; rc-service crond start >/dev/null 2>&1 || true; ${quote(periodic)}; test -f ${quote(`${DATA_ROOT}/.webminai-cron-ok`)}; printf '%s\n' cron-ready`
}

function nativeVerifyCommand (profile) {
  return [
    'set -eu',
    `test -S ${quote(profile.phpFpmListener)} || { printf '%s\n' SERVICE_SOCKET_NOT_READY >&2; exit 1; }`,
    `test -f ${quote(`${WEB_ROOT}/.webminai-installed`)} || { printf '%s\n' INSTALL_MARKER_MISSING >&2; exit 1; }`,
    `test -f ${quote(`${WEB_ROOT}/config.php`)} || { printf '%s\n' APP_CONFIG_MISSING >&2; exit 1; }`,
    `test -f ${quote(`${DATA_ROOT}/.webminai-cron-ok`)} || { printf '%s\n' CRON_NOT_READY >&2; exit 1; }`,
    `test "$(stat -c %a ${quote(`${WEB_ROOT}/config.php`)})" = 640 || { printf '%s\n' APP_CONFIG_MODE_INVALID >&2; exit 1; }`,
    `mariadb --protocol=socket -uroot -Nse ${quote(`SELECT COUNT(*) FROM ${DATABASE}.wmai_user WHERE username='webminai_admin';`)} | grep -Fxq 1 || { printf '%s\n' DATABASE_ADMIN_NOT_READY >&2; exit 1; }`,
    `if command -v setpriv >/dev/null 2>&1 && setpriv --help 2>&1 | grep -q -- --reuid; then setpriv --reuid=${quote(profile.phpFpmUser)} --regid=${quote(profile.phpFpmGroup)} --init-groups /bin/sh -c ${quote(`test -w ${DATA_ROOT}`)}; else su -s /bin/sh -c ${quote(`test -w ${DATA_ROOT}`)} ${quote(profile.phpFpmUser)}; fi`,
    `address=$(${profile.primaryAddressCommand})`,
    '[ -n "$address" ] || { printf \'%s\\n\' HOST_ADDRESS_UNAVAILABLE >&2; exit 1; }',
    `curl --fail --location --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 --max-time 10 "http://$address:${PORT}/" | grep -Fq ${MARKER} || { printf '%s\n' APP_HTTP_MARKER_NOT_READY >&2; exit 1; }`,
    `curl --fail --location --silent --show-error --max-time 10 "http://$address:${PORT}/login/index.php" | grep -Fq login`,
    "printf '%s\n' verification-passed"
  ].join('; ')
}

function extendNativeRevert (plan, profile, state, taskId) {
  const first = plan.revertCommands[0]
  const cron = {
    ...first,
    id: 'remove-moodle-cron',
    purpose: 'Remove the task-owned Moodle cron schedule and restore Alpine crond state',
    command: nativeCronRevertCommand(profile, state, taskId),
    dependsOn: []
  }
  plan.revertCommands.unshift(cron)
  first.dependsOn = ['remove-moodle-cron']
  const files = plan.revertCommands.find(command => command.id === 'remove-application-files')
  if (!files) throw new Error('Moodle foundation is missing remove-application-files')
  files.command = files.command.replace(`rm -rf -- ${quote(WEB_ROOT)}`, `rm -rf -- ${quote(WEB_ROOT)} ${quote(DATA_ROOT)}`)
}

function nativeCronRevertCommand (profile, state, taskId) {
  if (profile.phpFpmService.endsWith('.service')) {
    return `set +e; systemctl stop ${quote(`webminai-moodle-install-${taskId}.service`)} >/dev/null 2>&1; systemctl reset-failed ${quote(`webminai-moodle-install-${taskId}.service`)} >/dev/null 2>&1; systemctl disable --now ${quote(`${SITE}-cron.timer`)} >/dev/null 2>&1; rm -f -- ${quote(`/etc/systemd/system/${SITE}-cron.service`)} ${quote(`/etc/systemd/system/${SITE}-cron.timer`)}; systemctl daemon-reload; exit 0`
  }
  return `set +e; if [ -s ${quote(`${state}/install-moodle-database.pid`)} ]; then kill "$(sed -n 1p ${quote(`${state}/install-moodle-database.pid`)})" >/dev/null 2>&1; fi; rm -f -- ${quote(cronPath(profile))}; if [ -d ${quote(state)} ]; then if [ ! -e ${quote(`${state}/crond-active.before`)} ]; then rc-service crond stop >/dev/null 2>&1; fi; if [ ! -e ${quote(`${state}/crond-enabled.before`)} ]; then rc-update del crond default >/dev/null 2>&1; fi; fi; exit 0`
}

function cronPath (profile) {
  return profile.phpFpmService.endsWith('.service') ? `/etc/systemd/system/${SITE}-cron.timer` : `/etc/periodic/15min/${SITE}`
}

function composeCommand (returnAssets = false) {
  const compose = [
    'services:',
    '  db:',
    `    image: ${DATABASE_IMAGE}`,
    '    restart: unless-stopped',
    '    environment:',
    `      MARIADB_DATABASE: ${DATABASE}`,
    `      MARIADB_USER: ${DATABASE}`,
    '      MARIADB_PASSWORD_FILE: /run/secrets/db_password',
    '      MARIADB_ROOT_PASSWORD_FILE: /run/secrets/db_root_password',
    '    command: ["--character-set-server=utf8mb4", "--collation-server=utf8mb4_unicode_ci"]',
    '    secrets: [db_password, db_root_password]',
    '    volumes: [db_data:/var/lib/mysql]',
    '    healthcheck:',
    '      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]',
    '      interval: 5s',
    '      timeout: 5s',
    '      retries: 30',
    '  moodle:',
    `    image: ${MOODLE_IMAGE}`,
    '    build: .',
    '    restart: unless-stopped',
    '    depends_on:',
    '      db: { condition: service_healthy }',
    '    secrets: [db_password, admin_password]',
    '    volumes:',
    '      - moodle_code:/var/www/html',
    '      - moodle_data:/var/moodledata',
    '      - php_run:/run/php-fpm',
    '      - ./php-fpm.conf:/usr/local/etc/php-fpm.d/zz-webminai-socket.conf:ro',
    '      - ./php.ini:/usr/local/etc/php/conf.d/zz-webminai-moodle.ini:ro',
    '      - ./installer-argv.php:/run/webminai/installer-argv.php:ro',
    '  cron:',
    `    image: ${MOODLE_IMAGE}`,
    '    restart: unless-stopped',
    '    user: www-data',
    '    depends_on: [moodle]',
    '    command: ["/bin/sh", "-c", "while [ ! -f /var/www/html/config.php ]; do sleep 5; done; while :; do php /var/www/html/admin/cli/cron.php --keep-alive=0 >/dev/null 2>&1 && touch /var/moodledata/.webminai-cron-ok; sleep 60; done"]',
    '    volumes:',
    '      - moodle_code:/var/www/html',
    '      - moodle_data:/var/moodledata',
    '      - ./php.ini:/usr/local/etc/php/conf.d/zz-webminai-moodle.ini:ro',
    '  nginx:',
    `    image: ${NGINX_IMAGE}`,
    '    restart: unless-stopped',
    '    depends_on: [moodle]',
    `    ports: ["${PORT}:80"]`,
    '    volumes:',
    '      - moodle_code:/var/www/html:ro',
    '      - php_run:/run/php-fpm',
    '      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro',
    'secrets:',
    `  db_password: { file: ${CREDENTIALS}/db_password }`,
    `  db_root_password: { file: ${CREDENTIALS}/db_root_password }`,
    `  admin_password: { file: ${CREDENTIALS}/admin_password }`,
    'volumes:',
    '  db_data:',
    '  moodle_code:',
    '  moodle_data:',
    '  php_run:'
  ]
  const dockerfile = [
    `FROM ${PHP_IMAGE}`,
    'RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates libcurl4-openssl-dev libfreetype6-dev libicu-dev libjpeg62-turbo-dev libonig-dev libpng-dev libxml2-dev libzip-dev && docker-php-ext-configure gd --with-freetype --with-jpeg && docker-php-ext-install -j1 curl gd intl mbstring mysqli soap zip && rm -rf /var/lib/apt/lists/*',
    `RUN install -d /opt/moodle && curl --fail --location --silent --show-error --output /tmp/moodle.tgz ${ARCHIVE_URL} && printf '%s  %s\\n' ${ARCHIVE_SHA256} /tmp/moodle.tgz | sha256sum -c - && tar -xzf /tmp/moodle.tgz --strip-components=1 -C /opt/moodle && rm -f /tmp/moodle.tgz`,
    'COPY docker-entrypoint.sh /usr/local/bin/webminai-moodle-entrypoint',
    'RUN chmod 0755 /usr/local/bin/webminai-moodle-entrypoint',
    'ENTRYPOINT ["webminai-moodle-entrypoint"]',
    'CMD ["php-fpm"]'
  ]
  const entrypoint = ['#!/bin/sh', 'set -eu', 'if [ "$(id -u)" = 0 ]; then if [ ! -f /var/www/html/public/version.php ]; then cp -a /opt/moodle/. /var/www/html/; fi; install -d -o www-data -g www-data -m 0770 /var/moodledata; install -d -o www-data -g www-data -m 0755 /run/php-fpm; chown -R www-data:www-data /var/www/html /var/moodledata /run/php-fpm; fi', 'exec docker-php-entrypoint "$@"']
  if (returnAssets) {
    return {
      compose: [...compose],
      dockerfile: [...dockerfile],
      entrypoint: [...entrypoint],
      fpm: fpmSocketConfig(),
      phpIni: ['max_input_vars=5000', 'memory_limit=256M', 'upload_max_filesize=64M', 'post_max_size=64M'],
      nginx: nginxConfig(),
      installer: installerBootstrapLines()
    }
  }
  return [
    'set -eu',
    `install -d -o root -g root -m 0755 ${quote(SERVICE_ROOT)}`,
    writeCandidate(`${SERVICE_ROOT}/compose.yaml`, compose, '0644'),
    writeCandidate(`${SERVICE_ROOT}/Dockerfile`, dockerfile, '0444'),
    writeCandidate(`${SERVICE_ROOT}/docker-entrypoint.sh`, entrypoint, '0555'),
    writeCandidate(`${SERVICE_ROOT}/php-fpm.conf`, fpmSocketConfig(), '0444'),
    writeCandidate(`${SERVICE_ROOT}/php.ini`, ['max_input_vars=5000', 'memory_limit=256M', 'upload_max_filesize=64M', 'post_max_size=64M'], '0444'),
    writeCandidate(`${SERVICE_ROOT}/nginx.conf`, nginxConfig(), '0444'),
    writeCandidate(`${SERVICE_ROOT}/installer-argv.php`, installerBootstrapLines(), '0444'),
    `grep -Fq 'fastcgi_pass unix:/run/php-fpm/webminai.sock' ${quote(`${SERVICE_ROOT}/nginx.conf`)}`,
    `grep -Fq ${quote('root /var/www/html/public')} ${quote(`${SERVICE_ROOT}/nginx.conf`)}`,
    `! grep -Eq '[0-9a-f]{32,}' ${quote(`${SERVICE_ROOT}/compose.yaml`)}`,
    "printf '%s\n' compose-ready"
  ].join('; ')
}

function writeCandidate (path, lines, mode) {
  return `candidate=$(mktemp); printf '%s\n' ${lines.map(quote).join(' ')} > "$candidate"; if ! cmp -s "$candidate" ${quote(path)}; then install -o root -g root -m ${mode} "$candidate" ${quote(path)}; fi; rm -f -- "$candidate"`
}

function buildImagesCommand (state, taskId) {
  const builder = `webminai-moodle-${taskId}`
  const buildkitImage = 'moby/buildkit:buildx-stable-1'
  return `set -eu; cd ${quote(SERVICE_ROOT)}; if ! docker image inspect ${quote(MOODLE_IMAGE)} >/dev/null 2>&1; then ! docker buildx inspect ${quote(builder)} >/dev/null 2>&1; buildkit_before=$(docker image inspect ${quote(buildkitImage)} --format '{{.Id}}' 2>/dev/null || true); docker buildx create --name ${quote(builder)} --driver docker-container --driver-opt network=host >/dev/null; cleanup_builder() { docker buildx rm --force ${quote(builder)} >/dev/null 2>&1 || true; if [ -z "$buildkit_before" ]; then docker image rm ${quote(buildkitImage)} >/dev/null 2>&1 || true; fi; }; trap cleanup_builder EXIT HUP INT TERM; docker buildx build --builder ${quote(builder)} --pull --network host --load --tag ${quote(MOODLE_IMAGE)} .; cleanup_builder; trap - EXIT HUP INT TERM; fi; docker compose -p ${quote(PROJECT)} pull db nginx; docker image inspect ${quote(MOODLE_IMAGE)} --format '{{.Id}}' > ${quote(`${state}/image-0.after`)}; cp ${quote(`${state}/image-0.after`)} ${quote(`${state}/image-1.after`)}; docker image inspect ${quote(NGINX_IMAGE)} --format '{{.Id}}' > ${quote(`${state}/image-2.after`)}; docker image inspect ${quote(DATABASE_IMAGE)} --format '{{.Id}}' > ${quote(`${state}/image-3.after`)}; printf '%s\\n' images-ready`
}

function extendComposeBuilderCleanup (plan, builder) {
  const project = plan.revertCommands.find(command => command.id === 'remove-compose-project')
  if (!project) throw new Error('Moodle foundation is missing remove-compose-project')
  project.command = `set +e; if command -v docker >/dev/null 2>&1; then docker buildx rm --force ${quote(builder)} >/dev/null 2>&1 || true; fi; ${project.command}; exit $?`
}

function insertComposeSwap (plan, state) {
  const pullIndex = plan.commands.findIndex(command => command.id === 'pull-images')
  const pull = plan.commands[pullIndex]
  if (pullIndex < 0 || !pull) throw new Error('Moodle foundation is missing pull-images')
  const prepare = {
    ...pull,
    id: 'prepare-moodle-swap',
    purpose: 'Provide reversible task-owned swap headroom for the Moodle PHP image build and installer',
    command: `set -eu; if [ ! -e ${quote(`${state}/swap-created`)} ]; then [ ! -e ${quote(SWAP_FILE)} ]; fallocate -l 2G ${quote(SWAP_FILE)}; chmod 0600 ${quote(SWAP_FILE)}; mkswap ${quote(SWAP_FILE)} >/dev/null; swapon ${quote(SWAP_FILE)}; : > ${quote(`${state}/swap-created`)}; fi; grep -Fq ${quote(SWAP_FILE)} /proc/swaps; printf '%s\n' swap-ready`,
    dependsOn: [...pull.dependsOn],
    phase: 'services'
  }
  delete prepare.executionMode
  delete prepare.retry
  prepare.timeoutMs = 300000
  plan.commands.splice(pullIndex, 0, prepare)
  pull.dependsOn = ['prepare-moodle-swap']

  const projectIndex = plan.revertCommands.findIndex(command => command.id === 'remove-compose-project')
  const project = plan.revertCommands[projectIndex]
  const remove = {
    ...project,
    id: 'remove-moodle-swap',
    purpose: 'Disable and remove only the task-owned Moodle swap file',
    command: `set -eu; if [ -e ${quote(`${state}/swap-created`)} ]; then swapoff ${quote(SWAP_FILE)} 2>/dev/null || true; rm -f -- ${quote(SWAP_FILE)}; fi; test ! -e ${quote(SWAP_FILE)}; printf '%s\n' swap-removed`,
    dependsOn: ['remove-compose-project'],
    phase: 'cleanup'
  }
  plan.revertCommands.splice(projectIndex + 1, 0, remove)
  for (const command of plan.revertCommands) {
    if (command.id !== remove.id) command.dependsOn = command.dependsOn.map(id => id === 'remove-compose-project' ? remove.id : id)
  }
}

function startComposeCommand () {
  return `set -eu; cd ${quote(SERVICE_ROOT)}; docker compose -p ${quote(PROJECT)} up -d db moodle nginx; ready=; for attempt in $(seq 1 90); do if docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq db && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq moodle && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq nginx && docker compose -p ${quote(PROJECT)} exec -T moodle test -S /run/php-fpm/webminai.sock && docker compose -p ${quote(PROJECT)} exec -T moodle test -f /var/www/html/admin/cli/install.php; then ready=yes; break; fi; sleep 2; done; [ "$ready" = yes ]; printf '%s\n' compose-started`
}

function composeInitializeCommand (linuxContext) {
  const addressCommand = linuxContext?.applications?.wordpress?.primaryAddressCommand ?? "ip -4 -o route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i == \"src\") {print $(i+1); exit}}'"
  const prepareCredentials = 'install -d -o www-data -g www-data -m 0700 /run/webminai; install -o www-data -g www-data -m 0400 /run/secrets/db_password /run/webminai/db_password; install -o www-data -g www-data -m 0400 /run/secrets/admin_password /run/webminai/admin_password'
  const install = `WEBMINAI_DB_PASS_FILE=/run/webminai/db_password WEBMINAI_ADMIN_PASSWORD_FILE=/run/webminai/admin_password php -d memory_limit=512M -d max_input_vars=5000 -d auto_prepend_file=/run/webminai/installer-argv.php /var/www/html/admin/cli/install.php --non-interactive --agree-license --lang=en --wwwroot="$WEBMINAI_MOODLE_URL" --dataroot=/var/moodledata --dbtype=mariadb --dbhost=db --dbname=${DATABASE} --dbuser=${DATABASE} --prefix=wmai_ --fullname=${MARKER} --shortname=${MARKER} --adminuser=webminai_admin --adminemail=intentaiops@example.invalid`
  const installDatabase = 'WEBMINAI_ADMIN_PASSWORD_FILE=/run/webminai/admin_password php -d auto_prepend_file=/run/webminai/installer-argv.php /var/www/html/admin/cli/install_database.php --agree-license --lang=en --fullname=WEBMINAI_MOODLE_OK --shortname=WEBMINAI_MOODLE_OK --adminuser=webminai_admin --adminemail=intentaiops@example.invalid'
  return [
    'set -eu',
    `cd ${quote(SERVICE_ROOT)}`,
    `address=$(${addressCommand})`,
    '[ -n "$address" ]',
    `if ! docker compose -p ${quote(PROJECT)} exec -T moodle test -f /var/www/html/.webminai-installed; then docker compose -p ${quote(PROJECT)} exec -T moodle /bin/sh -c ${quote(prepareCredentials)}; if docker compose -p ${quote(PROJECT)} exec -T moodle test -f /var/www/html/config.php; then docker compose -p ${quote(PROJECT)} exec -T --user www-data moodle /bin/sh -c ${quote(`${installDatabase} >/dev/null 2>&1`)}; else docker compose -p ${quote(PROJECT)} exec -T --user www-data -e WEBMINAI_MOODLE_URL="http://$address:${PORT}" moodle /bin/sh -c ${quote(`${install} >/dev/null 2>&1`)}; fi; docker compose -p ${quote(PROJECT)} exec -T moodle /bin/sh -c ${quote("rm -f /run/webminai/db_password /run/webminai/admin_password; printf '%s\\n' installation-completed > /var/www/html/.webminai-installed && chown www-data:www-data /var/www/html/.webminai-installed")}; fi`,
    `if ! docker compose -p ${quote(PROJECT)} exec -T moodle test -f /var/moodledata/.webminai-cron-ok; then docker compose -p ${quote(PROJECT)} stop cron >/dev/null 2>&1 || true; docker compose -p ${quote(PROJECT)} exec -T --user www-data moodle /bin/sh -c ${quote('php /var/www/html/admin/cli/cron.php --help >/dev/null 2>&1 && touch /var/moodledata/.webminai-cron-ok')}; fi`,
    `docker compose -p ${quote(PROJECT)} up -d cron`,
    `cronReady=; for attempt in $(seq 1 60); do if docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq cron; then cronReady=yes; break; fi; sleep 2; done`,
    '[ "$cronReady" = yes ]',
    `docker compose -p ${quote(PROJECT)} exec -T moodle test -f /var/www/html/config.php`,
    `docker compose -p ${quote(PROJECT)} exec -T moodle test -f /var/moodledata/.webminai-cron-ok`,
    `docker compose -p ${quote(PROJECT)} exec -T moodle /bin/sh -c ${quote(`printf '%s\n' ${MARKER} > /var/www/html/public/webminai-health.txt && chown www-data:www-data /var/www/html/public/webminai-health.txt && chmod 0644 /var/www/html/public/webminai-health.txt`)}`,
    `ready=; for attempt in $(seq 1 60); do if curl --fail --location --silent --show-error --max-time 5 "http://$address:${PORT}/webminai-health.txt" 2>/dev/null | grep -Fq ${MARKER}; then ready=yes; break; fi; sleep 2; done`,
    '[ "$ready" = yes ]',
    "printf '%s\n' moodle-installed"
  ].join('; ')
}

function composeVerifyCommand (linuxContext) {
  const addressCommand = linuxContext?.applications?.wordpress?.primaryAddressCommand ?? "ip -4 -o route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i == \"src\") {print $(i+1); exit}}'"
  return `set -eu; cd ${quote(SERVICE_ROOT)}; for service in moodle nginx cron; do docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq "$service"; done; docker compose -p ${quote(PROJECT)} exec -T moodle test -S /run/php-fpm/webminai.sock; docker compose -p ${quote(PROJECT)} exec -T moodle test -f /var/www/html/.webminai-installed; docker compose -p ${quote(PROJECT)} exec -T moodle test -f /var/www/html/config.php; docker compose -p ${quote(PROJECT)} exec -T moodle test -f /var/moodledata/.webminai-cron-ok; docker compose -p ${quote(PROJECT)} exec -T --user www-data moodle test -w /var/moodledata; address=$(${addressCommand}); [ -n "$address" ]; curl --fail --location --silent --show-error --max-time 20 "http://$address:${PORT}/webminai-health.txt" | grep -Fq ${MARKER}; curl --fail --silent --show-error --max-time 20 "http://$address:${PORT}/login/index.php" | grep -Eiq '<!DOCTYPE html|<html'; printf '%s\n' verification-passed`
}

function fpmSocketConfig () {
  return ['[www]', 'listen = /run/php-fpm/webminai.sock', 'listen.owner = www-data', 'listen.group = www-data', 'listen.mode = 0666']
}

function nginxConfig () {
  return [
    'server {',
    '    listen 80;',
    '    server_name _;',
    '    root /var/www/html/public;',
    '    index index.php;',
    '    client_max_body_size 64m;',
    '    location / { try_files $uri $uri/ /r.php?$query_string; }',
    '    location ~ [^/]\\.php(/|$) {',
    '        fastcgi_split_path_info ^(.+\\.php)(/.+)$;',
    '        try_files $fastcgi_script_name =404;',
    '        include fastcgi_params;',
    '        fastcgi_pass unix:/run/php-fpm/webminai.sock;',
    '        fastcgi_param PATH_INFO $fastcgi_path_info;',
    '        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;',
    '        fastcgi_read_timeout 300;',
    '    }',
    '    location ~ /\\. { deny all; }',
    '}'
  ]
}

function installerBootstrapLines () {
  return [
    '<?php',
    "$files = ['dbpass' => getenv('WEBMINAI_DB_PASS_FILE'), 'adminpass' => getenv('WEBMINAI_ADMIN_PASSWORD_FILE')];",
    'foreach ($files as $option => $path) {',
    '    if (!$path) { continue; }',
    "    if (!is_file($path)) { fwrite(STDERR, 'missing protected credential file' . PHP_EOL); exit(1); }",
    '    $value = trim((string) file_get_contents($path));',
    "    if ($value === '') { fwrite(STDERR, 'empty protected credential file' . PHP_EOL); exit(1); }",
    "    $argv[] = '--' . $option . '=' . $value;",
    '}',
    '$argc = count($argv);',
    "$_SERVER['argv'] = $argv;",
    "$_SERVER['argc'] = $argc;",
    "$GLOBALS['argv'] = $argv;",
    "$GLOBALS['argc'] = $argc;"
  ]
}

function compatibilityManifest (linuxContext, compose) {
  const identity = linuxContext.identity
  const selectedRoute = {
    id: compose ? 'moodle-compose' : 'moodle-native',
    kind: compose ? 'compose' : 'native',
    status: 'resolved',
    reason: compose
      ? 'a reviewed image built from the Docker Official PHP 8.4 FPM base plus pinned nginx and MariaDB satisfies Moodle 5.2'
      : linuxContext.management.family === 'rhel'
        ? 'the parallel Remi PHP 8.4 SCL supplies sodium without replacing the distribution PHP; nginx and the reviewed MariaDB profile remain native'
        : requiresEl9Streams(linuxContext)
          ? 'reviewed PHP 8.3, nginx 1.26, and MariaDB 10.11 module streams resolve the EL9 defaults below Moodle minima'
          : 'the reviewed distribution PHP, nginx, and MariaDB profile satisfies Moodle 5.2',
    components: compose
      ? [
          { profileId: 'moodle', selectedVersion: VERSION, source: `commit:${SOURCE_COMMIT}`, status: 'supported' },
          { profileId: 'php-fpm', selectedVersion: '8.4', source: PHP_IMAGE, status: 'supported' },
          { profileId: 'nginx', selectedVersion: '1.30.4', source: NGINX_IMAGE, status: 'supported' },
          { profileId: 'mariadb', selectedVersion: '11.8.8', source: DATABASE_IMAGE, status: 'supported' }
        ]
      : [
          { profileId: 'moodle', selectedVersion: VERSION, source: 'verified-official-source-commit', status: 'supported' },
          { profileId: 'php-fpm', selectedVersion: linuxContext.management.family === 'rhel' ? '8.4' : 'runtime-preflight', source: linuxContext.management.family === 'rhel' ? 'remi-scl' : 'reviewed-distro-profile', status: 'supported' },
          { profileId: 'nginx', selectedVersion: requiresEl9Streams(linuxContext) ? '1.26' : 'distribution-supported', source: 'reviewed-distro-profile', status: 'supported' },
          { profileId: 'mariadb', selectedVersion: requiresEl9Streams(linuxContext) ? '10.11' : 'distribution-supported', source: 'reviewed-distro-profile', status: 'supported' }
        ]
  }
  return {
    format: 'webminai-compatibility-manifest',
    version: 1,
    generatedAt: new Date().toISOString(),
    application: { id: 'moodle', version: VERSION },
    host: { fingerprint: linuxContext.fingerprint, distribution: identity.id, distributionVersion: identity.versionId, architecture: identity.architecture, family: linuxContext.management.family },
    status: 'resolved',
    selectedRoute,
    evaluatedRoutes: [selectedRoute],
    reason: selectedRoute.reason,
    officialRequirements: { php: '>=8.3.0 <8.5.0; 64-bit; sodium; max_input_vars>=5000', mariadb: '>=10.11.0', webRoot: 'public/', cron: 'recurring' },
    artifact: { url: ARCHIVE_URL, commit: SOURCE_COMMIT, sha256: ARCHIVE_SHA256 },
    sources: ['https://moodledev.io/general/releases/5.2', 'https://download.moodle.org/releases/latest/', 'https://moodledev.io/docs/5.2/guides/restructure', 'https://docs.moodle.org/502/en/Installing_Moodle_using_command_line', 'https://docs.moodle.org/500/en/Cron_with_Unix_or_Linux', 'https://hub.docker.com/_/php/tags?name=8.4-fpm', 'https://blog.remirepo.net/post/2024/11/21/PHP-version-8.4-is-released', 'https://rpms.remirepo.net/']
  }
}

function applicationContract () {
  return { id: 'moodle', label: 'Moodle', project: PROJECT, port: PORT, webRoot: WEB_ROOT, artifacts: ARTIFACTS, credentials: CREDENTIALS, database: DATABASE, serviceRoot: SERVICE_ROOT, marker: MARKER, images: [PHP_IMAGE, MOODLE_IMAGE, NGINX_IMAGE, DATABASE_IMAGE] }
}

function requiresEl9Streams (linuxContext) {
  return linuxContext?.management?.family === 'rhel' && ['almalinux', 'rocky', 'ol'].includes(linuxContext?.identity?.id)
}

function assignPhases (plan) {
  const phases = {
    'prepare-moodle-swap': 'services',
    'extract-moodle': 'configure',
    'configure-moodle-cron': 'services',
    'install-moodle': 'initialize',
    'initialize-moodle': 'initialize',
    'verify-moodle': 'verify'
  }
  for (const item of plan.commands) item.phase = phases[item.id] ?? item.phase ?? 'verify'
  for (const item of plan.revertCommands) item.phase = 'cleanup'
}

function replaceCommand (plan, id, commandText, purpose) {
  const item = plan.commands.find(command => command.id === id)
  if (!item) throw new Error(`Moodle foundation is missing ${id}`)
  item.command = commandText
  if (purpose) item.purpose = purpose
}

function renameCommand (plan, oldId, newId, commandText, purpose) {
  const item = plan.commands.find(command => command.id === oldId)
  if (!item) throw new Error(`Moodle foundation is missing ${oldId}`)
  item.id = newId
  item.command = commandText
  item.purpose = purpose
  for (const command of [...plan.commands, ...plan.revertCommands]) command.dependsOn = command.dependsOn.map(id => id === oldId ? newId : id)
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
