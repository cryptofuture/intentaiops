const VERSION = '2.4.8-p5'
const PORT = 18108
const MARKER = 'WEBMINAI_MAGENTO_OK'
const PROJECT = 'webminai-magento-18108'
const SERVICE_ROOT = '/opt/webminai/services/magento'
const COMPOSE_FILE = `${SERVICE_ROOT}/compose.yaml`
const CREDENTIALS = '/root/magento_credentials'
const SWAP_FILE = '/var/lib/webminai/webminai-magento-18108.swap'
const DATABASE = 'webminai_magento_18108'
const MAGENTO_IMAGE = 'mappia/magento2@sha256:4afc75904ccc2a638fda27a5ac03ee8a2db46be49db54363977583c0e0860e2f'
const NGINX_IMAGE = 'nginx@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46'
const DATABASE_IMAGE = 'mariadb@sha256:d9f7eb2637296652f24b484afd5d246f759f49f5babcadc6a9e344c9acb75fbf'
const OPENSEARCH_IMAGE = 'opensearchproject/opensearch@sha256:44ba7ea58a319adf61c33ab16873f9ef5dbb30b291a832d375172f0b2d24e3c9'
const VALKEY_IMAGE = 'valkey/valkey@sha256:d827e7f7552cdee40cc7482dbae9da020f42bc47669af6f71182a4ef76a22773'
const IMAGES = [MAGENTO_IMAGE, NGINX_IMAGE, DATABASE_IMAGE, OPENSEARCH_IMAGE, VALKEY_IMAGE]
const DPKG_PACKAGE_FORMAT = '$' + '{binary:Package}\\n'

export function buildMagentoTask (taskId, linuxContext, docker = {}) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  const identity = linuxContext?.identity ?? {}
  if (docker.preferred !== true) throw new Error('the learned Magento task currently requires the preferred Compose route')
  if (!['ubuntu', 'debian'].includes(identity.id)) throw new Error(`learned Magento Compose setup does not yet support ${identity.id ?? 'this Linux distribution'}`)
  if (!docker.ready && docker.installMethod !== 'official-apt') throw new Error('learned Magento Compose setup requires Docker ready or the reviewed official apt route')

  const state = `/var/lib/webminai/task-state/${taskId}-magento-compose`
  const commands = [
    item('capture-baseline', 'baseline', baselineCommand(state), 'Capture Docker, image, service, and task-path state exactly once'),
    item('prepare-docker', 'packages', prepareDockerCommand(state), 'Install Docker Engine and Compose only when the reviewed host route requires it', ['capture-baseline'], 900000, 'job'),
    item('generate-credentials', 'secrets', credentialsCommand(), 'Generate protected database and administrator credentials on the host', ['capture-baseline']),
    item('write-compose', 'configure', composeCommand(), 'Write the reviewed digest-pinned Magento, nginx, MariaDB, OpenSearch, Valkey, and cron project', ['prepare-docker', 'generate-credentials'], 900000, 'job'),
    item('pull-images', 'acquire', pullCommand(state), 'Pull and record every digest-pinned image', ['write-compose'], 3600000, 'job'),
    item('prepare-code', 'initialize', prepareCodeCommand(), 'Populate the isolated Magento code volume from the pinned application image', ['pull-images'], 900000, 'job'),
    item('prepare-magento-swap', 'services', prepareSwapCommand(state), 'Provide reversible task-owned memory headroom for OpenSearch and Magento initialization', ['prepare-code'], 300000),
    item('start-dependencies', 'services', startCommand(), 'Start MariaDB, OpenSearch, Valkey, Magento PHP-FPM, and nginx with bounded readiness', ['prepare-magento-swap'], 900000, 'job'),
    item('initialize-magento', 'initialize', initializeCommand(linuxContext), 'Install Magento, configure caches, create the real CMS marker, and start cron without exposing credentials', ['start-dependencies'], 3600000, 'job'),
    item('verify-magento', 'verify', verifyCommand(linuxContext), 'Verify Magento CLI state, indexers, cron, search, database, Unix socket, caches, and external marker', ['initialize-magento'], 900000, 'job')
  ]
  const revertCommands = [
    item('remove-compose-project', 'cleanup', removeProjectCommand(state), 'Remove only the task-owned Compose containers, volumes, and network', [], 900000, 'job', 'destructive'),
    item('remove-magento-swap', 'cleanup', removeSwapCommand(state), 'Disable and remove only the task-owned Magento swap file', ['remove-compose-project'], 300000, undefined, 'destructive'),
    item('remove-compose-images', 'cleanup', removeImagesCommand(state), 'Remove only images first pulled by this task and still matching the recorded digest', ['remove-magento-swap'], 900000, 'job', 'destructive'),
    item('remove-compose-files', 'cleanup', `set -eu; rm -rf -- ${quote(SERVICE_ROOT)} ${quote(CREDENTIALS)}`, 'Remove only task-owned configuration and protected credentials', ['remove-compose-images'], 300000, undefined, 'destructive'),
    item('restore-docker', 'cleanup', restoreDockerCommand(state), 'Restore the exact pre-task Docker package, repository, service, and storage ownership state', ['remove-compose-files'], 900000, 'job', 'destructive')
  ]

  return {
    plan: {
      summary: 'Deploy a learned reversible Magento Open Source Compose store',
      changeOverview: `Deploy Magento Open Source ${VERSION} on port ${PORT} with digest-pinned PHP-FPM, nginx, MariaDB, OpenSearch, and Valkey services.`,
      modifiedFiles: [
        state,
        SERVICE_ROOT,
        COMPOSE_FILE,
        `${SERVICE_ROOT}/php-fpm.conf`,
        `${SERVICE_ROOT}/nginx.conf`,
        `${SERVICE_ROOT}/installer-argv.php`,
        `${SERVICE_ROOT}/marker.php`,
        CREDENTIALS,
        SWAP_FILE,
        '/etc/apt/keyrings/docker.asc',
        '/etc/apt/sources.list.d/docker.sources',
        '/var/lib/docker',
        '/var/lib/containerd'
      ],
      assumptions: [
        `Authoritative Linux profile: ${identity.id} ${identity.versionId ?? ''}`.trim(),
        `Effective Docker policy: ${docker.ready ? 'ready' : `setup required through ${docker.installMethod}`}`,
        `Resolved matrix: Magento ${VERSION}, PHP 8.4, MariaDB 11.8, OpenSearch 3, Valkey 8.1, nginx 1.30.`
      ],
      warnings: [
        'The Magento application image is third-party and therefore pinned by immutable manifest digest; official service images are pinned the same way.',
        'This controlled test publishes only TCP port 18108 and may create a task-owned 1 GiB swap file that is removed by the saved revert.',
        'The controlled validation route uses Magento developer mode rather than resource-intensive production DI/static compilation.'
      ],
      requiresConfirmation: true,
      compatibilityManifest: compatibilityManifest(identity),
      commands,
      revertCommands
    },
    verifyApplied: verifyCommand(linuxContext),
    verifyReverted: `test ! -e ${quote(SERVICE_ROOT)} && test ! -e ${quote(CREDENTIALS)} && test ! -e ${quote(state)} && test ! -e ${quote(SWAP_FILE)} && { ! command -v docker >/dev/null 2>&1 || ! docker ps -aq --filter label=com.docker.compose.project=${quote(PROJECT)} | grep -q .; }`,
    stateProbe: `for path in ${quote(SERVICE_ROOT)} ${quote(CREDENTIALS)} ${quote(state)} ${quote(SWAP_FILE)}; do if [ -e "$path" ]; then printf 'present=%s\\n' "$path"; else printf 'absent=%s\\n' "$path"; fi; done; if command -v docker >/dev/null 2>&1; then docker ps -a --filter label=com.docker.compose.project=${quote(PROJECT)} --format 'compose-container={{.Names}} {{.State}}'; fi`
  }
}

export function magentoComposeRelease () {
  return Object.freeze({ version: VERSION, images: Object.freeze([...IMAGES]) })
}

export function magentoComposeAssets () {
  return composeCommand(true)
}

function baselineCommand (state) {
  return [
    'set -eu',
    `if [ ! -s ${quote(`${state}/packages.before`)} ]; then :`,
    `test ! -e ${quote(SERVICE_ROOT)}`,
    `test ! -e ${quote(CREDENTIALS)}`,
    `install -d -o root -g root -m 0700 ${quote(state)}`,
    `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(`${state}/packages.before`)}`,
    `if systemctl is-active --quiet docker 2>/dev/null; then : > ${quote(`${state}/docker-service.active`)}; fi`,
    `for path in /etc/apt/keyrings /etc/apt/keyrings/docker.asc /etc/apt/sources.list.d/docker.sources /etc/docker /var/lib/docker /var/lib/containerd; do key=$(printf '%s' "$path" | tr '/.' '__'); if [ -e "$path" ]; then : > ${quote(state)}/"$key.existed"; fi; done`,
    `if command -v docker >/dev/null 2>&1; then : > ${quote(`${state}/docker-cli.existed`)}; docker ps -aq --filter label=com.docker.compose.project=${quote(PROJECT)} | grep -q . && { printf '%s\\n' 'Compose project already exists' >&2; exit 1; } || true; fi`,
    ...IMAGES.map((image, index) => `if command -v docker >/dev/null 2>&1 && docker image inspect ${quote(image)} >/dev/null 2>&1; then : > ${quote(`${state}/image-${index}.existed`)}; fi`),
    'fi',
    "printf '%s\\n' baseline-ready"
  ].join('; ')
}

function prepareDockerCommand (state) {
  return [
    'set -eu',
    `state=${quote(state)}`,
    'if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then : > "$state/docker-ready.before"; else :',
    '[ ! -e "$state/docker-cli.existed" ] || { printf \'%s\\n\' \'Existing Docker installation is not ready; refusing to replace it\' >&2; exit 1; }',
    '. /etc/os-release',
    'case "$ID" in ubuntu|debian) vendor="$ID";; *) printf \'unsupported official Docker apt host: %s\\n\' "$ID" >&2; exit 1;; esac',
    'arch=$(dpkg --print-architecture)',
    'case "$arch" in amd64|arm64|armhf|s390x|ppc64el) :;; *) printf \'unsupported Docker architecture: %s\\n\' "$arch" >&2; exit 1;; esac',
    'set +u; codename="$UBUNTU_CODENAME"; [ -n "$codename" ] || codename="$VERSION_CODENAME"; set -u; [ -n "$codename" ]',
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update',
    'apt-get install -y ca-certificates curl',
    'install -d -o root -g root -m 0755 /etc/apt/keyrings',
    'curl --fail --location --silent --show-error "https://download.docker.com/linux/$vendor/gpg" --output /etc/apt/keyrings/docker.asc',
    'chmod 0644 /etc/apt/keyrings/docker.asc',
    'printf \'%s\\n\' \'Types: deb\' "URIs: https://download.docker.com/linux/$vendor" "Suites: $codename" \'Components: stable\' "Architectures: $arch" \'Signed-By: /etc/apt/keyrings/docker.asc\' > /etc/apt/sources.list.d/docker.sources',
    'chmod 0644 /etc/apt/sources.list.d/docker.sources',
    'apt-get update',
    'apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
    'systemctl start docker',
    'fi',
    'docker info >/dev/null',
    'docker compose version >/dev/null',
    `dpkg-query -W -f=${quote(DPKG_PACKAGE_FORMAT)} | LC_ALL=C sort -u > ${quote(`${state}/packages.after`)}`,
    `LC_ALL=C comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} | grep -Ev '^(curl|netdata|netdata-|openssh|openssh-|webminai|webminai-)' > ${quote(`${state}/packages.added`)} || true`,
    "printf '%s\\n' docker-ready"
  ].join('; ')
}

function credentialsCommand () {
  return `set -eu; umask 077; install -d -o root -g root -m 0700 ${quote(CREDENTIALS)}; [ -s ${quote(`${CREDENTIALS}/db_username`)} ] || { printf 'magento_%s\\n' "$(openssl rand -hex 8)" > ${quote(`${CREDENTIALS}/db_username`)}; }; [ -s ${quote(`${CREDENTIALS}/db_password`)} ] || openssl rand -hex 32 > ${quote(`${CREDENTIALS}/db_password`)}; [ -s ${quote(`${CREDENTIALS}/db_root_password`)} ] || openssl rand -hex 32 > ${quote(`${CREDENTIALS}/db_root_password`)}; [ -s ${quote(`${CREDENTIALS}/admin_username`)} ] || { printf 'admin_%s\\n' "$(openssl rand -hex 8)" > ${quote(`${CREDENTIALS}/admin_username`)}; }; [ -s ${quote(`${CREDENTIALS}/admin_password`)} ] || openssl rand -base64 36 | tr -dc 'A-Za-z0-9_!@#%+=' | head -c 32 > ${quote(`${CREDENTIALS}/admin_password`)}; chmod 0600 ${quote(`${CREDENTIALS}/db_username`)} ${quote(`${CREDENTIALS}/db_password`)} ${quote(`${CREDENTIALS}/db_root_password`)} ${quote(`${CREDENTIALS}/admin_username`)} ${quote(`${CREDENTIALS}/admin_password`)}; printf '%s\\n' ${quote(CREDENTIALS)}`
}

function composeCommand (returnAssets = false) {
  const compose = [
    'services:',
    '  db:',
    `    image: ${DATABASE_IMAGE}`,
    '    restart: unless-stopped',
    '    environment:',
    `      MARIADB_DATABASE: ${DATABASE}`,
    '      MARIADB_USER_FILE: /run/secrets/db_username',
    '      MARIADB_PASSWORD_FILE: /run/secrets/db_password',
    '      MARIADB_ROOT_PASSWORD_FILE: /run/secrets/db_root_password',
    '    command: ["--character-set-server=utf8mb4", "--collation-server=utf8mb4_unicode_ci", "--innodb-buffer-pool-size=128M", "--max-connections=50"]',
    '    secrets: [db_username, db_password, db_root_password]',
    '    volumes: [db_data:/var/lib/mysql]',
    '    healthcheck:',
    '      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]',
    '      interval: 5s',
    '      timeout: 5s',
    '      retries: 60',
    '  opensearch:',
    `    image: ${OPENSEARCH_IMAGE}`,
    '    restart: unless-stopped',
    '    environment:',
    '      discovery.type: single-node',
    '      DISABLE_SECURITY_PLUGIN: "true"',
    '      OPENSEARCH_JAVA_OPTS: -Xms256m -Xmx256m',
    '      cluster.routing.allocation.disk.threshold_enabled: "false"',
    '    volumes: [opensearch_data:/usr/share/opensearch/data]',
    '    healthcheck:',
    '      test: ["CMD-SHELL", "curl --fail --silent http://127.0.0.1:9200/_cluster/health >/dev/null"]',
    '      interval: 10s',
    '      timeout: 5s',
    '      retries: 90',
    '  valkey:',
    `    image: ${VALKEY_IMAGE}`,
    '    restart: unless-stopped',
    '    command: ["valkey-server", "--save", "", "--appendonly", "no", "--stop-writes-on-bgsave-error", "no", "--maxmemory", "64mb", "--maxmemory-policy", "allkeys-lru"]',
    '    volumes: [valkey_data:/data]',
    '    healthcheck:',
    '      test: ["CMD", "valkey-cli", "ping"]',
    '      interval: 5s',
    '      timeout: 3s',
    '      retries: 30',
    '  bootstrap:',
    `    image: ${MAGENTO_IMAGE}`,
    '    profiles: [tools]',
    '    cpuset: "0"',
    '    entrypoint: ["/bin/sh", "-c"]',
    '    command: ["test -f /target/bin/magento || cp -a /var/www/html/. /target/; chown -R www-data:www-data /target"]',
    '    volumes: [magento_code:/target]',
    '  magento:',
    `    image: ${MAGENTO_IMAGE}`,
    '    restart: unless-stopped',
    '    cpuset: "0"',
    '    depends_on:',
    '      db: { condition: service_healthy }',
    '      opensearch: { condition: service_healthy }',
    '      valkey: { condition: service_healthy }',
    '    command: ["/bin/sh", "-c", "install -d -o www-data -g www-data -m 0775 /run/php-fpm && rm -f /run/php-fpm/webminai.sock && exec docker-php-entrypoint php-fpm"]',
    '    secrets: [db_username, db_password, admin_username, admin_password]',
    '    volumes:',
    '      - magento_code:/var/www/html',
    '      - php_run:/run/php-fpm',
    '      - ./php-fpm.conf:/usr/local/etc/php-fpm.d/zz-webminai-socket.conf:ro',
    '      - ./installer-argv.php:/run/webminai/installer-argv.php:ro',
    '      - ./marker.php:/run/webminai/marker.php:ro',
    '  cron:',
    `    image: ${MAGENTO_IMAGE}`,
    '    restart: unless-stopped',
    '    user: www-data',
    '    depends_on: [magento]',
    '    entrypoint: ["/bin/sh", "-c"]',
    '    command: ["while [ ! -f /var/www/html/app/etc/env.php ]; do sleep 5; done; while :; do php /var/www/html/bin/magento cron:run --no-ansi --quiet >/dev/null 2>&1 && touch /var/www/html/var/.webminai-cron-ok; sleep 300; done"]',
    '    volumes: [magento_code:/var/www/html]',
    '  nginx:',
    `    image: ${NGINX_IMAGE}`,
    '    restart: unless-stopped',
    '    depends_on: [magento]',
    `    ports: ["${PORT}:80"]`,
    '    volumes:',
    '      - magento_code:/var/www/html:ro',
    '      - php_run:/run/php-fpm',
    '      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro',
    'secrets:',
    `  db_username: { file: ${CREDENTIALS}/db_username }`,
    `  db_password: { file: ${CREDENTIALS}/db_password }`,
    `  db_root_password: { file: ${CREDENTIALS}/db_root_password }`,
    `  admin_username: { file: ${CREDENTIALS}/admin_username }`,
    `  admin_password: { file: ${CREDENTIALS}/admin_password }`,
    'volumes:',
    '  db_data:',
    '  opensearch_data:',
    '  valkey_data:',
    '  magento_code:',
    '  php_run:'
  ]
  const fpm = ['[www]', 'listen = /run/php-fpm/webminai.sock', 'listen.owner = www-data', 'listen.group = www-data', 'listen.mode = 0666', 'pm.max_children = 2', 'pm.max_spare_servers = 2']
  const nginx = [
    'upstream fastcgi_backend { server unix:/run/php-fpm/webminai.sock; }',
    'server {',
    '    listen 80;',
    '    server_name _;',
    '    set $MAGE_ROOT /var/www/html;',
    '    set $MAGE_DEBUG_SHOW_ARGS 0;',
    '    include /var/www/html/nginx.conf.sample;',
    '}'
  ]
  if (returnAssets) {
    return {
      compose: [...compose],
      fpm: [...fpm],
      nginx: [...nginx],
      installer: installerArgvLines(),
      marker: markerLines()
    }
  }
  return [
    'set -eu',
    `install -d -o root -g root -m 0755 ${quote(SERVICE_ROOT)}`,
    writeCandidate(COMPOSE_FILE, compose, '0644'),
    writeCandidate(`${SERVICE_ROOT}/php-fpm.conf`, fpm, '0444'),
    writeCandidate(`${SERVICE_ROOT}/nginx.conf`, nginx, '0444'),
    writeCandidate(`${SERVICE_ROOT}/installer-argv.php`, installerArgvLines(), '0444'),
    writeCandidate(`${SERVICE_ROOT}/marker.php`, markerLines(), '0444'),
    `grep -Fq 'fastcgi_backend { server unix:/run/php-fpm/webminai.sock; }' ${quote(`${SERVICE_ROOT}/nginx.conf`)}`,
    `grep -Fq ${quote(`file: ${CREDENTIALS}/db_password`)} ${quote(COMPOSE_FILE)}`,
    `! grep -Eq '[0-9a-f]{32,}' ${quote(COMPOSE_FILE)}`,
    `cd ${quote(SERVICE_ROOT)} && docker compose -p ${quote(PROJECT)} --profile tools config --quiet`,
    "printf '%s\\n' compose-ready"
  ].join('; ')
}

function pullCommand (state) {
  return `set -eu; cd ${quote(SERVICE_ROOT)}; docker compose -p ${quote(PROJECT)} --profile tools pull; ${IMAGES.map((image, index) => `docker image inspect ${quote(image)} --format '{{.Id}}' > ${quote(`${state}/image-${index}.after`)}`).join('; ')}; printf '%s\\n' images-ready`
}

function prepareCodeCommand () {
  const prepare = 'if [ ! -f /target/var/.webminai-source-prepared ]; then test -f /target/bin/magento || cp -a /var/www/html/. /target/; rm -f /target/app/etc/env.php; rm -rf /target/generated/code/* /target/generated/metadata/* /target/var/cache/* /target/var/page_cache/* /target/var/di/*; cd /target; COMPOSER_ALLOW_SUPERUSER=1 composer dump-autoload --no-dev --no-interaction --no-ansi --quiet; install -d -o www-data -g www-data -m 0775 /target/var; touch /target/var/.webminai-source-prepared; chown -R www-data:www-data /target; fi; test -f /target/bin/magento; test -f /target/var/.webminai-source-prepared'
  return `set -eu; cd ${quote(SERVICE_ROOT)}; docker compose -p ${quote(PROJECT)} --profile tools run --rm --entrypoint /bin/sh bootstrap -c ${quote(prepare)} >/dev/null; printf '%s\\n' code-ready`
}

function prepareSwapCommand (state) {
  return `set -eu; if [ ! -e ${quote(`${state}/swap-created`)} ]; then test ! -e ${quote(SWAP_FILE)}; fallocate -l 1G ${quote(SWAP_FILE)}; chmod 0600 ${quote(SWAP_FILE)}; mkswap ${quote(SWAP_FILE)} >/dev/null; swapon ${quote(SWAP_FILE)}; : > ${quote(`${state}/swap-created`)}; fi; grep -Fq ${quote(SWAP_FILE)} /proc/swaps; printf '%s\n' swap-ready`
}

function startCommand () {
  const settings = '{"persistent":{"cluster.routing.allocation.disk.threshold_enabled":false,"cluster.blocks.create_index":false}}'
  return `set -eu; cd ${quote(SERVICE_ROOT)}; docker compose -p ${quote(PROJECT)} up -d db opensearch valkey magento nginx; ready=; for attempt in $(seq 1 180); do if docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq db && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq opensearch && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq valkey && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq magento && docker compose -p ${quote(PROJECT)} ps --status running --services | grep -Fxq nginx && docker compose -p ${quote(PROJECT)} exec -T magento test -S /run/php-fpm/webminai.sock && docker compose -p ${quote(PROJECT)} exec -T magento test -f /var/www/html/bin/magento; then ready=yes; break; fi; sleep 3; done; [ "$ready" = yes ] || { docker compose -p ${quote(PROJECT)} ps >&2; exit 1; }; docker compose -p ${quote(PROJECT)} exec -T opensearch curl --fail --silent --show-error -X PUT -H 'Content-Type: application/json' --data ${quote(settings)} http://127.0.0.1:9200/_cluster/settings >/dev/null; printf '%s\\n' dependencies-ready`
}

function initializeCommand (linuxContext) {
  const addressCommand = linuxContext?.applications?.wordpress?.primaryAddressCommand ?? "ip -4 -o route get 1.1.1.1 | awk '{for (i=1;i<=NF;i++) if ($i == \"src\") {print $(i+1); exit}}'"
  const install = [
    'WEBMINAI_DB_USERNAME_FILE=/run/webminai/db_username',
    'WEBMINAI_DB_PASSWORD_FILE=/run/webminai/db_password',
    'WEBMINAI_ADMIN_USERNAME_FILE=/run/webminai/admin_username',
    'WEBMINAI_ADMIN_PASSWORD_FILE=/run/webminai/admin_password',
    'php -d memory_limit=2G -d auto_prepend_file=/run/webminai/installer-argv.php bin/magento setup:install',
    '--no-interaction --no-ansi --quiet --cleanup-database',
    '--base-url="$WEBMINAI_MAGENTO_URL"',
    '--db-host=db',
    `--db-name=${DATABASE}`,
    '--backend-frontname=webminai_admin',
    '--admin-firstname=Intent AI Ops --admin-lastname=Administrator',
    '--admin-email=intentaiops@example.invalid',
    '--language=en_US --currency=USD --timezone=UTC --use-rewrites=1',
    '--search-engine=opensearch --opensearch-host=opensearch --opensearch-port=9200 --opensearch-enable-auth=0',
    '--session-save=redis --session-save-redis-host=valkey --session-save-redis-db=2',
    '--cache-backend=redis --cache-backend-redis-server=valkey --cache-backend-redis-db=0',
    '--page-cache=redis --page-cache-redis-server=valkey --page-cache-redis-db=1'
  ].join(' ')
  return [
    'set -eu',
    `cd ${quote(SERVICE_ROOT)}`,
    `address=$(${addressCommand})`,
    '[ -n "$address" ]',
    `if ! docker compose -p ${quote(PROJECT)} exec -T magento test -f /var/www/html/app/etc/env.php; then docker compose -p ${quote(PROJECT)} exec -T magento /bin/sh -c 'install -d -o www-data -g www-data -m 0700 /run/webminai; for name in db_username db_password admin_username admin_password; do install -o www-data -g www-data -m 0400 "/run/secrets/$name" "/run/webminai/$name"; done'; docker compose -p ${quote(PROJECT)} exec -T --user www-data -e WEBMINAI_MAGENTO_URL="http://$address:${PORT}/" magento /bin/sh -c ${quote(`${install} >/dev/null 2>&1`)}; docker compose -p ${quote(PROJECT)} exec -T magento rm -f -- /run/webminai/db_username /run/webminai/db_password /run/webminai/admin_username /run/webminai/admin_password; fi`,
    `docker compose -p ${quote(PROJECT)} exec -T --user www-data magento php bin/magento deploy:mode:set developer --skip-compilation --no-ansi >/dev/null 2>&1`,
    `docker compose -p ${quote(PROJECT)} exec -T --user www-data magento php -d memory_limit=2G /run/webminai/marker.php >/dev/null 2>&1`,
    `docker compose -p ${quote(PROJECT)} exec -T --user www-data magento /bin/sh -c ${quote('php bin/magento indexer:reindex --no-ansi --quiet >/dev/null 2>&1; touch var/.webminai-indexed')}`,
    `docker compose -p ${quote(PROJECT)} exec -T --user www-data magento php bin/magento cache:flush --no-ansi --quiet >/dev/null 2>&1`,
    `docker compose -p ${quote(PROJECT)} up -d cron`,
    `ready=; for attempt in $(seq 1 90); do if docker compose -p ${quote(PROJECT)} exec -T magento test -f /var/www/html/var/.webminai-cron-ok && curl --fail --location --silent --show-error --max-time 10 "http://$address:${PORT}/" 2>/dev/null | grep -F ${MARKER} >/dev/null; then ready=yes; break; fi; sleep 3; done`,
    '[ "$ready" = yes ]',
    "printf '%s\\n' magento-installed"
  ].join('; ')
}

function verifyCommand (linuxContext) {
  return `set -eu; cd ${quote(SERVICE_ROOT)}; running=$(docker compose -p ${quote(PROJECT)} ps --status running --services); printf '%s\\n' "$running" | grep -Fxq magento; printf '%s\\n' "$running" | grep -Fxq nginx; printf '%s\\n' "$running" | grep -Fxq cron; docker compose -p ${quote(PROJECT)} exec -T magento test -S /run/php-fpm/webminai.sock; docker compose -p ${quote(PROJECT)} exec -T magento test -f /var/www/html/app/etc/env.php; docker compose -p ${quote(PROJECT)} exec -T magento test -f /var/www/html/var/.webminai-indexed; docker compose -p ${quote(PROJECT)} exec -T magento test -f /var/www/html/var/.webminai-cron-ok; docker compose -p ${quote(PROJECT)} exec -T --user www-data magento php bin/magento --version | grep -Fq ${quote(VERSION)}; docker compose -p ${quote(PROJECT)} exec -T opensearch curl --fail --silent http://127.0.0.1:9200/_cluster/health >/dev/null; docker compose -p ${quote(PROJECT)} exec -T valkey valkey-cli ping | grep -Fq PONG; curl --fail --location --silent --show-error --max-time 30 http://127.0.0.1:${PORT}/ | grep -F ${MARKER} >/dev/null; printf '%s\\n' verification-passed`
}

function removeProjectCommand (state) {
  return `set +e; [ -d ${quote(state)} ] || exit 0; if command -v docker >/dev/null 2>&1 && [ -f ${quote(COMPOSE_FILE)} ]; then cd ${quote(SERVICE_ROOT)} && docker compose -p ${quote(PROJECT)} --profile tools down --volumes --remove-orphans >/dev/null 2>&1; fi; if command -v docker >/dev/null 2>&1 && docker ps -aq --filter label=com.docker.compose.project=${quote(PROJECT)} | grep -q .; then exit 1; fi; exit 0`
}

function removeSwapCommand (state) {
  return `set -eu; if [ -d ${quote(state)} ]; then if grep -Fq ${quote(SWAP_FILE)} /proc/swaps; then swapoff ${quote(SWAP_FILE)}; fi; rm -f -- ${quote(SWAP_FILE)}; fi; test ! -e ${quote(SWAP_FILE)}; printf '%s\n' swap-removed`
}

function removeImagesCommand (state) {
  return `set +e; [ -d ${quote(state)} ] || exit 0; ${IMAGES.map((image, index) => `if command -v docker >/dev/null 2>&1 && [ ! -e ${quote(`${state}/image-${index}.existed`)} ]; then after=$(sed -n 1p ${quote(`${state}/image-${index}.after`)} 2>/dev/null); current=$(docker image inspect ${quote(image)} --format '{{.Id}}' 2>/dev/null); if [ -n "$after" ] && [ "$current" = "$after" ]; then docker image rm ${quote(image)} >/dev/null 2>&1 || true; fi; fi`).join('; ')}; exit 0`
}

function restoreDockerCommand (state) {
  return [
    'set -eu',
    `state=${quote(state)}`,
    '[ -d "$state" ] || exit 0',
    'if [ ! -e "$state/docker-ready.before" ]; then :',
    'systemctl stop docker.service docker.socket containerd.service >/dev/null 2>&1 || true',
    'if [ -s "$state/packages.added" ]; then export DEBIAN_FRONTEND=noninteractive; xargs -r apt-get purge -y < "$state/packages.added"; fi',
    'if [ ! -e "$state/__etc_apt_sources_list_d_docker_sources.existed" ]; then rm -f -- /etc/apt/sources.list.d/docker.sources; fi',
    'if [ ! -e "$state/__etc_apt_keyrings_docker_asc.existed" ]; then rm -f -- /etc/apt/keyrings/docker.asc; fi',
    'if [ ! -e "$state/__etc_docker.existed" ]; then rm -rf -- /etc/docker; fi',
    'if [ ! -e "$state/__var_lib_docker.existed" ]; then rm -rf -- /var/lib/docker; fi',
    'if [ ! -e "$state/__var_lib_containerd.existed" ]; then rm -rf -- /var/lib/containerd; fi',
    'if [ ! -e "$state/__etc_apt_keyrings.existed" ]; then rmdir /etc/apt/keyrings 2>/dev/null || true; fi',
    'else if [ -e "$state/docker-service.active" ]; then systemctl start docker; else systemctl stop docker >/dev/null 2>&1 || true; fi; fi',
    'rm -rf -- "$state"',
    "printf '%s\\n' docker-restored"
  ].join('; ')
}

function installerArgvLines () {
  return [
    '<?php',
    "$files = ['db-user' => getenv('WEBMINAI_DB_USERNAME_FILE'), 'db-password' => getenv('WEBMINAI_DB_PASSWORD_FILE'), 'admin-user' => getenv('WEBMINAI_ADMIN_USERNAME_FILE'), 'admin-password' => getenv('WEBMINAI_ADMIN_PASSWORD_FILE')];",
    'foreach ($files as $option => $path) {',
    '    if (!$path || !is_file($path)) { fwrite(STDERR, \'missing protected credential file\' . PHP_EOL); exit(1); }',
    '    $value = trim((string) file_get_contents($path));',
    '    if ($value === \'\') { fwrite(STDERR, \'empty protected credential file\' . PHP_EOL); exit(1); }',
    "    $argv[] = '--' . $option . '=' . $value;",
    '}',
    '$argc = count($argv);',
    "$_SERVER['argv'] = $argv; $_SERVER['argc'] = $argc; $GLOBALS['argv'] = $argv; $GLOBALS['argc'] = $argc;"
  ]
}

function markerLines () {
  return [
    '<?php',
    'use Magento\\Framework\\App\\Bootstrap;',
    "require '/var/www/html/app/bootstrap.php';",
    '$bootstrap = Bootstrap::create(BP, $_SERVER);',
    '$objectManager = $bootstrap->getObjectManager();',
    "$objectManager->get(Magento\\Framework\\App\\State::class)->setAreaCode('adminhtml');",
    "$page = $objectManager->create(Magento\\Cms\\Model\\Page::class)->getCollection()->addFieldToFilter('identifier', 'home')->getFirstItem();",
    'if (!$page->getId()) { throw new RuntimeException(\'home page missing\'); }',
    `$page->setTitle('${MARKER}')->setContent('<main><h1>${MARKER}</h1></main>')->setIsActive(true)->save();`,
    `file_put_contents('/var/www/html/var/.webminai-marker-ok', '${MARKER}\\n');`
  ]
}

function writeCandidate (path, lines, mode) {
  return `candidate=$(mktemp); printf '%s\\n' ${lines.map(quote).join(' ')} > "$candidate"; if ! cmp -s "$candidate" ${quote(path)}; then install -o root -g root -m ${mode} "$candidate" ${quote(path)}; fi; rm -f -- "$candidate"`
}

function compatibilityManifest (identity) {
  return {
    format: 'webminai-compatibility-manifest',
    version: 1,
    generatedAt: new Date().toISOString(),
    application: { id: 'magento', version: VERSION },
    host: { id: identity.id ?? null, versionId: identity.versionId ?? null },
    selectedRoute: {
      id: 'magento-compose',
      kind: 'compose',
      status: 'resolved',
      reason: 'Docker is preferred and the resolved Magento 2.4.8-p5 service matrix is available as digest-pinned images.',
      components: [
        { profileId: 'magento', selectedVersion: VERSION, source: MAGENTO_IMAGE, status: 'supported' },
        { profileId: 'php-fpm', selectedVersion: '8.4.23', source: MAGENTO_IMAGE, status: 'supported' },
        { profileId: 'nginx', selectedVersion: '1.30.4', source: NGINX_IMAGE, status: 'supported' },
        { profileId: 'mariadb', selectedVersion: '11.8.8', source: DATABASE_IMAGE, status: 'supported' },
        { profileId: 'opensearch', selectedVersion: '3.7.0', source: OPENSEARCH_IMAGE, status: 'supported' },
        { profileId: 'valkey', selectedVersion: '8.1.3', source: VALKEY_IMAGE, status: 'supported' }
      ]
    }
  }
}

function item (id, phase, command, purpose, dependsOn = [], timeoutMs = 300000, executionMode, risk = phase === 'verify' ? 'read' : 'change') {
  return { id, command, purpose, risk, timeoutMs, requiresSudo: true, phase, diagnostic: null, dependsOn, ...(executionMode ? { executionMode } : {}) }
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
