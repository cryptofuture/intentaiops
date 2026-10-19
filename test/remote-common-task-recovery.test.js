import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildCommonTask } from '../src/common-tasks.js'
import { AdminService } from '../src/admin-service.js'
import { rootExecutionPolicy } from '../src/execution-policy.js'
import { planFingerprint } from '../src/execution-journal.js'
import { RemoteRecoveryState } from '../src/remote-recovery-state.js'
import { RemoteRecoveryTransport, recoveryStorageCommand } from '../src/remote-recovery-transport.js'
import { commonTaskRecoveryManifest, regenerateCommonTaskRecovery, RemoteCommonTaskJournal, retrieveRecoveryExecution } from '../src/remote-common-task-recovery.js'
import { recoveryKeyFingerprint, recoveryRecord, signRecoveryRecord, verifyRecoveryKeyRotation } from '../src/remote-recovery-record.js'
import { recoveryBaselineCommand, inspectRecoveryBaseline } from '../src/remote-recovery-baseline.js'

const target = 'SHA256:' + 'a'.repeat(64)
const options = { platform: 'linux' }

test('public-key pins are automatic, persistent and cannot be silently replaced', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-recovery-pins-'))
  try {
    const state = new RemoteRecoveryState(directory)
    const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const trust = { publicKey: key, fingerprint: recoveryKeyFingerprint(key) }
    assert.equal(state.pin(target, trust).pinnedFingerprint, trust.fingerprint)
    assert.equal(new RemoteRecoveryState(directory).pin(target, trust).pinnedFingerprint, trust.fingerprint)
    const substitute = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    assert.throws(() => state.pin(target, { publicKey: substitute, fingerprint: recoveryKeyFingerprint(substitute) }), /changed/u)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('real OpenSSL storage survives a fresh client, rejects racing owners and never exposes the private key', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-recovery-store-'))
  try {
    const client = shellClient(directory)
    const transport = new RemoteRecoveryTransport({ client, platform: 'linux' })
    assert.equal(await transport.key(), null)
    assert.equal(existsSync(path.join(directory, 'parent/recovery')), false)
    const key = await transport.key({ initialize: true })
    assert.doesNotMatch(JSON.stringify(key), /PRIVATE KEY/u)
    const original = buildCommonTask('systemd-service', 61, options).plan
    const manifest = commonTaskRecoveryManifest({ catalogId: 'systemd-service', taskId: 61, target, options, plan: original })
    const state = new RemoteRecoveryState(path.join(directory, 'client-a'))
    const registered = state.register(manifest)
    const journal = new RemoteCommonTaskJournal({ transport, state, target, taskId: 61, plan: original })
    const command = original.commands[0]
    await journal.append({ type: 'plan_approved', commandId: command.id })
    await journal.append({ type: 'command_completed', commandId: command.id }, { baselineDigest: 'd'.repeat(64) })
    const row = state.get(target, 61)
    const first = await transport.read(registered.executionId, 1)
    await assert.rejects(retrieveRecoveryExecution({ transport: { key: async () => key, list: async () => ({ executions: [{ executionId: registered.executionId, sequence: 1, head: planFingerprint(first) }] }), read () { assert.fail('known checkpoint rollback must reject before reading records') } }, state, target, executionId: registered.executionId }), /checkpoint/u)
    await assert.rejects(transport.claim({ executionId: registered.executionId, owner: 'f'.repeat(32), sequence: row.sequence, head: row.head, taskId: 61 }))
    await journal.release()
    const fresh = new RemoteRecoveryState(path.join(directory, 'client-b'))
    const verified = await retrieveRecoveryExecution({ transport, state: fresh, target, executionId: registered.executionId })
    assert.equal(verified.records.length, 2)
    const recovery = regenerateCommonTaskRecovery({ ...verified, options, baselineDigest: 'd'.repeat(64) })
    assert.equal(recovery.plan.commands.length, original.revertCommands.length)
    assert.match(recovery.plan.commands[0].command, /RECOVERY_BASELINE_CHANGED/u)
    assert.equal(recovery.plan.revertCommands.length, 0)
    await assert.rejects(transport.claim({ executionId: randomBytes(16).toString('hex'), owner: 'f'.repeat(32), sequence: 0, head: null, taskId: 61 }))
    const signing = path.join(directory, 'parent/recovery/signing.pem')
    chmodSync(signing, 0o644)
    await assert.rejects(transport.key())
    chmodSync(signing, 0o600)
    const displaced = path.join(directory, 'private-displaced')
    writeFileSync(displaced, readFileSync(signing))
    rmSync(signing)
    symlinkSync(displaced, signing)
    await assert.rejects(transport.key())
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('catalog mismatch, incomplete execution, changed baseline and unregistered task families block recovery', () => {
  const plan = buildCommonTask('systemd-service', 62, options).plan
  const manifest = { ...commonTaskRecoveryManifest({ catalogId: 'systemd-service', taskId: 62, target, options, plan }), executionId: 'b'.repeat(32) }
  const event = { type: 'command_completed', commandId: 'apply', commandDigest: planFingerprint(plan.commands[0]) }
  const record = recoveryRecord(manifest, event, { sequence: 1, baselineDigest: 'd'.repeat(64) })
  const input = { records: [record], head: 'e'.repeat(64), baselineDigest: 'd'.repeat(64), options }
  assert.ok(regenerateCommonTaskRecovery(input).plan)
  assert.throws(() => regenerateCommonTaskRecovery({ ...input, baselineDigest: 'f'.repeat(64) }), /baseline/u)
  assert.throws(() => regenerateCommonTaskRecovery({ ...input, records: [{ ...record, event: 'command_outcome_unknown' }] }), /uncertain/u)
  assert.throws(() => regenerateCommonTaskRecovery({ ...input, records: [{ ...record, revision: 'f'.repeat(64) }] }), /catalog/u)
  assert.throws(() => regenerateCommonTaskRecovery({ ...input, records: [{ ...record, catalogId: 'ghost-linux' }] }), /not registered/u)
  assert.throws(() => regenerateCommonTaskRecovery({ ...input, records: [{ ...record, operation: 'recovery' }] }), /already started/u)
  assert.throws(() => commonTaskRecoveryManifest({ catalogId: 'systemd-service', taskId: 62, target, options, plan: { ...plan, commands: [{ ...plan.commands[0], command: 'malicious' }] } }), /unchanged/u)
})

test('reviewed key rotation preserves historical verification and fresh-install retrieval without exposing private keys', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-recovery-rotation-'))
  try {
    const transport = new RemoteRecoveryTransport({ client: shellClient(directory), platform: 'linux' })
    const originalKey = await transport.key({ initialize: true })
    const state = new RemoteRecoveryState(path.join(directory, 'client'))
    state.pin(target, originalKey)
    const plan = buildCommonTask('systemd-service', 74, options).plan
    const manifest = state.register(commonTaskRecoveryManifest({ catalogId: 'systemd-service', taskId: 74, target, options, plan }))
    const journal = new RemoteCommonTaskJournal({ transport, state, target, taskId: 74, plan })
    await journal.append({ type: 'command_completed', commandId: plan.commands[0].id }, { baselineDigest: 'd'.repeat(64) })
    await assert.rejects(transport.rotateKey(originalKey.fingerprint, target), /failed/u)
    assert.equal((await transport.key()).fingerprint, originalKey.fingerprint)
    await journal.release()
    const replacement = await transport.rotateKey(originalKey.fingerprint, target)
    assert.notEqual(replacement.fingerprint, originalKey.fingerprint)
    assert.doesNotMatch(JSON.stringify(replacement), /PRIVATE KEY/u)
    assert.throws(() => state.pin(target, replacement), /changed/u)
    const trust = { target, publicKey: originalKey.publicKey, pinnedFingerprint: originalKey.fingerprint }
    assert.equal(verifyRecoveryKeyRotation(replacement.rotation, trust).fingerprint, replacement.fingerprint)
    assert.throws(() => verifyRecoveryKeyRotation(replacement.rotation, { ...trust, target: 'SHA256:' + 'f'.repeat(64) }), /invalid/u)
    assert.throws(() => verifyRecoveryKeyRotation({ ...replacement.rotation, signature: 'a'.repeat(96) }, trust), /verification/u)
    assert.throws(() => state.acceptKeyRotation(target, replacement, replacement.fingerprint), /Stale/u)
    assert.equal(state.acceptKeyRotation(target, replacement, originalKey.fingerprint).pinnedFingerprint, replacement.fingerprint)
    assert.equal(state.trustedKey(target, originalKey.fingerprint).publicKey, originalKey.publicKey)
    assert.throws(() => state.acceptKeyRotation(target, replacement, originalKey.fingerprint), /Stale/u)
    const continued = new RemoteCommonTaskJournal({ transport, state, target, taskId: 74, plan })
    await continued.append({ type: 'execution_paused' })
    await continued.release()
    assert.equal((await retrieveRecoveryExecution({ transport, state, target, executionId: manifest.executionId })).records.length, 2)
    const fresh = new RemoteRecoveryState(path.join(directory, 'fresh'))
    assert.equal((await retrieveRecoveryExecution({ transport, state: fresh, target, executionId: manifest.executionId })).records.length, 2)
    assert.equal(fresh.trustedKey(target, originalKey.fingerprint).publicKey, originalKey.publicKey)
    await assert.rejects(transport.rotateKey(originalKey.fingerprint, target), /failed/u)
    const published = await transport.key()
    assert.deepEqual(published, replacement)
    assert.equal(statSync(path.join(directory, 'parent/recovery/keys', originalKey.fingerprint + '.der')).mode & 0o777, 0o600)
    const interruptedClient = new RemoteRecoveryState(path.join(directory, 'interrupted'))
    interruptedClient.pin(target, originalKey)
    assert.equal(interruptedClient.acceptKeyRotation(target, published, originalKey.fingerprint).pinnedFingerprint, replacement.fingerprint)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('key management requires explicit approval and rejects changed keys before mutation', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-recovery-key-admin-'))
  try {
    const admin = new AdminService({ dataRoot: directory })
    let reads = 0
    let writes = 0
    const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const original = { publicKey: key, fingerprint: recoveryKeyFingerprint(key) }
    admin.remoteRecoveryConnection = async () => {
      reads++
      return { target, transport: { key: async () => original, rotateKey: async () => { writes++; assert.fail('stale approval must not rotate') } } }
    }
    await assert.rejects(admin.rotateRemoteRecoveryKey({ expectedFingerprint: original.fingerprint }), /approval/u)
    await assert.rejects(admin.acceptRemoteRecoveryKeyRotation({ expectedFingerprint: original.fingerprint, publishedFingerprint: original.fingerprint }), /approval/u)
    assert.equal(reads, 0)
    assert.equal((await admin.inspectRemoteRecoveryKey({})).changed, false)
    await assert.rejects(admin.rotateRemoteRecoveryKey({ expectedFingerprint: 'f'.repeat(64), approved: true }), /changed/u)
    await assert.rejects(admin.acceptRemoteRecoveryKeyRotation({ expectedFingerprint: original.fingerprint, publishedFingerprint: 'f'.repeat(64), approved: true }), /changed/u)
    assert.equal(writes, 0)
    assert.equal(admin.remoteRecovery.currentKey(target).fingerprint, original.fingerprint)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('unsupported backends fail before accessing a remote target', async () => {
  for (const platform of ['kubernetes']) {
    const transport = new RemoteRecoveryTransport({ platform, client: { runCommand () { assert.fail('unsupported backend must not dispatch') } } })
    await assert.rejects(transport.key(), /unavailable/u)
  }
  await assert.rejects(recoveryStorageCommand('linux', 'read', { executionId: '../../bad', sequence: 1 }), /identity/u)
})

test('a changed live host identity blocks recovery before reading its ledger', async () => {
  const admin = new AdminService({ dataRoot: '/tmp/intent-recovery-identity-readonly', ssh: { async hostFingerprint () { return 'SHA256:' + 'b'.repeat(64) } }, settings: { async decryptServer () { return { connectionUrl: 'ssh://fixture' } } } })
  admin.netdata = () => { assert.fail('identity must be verified before ledger access') }
  await assert.rejects(admin.listRemoteCommonTasks({ settings: { servers: { lab: { hostFingerprint: target } } }, passphrase: 'unused', serverId: 'lab' }), /Current host identity/u)
})

test('remote listings reject unsolicited fields, malformed identities and unordered cursors', async () => {
  const entry = { executionId: 'a'.repeat(32), sequence: 1, head: 'b'.repeat(64) }
  for (const executions of [[{ ...entry, secret: 'not-forwarded' }], [{ ...entry, executionId: '\u001b[2J' }], [entry, entry], Array(11).fill(entry)]) {
    const transport = new RemoteRecoveryTransport({ platform: 'linux', client: { async runCommand () { return { exitCode: 0, stdout: JSON.stringify({ executions }), stderr: '' } } } })
    await assert.rejects(transport.list(), /Invalid remote recovery/u)
  }
})

test('Windows storage uses fixed CNG, protected ACLs and durable publication rather than POSIX commands', async () => {
  const command = await recoveryStorageCommand('windows', 'initialize')
  assert.match(command, /CngAlgorithm\]::ECDsaP256/u)
  assert.match(command, /S-1-5-18/u)
  assert.match(command, /S-1-5-32-544/u)
  assert.match(command, /SetAccessRuleProtection\(\$true,\$false\)/u)
  assert.match(command, /ReparsePoint/u)
  assert.match(command, /FileOptions\]::WriteThrough/u)
  assert.match(command, /MoveFileEx/u)
  assert.doesNotMatch(command, /openssl|\/var\/lib/u)
})

test('signature-verified arbitrary remote fields cannot become executable recovery code', () => {
  const { privateKey } = generateKeyPairSync('ed25519')
  const plan = buildCommonTask('systemd-service', 63, options).plan
  const manifest = { ...commonTaskRecoveryManifest({ catalogId: 'systemd-service', taskId: 63, target, options, plan }), executionId: 'b'.repeat(32) }
  const record = recoveryRecord(manifest, { type: 'command_completed', commandId: 'apply', commandDigest: planFingerprint(plan.commands[0]) }, { sequence: 1 })
  assert.throws(() => signRecoveryRecord({ ...record, command: 'arbitrary command' }, privateKey), /schema/u)
})

for (const takeover of [false, true]) {
  test(`shared execution and fresh-install recovery preserve approval and ownership: takeover=${takeover}`, async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-recovery-workflow-'))
    try {
      const storage = shellClient(directory)
      const settings = { servers: { lab: { hostFingerprint: target } } }
      let executed = 0
      const client = {
        async health () { return { platform: 'linux' } },
        async runCommand (command) {
          if (command.includes('intentaiops-recovery')) return storage.runCommand(command)
          if (command.includes('safe_parent ()') && !command.includes('RECOVERY_BASELINE_CHANGED')) return { exitCode: 0, stdout: 'SHA2-256(stdin)= ' + 'd'.repeat(64), stderr: '' }
          executed++
          return { exitCode: 0, stdout: 'fixture-operation-completed', stderr: '' }
        }
      }
      const makeAdmin = name => {
        const admin = new AdminService({
          dataRoot: path.join(directory, name),
          ssh: { async hostFingerprint () { return target } },
          settings: { async decryptServer () { return { connectionUrl: 'ssh://fixture' } } },
          workspace: { async loadRules () { return { policy: rootExecutionPolicy({}) } } }
        })
        admin.netdata = () => client
        return admin
      }
      const admin = makeAdmin('original-install')
      const task = admin.createTask('lab', 'Deploy the common service fixture', { kind: 'catalog', catalogId: 'systemd-service' })
      const plan = buildCommonTask('systemd-service', task.id, options).plan
      admin.saveTaskPlan('lab', task.id, plan, { catalogId: 'systemd-service', options, target })
      const results = await admin.execute({ settings, passphrase: 'unused', serverId: 'lab', taskId: task.id, plan, approve: async () => true, onResult: result => admin.appendTaskResult('lab', task.id, result) })
      admin.saveTaskResults('lab', task.id, results)
      assert.equal(executed, 1)
      const archived = admin.remoteRecovery.get(target, task.id)
      assert.equal(archived.sequence, 4)
      const transport = new RemoteRecoveryTransport({ client, platform: 'linux' })
      if (takeover) await transport.claim({ executionId: archived.manifest.executionId, taskId: task.id, owner: archived.owner, sequence: archived.sequence, head: archived.head })
      const fresh = makeAdmin('fresh-install')
      const connection = { settings, passphrase: 'unused', serverId: 'lab' }
      const proposal = await fresh.prepareRemoteCommonTaskRecovery({ ...connection, executionId: archived.manifest.executionId, options })
      assert.equal(proposal.ownership.owned, takeover)
      assert.equal(fresh.tasks.executionEvents('lab', proposal.taskId).length, 0)
      await assert.rejects(fresh.execute({ ...connection, taskId: proposal.taskId, plan: proposal.plan, approve: async () => true, requireRevert: false }), /recheck/u)
      const rejected = await fresh.executeRemoteCommonTaskRecovery({ ...connection, taskId: proposal.taskId, options, approve: async () => false })
      assert.equal(rejected[0].status, 'rejected')
      assert.equal(executed, 1)
      if (takeover) {
        await assert.rejects(fresh.executeRemoteCommonTaskRecovery({ ...connection, taskId: proposal.taskId, options, takeoverFingerprint: proposal.ownership.ownerFingerprint, approve: async () => true }), /takeover approval/u)
        await assert.rejects(fresh.executeRemoteCommonTaskRecovery({ ...connection, taskId: proposal.taskId, options, takeoverFingerprint: 'f'.repeat(64), takeoverApproved: true, approve: async () => true }), /failed/u)
        assert.equal(executed, 1)
      }
      const recovered = await fresh.executeRemoteCommonTaskRecovery({ ...connection, taskId: proposal.taskId, options, ...(takeover ? { takeoverFingerprint: proposal.ownership.ownerFingerprint, takeoverApproved: true } : {}), approve: async () => true })
      assert.equal(recovered[0].status, 'completed')
      assert.equal(executed, 2)
      const events = fresh.tasks.executionEvents('lab', proposal.taskId)
      assert.ok(events.every(event => event.commandId !== 'apply'))
      await assert.rejects(fresh.executeRemoteCommonTaskRecovery({ ...connection, taskId: proposal.taskId, options, approve: async () => true }), /already started/u)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
}

test('signed common-task records retain transport recovery without replay or losing confirmed baseline evidence', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-recovery-reconnect-'))
  try {
    const storage = shellClient(directory)
    const settings = { servers: { lab: { hostFingerprint: target } } }
    let executed = 0
    const client = {
      async health () { return { platform: 'linux' } },
      async runCommand (command, request) {
        if (command.includes('intentaiops-recovery')) return storage.runCommand(command)
        if (command.includes('safe_parent ()')) return { exitCode: 0, stdout: 'SHA2-256(stdin)= ' + 'd'.repeat(64), stderr: '' }
        executed++
        await request.onRecovery({ state: 'reconnecting', attempt: 1, attempts: 3 })
        return { exitCode: 0, stdout: '', stderr: '' }
      }
    }
    const makeAdmin = name => {
      const admin = new AdminService({ dataRoot: path.join(directory, name), ssh: { async hostFingerprint () { return target } }, settings: { async decryptServer () { return { connectionUrl: 'ssh://fixture' } } }, workspace: { async loadRules () { return { policy: rootExecutionPolicy({}) } } } })
      admin.netdata = () => client
      return admin
    }
    const admin = makeAdmin('original')
    const task = admin.createTask('lab', 'Deploy common service', { kind: 'catalog', catalogId: 'systemd-service' })
    const plan = buildCommonTask('systemd-service', task.id, options).plan
    admin.saveTaskPlan('lab', task.id, plan, { catalogId: 'systemd-service', options, target })
    const connection = { settings, passphrase: 'unused', serverId: 'lab' }
    const results = await admin.execute({ ...connection, taskId: task.id, plan, approve: async () => true })
    assert.equal(results[0].status, 'completed')
    assert.equal(results[0].recoveryRequired, true)
    assert.equal(admin.tasks.control('lab', task.id).action, 'pause')
    assert.equal(executed, 1)
    const executionId = admin.remoteRecovery.get(target, task.id).manifest.executionId
    const verified = await admin.inspectRemoteCommonTask({ ...connection, executionId })
    assert.equal(verified.records.filter(record => record.event === 'execution_recovery').length, 2)
    assert.equal(verified.records.at(-1).event, 'execution_paused')
    const fresh = makeAdmin('fresh')
    const proposal = await fresh.prepareRemoteCommonTaskRecovery({ ...connection, executionId, options })
    assert.ok(proposal.plan.commands.length)
    assert.equal(fresh.tasks.executionEvents('lab', proposal.taskId).length, 0)
    assert.equal(executed, 1)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('authoritative job reconciliation signs completion and baseline without replaying the command', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-recovery-reconcile-'))
  try {
    const storage = shellClient(directory)
    const settings = { servers: { lab: { hostFingerprint: target } } }
    let statusReads = 0
    const client = {
      async health () { return { platform: 'linux' } },
      async jobStatus (jobId) { assert.equal(jobId, 'a'.repeat(32)); statusReads++; return { state: 'succeeded', exitCode: 0 } },
      async runCommand (command) {
        if (command.includes('intentaiops-recovery')) return storage.runCommand(command)
        if (command.includes('safe_parent ()')) return { exitCode: 0, stdout: 'SHA2-256(stdin)= ' + 'd'.repeat(64), stderr: '' }
        assert.fail('reconciliation must not execute deployment commands')
      }
    }
    const admin = new AdminService({ dataRoot: path.join(directory, 'client'), ssh: { async hostFingerprint () { return target } }, settings: { async decryptServer () { return { connectionUrl: 'ssh://fixture' } } }, workspace: { async loadRules () { return { policy: rootExecutionPolicy({}) } } } })
    admin.netdata = () => client
    const task = admin.createTask('lab', 'Reconcile common service', { kind: 'catalog', catalogId: 'systemd-service' })
    const plan = buildCommonTask('systemd-service', task.id, options).plan
    admin.saveTaskPlan('lab', task.id, plan, { catalogId: 'systemd-service', options, target })
    const journal = await admin.remoteTaskJournal({ settings, serverId: 'lab', taskId: task.id, plan, server: {}, task: admin.tasks.get('lab', task.id) })
    const lease = admin.tasks.acquireExecution('lab', task.id, plan)
    for (const type of ['plan_approved', 'command_prepared', 'command_dispatched', 'command_acknowledged']) {
      const event = { type, commandId: plan.commands[0].id, attemptId: '12345678-1234-1234-1234-123456789abc', metadata: type === 'command_acknowledged' ? { jobId: 'a'.repeat(32), state: 'running' } : {} }
      admin.tasks.appendExecutionEvent('lab', task.id, lease.owner, event)
      await journal.append(event)
    }
    admin.tasks.releaseExecution('lab', task.id, lease.owner)
    const connection = { settings, passphrase: 'unused', serverId: 'lab' }
    const state = await admin.reconcileTask({ ...connection, taskId: task.id })
    assert.equal(state[0].status, 'completed')
    assert.equal(statusReads, 1)
    const executionId = admin.remoteRecovery.get(target, task.id).manifest.executionId
    const verified = await admin.inspectRemoteCommonTask({ ...connection, executionId })
    assert.equal(verified.records.at(-1).event, 'command_completed')
    assert.equal(verified.records.at(-1).baselineDigest, 'd'.repeat(64))
    assert.ok(regenerateCommonTaskRecovery({ ...verified, options, baselineDigest: 'd'.repeat(64) }).plan)
    await admin.reconcileTask({ ...connection, taskId: task.id })
    assert.equal(statusReads, 1)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('failure to persist pre-dispatch remote intent prevents the actual command', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-recovery-intent-'))
  try {
    const storage = shellClient(directory)
    const settings = { servers: { lab: { hostFingerprint: target } } }
    let appends = 0
    let executed = 0
    const admin = new AdminService({ dataRoot: path.join(directory, 'client'), ssh: { async hostFingerprint () { return target } }, settings: { async decryptServer () { return { connectionUrl: 'ssh://fixture' } } }, workspace: { async loadRules () { return { policy: rootExecutionPolicy({}) } } } })
    admin.netdata = () => ({
      async runCommand (command) {
        if (command.includes('intentaiops-recovery')) {
          if (command.includes("'append' 'linux'") && ++appends === 3) return { exitCode: 1, stdout: '', stderr: 'fixture persistence failure' }
          return storage.runCommand(command)
        }
        executed++
        return { exitCode: 0, stdout: '', stderr: '' }
      }
    })
    const task = admin.createTask('lab', 'Deploy the common service fixture', { kind: 'catalog', catalogId: 'systemd-service' })
    const plan = buildCommonTask('systemd-service', task.id, options).plan
    admin.saveTaskPlan('lab', task.id, plan, { catalogId: 'systemd-service', options, target })
    await assert.rejects(admin.execute({ settings, passphrase: 'unused', serverId: 'lab', taskId: task.id, plan, approve: async () => true }), /Remote recovery append failed/u)
    assert.equal(executed, 0)
    assert.equal(admin.tasks.executionState('lab', task.id)[0].status, 'pending')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('failed remote completion persistence retains local confirmation and never replays the command', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-recovery-outcome-'))
  try {
    const storage = shellClient(directory)
    const settings = { servers: { lab: { hostFingerprint: target } } }
    let appends = 0
    let executed = 0
    const admin = new AdminService({ dataRoot: path.join(directory, 'client'), ssh: { async hostFingerprint () { return target } }, settings: { async decryptServer () { return { connectionUrl: 'ssh://fixture' } } }, workspace: { async loadRules () { return { policy: rootExecutionPolicy({}) } } } })
    admin.netdata = () => ({
      async health () { return { platform: 'linux' } },
      async runCommand (command) {
        if (command.includes('intentaiops-recovery')) {
          if (command.includes("'append' 'linux'") && ++appends === 4) return { exitCode: 1, stdout: '', stderr: 'fixture persistence failure' }
          return storage.runCommand(command)
        }
        if (command.includes('safe_parent ()')) return { exitCode: 0, stdout: 'SHA2-256(stdin)= ' + 'd'.repeat(64), stderr: '' }
        executed++
        return { exitCode: 0, stdout: '', stderr: '' }
      }
    })
    const task = admin.createTask('lab', 'Deploy common service', { kind: 'catalog', catalogId: 'systemd-service' })
    const plan = buildCommonTask('systemd-service', task.id, options).plan
    admin.saveTaskPlan('lab', task.id, plan, { catalogId: 'systemd-service', options, target })
    const connection = { settings, passphrase: 'unused', serverId: 'lab' }
    await assert.rejects(admin.execute({ ...connection, taskId: task.id, plan, approve: async () => true }), /Remote recovery append failed/u)
    assert.equal(executed, 1)
    assert.equal(admin.tasks.executionState('lab', task.id)[0].status, 'completed')
    const executionId = admin.remoteRecovery.get(target, task.id).manifest.executionId
    const verified = await admin.inspectRemoteCommonTask({ ...connection, executionId })
    assert.equal(verified.records.at(-1).event, 'command_dispatched')
    assert.throws(() => regenerateCommonTaskRecovery({ ...verified, options, baselineDigest: 'd'.repeat(64) }), /Partial or uncertain/u)
    const resumed = await admin.execute({ ...connection, taskId: task.id, plan, approve: async () => true })
    assert.equal(resumed[0].status, 'completed')
    assert.equal(executed, 1)
    assert.equal(admin.tasks.executionEvents('lab', task.id).filter(event => event.type === 'command_dispatched').length, 1)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('systemd completion evidence stays private under the plugin group-writable umask', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-recovery-baseline-'))
  try {
    const plan = buildCommonTask('systemd-service', 81, options).plan
    mkdirSync(directory + '/etc/systemd/system', { recursive: true })
    const relocate = command => command.replaceAll('/var/lib/webminai/task-state/81-systemd-service', directory + '/state').replaceAll('/etc/systemd/system/webminai-test.service', directory + '/etc/systemd/system/webminai-test.service').replaceAll('/run/webminai-test-service', directory + '/runtime')
    const apply = spawnSync('/bin/sh', ['-c', 'umask 0007; systemctl () { :; }; ' + relocate(plan.commands[0].command)], { encoding: 'utf8' })
    assert.equal(apply.status, 0, apply.stderr)
    assert.equal(statSync(directory + '/state/apply-complete').mode & 0o777, 0o600)
    const command = relocate(recoveryBaselineCommand('systemd-service', 81)).replaceAll('-user root', '-user ' + os.userInfo().username).replaceAll('safe_parent "$state"', ':').replaceAll('safe_parent "$file"', ':')
    const client = { async runCommand () { const result = spawnSync('/bin/sh', ['-c', 'id () { printf 0; }; ' + command], { encoding: 'utf8' }); return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr } } }
    assert.match(await inspectRecoveryBaseline(client, 'systemd-service', 81), /^[a-f0-9]{64}$/u)
    const failedHash = spawnSync('/bin/sh', ['-c', 'id () { printf 0; }; openssl () { if [ "$#" -gt 2 ]; then return 1; fi; command openssl "$@"; }; ' + command], { encoding: 'utf8' })
    assert.notEqual(failedHash.status, 0)
    assert.equal(failedHash.stdout, '')
    chmodSync(directory + '/etc/systemd/system/webminai-test.service', 0o664)
    await assert.rejects(inspectRecoveryBaseline(client, 'systemd-service', 81), /ownership/u)
    chmodSync(directory + '/etc/systemd/system/webminai-test.service', 0o644)
    rmSync(directory + '/etc/systemd/system/webminai-test.service')
    symlinkSync(directory + '/foreign', directory + '/etc/systemd/system/webminai-test.service')
    await assert.rejects(inspectRecoveryBaseline(client, 'systemd-service', 81), /ownership/u)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('native CLI recovery binds protected markers, complete owned tree and launchers without executing installed files', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-cli-recovery-baseline-'))
  try {
    const state = directory + '/state'
    const root = directory + '/installation'
    mkdirSync(state, { mode: 0o700 })
    mkdirSync(root, { mode: 0o755 })
    mkdirSync(directory + '/bin', { mode: 0o755 })
    for (const name of ['baseline', 'owns-root', 'installed']) writeFileSync(state + '/' + name, '', { mode: 0o600 })
    writeFileSync(root + '/version.txt', 'reviewed-version', { mode: 0o644 })
    symlinkSync('version.txt', root + '/version-link')
    for (const name of ['intentaiops', 'intentops']) writeFileSync(directory + '/bin/' + name, 'DO NOT EXECUTE', { mode: 0o755 })
    const script = recoveryBaselineCommand('intent-ai-ops-linux', 82)
      .replaceAll('/var/lib/webminai/tasks/82/intent-ai-ops-install', state)
      .replaceAll('/opt/intent-ai-ops', root)
      .replaceAll('/usr/local/bin/intentaiops', directory + '/bin/intentaiops')
      .replaceAll('/usr/local/bin/intentops', directory + '/bin/intentops')
      .replaceAll('-user root', '-user ' + os.userInfo().username)
      .replaceAll('safe_parent "$state"', ':').replaceAll('safe_parent "$root"', ':').replaceAll('safe_parent "$file"', ':')
    const client = { async runCommand () { const value = spawnSync('/bin/sh', ['-c', 'id () { printf 0; }; ' + script], { encoding: 'utf8', timeout: 10000 }); return { exitCode: value.status, stdout: value.stdout, stderr: value.stderr } } }
    const digest = await inspectRecoveryBaseline(client, 'intent-ai-ops-linux', 82)
    assert.equal(await inspectRecoveryBaseline(client, 'intent-ai-ops-linux', 82), digest)
    writeFileSync(root + '/unrelated-data', 'preserve this newly added data', { mode: 0o600 })
    assert.notEqual(await inspectRecoveryBaseline(client, 'intent-ai-ops-linux', 82), digest)
    rmSync(root + '/unrelated-data')
    writeFileSync(directory + '/bin/intentops', 'changed launcher', { mode: 0o755 })
    assert.notEqual(await inspectRecoveryBaseline(client, 'intent-ai-ops-linux', 82), digest)
    chmodSync(state + '/owns-root', 0o660)
    await assert.rejects(inspectRecoveryBaseline(client, 'intent-ai-ops-linux', 82), /ownership/u)
    chmodSync(state + '/owns-root', 0o600)
    writeFileSync(state + '/unexpected', 'not an audited baseline input')
    await assert.rejects(inspectRecoveryBaseline(client, 'intent-ai-ops-linux', 82), /ownership/u)
    rmSync(state + '/unexpected')
    rmSync(directory + '/bin/intentops')
    symlinkSync(root + '/version.txt', directory + '/bin/intentops')
    await assert.rejects(inspectRecoveryBaseline(client, 'intent-ai-ops-linux', 82), /ownership/u)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('native CLI recovery regenerates trusted cleanup while refusing Alpine package ownership', () => {
  const taskId = 83
  const plan = buildCommonTask('intent-ai-ops-linux', taskId, options).plan
  const manifest = { ...commonTaskRecoveryManifest({ catalogId: 'intent-ai-ops-linux', taskId, target, options, plan }), executionId: 'b'.repeat(32) }
  const records = plan.commands.map((command, index) => recoveryRecord(manifest, { type: 'command_completed', commandId: command.id, commandDigest: planFingerprint(command) }, { sequence: index + 1, previousHash: index ? 'a'.repeat(64) : null, baselineDigest: 'd'.repeat(64) }))
  const input = { records, head: 'e'.repeat(64), options, baselineDigest: 'd'.repeat(64) }
  const recovery = regenerateCommonTaskRecovery(input)
  assert.equal(recovery.plan.commands.length, 1)
  assert.match(recovery.plan.commands[0].command, /RECOVERY_BASELINE_CHANGED/u)
  assert.match(recovery.plan.commands[0].command, /test ! -L "\$root"/u)
  assert.throws(() => regenerateCommonTaskRecovery({ ...input, options: { ...options, linuxContext: { identity: { id: 'alpine' } } } }), /Alpine/u)
  assert.throws(() => regenerateCommonTaskRecovery({ ...input, baselineDigest: 'f'.repeat(64) }), /baseline/u)
})

function shellClient (directory) {
  const owner = os.userInfo().username
  mkdirSync(path.join(directory, 'parent'), { mode: 0o700 })
  return {
    async runCommand (command) {
      const script = command
        .replaceAll('/var/lib/intentaiops/recovery', path.join(directory, 'parent/recovery'))
        .replaceAll('-user root', '-user ' + owner)
        .replaceAll('safe_directory "$' + '{ancestor%/*}"', ':')
        .replaceAll('safe_directory "$current"', ':')
      const result = spawnSync('/bin/bash', ['-c', 'id () { printf 0; }; sync () { :; }; export -f id sync; ' + script.replace(/^sh -c /u, 'bash -c ')], { encoding: 'utf8', timeout: 15000, shell: false, env: { ...process.env, BASH_ENV: undefined } })
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
    }
  }
}
