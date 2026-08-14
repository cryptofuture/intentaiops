import { deploymentBlueprint, validateApplicationDeltaPlan } from './application-delta.js'
import { buildLinuxPhpApplicationFoundation, linuxPhpApplicationProfile } from './linux-php-foundation.js'

const VERSION = '11.0.0'
const PLUGIN_URL = `https://downloads.wordpress.org/plugin/woocommerce.${VERSION}.zip`
const PLUGIN_SHA256 = 'ba08c7fc58c98a11f22866269c5832d85c52b664806ec206036f09737ba21666'
const PORT = 18102
const MARKER = 'WEBMINAI_WOOCOMMERCE_OK'
const WORDPRESS_IMAGE = 'wordpress:7.0.2-php8.3-fpm'
const CLI_IMAGE = 'wordpress:cli-2.12.0-php8.3'
const NGINX_IMAGE = 'nginx:1.30.4-alpine'
const DATABASE_IMAGE = 'mariadb:11.8.8'
const SERVICE_ROOT = '/opt/webminai/services/woocommerce'
const CREDENTIALS = '/root/woocommerce_credentials'
const PROJECT = 'webminai-woocommerce-18102'
const WEB_ROOT = '/srv/webminai-woocommerce-18102'
const ARTIFACTS = '/var/lib/webminai/webminai-woocommerce-18102'
const DATABASE = 'webminai_woocommerce_18102'

export function buildWooCommerceTask (taskId, linuxContext, docker = {}) {
  const compose = docker.preferred === true
  const foundation = buildLinuxPhpApplicationFoundation({ taskId, linuxContext, docker, application: applicationContract() })
  const manifest = compatibilityManifest(linuxContext, compose)
  const built = foundation
  if (compose) configureComposeFoundation(built, taskId, linuxContext)
  else configureNativeFoundation(built, linuxContext)
  const deltaCommands = compose
    ? composeDelta(taskId, linuxContext)
    : [nativeDelta(linuxContext)]
  validateApplicationDeltaPlan({ commands: deltaCommands, revertCommands: [] })

  const publish = built.plan.commands.find(command => command.id === 'initialize-wordpress-foundation')
  if (!publish) throw new Error('WooCommerce foundation is missing WordPress initialization')
  const insertAt = built.plan.commands.indexOf(publish) + 1
  deltaCommands[0].dependsOn = [publish.id]
  built.plan.commands.splice(insertAt, 0, ...deltaCommands)
  const verification = built.plan.commands.find(command => command.id === 'verify-compose' || command.id === 'verify-application')
  if (verification) verification.dependsOn = [deltaCommands.at(-1).id]
  assignPhases(built.plan)

  built.plan.summary = `Deploy a learned reversible ${compose ? 'WooCommerce Compose store' : 'native WooCommerce store'}`
  built.plan.changeOverview = `Compose the reviewed WordPress foundation with the pinned WooCommerce ${VERSION} application delta on port ${PORT}.`
  built.plan.assumptions = [
    ...built.plan.assumptions.filter(value => !value.includes('WordPress task')),
    `Compatibility resolved from WooCommerce ${VERSION} requirements before planning.`,
    compose ? 'The pinned WordPress 7.0.2/PHP 8.3/MariaDB 11.8 Compose row satisfies the official requirements.' : 'The reviewed distro PHP profile is validated as PHP 7.4 or newer before plugin activation.'
  ]
  built.plan.warnings = [...built.plan.warnings, 'WooCommerce setup is deliberately minimal; payment, mail, tax, and shipping integrations are not configured.']
  built.plan.modifiedFiles.push(
    compose ? `${SERVICE_ROOT}/woocommerce.11.0.0.zip` : `${ARTIFACTS}/woocommerce.11.0.0.zip`,
    `${WEB_ROOT}/wp-content/plugins/woocommerce`
  )
  built.plan.compatibilityManifest = manifest
  built.plan.applicationDelta = deploymentBlueprint({
    manifest,
    foundationPhases: [...new Set(built.plan.commands.filter(command => !deltaCommands.some(delta => delta.id === command.id)).map(command => command.phase))],
    foundationPaths: built.plan.modifiedFiles.filter(path => !path.includes('/woocommerce.11.0.0.zip'))
  })
  built.verifyApplied = verificationCommand(compose, linuxContext)
  return built
}

export function wooCommerceRelease () {
  return Object.freeze({ version: VERSION, url: PLUGIN_URL, sha256: PLUGIN_SHA256 })
}

function applicationContract () {
  return {
    id: 'woocommerce',
    label: 'WooCommerce',
    project: PROJECT,
    port: PORT,
    webRoot: WEB_ROOT,
    artifacts: ARTIFACTS,
    credentials: CREDENTIALS,
    database: DATABASE,
    serviceRoot: SERVICE_ROOT,
    marker: MARKER,
    images: [WORDPRESS_IMAGE, CLI_IMAGE, NGINX_IMAGE, DATABASE_IMAGE]
  }
}

function configureNativeFoundation (built, linuxContext) {
  const profile = linuxPhpApplicationProfile(linuxContext, applicationContract())
  replaceCommand(built.plan, 'verify-artifacts', wordpressArtifacts(), 'Acquire and verify WordPress core and WP-CLI')
  renameCommand(built.plan, 'extract-application', 'extract-wordpress-foundation', extractWordpress(profile), 'Extract verified WordPress core with explicit WooCommerce ownership')
  renameCommand(built.plan, 'install-application', 'initialize-wordpress-foundation', initializeNativeWordpress(profile), 'Initialize the structured WordPress application phase from protected credential paths')
  replaceCommand(built.plan, 'verify-application', nativeVerification(profile), 'Verify the WooCommerce plugin, database state, and marker product')
  built.plan.modifiedFiles.push(`${ARTIFACTS}/wordpress.tar.gz`, `${ARTIFACTS}/wp-cli.phar`)
}

function configureComposeFoundation (built, taskId, linuxContext) {
  const state = `/var/lib/webminai/task-state/${taskId}-woocommerce-compose`
  replaceCommand(built.plan, 'write-compose', wordpressCompose(), 'Write the pinned WordPress Compose foundation using file-backed secrets')
  replaceCommand(built.plan, 'pull-images', composePull(state), 'Pull and record the pinned WordPress, nginx, and MariaDB images')
  replaceCommand(built.plan, 'start-compose', composeStart(), 'Start the WordPress foundation and wait through bounded readiness')
  renameCommand(built.plan, 'initialize-application', 'initialize-wordpress-foundation', initializeComposeWordpress(linuxContext), 'Initialize the structured WordPress application phase from protected credential paths')
  replaceCommand(built.plan, 'verify-compose', composeVerification(), 'Verify the WooCommerce plugin, marker product, and Compose health')
}

function wordpressArtifacts () {
  return `set -eu; install -d -o root -g root -m 0755 ${quote(ARTIFACTS)}; curl --fail --location --silent --show-error --output ${quote(`${ARTIFACTS}/wordpress.tar.gz`)} https://wordpress.org/latest.tar.gz; curl --fail --location --silent --show-error --output ${quote(`${ARTIFACTS}/wordpress.tar.gz.sha1`)} https://wordpress.org/latest.tar.gz.sha1; expected=$(tr -d '\r\n' < ${quote(`${ARTIFACTS}/wordpress.tar.gz.sha1`)}); [ "$(sha1sum ${quote(`${ARTIFACTS}/wordpress.tar.gz`)} | awk '{print $1}')" = "$expected" ]; curl --fail --location --silent --show-error --output ${quote(`${ARTIFACTS}/wp-cli.phar`)} https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar; curl --fail --location --silent --show-error --output ${quote(`${ARTIFACTS}/wp-cli.phar.sha512`)} https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar.sha512; expected=$(tr -d '\r\n' < ${quote(`${ARTIFACTS}/wp-cli.phar.sha512`)}); [ "$(sha512sum ${quote(`${ARTIFACTS}/wp-cli.phar`)} | awk '{print $1}')" = "$expected" ]; chmod 0755 ${quote(`${ARTIFACTS}/wp-cli.phar`)}; printf '%s\n' artifacts-verified`
}

function extractWordpress (profile) {
  return `set -eu; if [ ! -f ${quote(`${WEB_ROOT}/wp-includes/version.php`)} ]; then work=$(mktemp -d ${quote('/var/lib/webminai/woocommerce-extract.XXXXXX')}); trap 'rm -rf -- "$work"' EXIT; tar -xzf ${quote(`${ARTIFACTS}/wordpress.tar.gz`)} -C "$work"; test -d "$work/wordpress"; mv "$work/wordpress" ${quote(WEB_ROOT)}; chown -R ${quote(`${profile.phpFpmUser}:${profile.phpFpmGroup}`)} ${quote(WEB_ROOT)}; find ${quote(WEB_ROOT)} -type d -exec chmod 0755 {} +; find ${quote(WEB_ROOT)} -type f -exec chmod 0644 {} +; trap - EXIT; rm -rf -- "$work"; fi; printf '%s\n' wordpress-files-ready`
}

function initializeNativeWordpress (profile) {
  const wp = `${quote(profile.phpBinary)} ${quote(`${ARTIFACTS}/wp-cli.phar`)} --allow-root --path=${quote(WEB_ROOT)}`
  return `set -eu; address=$(${profile.primaryAddressCommand}); test -n "$address"; dbpass=$(sed -n 1p ${quote(`${CREDENTIALS}/db_password`)}); if [ ! -f ${quote(`${WEB_ROOT}/wp-config.php`)} ]; then printf '%s\n' "$dbpass" | ${wp} config create --dbname=${DATABASE} --dbuser=${DATABASE} --dbhost=${quote(profile.databaseHost)} --prompt=dbpass --skip-check >/dev/null; fi; if ! ${wp} core is-installed >/dev/null 2>&1; then adminpass=$(sed -n 1p ${quote(`${CREDENTIALS}/admin_password`)}); printf '%s\n' "$adminpass" | ${wp} core install --url="http://$address:${PORT}" --title=${quote(MARKER)} --admin_user=webminai_admin --admin_email=intentaiops@example.invalid --skip-email --prompt=admin_password >/dev/null; fi; chown ${quote(`${profile.phpFpmUser}:${profile.phpFpmGroup}`)} ${quote(`${WEB_ROOT}/wp-config.php`)}; chmod 0640 ${quote(`${WEB_ROOT}/wp-config.php`)}; printf '%s\n' wordpress-foundation-ready`
}

function wordpressCompose () {
  const lines = [
    'services:',
    '  db:',
    `    image: ${DATABASE_IMAGE}`,
    '    restart: unless-stopped',
    `    environment: { MARIADB_DATABASE: ${DATABASE}, MARIADB_USER: ${DATABASE}, MARIADB_PASSWORD_FILE: /run/secrets/db_password, MARIADB_ROOT_PASSWORD_FILE: /run/secrets/db_root_password }`,
    '    secrets: [db_password, db_root_password]',
    '    volumes: [db_data:/var/lib/mysql]',
    '    healthcheck: { test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"], interval: 5s, timeout: 5s, retries: 30 }',
    '  wordpress:',
    `    image: ${WORDPRESS_IMAGE}`,
    '    restart: unless-stopped',
    '    depends_on: { db: { condition: service_healthy } }',
    `    environment: &wordpress_environment { WORDPRESS_DB_HOST: "db:3306", WORDPRESS_DB_NAME: ${DATABASE}, WORDPRESS_DB_USER: ${DATABASE}, WORDPRESS_DB_PASSWORD_FILE: /run/webminai/db_password }`,
    '    command: ["/bin/sh", "-c", "install -o www-data -g www-data -m 0400 /run/secrets/db_password /run/webminai/db_password && exec docker-entrypoint.sh php-fpm"]',
    '    tmpfs: ["/run/webminai:size=64k,mode=0711"]',
    '    secrets: [db_password]',
    '    volumes: [wordpress_data:/var/www/html, php_run:/run/php-fpm, ./php-fpm.conf:/usr/local/etc/php-fpm.d/zz-webminai-socket.conf:ro]',
    '  nginx:',
    `    image: ${NGINX_IMAGE}`,
    '    restart: unless-stopped',
    '    depends_on: [wordpress]',
    `    ports: ["${PORT}:80"]`,
    '    volumes: [wordpress_data:/var/www/html:ro, php_run:/run/php-fpm, ./nginx.conf:/etc/nginx/conf.d/default.conf:ro]',
    '  cli:',
    `    image: ${CLI_IMAGE}`,
    '    profiles: ["tools"]',
    '    user: "0:0"',
    '    environment: { <<: *wordpress_environment, HOME: /tmp, WP_CLI_ALLOW_ROOT: "1", WORDPRESS_DB_PASSWORD_FILE: /run/secrets/db_password }',
    '    secrets: [db_password]',
    '    volumes: [wordpress_data:/var/www/html]',
    'secrets:',
    `  db_password: { file: ${CREDENTIALS}/db_password }`,
    `  db_root_password: { file: ${CREDENTIALS}/db_root_password }`,
    'volumes: { db_data: {}, wordpress_data: {}, php_run: {} }'
  ]
  const fpm = ['[www]', 'listen = /run/php-fpm/webminai.sock', 'listen.owner = www-data', 'listen.group = www-data', 'listen.mode = 0666']
  const nginx = ['server {', '  listen 80;', '  root /var/www/html;', '  index index.php index.html;', '  location / { try_files $uri $uri/ /index.php?$args; }', '  location ~ \\.php$ { include fastcgi_params; fastcgi_pass unix:/run/php-fpm/webminai.sock; fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name; }', '}']
  return `set -eu; install -d -o root -g root -m 0755 ${quote(SERVICE_ROOT)}; printf '%s\n' ${lines.map(quote).join(' ')} > ${quote(`${SERVICE_ROOT}/compose.yaml`)}; printf '%s\n' ${fpm.map(quote).join(' ')} > ${quote(`${SERVICE_ROOT}/php-fpm.conf`)}; printf '%s\n' ${nginx.map(quote).join(' ')} > ${quote(`${SERVICE_ROOT}/nginx.conf`)}; chmod 0644 ${quote(`${SERVICE_ROOT}/compose.yaml`)}; chmod 0444 ${quote(`${SERVICE_ROOT}/php-fpm.conf`)} ${quote(`${SERVICE_ROOT}/nginx.conf`)}; ! grep -Eq '[0-9a-f]{32,}' ${quote(`${SERVICE_ROOT}/compose.yaml`)}; printf '%s\n' compose-ready`
}

function composePull (state) {
  return `set -eu; cd ${quote(SERVICE_ROOT)}; docker compose -p ${quote(PROJECT)} --profile tools pull; ${[WORDPRESS_IMAGE, CLI_IMAGE, NGINX_IMAGE, DATABASE_IMAGE].map((image, index) => `docker image inspect ${quote(image)} --format '{{.Id}}' > ${quote(`${state}/image-${index}.after`)}`).join('; ')}; printf '%s\n' images-pulled`
}

function composeStart () {
  return `set -eu; cd ${quote(SERVICE_ROOT)}; docker compose -p ${quote(PROJECT)} up -d db wordpress nginx; ready=; for attempt in $(seq 1 60); do docker compose -p ${quote(PROJECT)} exec -T wordpress test -S /run/php-fpm/webminai.sock && curl --fail --silent --show-error --max-time 3 http://127.0.0.1:${PORT}/ >/dev/null 2>&1 && { ready=yes; break; }; sleep 2; done; test "$ready" = yes; printf '%s\n' compose-started`
}

function initializeComposeWordpress (linuxContext) {
  const addressCommand = linuxContext?.applications?.wordpress?.primaryAddressCommand ?? "ip -4 -o route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i == \"src\") {print $(i+1); exit}}'"
  const cli = `docker compose -p ${quote(PROJECT)} --profile tools run --rm --no-deps -T --entrypoint /usr/local/bin/wp cli`
  return `set -eu; cd ${quote(SERVICE_ROOT)}; address=$(${addressCommand}); test -n "$address"; if ! ${cli} --allow-root core is-installed >/dev/null 2>&1; then adminpass=$(sed -n 1p ${quote(`${CREDENTIALS}/admin_password`)}); printf '%s\n' "$adminpass" | ${cli} --allow-root core install --url="http://$address:${PORT}" --title=${quote(MARKER)} --admin_user=webminai_admin --admin_email=intentaiops@example.invalid --skip-email --prompt=admin_password >/dev/null; fi; printf '%s\n' wordpress-foundation-ready`
}

function nativeVerification (profile) {
  const wp = `${quote(profile.phpBinary)} ${quote(`${ARTIFACTS}/wp-cli.phar`)} --allow-root --path=${quote(WEB_ROOT)}`
  return `set -eu; ${wp} plugin is-active woocommerce >/dev/null; test "$(${wp} plugin get woocommerce --field=version)" = ${quote(VERSION)}; curl --fail --silent --show-error --max-time 10 http://127.0.0.1:${PORT}/ | grep -Fq ${MARKER}; printf '%s\n' verification-passed`
}

function composeVerification () {
  const cli = `docker compose -p ${quote(PROJECT)} --profile tools run --rm --no-deps -T --entrypoint /usr/local/bin/wp cli`
  return `set -eu; cd ${quote(SERVICE_ROOT)}; ${cli} --allow-root plugin is-active woocommerce >/dev/null; test "$(${cli} --allow-root plugin get woocommerce --field=version)" = ${quote(VERSION)}; docker compose -p ${quote(PROJECT)} exec -T wordpress test -S /run/php-fpm/webminai.sock; curl --fail --silent --show-error --max-time 10 http://127.0.0.1:${PORT}/ | grep -Fq ${MARKER}; printf '%s\n' verification-passed`
}

function nativeDelta (linuxContext) {
  const profile = linuxContext.applications.wordpress
  const wp = `${quote(profile.phpBinary)} ${quote('/var/lib/webminai/webminai-woocommerce-18102/wp-cli.phar')} --allow-root --path=${quote('/srv/webminai-woocommerce-18102')}`
  const artifact = `/var/lib/webminai/webminai-woocommerce-18102/woocommerce.${VERSION}.zip`
  return command('install-woocommerce', 'initialize', [
    'set -eu',
    `${quote(profile.phpBinary)} -r 'exit(PHP_VERSION_ID >= 70400 ? 0 : 1);'`,
    `if [ ! -f ${quote(artifact)} ] || ! printf '%s  %s\n' ${quote(PLUGIN_SHA256)} ${quote(artifact)} | sha256sum -c - >/dev/null 2>&1; then curl --fail --location --silent --show-error --output ${quote(`${artifact}.tmp`)} ${quote(PLUGIN_URL)}; printf '%s  %s\n' ${quote(PLUGIN_SHA256)} ${quote(`${artifact}.tmp`)} | sha256sum -c - >/dev/null; mv -f -- ${quote(`${artifact}.tmp`)} ${quote(artifact)}; fi`,
    `installed=$(${wp} plugin get woocommerce --field=version 2>/dev/null || true)`,
    `if [ "$installed" != ${quote(VERSION)} ]; then ${wp} plugin install ${quote(artifact)} --force --activate >/dev/null; elif ! ${wp} plugin is-active woocommerce >/dev/null 2>&1; then ${wp} plugin activate woocommerce >/dev/null; fi`,
    productCommand(wp),
    `${wp} plugin is-active woocommerce >/dev/null`,
    `test "$(${wp} plugin get woocommerce --field=version)" = ${quote(VERSION)}`,
    `test -n "$(${wp} option get woocommerce_db_version 2>/dev/null)"`,
    'printf \'%s\n\' woocommerce-installed'
  ].join('; '), 'Install the digest-pinned WooCommerce plugin and reconcile one harmless marker product')
}

function composeDelta (taskId, linuxContext) {
  const addressCommand = linuxContext?.applications?.wordpress?.primaryAddressCommand ?? 'ip -o -4 addr show scope global | awk \'{sub(/\\/.*/, "", $4); print $4; exit}\''
  const root = '/opt/webminai/services/woocommerce'
  const artifact = `${root}/woocommerce.${VERSION}.zip`
  const project = 'webminai-woocommerce-18102'
  const state = `/var/lib/webminai/task-state/${taskId}-woocommerce-compose`
  const bootstrap = `webminai-woocommerce-bootstrap-${taskId}`
  const cli = `docker compose -p ${quote(project)} --profile tools run --rm --no-deps -T --entrypoint /usr/local/bin/wp cli`
  const cliShell = `docker compose -p ${quote(project)} --profile tools run --rm --no-deps -T --entrypoint /bin/sh cli -c`
  const prepare = command('prepare-woocommerce-plugin', 'configure', [
    'set -eu',
    `cd ${quote(root)}`,
    `if [ ! -f ${quote(artifact)} ] || ! printf '%s  %s\n' ${quote(PLUGIN_SHA256)} ${quote(artifact)} | sha256sum -c - >/dev/null 2>&1; then curl --fail --location --silent --show-error --output ${quote(`${artifact}.tmp`)} ${quote(PLUGIN_URL)}; printf '%s  %s\n' ${quote(PLUGIN_SHA256)} ${quote(`${artifact}.tmp`)} | sha256sum -c - >/dev/null; mv -f -- ${quote(`${artifact}.tmp`)} ${quote(artifact)}; fi`,
    `docker compose -p ${quote(project)} cp ${quote(artifact)} wordpress:/var/www/html/woocommerce.zip >/dev/null`,
    "printf '%s\n' woocommerce-plugin-prepared"
  ].join('; '), 'Acquire the digest-pinned WooCommerce plugin and place it in the shared WordPress volume')
  const start = command('start-woocommerce-activation', 'initialize', [
    'set -eu',
    `cd ${quote(root)}`,
    `installed=$(${cli} --allow-root plugin get woocommerce --field=version 2>/dev/null || true)`,
    `if [ "$installed" = ${quote(VERSION)} ] && ${cli} --allow-root plugin is-active woocommerce >/dev/null 2>&1; then : > ${quote(`${state}/activation.complete`)}; else rm -f -- ${quote(`${state}/activation.complete`)}; test -z "$(docker ps -aq --filter name=^/${bootstrap}$)"; if [ "$installed" != ${quote(VERSION)} ]; then container=$(docker compose -p ${quote(project)} --profile tools run -d --name ${quote(bootstrap)} --no-deps --entrypoint /usr/local/bin/wp cli --allow-root plugin install /var/www/html/woocommerce.zip --force --activate); else container=$(docker compose -p ${quote(project)} --profile tools run -d --name ${quote(bootstrap)} --no-deps --entrypoint /usr/local/bin/wp cli --allow-root plugin activate woocommerce); fi; printf '%s\n' "$container" > ${quote(`${state}/activation.container`)}; fi`,
    "printf '%s\n' woocommerce-activation-started"
  ].join('; '), 'Start slow first-time WooCommerce activation in a task-owned detached tools container')
  start.dependsOn = [prepare.id]
  const waitFirst = activationWaitCommand({ state, bootstrap, final: false })
  waitFirst.dependsOn = [start.id]
  const waitFinal = activationWaitCommand({ state, bootstrap, final: true })
  waitFinal.dependsOn = [waitFirst.id]
  const finalize = command('configure-woocommerce-store', 'initialize', [
    'set -eu',
    `cd ${quote(root)}`,
    `test -e ${quote(`${state}/activation.complete`)}`,
    `docker compose -p ${quote(project)} exec -T wordpress rm -f -- /var/www/html/woocommerce.zip`,
    `${cliShell} ${quote([productCommand('wp --allow-root'), 'wp --allow-root plugin is-active woocommerce >/dev/null', `test "$(wp --allow-root plugin get woocommerce --field=version)" = ${quote(VERSION)}`, 'test -n "$(wp --allow-root option get woocommerce_db_version 2>/dev/null)"'].join('; '))}`,
    `address=$(${addressCommand})`,
    '[ -n "$address" ]',
    `curl --fail --silent --show-error --max-time 10 "http://$address:${PORT}/" | grep -Fq ${MARKER}`,
    `test -d ${quote(state)}`,
    'printf \'%s\n\' woocommerce-installed'
  ].join('; '), 'Verify WooCommerce activation and reconcile one harmless marker product')
  finalize.dependsOn = [waitFinal.id]
  return [prepare, start, waitFirst, waitFinal, finalize]
}

function activationWaitCommand ({ state, bootstrap, final }) {
  const id = final ? 'finish-woocommerce-activation' : 'wait-woocommerce-activation'
  const tail = final
    ? 'if [ "$(docker inspect -f \'{{.State.Running}}\' "$container" 2>/dev/null || true)" = true ]; then docker rm -f "$container" >/dev/null 2>&1 || true; printf \'%s\n\' \'WooCommerce activation exceeded the bounded startup budget\' >&2; exit 1; fi'
    : 'if [ "$(docker inspect -f \'{{.State.Running}}\' "$container" 2>/dev/null || true)" = true ]; then printf \'%s\n\' woocommerce-activation-pending; exit 0; fi'
  return command(id, 'initialize', [
    'set -eu',
    `state=${quote(state)}`,
    '[ -e "$state/activation.complete" ] && exit 0',
    'container=$(sed -n 1p "$state/activation.container")',
    '[ -n "$container" ]',
    'for attempt in $(seq 1 120); do [ "$(docker inspect -f \'{{.State.Running}}\' "$container" 2>/dev/null || true)" = true ] || break; sleep 2; done',
    tail,
    'code=$(docker inspect -f \'{{.State.ExitCode}}\' "$container")',
    'if [ "$code" -ne 0 ]; then docker logs --tail 50 "$container" >&2 || true; docker rm -f "$container" >/dev/null 2>&1 || true; exit "$code"; fi',
    'docker rm "$container" >/dev/null',
    ': > "$state/activation.complete"',
    'rm -f -- "$state/activation.container"',
    'printf \'%s\n\' woocommerce-activation-complete'
  ].join('; '), final ? 'Finish the second bounded WooCommerce activation wait and require successful exit' : 'Wait through the first bounded WooCommerce activation interval')
}

function productCommand (wp) {
  return [
    `product=$(${wp} post list --post_type=product --name=webminai-woocommerce-product --field=ID --format=ids 2>/dev/null | awk 'NR == 1 { print; exit }')`,
    `if [ -z "$product" ]; then product=$(${wp} post create --post_type=product --post_status=publish --post_name=webminai-woocommerce-product --post_title=${quote('WebminAI WooCommerce Product')} --post_content=${MARKER} --porcelain); elif [ "$(${wp} post get "$product" --field=post_status)" != publish ] || [ "$(${wp} post get "$product" --field=post_title)" != ${quote('WebminAI WooCommerce Product')} ] || [ "$(${wp} post get "$product" --field=post_content)" != ${MARKER} ]; then ${wp} post update "$product" --post_status=publish --post_title=${quote('WebminAI WooCommerce Product')} --post_content=${MARKER} >/dev/null; fi`,
    'case "$product" in \'\'|*[!0-9]*) exit 1;; esac',
    `[ "$(${wp} post meta get "$product" _regular_price 2>/dev/null || true)" = 1.00 ] || ${wp} post meta update "$product" _regular_price 1.00 >/dev/null`,
    `[ "$(${wp} post meta get "$product" _price 2>/dev/null || true)" = 1.00 ] || ${wp} post meta update "$product" _price 1.00 >/dev/null`,
    `[ "$(${wp} post meta get "$product" _stock_status 2>/dev/null || true)" = instock ] || ${wp} post meta update "$product" _stock_status instock >/dev/null`
  ].join('; ')
}

function verificationCommand (compose, linuxContext) {
  if (compose) {
    const cli = `docker compose -p ${quote('webminai-woocommerce-18102')} --profile tools run --rm --no-deps -T --entrypoint /usr/local/bin/wp cli`
    return `cd ${quote('/opt/webminai/services/woocommerce')} && ${cli} --allow-root plugin is-active woocommerce >/dev/null && test "$(${cli} --allow-root plugin get woocommerce --field=version)" = ${quote(VERSION)} && curl --fail --location --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 --max-time 10 http://127.0.0.1:${PORT}/ | grep -Fq ${MARKER}`
  }
  const profile = linuxContext.applications.wordpress
  const wp = `${quote(profile.phpBinary)} ${quote('/var/lib/webminai/webminai-woocommerce-18102/wp-cli.phar')} --allow-root --path=${quote('/srv/webminai-woocommerce-18102')}`
  return `${wp} plugin is-active woocommerce >/dev/null && test "$(${wp} plugin get woocommerce --field=version)" = ${quote(VERSION)} && curl --fail --location --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 --max-time 10 http://127.0.0.1:${PORT}/ | grep -Fq ${MARKER}`
}

function compatibilityManifest (linuxContext, compose) {
  const identity = linuxContext.identity
  const selectedRoute = {
    id: compose ? 'woocommerce-compose' : 'woocommerce-native',
    kind: compose ? 'compose' : 'native',
    status: 'resolved',
    reason: compose
      ? 'pinned WordPress, PHP, and MariaDB images satisfy the official WooCommerce support matrix'
      : 'the reviewed distro PHP profile is supported and execution validates PHP >= 7.4 before plugin activation',
    components: compose
      ? [
          { profileId: 'wordpress', selectedVersion: '7.0.2', source: 'pinned-image', status: 'supported' },
          { profileId: 'php-fpm', selectedVersion: '8.3', source: 'pinned-image', status: 'supported' },
          { profileId: 'mariadb', selectedVersion: '11.8.8', source: 'pinned-image', status: 'supported' }
        ]
      : [
          { profileId: 'wordpress', selectedVersion: '7.0', source: 'official-current-archive', status: 'supported' },
          { profileId: 'php-fpm', selectedVersion: linuxContext.stackProfiles.profiles['php-fpm'].capabilities.profileVersion ?? 'runtime-preflight', source: 'reviewed-distro-profile', status: 'supported' },
          { profileId: 'mariadb', selectedVersion: 'distribution-supported', source: 'reviewed-distro-profile', status: 'supported' }
        ]
  }
  return {
    format: 'webminai-compatibility-manifest',
    version: 1,
    generatedAt: new Date().toISOString(),
    application: { id: 'woocommerce', version: VERSION },
    host: { fingerprint: linuxContext.fingerprint, distribution: identity.id, distributionVersion: identity.versionId, architecture: identity.architecture, family: linuxContext.management.family },
    status: 'resolved',
    selectedRoute,
    evaluatedRoutes: [selectedRoute],
    reason: selectedRoute.reason,
    officialRequirements: { wordpress: '>=6.9', php: '>=7.4', recommendedPhp: '>=8.3', mysql: '>=8.0', mariadb: '>=10.6' },
    artifact: { url: PLUGIN_URL, sha256: PLUGIN_SHA256 },
    sources: ['https://wordpress.org/plugins/woocommerce/', 'https://woocommerce.com/document/server-requirements/']
  }
}

function assignPhases (plan) {
  const phases = {
    'capture-baseline': 'baseline',
    'prepare-docker': 'packages',
    'install-packages': 'packages',
    'verify-artifacts': 'acquire',
    'generate-credentials': 'secrets',
    'prepare-database': 'database',
    'extract-wordpress-foundation': 'configure',
    'extract-wordpress': 'configure',
    'configure-php-fpm': 'configure',
    'configure-nginx': 'configure',
    'write-compose': 'configure',
    'pull-images': 'acquire',
    'start-compose': 'services',
    'install-wordpress': 'initialize',
    'initialize-wordpress': 'initialize',
    'initialize-wordpress-foundation': 'initialize',
    'install-woocommerce': 'initialize',
    'prepare-woocommerce-plugin': 'configure',
    'start-woocommerce-activation': 'initialize',
    'wait-woocommerce-activation': 'initialize',
    'finish-woocommerce-activation': 'initialize',
    'configure-woocommerce-store': 'initialize',
    'publish-and-verify': 'verify',
    'verify-compose': 'verify'
  }
  for (const item of plan.commands) item.phase = phases[item.id] ?? 'verify'
  for (const item of plan.revertCommands) item.phase = 'cleanup'
}

function command (id, phase, commandText, purpose) {
  return { id, phase, command: commandText, purpose, risk: 'change', timeoutMs: 300000, requiresSudo: true, dependsOn: [] }
}

function replaceCommand (plan, id, commandText, purpose) {
  const item = plan.commands.find(command => command.id === id)
  if (!item) throw new Error(`WooCommerce foundation is missing ${id}`)
  item.command = commandText
  if (purpose) item.purpose = purpose
}

function renameCommand (plan, oldId, newId, commandText, purpose) {
  const item = plan.commands.find(command => command.id === oldId)
  if (!item) throw new Error(`WooCommerce foundation is missing ${oldId}`)
  item.id = newId
  item.command = commandText
  item.purpose = purpose
  for (const command of [...plan.commands, ...plan.revertCommands]) {
    command.dependsOn = command.dependsOn.map(id => id === oldId ? newId : id)
  }
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
