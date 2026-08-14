import { buildLinuxStackProfiles } from './linux-stack-profiles.js'

const FORMAT = 'webminai-linux-host-context'
const VERSION = 3
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const UNAVAILABLE_TTL_MS = 15 * 60 * 1000
const SOURCE_TIMEOUT_MS = 3000
const SOURCE_BODY_LIMIT = 64 * 1024

const DISTROS = {
  ubuntu: {
    family: 'debian',
    packageManager: 'apt',
    serviceManager: 'systemd',
    documentationUrl: 'https://documentation.ubuntu.com/server/',
    packageSearchUrl: 'https://packages.ubuntu.com/',
    releaseUrl: identity => `https://releases.ubuntu.com/${encodeURIComponent(identity.versionId)}/`,
    packageCandidates: debianPackages()
  },
  debian: {
    family: 'debian',
    packageManager: 'apt',
    serviceManager: 'systemd',
    documentationUrl: 'https://www.debian.org/doc/',
    packageSearchUrl: 'https://packages.debian.org/',
    releaseUrl: identity => `https://www.debian.org/releases/${encodeURIComponent(identity.codename || 'stable')}/`,
    packageCandidates: debianPackages()
  },
  alpine: {
    family: 'alpine',
    packageManager: 'apk',
    serviceManager: 'openrc',
    documentationUrl: 'https://wiki.alpinelinux.org/wiki/Main_Page',
    packageSearchUrl: 'https://pkgs.alpinelinux.org/packages',
    releaseUrl: () => 'https://www.alpinelinux.org/releases/',
    packageCandidates: ['ca-certificates', 'tar', 'gzip', 'openssl', 'nginx', 'apache2', 'php83', 'php83-fpm', 'php83-mysqli', 'mariadb', 'mariadb-client', 'postgresql', 'nodejs', 'npm', 'redis', 'docker-cli-compose']
  },
  arch: {
    family: 'arch',
    packageManager: 'pacman',
    serviceManager: 'systemd',
    documentationUrl: 'https://wiki.archlinux.org/title/Main_page',
    packageSearchUrl: 'https://archlinux.org/packages/',
    releaseUrl: () => 'https://archlinux.org/releng/releases/',
    packageCandidates: ['ca-certificates', 'tar', 'gzip', 'openssl', 'nginx', 'apache', 'php', 'php-fpm', 'mariadb', 'postgresql', 'nodejs', 'npm', 'redis', 'docker-compose']
  },
  fedora: rpmDistro({
    documentationUrl: 'https://docs.fedoraproject.org/en-US/fedora/latest/system-administrators-guide/',
    packageSearchUrl: 'https://packages.fedoraproject.org/',
    releaseUrl: () => 'https://docs.fedoraproject.org/en-US/releases/'
  }),
  almalinux: rpmDistro({
    documentationUrl: 'https://wiki.almalinux.org/',
    packageSearchUrl: 'https://repo.almalinux.org/almalinux/',
    releaseUrl: identity => `https://repo.almalinux.org/almalinux/${encodeURIComponent(majorVersion(identity.versionId))}/`
  }),
  rocky: rpmDistro({
    documentationUrl: 'https://docs.rockylinux.org/',
    packageSearchUrl: 'https://download.rockylinux.org/pub/rocky/',
    releaseUrl: identity => `https://download.rockylinux.org/pub/rocky/${encodeURIComponent(majorVersion(identity.versionId))}/`
  }),
  ol: rpmDistro({
    documentationUrl: 'https://docs.oracle.com/en/operating-systems/oracle-linux/',
    packageSearchUrl: 'https://yum.oracle.com/',
    releaseUrl: identity => `https://docs.oracle.com/en/operating-systems/oracle-linux/${encodeURIComponent(majorVersion(identity.versionId))}/`
  }),
  opensuse: suseDistro(),
  'opensuse-leap': suseDistro()
}

export class LinuxHostContextService {
  constructor ({ fetchImpl = globalThis.fetch, now = () => new Date(), ttlMs = DEFAULT_TTL_MS } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
    if (typeof now !== 'function') throw new TypeError('now must be a function')
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new TypeError('ttlMs must be a non-negative number')
    this.fetch = fetchImpl
    this.now = now
    this.ttlMs = ttlMs
  }

  async build ({ inventory, execution, docker = {}, previous = null }) {
    const identity = linuxIdentity(inventory, execution)
    if (identity.platform !== 'linux') return null
    const generatedAt = this.now()
    const fingerprint = [identity.id, identity.versionId, identity.codename, identity.architecture].join(':')
    const previousTtl = previous?.officialSources?.release?.status === 'online'
      ? this.ttlMs
      : Math.min(this.ttlMs, UNAVAILABLE_TTL_MS)
    if (isFresh(previous, fingerprint, generatedAt, previousTtl)) {
      const distro = DISTROS[identity.id] ?? genericDistro(identity)
      const management = {
        ...previous.management,
        packageManager: firstAvailable(execution.commands, previous.management?.packageManager),
        serviceManager: detectServiceManager(execution.commands, previous.management?.serviceManager),
        init: execution.init || null,
        availableServiceUnits: execution.serviceUnits ?? []
      }
      return {
        ...previous,
        version: VERSION,
        observedAt: generatedAt.toISOString(),
        execution,
        management,
        stack: {
          ...previous.stack,
          availableCommands: Object.entries(execution.commands ?? {}).filter(([, available]) => available).map(([name]) => name),
          detectedVersions: execution.versions ?? {},
          installedPackages: execution.installedPackages ?? []
        },
        applications: applicationProfiles(identity, distro),
        stackProfiles: buildLinuxStackProfiles({ identity, management, execution, docker }),
        cache: { reused: true, expiresAt: new Date(new Date(previous.refreshedAt).getTime() + this.ttlMs).toISOString() }
      }
    }

    const distro = DISTROS[identity.id] ?? genericDistro(identity)
    const releaseUrl = distro.releaseUrl(identity)
    const online = await this.checkOfficialSource(releaseUrl, identity)
    const cacheTtl = online.status === 'online' ? this.ttlMs : Math.min(this.ttlMs, UNAVAILABLE_TTL_MS)
    const management = {
      family: distro.family,
      packageManager: firstAvailable(execution.commands, distro.packageManager),
      serviceManager: detectServiceManager(execution.commands, distro.serviceManager),
      init: execution.init || null,
      availableServiceUnits: execution.serviceUnits ?? []
    }
    return {
      format: FORMAT,
      version: VERSION,
      refreshedAt: generatedAt.toISOString(),
      observedAt: generatedAt.toISOString(),
      fingerprint,
      identity,
      management,
      stack: {
        availableCommands: Object.entries(execution.commands ?? {}).filter(([, available]) => available).map(([name]) => name),
        detectedVersions: execution.versions ?? {},
        installedPackages: execution.installedPackages ?? [],
        candidatePackages: distro.packageCandidates,
        candidatePackageWarning: 'Candidate names are distro-specific starting points, not proof of repository availability; verify with the configured package manager before changing the host.'
      },
      applications: applicationProfiles(identity, distro),
      stackProfiles: buildLinuxStackProfiles({ identity, management, execution, docker }),
      officialSources: {
        documentation: distro.documentationUrl,
        packages: distro.packageSearchUrl,
        release: online
      },
      cache: { reused: false, expiresAt: new Date(generatedAt.getTime() + cacheTtl).toISOString() }
    }
  }

  async checkOfficialSource (url, identity) {
    const checkedAt = this.now().toISOString()
    try {
      const response = await this.fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { accept: 'text/html,application/json,text/plain;q=0.9', 'user-agent': 'IntentAIOps-Linux-Context/1' },
        signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await readLimitedText(response.body, SOURCE_BODY_LIMIT)
      const versionNeedle = String(identity.versionId ?? '').trim()
      return {
        url,
        status: 'online',
        checkedAt,
        finalUrl: sameOfficialOrigin(url, response.url) ? response.url : url,
        lastModified: boundedHeader(response.headers.get('last-modified')),
        versionMentioned: versionNeedle ? body.toLowerCase().includes(versionNeedle.toLowerCase()) : null
      }
    } catch (error) {
      return { url, status: 'unavailable', checkedAt, error: boundedError(error) }
    }
  }
}

/** @param {{ architecture?: string, primaryAddressCommand?: string }} [options] */
export function buildLinuxComposeReferenceContext ({ architecture = 'x86_64', primaryAddressCommand } = {}) {
  const identity = {
    platform: 'linux',
    id: 'ubuntu',
    idLike: '',
    name: 'Ubuntu',
    prettyName: 'Ubuntu 24.04 LTS Compose reference',
    version: '24.04',
    versionId: '24.04',
    codename: 'noble',
    architecture,
    kernel: null
  }
  const distro = DISTROS.ubuntu
  const management = {
    family: distro.family,
    packageManager: 'apt',
    serviceManager: 'systemd',
    init: 'systemd',
    availableServiceUnits: []
  }
  const execution = { platform: 'linux', architecture, commands: { apt: true }, installedPackages: [], serviceUnits: [], versions: {} }
  const applications = applicationProfiles(identity, distro)
  if (primaryAddressCommand) applications.wordpress.primaryAddressCommand = primaryAddressCommand
  return {
    format: 'webminai-compose-reference-context',
    version: 1,
    fingerprint: `compose-reference:ubuntu:24.04:${architecture}`,
    identity,
    management,
    execution,
    applications,
    stackProfiles: buildLinuxStackProfiles({ identity, management, execution, docker: { ready: true, composeAvailable: true } })
  }
}

function applicationProfiles (identity, distro) {
  return {
    wordpress: wordpressProfile(identity, distro)
  }
}

function wordpressProfile (identity, distro) {
  const shared = {
    deployment: 'native-nginx-php-fpm-mariadb',
    externalPort: 18101,
    phpFpmRuntimeDirectory: '/run/webminai-wordpress-18101',
    phpFpmListener: '/run/webminai-wordpress-18101/php-fpm.sock',
    webRoot: '/srv/webminai-wordpress-18101',
    artifactDirectory: '/var/lib/webminai/webminai-wordpress-18101',
    wordpressArchive: '/var/lib/webminai/webminai-wordpress-18101/wordpress.tar.gz',
    wpCliPhar: '/var/lib/webminai/webminai-wordpress-18101/wp-cli.phar',
    credentialsDirectory: '/root/wordpress_credentials',
    databaseName: 'webminai_wordpress_18101',
    databaseUser: 'webminai_wordpress_18101',
    databaseHost: 'localhost',
    databaseAdministrativeAuth: 'local-socket-without-MYSQL_PWD',
    nginxFastcgiPass: 'unix:/run/webminai-wordpress-18101/php-fpm.sock',
    nginxRequiredFastcgiParams: ['HTTP_HOST $http_host', 'SERVER_PORT $server_port', 'REQUEST_SCHEME $scheme', 'SCRIPT_FILENAME $document_root$fastcgi_script_name'],
    primaryAddressCommand: 'ip -o -4 addr show scope global | awk \'{sub(/\\/.*/, "", $4); print $4; exit}\'',
    officialSources: {
      requirements: 'https://wordpress.org/about/requirements/',
      coreArchive: 'https://wordpress.org/latest.tar.gz',
      coreDigest: 'https://wordpress.org/latest.tar.gz.sha1',
      wpCli: 'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar',
      wpCliDigest: 'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar.sha512'
    }
  }
  if (distro.family === 'debian') {
    const phpVersion = identity.id === 'ubuntu' ? ubuntuPhpVersion(identity.versionId) : '8.4'
    return {
      ...shared,
      packages: ['ca-certificates', 'tar', 'gzip', 'openssl', 'nginx', 'mariadb-server', 'php-cli', 'php-fpm', 'php-mysql', 'php-curl', 'php-gd', 'php-intl', 'php-mbstring', 'php-xml', 'php-zip'],
      phpBinary: '/usr/bin/php',
      phpFpmBinary: `/usr/sbin/php-fpm${phpVersion}`,
      phpFpmService: `php${phpVersion}-fpm.service`,
      phpFpmPool: `/etc/php/${phpVersion}/fpm/pool.d/webminai-wordpress-18101.conf`,
      phpFpmUser: 'www-data',
      phpFpmGroup: 'www-data',
      nginxService: 'nginx.service',
      nginxVhost: '/etc/nginx/sites-available/webminai-wordpress-18101.conf',
      nginxEnableLink: '/etc/nginx/sites-enabled/webminai-wordpress-18101.conf',
      mariadbService: 'mariadb.service'
    }
  }
  if (distro.family === 'alpine') {
    return {
      ...shared,
      packages: ['ca-certificates', 'tar', 'gzip', 'openssl', 'nginx', 'mariadb', 'mariadb-client', 'php83', 'php83-fpm', 'php83-curl', 'php83-dom', 'php83-fileinfo', 'php83-gd', 'php83-iconv', 'php83-intl', 'php83-mbstring', 'php83-mysqli', 'php83-mysqlnd', 'php83-opcache', 'php83-openssl', 'php83-phar', 'php83-session', 'php83-simplexml', 'php83-tokenizer', 'php83-xml', 'php83-xmlreader', 'php83-xmlwriter', 'php83-zip'],
      phpBinary: '/usr/bin/php83',
      phpFpmBinary: '/usr/sbin/php-fpm83',
      phpFpmService: 'php-fpm83',
      phpFpmPool: '/etc/php83/php-fpm.d/webminai-wordpress-18101.conf',
      phpFpmUser: 'nginx',
      phpFpmGroup: 'nginx',
      nginxService: 'nginx',
      nginxVhost: '/etc/nginx/http.d/webminai-wordpress-18101.conf',
      mariadbService: 'mariadb'
    }
  }
  if (distro.family === 'arch') {
    return {
      ...shared,
      packages: ['ca-certificates', 'tar', 'gzip', 'openssl', 'nginx', 'mariadb', 'php', 'php-fpm', 'php-gd'],
      phpBinary: '/usr/bin/php',
      phpFpmBinary: '/usr/bin/php-fpm',
      phpFpmService: 'php-fpm.service',
      phpFpmPool: '/etc/php/php-fpm.d/webminai-wordpress-18101.conf',
      phpFpmUser: 'http',
      phpFpmGroup: 'http',
      phpExtensionConfig: '/etc/php/conf.d/webminai-wordpress-18101.ini',
      phpExtensionsToEnable: ['curl', 'gd', 'iconv', 'intl', 'mysqli', 'pdo_mysql', 'zip'],
      nginxService: 'nginx.service',
      nginxVhost: '/etc/nginx/conf.d/webminai-wordpress-18101.conf',
      nginxMainConfig: '/etc/nginx/nginx.conf',
      nginxIncludeDirective: 'include conf.d/*.conf;',
      nginxIncludeRequired: true,
      mariadbService: 'mariadb.service',
      mariadbInitialization: 'mariadb-install-db --user=mysql --basedir=/usr --datadir=/var/lib/mysql'
    }
  }
  if (distro.family === 'suse') {
    return {
      ...shared,
      packages: ['ca-certificates', 'tar', 'gzip', 'openssl', 'nginx', 'mariadb', 'php8', 'php8-cli', 'php8-phar', 'php8-fpm', 'php8-mysql', 'php8-dom', 'php8-xmlreader', 'php8-xmlwriter', 'php8-curl', 'php8-fileinfo', 'php8-gd', 'php8-iconv', 'php8-intl', 'php8-mbstring', 'php8-openssl', 'php8-tokenizer', 'php8-zip'],
      phpBinary: '/usr/bin/php',
      phpFpmBinary: '/usr/sbin/php-fpm',
      phpFpmService: 'php-fpm.service',
      phpFpmPool: '/etc/php8/fpm/php-fpm.d/webminai-wordpress-18101.conf',
      phpFpmUser: 'nginx',
      phpFpmGroup: 'nginx',
      nginxService: 'nginx.service',
      nginxVhost: '/etc/nginx/vhosts.d/webminai-wordpress-18101.conf',
      mariadbService: 'mariadb.service',
      packageRefreshCommand: 'zypper --non-interactive refresh --force'
    }
  }
  return {
    ...shared,
    databaseHost: '127.0.0.1',
    packages: ['ca-certificates', 'tar', 'gzip', 'openssl', 'nginx', 'mariadb-server', 'php-cli', 'php-fpm', 'php-mysqlnd', 'php-gd', 'php-intl', 'php-mbstring', 'php-xml', 'php-pecl-zip'],
    phpBinary: '/usr/bin/php',
    phpFpmBinary: '/usr/sbin/php-fpm',
    phpFpmService: 'php-fpm.service',
    phpFpmPool: '/etc/php-fpm.d/webminai-wordpress-18101.conf',
    phpFpmUser: 'nginx',
    phpFpmGroup: 'nginx',
    nginxService: 'nginx.service',
    nginxVhost: '/etc/nginx/conf.d/webminai-wordpress-18101.conf',
    mariadbService: 'mariadb.service'
  }
}

function ubuntuPhpVersion (versionId) {
  const release = Number.parseInt(String(versionId).split('.')[0], 10)
  if (release <= 22) return '8.1'
  if (release >= 26) return '8.5'
  return '8.3'
}

export function parseLinuxExecutionInventory (stdout) {
  const values = Object.fromEntries(String(stdout).split('\n').filter(Boolean).map(line => {
    const separator = line.indexOf('=')
    return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)]
  }))
  let osRelease = {}
  if (values.osReleaseBase64) {
    try {
      osRelease = parseOsRelease(Buffer.from(values.osReleaseBase64, 'base64').toString('utf8'))
    } catch {}
  }
  const commands = {}
  const versions = {}
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith('command_')) commands[key.slice(8).replaceAll('_', '-')] = value === 'yes'
    if (key.startsWith('version_')) {
      try {
        versions[key.slice(8).replaceAll('_', '-')] = cleanValue(Buffer.from(value, 'base64').toString('utf8'))
      } catch {}
    }
  }
  return {
    platform: 'linux',
    architecture: cleanValue(values.architecture),
    kernel: cleanValue(values.kernel),
    init: cleanValue(values.init),
    osRelease,
    commands,
    versions,
    installedPackages: decodeLineList(values.installedPackagesBase64, 256),
    serviceUnits: decodeLineList(values.serviceUnitsBase64, 128)
  }
}

function decodeLineList (encoded, limit) {
  if (!encoded) return []
  try {
    return Buffer.from(encoded, 'base64').toString('utf8').split(/\r?\n/u)
      .map(cleanValue).filter(Boolean).slice(0, limit)
  } catch {
    return []
  }
}

function linuxIdentity (inventory, execution) {
  const release = execution?.osRelease ?? {}
  const application = firstAgentApplication(inventory)
  const applicationOs = typeof application?.os === 'string' ? application.os.toLowerCase() : ''
  return {
    platform: execution?.platform === 'linux' || applicationOs.includes('linux') ? 'linux' : 'unknown',
    id: normalizedId(release.ID),
    idLike: cleanValue(release.ID_LIKE),
    name: cleanValue(release.NAME),
    prettyName: cleanValue(release.PRETTY_NAME),
    version: cleanValue(release.VERSION),
    versionId: cleanValue(release.VERSION_ID),
    codename: cleanValue(release.VERSION_CODENAME ?? release.UBUNTU_CODENAME),
    architecture: cleanValue(execution?.architecture),
    kernel: cleanValue(execution?.kernel)
  }
}

function parseOsRelease (content) {
  const values = {}
  for (const line of String(content).split('\n')) {
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
    if (!match) continue
    let value = match[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    values[match[1]] = stripControl(value.replace(/\\([\\"'$`])/g, '$1')).slice(0, 512)
  }
  return values
}

function firstAgentApplication (inventory) {
  return Array.isArray(inventory?.info?.agents) ? inventory.info.agents[0]?.application : null
}

function normalizedId (value) {
  const id = cleanValue(value).toLowerCase()
  if (id === 'oracle') return 'ol'
  if (id === 'opensuse-tumbleweed') return 'opensuse'
  return id || 'unknown'
}

function cleanValue (value) {
  return typeof value === 'string' ? stripControl(value).trim().slice(0, 512) : ''
}

function stripControl (value) {
  return [...value].filter(character => {
    const code = character.codePointAt(0)
    return code > 31 && code !== 127
  }).join('')
}

function isFresh (previous, fingerprint, now, ttlMs) {
  if (previous?.format !== FORMAT || previous.version !== VERSION || previous.fingerprint !== fingerprint) return false
  const refreshedAt = new Date(previous.refreshedAt).getTime()
  return Number.isFinite(refreshedAt) && now.getTime() - refreshedAt < ttlMs
}

function firstAvailable (commands = {}, preferred) {
  if (commands[preferred]) return preferred
  return ['apt', 'dnf', 'yum', 'apk', 'pacman', 'zypper'].find(command => commands[command]) ?? preferred
}

function detectServiceManager (commands = {}, preferred) {
  if (commands.systemctl) return 'systemd'
  if (commands['rc-service']) return 'openrc'
  if (commands.service) return 'sysv-compatible'
  return preferred
}

function genericDistro (identity) {
  const family = identity.idLike.split(/\s+/).find(Boolean) || identity.id
  const rpm = ['rhel', 'fedora', 'centos'].includes(family)
  return rpm
    ? rpmDistro({ documentationUrl: 'https://docs.fedoraproject.org/', packageSearchUrl: 'https://packages.fedoraproject.org/', releaseUrl: () => 'https://docs.fedoraproject.org/' })
    : {
        family,
        packageManager: 'unknown',
        serviceManager: 'unknown',
        documentationUrl: 'https://www.kernel.org/doc/html/latest/admin-guide/',
        packageSearchUrl: 'https://www.linux.org/',
        releaseUrl: () => 'https://www.kernel.org/',
        packageCandidates: []
      }
}

function rpmDistro ({ documentationUrl, packageSearchUrl, releaseUrl }) {
  return {
    family: 'rhel',
    packageManager: 'dnf',
    serviceManager: 'systemd',
    documentationUrl,
    packageSearchUrl,
    releaseUrl,
    packageCandidates: ['ca-certificates', 'tar', 'gzip', 'openssl', 'nginx', 'httpd', 'php-fpm', 'php-cli', 'php-mysqlnd', 'mariadb-server', 'postgresql-server', 'nodejs', 'npm', 'redis', 'podman-compose', 'docker-compose-plugin']
  }
}

function suseDistro () {
  return {
    family: 'suse',
    packageManager: 'zypper',
    serviceManager: 'systemd',
    documentationUrl: 'https://doc.opensuse.org/',
    packageSearchUrl: 'https://software.opensuse.org/',
    releaseUrl: identity => identity.versionId ? `https://get.opensuse.org/leap/${encodeURIComponent(identity.versionId)}/` : 'https://get.opensuse.org/',
    packageCandidates: ['ca-certificates', 'tar', 'gzip', 'openssl', 'nginx', 'apache2', 'php8', 'php8-fpm', 'php8-mysql', 'php8-dom', 'php8-xmlreader', 'php8-xmlwriter', 'php8-curl', 'php8-gd', 'php8-iconv', 'php8-mbstring', 'php8-zip', 'mariadb', 'postgresql-server', 'nodejs', 'npm', 'redis', 'docker-compose']
  }
}

function debianPackages () {
  return ['ca-certificates', 'tar', 'gzip', 'openssl', 'nginx', 'apache2', 'php-fpm', 'php-cli', 'php-mysql', 'php-curl', 'php-gd', 'php-intl', 'php-mbstring', 'php-xml', 'php-zip', 'mariadb-server', 'postgresql', 'nodejs', 'npm', 'redis-server', 'docker-compose-v2']
}

function majorVersion (version) {
  return String(version || 'latest').split('.')[0]
}

async function readLimitedText (stream, limit) {
  if (!stream) return ''
  const reader = stream.getReader()
  const chunks = []
  let size = 0
  try {
    while (size < limit) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = limit - size
      chunks.push(value.subarray(0, remaining))
      size += Math.min(value.length, remaining)
      if (value.length > remaining) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks.map(value => Buffer.from(value))).toString('utf8')
}

function sameOfficialOrigin (requested, actual) {
  try {
    return new URL(requested).hostname === new URL(actual).hostname
  } catch {
    return false
  }
}

function boundedHeader (value) {
  return typeof value === 'string' ? value.replace(/[\r\n]/g, '').slice(0, 200) || null : null
}

function boundedError (error) {
  return String(error?.message ?? error).replace(/[\r\n]/g, ' ').slice(0, 240)
}
