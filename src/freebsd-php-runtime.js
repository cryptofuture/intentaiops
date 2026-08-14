export const FREEBSD_PHP_IMAGE = 'localhost/webminai-freebsd-php84-nginx:15.1'

export function buildFreebsdPhpRuntimeCommand (buildRoot) {
  return `set -eu; root=${quote(`${buildRoot}/php-runtime`)}; rm -rf -- "$root"; install -d -m 0755 "$root/rootfs/usr/local/sbin" "$root/rootfs/usr/local/etc/nginx"; cat > "$root/rootfs/usr/local/etc/php-fpm.conf" <<'CONF'
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
http { include /usr/local/etc/nginx/mime.types; client_max_body_size 64m; server { listen 80; root /srv/app; index index.php index.html; location / { try_files $uri $uri/ /index.php?$args; } location ~ \\.php$ { try_files $uri =404; include fastcgi_params; fastcgi_pass unix:/var/run/webminai/php-fpm.sock; fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name; } location ~ /\\. { deny all; } } }
CONF
cat > "$root/rootfs/usr/local/sbin/webminai-entrypoint" <<'SH'
#!/bin/sh
set -eu
install -d -m 0755 /srv/app /var/run/webminai
/usr/local/sbin/php-fpm -D -R
exec /usr/local/sbin/nginx -g 'daemon off;'
SH
chmod 0755 "$root/rootfs/usr/local/sbin/webminai-entrypoint"; cat > "$root/Containerfile" <<'CF'
FROM ghcr.io/freebsd/freebsd-notoolchain:15.1
RUN env ASSUME_ALWAYS_YES=yes IGNORE_OS_VERSION=yes pkg bootstrap -r FreeBSD && pkg install -y nginx php84 php84-bcmath php84-ctype php84-curl php84-dom php84-fileinfo php84-filter php84-gd php84-gmp php84-iconv php84-intl php84-mbstring php84-mysqli php84-opcache php84-pcntl php84-pdo php84-pdo_mysql php84-posix php84-session php84-simplexml php84-soap php84-sodium php84-tokenizer php84-xml php84-xmlreader php84-xmlwriter php84-zip php84-zlib ca_root_nss && pkg clean -y
COPY rootfs /
EXPOSE 80
ENTRYPOINT ["/usr/local/sbin/webminai-entrypoint"]
CF
cd "$root"; TMPDIR=/var/db/containers/tmp podman build -t ${FREEBSD_PHP_IMAGE} .`
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
