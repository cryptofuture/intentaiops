import assert from 'node:assert/strict'
import test from 'node:test'
import { deploymentBlueprint, validateApplicationDeltaPlan } from '../src/application-delta.js'

test('application delta permits initialization but rejects foundation-owned work', () => {
  const plan = {
    commands: [{ id: 'init', phase: 'initialize', command: '/opt/example/bin/app initialize --password-file /root/example_credentials/database_password' }],
    revertCommands: [{ id: 'cleanup', phase: 'cleanup', command: 'rm -rf -- /opt/example/app-state' }]
  }
  assert.equal(validateApplicationDeltaPlan(plan), plan)
  assert.throws(() => validateApplicationDeltaPlan({ ...plan, commands: [{ id: 'packages', phase: 'packages', command: 'apt-get install example' }] }), /foundation-owned phase/u)
  assert.throws(() => validateApplicationDeltaPlan({ ...plan, commands: [{ id: 'service', phase: 'initialize', command: 'systemctl start example' }] }), /foundation-owned package/u)
})

test('application delta blueprint minimizes a resolved compatibility manifest', () => {
  const blueprint = deploymentBlueprint({
    manifest: {
      status: 'resolved',
      application: { id: 'example', version: '1.0' },
      selectedRoute: { id: 'native', kind: 'native', components: [{ profileId: 'nodejs', selectedVersion: '24' }] }
    },
    foundationPhases: ['baseline', 'packages', 'secrets', 'services', 'health'],
    foundationPaths: ['/root/example_credentials/database_password']
  })
  assert.equal(blueprint.compatibility.route, 'native')
  assert.deepEqual(blueprint.allowedForwardPhases, ['configure', 'initialize', 'verify'])
  assert.equal(JSON.stringify(blueprint).includes('ssh://'), false)
})
