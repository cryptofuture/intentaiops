const WORDPRESS_IMAGE = 'localhost/webminai-freebsd-wordpress:7.0.2-php84'
const DATABASE_IMAGE = 'localhost/webminai-freebsd-mariadb:11.8'
const WORDPRESS = Object.freeze({
  id: 'wordpress',
  label: 'WordPress',
  serviceRoot: '/var/db/webminai/apps/wordpress',
  buildRoot: '/var/db/webminai/image-builds/wordpress',
  credentials: '/root/wordpress_credentials',
  project: 'webminai-wordpress-18101',
  port: 18101,
  subnet: '10.89.101',
  database: 'webminai_wordpress',
  marker: 'WEBMINAI_WORDPRESS_FREEBSD_OK'
})

export function buildFreebsdWordpressTask (taskId, freebsdExecution) {
  return buildFreebsdWordpressApplication(taskId, freebsdExecution, WORDPRESS)
}

export function buildFreebsdWordpressApplication (taskId, freebsdExecution, application, extensions = {}) {
  if (freebsdExecution?.platform !== 'freebsd') throw new Error('FreeBSD WordPress requires a FreeBSD execution inventory')
  if (!freebsdExecution.docker?.ready && !freebsdExecution.docker?.daemonReachable) {
    throw new Error('FreeBSD WordPress requires the reviewed Podman Suite and podman-compose substrate')
  }
  validateApplication(application)
  const state = `/var/lib/webminai/task-state/${taskId}-${application.id}-freebsd`
  const deployId = extensions.deployId ?? 'deploy-wordpress'
  const verifyId = extensions.verifyId ?? 'verify-wordpress'
  const commands = [
    item('capture-and-prepare', prepare(state, application), 'Capture ownership and prepare protected credentials and build directories'),
    item('build-mariadb-image', buildFreebsdMariaDbImageCommand(application.buildRoot), 'Build the minimal native FreeBSD MariaDB 11.8 image', ['capture-and-prepare'], 1200000, 'job'),
    item('build-wordpress-image', buildWordPress(application), 'Download verified WordPress 7.0.2 and build the minimal native FreeBSD PHP 8.4/nginx image', ['capture-and-prepare'], 1200000, 'job'),
    item(deployId, deploy(application), `Deploy and initialize the structured WordPress phase for ${application.label} without exposing generated credentials`, ['build-mariadb-image', 'build-wordpress-image'], 600000, 'job')
  ]
  if (extensions.afterDeploy) commands.push(...extensions.afterDeploy({ state, application, deployId }))
  const verifyDependencies = extensions.verifyDependsOn ?? [commands.at(-1).id]
  commands.push(item(verifyId, extensions.verifyCommand?.({ state, application }) ?? verify(application), `Verify ${application.label} HTTP output and restart recovery through the published host port`, verifyDependencies, 600000, 'job'))
  return {
    plan: {
      summary: `Deploy a learned reversible native FreeBSD ${application.label} site`,
      changeOverview: `Build minimal native FreeBSD MariaDB and PHP/nginx OCI images, then deploy ${application.label} with host-generated credentials and a static Podman network.`,
      modifiedFiles: [state, application.buildRoot, application.serviceRoot, application.credentials, ...(extensions.modifiedFiles ?? [])],
      assumptions: ['FreeBSD 15.1 amd64 with Podman Suite, podman-compose, PF and fdescfs configured by Stage 2 inventory'],
      warnings: ['FreeBSD Podman uses jails and VFS storage. The reviewed images run service processes as container root because non-root processes cannot reliably traverse image layers on this substrate. Only the WordPress HTTP port is published.', 'The native MariaDB and PHP/nginx images are shared FreeBSD runtime assets and remain available after application rollback.'],
      commands,
      revertCommands: [
        item(`remove-${application.id}-stack`, removeStack(state, application), 'Remove only the task-owned containers, network, files, and credentials while retaining shared native runtime images', [], 900000, 'job', 'destructive')
      ]
    },
    verifyApplied: extensions.verifyApplied ?? stableHttpVerification(application),
    verifyReverted: `test ! -e ${quote(application.serviceRoot)} && test ! -e ${quote(state)}`,
    stateProbe: `test -e ${quote(state)} && printf applied || printf absent`
  }
}

function prepare (state, application) {
  return `set -eu; test "$(uname -s)" = FreeBSD; test "$(freebsd-version -u | sed -E 's/^([0-9]+).*/\\1/')" -ge 15; command -v podman >/dev/null; command -v podman-compose >/dev/null; podman info >/dev/null; install -d -m 0700 ${quote(state)} ${quote(application.buildRoot)} ${quote(application.serviceRoot)}; if [ -e ${quote(application.credentials)} ]; then : > ${quote(`${state}/credentials-preexisting`)}; else install -d -m 0700 ${quote(application.credentials)}; fi; for name in db_root_password db_password admin_password; do if [ ! -s ${quote(application.credentials)}/$name ]; then umask 077; openssl rand -base64 30 | tr -d '\\n' > ${quote(application.credentials)}/$name; fi; done; chmod 0600 ${quote(application.credentials)}/*`
}

/** @param {string} [buildRoot] */
export function buildFreebsdMariaDbImageCommand (buildRoot = WORDPRESS.buildRoot) {
  return `set -eu; root=${quote(`${buildRoot}/mariadb`)}; rm -rf -- "$root"; install -d -m 0755 "$root/rootfs/usr/local/sbin"; cat > "$root/rootfs/usr/local/sbin/webminai-entrypoint" <<'SH'
#!/bin/sh
set -eu
datadir=/var/db/mysql
socket=/var/run/mysql/mysql.sock
db_name=\${WEBMINAI_DB_NAME:-webminai_wordpress}
db_user=\${WEBMINAI_DB_USER:-webminai_wordpress}
case "$db_name:$db_user" in *[!A-Za-z0-9_:]*) echo 'invalid database identity' >&2; exit 1;; esac
install -d -m 0700 "$datadir" /var/run/mysql
root_password=$(cat /run/secrets/db_root_password)
db_password=$(cat /run/secrets/db_password)
fresh=
if [ ! -d "$datadir/mysql" ]; then
  mariadb-install-db --no-defaults --user=root --datadir="$datadir" --skip-test-db >/dev/null
  fresh=yes
fi
/usr/local/libexec/mariadbd --no-defaults --user=root --datadir="$datadir" --socket="$socket" --skip-networking --pid-file=/var/run/mysql/bootstrap.pid &
pid=$!
ready=; for attempt in $(jot 60); do if [ "$fresh" = yes ]; then mariadb-admin --socket="$socket" -uroot ping >/dev/null 2>&1; else mariadb-admin --socket="$socket" -uroot --password="$root_password" ping >/dev/null 2>&1; fi && { ready=yes; break; }; sleep 1; done; [ "$ready" = yes ]
if [ "$fresh" = yes ]; then
  mariadb --socket="$socket" -uroot <<SQL >/dev/null
ALTER USER 'root'@'localhost' IDENTIFIED BY '$root_password';
SQL
fi
mariadb --socket="$socket" -uroot --password="$root_password" <<SQL >/dev/null
CREATE DATABASE IF NOT EXISTS $db_name CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$db_user'@'%' IDENTIFIED BY '$db_password';
ALTER USER '$db_user'@'%' IDENTIFIED BY '$db_password';
GRANT ALL PRIVILEGES ON $db_name.* TO '$db_user'@'%';
FLUSH PRIVILEGES;
SQL
mariadb-admin --socket="$socket" -uroot --password="$root_password" shutdown >/dev/null; wait "$pid"
exec /usr/local/libexec/mariadbd --no-defaults --user=root --datadir="$datadir" --socket="$socket" --bind-address=0.0.0.0 --pid-file=/var/run/mysql/mariadb.pid
SH
chmod 0755 "$root/rootfs/usr/local/sbin/webminai-entrypoint"; cat > "$root/Containerfile" <<'CF'
FROM ghcr.io/freebsd/freebsd-notoolchain:15.1
RUN env ASSUME_ALWAYS_YES=yes IGNORE_OS_VERSION=yes pkg bootstrap -r FreeBSD && pkg install -y mariadb118-server mariadb118-client && pkg clean -y
COPY rootfs /
EXPOSE 3306
ENTRYPOINT ["/usr/local/sbin/webminai-entrypoint"]
CF
cd "$root"; TMPDIR=/var/db/containers/tmp podman build -t ${DATABASE_IMAGE} .`
}

function buildWordPress (application) {
  return `set -eu; root=${quote(`${application.buildRoot}/app`)}; rm -rf -- "$root"; install -d -m 0755 "$root/rootfs/usr/local/sbin" "$root/rootfs/usr/local/etc/nginx" "$root/rootfs/opt"; fetch -qo "$root/wordpress.tgz" https://wordpress.org/wordpress-7.0.2.tar.gz; fetch -qo "$root/wordpress.sha1" https://wordpress.org/wordpress-7.0.2.tar.gz.sha1; expected=$(tr -d '[:space:]' < "$root/wordpress.sha1"); case "$expected" in ???????*) ;; *) exit 1;; esac; [ "$(sha1 -q "$root/wordpress.tgz")" = "$expected" ]; tar -xzf "$root/wordpress.tgz" -C "$root/rootfs/opt"; cat > "$root/rootfs/usr/local/etc/php-fpm.conf" <<'CONF'
[global]
daemonize = yes
[www]
user = root
group = wheel
listen = /var/run/webminai/php-fpm.sock
listen.owner = root
listen.group = wheel
listen.mode = 0660
pm = dynamic
pm.max_children = 8
pm.start_servers = 2
pm.min_spare_servers = 1
pm.max_spare_servers = 3
clear_env = no
CONF
cat > "$root/rootfs/usr/local/etc/nginx/nginx.conf" <<'CONF'
user root wheel;
worker_processes 1;
events { worker_connections 256; }
http { include /usr/local/etc/nginx/mime.types; server { listen 80; root /srv/wordpress; index index.php index.html; location / { try_files $uri $uri/ /index.php?$args; } location ~ \\.php$ { include fastcgi_params; fastcgi_pass unix:/var/run/webminai/php-fpm.sock; fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name; } location ~ /\\. { deny all; } } }
CONF
cat > "$root/rootfs/usr/local/sbin/webminai-entrypoint" <<'SH'
#!/bin/sh
set -eu
install -d -m 0755 /srv/wordpress /var/run/webminai
if [ ! -f /srv/wordpress/wp-settings.php ]; then cp -a /opt/wordpress/. /srv/wordpress/; fi
chown -R root:wheel /srv/wordpress
/usr/local/sbin/php-fpm -D -R
exec /usr/local/sbin/nginx -g 'daemon off;'
SH
chmod 0755 "$root/rootfs/usr/local/sbin/webminai-entrypoint"; find "$root/rootfs/opt/wordpress" -type d -exec chmod 0755 {} +; find "$root/rootfs/opt/wordpress" -type f -exec chmod 0644 {} +; cat > "$root/Containerfile" <<'CF'
FROM ghcr.io/freebsd/freebsd-notoolchain:15.1
RUN env ASSUME_ALWAYS_YES=yes IGNORE_OS_VERSION=yes pkg bootstrap -r FreeBSD && pkg install -y nginx php84 php84-curl php84-filter php84-gd php84-intl php84-mbstring php84-mysqli php84-opcache php84-session php84-xml php84-zip ca_root_nss && pkg clean -y
COPY rootfs /
EXPOSE 80
ENTRYPOINT ["/usr/local/sbin/webminai-entrypoint"]
CF
cd "$root"; TMPDIR=/var/db/containers/tmp podman build -t ${WORDPRESS_IMAGE} .`
}

function deploy (application) {
  return `set -eu; root=${quote(application.serviceRoot)}; install -d -m 0755 "$root/db" "$root/www"; podman network exists ${application.project} || podman network create --subnet ${application.subnet}.0/24 --gateway ${application.subnet}.1 ${application.project} >/dev/null; cat > "$root/compose.yml" <<'YAML'
services:
  db:
    image: ${DATABASE_IMAGE}
    restart: always
    environment: { WEBMINAI_DB_NAME: ${application.database}, WEBMINAI_DB_USER: ${application.database} }
    networks: { default: { ipv4_address: ${application.subnet}.2 } }
    volumes: [ '${application.serviceRoot}/db:/var/db/mysql', '${application.credentials}:/run/secrets:ro' ]
  wordpress:
    image: ${WORDPRESS_IMAGE}
    restart: always
    depends_on: [ db ]
    networks: { default: { ipv4_address: ${application.subnet}.3 } }
    ports: [ '${application.port}:80' ]
    volumes: [ '${application.serviceRoot}/www:/srv/wordpress', '${application.credentials}:/run/secrets:ro' ]
networks:
  default: { external: true, name: ${application.project} }
YAML
chmod 0600 "$root/compose.yml"; cd "$root"; podman-compose -p ${application.project} -f compose.yml up -d; ready=; for attempt in $(jot 90); do [ -f "$root/www/wp-settings.php" ] && break; sleep 2; done; [ -f "$root/www/wp-settings.php" ]; if [ ! -f "$root/www/wp-config.php" ] || grep -Fq database_name_here "$root/www/wp-config.php"; then cp "$root/www/wp-config-sample.php" "$root/www/wp-config.php"; podman exec ${application.project}_wordpress_1 php -r '$path="/srv/wordpress/wp-config.php"; $value=file_get_contents($path); $value=str_replace(["database_name_here","username_here","password_here","localhost"], ["${application.database}","${application.database}",trim(file_get_contents("/run/secrets/db_password")),"${application.subnet}.2"], $value); if (file_put_contents($path, $value) === false) { exit(1); }'; chmod 0600 "$root/www/wp-config.php"; fi; cat > "$root/www/webminai-install.php" <<'PHP'
<?php
define('WP_INSTALLING', true);
require __DIR__ . '/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
if (!is_blog_installed()) { wp_install('${application.marker}', 'webminai', 'intentaiops@example.invalid', true, '', trim(file_get_contents('/run/secrets/admin_password'))); }
$url = 'http://' . $_SERVER['HTTP_HOST']; update_option('home', $url); update_option('siteurl', $url); update_option('blogname', '${application.marker}'); echo '${application.marker}';
PHP
chmod 0644 "$root/www/webminai-install.php"; ${primaryAddress()}; ready=; for attempt in $(jot 90); do response=$(curl --header "Host: $address:${application.port}" --fail --silent --show-error --max-time 5 http://${application.subnet}.3/webminai-install.php 2>/dev/null || true); [ "$response" = ${application.marker} ] && { ready=yes; break; }; sleep 2; done; rm -f "$root/www/webminai-install.php"; [ "$ready" = yes ]`
}

function verify (application) {
  return `set -eu; ${primaryAddress()}; response=$(mktemp); trap 'rm -f -- "$response"' EXIT; verify_http() { curl --header "Host: $address:${application.port}" --fail --location --silent --show-error --max-time 20 --output "$response" http://${application.subnet}.3/; grep -Fq ${application.marker} "$response"; curl --header "Host: $address:${application.port}" --fail --silent --show-error --max-time 20 --output "$response" http://${application.subnet}.3/wp-includes/blocks/page-list/style.min.css; grep -Fq '.wp-block-navigation' "$response"; }; verify_http; podman restart ${application.project}_db_1 ${application.project}_wordpress_1 >/dev/null; ready=; for attempt in $(jot 60); do verify_http 2>/dev/null && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]`
}

function primaryAddress () {
  return 'interface=$(route -n get default | awk \'/interface:/{print $2; exit}\'); address=$(ifconfig "$interface" inet | awk \'/inet /{print $2; exit}\'); [ -n "$address" ]'
}

function stableHttpVerification (application) {
  return `set -eu; ${primaryAddress()}; response=$(mktemp); trap 'rm -f -- "$response"' EXIT; ready=; for attempt in $(jot 60); do curl --header "Host: $address:${application.port}" --fail --location --silent --show-error --max-time 10 --output "$response" http://${application.subnet}.3/ 2>/dev/null && grep -Fq ${application.marker} "$response" && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]`
}

function removeStack (state, application) {
  return `set -eu; if [ -f ${quote(`${application.serviceRoot}/compose.yml`)} ]; then cd ${quote(application.serviceRoot)}; podman-compose -p ${application.project} -f compose.yml down >/dev/null 2>&1 || true; fi; podman network rm ${application.project} >/dev/null 2>&1 || true; rm -rf -- ${quote(application.serviceRoot)} ${quote(application.buildRoot)}; if [ -d ${quote(state)} ] && [ ! -e ${quote(`${state}/credentials-preexisting`)} ]; then rm -rf -- ${quote(application.credentials)}; fi; rm -rf -- ${quote(state)}`
}

function validateApplication (application) {
  for (const key of ['id', 'label', 'serviceRoot', 'buildRoot', 'credentials', 'project', 'subnet', 'database', 'marker']) if (!application?.[key]) throw new TypeError(`FreeBSD WordPress foundation application is missing ${key}`)
  if (!Number.isInteger(application.port) || application.port < 1 || application.port > 65535) throw new TypeError('FreeBSD WordPress foundation application has invalid port')
}

function item (id, command, purpose, dependsOn = [], timeoutMs = 300000, executionMode = null, risk = 'change') {
  return { id, command, purpose, risk, timeoutMs, requiresSudo: true, dependsOn, ...(executionMode ? { executionMode } : {}) }
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
