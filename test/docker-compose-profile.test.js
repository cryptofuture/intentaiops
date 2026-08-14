import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { buildDockerComposeProfilePlan } from '../src/docker-compose-profile.js'
import { validateCommandPlan } from '../src/plan-validator.js'

test('reviewed Docker profile has idempotent baseline, official apt setup, and exact rollback', () => {
  const plan = buildDockerComposeProfilePlan({
    taskId: 4,
    linuxContext: { identity: { id: 'ubuntu', versionId: '24.04' }, management: { packageManager: 'apt' } },
    docker: { preferred: true, ready: false, installMethod: 'official-apt' }
  })
  validateCommandPlan(plan, { executionIdentity: 'root' })
  assert.match(plan.commands[0].command, /if \[ ! -s .*baseline\.sha256/u)
  assert.match(plan.commands[1].command, /download\.docker\.com/u)
  assert.match(plan.commands[1].command, /docker-compose-plugin/u)
  assert.match(plan.revertCommands[1].command, /Docker package baseline drift/u)
  assert.equal(plan.commands.every(item => item.phase), true)
  for (const item of [...plan.commands, ...plan.revertCommands]) {
    const syntax = spawnSync('bash', ['-n'], { input: item.command, encoding: 'utf8' })
    assert.equal(syntax.status, 0, `${item.id}: ${syntax.stderr}`)
  }
})
