import assert from 'node:assert/strict'
import test from 'node:test'
import {
  detectPlannerPlatform,
  validateDockerAndSecrets,
  validateNetdataFunctions,
  validatePortablePlan,
  validateWindowsPlan
} from '../src/planner-platform-policy.js'

function planWith (command, overrides = {}) {
  return {
    modifiedFiles: [],
    commands: [{
      id: 'command',
      command,
      purpose: 'Exercise deterministic policy',
      risk: 'read',
      timeoutMs: 5000,
      requiresSudo: false,
      dependsOn: []
    }],
    revertCommands: [],
    ...overrides
  }
}

test('planner platform detection preserves inventory precedence and unknown fallback', () => {
  assert.equal(detectPlannerPlatform({ os: 'linux', platform: { os: 'Windows_NT' } }), 'windows')
  assert.equal(detectPlannerPlatform({ info: { agents: [{ application: { kernel: 'FreeBSD 15.1' } }] } }), 'freebsd')
  assert.equal(detectPlannerPlatform({ os: 'plan9' }), 'unknown')
})

test('portable policy rejects placeholders before platform-specific planning', () => {
  assert.throws(
    () => validatePortablePlan(planWith('install -d /var/lib/webminai/task-state/$' + '{TASK_ID}')),
    /unresolved task ID placeholder/u
  )
})

test('Windows policy uses execution inventory for LocalSystem package tools', () => {
  const plan = planWith('choco.exe install brave -y', { modifiedFiles: ['C:\\ProgramData\\WebminAI\\state.json'] })
  assert.throws(
    () => validateWindowsPlan(plan, { webminaiExecution: { commands: { chocolatey: false } } }, 'install a package'),
    /Chocolatey but it is unavailable/u
  )
  assert.doesNotThrow(() => validateWindowsPlan(plan, { webminaiExecution: { commands: { chocolatey: true } } }, 'install a package'))
})

test('Docker credential policy and Netdata function policy remain independent', () => {
  assert.throws(
    () => validateDockerAndSecrets(planWith('docker run example/service'), { webminaiDocker: { preferred: true } }),
    /Docker Compose instead of docker run/u
  )
  const netdataPlan = planWith("curl 'http://127.0.0.1:19999/api/v3/function?function=webminai%3Ahealth'")
  assert.doesNotThrow(() => validateNetdataFunctions(netdataPlan, {
    functions: { functions: [{ name: 'webminai:health' }] }
  }))
})
