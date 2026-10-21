import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { launchLabCli } from '../browser-checks/lab-cli.js'
import { SystemSsh } from '../src/system-ssh.js'
import { SettingsStore } from '../src/settings-store.js'
import { TaskStore } from '../src/task-store.js'
import { redactDiagnosticText } from '../src/error-details.js'
import { buildCommonTask } from '../src/common-tasks.js'
import { regenerateCatalogRevision } from '../src/catalog-plan-revision.js'
import { planFingerprint } from '../src/execution-journal.js'
import { validateCommandPlan } from '../src/plan-validator.js'
import { rootExecutionPolicy } from '../src/execution-policy.js'
import { RemoteRecoveryState } from '../src/remote-recovery-state.js'
import { recoveryRecord, verifyRecoveryChain, verifyRecoveryRecord } from '../src/remote-recovery-record.js'
import { RemoteRecoveryTransport, recoveryStorageCommand } from '../src/remote-recovery-transport.js'
import { NetdataClient } from '../src/netdata-client.js'

const hostId = 'ubuntu-2604-netbook'
const destination = 'ssh://user@192.168.1.102'
const applications = ['wordpress-linux', 'woocommerce-linux', 'joomla-linux', 'drupal-linux', 'prestashop-linux', 'moodle-linux', 'magento-linux', 'n8n-linux', 'ghost-linux', 'mattermost-linux', 'odoo-linux', 'jellyfin-linux', 'home-assistant-linux']
const directory = path.resolve('artifacts/netbook-docker')
const checkpoint = 'netbook-docker-validation-status.md'
const selected = process.argv.filter(value => value.startsWith('--task=')).map(value => value.slice(7))
const restoreDocker = process.argv.includes('--restore-docker')
const preserveReviewedUpgrades = process.argv.includes('--preserve-reviewed-upgrades')
assert.ok(!preserveReviewedUpgrades || restoreDocker, 'Reviewed upgrade exceptions apply only to final Docker restoration')
const reviewedUpgrades = [
  ['ca-certificates', '20260601~26.04.1', '20260816ubuntu0.26.04.1'],
  ['liblzma5:amd64', '5.8.3-1', '5.8.3-1ubuntu0.1'],
  ['xz-utils', '5.8.3-1', '5.8.3-1ubuntu0.1']
]
function originalPackageVersions (text) {
  for (const [name, before, after] of reviewedUpgrades) {
    const expression = new RegExp('^' + (name + '=' + after).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '(?= |$)', 'gmu')
    assert.equal([...text.matchAll(expression)].length, 1, `Expected exactly the reviewed upgraded version of ${name}`)
    text = text.replace(expression, name + '=' + before)
  }
  return text
}
assert.equal(originalPackageVersions(reviewedUpgrades.map(([name, , after]) => `${name}=${after} ii `).join('\n')), reviewedUpgrades.map(([name, before]) => `${name}=${before} ii `).join('\n'))
assert.throws(() => originalPackageVersions(''), /Expected exactly/u)
const updateStage2 = process.argv.includes('--update-stage2')
const resumeMagentoApproved = process.argv.includes('--resume-magento-reviewed')
const repairReadinessLedger = process.argv.includes('--review-magento-readiness-ledger')
const repairVerificationLedger = process.argv.includes('--review-magento-verification-ledger')
const installationLedgerOnly = process.argv.includes('--review-magento-installation-ledger') || process.argv.includes('--review-magento-installation-ledger-finalize') || repairReadinessLedger || repairVerificationLedger
assert.ok(process.argv.includes('--approve-live-tests'), 'Explicit --approve-live-tests is required')
assert.ok(process.env.SSH_HOST_2 && process.env.VAULT_TEST, 'SSH_HOST_2 and VAULT_TEST are required')
assert.ok(selected.every(id => applications.includes(id)), 'Unknown application')
assert.equal(new Set(selected).size, selected.length, 'Duplicate selected application')
if (updateStage2) assert.ok(process.argv.includes('--setup-only') && !selected.length && !restoreDocker, 'Stage 2 update is a separate reviewed setup-only operation')
if (installationLedgerOnly) {
  assert.deepEqual(selected, ['magento-linux'])
  assert.equal(process.argv.filter(value => value.startsWith('--review-')).length, 1, 'Metadata repair must be separate from application continuation and its Docker readiness checks')
  assert.ok(!restoreDocker && !updateStage2 && !resumeMagentoApproved && !process.argv.includes('--setup-only'))
}
process.env.INTENT_WEB_DATA_ROOT = process.env.WEBMINAI_DATA_ROOT ?? '/home/vscode/.intentaiops'
await mkdir(directory, { recursive: true, mode: 0o700 })
const stateFile = path.join(directory, 'state.json')
let state
try { state = JSON.parse(await readFile(stateFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error; state = { hostId, destination, tasks: {} } }
assert.equal(state.destination, destination)
if (restoreDocker) {
  assert.ok(!selected.length && !process.argv.includes('--setup-only'), 'Restoration cannot start another selected test')
  assert.ok(applications.every(id => state.tasks[id]?.status === 'reverted' || (state.tasks[id]?.status === 'blocked-cpu' && state.tasks[id]?.cleanupReverted === true)), 'Every application must be verified reverted or hardware-blocked with verified cleanup before Docker restoration')
  assert.ok(Number.isSafeInteger(state.dockerTaskId) && state.dockerTaskId > 0)
}
const safe = value => redactDiagnosticText(String(value).split(process.env.SSH_HOST_2).join('[redacted]').split(process.env.VAULT_TEST).join('[redacted]')).replace(/[\r\n]+/gu, ' ').trim().slice(0, 1800)
async function record (message) {
  state.observedAt = new Date().toISOString()
  await writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  const line = `${state.observedAt} ${safe(message)}`
  await appendFile(checkpoint, '\n- ' + line + '\n')
  console.log(line)
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const packageFields = '$' + '{binary:Package}=' + '$' + '{Version} ' + '$' + '{db:Status-Abbrev}'
const packageList = `dpkg-query -W -f=${quote(packageFields + '\\n')} | LC_ALL=C sort`
const setupBaselineCommand = 'set -eu; ' + packageList + "; docker ps -aq; docker image ls --no-trunc --format '{{.ID}}'; docker volume ls -q; docker network ls --format '{{.ID}} {{.Name}}'"
async function inspect (command) {
  const session = await new SystemSsh().openInteractiveSession(destination, { authentication: 'password', credential: process.env.SSH_HOST_2 })
  try {
    return (await session.ssh.execute(destination, "sudo -S -p '' sh -c " + quote(command), { input: process.env.SSH_HOST_2 + '\n', timeoutMs: 60000, maxOutputBytes: 2 * 1024 * 1024 })).stdout
  } finally { await session.close() }
}
const runtimeBaseline = "set -eu; printf 'containers\\n'; docker ps -aq | LC_ALL=C sort; printf 'images\\n'; docker image ls --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}' | LC_ALL=C sort; printf 'volumes\\n'; docker volume ls -q | LC_ALL=C sort; printf 'networks\\n'; docker network ls --format '{{.Name}} {{.Driver}}' | LC_ALL=C sort"
if (!state.baselineSaved) {
  const baseline = await inspect("set -eu; printf '===OS===\\n'; cat /etc/os-release; uname -m; printf '===PACKAGES===\\n'; " + packageList + "; printf '===USERS===\\n'; getent passwd; printf '===GROUPS===\\n'; getent group; printf '===SERVICES===\\n'; systemctl list-unit-files --no-pager --no-legend; printf '===RESOURCES===\\n'; free -m; df -Pk /; printf '===PATHS===\\n'; for p in /etc/docker /var/lib/docker /var/lib/containerd /etc/netdata /var/lib/netdata /var/cache/netdata /var/log/netdata /var/lib/webminai /etc/apt/keyrings /etc/apt/sources.list.d; do if [ -e \"$p\" ]; then stat -c '%n %F %u:%g %a' \"$p\"; else printf 'absent %s\\n' \"$p\"; fi; done; printf '===REPOSITORIES===\\n'; find /etc/apt/sources.list.d /etc/apt/keyrings -maxdepth 1 -type f -exec sha256sum {} \\; 2>/dev/null || true; printf '===RUNTIMES===\\n'; command -v docker || true; command -v netdata || true")
  assert.match(baseline, /VERSION_ID="26\.04"/u)
  assert.equal(baseline.split('===RUNTIMES===')[1].trim(), '', 'Preexisting Docker or Netdata requires separate restoration review')
  await writeFile(path.join(directory, 'before-setup.txt'), baseline, { flag: 'wx', mode: 0o600 })
  state.baselineSaved = true
  await record('Saved private pre-install package, account, service, repository and path baseline; Docker and Netdata absent. No runtime installed yet.')
}
let sshPrompts = 0
const onPrompt = (output, action = state.operation?.action) => {
  if ((['host-add', 'host-connect'].includes(action) && /user@192\.168\.1\.102['’]s password:|\(user@192\.168\.1\.102\) Password:/iu.test(output)) || (['stage2-activate', 'stage2-update', 'stage2-deactivate'].includes(action) && /Sudo password:/u.test(output))) {
    assert.ok(++sshPrompts <= 12, 'Unexpected repeated authentication prompts; stop rather than flood credentials')
    return process.env.SSH_HOST_2
  }
  return null
}
assert.equal(onPrompt('Unrelated output'), null)
assert.ok(onPrompt("user@192.168.1.102's password: ", 'host-connect') !== null)
assert.ok(onPrompt('(user@192.168.1.102) Password: ', 'host-connect') !== null)
assert.ok(onPrompt('Sudo password: ', 'stage2-activate') !== null)
assert.ok(onPrompt('Sudo password: ', 'stage2-update') !== null)
assert.equal(onPrompt('Sudo password: ', 'execute'), null)
sshPrompts = 0
process.env.INTENT_WEB_DATA_ROOT = path.resolve(process.env.INTENT_WEB_DATA_ROOT)
const cli = await launchLabCli({ actions: true, onPrompt })
const launch = new URL(cli.url)
const base = launch.origin + launch.pathname.replace(/\/$/u, '')
let cookie, csrf
async function request (endpoint, body) {
  const response = await fetch(base + endpoint, { method: body ? 'POST' : 'GET', headers: { Origin: launch.origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json', 'X-Intent-CSRF': csrf ?? '' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000) })
  if (endpoint === '/session') cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const result = await response.json()
  assert.ok(response.ok, result.error ?? `HTTP ${response.status}`)
  return result
}
async function operation (body) {
  const accepted = await request('/operation', { ...body, hostId, requestKey: randomUUID() })
  state.operation = { id: accepted.id, action: body.action, taskId: body.taskId ?? null }
  await record(`${body.action} accepted: ${accepted.id}${body.taskId ? ' task #' + body.taskId : ''}`)
  const deadline = Date.now() + 4 * 60 * 60 * 1000
  while (Date.now() < deadline) {
    const current = await request('/operation?id=' + accepted.id)
    if (current.status !== 'running') {
      state.operation.status = current.status
      await record(`${body.action}: ${current.status}${current.error ? '; ' + safe(current.error) : ''}`)
      assert.equal(current.status, 'completed', current.error ?? 'Operation interrupted; inspect before continuing')
      return current.result
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error('Observation deadline exceeded. Do not replay; reconcile the recorded operation first.')
}
async function snapshotHost () { return (await request('/workspace')).hosts.find(host => host.id === hostId) }
async function view (id) { return request(`/task?host=${hostId}&task=${id}`) }
async function reviewedExecution (id) {
  const current = await view(id)
  assert.equal(current.task.status, 'planned')
  assert.ok(current.commands.every(command => command.status === 'pending'))
  if (current.task.catalogId !== 'docker-linux') assert.ok(current.task.plan.commands.some(command => /\bdocker compose\b/u.test(command.command)), 'Application plan must use the Docker Compose route')
  await operation({ action: 'execute', taskId: id, expectedVersion: current.stateVersion, fingerprint: current.fingerprint, approved: true })
  const saved = await view(id)
  assert.ok(saved.commands.every(command => command.status === 'completed'), 'Partial or uncertain execution requires inspection and separately reviewed cleanup')
  assert.equal(saved.task.status, 'completed')
}
try {
  csrf = (await request('/session', { token: launch.hash.slice(1) })).csrf
  if (!await snapshotHost()) await operation({ action: 'host-add', connection: destination, authentication: 'password' })
  await operation({ action: 'host-connect' })
  const host = await snapshotHost()
  const settingsStore = new SettingsStore(process.env.INTENT_WEB_DATA_ROOT)
  const settings = await settingsStore.load()
  const server = await settingsStore.decryptServer({ settings, passphrase: process.env.VAULT_TEST, serverId: hostId })
  assert.equal(server.connectionUrl, destination)
  if (settings.servers[hostId].desiredStage2 !== 'active') await operation({ action: 'stage2-activate', hostVersion: host.hostVersion, approved: true })
  else if (updateStage2) {
    await operation({ action: 'stage2-update', hostVersion: host.hostVersion, approved: true })
    const expected = createHash('sha256').update(await readFile('remote/webminai-stage2.sh')).digest('hex')
    const observed = (await inspect('sha256sum /usr/local/libexec/webminai-stage2')).trim().split(/\s+/u)[0]
    assert.equal(observed, expected, 'Installed lifecycle runner differs from the reviewed source')
    state.runnerSafetyUpdated = true
    await record('Reviewed CLI Stage 2 update completed; installed lifecycle runner matches local SHA-256; native protocol unchanged')
  }
  const tasks = new TaskStore(process.env.INTENT_WEB_DATA_ROOT, { directoryAliases: new Map([[hostId, settings.servers[hostId].historyId]]) })
  if (!state.dockerTaskId) {
    const inventory = await request('/inventory?host=' + hostId)
    assert.equal(inventory.webminaiDocker.hostIsContainer, false)
    assert.equal(inventory.webminaiDocker.installSupported, true)
    const prepared = await operation({ action: 'prepare', catalogId: 'docker-linux', request: 'Install and verify Docker Engine and Compose for sequential, reversible netbook application validation' })
    state.dockerTaskId = prepared.results[0].taskId
    await record('Saved Docker setup task #' + state.dockerTaskId)
    await reviewedExecution(state.dockerTaskId)
    await record('Docker setup completed with ordinary runtime verification; no eligibility bypass')
  } else {
    const docker = (await view(state.dockerTaskId)).task
    assert.equal(docker.catalogId, 'docker-linux')
    assert.equal(docker.status, 'completed', 'Inspect existing Docker setup rather than repeating it')
  }
  if (installationLedgerOnly) assert.ok((await readFile(path.join(directory, 'after-setup.txt'), 'utf8')).length)
  else await writeFile(path.join(directory, 'after-setup.txt'), await inspect(setupBaselineCommand), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  if (process.argv.includes('--setup-only')) { await record('Setup-only checkpoint reached; application tasks not started'); process.exitCode = 0 } else {
    const inventory = installationLedgerOnly ? null : await request('/inventory?host=' + hostId)
    if (!installationLedgerOnly) {
      assert.equal(inventory.webminaiDocker.ready, true, 'Docker inventory did not confirm daemon/Compose readiness; no application or cleanup command was dispatched')
      assert.equal(inventory.webminaiDocker.preferred, true, 'The host must retain its reviewed Docker preference')
    }
    const retryGnuLedger = process.argv.includes('--review-magento-ledger-gnusync')
    const repairMagentoLedger = process.argv.includes('--review-magento-ledger') || retryGnuLedger
    const finalizeMagentoLedger = process.argv.includes('--review-magento-installation-ledger-finalize')
    const repairMagentoInstallationLedger = process.argv.includes('--review-magento-installation-ledger') || finalizeMagentoLedger || repairReadinessLedger || repairVerificationLedger
    const reviewSearchTimeout = process.argv.includes('--review-magento-search-timeout')
    const reviewMagentoReadiness = process.argv.includes('--review-magento-readiness')
    const reviewMagentoHttpTimeout = process.argv.includes('--review-magento-http-timeout')
    const finalMagentoVerification = process.argv.includes('--review-magento-final-verification') || reviewMagentoHttpTimeout
    const continueMagento = process.argv.includes('--review-magento-continuation') || reviewSearchTimeout || reviewMagentoReadiness || resumeMagentoApproved || finalMagentoVerification
    if (repairMagentoLedger) {
      assert.deepEqual(selected, ['magento-linux'])
      assert.equal(state.tasks['magento-linux']?.id, 23)
      if (retryGnuLedger) {
        assert.equal(state.magentoLedgerRepairTaskId, 24)
        assert.equal(tasks.get(hostId, 24).status, 'partial')
        assert.ok(tasks.executionState(hostId, 24).every(c => c.status === 'failed'), 'Reconcile any uncertain metadata work before a new reviewed repair')
      } else assert.ok(!state.magentoLedgerRepairTaskId, 'Inspect any previously dispatched repair instead of replaying it')
      const recovery = new RemoteRecoveryState(process.env.INTENT_WEB_DATA_ROOT)
      const target = settings.servers[hostId].hostFingerprint
      const saved = recovery.get(target, 23)
      const id = saved.manifest.executionId
      assert.equal(id, 'c900bdc1aa345c3e16150611040b4290')
      assert.equal(saved.sequence, 36)
      assert.equal(saved.head, '98fcd1153be046df8c75e14b3e5448eff7ea5be0cd51ec0309762b2ec9de82fc')
      const current = await view(23)
      const pending = current.commands.find(c => c.commandId === 'start-dependencies')
      assert.equal(pending.status, retryGnuLedger ? 'completed' : 'uncertain')
      assert.equal(pending.jobId, '9d9d6f1058c2943cd6b3d22734749d03')
      const key = recovery.currentKey(target)
      const session = await new SystemSsh().openInteractiveSession(destination, { authentication: 'password', credential: process.env.SSH_HOST_2 })
      try {
        const client = new NetdataClient({ ssh: session.ssh, connectionUrl: destination, actionKey: server.actionKey })
        const job = await client.jobStatus(pending.jobId)
        assert.equal(job.state, 'succeeded'); assert.equal(job.exitCode, 0); assert.equal(job.timedOut, false)
        const transport = new RemoteRecoveryTransport({ client, platform: 'linux' })
        assert.equal((await transport.key()).fingerprint, key.fingerprint)
        const envelopes = []
        for (let sequence = 1; sequence <= 36; sequence++) envelopes.push(await transport.read(id, sequence))
        const chain = verifyRecoveryChain(envelopes, { ...key, target, pinnedFingerprint: key.fingerprint })
        assert.equal(chain.sequence, 36); assert.equal(chain.head, saved.head)
      } finally { await session.close() }
      const storage = '/var/lib/intentaiops/recovery'
      const execution = `${storage}/${id}`
      const lock = `${storage}/.write-lock`
      const quarantine = `${storage}/reviewed-empty-lock-magento-23-20261021`
      const lockIdentity = (await inspect(`stat -c '%d:%i:%Y' ${quote(lock)}`)).trim()
      assert.match(lockIdentity, /^\d+:\d+:\d+$/u)
      const original = tasks.get(hostId, 23)
      const command = original.plan.commands.find(c => c.id === 'start-dependencies')
      const completion = recoveryRecord(saved.manifest, { type: 'command_completed', commandId: command.id, commandDigest: planFingerprint(command), attemptId: pending.attemptId, metadata: { jobId: pending.jobId } }, { sequence: 37, previousHash: saved.head })
      const placeholder = 'f'.repeat(32)
      let append = await recoveryStorageCommand('linux', 'append', { record: completion, owner: placeholder, fingerprint: key.fingerprint })
      assert.equal(append.split(quote(placeholder)).length, 2)
      append = append.replace(quote(placeholder), '"$owner"')
      const checks = [
        'set -eu', `test ! -L ${quote(storage)}; test ! -L ${quote(execution)}; test ! -L ${quote(lock)}`,
        `test "$(stat -c '%u:%g:%a:%h' ${quote(lock)})" = '0:0:700:2'`,
        `test "$(stat -c '%d:%i:%Y' ${quote(lock)})" = ${quote(lockIdentity)}`,
        `test -z "$(find ${quote(lock)} -mindepth 1 -maxdepth 1 -print)"`,
        `test "$(cat ${quote(`${execution}/head`)})" = ${quote(`36 ${saved.head}`)}`,
        `test ! -e ${quote(`${execution}/37.json`)}; test ! -L ${quote(`${execution}/37.json`)}`,
        `test ! -e ${quote(quarantine)}; test ! -L ${quote(quarantine)}`,
        `test ! -L ${quote(`${execution}/owner`)}; test "$(stat -c '%u:%g:%a:%h:%s' ${quote(`${execution}/owner`)})" = '0:0:600:1:32'`,
        `test "$(sha256sum ${quote(`${execution}/owner`)} | cut -d ' ' -f 1)" = ${quote(createHash('sha256').update(saved.owner).digest('hex'))}`,
        "for file in /proc/[0-9]*/cmdline; do if [ -r \"$file\" ] && grep -zFxq intentaiops-recovery \"$file\" 2>/dev/null; then printf 'Active recovery helper; refuse lock quarantine\\n' >&2; exit 78; fi; done",
        'ledger_sync=; for utility in sync gnusync; do if "$utility" --version 2>/dev/null | grep -Fq "GNU coreutils"; then ledger_sync=$utility; break; fi; done; test -n "$ledger_sync"',
        `mv ${quote(lock)} ${quote(quarantine)}`,
        `"$ledger_sync" -- ${quote(quarantine)} ${quote(storage)}`,
        `owner=$(cat ${quote(`${execution}/owner`)})`,
        `${append} >/dev/null`,
        "printf '%s\\n' reviewed-ledger-completion-recorded"
      ]
      const item = { id: 'repair-reviewed-magento-ledger', command: checks.join('; '), purpose: 'Quarantine only the verified empty inactive lock, then sign the already-confirmed original job completion without replaying startup', risk: 'change', timeoutMs: 300000, executionMode: 'job', requiresSudo: true, phase: 'cleanup', diagnostic: null, dependsOn: [] }
      const plan = { summary: 'Reviewed Magento ledger reconciliation', changeOverview: 'Preserve all existing signed records and keys. Append authoritative completion of the original successful startup job, not a new execution.', modifiedFiles: [lock, quarantine, `${execution}/head`, `${execution}/37.json`], assumptions: ['Signed history through record 36 and the pinned key verified; original startup succeeded; the lock is empty and no recovery helper is active'], warnings: ['This does not approve Magento installation or restart any service. Signed history is not automatically rewound.'], requiresConfirmation: true, commands: [item], revertCommands: [{ ...item, id: 'refuse-ledger-rewind', command: "printf 'Signed history must not be rewound; inspect the preserved quarantine\\n' >&2; exit 1", purpose: 'Refuse an automatic signed-history rewind', risk: 'read', timeoutMs: 30000 }] }
      validateCommandPlan(plan, rootExecutionPolicy({}))
      if (!retryGnuLedger) await operation({ action: 'resolve', taskId: 23, commandId: 'start-dependencies', status: 'completed', expectedVersion: current.stateVersion, evidence: 'Authoritative original signed job 9d9d6f1058c2943cd6b3d22734749d03 succeeded, exit 0, timedOut=false. Owned dependencies are healthy. No startup replay authorized; ledger completion will be separately repaired and signed.', approved: true })
      assert.equal((await view(23)).task.status, 'partial')
      const repair = tasks.create(hostId, 'Reviewed empty recovery-lock quarantine and authoritative Magento startup completion record')
      tasks.savePlan(hostId, repair.id, plan)
      if (retryGnuLedger) state.failedMagentoLedgerRepairTaskId = state.magentoLedgerRepairTaskId
      state.magentoLedgerRepairTaskId = repair.id
      await record(`Prepared metadata-only Magento repair #${repair.id}; verify existing chain, preserve empty stale lock and append the confirmed original job result`)
      const review = await view(repair.id)
      await operation({ action: 'execute', taskId: repair.id, expectedVersion: review.stateVersion, fingerprint: review.fingerprint, approved: true })
      assert.ok((await view(repair.id)).commands.every(c => c.status === 'completed'))
      const envelope = JSON.parse(await inspect(`cat ${quote(`${execution}/37.json`)}`))
      const verified = verifyRecoveryRecord(envelope, { ...key, target, pinnedFingerprint: key.fingerprint })
      assert.equal(planFingerprint(verified), planFingerprint(completion))
      recovery.advance(target, 23, 36, saved.head, envelope)
      await record('Magento original startup completion is now signed and locally acknowledged. No application command replayed. Search verification and corrected installer require a separately approved revision.')
    }
    if (repairMagentoInstallationLedger) {
      assert.deepEqual(selected, ['magento-linux'])
      assert.equal(state.tasks['magento-linux']?.id, 23)
      if (repairVerificationLedger) assert.ok(!state.magentoVerificationLedgerRepairTaskId, 'Reconcile previously dispatched verification metadata work rather than replaying it')
      else if (repairReadinessLedger) assert.ok(!state.magentoReadinessLedgerRepairTaskId, 'Reconcile previously dispatched readiness metadata work rather than replaying it')
      else if (finalizeMagentoLedger) {
        assert.equal(state.magentoInstallationLedgerRepairTaskId, 26)
        assert.equal(tasks.get(hostId, 26).status, 'planned')
        assert.ok(tasks.executionState(hostId, 26).every(c => c.status === 'pending'), 'Do not replay dispatched metadata work')
        const current = await view(23)
        await operation({ action: 'reconcile', taskId: 23, expectedVersion: current.stateVersion })
        assert.equal((await view(23)).task.status, 'partial')
      } else assert.ok(!state.magentoInstallationLedgerRepairTaskId, 'Reconcile previously accepted metadata repair rather than replaying it')
      const recovery = new RemoteRecoveryState(process.env.INTENT_WEB_DATA_ROOT)
      const target = settings.servers[hostId].hostFingerprint
      const saved = recovery.get(target, 23)
      assert.equal(saved.sequence, repairVerificationLedger ? 72 : repairReadinessLedger ? 66 : finalizeMagentoLedger ? 59 : 58)
      assert.equal(saved.head, repairVerificationLedger ? '58bc8c00629ede577a27c80ec444089403b3d270fee57d62b7f2a91b193b8243' : repairReadinessLedger ? '38264fa12998ace6362eef6f03c0c716a71325f908fecaabae8f3bc711b157dd' : finalizeMagentoLedger ? '315cd6c9df1ffbe641c60af6006360c21a5620f2449bdfc0f6de8b022ce1431c' : '4dd69fbaee09ffa940138bbc8bb15b9cb3c9e70baeb6ed8430da21ae8e5bda5a')
      const executionId = saved.manifest.executionId
      assert.equal(executionId, 'c900bdc1aa345c3e16150611040b4290')
      const key = recovery.currentKey(target)
      const commandId = repairVerificationLedger ? 'verify-magento-reviewed' : repairReadinessLedger ? 'finish-magento-readiness' : 'initialize-magento'
      const pending = (await view(23)).commands.find(c => c.commandId === commandId)
      assert.ok((repairVerificationLedger ? ['uncertain', 'failed'] : ['uncertain', 'completed']).includes(pending.status))
      assert.equal(pending.jobId, repairVerificationLedger ? '0a50b4531cf81fe72ed685578f54fd32' : repairReadinessLedger ? 'c51cb0c5b125cc3480f3a72a1c724a89' : 'a5b676bca6cc8eec3f790d870869de78')
      let published
      const session = await new SystemSsh().openInteractiveSession(destination, { authentication: 'password', credential: process.env.SSH_HOST_2 })
      try {
        const client = new NetdataClient({ ssh: session.ssh, connectionUrl: destination, actionKey: server.actionKey })
        const job = await client.jobStatus(pending.jobId)
        assert.equal(job.state, repairVerificationLedger ? 'failed' : 'succeeded'); assert.equal(job.exitCode, repairVerificationLedger ? 1 : 0); assert.equal(job.timedOut, false)
        const transport = new RemoteRecoveryTransport({ client, platform: 'linux' })
        assert.equal((await transport.key()).fingerprint, key.fingerprint)
        if (repairVerificationLedger) {
          published = await transport.read(executionId, 72)
          assert.equal(planFingerprint(published), saved.head)
          assert.ok(job.stdout.includes('magento-indexers-valid'))
        } else if (repairReadinessLedger) {
          assert.ok(job.stdout.includes('magento-installed'))
          const staged = await session.ssh.execute(destination, "sudo -S -p '' sh -c " + quote("set -eu; base64 -w0 /var/lib/intentaiops/recovery/.write-lock/payload; printf '\\n'; base64 -w0 /var/lib/intentaiops/recovery/.write-lock/signature; printf '\\n'"), { input: process.env.SSH_HOST_2 + '\n', timeoutMs: 60000, maxOutputBytes: 10000 })
          const [payload, signature] = staged.stdout.trim().split('\n').map(value => Buffer.from(value, 'base64'))
          const domain = 'intentaiops.remote-common-task.v1\n'
          assert.ok(payload.toString().startsWith(domain))
          assert.equal(createHash('sha256').update(payload).digest('hex'), 'e50a1551bed7c6f95c9f5b797351be213b7dccdea1300ddb2b90af92ec83c1df')
          assert.equal(createHash('sha256').update(signature).digest('hex'), 'd28b0db7a2fc30a3c20632f4f0448f5e2c4150dedbeae60f8817f52d6c1c3ef8')
          published = { format: 'intentaiops-remote-recovery', version: 1, algorithm: 'ECDSA-P256-SHA256', keyFingerprint: key.fingerprint, payload: payload.subarray(Buffer.byteLength(domain)).toString('base64url'), signature: signature.toString('base64url') }
        } else {
          const envelopes = []
          for (let sequence = 1; sequence <= 59; sequence++) envelopes.push(await transport.read(executionId, sequence))
          const chain = verifyRecoveryChain(envelopes, { ...key, target, pinnedFingerprint: key.fingerprint })
          assert.equal(chain.sequence, 59)
          published = envelopes.at(-1)
          assert.equal(chain.head, '315cd6c9df1ffbe641c60af6006360c21a5620f2449bdfc0f6de8b022ce1431c')
        }
      } finally { await session.close() }
      const verified = verifyRecoveryRecord(published, { ...key, target, pinnedFingerprint: key.fingerprint })
      const original = tasks.get(hostId, 23)
      if (!repairVerificationLedger) assert.equal(verified.previousHash, repairReadinessLedger ? saved.head : '4dd69fbaee09ffa940138bbc8bb15b9cb3c9e70baeb6ed8430da21ae8e5bda5a')
      assert.equal(verified.executionId, executionId)
      assert.equal(verified.sequence, repairVerificationLedger ? 72 : repairReadinessLedger ? 67 : 59)
      assert.equal(verified.taskId, 23)
      assert.equal(verified.catalogId, 'magento-linux')
      assert.equal(verified.event, repairVerificationLedger ? 'command_acknowledged' : 'execution_recovery')
      assert.equal(verified.commandId, commandId)
      assert.equal(verified.attemptId, pending.attemptId)
      assert.equal(verified.jobId, pending.jobId)
      assert.equal(verified.revision, planFingerprint(original.plan))
      assert.equal(verified.commandDigest, planFingerprint(original.plan.commands.find(c => c.id === verified.commandId)))
      const storage = '/var/lib/intentaiops/recovery'
      const execution = `${storage}/${executionId}`
      const lock = `${storage}/.write-lock`
      const quarantine = `${storage}/${repairVerificationLedger ? 'reviewed-empty-lock-magento-23-verification-20261021' : repairReadinessLedger ? 'reviewed-staged-lock-magento-23-readiness-20261021' : 'reviewed-empty-lock-magento-23-installation-20261021'}`
      const sequence = repairVerificationLedger ? 72 : repairReadinessLedger ? 66 : 59
      const head = repairVerificationLedger || repairReadinessLedger ? saved.head : planFingerprint(published)
      const completion = recoveryRecord({ ...saved.manifest, revision: planFingerprint(original.plan) }, { type: repairVerificationLedger ? 'command_failed' : 'command_completed', commandId: verified.commandId, commandDigest: verified.commandDigest, attemptId: verified.attemptId, metadata: { jobId: verified.jobId } }, { sequence: sequence + 1, previousHash: head })
      const placeholder = 'f'.repeat(32)
      let append = await recoveryStorageCommand('linux', 'append', { record: completion, owner: placeholder, fingerprint: key.fingerprint })
      assert.equal(append.split(quote(placeholder)).length, 2)
      append = append.replace(quote(placeholder), '"$owner"')
      const checks = [
        'set -eu', `test ! -L ${quote(storage)}; test ! -L ${quote(execution)}; test ! -L ${quote(lock)}`,
        `test "$(stat -c '%u:%g:%a:%h' ${quote(lock)})" = '0:0:700:2'`,
        `test "$(stat -c '%d:%i:%Y' ${quote(lock)})" = ${quote(repairVerificationLedger ? '2050:396104:1792584889' : repairReadinessLedger ? '2050:395624:1792583342' : '2050:395620:1792580306')}`,
        ...(repairReadinessLedger
          ? [
          `test "$(find ${quote(lock)} -mindepth 1 -maxdepth 1 -printf '%f\\n' | LC_ALL=C sort | tr '\\n' ' ')" = 'payload record signature '`,
          ...[['payload', 1126, 'e50a1551bed7c6f95c9f5b797351be213b7dccdea1300ddb2b90af92ec83c1df'], ['signature', 71, 'd28b0db7a2fc30a3c20632f4f0448f5e2c4150dedbeae60f8817f52d6c1c3ef8'], ['record', 0, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855']].map(([name, size, hash]) => `test ! -L ${quote(`${lock}/${name}`)}; test "$(stat -c '%u:%g:%a:%h:%s' ${quote(`${lock}/${name}`)})" = ${quote(`0:0:600:1:${size}`)}; test "$(sha256sum ${quote(`${lock}/${name}`)} | cut -d ' ' -f 1)" = ${quote(hash)}`)
            ]
          : [`test -z "$(find ${quote(lock)} -mindepth 1 -maxdepth 1 -print)"`]),
        `test "$(cat ${quote(`${execution}/head`)})" = ${quote(`${sequence} ${head}`)}`,
        `test ! -e ${quote(`${execution}/${sequence + 1}.json`)}; test ! -L ${quote(`${execution}/${sequence + 1}.json`)}`,
        `test ! -e ${quote(quarantine)}; test ! -L ${quote(quarantine)}`,
        `test ! -L ${quote(`${execution}/owner`)}; test "$(stat -c '%u:%g:%a:%h:%s' ${quote(`${execution}/owner`)})" = '0:0:600:1:32'`,
        `test "$(sha256sum ${quote(`${execution}/owner`)} | cut -d ' ' -f 1)" = ${quote(createHash('sha256').update(saved.owner).digest('hex'))}`,
        "for file in /proc/[0-9]*/cmdline; do if [ -r \"$file\" ] && grep -zFxq intentaiops-recovery \"$file\" 2>/dev/null; then printf 'Active recovery helper; refuse lock quarantine\\n' >&2; exit 78; fi; done",
        'if pgrep -x gnusync >/dev/null || pgrep -x sync >/dev/null || pgrep -x openssl >/dev/null; then exit 78; fi',
        'gnusync --version | grep -Fq "GNU coreutils"', `mv ${quote(lock)} ${quote(quarantine)}`, `gnusync -- ${repairReadinessLedger ? ['payload', 'signature', 'record'].map(name => quote(`${quarantine}/${name}`)).join(' ') + ' ' : ''}${quote(`${execution}/${sequence}.json`)} ${quote(`${execution}/head`)} ${quote(execution)} ${quote(quarantine)} ${quote(storage)}`,
        ...(finalizeMagentoLedger || repairReadinessLedger || repairVerificationLedger ? [`owner=$(cat ${quote(`${execution}/owner`)})`, `${append} >/dev/null`] : []), "printf '%s\\n' reviewed-empty-lock-preserved"
      ]
      const command = { id: 'preserve-reviewed-empty-lock', command: checks.join('; '), purpose: 'Preserve only the verified empty inactive lock; do not execute application work or modify signed history', risk: 'change', timeoutMs: 300000, executionMode: 'job', requiresSudo: true, phase: 'cleanup', diagnostic: null, dependsOn: [] }
      const plan = { summary: 'Review empty Magento installation-ledger lock quarantine', changeOverview: 'Keep all 59 signed records and keys unchanged. Preserve the exact empty lock to allow ordinary authoritative job reconciliation.', modifiedFiles: [lock, quarantine], assumptions: ['Pinned key and complete signed chain verified; original installation job succeeded; lock identity and absence of active helpers will be rechecked'], warnings: ['This does not approve application replay, restart or rollback. Signed history must not be rewound.'], requiresConfirmation: true, commands: [command], revertCommands: [{ ...command, id: 'refuse-stale-lock-restoration', command: "printf 'Do not restore a stale global lock; inspect the preserved quarantine\\n' >&2; exit 1", purpose: 'Refuse automatic restoration of an abandoned lock', risk: 'read', timeoutMs: 30000 }] }
      if (repairVerificationLedger) {
        command.purpose = 'Preserve only the exact empty inactive lock and sign the authoritative failed verification outcome; no application command replay'
        plan.summary = 'Review verification-ledger repair after confirmed nonzero result'
        plan.assumptions = ['Pinned key and acknowledged record 72 verified; original verification failed with exit 1; exact empty lock identity and no active helpers will be rechecked']
      } else if (repairReadinessLedger) {
        command.purpose = 'Preserve the exact inactive staging files, including the verified unpublished observation signature, then sign the original successful read-only job completion without replay'
        plan.summary = 'Review preservation of inactive Magento readiness-ledger staging'
        plan.assumptions = ['Pinned key and local signed checkpoint 66 verified; signed staged observation matches the exact approved readiness attempt; original job succeeded; artifact hashes and absence of helpers will be rechecked']
      }
      validateCommandPlan(plan, rootExecutionPolicy({}))
      if (repairVerificationLedger && pending.status === 'uncertain') {
        const current = await view(23)
        await operation({ action: 'resolve', taskId: 23, commandId, status: 'failed', expectedVersion: current.stateVersion, evidence: 'Authoritative original Stage 2 verification job 0a50b4531cf81fe72ed685578f54fd32 failed, exit 1, timedOut=false. Indexer verification passed, later predicate unknown. No application command replay authorized.', approved: true })
        assert.equal((await view(23)).task.status, 'partial')
      } else if (repairReadinessLedger) {
        const current = await view(23)
        await operation({ action: 'resolve', taskId: 23, commandId, status: 'completed', expectedVersion: current.stateVersion, evidence: 'Authoritative original Stage 2 readiness job c51cb0c5b125cc3480f3a72a1c724a89 succeeded, exit 0, timedOut=false, magento-installed marker observed. No application command replay is authorized.', approved: true })
        assert.equal((await view(23)).task.status, 'partial')
      } else if (!finalizeMagentoLedger && !repairVerificationLedger) recovery.advance(target, 23, 58, saved.head, published)
      const repair = finalizeMagentoLedger ? tasks.get(hostId, 26) : tasks.create(hostId, repairVerificationLedger ? 'Review exact empty verification-ledger lock preservation and confirmed failed verification receipt' : repairReadinessLedger ? 'Review preservation of exact inactive Magento readiness-ledger staging and confirmed read-only completion' : 'Review preservation of the exact empty inactive Magento installation-ledger lock')
      if (finalizeMagentoLedger || repairReadinessLedger || repairVerificationLedger) {
        plan.modifiedFiles.push(`${execution}/head`, `${execution}/${sequence + 1}.json`)
        plan.changeOverview = repairVerificationLedger ? 'Preserve the exact empty lock and all 72 records. Append the authoritative failed original verification outcome; no application replay or signed-history rewrite.' : repairReadinessLedger ? 'Preserve all three inactive staging artifacts and all 66 existing records. Append confirmed original readiness completion, not the unpublished observation. No application replay or signed-history rewrite.' : 'Preserve the exact empty lock and append confirmed original installation completion; no application replay or signed-history rewrite.'
      }
      if (finalizeMagentoLedger) {
        const review = await view(26)
        const revisionId = tasks.proposeRevision(hostId, 26, plan, review.stateVersion)
        await operation({ action: 'approve', taskId: 26, revisionId, expectedVersion: review.stateVersion, fingerprint: planFingerprint(plan), approved: true })
      } else tasks.savePlan(hostId, repair.id, plan)
      state[repairVerificationLedger ? 'magentoVerificationLedgerRepairTaskId' : repairReadinessLedger ? 'magentoReadinessLedgerRepairTaskId' : 'magentoInstallationLedgerRepairTaskId'] = repair.id
      await record(`Prepared metadata-only repair #${repair.id}; ${repairVerificationLedger ? 'verify original failed result and acknowledged record 72; preserve exact empty lock and append failure 73' : repairReadinessLedger ? 'verified signed unpublished observation and original readiness completion; preserve all staging files and append completion 67' : 'verified and acknowledged existing signed recovery record 59; preserve the exact empty lock'}; no application replay or signed-history rewrite`)
      const review = await view(repair.id)
      await operation({ action: 'execute', taskId: repair.id, expectedVersion: review.stateVersion, fingerprint: review.fingerprint, approved: true })
      assert.ok((await view(repair.id)).commands.every(c => c.status === 'completed'))
      if (finalizeMagentoLedger || repairReadinessLedger || repairVerificationLedger) {
        const envelope = JSON.parse(await inspect(`cat ${quote(`${execution}/${sequence + 1}.json`)}`))
        const record = verifyRecoveryRecord(envelope, { ...key, target, pinnedFingerprint: key.fingerprint })
        assert.equal(planFingerprint(record), planFingerprint(completion))
        recovery.advance(target, 23, sequence, head, envelope)
      }
      await record('Reviewed installation-ledger lock quarantine completed. Reconcile original successful job separately before read-only continuation and rollback.')
    }
    if (continueMagento) {
      assert.deepEqual(selected, ['magento-linux'])
      assert.equal(state.tasks['magento-linux']?.id, 23)
      assert.equal(tasks.get(hostId, state.magentoLedgerRepairTaskId).status, 'completed')
      let current = await view(23)
      const original = tasks.get(hostId, 23)
      if (finalMagentoVerification) {
        assert.equal(tasks.get(hostId, state.magentoVerificationLedgerRepairTaskId).status, 'completed')
        assert.equal(new RemoteRecoveryState(process.env.INTENT_WEB_DATA_ROOT).get(settings.servers[hostId].hostFingerprint, 23).sequence, reviewMagentoHttpTimeout ? 79 : 73)
        assert.equal(current.task.status, 'partial')
        assert.ok(!current.commands.some(c => c.status === 'uncertain'))
        assert.deepEqual(current.commands.filter(c => c.status !== 'completed').map(c => [c.commandId, c.status]), [[reviewMagentoHttpTimeout ? 'verify-magento-final' : 'verify-magento-reviewed', 'failed']])
        if (reviewMagentoHttpTimeout) {
          assert.equal(current.fingerprint, 'b5363473653eee798623830a32c74f3be629ac22ca68df3d1861a6853e169e41')
          const session = await new SystemSsh().openInteractiveSession(destination, { authentication: 'password', credential: process.env.SSH_HOST_2 })
          try {
            const result = await new NetdataClient({ ssh: session.ssh, connectionUrl: destination, actionKey: server.actionKey }).jobStatus('788bba32e7a0620115f34f12b396946c')
            assert.equal(result.state, 'failed'); assert.equal(result.exitCode, 1); assert.equal(result.timedOut, false)
            assert.match(result.stderr, /MAGENTO_VERIFICATION_FAILED:http/u)
            assert.match(result.stderr, /curl: \(28\)/u)
          } finally { await session.close() }
        }
        const completedIds = current.commands.filter(c => c.status === 'completed').map(c => c.commandId)
        const trusted = buildCommonTask('magento-linux', 23, { platform: 'linux', linuxContext: inventory.webminaiLinuxContext, docker: inventory.webminaiDocker }).plan
        assert.equal(planFingerprint(original.plan.revertCommands), planFingerprint(trusted.revertCommands))
        const verify = { ...trusted.commands.find(c => c.id === 'verify-magento'), id: reviewMagentoHttpTimeout ? 'verify-magento-http-reviewed' : 'verify-magento-final', dependsOn: [completedIds.at(-1)] }
        assert.match(verify.command, /MAGENTO_VERIFICATION_FAILED/u)
        assert.match(verify.command, /--max-time 120/u)
        if (reviewMagentoHttpTimeout) assert.equal(verify.command.replace('--max-time 120', '--max-time 60'), original.plan.commands.find(c => c.id === 'verify-magento-final').command)
        const revised = { ...original.plan, summary: 'Review labelled read-only Magento verification after confirmed failed probe', warnings: [...original.plan.warnings, reviewMagentoHttpTimeout ? 'The labelled HTTP probe reached its 60-second client deadline, not the native execution deadline. Direct 120-second probes served the marker on loopback and the host address. Only that HTTP bound changes; normal approval and all completed history remain intact.' : 'Previous verification failed after its indexer check; its exact predicate is unconfirmed. Fresh version, PONG and HTTP-marker probes passed. This read-only retry uses check labels and a 120-second HTTP bound. No installation, readiness, startup or reindex replay.'], commands: [...original.plan.commands.filter(c => completedIds.includes(c.id)), verify] }
        validateCommandPlan(revised, rootExecutionPolicy({}))
        const revisionId = tasks.proposeRevision(hostId, 23, revised, current.stateVersion)
        await record(`Prepared final Magento verification revision #${revisionId}; only one labelled read-only command changes, all completed commands remain immutable, no application replay`)
        await operation({ action: 'approve', taskId: 23, revisionId, expectedVersion: current.stateVersion, fingerprint: planFingerprint(revised), approved: true })
      } else if (resumeMagentoApproved) {
        assert.equal(state.magentoReadinessLedgerRepairTaskId, 27)
        assert.equal(tasks.get(hostId, 27).status, 'completed')
        assert.equal(new RemoteRecoveryState(process.env.INTENT_WEB_DATA_ROOT).get(settings.servers[hostId].hostFingerprint, 23).sequence, 67)
        assert.equal(current.task.status, 'partial')
        assert.ok(!current.commands.some(c => ['uncertain', 'failed'].includes(c.status)))
        assert.deepEqual(current.commands.filter(c => c.status !== 'completed').map(c => c.commandId), ['verify-magento-reviewed'])
        assert.equal(current.fingerprint, '588ff501e5290c74d7e807b3e532bad79a3d8a9cc5060bc8da073300c0179492')
        await record('Review resume of existing Magento revision #28: only the pending strong verification may run. Both original installer and read-only readiness jobs are confirmed complete and signed; no plan replacement or application replay.')
      } else if (reviewMagentoReadiness) {
        await operation({ action: 'reconcile', taskId: 23, expectedVersion: current.stateVersion })
        current = await view(23)
        assert.ok(!current.commands.some(c => c.status === 'uncertain'), 'Existing installation job must finish and reconcile before continuation; never replay it')
        const installation = current.commands.find(c => c.commandId === 'initialize-magento')
        assert.ok(['completed', 'failed'].includes(installation.status))
        const completedIds = current.commands.filter(c => c.status === 'completed').map(c => c.commandId)
        assert.deepEqual(completedIds.filter(id => id !== 'initialize-magento'), ['capture-baseline', 'prepare-docker', 'generate-credentials', 'write-compose', 'pull-images', 'prepare-code', 'prepare-magento-swap', 'start-dependencies', 'reconcile-search-probe', 'verify-search-reviewed'])
        assert.equal(current.commands.find(c => c.commandId === 'verify-magento').status, 'pending')
        assert.equal((await inspect('set -eu; if pgrep -x docker >/dev/null || pgrep -x docker-compose >/dev/null; then exit 78; fi; test "$(docker ps -aq | sort)" = "$(docker ps -q --filter label=com.docker.compose.project=webminai-magento-18108 | sort)"; test "$(docker ps -q --filter label=com.docker.compose.project=webminai-magento-18108 | wc -l)" = 6; printf reviewed-owned-running-project')).trim(), 'reviewed-owned-running-project')
        const trusted = buildCommonTask('magento-linux', 23, { platform: 'linux', linuxContext: inventory.webminaiLinuxContext, docker: inventory.webminaiDocker }).plan
        assert.equal(planFingerprint(original.plan.revertCommands), planFingerprint(trusted.revertCommands))
        const installer = trusted.commands.find(c => c.id === 'initialize-magento')
        const suffix = installer.command.slice(installer.command.indexOf('ready=;'))
        assert.ok(installer.command.includes('ready=;'))
        assert.doesNotMatch(suffix, /setup:install|indexer:reindex|cache:flush|up -d|deploy:mode:set/u)
        const readiness = { ...installer, id: 'finish-magento-readiness', phase: 'verify', risk: 'read', timeoutMs: 1800000, dependsOn: [completedIds.at(-1)], purpose: 'Separately reviewed read-only cron and cold HTTP readiness; no installation, reindexing, container startup or image replay', command: 'set -eu; address=127.0.0.1; cd /opt/webminai/services/magento; ' + suffix }
        const verify = { ...trusted.commands.find(c => c.id === 'verify-magento'), id: 'verify-magento-reviewed', dependsOn: [readiness.id] }
        const revised = { ...original.plan, summary: 'Review only remaining Magento readiness and actual indexer state after authoritative reconciliation', warnings: [...original.plan.warnings, 'Completed commands remain unchanged. The original installer is never replayed. HTTP/cron checks are read-only and bounded; uncertain results block continuation.'], commands: [...original.plan.commands.filter(c => completedIds.includes(c.id)), readiness, verify] }
        validateCommandPlan(revised, rootExecutionPolicy({}))
        const revisionId = tasks.proposeRevision(hostId, 23, revised, current.stateVersion)
        await record(`Prepared Magento read-only readiness revision #${revisionId}; original job reconciled, no installation/startup/reindex replay, actual indexer state required`)
        await operation({ action: 'approve', taskId: 23, revisionId, expectedVersion: current.stateVersion, fingerprint: planFingerprint(revised), approved: true })
      } else {
        assert.equal(current.task.status, 'partial')
        assert.ok(!current.commands.some(c => c.status === 'uncertain'))
        const completed = ['capture-baseline', 'prepare-docker', 'generate-credentials', 'write-compose', 'pull-images', 'prepare-code', 'prepare-magento-swap', 'start-dependencies']
        const pending = ['verify-search', 'initialize-magento', 'verify-magento']
        assert.deepEqual(current.commands.filter(c => c.status === 'completed').map(c => c.commandId), completed)
        assert.deepEqual(current.commands.filter(c => c.status === 'pending').map(c => c.commandId), reviewSearchTimeout ? pending.slice(1) : pending)
        if (reviewSearchTimeout) {
          const failed = current.commands.filter(c => c.status === 'failed')
          assert.equal(failed.length, 1)
          assert.equal(failed[0].commandId, 'verify-search')
          assert.equal(failed[0].jobId, '1c2d49e36c139dfb4ad7bdca26759eec')
          assert.equal(tasks.get(hostId, 23).results.find(r => r.id === 'verify-search').result.exitCode, 28)
        }
        const checks = [
          'set -eu', 'if pgrep -x docker >/dev/null || pgrep -x docker-compose >/dev/null; then exit 78; fi',
          'test "$(docker ps -aq | sort)" = "$(docker ps -q --filter label=com.docker.compose.project=webminai-magento-18108 | sort)"',
          'test "$(docker ps -q --filter label=com.docker.compose.project=webminai-magento-18108 | wc -l)" = 5',
          'for service in db opensearch valkey; do test "$(docker inspect webminai-magento-18108-$service-1 --format \'{{.State.Health.Status}}\')" = healthy; done',
          'cd /opt/webminai/services/magento',
          'docker compose -p webminai-magento-18108 exec -T magento test ! -e /var/www/html/app/etc/env.php',
          'count=$(docker compose -p webminai-magento-18108 exec -T db sh -c \'MYSQL_PWD="$(cat /run/secrets/db_root_password)" mariadb -u root --batch --skip-column-names -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=0x7765626d696e61695f6d6167656e746f5f3138313038"\'); test "$count" = 0',
          'printf reviewed-existing-dependencies-empty-app-database'
        ]
        assert.equal((await inspect(checks.join('; '))).trim(), 'reviewed-existing-dependencies-empty-app-database')
        const trusted = buildCommonTask('magento-linux', 23, { platform: 'linux', linuxContext: inventory.webminaiLinuxContext, docker: inventory.webminaiDocker }).plan
        assert.equal(planFingerprint(original.plan.revertCommands), planFingerprint(trusted.revertCommands))
        for (const id of reviewSearchTimeout ? ['verify-magento'] : ['verify-search', 'verify-magento']) assert.equal(planFingerprint(original.plan.commands.find(c => c.id === id)), planFingerprint(trusted.commands.find(c => c.id === id)))
        const installer = trusted.commands.find(c => c.id === 'initialize-magento')
        assert.equal(original.plan.commands.find(c => c.id === installer.id).command.replace('--admin-firstname=Intent AI Ops', '--admin-firstname=Intent'), installer.command)
        let remaining = trusted.commands.filter(c => pending.includes(c.id))
        if (reviewSearchTimeout) {
          const container = (await inspect("docker inspect webminai-magento-18108-opensearch-1 --format '{{.Id}}'")).trim()
          assert.match(container, /^[a-f0-9]{64}$/u)
          const php = [
            'function request($method,$path){$h=curl_init("http://opensearch:9200".$path);curl_setopt_array($h,[CURLOPT_RETURNTRANSFER=>true,CURLOPT_CONNECTTIMEOUT=>10,CURLOPT_TIMEOUT=>150,CURLOPT_CUSTOMREQUEST=>$method,CURLOPT_NOBODY=>$method==="HEAD",CURLOPT_FOLLOWLOCATION=>false]);$body=curl_exec($h);if($body===false){throw new RuntimeException("request unavailable");}$status=curl_getinfo($h,CURLINFO_RESPONSE_CODE);curl_close($h);return [$status,$body===""?null:json_decode($body,true,512,JSON_THROW_ON_ERROR)];}',
            'try{[$status,$rows]=request("GET","/_cat/indices/intentaiops_probe_23?format=json&h=index,uuid,docs.count,creation.date");if($status!==200||count($rows)!==1||$rows[0]["index"]!=="intentaiops_probe_23"||$rows[0]["uuid"]!=="kE2cn-7JRNWfNofTIdhI_Q"||$rows[0]["docs.count"]!=="0"||$rows[0]["creation.date"]!=="1792577571102"){exit(78);}[$status,$result]=request("DELETE","/intentaiops_probe_23?timeout=120s&cluster_manager_timeout=120s");if($status!==200||($result["acknowledged"]??false)!==true){exit(1);}[$status]=request("HEAD","/intentaiops_probe_23");if($status!==404){exit(1);}echo "reviewed-empty-probe-removed";}catch(Throwable $error){fwrite(STDERR,"OPENSEARCH_PROBE_REVIEW_REQUIRED\n");exit(1);}'
          ].join(' ')
          const cleanup = { id: 'reconcile-search-probe', phase: 'cleanup', risk: 'change', requiresSudo: true, executionMode: 'job', timeoutMs: 300000, dependsOn: ['start-dependencies'], diagnostic: null, purpose: 'Review and remove only the observed empty index left by the timed-out request, bound to container identity, index UUID and creation time; never repeat an uncertain mutation', command: `set -eu; test "$(docker inspect webminai-magento-18108-opensearch-1 --format '{{.Id}}')" = ${quote(container)}; cd /opt/webminai/services/magento; docker compose -p webminai-magento-18108 exec -T magento php -r ${quote(php)}` }
          const probe = { ...remaining.find(c => c.id === 'verify-search'), id: 'verify-search-reviewed', dependsOn: [cleanup.id] }
          remaining = [cleanup, probe, { ...installer, dependsOn: [probe.id] }, remaining.find(c => c.id === 'verify-magento')]
        }
        const revised = { ...original.plan, summary: 'Review remaining Magento search and installation after confirmed startup', warnings: [...original.plan.warnings, reviewSearchTimeout ? 'The prior index-create request timed out. The observed empty index must match its exact UUID, creation time and container before reviewed cleanup. New bounded API requests do not retry unknown mutations.' : 'Original startup succeeded and is signed. Preserve completed history. Only pending search/installation/verification run; the installer first-name argument is corrected.'], commands: [...original.plan.commands.filter(c => completed.includes(c.id)), ...remaining] }
        validateCommandPlan(revised, rootExecutionPolicy({}))
        const revisionId = tasks.proposeRevision(hostId, 23, revised, current.stateVersion)
        await record(`Prepared Magento continuation revision #${revisionId}: all eight completed commands remain immutable; no image/build/code/startup replay; ${reviewSearchTimeout ? 'UUID-bound empty-index reconciliation and longer bounded cold-index checks' : 'pending installer quoting fix'} require fresh approval`)
        await operation({ action: 'approve', taskId: 23, revisionId, expectedVersion: current.stateVersion, fingerprint: planFingerprint(revised), approved: true })
      }
      current = await view(23)
      await operation({ action: 'resume', taskId: 23, expectedVersion: current.stateVersion, fingerprint: current.fingerprint, approved: true })
      current = await view(23)
      assert.equal(current.task.status, 'completed')
      assert.ok(current.commands.every(c => c.status === 'completed'))
      await operation({ action: 'rollback', taskId: 23, expectedVersion: current.stateVersion, fingerprint: current.rollbackFingerprint, approved: true })
      const restored = tasks.get(hostId, 23)
      assert.equal(restored.status, 'reverted')
      assert.ok(restored.revertResults.every(c => c.status === 'completed'))
      assert.equal(await inspect(runtimeBaseline), await readFile(path.join(directory, '23-magento-linux-runtime.before.txt'), 'utf8'))
      const paths = original.plan.modifiedFiles
      assert.ok(paths.every(value => /^\/[a-zA-Z0-9_./-]+$/u.test(value) && !value.split('/').includes('..')))
      const probe = `set -eu; for p in ${paths.map(quote).join(' ')}; do if [ -e "$p" ] || [ -L "$p" ]; then stat -c '%n %F %u:%g %a' -- "$p"; else printf 'absent %s\\n' "$p"; fi; done`
      assert.equal(await inspect(probe), await readFile(path.join(directory, '23-magento-linux-paths.before.txt'), 'utf8'))
      state.tasks['magento-linux'].status = 'reverted'
      await record('magento-linux: PASS with separately reviewed continuation, real OpenSearch indexing/search, Magento installation/reindexing/cron/HTTP verification, reviewed rollback and matching runtime/path baselines. Original startup was never replayed.')
    }
    const cleanupMattermost = process.argv.includes('--review-mattermost-cleanup')
    if (cleanupMattermost) {
      assert.deepEqual(selected, ['mattermost-linux'])
      assert.equal(state.tasks['mattermost-linux']?.id, 14)
      const recovery = new RemoteRecoveryState(process.env.INTENT_WEB_DATA_ROOT)
      const target = settings.servers[hostId].hostFingerprint
      const saved = recovery.get(target, 14)
      assert.equal(saved.manifest.executionId, '7558126a97397070555bded8b9da5e87')
      assert.equal(saved.sequence, 21)
      const storage = '/var/lib/intentaiops/recovery'
      const execution = `${storage}/${saved.manifest.executionId}`
      const envelope = JSON.parse(await inspect(`cat ${quote(`${execution}/22.json`)}`))
      const key = recovery.currentKey(target)
      const published = verifyRecoveryRecord(envelope, { ...key, target, pinnedFingerprint: key.fingerprint })
      assert.equal(published.sequence, 22)
      assert.equal(published.previousHash, saved.head)
      assert.equal(published.executionId, saved.manifest.executionId)
      assert.equal(published.taskId, 14)
      assert.equal(published.event, 'execution_recovery')
      const publishedHash = planFingerprint(envelope)
      assert.equal(publishedHash, '83e6bafa9ccc66b8e2460b96ad7682ac39aa92a2ea1f3f841b7527102b6a069a')
      const lock = `${storage}/.write-lock`
      const quarantine = `${storage}/reviewed-stale-lock-mattermost-14-20261021`
      const checks = [
        'set -eu', '! pgrep -x openssl >/dev/null', '! pgrep -x sync >/dev/null', '! pgrep -x docker >/dev/null', '! pgrep -x docker-compose >/dev/null',
        `test ! -L ${quote(storage)}`, `test ! -L ${quote(lock)}`, `test "$(stat -c '%u:%g:%a' ${quote(lock)})" = '0:0:700'`,
        ...[`${lock}/head`, `${lock}/payload`, `${lock}/signature`, `${execution}/head`, `${execution}/22.json`].map(file => `test ! -L ${quote(file)}; test "$(stat -c '%F:%u:%g:%a:%h' ${quote(file)})" = 'regular file:0:0:600:1'`),
        `test "$(find ${quote(lock)} -mindepth 1 -maxdepth 1 -printf '%f\\n' | LC_ALL=C sort)" = "$(printf 'head\\npayload\\nsignature')"`,
        `test ! -e ${quote(quarantine)}`, `test ! -L ${quote(quarantine)}`, `test ! -e ${quote(`${execution}/23.json`)}`,
        `test "$(cat ${quote(`${execution}/head`)})" = ${quote(`21 ${saved.head}`)}`,
        `test "$(cat ${quote(`${lock}/head`)})" = ${quote(`22 ${publishedHash}`)}`,
        `printf '%s  %s\\n' ${quote(publishedHash)} ${quote(`${execution}/22.json`)} 'a4f4956b7469dd18974a63380e323813ee75de262d20e85bc8879280b8223e44' ${quote(`${lock}/head`)} '11ef2b10c301acb0135278f1c4cec7f5c2d359d234691abf7cd9263874d202cb' ${quote(`${lock}/payload`)} '689aa6513a433d23a0abbda08f642b4c0fd240b78713ed835cca89b260ec0e98' ${quote(`${lock}/signature`)} | sha256sum -c - >/dev/null`,
        `cp -p ${quote(`${execution}/head`)} ${quote(`${lock}/head.before`)}`, `mv ${quote(`${lock}/head`)} ${quote(`${execution}/head`)}`, 'sync', `mv ${quote(lock)} ${quote(quarantine)}`, 'sync', "printf '%s\\n' reviewed-ledger-head-repaired"
      ]
      const item = { id: 'repair-reviewed-ledger-head', command: checks.join('; '), purpose: 'Complete the verified published record head and quarantine only the inspected stale lock; preserve all original artifacts and signing keys', risk: 'change', timeoutMs: 300000, executionMode: 'job', requiresSudo: true, phase: 'cleanup', diagnostic: null, dependsOn: [] }
      const plan = { summary: 'Reviewed Mattermost ledger metadata repair', changeOverview: 'No application commands or signing-key changes. Advance the head to the already verified signed record and preserve the stale lock in quarantine.', modifiedFiles: [lock, quarantine, `${execution}/head`], assumptions: ['Remote Mattermost job was authoritatively observed succeeded; no active Docker client, OpenSSL or sync writer was found'], warnings: ['This repairs ledger metadata only. It does not authorize replay, rollback or continuation of Mattermost. Undoing an append-only history repair is not automatic.'], requiresConfirmation: true, commands: [item], revertCommands: [{ ...item, id: 'refuse-ledger-history-rewind', command: "printf '%s\\n' 'Ledger history must not be rewound automatically; inspect the preserved quarantine' >&2; exit 1", purpose: 'Refuse an automatic history rewind after subsequent records may exist', risk: 'read', timeoutMs: 30000 }] }
      validateCommandPlan(plan, rootExecutionPolicy({}))
      const pending = await view(14)
      assert.equal(pending.commands.find(command => command.id === 'start-compose' || command.commandId === 'start-compose').status, 'uncertain')
      await operation({ action: 'resolve', taskId: 14, commandId: 'start-compose', status: 'completed', expectedVersion: pending.stateVersion, evidence: 'Authoritative signed native job 674d37d17f7209d9754a660cb0054150 retrieved after verified SSH reconnection: succeeded, exit 0, timedOut=false; task-owned containers running and PostgreSQL healthy. No replay authorized.', approved: true })
      assert.equal((await view(14)).task.status, 'partial')
      const repair = state.ledgerRepairTaskId ? tasks.get(hostId, state.ledgerRepairTaskId) : tasks.create(hostId, 'Operator-reviewed repair of verified published Mattermost recovery record and stale lock, without replaying application work')
      if (state.ledgerRepairTaskId) {
        assert.equal(repair.status, 'planned')
        assert.equal(planFingerprint(repair.plan), planFingerprint(plan))
        assert.ok(tasks.executionState(hostId, repair.id).every(command => command.status === 'pending'), 'Previously dispatched repair must be reconciled, not replayed')
      } else tasks.savePlan(hostId, repair.id, plan)
      state.ledgerRepairTaskId = repair.id
      state.pausedByOperator = false
      await record(`Prepared metadata-only ledger repair task #${repair.id}; verified signed record #22 extends local/remote head #21; preserve stale lock artifacts`)
      const review = await view(repair.id)
      await operation({ action: 'execute', taskId: repair.id, expectedVersion: review.stateVersion, fingerprint: review.fingerprint, approved: true })
      assert.ok((await view(repair.id)).commands.every(command => command.status === 'completed'))
      assert.equal((await inspect(`cat ${quote(`${execution}/head`)}`)).trim(), `22 ${publishedHash}`)
      recovery.advance(target, 14, 21, saved.head, envelope)
      await record('Reviewed ledger repair completed; locally acknowledged the verified signed remote record, no application command replayed')
      const current = await view(14)
      await operation({ action: 'reconcile', taskId: 14, expectedVersion: current.stateVersion })
      assert.ok(!(await view(14)).commands.some(command => command.status === 'uncertain'))
    }
    if (process.argv.includes('--review-prestashop-pull') || process.argv.includes('--review-moodle-build') || process.argv.includes('--review-mattermost-verification') || process.argv.includes('--review-ghost-readiness')) {
      const moodle = process.argv.includes('--review-moodle-build')
      const verifyMattermost = process.argv.includes('--review-mattermost-verification')
      const verifyGhost = process.argv.includes('--review-ghost-readiness')
      const catalogId = moodle ? 'moodle-linux' : verifyMattermost ? 'mattermost-linux' : verifyGhost ? 'ghost-linux' : 'prestashop-linux'
      assert.deepEqual(selected, [catalogId])
      const id = state.tasks[catalogId]?.id
      assert.ok(Number.isSafeInteger(id) && id > 0)
      let current = await view(id)
      assert.equal(current.task.status, 'partial')
      assert.ok(!current.commands.some(command => command.status === 'uncertain'))
      assert.deepEqual(current.commands.filter(command => command.status === 'completed').map(command => command.commandId ?? command.id), ['capture-baseline', 'prepare-docker', 'generate-credentials', 'write-compose', ...(moodle ? ['prepare-moodle-swap'] : verifyMattermost ? ['start-compose'] : verifyGhost ? ['acquire-images'] : [])])
      if (verifyMattermost) assert.deepEqual(current.commands.filter(command => command.status === 'pending').map(command => command.commandId ?? command.id), ['verify-compose'])
      else assert.equal(current.commands.find(command => verifyGhost ? command.commandId === 'start-compose' : (command.commandId ?? command.id).startsWith('pull-images')).status, 'failed')
      const containerCheck = moodle ? `test "$(docker ps -a --format '{{.Names}}')" = 'buildx_buildkit_webminai-moodle-${id}0'; docker image inspect 'webminai/moodle:5.2.1-php8.4-fpm-r2' >/dev/null` : verifyGhost ? 'test "$(docker ps -aq | sort)" = "$(docker ps -q --filter label=com.docker.compose.project=webminai-ghost-18110 | sort)"; test "$(docker ps -q --filter label=com.docker.compose.project=webminai-ghost-18110 | wc -l)" = 3; for service in db ghost; do test "$(docker inspect webminai-ghost-18110-$service-1 --format \'{{.State.Health.Status}}\')" = healthy; done' : verifyMattermost ? 'test "$(docker ps -aq | sort)" = "$(docker ps -q --filter label=com.docker.compose.project=webminai-mattermost-18111 | sort)"; test "$(docker ps -q --filter label=com.docker.compose.project=webminai-mattermost-18111 | wc -l)" = 3; test "$(docker inspect webminai-mattermost-18111-db-1 --format \'{{.State.Health.Status}}\')" = healthy' : 'test -z "$(docker ps -aq)"'
      assert.equal((await inspect(`set -eu; if pgrep -x docker >/dev/null || pgrep -x docker-compose >/dev/null; then exit 78; fi; ${containerCheck}; printf inspected-no-active-client`)).trim(), 'inspected-no-active-client')
      const original = tasks.get(hostId, id)
      const trusted = buildCommonTask(catalogId, id, { platform: 'linux', linuxContext: inventory.webminaiLinuxContext, docker: inventory.webminaiDocker, applicationDefaults: await settingsStore.decryptApplicationDefaults({ settings, passphrase: process.env.VAULT_TEST }) }).plan
      if (verifyGhost) {
        assert.equal(id, 22)
        const failed = original.results.find(result => result.id === 'start-compose')
        assert.equal(failed?.result?.exitCode, 1)
        assert.equal(failed?.result?.timedOut, false)
        const start = trusted.commands.find(command => command.id === 'start-compose')
        const before = start.command
        start.command = start.command.replace(/^set -eu; docker compose[^;]+ up -d --pull never; /u, 'set -eu; ')
        assert.notEqual(start.command, before)
        assert.doesNotMatch(start.command, /\b(?:up|pull|build)\b/u)
        start.purpose = 'Separately reviewed read-only readiness continuation for already-running owned services; do not recreate containers, rebuild images or repeat database initialization'
      }
      if (moodle) {
        const failed = original.results.find(result => result.id === 'pull-images')
        assert.equal(failed?.result?.timedOut, true, 'Reconcile the authoritative acquisition result before revising')
        const baseline = await readFile(path.join(directory, `${id}-${catalogId}-runtime.before.txt`), 'utf8')
        assert.ok(!baseline.includes('moby/buildkit:'), 'Preexisting BuildKit image must not be removed')
        const acquisition = trusted.commands.find(command => command.id === 'pull-images')
        acquisition.command = `set -eu; docker buildx rm --force ${quote(`webminai-moodle-${id}`)} >/dev/null; docker image rm 'moby/buildkit:buildx-stable-1' >/dev/null; ${acquisition.command}`
        acquisition.purpose = 'Separately reviewed cleanup of this timed-out attempt’s builder, reuse its completed Moodle image, then finish trusted image acquisition'
      }
      if (verifyMattermost) {
        assert.equal(planFingerprint(original.plan.commands.find(command => command.id === 'verify-compose')), planFingerprint(trusted.commands.find(command => command.id === 'verify-compose')))
        assert.equal(planFingerprint(original.plan.revertCommands), planFingerprint(trusted.revertCommands))
        await record('Reviewed Mattermost post-reconnection continuation: startup is confirmed complete, all three owned containers running, PostgreSQL healthy, only unchanged catalog verification remains. Preserve conservative saved risk classification; approve resume separately, never repeat startup.')
      } else {
        const revised = regenerateCatalogRevision(original, tasks.executionState(hostId, id), trusted)
        validateCommandPlan(revised, rootExecutionPolicy({}))
        const revisionId = tasks.proposeRevision(hostId, id, revised, current.stateVersion)
        await record(`Proposed ${catalogId} continuation revision #${revisionId}; no active Docker client, completed setup preserved. ${verifyGhost ? 'Confirmed Nginx probe connection reset after successful service startup; read-only readiness and verification only, no startup replay.' : moodle ? 'Confirmed execution timeout; reviewed task-owned builder cleanup and reuse of the completed image, no OOM claim.' : 'Confirmed Docker CDN timeout; serialize pulls and quiet progress.'} Fresh approval required.`)
        await operation({ action: 'approve', taskId: id, revisionId, expectedVersion: current.stateVersion, fingerprint: planFingerprint(revised), approved: true })
      }
      current = await view(id)
      await operation({ action: 'resume', taskId: id, expectedVersion: current.stateVersion, fingerprint: current.fingerprint, approved: true })
      current = await view(id)
      assert.equal(current.task.status, 'completed')
      assert.ok(current.commands.every(command => command.status === 'completed'))
      await operation({ action: 'rollback', taskId: id, expectedVersion: current.stateVersion, fingerprint: current.rollbackFingerprint, approved: true })
      const restored = tasks.get(hostId, id)
      assert.equal(restored.status, 'reverted')
      assert.ok(restored.revertResults.every(result => result.status === 'completed'))
      assert.equal(await inspect(runtimeBaseline), await readFile(path.join(directory, `${id}-${catalogId}-runtime.before.txt`), 'utf8'))
      const paths = original.plan.modifiedFiles
      assert.ok(paths.every(value => /^\/[a-zA-Z0-9_./-]+$/u.test(value) && !value.split('/').includes('..')))
      const pathProbe = `set -eu; for p in ${paths.map(quote).join(' ')}; do if [ -e "$p" ] || [ -L "$p" ]; then stat -c '%n %F %u:%g %a' -- "$p"; else printf 'absent %s\\n' "$p"; fi; done`
      assert.equal(await inspect(pathProbe), await readFile(path.join(directory, `${id}-${catalogId}-paths.before.txt`), 'utf8'))
      state.tasks[catalogId].status = 'reverted'
      await record(`${catalogId}: PASS with ${verifyMattermost ? 'separately reviewed post-reconnection continuation without startup replay' : verifyGhost ? 'separately reviewed read-only readiness continuation without startup replay' : 'separately reviewed acquisition revision'}, application verification, rollback and runtime/path baseline comparison.`)
    }
    const cleanupGhostBuild = process.argv.includes('--review-ghost-build-cleanup')
    const cleanupGhost = process.argv.includes('--review-ghost-cleanup') || cleanupGhostBuild
    const cleanupMagento = process.argv.includes('--review-magento-cleanup')
    const cleanupCpu = (cleanupGhost && !cleanupGhostBuild) || cleanupMagento
    const cleanupPartial = process.argv.includes('--review-wordpress-cleanup') || cleanupCpu || cleanupMattermost || cleanupGhostBuild
    if (cleanupPartial) {
      const catalogId = cleanupGhost ? 'ghost-linux' : cleanupMagento ? 'magento-linux' : cleanupMattermost ? 'mattermost-linux' : 'wordpress-linux'
      if (cleanupCpu || cleanupGhostBuild) assert.deepEqual(selected, [catalogId])
      const id = state.tasks[catalogId]?.id
      assert.ok(Number.isSafeInteger(id) && id > 0)
      let current = await view(id)
      assert.equal(current.task.status, 'partial')
      assert.ok(!current.commands.some(command => command.status === 'uncertain'))
      const project = cleanupGhost ? 'webminai-ghost-18110' : cleanupMagento ? 'webminai-magento-18108' : cleanupMattermost ? 'webminai-mattermost-18111' : 'webminai-wordpress-18101'
      const baselineFile = cleanupCpu || cleanupMattermost || cleanupGhostBuild ? 'packages.before' : 'docker-ready.before'
      const family = cleanupGhost ? 'ghost' : cleanupMagento ? 'magento' : cleanupMattermost ? 'mattermost' : 'wordpress'
      const observed = await inspect(`set -eu; if pgrep -x docker >/dev/null || pgrep -x docker-compose >/dev/null; then exit 78; fi; test "$(docker ps -aq | sort)" = "$(docker ps -aq --filter label=com.docker.compose.project=${project} | sort)"; test -e /var/lib/webminai/task-state/${id}-${family}-compose/${baselineFile}; printf '%s\\n' reviewed-project-only`)
      assert.equal(observed.trim(), 'reviewed-project-only')
      const original = tasks.get(hostId, id)
      let trusted = buildCommonTask(catalogId, id, { platform: 'linux', linuxContext: inventory.webminaiLinuxContext, docker: inventory.webminaiDocker }).plan
      if (cleanupGhostBuild) {
        assert.equal(id, 21)
        assert.equal(planFingerprint(original.plan.revertCommands), 'd6d667056d53105673633c89f4ab31629f07ce7f5dc7c8be13684ba9ee7362c4')
        assert.equal((await inspect('set -eu; test "$(cat /var/lib/webminai/task-state/21-ghost-compose/image-profile)" = compat; test "$(docker image inspect intentaiops/ghost-mysql:8.4.13-bookworm-task-21 --format \'{{.Id}}\')" = "$(cat /var/lib/webminai/task-state/21-ghost-compose/compat-image.after)"; ! docker buildx inspect intentaiops-ghost-mysql-21 >/dev/null 2>&1; printf reviewed-image-ownership')).trim(), 'reviewed-image-ownership')
        trusted = original.plan
      }
      assert.equal(planFingerprint(original.plan.revertCommands), planFingerprint(trusted.revertCommands), 'Cleanup must match trusted catalog rollback exactly')
      const revised = { ...trusted, commands: trusted.revertCommands, revertCommands: [], operatorRollback: true }
      validateCommandPlan(revised, rootExecutionPolicy({}), { requireRevert: false })
      const revisionId = tasks.proposeRevision(hostId, id, revised, current.stateVersion)
      await record(`Proposed separately reviewed partial ${catalogId} cleanup #${revisionId}; only task-owned project changes, retain Docker setup #${state.dockerTaskId}`)
      await operation({ action: 'approve', taskId: id, revisionId, expectedVersion: current.stateVersion, fingerprint: planFingerprint(revised), approved: true })
      current = await view(id)
      await operation({ action: 'rollback', taskId: id, revisionId, expectedVersion: current.stateVersion, fingerprint: planFingerprint(revised), approved: true })
      const restored = tasks.get(hostId, id)
      assert.equal(restored.status, 'reverted')
      assert.ok(restored.revertResults.every(result => result.status === 'completed'))
      assert.equal((await inspect('docker ps -aq')).trim(), '')
      if (cleanupGhostBuild) {
        assert.equal(await inspect(runtimeBaseline), await readFile(path.join(directory, `${id}-${catalogId}-runtime.before.txt`), 'utf8'))
        const paths = original.plan.modifiedFiles
        assert.ok(paths.every(value => /^\/[a-zA-Z0-9_./-]+$/u.test(value) && !value.split('/').includes('..')))
        const probe = `set -eu; for p in ${paths.map(quote).join(' ')}; do if [ -e "$p" ] || [ -L "$p" ]; then stat -c '%n %F %u:%g %a' -- "$p"; else printf 'absent %s\\n' "$p"; fi; done`
        assert.equal(await inspect(probe), await readFile(path.join(directory, `${id}-${catalogId}-paths.before.txt`), 'utf8'))
        state.failedGhostBuildTaskId = id
        delete state.tasks[catalogId]
        await record('Ghost #21 partial initialization cleaned through separately reviewed saved rollback; runtime/path baselines restored. Missing mysqladmin fixed in the recipe; a fresh lifecycle test is required.')
      } else if (cleanupCpu) {
        assert.equal(await inspect(runtimeBaseline), await readFile(path.join(directory, `${id}-${catalogId}-runtime.before.txt`), 'utf8'))
        const paths = original.plan.modifiedFiles
        assert.ok(paths.every(value => /^\/[a-zA-Z0-9_./-]+$/u.test(value) && !value.split('/').includes('..')))
        const probe = `set -eu; for p in ${paths.map(quote).join(' ')}; do if [ -e "$p" ] || [ -L "$p" ]; then stat -c '%n %F %u:%g %a' -- "$p"; else printf 'absent %s\\n' "$p"; fi; done`
        assert.equal(await inspect(probe), await readFile(path.join(directory, `${id}-${catalogId}-paths.before.txt`), 'utf8'))
        state.tasks[catalogId].cleanupReverted = true
        state.tasks[catalogId].status = 'blocked-cpu'
        await record(`${catalogId} partial attempt rolled back with matching runtime/path baselines. Confirmed image rejects x86-64-v2-incompatible CPU; not an application pass.`)
        const prepared = await operation({ action: 'prepare', catalogId, request: `Verify the ${catalogId} CPU prerequisite rejects this known incompatible host before creating any task state or credentials` })
        const probeId = prepared.results[0].taskId
        state.tasks[catalogId].prerequisiteTaskId = probeId
        await record(`Saved ${catalogId} CPU prerequisite test #${probeId}; expected fail-closed result, not deployment`)
        current = await view(probeId)
        assert.equal(current.task.status, 'planned')
        const probePaths = current.task.plan.modifiedFiles
        assert.ok(probePaths.every(value => /^\/[a-zA-Z0-9_./-]+$/u.test(value) && !value.split('/').includes('..')))
        const prerequisitePaths = `set -eu; for p in ${probePaths.map(quote).join(' ')}; do if [ -e "$p" ] || [ -L "$p" ]; then stat -c '%n %F %u:%g %a' -- "$p"; else printf 'absent %s\\n' "$p"; fi; done`
        const prerequisiteBaseline = await inspect(prerequisitePaths)
        await operation({ action: 'execute', taskId: probeId, expectedVersion: current.stateVersion, fingerprint: current.fingerprint, approved: true })
        current = await view(probeId)
        assert.equal(current.commands[0].status, 'failed')
        assert.ok(current.commands.slice(1).every(command => command.status === 'pending'))
        assert.ok(current.task.results[0].diagnostics.some(value => value.code === 'CPU_INSTRUCTION_SET_UNSUPPORTED'))
        assert.equal(await inspect(runtimeBaseline), await readFile(path.join(directory, `${id}-${catalogId}-runtime.before.txt`), 'utf8'))
        assert.equal(await inspect(prerequisitePaths), prerequisiteBaseline)
        state.tasks[catalogId].prerequisiteVerified = true
        await record(`${catalogId} CPU prerequisite rejection verified through the real binary: no later commands dispatched, no task paths or runtime changes. Application remains hardware-blocked.`)
      } else if (cleanupMattermost) {
        assert.equal(await inspect(runtimeBaseline), await readFile(path.join(directory, `${id}-${catalogId}-runtime.before.txt`), 'utf8'))
        const paths = original.plan.modifiedFiles
        assert.ok(paths.every(value => /^\/[a-zA-Z0-9_./-]+$/u.test(value) && !value.split('/').includes('..')))
        const probe = `set -eu; for p in ${paths.map(quote).join(' ')}; do if [ -e "$p" ] || [ -L "$p" ]; then stat -c '%n %F %u:%g %a' -- "$p"; else printf 'absent %s\\n' "$p"; fi; done`
        assert.equal(await inspect(probe), await readFile(path.join(directory, `${id}-${catalogId}-paths.before.txt`), 'utf8'))
        state.recoveredMattermostTaskId = id
        delete state.tasks[catalogId]
        await record('Mattermost #14 reconciled without replay, then reviewed cleanup matched runtime/path baselines. A fresh application retest is now required.')
      } else {
        state.recoveredWordpressTaskId = id
        delete state.tasks['wordpress-linux']
        await record('Partial WordPress attempt cleaned through reviewed catalog rollback. Not counted as a cold lifecycle pass; original task history retained.')
      }
    }
    if (process.argv.includes('--review-ghost-compatible-image')) {
      assert.deepEqual(selected, ['ghost-linux'])
      const prior = state.tasks['ghost-linux']
      assert.equal(prior.status, 'blocked-cpu')
      assert.equal(prior.cleanupReverted, true)
      assert.equal(tasks.get(hostId, prior.id).status, 'reverted')
      assert.equal(await inspect(runtimeBaseline), await readFile(path.join(directory, `${prior.id}-ghost-linux-runtime.before.txt`), 'utf8'))
      assert.equal((await inspect('docker ps -aq')).trim(), '')
      state.previousGhostTaskId = prior.id
      state.previousGhostPrerequisiteTaskId = prior.prerequisiteTaskId
      delete state.tasks['ghost-linux']
      await record('Operator-authorized fresh Ghost compatibility-image test: prior attempt cleaned, runtime baseline verified, original history retained. CPU evidence alone selects the maintained MySQL image variant; no existing database is reused or downgraded.')
    }
    if (process.argv.includes('--review-magento-compatible-image')) {
      assert.deepEqual(selected, ['magento-linux'])
      const prior = state.tasks['magento-linux']
      assert.equal(prior.status, 'blocked-cpu')
      assert.equal(prior.cleanupReverted, true)
      assert.equal(tasks.get(hostId, prior.id).status, 'reverted')
      assert.equal(await inspect(runtimeBaseline), await readFile(path.join(directory, `${prior.id}-magento-linux-runtime.before.txt`), 'utf8'))
      assert.equal((await inspect('docker ps -aq')).trim(), '')
      state.previousMagentoTaskId = prior.id
      state.previousMagentoPrerequisiteTaskId = prior.prerequisiteTaskId
      delete state.tasks['magento-linux']
      await record('Operator-authorized fresh Magento compatibility-image test: previous attempt cleaned and runtime baseline verified. Keep official OpenSearch as default; CPU evidence alone selects the maintained minimal OpenSearch/Java 21 build. No existing data adopted.')
    }
    const catalog = cleanupPartial || repairMagentoLedger || repairMagentoInstallationLedger || continueMagento ? [] : await request('/catalog?host=' + hostId)
    for (const catalogId of cleanupPartial || repairMagentoLedger || repairMagentoInstallationLedger || continueMagento ? [] : selected.length ? selected : applications) {
      if (state.tasks[catalogId]?.status === 'blocked-cpu') {
        assert.equal(state.tasks[catalogId].cleanupReverted, true)
        assert.equal(state.tasks[catalogId].prerequisiteVerified, true)
        assert.equal(tasks.get(hostId, state.tasks[catalogId].id).status, 'reverted')
        await record(catalogId + ': skipped as verified hardware-incompatible, not an application pass')
        continue
      }
      if (state.tasks[catalogId]?.status === 'reverted') {
        const saved = tasks.get(hostId, state.tasks[catalogId].id)
        assert.equal(saved.catalogId, catalogId)
        assert.equal(saved.status, 'reverted')
        assert.ok(saved.revertResults.length && saved.revertResults.every(result => result.status === 'completed'))
        continue
      }
      assert.ok(!state.tasks[catalogId], 'Previously accepted application work must be reconciled; do not create a duplicate task')
      assert.ok(catalog.some(task => task.id === catalogId && task.eligible), catalogId + ' is not eligible')
      assert.equal((await inspect('docker ps -aq')).trim(), '', 'Previous application containers remain; refuse overlapping tests')
      const baseline = await inspect(runtimeBaseline)
      const prepared = await operation({ action: 'prepare', catalogId, request: 'Validate ' + catalogId + ' on the low-powered netbook using its verified Docker Compose route, then review rollback to the pre-task baseline' })
      const id = prepared.results[0].taskId
      await writeFile(path.join(directory, `${id}-${catalogId}-runtime.before.txt`), baseline, { flag: 'wx', mode: 0o600 })
      const paths = (await view(id)).task.plan.modifiedFiles
      assert.ok(Array.isArray(paths) && paths.length > 0 && paths.length <= 128)
      assert.ok(paths.every(value => typeof value === 'string' && /^\/[a-zA-Z0-9_./-]+$/u.test(value) && !value.split('/').includes('..')))
      const pathProbe = `set -eu; for p in ${paths.map(quote).join(' ')}; do if [ -e "$p" ] || [ -L "$p" ]; then stat -c '%n %F %u:%g %a' -- "$p"; else printf 'absent %s\\n' "$p"; fi; done`
      const pathBaseline = await inspect(pathProbe)
      await writeFile(path.join(directory, `${id}-${catalogId}-paths.before.txt`), pathBaseline, { flag: 'wx', mode: 0o600 })
      state.tasks[catalogId] = { id, status: 'awaiting-review' }
      await record(`${catalogId}: saved task #${id}; review before sequential execution`)
      await reviewedExecution(id)
      state.tasks[catalogId].status = 'completed'
      await record(catalogId + ': application command and health checks completed')
      const current = await view(id)
      assert.ok(!current.commands.some(command => command.status === 'uncertain'))
      await operation({ action: 'rollback', taskId: id, expectedVersion: current.stateVersion, fingerprint: current.rollbackFingerprint, approved: true })
      const restored = tasks.get(hostId, id)
      assert.equal(restored.status, 'reverted', 'Rollback did not restore the application baseline; stop before another application')
      assert.ok(restored.revertResults.every(result => result.status === 'completed'))
      assert.equal((await inspect('docker ps -aq')).trim(), '', 'Rollback left containers; stop before another application')
      assert.equal(await inspect(runtimeBaseline), baseline, 'Rollback changed the pre-task images, volumes or networks; inspect before continuing')
      assert.equal(await inspect(pathProbe), pathBaseline, 'Rollback changed catalog path existence, type, ownership or permissions; inspect before continuing')
      state.tasks[catalogId].status = 'reverted'
      await record(catalogId + ': PASS; reviewed rollback completed and Docker containers, image references, volumes and networks match the pre-task baseline')
    }
    if (restoreDocker) {
      const setupObserved = await inspect(setupBaselineCommand)
      assert.equal(preserveReviewedUpgrades ? originalPackageVersions(setupObserved) : setupObserved, await readFile(path.join(directory, 'after-setup.txt'), 'utf8'), 'Setup baseline drift detected; preserve unrelated Docker work and inspect before removing the runtime')
      await writeFile(path.join(directory, 'before-docker-packages.txt'), await inspect(`cat /var/lib/webminai/tasks/${state.dockerTaskId}/linux-docker/packages.before`), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      let current = await view(state.dockerTaskId)
      assert.ok((await readFile(path.join(directory, 'before-docker-network.txt'), 'utf8')).startsWith('===FORWARDING===\n0\n0\n'), 'Original forwarding evidence does not match the reviewed restoration')
      const original = tasks.get(hostId, state.dockerTaskId)
      const commands = original.plan.revertCommands.map(command => ({ ...command, dependsOn: [...command.dependsOn] }))
      if (preserveReviewedUpgrades) {
        const verification = commands.find(command => command.id === 'verify-docker-baseline')
        const comparison = "cmp -s '/var/lib/webminai/tasks/1/linux-docker/baseline.sha256' '/var/lib/webminai/tasks/1/linux-docker/final.sha256'"
        assert.ok(verification?.command.includes(comparison), 'Unknown baseline verifier, refuse to alter its checks')
        const expressions = reviewedUpgrades.map(([name, before, after]) => `-e ${quote('s|^' + name + '=' + after.replaceAll('.', '\\.') + '$|' + name + '=' + before + '|')}`).join(' ')
        const checks = reviewedUpgrades.map(([name, , after]) => `grep -Fxq ${quote(name + '=' + after)} '/var/lib/webminai/tasks/1/linux-docker/packages.final'`).join(' && ')
        verification.command = verification.command.replace(comparison, `( ${checks} && sed ${expressions} '/var/lib/webminai/tasks/1/linux-docker/packages.final' | cmp -s '/var/lib/webminai/tasks/1/linux-docker/packages.before' - )`)
        verification.purpose = 'Require the original package and path baseline except the three exact operator-approved package upgrades; never downgrade or rewrite original evidence'
        delete verification.source
        await record('Operator approved preserving exactly the recorded ca-certificates, liblzma5:amd64 and xz-utils upgrades. All other baseline checks remain required; original evidence is unchanged.')
      }
      const removeState = commands.find(command => command.id === 'remove-docker-task-state')
      assert.ok(removeState)
      const network = { id: 'restore-reviewed-forwarding', phase: 'cleanup', command: 'set -eu; ! command -v docker >/dev/null 2>&1; sysctl -w net.ipv4.ip_forward=0 net.ipv6.conf.all.forwarding=0 >/dev/null; test "$(cat /proc/sys/net/ipv4/ip_forward)" = 0; test "$(cat /proc/sys/net/ipv6/conf/all/forwarding)" = 0; printf forwarding-restored', purpose: 'Operator-reviewed restoration of the separately captured pre-install IPv4/IPv6 forwarding values, not an unchanged catalog rollback command', risk: 'change', requiresSudo: true, timeoutMs: 30000, dependsOn: [...removeState.dependsOn] }
      commands.splice(commands.indexOf(removeState), 0, network)
      removeState.dependsOn = [network.id]
      const revised = { ...original.plan, commands, revertCommands: [], operatorRollback: true, modifiedFiles: [...original.plan.modifiedFiles, '/proc/sys/net/ipv4/ip_forward', '/proc/sys/net/ipv6/conf/all/forwarding'] }
      validateCommandPlan(revised, rootExecutionPolicy({}), { requireRevert: false })
      const revisionId = tasks.proposeRevision(hostId, state.dockerTaskId, revised, current.stateVersion)
      await record('Proposed separate Docker rollback revision including recorded forwarding restoration; no blind firewall reset or inherited approval')
      await operation({ action: 'approve', taskId: state.dockerTaskId, revisionId, expectedVersion: current.stateVersion, fingerprint: planFingerprint(revised), approved: true })
      current = await view(state.dockerTaskId)
      await operation({ action: 'rollback', taskId: state.dockerTaskId, revisionId, expectedVersion: current.stateVersion, fingerprint: planFingerprint(revised), approved: true })
      assert.equal(tasks.get(hostId, state.dockerTaskId).status, 'reverted')
      state.dockerRestored = true
      await record('Reviewed Docker rollback completed. Monitoring removal and original-host baseline comparison remain; do not claim full host restoration yet.')
    } else if (!repairMagentoLedger) await record('Selected application tests finished. Docker/Stage 2 restoration remains a separate reviewed final step; do not claim original-host restoration yet.')
  }
} catch (error) { await record('STOPPED: ' + safe(error.message)); throw new Error(safe(error.message)) } finally { await cli.close() }
