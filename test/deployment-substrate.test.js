import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildValidationStages } from '../src/canary-scheduler.js'
import { buildBaselineCommands, buildPackagePhase, buildSafeDiagnosticCommand, buildSecretPhase, composeDeploymentPlan } from '../src/deployment-phases.js'
import { DeploymentScorecard } from '../src/deployment-scorecard.js'
import { evaluatePromotionEvidence } from '../src/promotion-policy.js'

test('reviewed deployment phases keep application-specific commands out of foundation responsibilities', () => {
  const foundation = [
    ...buildBaselineCommands({ taskId: 7, applicationId: 'demo', packageManager: 'apt' }),
    ...buildPackagePhase({ taskId: 7, applicationId: 'demo', packageManager: 'apt', packages: ['nginx', 'python3'] }),
    ...buildSecretPhase({ taskId: 7, applicationId: 'demo' })
  ]
  const plan = composeDeploymentPlan({
    foundation,
    applicationCommands: [{ id: 'initialize-demo', phase: 'initialize', command: 'true', purpose: 'Initialize only the application.', risk: 'change', timeoutMs: 1000, requiresSudo: true, dependsOn: ['generate-host-credentials'] }],
    revertCommands: [{ id: 'remove-demo', command: 'true', purpose: 'Remove task state.', risk: 'destructive', timeoutMs: 1000, requiresSudo: true, dependsOn: [] }],
    summary: 'Install demo',
    changeOverview: 'Uses reviewed foundation phases.'
  })
  assert.deepEqual(plan.commands.map(item => item.phase), ['baseline', 'packages', 'packages', 'secrets', 'initialize'])
  assert.match(plan.commands[3].purpose, /only \/root\/demo_credentials\/database_password/u)
  assert.throws(() => composeDeploymentPlan({ ...plan, foundation: [], applicationCommands: [{ ...plan.commands[4], phase: 'packages' }] }), /cannot replace/u)
})

test('safe diagnostics permit loopback but reject external HTTP and shell metacharacters', () => {
  assert.match(buildSafeDiagnosticCommand({ kind: 'http', target: 'http://127.0.0.1:8080/health' }), /curl/u)
  assert.throws(() => buildSafeDiagnosticCommand({ kind: 'http', target: 'https://example.com/' }), /loopback/u)
  assert.throws(() => buildSafeDiagnosticCommand({ kind: 'service', target: 'nginx;id' }), /invalid/u)
})

test('scorecards persist phase outcomes and canary scheduling prioritizes unresolved information', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'webminai-scorecard-'))
  try {
    const scorecard = new DeploymentScorecard(root)
    scorecard.record({ runId: 1, taskId: 1, serverId: 'ubuntu', applicationId: 'demo', stackId: 'native', distroFamily: 'debian', phase: 'packages', outcome: 'failed', durationMs: 40, failureCode: 'PACKAGE_NOT_FOUND', firstPass: true })
    scorecard.record({ runId: 2, taskId: 2, serverId: 'ubuntu', applicationId: 'demo', stackId: 'native', distroFamily: 'debian', phase: 'packages', outcome: 'completed', durationMs: 30, firstPass: false })
    const summary = scorecard.summary({ applicationId: 'demo' })[0]
    assert.equal(summary.attempts, 2)
    assert.equal(summary.failures, 1)
    assert.equal(summary.firstPassSuccesses, 0)
    const stages = buildValidationStages({
      applicationId: 'demo',
      scorecard,
      hosts: [
        { serverId: 'debian', family: 'debian' },
        { serverId: 'ubuntu', family: 'debian' },
        { serverId: 'alpine', family: 'alpine' },
        { serverId: 'rocky', family: 'rpm' }
      ]
    })
    assert.equal(stages[0].hosts[0].serverId, 'ubuntu')
    assert.deepEqual(stages.flatMap(stage => stage.hosts).map(host => host.serverId).sort(), ['alpine', 'debian', 'rocky', 'ubuntu'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('promotion requires two idempotent applies, restart recovery, two reverts, and an exact baseline', () => {
  const fingerprint = 'a'.repeat(64)
  const evidence = {
    apply1: { status: 'completed', changed: true },
    apply2: { status: 'completed', changed: false },
    restartRecovery: { status: 'completed' },
    revert1: { status: 'completed', changed: true },
    revert2: { status: 'completed', changed: false },
    baselineFingerprint: fingerprint,
    finalFingerprint: fingerprint
  }
  assert.equal(evaluatePromotionEvidence(evidence).promoted, true)
  assert.deepEqual(evaluatePromotionEvidence({ ...evidence, apply2: { status: 'completed', changed: true } }).failures, ['second apply was not idempotent'])
})
