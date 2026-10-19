import { randomUUID } from 'node:crypto'
import { buildCommonTask } from './common-tasks.js'
import { planFingerprint } from './execution-journal.js'
import { recoveryRecord, verifyRecoveryChain } from './remote-recovery-record.js'
import { guardRecoveryBaseline } from './remote-recovery-baseline.js'

const RECOVERY_PROFILES = new Set(['systemd-service', 'systemd-timer', 'intent-ai-ops-linux'])

export function commonTaskRecoverySupported (catalogId, platform) {
  return platform === 'linux' && RECOVERY_PROFILES.has(catalogId)
}

export function commonTaskRecoveryManifest ({ catalogId, taskId, target, options, plan }) {
  const trusted = buildCommonTask(catalogId, taskId, options).plan
  if (commonTaskTemplateDigest(trusted) !== commonTaskTemplateDigest(plan)) throw new Error('Common-task recovery requires an unchanged trusted catalog plan')
  return {
    target,
    identityMethod: options.platform === 'kubernetes' ? 'kubernetes-cluster-uid-v1' : 'ssh-host-fingerprint-v1',
    platform: options.platform ?? 'linux',
    catalogId,
    taskId,
    catalogDigest: commonTaskTemplateDigest(trusted),
    planDigest: planFingerprint(plan),
    rollbackDigest: planFingerprint(trusted.revertCommands),
    revision: planFingerprint(plan)
  }
}

export class RemoteCommonTaskJournal {
  constructor ({ transport, state, target, taskId, plan }) {
    this.transport = transport
    this.state = state
    this.target = target
    this.taskId = taskId
    this.plan = plan
    this.claimed = false
  }

  async append (event, { operation = 'deployment', baselineDigest = null } = {}) {
    const saved = this.state.get(this.target, this.taskId)
    if (!saved) throw new Error('Common-task recovery registration is missing')
    if (!this.trust) {
      const key = await this.transport.key({ initialize: true })
      this.trust = this.state.pin(this.target, key)
    }
    const { manifest, owner, sequence, head } = saved
    if (!this.claimed) {
      await this.transport.claim({ executionId: manifest.executionId, taskId: manifest.taskId, owner, sequence, head })
      this.claimed = true
    }
    const command = (operation === 'rollback' ? this.plan.revertCommands : this.plan.commands).find(item => item.id === event.commandId)
    if (event.commandId && !command) throw new Error('Remote recovery event references an unknown command')
    const record = recoveryRecord({ ...manifest, revision: planFingerprint(this.plan) }, { ...event, commandDigest: command ? planFingerprint(command) : null }, { sequence: sequence + 1, previousHash: head, operation, baselineDigest })
    const envelope = await this.transport.append(record, { owner, trust: this.trust })
    this.state.advance(this.target, this.taskId, sequence, head, envelope)
    return record
  }

  async release () {
    if (!this.claimed) return
    const saved = this.state.get(this.target, this.taskId)
    await this.transport.release({ executionId: saved.manifest.executionId, owner: saved.owner, sequence: saved.sequence, head: saved.head })
    this.claimed = false
  }
}

export async function retrieveRecoveryExecution ({ transport, state, target, executionId, maximumRecords = 1000, timeoutMs = 30000 }) {
  if (!/^[a-f0-9]{32}$/u.test(executionId) || !Number.isInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 1000) throw new Error('Invalid recovery retrieval limit or execution identity')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid recovery retrieval deadline')
  const deadline = Date.now() + timeoutMs
  const key = await transport.key()
  if (!key) throw new Error('No signed remote recovery records are available')
  const trust = state.pin(target, key)
  const page = await transport.list()
  if (!Array.isArray(page.executions)) throw new Error('Invalid recovery listing')
  let entries = page.executions
  let current = entries.find(item => item.executionId === executionId)
  let pages = 1
  while (!current && entries.length === 10 && pages++ < 100) {
    if (Date.now() >= deadline) throw new Error('Remote recovery retrieval deadline exceeded')
    const cursor = entries.at(-1)?.executionId
    if (!/^[a-f0-9]{32}$/u.test(cursor)) throw new Error('Invalid remote recovery cursor')
    entries = (await transport.list(cursor)).executions
    if (!Array.isArray(entries)) throw new Error('Invalid recovery listing')
    current = entries.find(item => item.executionId === executionId)
  }
  if (!current || !Number.isSafeInteger(current.sequence) || current.sequence < 1 || current.sequence > maximumRecords || !/^[a-f0-9]{64}$/u.test(current.head)) throw new Error('Recovery history is missing or exceeds retrieval limit')
  const checkpoint = state.checkpoint(target, executionId)
  if (checkpoint && (checkpoint.sequence > current.sequence || (checkpoint.sequence === current.sequence && checkpoint.head !== current.head))) throw new Error('Remote recovery history is older than or conflicts with the local checkpoint')
  let verified = { records: [], sequence: 0, head: null }
  for (let sequence = 1; sequence <= current.sequence; sequence++) {
    if (Date.now() >= deadline) throw new Error('Remote recovery retrieval deadline exceeded')
    const envelope = await transport.read(executionId, sequence)
    let verificationTrust = trust
    if (envelope.keyFingerprint !== trust.pinnedFingerprint) {
      verificationTrust = state.trustedKey(target, envelope.keyFingerprint)
      if (!verificationTrust) verificationTrust = state.rememberHistoricalKey(target, await transport.historicalKey(envelope.keyFingerprint), trust.pinnedFingerprint)
    }
    const result = verifyRecoveryChain([envelope], verificationTrust, verified)
    if (checkpoint?.sequence === sequence && checkpoint.head !== result.head) throw new Error('Remote recovery history forks from the local checkpoint')
    if (result.records[0].executionId !== executionId) throw new Error('Recovery execution identity mismatch')
    if (verified.records.length && ['catalogId', 'taskId', 'catalogDigest', 'planDigest', 'rollbackDigest', 'platform', 'identityMethod'].some(field => verified.records[0][field] !== result.records[0][field])) throw new Error('Recovery definition changed within execution')
    verified = { ...result, records: [...verified.records, ...result.records] }
  }
  if (verified.head !== current.head) throw new Error('Recovery head changed during retrieval')
  return verified
}

export function regenerateCommonTaskRecovery ({ records, head, options, baselineDigest, recoveryId = randomUUID() }) {
  if (!Array.isArray(records) || records.length === 0) throw new Error('Verified recovery history is required')
  const original = records[0]
  if (!commonTaskRecoverySupported(original.catalogId, original.platform)) throw new Error('Common-task baseline validation is not registered for this task family')
  if (original.catalogId === 'intent-ai-ops-linux' && options.linuxContext?.identity?.id === 'alpine') throw new Error('Verified CLI recovery does not yet authorize Alpine package removal')
  if (original.platform !== (options.platform ?? 'linux') || original.platform !== 'linux') throw new Error('Recovery platform does not match the audited task profile')
  const built = buildCommonTask(original.catalogId, original.taskId, options)
  if (commonTaskTemplateDigest(built.plan) !== original.catalogDigest || planFingerprint(built.plan.revertCommands) !== original.rollbackDigest || records.some(record => record.revision !== original.planDigest || record.event === 'plan_revised')) throw new Error('Installed catalog cannot reproduce the signed task definition')
  if (records.some(record => record.operation !== 'deployment')) throw new Error('Recovery or rollback has already started; inspect and reconcile that operation')
  const last = new Map()
  for (const record of records) {
    if (!record.commandId) continue
    const command = built.plan.commands.find(item => item.id === record.commandId)
    if (!command || record.commandDigest !== planFingerprint(command)) throw new Error('Signed command does not match the trusted common task')
    if (record.event.startsWith('command_')) last.set(record.commandId, record)
  }
  if (built.plan.commands.some(command => last.get(command.id)?.event !== 'command_completed')) throw new Error('Partial or uncertain task requires separately reviewed investigation, not automatic catalog rollback')
  const confirmed = records.findLast(record => record.event === 'command_completed')
  if (!confirmed?.baselineDigest || confirmed.baselineDigest !== baselineDigest) throw new Error('Recovery baseline is missing or modified')
  if (!/^[a-f0-9]{64}$/u.test(head)) throw new Error('Verified recovery head is required')
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(recoveryId)) throw new Error('Invalid recovery plan identity')
  return {
    recoveryId,
    sourceExecutionId: original.executionId,
    expectedHead: head,
    baselineDigest,
    plan: {
      ...built.plan,
      summary: `Recover ${original.catalogId} (${recoveryId})`,
      changeOverview: 'Remove only the verified task-owned changes after fresh baseline inspection.',
      warnings: [...built.plan.warnings, 'Remote history is evidence, not approval. Review this newly generated recovery plan.'],
      commands: built.plan.revertCommands.map(command => guardRecoveryBaseline(command, original.catalogId, original.taskId, baselineDigest)),
      revertCommands: []
    }
  }
}

function commonTaskTemplateDigest (plan) {
  return planFingerprint({ commands: plan.commands, revertCommands: plan.revertCommands, modifiedFiles: plan.modifiedFiles, requiresConfirmation: plan.requiresConfirmation })
}
