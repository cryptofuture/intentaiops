const PROFILE_FORMAT = 'webminai-linux-stack-profiles'
const PROFILE_VERSION = 1
const PROFILE_IDS = ['nginx', 'php-fpm', 'mariadb', 'postgresql', 'nodejs', 'python', 'composer', 'compose']
const PROFILE_STATUS = new Set(['ready', 'installable', 'blocked', 'unknown'])

export function buildLinuxStackProfiles ({ identity, management, execution, docker = {} }) {
  if (identity?.platform !== 'linux') throw new TypeError('Linux stack profiles require a Linux identity')
  const family = management?.family
  const definitions = definitionsFor({ identity, family })
  const profiles = Object.fromEntries(PROFILE_IDS.map(id => {
    const definition = definitions[id]
    return [id, materializeProfile(id, definition, execution, docker)]
  }))
  const value = {
    format: PROFILE_FORMAT,
    version: PROFILE_VERSION,
    hostFingerprint: [identity.id, identity.versionId, identity.architecture].join(':'),
    profiles
  }
  validateLinuxStackProfiles(value)
  return value
}

export function validateLinuxStackProfiles (value) {
  if (value?.format !== PROFILE_FORMAT || value.version !== PROFILE_VERSION || typeof value.hostFingerprint !== 'string') {
    throw new TypeError('invalid Linux stack profile envelope')
  }
  if (!value.profiles || typeof value.profiles !== 'object' || Array.isArray(value.profiles)) {
    throw new TypeError('Linux stack profiles require a profiles object')
  }
  if (Object.keys(value.profiles).sort().join(',') !== [...PROFILE_IDS].sort().join(',')) {
    throw new TypeError('Linux stack profile set is incomplete')
  }
  for (const id of PROFILE_IDS) validateProfile(id, value.profiles[id])
  return value
}

export function stackProfileIds () {
  return [...PROFILE_IDS]
}

function materializeProfile (id, definition, execution = {}, docker = {}) {
  const commands = execution.commands ?? {}
  const installedPackages = new Set(execution.installedPackages ?? [])
  const availableServices = new Set(execution.serviceUnits ?? [])
  const observedBinary = definition.binaryCandidates.find(binary => commands[commandKey(binary)]) ?? null
  const installed = Boolean(observedBinary || definition.packages.some(packageName => installedPackages.has(packageName)))
  const service = definition.serviceCandidates.find(candidate => availableServices.has(candidate)) ?? definition.serviceCandidates[0] ?? null
  const versionKey = definition.versionCommands.find(command => execution.versions?.[command] !== undefined)
  const versionText = versionKey ? execution.versions[versionKey] : null
  const version = normalizedVersion(versionText)
  let status = observedBinary ? 'ready' : definition.installable ? 'installable' : 'unknown'
  let reason = observedBinary ? 'required command is present' : definition.installable ? 'reviewed distribution package route is available' : 'no reviewed installation route'

  if (id === 'compose') {
    const ready = docker.cliAvailable && docker.daemonReachable && docker.composeAvailable
    status = ready ? 'ready' : docker.installSupported ? 'installable' : docker.hostIsContainer ? 'blocked' : 'unknown'
    reason = ready
      ? 'Docker Engine and Compose are reachable'
      : docker.installSupported
        ? `Docker setup is supported through ${docker.installMethod}`
        : docker.hostIsContainer
          ? `automatic Docker setup is blocked inside ${docker.containerRuntime ?? 'a container'}`
          : 'no reviewed Docker installation route'
  }

  return {
    id,
    kind: definition.kind,
    provider: definition.provider,
    status,
    reason,
    installed,
    installable: id === 'compose' ? Boolean(docker.installSupported) : definition.installable,
    packages: [...definition.packages],
    packageAlternatives: definition.packageAlternatives.map(items => [...items]),
    binaries: [...definition.binaryCandidates],
    observedBinary,
    service,
    serviceCandidates: [...definition.serviceCandidates],
    configPaths: [...definition.configPaths],
    version,
    versionText,
    capabilities: { ...definition.capabilities },
    evidence: {
      installedPackages: definition.packages.filter(packageName => installedPackages.has(packageName)),
      availableServices: definition.serviceCandidates.filter(candidate => availableServices.has(candidate)),
      installMethod: id === 'compose' ? docker.installMethod ?? null : null,
      containerRuntime: id === 'compose' ? docker.containerRuntime ?? null : null
    }
  }
}

function definitionsFor ({ identity, family }) {
  const common = {
    nginx: serviceDefinition('web-server', 'nginx', ['nginx'], ['/usr/sbin/nginx', '/usr/bin/nginx'], ['nginx.service'], ['/etc/nginx/nginx.conf'], ['nginx']),
    mariadb: serviceDefinition('database', 'mariadb', ['mariadb-server'], ['/usr/bin/mariadb', '/usr/bin/mysql'], ['mariadb.service'], ['/etc/my.cnf', '/etc/mysql'], ['mariadbd', 'mysqld']),
    postgresql: serviceDefinition('database', 'postgresql', ['postgresql', 'postgresql-server'], ['/usr/bin/psql'], ['postgresql.service'], ['/etc/postgresql', '/var/lib/pgsql/data/postgresql.conf'], ['postgres', 'psql']),
    nodejs: runtimeDefinition('nodejs', ['nodejs', 'npm'], ['/usr/bin/node'], ['node'], nodeCapabilities(identity, family)),
    python: runtimeDefinition('python', ['python3', 'python3-pip', 'python3-venv'], ['/usr/bin/python3'], ['python3'], { virtualEnvironment: true }),
    composer: runtimeDefinition('composer', ['composer'], ['/usr/bin/composer'], ['composer'], { phpPackageManager: true }),
    compose: composeDefinition(identity)
  }

  if (family === 'debian') {
    const phpVersion = identity.id === 'ubuntu' ? ubuntuPhpVersion(identity.versionId) : '8.4'
    return {
      ...common,
      'php-fpm': phpDefinition({
        packages: ['php-cli', 'php-fpm', 'php-mysql', 'php-curl', 'php-gd', 'php-intl', 'php-mbstring', 'php-xml', 'php-zip'],
        binaries: ['/usr/bin/php', `/usr/sbin/php-fpm${phpVersion}`],
        service: `php${phpVersion}-fpm.service`,
        config: [`/etc/php/${phpVersion}/fpm/php-fpm.conf`, `/etc/php/${phpVersion}/fpm/pool.d`],
        user: 'www-data',
        version: phpVersion
      }),
      mariadb: { ...common.mariadb, packages: ['mariadb-server', 'mariadb-client'], configPaths: ['/etc/mysql', '/etc/mysql/mariadb.conf.d'] },
      postgresql: { ...common.postgresql, packages: ['postgresql', 'postgresql-client'], configPaths: ['/etc/postgresql'] }
    }
  }
  if (family === 'alpine') {
    return {
      ...common,
      nginx: { ...common.nginx, binaryCandidates: ['/usr/sbin/nginx'], serviceCandidates: ['nginx'], configPaths: ['/etc/nginx/nginx.conf', '/etc/nginx/http.d'] },
      'php-fpm': phpDefinition({
        packages: ['php83', 'php83-fpm', 'php83-curl', 'php83-dom', 'php83-fileinfo', 'php83-gd', 'php83-intl', 'php83-mbstring', 'php83-mysqli', 'php83-opcache', 'php83-phar', 'php83-session', 'php83-simplexml', 'php83-xml', 'php83-xmlreader', 'php83-xmlwriter', 'php83-zip'],
        binaries: ['/usr/bin/php83', '/usr/sbin/php-fpm83'],
        service: 'php-fpm83',
        config: ['/etc/php83/php.ini', '/etc/php83/php-fpm.conf', '/etc/php83/php-fpm.d'],
        user: 'nginx',
        version: '8.3'
      }),
      mariadb: { ...common.mariadb, packages: ['mariadb', 'mariadb-client'], serviceCandidates: ['mariadb'], configPaths: ['/etc/my.cnf.d'] },
      postgresql: { ...common.postgresql, packages: ['postgresql18', 'postgresql18-client'], serviceCandidates: ['postgresql'], configPaths: ['/var/lib/postgresql/18/data/postgresql.conf'], capabilities: { ...common.postgresql.capabilities, profileVersion: '18' } },
      nodejs: runtimeDefinition('nodejs', ['nodejs', 'npm'], ['/usr/bin/node'], ['node'], nodeCapabilities(identity, family)),
      python: runtimeDefinition('python', ['python3', 'py3-pip', 'py3-virtualenv'], ['/usr/bin/python3'], ['python3'], { virtualEnvironment: true }),
      composer: runtimeDefinition('composer', ['composer'], ['/usr/bin/composer'], ['composer'], { phpPackageManager: true })
    }
  }
  if (family === 'arch') {
    return {
      ...common,
      'php-fpm': phpDefinition({
        packages: ['php', 'php-fpm', 'php-gd'],
        binaries: ['/usr/bin/php', '/usr/bin/php-fpm'],
        service: 'php-fpm.service',
        config: ['/etc/php/php.ini', '/etc/php/php-fpm.conf', '/etc/php/php-fpm.d'],
        user: 'http'
      }),
      mariadb: { ...common.mariadb, packages: ['mariadb'], configPaths: ['/etc/my.cnf.d'] },
      postgresql: { ...common.postgresql, packages: ['postgresql'], configPaths: ['/var/lib/postgres/data/postgresql.conf'] },
      python: runtimeDefinition('python', ['python', 'python-pip'], ['/usr/bin/python3', '/usr/bin/python'], ['python3'], { virtualEnvironment: true })
    }
  }
  if (family === 'suse') {
    return {
      ...common,
      nginx: { ...common.nginx, configPaths: ['/etc/nginx/nginx.conf', '/etc/nginx/vhosts.d'] },
      'php-fpm': phpDefinition({
        packages: ['php8', 'php8-cli', 'php8-phar', 'php8-fpm', 'php8-mysql', 'php8-curl', 'php8-dom', 'php8-gd', 'php8-iconv', 'php8-mbstring', 'php8-openssl', 'php8-tokenizer', 'php8-xmlreader', 'php8-xmlwriter', 'php8-zip'],
        binaries: ['/usr/bin/php', '/usr/sbin/php-fpm'],
        service: 'php-fpm.service',
        config: ['/etc/php8/cli/php.ini', '/etc/php8/fpm/php-fpm.conf', '/etc/php8/fpm/php-fpm.d'],
        user: 'nginx',
        version: '8'
      }),
      mariadb: { ...common.mariadb, packages: ['mariadb', 'mariadb-client'], configPaths: ['/etc/my.cnf', '/etc/my.cnf.d'] },
      postgresql: { ...common.postgresql, packages: ['postgresql-server', 'postgresql'], configPaths: ['/var/lib/pgsql/data/postgresql.conf'] },
      nodejs: runtimeDefinition('nodejs', ['nodejs-default', 'npm-default'], ['/usr/bin/node'], ['node'], nodeCapabilities(identity, family)),
      python: runtimeDefinition('python', ['python3', 'python313-pip', 'python313-virtualenv'], ['/usr/bin/python3'], ['python3'], { virtualEnvironment: true, profileVersion: '3.13' }),
      composer: runtimeDefinition('composer', ['php-composer2'], ['/usr/bin/composer'], ['composer'], { phpPackageManager: true, profileVersion: '2' })
    }
  }
  const rpm = {
    ...common,
    'php-fpm': phpDefinition({
      packages: ['php-cli', 'php-fpm', 'php-mysqlnd', 'php-gd', 'php-intl', 'php-mbstring', 'php-xml', 'php-pecl-zip'],
      binaries: ['/usr/bin/php', '/usr/sbin/php-fpm'],
      service: 'php-fpm.service',
      config: ['/etc/php.ini', '/etc/php-fpm.conf', '/etc/php-fpm.d'],
      user: 'nginx'
    }),
    mariadb: { ...common.mariadb, packages: ['mariadb-server'], configPaths: ['/etc/my.cnf', '/etc/my.cnf.d'] },
    postgresql: { ...common.postgresql, packages: ['postgresql-server', 'postgresql'], configPaths: ['/var/lib/pgsql/data/postgresql.conf'] },
    python: runtimeDefinition('python', ['python3', 'python3-pip'], ['/usr/bin/python3'], ['python3'], { virtualEnvironment: true })
  }
  if (identity.id === 'fedora') {
    rpm.nodejs = runtimeDefinition('nodejs', ['nodejs24', 'nodejs24-npm'], ['/usr/bin/node'], ['node'], { ...nodeCapabilities(identity, family), profileVersion: '24' })
  }
  if (identity.id === 'ol') {
    rpm.composer = runtimeDefinition('composer', [], ['/usr/local/bin/composer', '/usr/bin/composer'], ['composer'], {
      phpPackageManager: true,
      installation: 'verified-upstream-installer',
      installerUrl: 'https://getcomposer.org/installer',
      checksumUrl: 'https://composer.github.io/installer.sig'
    })
  }
  return rpm
}

function serviceDefinition (kind, provider, packages, binaries, services, configPaths, versions) {
  return {
    kind,
    provider,
    installable: true,
    packages,
    packageAlternatives: [],
    binaryCandidates: binaries,
    serviceCandidates: services,
    configPaths,
    versionCommands: versions,
    capabilities: { managedService: true }
  }
}

function runtimeDefinition (provider, packages, binaries, versions, capabilities) {
  return {
    kind: 'runtime',
    provider,
    installable: true,
    packages,
    packageAlternatives: [],
    binaryCandidates: binaries,
    serviceCandidates: [],
    configPaths: [],
    versionCommands: versions,
    capabilities
  }
}

function nodeCapabilities (identity, family) {
  const nodeSource = ['debian', 'rhel', 'rpm'].includes(family) && ['x86_64', 'amd64', 'aarch64', 'arm64'].includes(identity.architecture)
  return {
    packageManagerBinary: '/usr/bin/npm',
    requiredMajorSelection: true,
    upstreamRepository: nodeSource
      ? {
          provider: 'nodesource',
          supported: true,
          majorVersions: ['22', '24'],
          distributionClass: family === 'debian' ? 'deb' : 'rpm',
          documentation: 'https://nodesource.com/products/distributions',
          installation: 'signed-repository'
        }
      : {
          provider: 'nodesource',
          supported: false,
          reason: 'NodeSource publishes reviewed DEB and RHEL-family distributions; use a compatible distro package or a verified upstream artifact',
          documentation: 'https://nodesource.com/products/distributions'
        }
  }
}

function phpDefinition ({ packages, binaries, service, config, user, version = null }) {
  return {
    kind: 'runtime-service',
    provider: 'php-fpm',
    installable: true,
    packages,
    packageAlternatives: [],
    binaryCandidates: binaries,
    serviceCandidates: [service],
    configPaths: config,
    versionCommands: ['php', 'php-fpm'],
    capabilities: { managedService: true, fastCgi: true, serviceUser: user, profileVersion: version }
  }
}

function composeDefinition (identity) {
  return {
    kind: 'orchestrator',
    provider: 'docker-compose-v2',
    installable: false,
    packages: [],
    packageAlternatives: [],
    binaryCandidates: ['/usr/bin/docker', '/usr/local/bin/docker'],
    serviceCandidates: ['docker.service'],
    configPaths: ['/etc/docker/daemon.json'],
    versionCommands: ['docker'],
    capabilities: { composeV2: true, architecture: identity.architecture }
  }
}

function commandKey (binary) {
  const name = binary.slice(binary.lastIndexOf('/') + 1)
  if (name.startsWith('php-fpm')) return 'php-fpm'
  if (name === 'python') return 'python3'
  return name
}

function normalizedVersion (text) {
  const match = String(text ?? '').match(/\b(\d+(?:\.\d+){0,3})\b/u)
  return match?.[1] ?? null
}

function ubuntuPhpVersion (versionId) {
  const release = Number.parseInt(String(versionId).split('.')[0], 10)
  if (release <= 22) return '8.1'
  if (release >= 26) return '8.5'
  return '8.3'
}

function validateProfile (id, profile) {
  if (profile?.id !== id || typeof profile.kind !== 'string' || typeof profile.provider !== 'string') {
    throw new TypeError(`invalid Linux stack profile: ${id}`)
  }
  if (!PROFILE_STATUS.has(profile.status) || typeof profile.reason !== 'string') throw new TypeError(`invalid Linux stack profile status: ${id}`)
  for (const key of ['packages', 'packageAlternatives', 'binaries', 'serviceCandidates', 'configPaths']) {
    if (!Array.isArray(profile[key])) throw new TypeError(`Linux stack profile ${id} requires ${key}`)
  }
  if (profile.packages.some(value => !safePackage(value)) || profile.binaries.some(value => !absolutePath(value)) || profile.configPaths.some(value => !absolutePath(value))) {
    throw new TypeError(`Linux stack profile ${id} contains unsafe package or path data`)
  }
  if (profile.service !== null && !/^[A-Za-z0-9_.@-]+$/u.test(profile.service)) throw new TypeError(`Linux stack profile ${id} contains an unsafe service`)
}

function safePackage (value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9+_.:-]*$/u.test(value)
}

function absolutePath (value) {
  return typeof value === 'string' && /^\/[A-Za-z0-9_./@+-]+$/u.test(value) && !value.includes('..')
}
