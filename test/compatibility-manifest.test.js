import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveCompatibilityManifest } from '../src/compatibility-manifest.js'
import { buildLinuxStackProfiles } from '../src/linux-stack-profiles.js'

const identity = { platform: 'linux', id: 'ubuntu', versionId: '24.04', architecture: 'x86_64' }
const management = { family: 'debian' }

test('compatibility resolution prefers an explicit resolved Compose row', () => {
  const stackProfiles = buildLinuxStackProfiles({
    identity,
    management,
    execution: { commands: { docker: true } },
    docker: { cliAvailable: true, daemonReachable: true, composeAvailable: true, installSupported: true }
  })
  const manifest = resolveCompatibilityManifest({
    application: { id: 'example', version: '2.0' },
    specification: specification(),
    linuxContext: { fingerprint: 'ubuntu:24.04:x86_64', identity, management, stackProfiles },
    dockerPolicy: { preferred: true },
    repositoryVersions: { compose: '2.29' },
    now: () => new Date('2026-08-08T00:00:00Z')
  })
  assert.equal(manifest.status, 'resolved')
  assert.equal(manifest.selectedRoute.id, 'compose')
  assert.equal(manifest.selectedRoute.components[0].source, 'repository')
})

test('compatibility resolution requests repository preflight instead of guessing a native version', () => {
  const stackProfiles = buildLinuxStackProfiles({ identity, management, execution: { commands: {} }, docker: {} })
  const manifest = resolveCompatibilityManifest({
    application: { id: 'example', version: '2.0' },
    specification: specification(),
    linuxContext: { fingerprint: 'ubuntu:24.04:x86_64', identity, management, stackProfiles },
    dockerPolicy: { preferred: false }
  })
  assert.equal(manifest.status, 'requires-preflight')
  assert.equal(manifest.selectedRoute.id, 'native')
  assert.match(manifest.reason, /repository version preflight/u)
})

function specification () {
  return {
    version: 1,
    routes: [
      { id: 'compose', kind: 'compose', priority: 0, applicationVersions: ['2.0'], architectures: ['x86_64'], profiles: ['compose'], components: { compose: { allowedVersions: ['2.29'] } } },
      { id: 'native', kind: 'native', priority: 1, applicationVersions: ['2.0'], architectures: [], profiles: ['nginx', 'nodejs'], components: { nginx: { allowedVersions: ['1.24', '1.26'] }, nodejs: { allowedVersions: ['22', '24'] } } }
    ]
  }
}
