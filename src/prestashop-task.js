import { deploymentBlueprint, validateApplicationDeltaPlan } from './application-delta.js'
import { buildLinuxPhpApplicationFoundation, linuxPhpApplicationProfile } from './linux-php-foundation.js'

const VERSION = '9.1.4'
const DISTRIBUTION = '5.0'
const ARCHIVE_URL = `https://api.prestashop-project.org/assets/prestashop-classic/${VERSION}-${DISTRIBUTION}/prestashop.zip`
const ARCHIVE_MD5 = '5196932098a06c15dfefa5d08b1c5328'
const ARCHIVE_SHA256 = '67babe2beb58ea242ca09f2942a301e5e09567c0e04f88525b2cfb6f671a5eeb'
const INNER_SHA256 = '187175adafc6038db7de06e755523e095d384c60233ef1aa4d053f5cc9f4be3e'
const PRESTASHOP_IMAGE = 'prestashop/prestashop:9.1.4-5.0-classic-8.4-fpm'
const NGINX_IMAGE = 'nginx:1.30.4-alpine'
const DATABASE_IMAGE = 'mariadb:11.8.8'
const PORT = 18105
const MARKER = 'WEBMINAI_PRESTASHOP_OK'
const SITE = 'webminai-prestashop-18105'
const WEB_ROOT = `/srv/${SITE}`
const ARTIFACTS = `/var/lib/webminai/${SITE}`
const CREDENTIALS = '/root/prestashop_credentials'
const DATABASE = 'webminai_prestashop_18105'
const SERVICE_ROOT = '/opt/webminai/services/prestashop'
const PROJECT = 'webminai-prestashop-18105'
const SWAP_FILE = `/var/lib/webminai/${SITE}.swap`
const ADMIN_DIRECTORY = 'admin-webminai'
const MODULE_BATCHES = [
  ['ps_linklist']
]

export function buildPrestaShopTask (taskId, linuxContext, docker = {}) {
  const compose = docker.preferred === true
  const built = buildLinuxPhpApplicationFoundation({ taskId, linuxContext, docker, application: applicationContract() })
  const manifest = compatibilityManifest(linuxContext, compose)

  if (compose) configureComposePlan(built, taskId, linuxContext)
  else configureNativePlan(built, taskId, linuxContext)

  const deltaCommands = built.plan.commands.filter(item => ['extract-prestashop', 'install-prestashop', 'verify-prestashop', 'write-compose', 'initialize-prestashop'].some(prefix => item.id.startsWith(prefix)))
  validateApplicationDeltaPlan({ commands: deltaCommands, revertCommands: [] })
  built.plan.summary = `Deploy a learned reversible ${compose ? 'PrestaShop Compose store' : 'native PrestaShop store'}`
  built.plan.changeOverview = `Compose the reviewed nginx/PHP-FPM/database foundation with digest-verified PrestaShop ${VERSION} on port ${PORT}.`
  built.plan.assumptions = [
    `Compatibility resolved from PrestaShop ${VERSION}'s official PHP, database, and nginx requirements before planning.`,
    compose
      ? 'The pinned official PrestaShop PHP 8.4 FPM, nginx, and MariaDB images satisfy the resolved row.'
      : 'The reviewed distro profile supplies PHP 8.1-8.5, MariaDB 10.2+, and nginx; EL9 selects task-owned module streams when necessary.',
    'Administrator and database passwords are generated on-host and consumed only from protected files.'
  ]
  built.plan.warnings = [
    `This controlled test serves HTTP on isolated port ${PORT}.`,
    'The root-owned installer bootstrap receives credential file paths and appends their values only inside the PHP process.'
  ]
  built.plan.compatibilityManifest = manifest
  built.plan.modifiedFiles = [...new Set(built.plan.modifiedFiles.filter(path => !/sites\/default|install-prestashop\.php|reconcile-prestashop\.php/u.test(path)))]
  built.plan.applicationDelta = deploymentBlueprint({
    manifest,
    foundationPhases: [...new Set(built.plan.commands.filter(item => !deltaCommands.includes(item)).map(item => item.phase))],
    foundationPaths: built.plan.modifiedFiles.filter(path => !path.endsWith('/prestashop.zip'))
  })
  return built
}

export function prestaShopRelease () {
  return Object.freeze({ version: VERSION, distribution: DISTRIBUTION, url: ARCHIVE_URL, md5: ARCHIVE_MD5, sha256: ARCHIVE_SHA256, innerSha256: INNER_SHA256, image: PRESTASHOP_IMAGE })
}

export function prestaShopComposeAssets () {
  return Object.freeze({
    installer: Object.freeze(installerBootstrapLines()),
    nginx: Object.freeze(nginxConfig()),
    phpFpm: Object.freeze(fpmSocketConfig())
  })
}

function configureNativePlan (built, taskId, linuxContext) {
  const profile = linuxPhpApplicationProfile(linuxContext, applicationContract())
  const state = `/var/lib/webminai/task-state/${taskId}-prestashop-linux`
  replaceCommand(built.plan, 'capture-baseline', nativeBaselineCommand(built.plan.commands.find(item => item.id === 'capture-baseline').command, state, linuxContext))
  replaceCommand(built.plan, 'install-packages', nativePackagesCommand(built.plan.commands.find(item => item.id === 'install-packages').command, state, linuxContext, profile))
  replaceCommand(built.plan, 'verify-artifacts', artifactCommand(profile), 'Acquire and verify the exact official PrestaShop distribution')
  renameCommand(built.plan, 'extract-application', 'extract-prestashop', extractCommand(profile), 'Extract the nested verified PrestaShop distribution with reviewed ownership and permissions')
  renameCommand(built.plan, 'install-application', 'install-prestashop', installCommand(profile, state), 'Initialize the PrestaShop database using protected credential-file indirection inside PHP')
  renameCommand(built.plan, 'verify-application', 'verify-prestashop')
  insertSequentialCommands(built.plan, 'install-prestashop', 'verify-prestashop', nativeInstallSteps(profile, state))
  replaceCommand(built.plan, 'verify-prestashop', nativeVerifyCommand(profile), 'Verify PrestaShop configuration, database state, installer removal, socket, and external marker')
  enhanceNativeModuleRestore(built.plan, state, linuxContext)
  built.plan.modifiedFiles.push(`${ARTIFACTS}/prestashop.zip`, `${state}/installer-argv.php`, `${WEB_ROOT}/app/config/parameters.php`)
  built.verifyApplied = `test -f ${quote(`${WEB_ROOT}/.webminai-installed`)} && test -f ${quote(`${WEB_ROOT}/app/config/parameters.php`)} && test ! -d ${quote(`${WEB_ROOT}/install`)} && test -S ${quote(profile.phpFpmListener)} && curl --fail --location --silent --show-error --max-time 10 http://127.0.0.1:${PORT}/ | grep -Fq ${MARKER}`
  built.verifyReverted = `test ! -e ${quote(WEB_ROOT)} && test ! -e ${quote(ARTIFACTS)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)}`
}

function configureComposePlan (built, taskId, linuxContext) {
  const state = `/var/lib/webminai/task-state/${taskId}-prestashop-compose`
  replaceCommand(built.plan, 'write-compose', composeCommand(), 'Write the pinned PrestaShop PHP-FPM, nginx, and MariaDB Compose application using file-backed secrets')
  replaceCommand(built.plan, 'pull-images', pullCommand(state), 'Pull and record the pinned official PrestaShop PHP-FPM, nginx, and MariaDB images')
  replaceCommand(built.plan, 'start-compose', startCommand(), 'Start MariaDB, PrestaShop PHP-FPM, and nginx and wait through bounded readiness')
  insertComposeSwapFoundation(built.plan, state)
  renameCommand(built.plan, 'initialize-application', 'initialize-prestashop', composeInstallStepCommand(linuxContext, 'database'), 'Initialize the PrestaShop database inside the container using protected credential-file indirection')
  insertSequentialCommands(built.plan, 'initialize-prestashop', 'verify-compose', composeInstallSteps(linuxContext))
  replaceCommand(built.plan, 'verify-compose', composeVerifyCommand(linuxContext), 'Verify Compose health, Unix socket, protected configuration, and the PrestaShop marker')
  built.plan.modifiedFiles.push(`${SERVICE_ROOT}/compose.yaml`, `${SERVICE_ROOT}/php-fpm.conf`, `${SERVICE_ROOT}/nginx.conf`, `${SERVICE_ROOT}/installer-argv.php`, SWAP_FILE)
  built.verifyApplied = `cd ${quote(SERVICE_ROOT)} && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq prestashop && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq nginx && docker compose -p ${quote(PROJECT)} exec -T prestashop test -S /run/php-fpm/webminai.sock && docker compose -p ${quote(PROJECT)} exec -T prestashop test -f /var/www/html/.webminai-installed && docker compose -p ${quote(PROJECT)} exec -T prestashop test -f /var/www/html/${ADMIN_DIRECTORY}/index.php && docker compose -p ${quote(PROJECT)} exec -T prestashop test ! -d /var/www/html/install && curl --fail --location --silent --show-error --max-time 10 http://127.0.0.1:${PORT}/ | grep -Fq ${MARKER}`
  built.verifyReverted = `test ! -e ${quote(SERVICE_ROOT)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)} && test ! -e ${quote(SWAP_FILE)} && { ! command -v docker >/dev/null 2>&1 || ! docker ps -aq --filter label=com.docker.compose.project=${quote(PROJECT)} | grep -q .; }`
}

function insertComposeSwapFoundation (plan, state) {
  const startIndex = plan.commands.findIndex(command => command.id === 'start-compose')
  const start = plan.commands[startIndex]
  if (startIndex < 0 || !start) throw new Error('PrestaShop foundation is missing start-compose')
  const prepare = {
    ...start,
    id: 'prepare-prestashop-swap',
    purpose: 'Provide reversible task-owned swap headroom for the memory-intensive PrestaShop installer',
    command: `set -eu; if [ ! -e ${quote(`${state}/swap-created`)} ]; then [ ! -e ${quote(SWAP_FILE)} ]; fallocate -l 1G ${quote(SWAP_FILE)}; chmod 0600 ${quote(SWAP_FILE)}; mkswap ${quote(SWAP_FILE)} >/dev/null; swapon ${quote(SWAP_FILE)}; : > ${quote(`${state}/swap-created`)}; fi; grep -Fq ${quote(SWAP_FILE)} /proc/swaps; printf '%s\n' swap-ready`,
    dependsOn: [...start.dependsOn],
    phase: 'services'
  }
  plan.commands.splice(startIndex, 0, prepare)
  start.dependsOn = ['prepare-prestashop-swap']

  const projectIndex = plan.revertCommands.findIndex(command => command.id === 'remove-compose-project')
  const project = plan.revertCommands[projectIndex]
  if (projectIndex < 0 || !project) throw new Error('PrestaShop foundation is missing remove-compose-project')
  const removeSwap = {
    ...project,
    id: 'remove-prestashop-swap',
    purpose: 'Disable and remove only the task-owned PrestaShop swap file',
    command: `set -eu; if [ -e ${quote(`${state}/swap-created`)} ]; then swapoff ${quote(SWAP_FILE)} 2>/dev/null || true; rm -f -- ${quote(SWAP_FILE)}; fi; test ! -e ${quote(SWAP_FILE)}; printf '%s\n' swap-removed`,
    dependsOn: ['remove-compose-project'],
    phase: 'cleanup'
  }
  plan.revertCommands.splice(projectIndex + 1, 0, removeSwap)
  for (const command of plan.revertCommands) {
    if (command.id !== removeSwap.id) command.dependsOn = command.dependsOn.map(id => id === 'remove-compose-project' ? removeSwap.id : id)
  }
}

function nativeBaselineCommand (foundation, state, linuxContext) {
  if (!requiresEl9Streams(linuxContext)) return foundation
  const suffix = "fi; printf '%s\n' baseline-ready"
  if (!foundation.endsWith(suffix)) throw new Error('PrestaShop foundation baseline hook is unavailable')
  return foundation.replace(suffix, [
    'php_stream=$(dnf -q module list php --enabled 2>/dev/null | awk \'$1 == "php" { print $2; exit }\')',
    `printf '%s\\n' "$php_stream" > ${quote(`${state}/php-stream.before`)}`,
    suffix
  ].join('; '))
}

function nativePackagesCommand (foundation, state, linuxContext, profile) {
  const suffix = "printf '%s\n' packages-ready"
  if (!foundation.endsWith(suffix)) throw new Error('PrestaShop foundation package hook is unavailable')
  let command = linuxContext.management.family === 'alpine'
    ? foundation.replace('set -eu; ', 'set -eu; apk add --no-cache php83-pdo php83-pdo_mysql; ')
    : foundation
  if (requiresEl9Streams(linuxContext)) {
    const prepare = [
      `php_stream=$(sed -n 1p ${quote(`${state}/php-stream.before`)})`,
      '[ -z "$php_stream" ] || [ "$php_stream" = 8.3 ] || { printf \'%s\\n\' "unsupported pre-existing PHP module stream: $php_stream" >&2; exit 1; }',
      `[ -n "$php_stream" ] || { dnf -y module enable php:8.3; : > ${quote(`${state}/php-stream.changed`)}; }`
    ].join('; ')
    command = command.replace('set -eu; ', `set -eu; ${prepare}; `)
  }
  const version = `${quote(profile.phpBinary)} -r ${quote('exit(PHP_VERSION_ID >= 80100 && PHP_VERSION_ID < 80600 ? 0 : 1);')}`
  return command.replace(suffix, `${version}; ${suffix}`)
}

function enhanceNativeModuleRestore (plan, state, linuxContext) {
  if (!requiresEl9Streams(linuxContext)) return
  const restore = plan.revertCommands.find(item => item.id === 'restore-packages-services')
  restore.command = restore.command.replace(`rm -rf -- ${quote(state)}`, `if [ -e ${quote(`${state}/php-stream.changed`)} ]; then dnf -y module reset php; fi; rm -rf -- ${quote(state)}`)
}

function artifactCommand (profile) {
  const archive = `${ARTIFACTS}/prestashop.zip`
  const check = `exit(hash_file('md5', $argv[1]) === '${ARCHIVE_MD5}' && hash_file('sha256', $argv[1]) === '${ARCHIVE_SHA256}' ? 0 : 1);`
  return [
    'set -eu',
    `install -d -o root -g root -m 0755 ${quote(ARTIFACTS)}`,
    `if [ -s ${quote(archive)} ] && ${quote(profile.phpBinary)} -r ${quote(check)} ${quote(archive)}; then printf '%s\n' artifact-already-verified; exit 0; fi`,
    `curl --fail --location --silent --show-error --output ${quote(`${archive}.tmp`)} ${quote(ARCHIVE_URL)}`,
    `${quote(profile.phpBinary)} -r ${quote(check)} ${quote(`${archive}.tmp`)}`,
    `mv -f -- ${quote(`${archive}.tmp`)} ${quote(archive)}`,
    "printf '%s\n' artifact-verified"
  ].join('; ')
}

function extractCommand (profile) {
  const outer = 'if (($zip = new ZipArchive()) === false || $zip->open($argv[1]) !== true || !$zip->extractTo($argv[2], [\'prestashop.zip\'])) { exit(1); } $zip->close();'
  const inner = 'if (($zip = new ZipArchive()) === false || $zip->open($argv[1]) !== true || !$zip->extractTo($argv[2])) { exit(1); } $zip->close();'
  return [
    'set -eu',
    `if [ ! -f ${quote(`${WEB_ROOT}/index.php`)} ]; then :`,
    `work=$(mktemp -d ${quote('/var/lib/webminai/prestashop-extract.XXXXXX')})`,
    'trap \'rm -rf -- "$work"\' EXIT',
    `${quote(profile.phpBinary)} -r ${quote(outer)} ${quote(`${ARTIFACTS}/prestashop.zip`)} "$work"`,
    `printf '%s  %s\n' ${quote(INNER_SHA256)} "$work/prestashop.zip" | sha256sum -c - >/dev/null`,
    'install -d -m 0755 "$work/app"',
    `${quote(profile.phpBinary)} -r ${quote(inner)} "$work/prestashop.zip" "$work/app"`,
    '[ -f "$work/app/index.php" ] && [ -f "$work/app/install/index_cli.php" ]',
    `mv "$work/app" ${quote(WEB_ROOT)}`,
    `chown -R ${quote(`${profile.phpFpmUser}:${profile.phpFpmGroup}`)} ${quote(WEB_ROOT)}`,
    `find ${quote(WEB_ROOT)} -type d -exec chmod 0755 {} +`,
    `find ${quote(WEB_ROOT)} -type f -exec chmod 0644 {} +`,
    'trap - EXIT; rm -rf -- "$work"',
    'fi',
    "printf '%s\n' files-ready"
  ].join('; ')
}

function installCommand (profile, state) {
  const bootstrap = `${state}/installer-argv.php`
  return [
    'set -eu',
    `${quote(profile.phpBinary)} -r ${quote("$required=['curl','dom','fileinfo','gd','iconv','intl','json','mbstring','openssl','pdo','pdo_mysql','simplexml','zip']; foreach ($required as $extension) { if (!extension_loaded($extension)) { fwrite(STDERR, 'PHP_EXTENSION_MISSING:' . $extension . PHP_EOL); exit(1); } }")}`,
    `if [ ! -f ${quote(`${WEB_ROOT}/.webminai-installed`)} ]; then :`,
    `bootstrap_candidate=$(mktemp); printf '%s\n' ${installerBootstrapLines().map(quote).join(' ')} > "$bootstrap_candidate"`,
    `install -o root -g root -m 0600 "$bootstrap_candidate" ${quote(bootstrap)}`,
    'rm -f -- "$bootstrap_candidate"',
    `address=$(${profile.primaryAddressCommand})`,
    '[ -n "$address" ]',
    `${nativeInstallerInvocation(profile, state, 'database')} >/dev/null 2>&1`,
    `test -f ${quote(`${WEB_ROOT}/app/config/parameters.php`)}`,
    'fi',
    "printf '%s\n' prestashop-database-ready"
  ].join('; ')
}

function nativeInstallSteps (profile, state) {
  const modules = MODULE_BATCHES.map((batch, index) => ({
    id: `install-prestashop-modules-${index + 1}`,
    purpose: `Install reviewed PrestaShop storefront module batch ${index + 1}`,
    command: nativeInstallStepCommand(profile, state, 'modules', false, batch)
  }))
  return [...modules, {
    id: 'install-prestashop-theme-postinstall',
    purpose: 'Install the classic theme and run its context-dependent post-install phase together',
    command: nativeInstallStepCommand(profile, state, 'theme,postInstall', false)
  }, {
    id: 'install-prestashop-finalize',
    purpose: 'Run the independently context-initialized PrestaShop finalize phase',
    command: nativeInstallStepCommand(profile, state, 'finalize', true)
  }]
}

function nativeInstallStepCommand (profile, state, step, finish, modules = []) {
  const commands = [
    'set -eu',
    `address=$(${profile.primaryAddressCommand})`,
    '[ -n "$address" ]',
    `if [ ! -f ${quote(`${WEB_ROOT}/.webminai-installed`)} ]; then ${nativeInstallerInvocation(profile, state, step, modules)} >/dev/null 2>&1`
  ]
  if (finish) {
    commands.push(
      `rm -rf -- ${quote(`${WEB_ROOT}/install`)}`,
      `printf '%s\n' installation-completed > ${quote(`${WEB_ROOT}/.webminai-installed`)}`,
      `chown -R ${quote(`${profile.phpFpmUser}:${profile.phpFpmGroup}`)} ${quote(WEB_ROOT)}`,
      `chmod 0640 ${quote(`${WEB_ROOT}/app/config/parameters.php`)}`
    )
  }
  commands.push('fi', `printf '%s\n' ${quote(`prestashop-${step.toLowerCase()}-ready`)}`)
  return commands.join('; ')
}

function nativeInstallerInvocation (profile, state, step, modules = []) {
  const selectedModules = modules.length > 0 ? ` --modules=${quote(modules.join(','))}` : ''
  return `WEBMINAI_DB_PASS_FILE=${quote(`${CREDENTIALS}/db_password`)} WEBMINAI_ADMIN_PASSWORD_FILE=${quote(`${CREDENTIALS}/admin_password`)} ${quote(profile.phpBinary)} -d memory_limit=-1 -d auto_prepend_file=${quote(`${state}/installer-argv.php`)} ${quote(`${WEB_ROOT}/install/index_cli.php`)} --step=${quote(step)}${selectedModules} --domain="$address:${PORT}" --db_server=${quote(profile.databaseHost)} --db_user=${quote(DATABASE)} --db_name=${quote(DATABASE)} --db_clear=1 --prefix=wmai_ --name=${quote(MARKER)} --email=intentaiops@example.invalid --firstname=Intent AI Ops --lastname=Administrator --country=us --timezone=Etc/UTC --fixtures=0 --rewrite=1`
}

function nativeVerifyCommand (profile) {
  return [
    'set -eu',
    `test -S ${quote(profile.phpFpmListener)} || { printf '%s\n' SERVICE_SOCKET_NOT_READY >&2; exit 1; }`,
    `test -f ${quote(`${WEB_ROOT}/.webminai-installed`)} || { printf '%s\n' INSTALL_MARKER_MISSING >&2; exit 1; }`,
    `test -f ${quote(`${WEB_ROOT}/app/config/parameters.php`)} || { printf '%s\n' APP_CONFIG_MISSING >&2; exit 1; }`,
    `test ! -d ${quote(`${WEB_ROOT}/install`)} || { printf '%s\n' INSTALLER_DIRECTORY_PRESENT >&2; exit 1; }`,
    `test "$(stat -c %a ${quote(`${WEB_ROOT}/app/config/parameters.php`)})" = 640 || { printf '%s\n' APP_CONFIG_MODE_INVALID >&2; exit 1; }`,
    `mariadb --protocol=socket -uroot -Nse ${quote(`SELECT COUNT(*) FROM ${DATABASE}.wmai_employee WHERE email='intentaiops@example.invalid';`)} | grep -Fxq 1 || { printf '%s\n' DATABASE_ADMIN_NOT_READY >&2; exit 1; }`,
    `address=$(${profile.primaryAddressCommand})`,
    '[ -n "$address" ] || { printf \'%s\\n\' HOST_ADDRESS_UNAVAILABLE >&2; exit 1; }',
    `ready=; for attempt in $(seq 1 60); do if curl --fail --location --silent --show-error --max-time 5 "http://$address:${PORT}/" 2>/dev/null | grep -Fq ${MARKER}; then ready=yes; break; fi; sleep 2; done`,
    '[ "$ready" = yes ] || { printf \'%s\\n\' APP_HTTP_MARKER_NOT_READY >&2; exit 1; }',
    "printf '%s\n' verification-passed"
  ].join('; ')
}

function composeCommand () {
  const lines = [
    'services:',
    '  db:',
    `    image: ${DATABASE_IMAGE}`,
    '    restart: unless-stopped',
    '    environment:',
    `      MARIADB_DATABASE: ${DATABASE}`,
    `      MARIADB_USER: ${DATABASE}`,
    '      MARIADB_PASSWORD_FILE: /run/secrets/db_password',
    '      MARIADB_ROOT_PASSWORD_FILE: /run/secrets/db_root_password',
    '    secrets:',
    '      - db_password',
    '      - db_root_password',
    '    volumes:',
    '      - db_data:/var/lib/mysql',
    '    healthcheck:',
    '      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]',
    '      interval: 5s',
    '      timeout: 5s',
    '      retries: 30',
    '  prestashop:',
    `    image: ${PRESTASHOP_IMAGE}`,
    '    restart: unless-stopped',
    '    environment:',
    '      PS_INSTALL_AUTO: "0"',
    '    depends_on:',
    '      db:',
    '        condition: service_healthy',
    '    secrets:',
    '      - db_password',
    '      - admin_password',
    '    volumes:',
    '      - prestashop_data:/var/www/html',
    '      - php_run:/run/php-fpm',
    '      - ./php-fpm.conf:/usr/local/etc/php-fpm.d/zz-webminai-socket.conf:ro',
    '      - ./installer-argv.php:/run/webminai/installer-argv.php:ro',
    '  nginx:',
    `    image: ${NGINX_IMAGE}`,
    '    restart: unless-stopped',
    '    depends_on:',
    '      - prestashop',
    '    ports:',
    `      - "${PORT}:80"`,
    '    volumes:',
    '      - prestashop_data:/var/www/html:ro',
    '      - php_run:/run/php-fpm',
    '      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro',
    'secrets:',
    '  db_password:',
    `    file: ${CREDENTIALS}/db_password`,
    '  db_root_password:',
    `    file: ${CREDENTIALS}/db_root_password`,
    '  admin_password:',
    `    file: ${CREDENTIALS}/admin_password`,
    'volumes:',
    '  db_data:',
    '  prestashop_data:',
    '  php_run:'
  ]
  return [
    'set -eu',
    `install -d -o root -g root -m 0755 ${quote(SERVICE_ROOT)}`,
    `candidate=$(mktemp); printf '%s\n' ${lines.map(quote).join(' ')} > "$candidate"`,
    `if ! cmp -s "$candidate" ${quote(`${SERVICE_ROOT}/compose.yaml`)}; then install -o root -g root -m 0644 "$candidate" ${quote(`${SERVICE_ROOT}/compose.yaml`)}; fi`,
    'rm -f -- "$candidate"',
    `fpm_candidate=$(mktemp); printf '%s\n' ${fpmSocketConfig().map(quote).join(' ')} > "$fpm_candidate"`,
    `install -o root -g root -m 0444 "$fpm_candidate" ${quote(`${SERVICE_ROOT}/php-fpm.conf`)}`,
    'rm -f -- "$fpm_candidate"',
    `nginx_candidate=$(mktemp); printf '%s\n' ${nginxConfig().map(quote).join(' ')} > "$nginx_candidate"`,
    `install -o root -g root -m 0444 "$nginx_candidate" ${quote(`${SERVICE_ROOT}/nginx.conf`)}`,
    'rm -f -- "$nginx_candidate"',
    `bootstrap_candidate=$(mktemp); printf '%s\n' ${installerBootstrapLines().map(quote).join(' ')} > "$bootstrap_candidate"`,
    `install -o root -g root -m 0444 "$bootstrap_candidate" ${quote(`${SERVICE_ROOT}/installer-argv.php`)}`,
    'rm -f -- "$bootstrap_candidate"',
    `grep -Fq ${quote(`file: ${CREDENTIALS}/admin_password`)} ${quote(`${SERVICE_ROOT}/compose.yaml`)}`,
    `grep -Fq 'fastcgi_pass unix:/run/php-fpm/webminai.sock' ${quote(`${SERVICE_ROOT}/nginx.conf`)}`,
    `! grep -Eq '[0-9a-f]{32,}' ${quote(`${SERVICE_ROOT}/compose.yaml`)}`,
    "printf '%s\n' compose-ready"
  ].join('; ')
}

function pullCommand (state) {
  return `set -eu; cd ${quote(SERVICE_ROOT)}; docker compose -p ${quote(PROJECT)} pull; docker image inspect ${quote(PRESTASHOP_IMAGE)} --format '{{.Id}}' > ${quote(`${state}/image-0.after`)}; cp ${quote(`${state}/image-0.after`)} ${quote(`${state}/image-1.after`)}; docker image inspect ${quote(NGINX_IMAGE)} --format '{{.Id}}' > ${quote(`${state}/image-2.after`)}; docker image inspect ${quote(DATABASE_IMAGE)} --format '{{.Id}}' > ${quote(`${state}/image-3.after`)}; printf '%s\n' images-pulled`
}

function startCommand () {
  return `set -eu; cd ${quote(SERVICE_ROOT)}; docker compose -p ${quote(PROJECT)} up -d db prestashop nginx; ready=; for attempt in $(seq 1 90); do if docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq db && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq prestashop && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq nginx && docker compose -p ${quote(PROJECT)} exec -T prestashop test -S /run/php-fpm/webminai.sock && docker compose -p ${quote(PROJECT)} exec -T prestashop /bin/sh -c 'test -f /var/www/html/.webminai-installed || test -f /var/www/html/install/index_cli.php'; then ready=yes; break; fi; sleep 2; done; [ "$ready" = yes ]; printf '%s\n' compose-started`
}

function composeInstallSteps (linuxContext) {
  const modules = MODULE_BATCHES.map((batch, index) => ({
    id: `initialize-prestashop-modules-${index + 1}`,
    purpose: `Install reviewed PrestaShop storefront module batch ${index + 1} inside the container`,
    command: composeInstallStepCommand(linuxContext, 'modules', false, batch)
  }))
  return [...modules, {
    id: 'initialize-prestashop-theme-postinstall',
    purpose: 'Install the classic theme and run its context-dependent post-install phase together inside the container',
    command: composeInstallStepCommand(linuxContext, 'theme,postInstall')
  }, {
    id: 'initialize-prestashop-finalize',
    purpose: 'Finalize the pinned Compose installation with a deterministic admin path and reviewed Symfony bundle assets',
    command: composeFinalizeCommand(linuxContext)
  }]
}

function composeInstallStepCommand (linuxContext, step, finish = false, modules = []) {
  const addressCommand = linuxContext?.applications?.wordpress?.primaryAddressCommand ?? "ip -4 -o route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i == \"src\") {print $(i+1); exit}}'"
  const selectedModules = modules.length > 0 ? ` --modules=${modules.join(',')}` : ''
  const install = `WEBMINAI_DB_PASS_FILE=/run/secrets/db_password WEBMINAI_ADMIN_PASSWORD_FILE=/run/secrets/admin_password php -d memory_limit=-1 -d auto_prepend_file=/run/webminai/installer-argv.php /var/www/html/install/index_cli.php --step=${step}${selectedModules} --domain="$WEBMINAI_DOMAIN" --db_server=db --db_user=${DATABASE} --db_name=${DATABASE} --db_clear=1 --prefix=wmai_ --name=${MARKER} --email=intentaiops@example.invalid --firstname=Intent AI Ops --lastname=Administrator --country=us --timezone=Etc/UTC --fixtures=0 --rewrite=1`
  const commands = [
    'set -eu',
    `cd ${quote(SERVICE_ROOT)}`,
    `address=$(${addressCommand})`,
    '[ -n "$address" ]',
    `if ! docker compose -p ${quote(PROJECT)} exec -T prestashop test -f /var/www/html/.webminai-installed; then docker compose -p ${quote(PROJECT)} exec -T -e WEBMINAI_DOMAIN="$address:${PORT}" prestashop /bin/sh -c ${quote(`${install} >/dev/null 2>&1`)}`
  ]
  if (finish) {
    commands.push(
      `docker compose -p ${quote(PROJECT)} exec -T prestashop rm -rf -- /var/www/html/install`,
      `docker compose -p ${quote(PROJECT)} exec -T prestashop /bin/sh -c ${quote("printf '%s\\n' installation-completed > /var/www/html/.webminai-installed")}`
    )
  }
  commands.push('fi')
  if (step === 'database') commands.push(`docker compose -p ${quote(PROJECT)} exec -T prestashop test -f /var/www/html/app/config/parameters.php`)
  if (finish) {
    commands.push(
      `docker compose -p ${quote(PROJECT)} exec -T prestashop test ! -d /var/www/html/install`,
      `ready=; for attempt in $(seq 1 60); do if curl --fail --location --silent --show-error --max-time 5 "http://$address:${PORT}/" 2>/dev/null | grep -Fq ${MARKER}; then ready=yes; break; fi; sleep 2; done`,
      '[ "$ready" = yes ]'
    )
  }
  commands.push(`printf '%s\n' ${quote(`prestashop-${step.toLowerCase()}-ready`)}`)
  return commands.join('; ')
}

function composeFinalizeCommand (linuxContext) {
  const addressCommand = linuxContext?.applications?.wordpress?.primaryAddressCommand ?? "ip -4 -o route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i == \"src\") {print $(i+1); exit}}'"
  const finalize = [
    'set -eu',
    `if [ -d /var/www/html/admin ] && [ ! -e /var/www/html/${ADMIN_DIRECTORY} ]; then mv /var/www/html/admin /var/www/html/${ADMIN_DIRECTORY}; fi`,
    `[ -d /var/www/html/${ADMIN_DIRECTORY} ]`,
    `rm -rf -- /var/www/html/${ADMIN_DIRECTORY}/bundles/fosjsrouting`,
    `rm -rf -- /var/www/html/${ADMIN_DIRECTORY}/bundles/apiplatform`,
    `install -d -o www-data -g www-data -m 0755 /var/www/html/${ADMIN_DIRECTORY}/bundles`,
    `ln -s /var/www/html/vendor/friendsofsymfony/jsrouting-bundle/Resources/public /var/www/html/${ADMIN_DIRECTORY}/bundles/fosjsrouting`,
    `ln -s /var/www/html/vendor/api-platform/core/src/Symfony/Bundle/Resources/public /var/www/html/${ADMIN_DIRECTORY}/bundles/apiplatform`,
    `test -f /var/www/html/${ADMIN_DIRECTORY}/index.php`,
    `test -d /var/www/html/${ADMIN_DIRECTORY}/bundles/fosjsrouting`,
    `test -d /var/www/html/${ADMIN_DIRECTORY}/bundles/apiplatform`,
    'chown -R www-data:www-data /var/www/html/var/cache',
    'rm -rf -- /var/www/html/install',
    "printf '%s\\n' installation-completed > /var/www/html/.webminai-installed",
    'chown www-data:www-data /var/www/html/.webminai-installed'
  ].join('; ')
  return [
    'set -eu',
    `cd ${quote(SERVICE_ROOT)}`,
    `address=$(${addressCommand})`,
    '[ -n "$address" ]',
    `if ! docker compose -p ${quote(PROJECT)} exec -T prestashop test -f /var/www/html/.webminai-installed; then docker compose -p ${quote(PROJECT)} exec -T prestashop /bin/sh -c ${quote(finalize)}; fi`,
    `docker compose -p ${quote(PROJECT)} exec -T prestashop test -f /var/www/html/${ADMIN_DIRECTORY}/index.php`,
    `docker compose -p ${quote(PROJECT)} exec -T prestashop test -d /var/www/html/${ADMIN_DIRECTORY}/bundles/fosjsrouting`,
    `docker compose -p ${quote(PROJECT)} exec -T prestashop test -d /var/www/html/${ADMIN_DIRECTORY}/bundles/apiplatform`,
    `docker compose -p ${quote(PROJECT)} exec -T prestashop test -w /var/www/html/var/cache`,
    `docker compose -p ${quote(PROJECT)} exec -T prestashop test ! -d /var/www/html/install`,
    `ready=; for attempt in $(seq 1 60); do if curl --fail --location --silent --show-error --max-time 5 "http://$address:${PORT}/" 2>/dev/null | grep -Fq ${MARKER}; then ready=yes; break; fi; sleep 2; done`,
    '[ "$ready" = yes ]',
    "printf '%s\n' prestashop-finalize-ready"
  ].join('; ')
}

function composeVerifyCommand (linuxContext) {
  const addressCommand = linuxContext?.applications?.wordpress?.primaryAddressCommand ?? "ip -4 -o route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i == \"src\") {print $(i+1); exit}}'"
  return `set -eu; cd ${quote(SERVICE_ROOT)}; docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq prestashop; docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq nginx; docker compose -p ${quote(PROJECT)} exec -T prestashop test -S /run/php-fpm/webminai.sock; docker compose -p ${quote(PROJECT)} exec -T prestashop test -f /var/www/html/.webminai-installed; docker compose -p ${quote(PROJECT)} exec -T prestashop test -f /var/www/html/app/config/parameters.php; docker compose -p ${quote(PROJECT)} exec -T prestashop test -f /var/www/html/${ADMIN_DIRECTORY}/index.php; docker compose -p ${quote(PROJECT)} exec -T prestashop test -d /var/www/html/${ADMIN_DIRECTORY}/bundles/fosjsrouting; docker compose -p ${quote(PROJECT)} exec -T prestashop test -d /var/www/html/${ADMIN_DIRECTORY}/bundles/apiplatform; docker compose -p ${quote(PROJECT)} exec -T prestashop test ! -d /var/www/html/install; address=$(${addressCommand}); [ -n "$address" ]; curl --fail --location --silent --show-error --max-time 20 "http://$address:${PORT}/" | grep -Fq ${MARKER}; printf '%s\n' verification-passed`
}

function fpmSocketConfig () {
  return ['[www]', 'listen = /run/php-fpm/webminai.sock', 'listen.owner = www-data', 'listen.group = www-data', 'listen.mode = 0666']
}

function nginxConfig () {
  return [
    'server {',
    '    listen 80;',
    '    server_name _;',
    '    root /var/www/html;',
    '    index index.php index.html;',
    '    client_max_body_size 16m;',
    '    error_page 404 /index.php?controller=404;',
    '    location / { try_files $uri $uri/ /index.php$is_args$args; }',
    '    location ~ ^/(app|bin|config|install|src|tests|var|vendor)/ { deny all; }',
    '    location ~ \\.php$ {',
    '        try_files $uri =404;',
    '        include fastcgi_params;',
    '        fastcgi_pass unix:/run/php-fpm/webminai.sock;',
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
    "$files = ['db_password' => getenv('WEBMINAI_DB_PASS_FILE'), 'password' => getenv('WEBMINAI_ADMIN_PASSWORD_FILE')];",
    'foreach ($files as $option => $path) {',
    "    if (!$path || !is_file($path)) { fwrite(STDERR, 'missing protected credential file' . PHP_EOL); exit(1); }",
    '    $value = trim((string) file_get_contents($path));',
    "    if ($value === '') { fwrite(STDERR, 'empty protected credential file' . PHP_EOL); exit(1); }",
    "    $argv[] = '--' . $option . '=' . $value;",
    '}',
    '$argc = count($argv);',
    "$GLOBALS['argv'] = $argv;",
    "$GLOBALS['argc'] = $argc;"
  ]
}

function compatibilityManifest (linuxContext, compose) {
  const identity = linuxContext.identity
  const selectedRoute = {
    id: compose ? 'prestashop-compose' : 'prestashop-native',
    kind: compose ? 'compose' : 'native',
    status: 'resolved',
    reason: compose
      ? 'the official pinned PrestaShop PHP 8.4 FPM image, nginx image, and MariaDB image satisfy the supported row'
      : requiresEl9Streams(linuxContext)
        ? 'reviewed PHP 8.3, nginx 1.26, and MariaDB 10.11 module streams resolve the EL9 repository defaults'
        : 'the reviewed distribution PHP, nginx, and MariaDB profile satisfies PrestaShop 9.1 requirements',
    components: compose
      ? [
          { profileId: 'prestashop', selectedVersion: VERSION, source: PRESTASHOP_IMAGE, status: 'supported' },
          { profileId: 'php-fpm', selectedVersion: '8.4', source: PRESTASHOP_IMAGE, status: 'supported' },
          { profileId: 'nginx', selectedVersion: '1.30.4', source: NGINX_IMAGE, status: 'supported' },
          { profileId: 'mariadb', selectedVersion: '11.8.8', source: DATABASE_IMAGE, status: 'supported' }
        ]
      : [
          { profileId: 'prestashop', selectedVersion: VERSION, source: 'verified-official-distribution', status: 'supported' },
          { profileId: 'php-fpm', selectedVersion: requiresEl9Streams(linuxContext) ? '8.3' : linuxContext.stackProfiles.profiles['php-fpm'].capabilities.profileVersion ?? 'runtime-preflight', source: 'reviewed-distro-profile', status: 'supported' },
          { profileId: 'nginx', selectedVersion: requiresEl9Streams(linuxContext) ? '1.26' : 'distribution-supported', source: 'reviewed-distro-profile', status: 'supported' },
          { profileId: 'mariadb', selectedVersion: requiresEl9Streams(linuxContext) ? '10.11' : 'distribution-supported', source: 'reviewed-distro-profile', status: 'supported' }
        ]
  }
  return {
    format: 'webminai-compatibility-manifest',
    version: 1,
    generatedAt: new Date().toISOString(),
    application: { id: 'prestashop', version: VERSION },
    host: { fingerprint: linuxContext.fingerprint, distribution: identity.id, distributionVersion: identity.versionId, architecture: identity.architecture, family: linuxContext.management.family },
    status: 'resolved',
    selectedRoute,
    evaluatedRoutes: [selectedRoute],
    reason: selectedRoute.reason,
    officialRequirements: { php: '>=8.1.0 <8.6.0', mariadb: '>=10.2.0', nginx: '>=1.0.0' },
    artifact: { url: ARCHIVE_URL, md5: ARCHIVE_MD5, sha256: ARCHIVE_SHA256, innerSha256: INNER_SHA256 },
    sources: ['https://devdocs.prestashop-project.org/9/basics/installation/system-requirements/', 'https://devdocs.prestashop-project.org/9/basics/installation/advanced/nginx/', 'https://devdocs.prestashop-project.org/9/basics/installation/advanced/install-from-cli/', 'https://prestashop.com/direct-downloads-for-automation-integration/']
  }
}

function applicationContract () {
  return { id: 'prestashop', label: 'PrestaShop', project: PROJECT, port: PORT, webRoot: WEB_ROOT, artifacts: ARTIFACTS, credentials: CREDENTIALS, database: DATABASE, serviceRoot: SERVICE_ROOT, marker: MARKER, images: [PRESTASHOP_IMAGE, NGINX_IMAGE, DATABASE_IMAGE] }
}

function requiresEl9Streams (linuxContext) {
  return linuxContext?.management?.family === 'rhel' && ['almalinux', 'rocky', 'ol'].includes(linuxContext?.identity?.id)
}

function replaceCommand (plan, id, commandText, purpose) {
  const item = plan.commands.find(command => command.id === id)
  if (!item) throw new Error(`PrestaShop foundation is missing ${id}`)
  item.command = commandText
  if (purpose) item.purpose = purpose
}

function renameCommand (plan, oldId, newId, commandText, purpose) {
  const item = plan.commands.find(command => command.id === oldId)
  if (!item) throw new Error(`PrestaShop foundation is missing ${oldId}`)
  item.id = newId
  if (commandText) item.command = commandText
  if (purpose) item.purpose = purpose
  for (const command of [...plan.commands, ...plan.revertCommands]) command.dependsOn = command.dependsOn.map(id => id === oldId ? newId : id)
}

function insertSequentialCommands (plan, anchorId, downstreamId, specifications) {
  const anchorIndex = plan.commands.findIndex(command => command.id === anchorId)
  const anchor = plan.commands[anchorIndex]
  if (anchorIndex < 0 || !anchor) throw new Error(`PrestaShop foundation is missing ${anchorId}`)
  let dependency = anchorId
  const additions = specifications.map(specification => {
    const command = { ...anchor, ...specification, dependsOn: [dependency] }
    dependency = command.id
    return command
  })
  plan.commands.splice(anchorIndex + 1, 0, ...additions)
  const downstream = plan.commands.find(command => command.id === downstreamId)
  if (!downstream) throw new Error(`PrestaShop foundation is missing ${downstreamId}`)
  downstream.dependsOn = downstream.dependsOn.map(id => id === anchorId ? dependency : id)
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
