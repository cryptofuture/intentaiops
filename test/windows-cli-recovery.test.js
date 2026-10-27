import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCommonTask } from '../src/common-tasks.js'
import { commonTaskRecoveryManifest, commonTaskRecoverySupported, regenerateCommonTaskRecovery } from '../src/remote-common-task-recovery.js'
import { recoveryRecord } from '../src/remote-recovery-record.js'
import { planFingerprint } from '../src/execution-journal.js'
import { recoveryBaselineCommand, inspectRecoveryBaseline } from '../src/remote-recovery-baseline.js'

test('Windows CLI recovery reconstructs only the signed completed catalog and guards its baseline', async () => {
  const options = { platform: 'windows' }
  const plan = buildCommonTask('intent-ai-ops-windows', 84, options).plan
  const manifest = { ...commonTaskRecoveryManifest({ catalogId: 'intent-ai-ops-windows', taskId: 84, target: 'SHA256:' + 'a'.repeat(64), options, plan }), executionId: 'b'.repeat(32) }
  const records = plan.commands.map((command, index) => recoveryRecord(manifest, { type: 'command_completed', commandId: command.id, commandDigest: planFingerprint(command), attemptId: '11111111-1111-4111-8111-111111111111' }, { sequence: index + 1, previousHash: index ? 'a'.repeat(64) : null, baselineDigest: 'd'.repeat(64) }))
  const input = { records, head: 'e'.repeat(64), options, baselineDigest: 'd'.repeat(64) }
  assert.equal(commonTaskRecoverySupported('intent-ai-ops-windows', 'windows'), true)
  assert.equal(commonTaskRecoverySupported('magento-windows', 'windows'), false)
  const recovered = regenerateCommonTaskRecovery(input)
  assert.equal(recovered.plan.commands.length, 1)
  assert.ok(recovered.plan.commands[0].command.endsWith(plan.revertCommands[0].command))
  assert.match(recovered.plan.commands[0].command, /RECOVERY_BASELINE_CHANGED/u)
  assert.doesNotMatch(recovered.plan.commands[0].command, /set -eu|sh -c/u)
  for (const field of ['catalogDigest', 'rollbackDigest', 'revision']) assert.throws(() => regenerateCommonTaskRecovery({ ...input, records: records.map(record => ({ ...record, [field]: 'f'.repeat(64) })) }), /catalog/u)
  assert.throws(() => regenerateCommonTaskRecovery({ ...input, baselineDigest: 'f'.repeat(64) }), /baseline/u)
  assert.throws(() => regenerateCommonTaskRecovery({ ...input, records: records.map(record => ({ ...record, baselineDigest: null })) }), /baseline/u)
  assert.throws(() => regenerateCommonTaskRecovery({ ...input, records: records.slice(0, 1) }), /Partial|uncertain/u)
  assert.throws(() => regenerateCommonTaskRecovery({ ...input, records: records.map(record => ({ ...record, operation: 'rollback' })) }), /already started/u)
  assert.throws(() => regenerateCommonTaskRecovery({ ...input, options: { platform: 'linux' } }), /platform/u)
  const command = recoveryBaselineCommand('intent-ai-ops-windows', 84)
  for (const required of ['LocalSystem', 'ReparsePoint', 'Links!=1', 'GetAccessRules', 'paths-before.json', 'Get-FileHash', '45', '60000']) assert.ok(command.includes(required))
  await inspectRecoveryBaseline({
    runCommand: async (received, options) => {
      assert.equal(received, command)
      assert.equal(options.timeoutSeconds, 60)
      return { exitCode: 0, stdout: 'd'.repeat(64) }
    }
  }, 'intent-ai-ops-windows', 84)
})
