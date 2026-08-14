import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLinuxStackProfiles, stackProfileIds, validateLinuxStackProfiles } from '../src/linux-stack-profiles.js'

test('typed stack profiles expose reviewed Ubuntu and Docker execution facts', () => {
  const value = buildLinuxStackProfiles({
    identity: { platform: 'linux', id: 'ubuntu', versionId: '24.04', architecture: 'x86_64' },
    management: { family: 'debian' },
    execution: {
      commands: { nginx: true, php: true, 'php-fpm': true, docker: true },
      versions: { nginx: 'nginx/1.24.0', php: 'PHP 8.3.10' },
      installedPackages: ['nginx', 'php8.3-fpm'],
      serviceUnits: ['nginx.service', 'php8.3-fpm.service']
    },
    docker: { cliAvailable: true, daemonReachable: true, composeAvailable: true, installSupported: true, installMethod: 'official-apt' }
  })
  assert.deepEqual(Object.keys(value.profiles), stackProfileIds())
  assert.equal(value.profiles.nginx.status, 'ready')
  assert.equal(value.profiles.nginx.version, '1.24.0')
  assert.equal(value.profiles['php-fpm'].capabilities.serviceUser, 'www-data')
  assert.equal(value.profiles.nodejs.capabilities.upstreamRepository.provider, 'nodesource')
  assert.equal(value.profiles.nodejs.capabilities.upstreamRepository.supported, true)
  assert.deepEqual(value.profiles.nodejs.capabilities.upstreamRepository.majorVersions, ['22', '24'])
  assert.equal(value.profiles.compose.status, 'ready')
  assert.equal(validateLinuxStackProfiles(value), value)
})

test('Compose is blocked for an unprepared container host', () => {
  const value = buildLinuxStackProfiles({
    identity: { platform: 'linux', id: 'alpine', versionId: '3.23', architecture: 'x86_64' },
    management: { family: 'alpine' },
    execution: { commands: {} },
    docker: { hostIsContainer: true, containerRuntime: 'lxc', installSupported: false }
  })
  assert.equal(value.profiles.compose.status, 'blocked')
  assert.match(value.profiles.compose.reason, /lxc/u)
  assert.deepEqual(value.profiles.postgresql.packages, ['postgresql18', 'postgresql18-client'])
  assert.equal(value.profiles.nodejs.capabilities.upstreamRepository.supported, false)
})

test('Fedora profile uses its versioned Node.js packages and PHP common curl module', () => {
  const value = buildLinuxStackProfiles({
    identity: { platform: 'linux', id: 'fedora', versionId: '44', architecture: 'x86_64' },
    management: { family: 'rpm' },
    execution: { commands: {} },
    docker: {}
  })
  assert.deepEqual(value.profiles.nodejs.packages, ['nodejs24', 'nodejs24-npm'])
  assert.equal(value.profiles.nodejs.capabilities.upstreamRepository.distributionClass, 'rpm')
  assert.equal(value.profiles['php-fpm'].packages.includes('php-curl'), false)
})

test('openSUSE Leap 16 profile uses versioned Python tooling and Composer 2 packages', () => {
  const value = buildLinuxStackProfiles({
    identity: { platform: 'linux', id: 'opensuse-leap', versionId: '16.0', architecture: 'x86_64' },
    management: { family: 'suse' },
    execution: { commands: {} },
    docker: {}
  })
  assert.deepEqual(value.profiles.python.packages, ['python3', 'python313-pip', 'python313-virtualenv'])
  assert.deepEqual(value.profiles.composer.packages, ['php-composer2'])
  assert.ok(value.profiles['php-fpm'].packages.includes('php8-openssl'))
  assert.ok(value.profiles['php-fpm'].packages.includes('php8-tokenizer'))
})

test('Oracle Linux Composer uses a verified upstream route when repositories lack a package', () => {
  const value = buildLinuxStackProfiles({
    identity: { platform: 'linux', id: 'ol', versionId: '9', architecture: 'x86_64' },
    management: { family: 'rpm' },
    execution: { commands: {} },
    docker: {}
  })
  assert.deepEqual(value.profiles.composer.packages, [])
  assert.equal(value.profiles.composer.capabilities.installation, 'verified-upstream-installer')
  assert.equal(value.profiles.composer.status, 'installable')
})
