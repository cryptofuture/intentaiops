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
import { validateCommandPlan } from '../src/plan-validator.js'
import { planFingerprint } from '../src/execution-journal.js'
import { RemoteRecoveryState } from '../src/remote-recovery-state.js'
import { RemoteRecoveryTransport, recoveryStorageCommand } from '../src/remote-recovery-transport.js'
import { commonTaskRecoveryManifest, regenerateCommonTaskRecovery, RemoteCommonTaskJournal, retrieveRecoveryExecution } from '../src/remote-common-task-recovery.js'
import { recoveryKeyFingerprint, recoveryRecord, signRecoveryRecord, verifyRecoveryKeyRotation } from '../src/remote-recovery-record.js'
import { recoveryBaselineCommand, inspectRecoveryBaseline } from '../src/remote-recovery-baseline.js'

const target = 'SHA256:' + 'a'.repeat(64)
const options = { platform: 'linux' }

test('durable recovery writes allow bounded flush time without automatic retry', async () => {
  const calls = []
  const transport = new RemoteRecoveryTransport({ platform: 'linux', client: { async runCommand (command, options) { calls.push(options.timeoutSeconds); return { exitCode: 0, stdout: '{"available":false}' } } } })
  assert.equal(await transport.key(), null)
  assert.equal(await transport.key({ initialize: true }), null)
  assert.deepEqual(calls, [15, 60])
})

for (const mode of ['gnu', 'gnu-alias', 'portable', 'failed-fsync']) {
  test(`recovery durability uses bounded ledger inode flushes with safe fallback: ${mode}`, async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-ledger-flush-'))
    const trace = path.join(directory, 'flush-calls')
    try {
      const implementation = mode === 'portable' ? 'BusyBox' : mode === 'gnu-alias' ? 'sync (uutils coreutils) 0.10.0' : 'sync (GNU coreutils) 9.11'
      const flush = mode === 'gnu' || mode === 'gnu-alias' ? 'test "$#" -gt 0; command sync "$@"' : mode === 'portable' ? 'test "$#" -eq 0' : 'return 1'
      const body = `if [ "\${1-}" = --version ]; then printf '%s\\n' '${implementation}'; return 0; fi; printf '%s\\n' "$*" >> '${trace}'; ${flush}`
      const alias = mode === 'gnu-alias' ? body.replace(implementation, 'sync (GNU coreutils) 9.7') : 'return 127'
      const transport = new RemoteRecoveryTransport({ client: shellClient(directory, body, alias), platform: 'linux' })
      if (mode === 'failed-fsync') {
        await assert.rejects(transport.key({ initialize: true }))
        assert.equal(existsSync(directory + '/parent/recovery/signing.pem'), false)
        assert.equal(existsSync(directory + '/parent/recovery/.write-lock'), false)
      } else {
        assert.ok(await transport.key({ initialize: true }))
        if (mode === 'gnu' || mode === 'gnu-alias') {
          const plan = buildCommonTask('systemd-service', 99, options).plan
          const state = new RemoteRecoveryState(directory + '/client')
          state.register(commonTaskRecoveryManifest({ catalogId: 'systemd-service', taskId: 99, target, options, plan }))
          const journal = new RemoteCommonTaskJournal({ transport, state, target, taskId: 99, plan })
          await journal.append({ type: 'plan_approved', commandId: plan.commands[0].id })
          await journal.release()
        }
      }
      const calls = readFileSync(trace, 'utf8').trimEnd().split('\n')
      if (mode === 'portable') assert.ok(calls.every(line => line === ''))
      else {
        assert.ok(calls.every(line => line.startsWith('-- ')))
        assert.ok(calls.every(line => line.includes('/parent/recovery/.write-lock') && line.includes('/parent/recovery') && line.includes(directory)))
        if (mode === 'gnu' || mode === 'gnu-alias') {
          assert.ok(calls.some(line => line.includes('/.write-lock/record')))
          assert.ok(calls.some(line => line.includes('/.write-lock/head')))
          assert.ok(calls.some(line => line.includes('/owner')))
          assert.ok(calls.some(line => line.includes('/task-99')))
        }
      }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
}

test('remote storage failures explain allowlisted conflicts without disclosing arbitrary stderr', async () => {
  for (const [stderr, expected] of [
    ['Legacy remote task state is already occupied\n', /legacy task state is occupied; preserve it and review a new task identity/u],
    ['Remote task identity is already occupied\n', /task identity is already reserved; preserve it and review a new task identity/u],
    ['recovery storage is busy or requires stale-lock investigation\n', /storage is busy; inspect ownership before continuing/u],
    ['password=known-secret Legacy remote task state is already occupied', /^Remote recovery claim failed; no automatic retry is authorized$/u],
    ['toString', /^Remote recovery claim failed; no automatic retry is authorized$/u],
    ['__proto__', /^Remote recovery claim failed; no automatic retry is authorized$/u]
  ]) {
    let calls = 0
    const transport = new RemoteRecoveryTransport({ platform: 'linux', client: { async runCommand () { calls++; return { exitCode: 1, stdout: '', stderr } } } })
    await assert.rejects(transport.claim({ executionId: 'a'.repeat(32), owner: 'b'.repeat(32), sequence: 0, head: null, taskId: 1 }), error => {
      assert.match(error.message, expected)
      assert.doesNotMatch(error.message, /known-secret/u)
      return true
    })
    assert.equal(calls, 1)
  }
})

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
    await assert.rejects(transport.claim({ executionId: randomBytes(16).toString('hex'), owner: 'f'.repeat(32), sequence: 0, head: null, taskId: 61 }), /task identity is already reserved/u)
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

test('new executions cannot adopt occupied legacy state even without a signed task reservation', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-legacy-state-collision-'))
  try {
    const transport = new RemoteRecoveryTransport({ client: shellClient(directory), platform: 'linux' })
    await transport.key({ initialize: true })
    const args = { executionId: 'b'.repeat(32), owner: 'c'.repeat(32), sequence: 0, head: null, taskId: 91 }
    for (const name of ['task-state/91-n8n-linux', 'db-task-state/91-intent-ai-ops-install', 'tasks/91', 'db-tasks/91']) {
      const occupied = path.join(directory, 'legacy', name)
      mkdirSync(occupied, { recursive: true, mode: 0o700 })
      writeFileSync(occupied + '/original', 'preserve legacy data')
      await assert.rejects(transport.claim(args), /legacy task state is occupied/u)
      assert.equal(readFileSync(occupied + '/original', 'utf8'), 'preserve legacy data')
      assert.equal(existsSync(directory + '/parent/recovery/' + args.executionId), false)
      rmSync(occupied, { recursive: true })
    }
    const dangling = directory + '/legacy/task-state/91-unresolved'
    symlinkSync(directory + '/missing', dangling)
    await assert.rejects(transport.claim(args), /legacy task state is occupied/u)
    rmSync(dangling)
    await transport.claim(args)
    await transport.release(args)
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

test('boundary pause and resume are signed remotely without repeating completed commands', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-recovery-boundaries-'))
  try {
    const storage = shellClient(directory)
    const executed = []
    const settings = { servers: { lab: { hostFingerprint: target } } }
    const admin = new AdminService({ dataRoot: directory + '/client', ssh: { async hostFingerprint () { return target } }, settings: { async decryptServer () { return { connectionUrl: 'ssh://fixture' } } }, workspace: { async loadRules () { return { policy: rootExecutionPolicy() } } } })
    admin.netdata = () => ({
      async health () { return { platform: 'linux' } },
      async runCommand (command) {
        if (command.includes('intentaiops-recovery')) return storage.runCommand(command)
        if (command.includes('safe_parent ()')) return { exitCode: 0, stdout: 'SHA2-256(stdin)= ' + 'd'.repeat(64), stderr: '' }
        executed.push(command)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
      async runJob (command, request) {
        await request.onStarted?.({ jobId: 'c'.repeat(32), state: 'running' })
        return this.runCommand(command)
      }
    })
    const task = admin.createTask('lab', 'Install CLI', { kind: 'catalog', catalogId: 'intent-ai-ops-linux' })
    const plan = buildCommonTask('intent-ai-ops-linux', task.id, options).plan
    assert.equal(plan.commands.length, 2)
    admin.saveTaskPlan('lab', task.id, plan, { catalogId: 'intent-ai-ops-linux', options, target })
    const args = { settings, passphrase: 'unused', serverId: 'lab', taskId: task.id, plan, approve: async () => true, onResult: result => admin.appendTaskResult('lab', task.id, result) }
    await admin.execute({ ...args, beforeCommand: async item => item.id === plan.commands[0].id })
    const executionId = admin.remoteRecovery.get(target, task.id).manifest.executionId
    const connection = { settings, passphrase: 'unused', serverId: 'lab', executionId }
    const paused = await admin.inspectRemoteCommonTask(connection)
    assert.equal(paused.records.at(-1).event, 'execution_paused')
    assert.equal(executed.length, 1)
    await admin.execute(args)
    const resumed = await admin.inspectRemoteCommonTask(connection)
    assert.equal(resumed.records.filter(record => record.event === 'execution_resumed').length, 1)
    assert.deepEqual(executed, plan.commands.map(command => command.command))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a later completed attempt cannot hide an earlier uncertain attempt in signed recovery history', () => {
  const plan = buildCommonTask('systemd-service', 62, options).plan
  const manifest = { ...commonTaskRecoveryManifest({ catalogId: 'systemd-service', taskId: 62, target, options, plan }), executionId: 'b'.repeat(32) }
  const command = { commandId: 'apply', commandDigest: planFingerprint(plan.commands[0]) }
  const firstAttempt = '11111111-1111-1111-1111-111111111111'
  const secondAttempt = '22222222-2222-2222-2222-222222222222'
  const unknown = recoveryRecord(manifest, { ...command, type: 'command_outcome_unknown', attemptId: firstAttempt }, { sequence: 1 })
  const completed = recoveryRecord(manifest, { ...command, type: 'command_completed', attemptId: secondAttempt }, { sequence: 2, previousHash: 'e'.repeat(64), baselineDigest: 'd'.repeat(64) })
  const input = { records: [unknown, completed], head: 'e'.repeat(64), baselineDigest: 'd'.repeat(64), options }
  assert.throws(() => regenerateCommonTaskRecovery(input), /earlier execution attempt remains uncertain/u)
  assert.ok(regenerateCommonTaskRecovery({ ...input, records: [unknown, { ...completed, attemptId: firstAttempt }] }).plan)
  assert.throws(() => regenerateCommonTaskRecovery({ ...input, records: [{ ...unknown, attemptId: null }, { ...completed, attemptId: null }] }), /uncertain/u)
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

test('a pinned missing key is never silently regenerated by execution', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-recovery-missing-pin-'))
  try {
    const state = new RemoteRecoveryState(directory)
    const original = buildCommonTask('systemd-service', 61, options).plan
    state.register(commonTaskRecoveryManifest({ catalogId: 'systemd-service', taskId: 61, target, options, plan: original }))
    const { publicKey } = generateKeyPairSync('ed25519')
    state.pin(target, { publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), fingerprint: recoveryKeyFingerprint(publicKey) })
    const transport = { async key ({ initialize }) { assert.equal(initialize, false); return null }, async claim () { assert.fail('no ownership or commands may be dispatched') } }
    const journal = new RemoteCommonTaskJournal({ transport, state, target, taskId: 61, plan: original })
    await assert.rejects(journal.append({ type: 'plan_approved' }), /without replacing/u)
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
  assert.match(command, /EnumerateFileSystemEntries/u)
  assert.match(command, /Legacy remote task state is already occupied/u)
  assert.doesNotMatch(command, /openssl|\/var\/lib/u)
})

test('Windows record pages bound requests, response bytes, records and read-only execution', async () => {
  const executionId = 'a'.repeat(32)
  for (const parameters of [{ sequence: 0, limit: 1 }, { sequence: 1, limit: 33 }, { sequence: 100000, limit: 2 }]) await assert.rejects(recoveryStorageCommand('windows', 'read-page', { executionId, ...parameters }), /record page/u)
  await assert.rejects(recoveryStorageCommand('linux', 'read-page', { executionId, sequence: 1, limit: 1 }), /record page/u)
  for (const response of [{ records: [] }, { records: [null, null] }, { records: [{}], extra: true }, { records: [{ payload: 'a'.repeat(8192) }] }]) {
    const transport = new RemoteRecoveryTransport({ platform: 'windows', client: { async runCommand (_command, options) { assert.equal(options.timeoutSeconds, 15); return { exitCode: 0, stdout: JSON.stringify(response) } } } })
    await assert.rejects(transport.readPage(executionId, 1, 1), /record page/u)
  }
  const transport = new RemoteRecoveryTransport({ platform: 'windows', client: { async runCommand () { return { exitCode: 0, stdout: JSON.stringify({ records: Array(8).fill({ payload: 'a'.repeat(7000) }) }) } } } })
  await assert.rejects(transport.readPage(executionId, 1, 8), /response exceeds limit/u)
})

test('batched retrieval still verifies every signature and chain position', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-recovery-pages-'))
  try {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const key = { publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), fingerprint: recoveryKeyFingerprint(publicKey) }
    const plan = buildCommonTask('systemd-service', 61, options).plan
    const manifest = { ...commonTaskRecoveryManifest({ catalogId: 'systemd-service', taskId: 61, target, options, plan }), executionId: 'a'.repeat(32) }
    const first = signRecoveryRecord(recoveryRecord(manifest, { type: 'plan_approved' }, { sequence: 1 }), privateKey)
    const second = signRecoveryRecord(recoveryRecord(manifest, { type: 'execution_paused' }, { sequence: 2, previousHash: planFingerprint(first) }), privateKey)
    const state = new RemoteRecoveryState(directory)
    let pages = 0
    const transport = { key: async () => key, list: async () => ({ executions: [{ executionId: manifest.executionId, sequence: 2, head: planFingerprint(second) }] }), readPage: async (_id, sequence, limit) => { pages++; assert.equal(sequence, 1); assert.equal(limit, 2); return [first, second] } }
    assert.equal((await retrieveRecoveryExecution({ transport, state, target, executionId: manifest.executionId })).records.length, 2)
    assert.equal(pages, 1)
    for (const records of [[second, first], [first, first], [first, { ...second, signature: first.signature }], []]) {
      transport.readPage = async () => records
      await assert.rejects(retrieveRecoveryExecution({ transport, state, target, executionId: manifest.executionId }), /signature|gap|record page/u)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
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

test('transport recovery callbacks stay local while signed outcomes and rollback remain durable', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-recovery-reconnect-'))
  try {
    const storage = shellClient(directory)
    const settings = { servers: { lab: { hostFingerprint: target } } }
    let executed = 0; let recovering = false
    const client = {
      async health () { return { platform: 'linux' } },
      async runCommand (command, request) {
        assert.equal(recovering, false, 'Recovery callbacks must not re-enter their SSH transport')
        if (command.includes('intentaiops-recovery')) return storage.runCommand(command)
        if (command.includes('safe_parent ()')) return { exitCode: 0, stdout: 'SHA2-256(stdin)= ' + 'd'.repeat(64), stderr: '' }
        executed++
        recovering = true
        try { await request.onRecovery({ state: 'reconnecting', attempt: 1, attempts: 3 }) } finally { recovering = false }
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
    const results = await admin.execute({ ...connection, taskId: task.id, plan, approve: async () => true, executionObserver: event => assert.notEqual(event.type, 'execution_recovery') })
    assert.equal(results[0].status, 'completed')
    assert.equal(results[0].recoveryRequired, true)
    assert.equal(admin.tasks.control('lab', task.id).action, 'pause')
    assert.equal(executed, 1)
    const executionId = admin.remoteRecovery.get(target, task.id).manifest.executionId
    const verified = await admin.inspectRemoteCommonTask({ ...connection, executionId })
    assert.equal(verified.records.filter(record => record.event === 'execution_recovery').length, 0)
    assert.equal(admin.tasks.executionEvents('lab', task.id).filter(event => event.type === 'execution_recovery').length, 2)
    assert.equal(verified.records.at(-1).event, 'execution_paused')
    const fresh = makeAdmin('fresh')
    const proposal = await fresh.prepareRemoteCommonTaskRecovery({ ...connection, executionId, options })
    assert.ok(proposal.plan.commands.length)
    assert.equal(fresh.tasks.executionEvents('lab', proposal.taskId).length, 0)
    assert.equal(executed, 1)
    admin.tasks.saveResults('lab', task.id, results)
    const rollback = await admin.revertTask({ ...connection, taskId: task.id, approve: async () => true })
    assert.equal(rollback[0].status, 'completed')
    assert.equal(admin.tasks.get('lab', task.id).status, 'reverting')
    assert.ok(admin.tasks.interruptedTasks('lab').some(row => row.id === task.id))
    const afterRollback = await admin.inspectRemoteCommonTask({ ...connection, executionId })
    assert.ok(afterRollback.records.some(record => record.operation === 'rollback' && record.event === 'command_completed'))
    assert.ok(!afterRollback.records.some(record => record.event === 'execution_recovery'))
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

test('reconciliation clears stale running status after a ledger error without replay', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-reconcile-status-'))
  try {
    let reads = 0; let journals = 0
    const admin = new AdminService({ dataRoot: directory, settings: { async decryptServer () { return { connectionUrl: 'ssh://fixture' } } } })
    admin.netdata = () => ({ async jobStatus () { reads++; return { state: 'succeeded', exitCode: 0 } } })
    admin.remoteTaskJournal = async () => { journals++; throw new Error('ledger unavailable') }
    const task = admin.createTask('lab', 'Reconcile known completion')
    const plan = buildCommonTask('systemd-service', task.id, options).plan
    plan.commands.push({ ...plan.commands[0], id: 'pending-next', command: 'true', dependsOn: [plan.commands[0].id], risk: 'read' })
    admin.saveTaskPlan('lab', task.id, plan)
    admin.tasks.markRunning('lab', task.id)
    const lease = admin.tasks.acquireExecution('lab', task.id, plan)
    for (const type of ['command_prepared', 'command_dispatched', 'command_acknowledged']) admin.tasks.appendExecutionEvent('lab', task.id, lease.owner, { type, commandId: plan.commands[0].id, attemptId: '12345678-1234-1234-1234-123456789abc', metadata: { jobId: 'a'.repeat(32) } })
    admin.tasks.releaseExecution('lab', task.id, lease.owner)
    const connection = { settings: { servers: { lab: {} } }, passphrase: 'unused', serverId: 'lab', taskId: task.id }
    await assert.rejects(admin.reconcileTask(connection), /ledger unavailable/u)
    assert.equal(admin.tasks.executionState('lab', task.id)[0].status, 'completed')
    assert.equal(admin.tasks.get('lab', task.id).status, 'running')
    const states = await admin.reconcileTask(connection)
    assert.equal(states[0].status, 'completed')
    assert.equal(states.at(-1).status, 'pending')
    assert.equal(admin.tasks.get('lab', task.id).status, 'partial')
    assert.deepEqual(admin.tasks.interruptedTasks('lab'), [])
    assert.equal(reads, 1)
    assert.equal(journals, 1)
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

for (const catalogId of ['logrotate-rule', 'tmpfiles-rule']) {
  test(`${catalogId} recovery binds fixed baseline files and refuses changed or unrelated data`, async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-fixture-recovery-'))
    try {
      const state = directory + '/state'
      const paths = catalogId === 'logrotate-rule'
        ? ['/etc/logrotate.d/webminai-test', '/var/log/webminai-test.log']
        : ['/etc/tmpfiles.d/webminai-test.conf', '/run/webminai-test-tmpfiles']
      const relocate = text => paths.reduce((text, original, index) => text.replaceAll(original, `${directory}/file-${index}`), text.replaceAll(`/var/lib/webminai/task-state/83-${catalogId}`, state))
      const built = buildCommonTask(catalogId, 83, options)
      const applyCommand = `umask 0007; logrotate () { :; }; fixture_tmpfiles () { mkdir -m 0750 '${directory}/file-1'; }; ${relocate(built.plan.commands[0].command).replaceAll('systemd-tmpfiles', 'fixture_tmpfiles')}`
      const apply = spawnSync('/bin/sh', ['-c', applyCommand], { encoding: 'utf8' })
      assert.equal(apply.status, 0, apply.stderr)
      const script = relocate(recoveryBaselineCommand(catalogId, 83)).replaceAll('-user root', '-user ' + os.userInfo().username).replaceAll('safe_parent "$state"', ':').replaceAll('safe_parent "$file"', ':').replaceAll('safe_parent "$directory"', ':')
      const client = { async runCommand () { const value = spawnSync('/bin/sh', ['-c', 'id () { printf 0; }; ' + script], { encoding: 'utf8' }); return { exitCode: value.status, stdout: value.stdout, stderr: value.stderr } } }
      const digest = await inspectRecoveryBaseline(client, catalogId, 83)
      const repeat = spawnSync('/bin/sh', ['-c', applyCommand], { encoding: 'utf8' })
      assert.equal(repeat.status, 0, repeat.stderr)
      assert.equal(await inspectRecoveryBaseline(client, catalogId, 83), digest)
      const manifest = { ...commonTaskRecoveryManifest({ catalogId, taskId: 83, target, options, plan: built.plan }), executionId: 'b'.repeat(32) }
      const record = recoveryRecord(manifest, { type: 'command_completed', commandId: 'apply', commandDigest: planFingerprint(built.plan.commands[0]) }, { sequence: 1, baselineDigest: digest })
      assert.match(regenerateCommonTaskRecovery({ records: [record], head: 'e'.repeat(64), options, baselineDigest: digest }).plan.commands[0].command, /RECOVERY_BASELINE_CHANGED/u)
      writeFileSync(directory + '/file-0', 'modified configuration', { mode: 0o644 })
      assert.notEqual(await inspectRecoveryBaseline(client, catalogId, 83), digest)
      if (catalogId === 'tmpfiles-rule') {
        writeFileSync(directory + '/file-1/unrelated-data', 'must be preserved')
        await assert.rejects(inspectRecoveryBaseline(client, catalogId, 83), /ownership/u)
      }
      chmodSync(directory + '/file-0', 0o664)
      await assert.rejects(inspectRecoveryBaseline(client, catalogId, 83), /ownership/u)
      if (catalogId === 'tmpfiles-rule') rmSync(directory + '/file-1/unrelated-data')
      for (let attempt = 0; attempt < 2; attempt++) {
        const rollback = spawnSync('/bin/sh', ['-c', relocate(built.plan.revertCommands[0].command)], { encoding: 'utf8' })
        assert.equal(rollback.status, 0, rollback.stderr)
        for (const entry of [state, directory + '/file-0', directory + '/file-1']) assert.equal(existsSync(entry), false)
      }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
}

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

test('native n8n recovery checks immutable backups, package drift, mount boundaries and directory identities', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-n8n-recovery-'))
  try {
    const state = directory + '/state'
    const roots = ['/opt/webminai-n8n-18109', '/var/lib/webminai-n8n-18109', '/root/n8n_credentials']
    mkdirSync(state, { mode: 0o700 })
    mkdirSync(state + '/repo-backup', { mode: 0o700 })
    writeFileSync(state + '/packages.before', 'nginx\nnodejs\n', { mode: 0o600 })
    writeFileSync(state + '/repo-0.existed', '', { mode: 0o600 })
    writeFileSync(state + '/repo-backup/0', 'original protected repository config', { mode: 0o600 })
    writeFileSync(directory + '/mountinfo', '')
    for (let index = 0; index < roots.length; index++) mkdirSync(`${directory}/root-${index}`, { mode: index === 0 ? 0o755 : 0o700 })
    writeFileSync(directory + '/root-0/package.json', '{}', { mode: 0o644 })
    const relocate = text => roots.reduce((value, entry, index) => value.replaceAll(entry, `${directory}/root-${index}`), text.replaceAll('/var/lib/webminai/task-state/84-n8n-linux', state))
    const script = relocate(recoveryBaselineCommand('n8n-linux', 84, 'debian'))
      .replaceAll('/etc/', directory + '/etc/').replaceAll('/usr/share/keyrings/', directory + '/keyrings/')
      .replaceAll('-user root', '-user ' + os.userInfo().username)
      .replaceAll('safe_parent "$state"', ':').replaceAll('safe_parent "$file"', ':').replaceAll('safe_parent "$directory"', ':').replaceAll('safe_parent "$state/repo-backup"', ':')
      .replaceAll(' -eq 0 ]', ` -eq ${os.userInfo().uid} ]`)
      .replaceAll('/proc/self/mountinfo', directory + '/mountinfo')
      .replaceAll('dpkg-query', 'fixture_packages')
    let packageVersion = '1'
    const client = {
      async runCommand () {
        const result = spawnSync('/bin/sh', ['-c', `id () { printf ${os.userInfo().uid}; }; getent () { printf fixture-account; }; fixture_packages () { printf 'nginx ${packageVersion}\\nnodejs 24\\n'; }; ` + script], { encoding: 'utf8' })
        return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
      }
    }
    const inspect = () => inspectRecoveryBaseline(client, 'n8n-linux', 84, 'debian')
    const digest = await inspect()
    assert.equal(await inspect(), digest)
    packageVersion = '2'
    assert.notEqual(await inspect(), digest)
    packageVersion = '1'
    mkdirSync(directory + '/etc/apt/sources.list.d', { recursive: true })
    writeFileSync(directory + '/etc/apt/sources.list.d/nodesource.sources', 'changed live repository', { mode: 0o600 })
    assert.notEqual(await inspect(), digest)
    writeFileSync(state + '/repo-backup/0', 'modified backup')
    assert.notEqual(await inspect(), digest)
    writeFileSync(state + '/packages.before', '--remove-everything\n')
    await assert.rejects(inspect(), /ownership/u)
    writeFileSync(state + '/packages.before', 'nginx\nnodejs\n')
    writeFileSync(directory + '/mountinfo', `1 2 0:1 / ${directory}/root-1/nested rw - tmpfs tmpfs rw\n`)
    await assert.rejects(inspect(), /ownership/u)
    writeFileSync(directory + '/mountinfo', '')
    chmodSync(state + '/repo-backup/0', 0o664)
    await assert.rejects(inspect(), /ownership/u)
    chmodSync(state + '/repo-backup/0', 0o600)
    rmSync(state + '/repo-backup/0')
    symlinkSync(directory + '/root-0/package.json', state + '/repo-backup/0')
    await assert.rejects(inspect(), /ownership/u)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('native n8n regenerates one guarded dependency-ordered job and refuses Compose', () => {
  const context = { identity: { id: 'debian', versionId: '13', architecture: 'x86_64' }, management: { family: 'debian', packageManager: 'apt', serviceManager: 'systemd' } }
  const options = { platform: 'linux', linuxContext: context, docker: { preferred: false } }
  const original = buildCommonTask('n8n-linux', 84, options).plan
  const manifest = { ...commonTaskRecoveryManifest({ catalogId: 'n8n-linux', taskId: 84, target, options, plan: original }), executionId: 'b'.repeat(32) }
  const records = original.commands.map((command, index) => recoveryRecord(manifest, { type: 'command_completed', commandId: command.id, commandDigest: planFingerprint(command) }, { sequence: index + 1, previousHash: index ? 'e'.repeat(64) : null, baselineDigest: 'd'.repeat(64) }))
  const recovery = regenerateCommonTaskRecovery({ records, head: 'e'.repeat(64), options, baselineDigest: 'd'.repeat(64) })
  assert.doesNotThrow(() => validateCommandPlan(recovery.plan, rootExecutionPolicy(), { requireRevert: false }))
  assert.equal(recovery.plan.commands.length, 1)
  const command = recovery.plan.commands[0]
  assert.equal(command.executionMode, 'job')
  assert.equal(command.risk, 'destructive')
  assert.equal(command.timeoutMs, 1500000)
  assert.match(recovery.plan.warnings.join(' '), /without an intervention boundary/u)
  assert.match(command.command, /RECOVERY_BASELINE_CHANGED/u)
  assert.ok(command.command.indexOf('systemctl disable') < command.command.indexOf('rm -rf'))
  assert.ok(command.command.indexOf('rm -rf') < command.command.indexOf('apt-get purge'))
  assert.equal(spawnSync('/bin/sh', ['-n', '-c', command.command]).status, 0)
  const directory = mkdtempSync(path.join(os.tmpdir(), 'intent-n8n-recovery-order-'))
  try {
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
    const start = command.command.indexOf('; set -eu\nsh -c ')
    assert.ok(start > 0)
    for (const failAt of [-1, 0, 1]) {
      let script = command.command.slice(start + 2)
      for (const [index, item] of original.revertCommands.entries()) script = script.replace(quote(item.command), quote(`printf '${index}\\n' >> '${directory}/order'; exit ${index === failAt ? 1 : 0}`))
      const result = spawnSync('/bin/sh', ['-c', script])
      assert.equal(result.status, failAt < 0 ? 0 : 1)
      assert.equal(readFileSync(directory + '/order', 'utf8'), Array.from({ length: failAt < 0 ? 3 : failAt + 1 }, (_, index) => `${index}\n`).join(''))
      rmSync(directory + '/order')
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
  assert.throws(() => regenerateCommonTaskRecovery({ records, head: 'e'.repeat(64), options: { ...options, docker: { preferred: true, ready: true } }, baselineDigest: 'd'.repeat(64) }), /native Linux route/u)
  for (const profile of [{ nginxService: 'unrelated.service' }, { nginxEnableLink: '/etc/unrelated-link' }, { nginxVhost: '/etc/unrelated.conf' }]) {
    const custom = { ...options, linuxContext: { ...context, applications: { wordpress: profile } } }
    const plan = buildCommonTask('n8n-linux', 84, custom).plan
    const manifest = { ...commonTaskRecoveryManifest({ catalogId: 'n8n-linux', taskId: 84, target, options: custom, plan }), executionId: 'b'.repeat(32) }
    const records = plan.commands.map((command, index) => recoveryRecord(manifest, { type: 'command_completed', commandId: command.id, commandDigest: planFingerprint(command) }, { sequence: index + 1, previousHash: index ? 'e'.repeat(64) : null, baselineDigest: 'd'.repeat(64) }))
    assert.throws(() => regenerateCommonTaskRecovery({ records, head: 'e'.repeat(64), options: custom, baselineDigest: 'd'.repeat(64) }), /customized/u)
  }
})

for (const [id, family, packageManager, serviceManager] of [
  ['debian', 'debian', 'apt', 'systemd'], ['alpine', 'alpine', 'apk', 'openrc'],
  ['arch', 'arch', 'pacman', 'systemd'], ['almalinux', 'rhel', 'dnf', 'systemd'],
  ['opensuse-leap', 'suse', 'zypper', 'systemd']
]) {
  test(`native n8n recovery reconstructs the ${family} catalog without substituting another platform`, () => {
    const options = { platform: 'linux', linuxContext: { identity: { id, versionId: 'fixture', architecture: 'x86_64' }, management: { family, packageManager, serviceManager } }, docker: { preferred: false } }
    const plan = buildCommonTask('n8n-linux', 85, options).plan
    const manifest = { ...commonTaskRecoveryManifest({ catalogId: 'n8n-linux', taskId: 85, target, options, plan }), executionId: 'b'.repeat(32) }
    const records = plan.commands.map((command, index) => recoveryRecord(manifest, { type: 'command_completed', commandId: command.id, commandDigest: planFingerprint(command) }, { sequence: index + 1, previousHash: index ? 'e'.repeat(64) : null, baselineDigest: 'd'.repeat(64) }))
    const recovery = regenerateCommonTaskRecovery({ records, head: 'e'.repeat(64), options, baselineDigest: 'd'.repeat(64) })
    assert.doesNotThrow(() => validateCommandPlan(recovery.plan, rootExecutionPolicy(), { requireRevert: false }))
    assert.equal(recovery.plan.compatibilityManifest.selectedRoute.id, `native-${family}`)
    assert.equal(recovery.plan.commands.length, 1)
    const binary = { debian: 'dpkg-query', alpine: 'apk', arch: 'pacman', rhel: 'rpm', suse: 'rpm' }[family]
    assert.ok(recoveryBaselineCommand('n8n-linux', 85, family).includes(`packages=$(${binary} `))
    assert.equal(spawnSync('/bin/sh', ['-n', '-c', recovery.plan.commands[0].command]).status, 0)
    assert.throws(() => regenerateCommonTaskRecovery({ records, head: 'e'.repeat(64), options: { ...options, platform: 'windows' }, baselineDigest: 'd'.repeat(64) }), /platform/u)
    assert.throws(() => regenerateCommonTaskRecovery({ records: records.slice(0, -1), head: 'e'.repeat(64), options, baselineDigest: 'd'.repeat(64) }), /uncertain/u)
  })
}

test('native n8n recovery refuses unknown package families rather than guessing from installed tools', () => {
  for (const family of [undefined, '__proto__', 'unknown']) assert.throws(() => recoveryBaselineCommand('n8n-linux', 85, family), /audited package family/u)
})

function shellClient (directory, syncBody = ':', aliasBody = 'return 127') {
  const owner = os.userInfo().username
  mkdirSync(path.join(directory, 'parent'), { mode: 0o700 })
  return {
    async runCommand (command) {
      const script = command
        .replaceAll('/var/lib/intentaiops/recovery', path.join(directory, 'parent/recovery'))
        .replaceAll('/var/lib/webminai/task-state', path.join(directory, 'legacy/task-state'))
        .replaceAll('/var/db/webminai/task-state', path.join(directory, 'legacy/db-task-state'))
        .replaceAll('/var/lib/webminai/tasks', path.join(directory, 'legacy/tasks'))
        .replaceAll('/var/db/webminai/tasks', path.join(directory, 'legacy/db-tasks'))
        .replaceAll('-user root', '-user ' + owner)
        .replaceAll('safe_directory "$' + '{ancestor%/*}"', ':')
        .replaceAll('safe_directory "$current"', ':')
      const result = spawnSync('/bin/bash', ['-c', `id () { printf 0; }; sync () { ${syncBody}; }; gnusync () { ${aliasBody}; }; export -f id sync gnusync; ` + script.replace(/^sh -c /u, 'bash -c ')], { encoding: 'utf8', timeout: 15000, shell: false, env: { ...process.env, BASH_ENV: undefined } })
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
    }
  }
}
