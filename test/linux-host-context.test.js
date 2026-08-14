import assert from 'node:assert/strict'
import test from 'node:test'
import { LinuxHostContextService, parseLinuxExecutionInventory } from '../src/linux-host-context.js'

test('Linux host context combines Netdata platform identity with distro management and official sources', async () => {
  const requests = []
  const service = new LinuxHostContextService({
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return new Response('<html>Ubuntu 24.04 LTS</html>', {
        status: 200,
        headers: { 'last-modified': 'Fri, 07 Aug 2026 00:00:00 GMT' }
      })
    },
    now: () => new Date('2026-08-07T12:00:00.000Z')
  })
  const context = await service.build({
    inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
    execution: {
      platform: 'linux',
      architecture: 'x86_64',
      kernel: '6.8.0',
      init: 'systemd',
      osRelease: { ID: 'ubuntu', NAME: 'Ubuntu', PRETTY_NAME: 'Ubuntu 24.04.3 LTS', VERSION_ID: '24.04', VERSION_CODENAME: 'noble' },
      commands: { apt: true, systemctl: true, nginx: true, php: false },
      installedPackages: ['nginx', 'php8.3-fpm'],
      serviceUnits: ['nginx.service', 'php8.3-fpm.service']
    }
  })

  assert.equal(context.identity.id, 'ubuntu')
  assert.equal(context.identity.codename, 'noble')
  assert.equal(context.management.packageManager, 'apt')
  assert.equal(context.management.serviceManager, 'systemd')
  assert.deepEqual(context.stack.availableCommands, ['apt', 'systemctl', 'nginx'])
  assert.deepEqual(context.stack.installedPackages, ['nginx', 'php8.3-fpm'])
  assert.deepEqual(context.management.availableServiceUnits, ['nginx.service', 'php8.3-fpm.service'])
  assert.ok(context.stack.candidatePackages.includes('php-fpm'))
  assert.equal(context.version, 3)
  assert.equal(context.stackProfiles.profiles.nginx.status, 'ready')
  assert.equal(context.stackProfiles.profiles['php-fpm'].service, 'php8.3-fpm.service')
  assert.equal(context.applications.wordpress.phpFpmRuntimeDirectory, '/run/webminai-wordpress-18101')
  assert.equal(context.applications.wordpress.phpFpmListener, '/run/webminai-wordpress-18101/php-fpm.sock')
  assert.equal(context.applications.wordpress.artifactDirectory, '/var/lib/webminai/webminai-wordpress-18101')
  assert.equal(context.applications.wordpress.wpCliPhar, '/var/lib/webminai/webminai-wordpress-18101/wp-cli.phar')
  assert.equal(context.applications.wordpress.databaseHost, 'localhost')
  assert.equal(context.applications.wordpress.nginxFastcgiPass, 'unix:/run/webminai-wordpress-18101/php-fpm.sock')
  assert.ok(context.applications.wordpress.nginxRequiredFastcgiParams.includes('HTTP_HOST $http_host'))
  assert.equal(context.applications.wordpress.phpFpmService, 'php8.3-fpm.service')
  assert.equal(context.applications.wordpress.phpFpmPool, '/etc/php/8.3/fpm/pool.d/webminai-wordpress-18101.conf')
  assert.match(context.applications.wordpress.primaryAddressCommand, /ip -o -4 addr show scope global/)
  assert.ok(context.applications.wordpress.packages.includes('php-intl'))
  assert.equal(context.officialSources.release.status, 'online')
  assert.equal(context.officialSources.release.versionMentioned, true)
  assert.equal(requests[0].url, 'https://releases.ubuntu.com/24.04/')
  assert.equal(requests[0].options.method, 'GET')
})

test('Linux host context reuses a matching daily online profile while refreshing local execution facts', async () => {
  let fetches = 0
  const buildAt = time => new LinuxHostContextService({
    fetchImpl: async () => {
      fetches++
      return new Response('Debian 13', { status: 200 })
    },
    now: () => new Date(time)
  })
  const input = {
    inventory: { info: { agents: [{ application: { os: 'linux' } }] } },
    execution: {
      platform: 'linux',
      architecture: 'amd64',
      kernel: '6.12',
      init: 'systemd',
      osRelease: { ID: 'debian', VERSION_ID: '13', VERSION_CODENAME: 'trixie' },
      commands: { apt: true, systemctl: true }
    }
  }
  const first = await buildAt('2026-08-07T10:00:00.000Z').build(input)
  const second = await buildAt('2026-08-07T11:00:00.000Z').build({
    ...input,
    execution: { ...input.execution, commands: { ...input.execution.commands, nginx: true } },
    previous: first
  })
  assert.equal(fetches, 1)
  assert.equal(second.cache.reused, true)
  assert.equal(second.execution.commands.nginx, true)
  assert.ok(second.stack.availableCommands.includes('nginx'))
  assert.equal(second.applications.wordpress.phpFpmService, 'php8.4-fpm.service')
  assert.equal(second.refreshedAt, first.refreshedAt)
  assert.equal(second.observedAt, '2026-08-07T11:00:00.000Z')
})

test('Linux execution inventory safely decodes os-release and command availability', () => {
  const osRelease = Buffer.from('ID=alpine\nVERSION_ID="3.23.1"\nPRETTY_NAME="Alpine Linux v3.23"\n').toString('base64')
  assert.deepEqual(parseLinuxExecutionInventory([
    `osReleaseBase64=${osRelease}`,
    'architecture=x86_64',
    'kernel=6.12.0',
    'init=init',
    'command_apk=yes',
    'command_rc_service=yes',
    'command_systemctl=no',
    'command_ip=yes',
    `installedPackagesBase64=${Buffer.from('nginx\nphp83-fpm\n').toString('base64')}`,
    `serviceUnitsBase64=${Buffer.from('nginx\nphp-fpm83\n').toString('base64')}`,
    `version_nginx=${Buffer.from('nginx version: nginx/1.28.0').toString('base64')}`
  ].join('\n')), {
    platform: 'linux',
    architecture: 'x86_64',
    kernel: '6.12.0',
    init: 'init',
    osRelease: { ID: 'alpine', VERSION_ID: '3.23.1', PRETTY_NAME: 'Alpine Linux v3.23' },
    commands: { apk: true, 'rc-service': true, systemctl: false, ip: true },
    versions: { nginx: 'nginx version: nginx/1.28.0' },
    installedPackages: ['nginx', 'php83-fpm'],
    serviceUnits: ['nginx', 'php-fpm83']
  })
})

test('Ubuntu WordPress profile follows the release PHP-FPM version', async () => {
  const service = new LinuxHostContextService({ fetchImpl: async () => new Response('Ubuntu release') })
  const build = versionId => service.build({
    inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
    execution: {
      platform: 'linux',
      architecture: 'amd64',
      kernel: '6.8',
      init: 'systemd',
      osRelease: { ID: 'ubuntu', VERSION_ID: versionId, VERSION_CODENAME: 'test' },
      commands: { apt: true, systemctl: true }
    }
  })
  assert.equal((await build('22.04')).applications.wordpress.phpFpmService, 'php8.1-fpm.service')
  assert.equal((await build('24.04')).applications.wordpress.phpFpmService, 'php8.3-fpm.service')
  assert.equal((await build('26.04')).applications.wordpress.phpFpmService, 'php8.5-fpm.service')
})

test('openSUSE WordPress profile includes the split CLI package and real binary path', async () => {
  const service = new LinuxHostContextService({
    fetchImpl: async () => new Response('openSUSE Leap 16.0', { status: 200 }),
    now: () => new Date('2026-08-08T00:00:00.000Z')
  })
  const context = await service.build({
    inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
    execution: {
      platform: 'linux',
      architecture: 'x86_64',
      kernel: '6.12',
      init: 'systemd',
      osRelease: { ID: 'opensuse-leap', VERSION_ID: '16.0' },
      commands: { zypper: true, systemctl: true }
    }
  })
  assert.equal(context.applications.wordpress.phpBinary, '/usr/bin/php')
  assert.ok(context.applications.wordpress.packages.includes('php8-cli'))
  assert.ok(context.applications.wordpress.packages.includes('php8-intl'))
  assert.ok(context.applications.wordpress.packages.includes('php8-fileinfo'))
  assert.ok(context.applications.wordpress.packages.includes('php8-phar'))
  assert.ok(context.applications.wordpress.packages.includes('php8-openssl'))
  assert.ok(context.applications.wordpress.packages.includes('php8-tokenizer'))
})

test('Arch WordPress profile records the nginx include missing from package defaults', async () => {
  const service = new LinuxHostContextService({
    fetchImpl: async () => new Response('Arch Linux', { status: 200 }),
    now: () => new Date('2026-08-08T00:00:00.000Z')
  })
  const context = await service.build({
    inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
    execution: {
      platform: 'linux',
      architecture: 'x86_64',
      kernel: '7.0',
      init: 'systemd',
      osRelease: { ID: 'arch' },
      commands: { pacman: true, systemctl: true }
    }
  })
  assert.equal(context.applications.wordpress.nginxMainConfig, '/etc/nginx/nginx.conf')
  assert.equal(context.applications.wordpress.nginxIncludeDirective, 'include conf.d/*.conf;')
  assert.equal(context.applications.wordpress.nginxIncludeRequired, true)
  assert.ok(context.applications.wordpress.phpExtensionsToEnable.includes('iconv'))
})
