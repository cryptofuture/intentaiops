export const GHOST_MYSQL_IMAGE = 'mysql@sha256:0f51e63e537a1f176423fa03ef559aabe6fa4372a53160a44bc7e75da7d15364'
export const GHOST_MYSQL_COMPAT_BASE = 'debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8'
export const GHOST_MYSQL_BUILDKIT = 'moby/buildkit@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea'
export const GHOST_MYSQL_COMPAT_VERSION = '8.4.13'
const SOURCE = 'https://raw.githubusercontent.com/docker-library/mysql/01f90d87012e46cd174073bba02d64e9fc693ed3'
const PACKAGES = [
  ['mysql-common', '7b97799896569f1cbc722067e834258a26103c38b141f3df94702e5f1fa50933'],
  ['mysql-community-client-plugins', '92a88e633b7eb36c4e3df86426f03e83f7c7ac4f1cd37bd18e59868934d14b7d'],
  ['mysql-community-client-core', '3fe5add0eb1e5ff13b81655cf3df36a35acff160cda807d570e1e82666b0ae76'],
  ['mysql-community-client', '3dec5e454623ae5f2d1dc41690977adf3fb5b0d98923b003bc1ffff70ff20206'],
  ['mysql-community-server-core', 'e655d929c48438d9c6a6f9e1a7c0641f1a35efde7fffe59573f157e9cbc606e0']
]

export function ghostMysqlCompatibilityImage (taskId) {
  if (!Number.isSafeInteger(taskId) || taskId < 1) throw new TypeError('positive task id required')
  return `intentaiops/ghost-mysql:${GHOST_MYSQL_COMPAT_VERSION}-bookworm-task-${taskId}`
}

export function ghostMysqlCompatibilityDockerfile () {
  const downloads = PACKAGES.map(([name, hash]) => {
    const file = `${name}_${GHOST_MYSQL_COMPAT_VERSION}-1debian12_amd64.deb`
    return `curl --fail --location --silent --show-error --connect-timeout 15 --max-time 300 https://repo.mysql.com/apt/debian/pool/mysql-8.4-lts/m/mysql-community/${file} --output /tmp/${file}; printf '%s  %s\\n' ${hash} /tmp/${file} | sha256sum -c -`
  }).join('; ')
  return [
    `FROM ${GHOST_MYSQL_COMPAT_BASE}`,
    `LABEL org.opencontainers.image.source="${SOURCE}" org.opencontainers.image.version="${GHOST_MYSQL_COMPAT_VERSION}"`,
    'RUN set -eux; test "$(dpkg --print-architecture)" = amd64; groupadd --system --gid 999 mysql; useradd --system --uid 999 --gid 999 --home-dir /var/lib/mysql --no-create-home mysql; apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl gosu bzip2 gzip openssl xz-utils zstd findutils tzdata; rm -rf /var/lib/apt/lists/*',
    `RUN set -eux; ${downloads}; apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends /tmp/*_amd64.deb; rm -f /tmp/*_amd64.deb; rm -rf /var/lib/apt/lists/*; mysqld --version | grep -F 'Ver ${GHOST_MYSQL_COMPAT_VERSION}'; mysql --version | grep -F 'Ver ${GHOST_MYSQL_COMPAT_VERSION}'; mysqladmin --version | grep -F '${GHOST_MYSQL_COMPAT_VERSION}'`,
    `RUN set -eux; curl --fail --location --silent --show-error --max-time 120 ${SOURCE}/docker-entrypoint.sh --output /usr/local/bin/docker-entrypoint.sh; printf '%s  %s\\n' 30f0e863cd9de49752045c01b2e4a4e3e065da48889d464a65ceeb4d69be4e5a /usr/local/bin/docker-entrypoint.sh | sha256sum -c -; chmod 0755 /usr/local/bin/docker-entrypoint.sh; mkdir -p /usr/share/doc/intentaiops-mysql-compat; curl --fail --location --silent --show-error --max-time 120 ${SOURCE}/LICENSE --output /usr/share/doc/intentaiops-mysql-compat/COPYING; printf '%s  %s\\n' 8177f97513213526df2cf6184d8ff986c675afb514d4e68a404010521b880643 /usr/share/doc/intentaiops-mysql-compat/COPYING | sha256sum -c -`,
    'RUN set -eux; mkdir -p /etc/mysql/conf.d /docker-entrypoint-initdb.d; install -d -o mysql -g mysql -m 0750 /var/lib/mysql /var/lib/mysql-files /var/run/mysqld; rm -f /etc/mysql/my.cnf; printf "[client]\\nsocket=/var/run/mysqld/mysqld.sock\\n[mysqld]\\ndatadir=/var/lib/mysql\\nsocket=/var/run/mysqld/mysqld.sock\\npid-file=/var/run/mysqld/mysqld.pid\\nsecure-file-priv=/var/lib/mysql-files\\n!includedir /etc/mysql/conf.d/\\n" > /etc/mysql/my.cnf',
    `ENV MYSQL_MAJOR=8.4 MYSQL_VERSION=${GHOST_MYSQL_COMPAT_VERSION}`,
    'VOLUME /var/lib/mysql',
    'EXPOSE 3306',
    'ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]',
    'CMD ["mysqld"]'
  ].join('\n')
}
