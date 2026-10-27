import assert from 'node:assert/strict'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, appendFile, chmod, rename } from 'node:fs/promises'
import { launchLabCli } from '../browser-checks/lab-cli.js'
import { SystemSsh } from '../src/system-ssh.js'
import { buildCommonTask, listCommonTasks } from '../src/common-tasks.js'
import { SettingsStore } from '../src/settings-store.js'
import { TaskStore } from '../src/task-store.js'
import { redactDiagnosticText } from '../src/error-details.js'
import { planFingerprint } from '../src/execution-journal.js'
import { validateCommandPlan } from '../src/plan-validator.js'
import { rootExecutionPolicy } from '../src/execution-policy.js'
import { stageInstallSource } from './validate-linux-common-tasks.js'
import { freebsdNginxSecurityCommand } from '../src/freebsd-nginx-security.js'
import { parallelMap } from '../src/multi-host-service.js'
import { verifyFreebsdPodmanBrowser } from '../browser-checks/freebsd-podman-apps.js'

assert.ok(process.argv.includes('--approve-live-tests'), 'Explicit live-lab approval required')
assert.ok(process.env.VAULT_TEST, 'VAULT_TEST required')
const hosts = ['webminai-freebsd-14-4', 'webminai-freebsd-15-1']
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const selectedHost = option('host'); const selectedTask = option('task')
const podmanCandidates = process.argv.includes('--podman-candidates')
const installationChecks = process.argv.includes('--installation-checks')
const absentRuntime = process.argv.includes('--absent-runtime')
assert.ok(!installationChecks || (!podmanCandidates && selectedHost && ['podman-freebsd', 'intent-ai-ops-freebsd'].includes(selectedTask)), 'Installation checks require one explicit runtime or CLI task and separate state')
const flags = new Set(['--approve-live-tests', '--podman-candidates', '--retest-preflight', '--parallel-hosts', '--verify-replay-guards', '--update-stage2', '--cleanup-confirmed-failure', '--retest-cleaned', '--retest-reverted', '--resume-prepared', '--refresh-failed', '--reconcile-only', '--repair-network', '--restore-network', '--repair-ghost-nginx', '--restore-ghost-security', '--keep-runtime', '--restore-runtime', '--setup-only', '--include-maintenance', '--replace-undispatched'])
assert.ok(process.argv.slice(2).every(argument => flags.has(argument) || ['--installation-checks', '--absent-runtime', '--resume-paused', '--refresh-paused'].includes(argument) || argument.startsWith('--host=') || argument.startsWith('--task=')), 'Unknown lab option')
assert.ok(!absentRuntime || (installationChecks && selectedTask === 'podman-freebsd'), 'Absent-runtime checks require the isolated Podman installation workflow')
assert.ok(!podmanCandidates || (selectedHost && ['odoo-freebsd', 'home-assistant-freebsd', 'magento-freebsd', 'ghost-freebsd', 'n8n-freebsd', 'mattermost-freebsd', 'jellyfin-freebsd'].includes(selectedTask) && process.argv.slice(2).every(argument => ['--approve-live-tests', '--podman-candidates', '--cleanup-confirmed-failure', '--retest-reverted', '--retest-preflight', '--refresh-failed', '--refresh-paused', '--resume-paused', '--resume-prepared', '--replace-undispatched'].includes(argument) || argument.startsWith('--host=') || argument.startsWith('--task='))), 'Podman candidates require one explicit supported host/application and isolated candidate state')
assert.ok(!podmanCandidates || ['--cleanup-confirmed-failure', '--retest-reverted', '--retest-preflight', '--refresh-failed', '--refresh-paused', '--resume-paused', '--resume-prepared', '--replace-undispatched'].filter(flag => process.argv.includes(flag)).length <= 1, 'Choose one candidate recovery operation')
assert.ok(!process.argv.includes('--retest-preflight') || (podmanCandidates && !process.argv.includes('--refresh-failed') && !process.argv.includes('--resume-prepared')), 'Preflight retest requires one isolated candidate without continuation flags')
const updatePlugin = process.argv.includes('--update-stage2')
const parallelHosts = process.argv.includes('--parallel-hosts')
const verifyReplayGuards = process.argv.includes('--verify-replay-guards')
assert.ok(!verifyReplayGuards || process.argv.slice(2).every(argument => ['--approve-live-tests', '--verify-replay-guards'].includes(argument) || argument.startsWith('--host=')), 'Replay guards cannot be mixed with changing task or recovery workflows')
assert.ok(!parallelHosts || (!selectedHost && process.argv.slice(2).every(argument => ['--approve-live-tests', '--parallel-hosts'].includes(argument) || (argument === '--refresh-failed' && selectedTask) || argument.startsWith('--task='))), 'Parallel testing permits only independent host matrices or an explicitly selected failed catalog task, not scoped recovery or maintenance operations')
const cleanupFailure = process.argv.includes('--cleanup-confirmed-failure')
const retestCleaned = process.argv.includes('--retest-cleaned')
const resumePrepared = process.argv.includes('--resume-prepared')
const resumePaused = process.argv.includes('--resume-paused')
const refreshPaused = process.argv.includes('--refresh-paused')
const refreshRemaining = process.argv.includes('--refresh-failed') || refreshPaused
const keepRuntime = process.argv.includes('--keep-runtime')
const retestReverted = process.argv.includes('--retest-reverted')
const restoreRuntime = process.argv.includes('--restore-runtime')
const reconcileOnly = process.argv.includes('--reconcile-only')
const repairNetwork = process.argv.includes('--repair-network')
const restoreNetwork = process.argv.includes('--restore-network')
const repairGhostNginx = process.argv.includes('--repair-ghost-nginx')
const restoreGhostSecurity = process.argv.includes('--restore-ghost-security')
assert.ok(!restoreGhostSecurity || (selectedHost === 'webminai-freebsd-15-1' && selectedTask === 'ghost-freebsd' && process.argv.slice(2).every(argument => ['--approve-live-tests', '--restore-ghost-security'].includes(argument) || argument.startsWith('--host=') || argument.startsWith('--task='))), 'Security staging cleanup requires the explicit reverted 15.1 Ghost task and no other operation')
assert.ok(!repairGhostNginx || (selectedHost === 'webminai-freebsd-15-1' && selectedTask === 'ghost-freebsd' && process.argv.slice(2).every(argument => ['--approve-live-tests', '--repair-ghost-nginx'].includes(argument) || argument.startsWith('--host=') || argument.startsWith('--task='))), 'nginx security repair requires the explicit paused 15.1 Ghost task and no other operation')
assert.ok(!refreshPaused || (selectedHost && selectedTask && process.argv.slice(2).every(argument => ['--approve-live-tests', '--refresh-paused', '--podman-candidates'].includes(argument) || argument.startsWith('--host=') || argument.startsWith('--task='))), 'Paused catalog refresh requires one explicit task and no other operation')
assert.ok(!resumePaused || (selectedHost && selectedTask && process.argv.slice(2).every(argument => ['--approve-live-tests', '--resume-paused', '--podman-candidates'].includes(argument) || argument.startsWith('--host=') || argument.startsWith('--task='))), 'Paused continuation requires one explicit task and no other operation')
assert.ok(!(repairNetwork && restoreNetwork), 'Choose network setup or restoration, not both')
assert.ok(!(repairNetwork || restoreNetwork) || (selectedHost === 'webminai-freebsd-14-4' && selectedTask === 'podman-freebsd' && !restoreRuntime && !keepRuntime && !retestReverted && !reconcileOnly && !refreshRemaining && !resumePrepared && !cleanupFailure && !retestCleaned && !updatePlugin), 'Network repair requires the explicit 14.4 Podman prerequisite')
assert.ok(!reconcileOnly || (selectedHost && selectedTask && !restoreRuntime && !keepRuntime && !retestReverted && !refreshRemaining && !resumePrepared && !cleanupFailure && !retestCleaned && !updatePlugin), 'Reconciliation requires one explicit saved task')
assert.ok(!restoreRuntime || (selectedHost && selectedTask === 'podman-freebsd' && !keepRuntime && !retestReverted && !refreshRemaining && !resumePrepared && !cleanupFailure && !retestCleaned && !updatePlugin), 'Runtime restoration requires one explicit retained Podman task')
assert.ok(!retestReverted || ((podmanCandidates || (selectedHost === 'webminai-freebsd-14-4' && ['jellyfin-freebsd', 'n8n-freebsd'].includes(selectedTask))) && !keepRuntime && !refreshRemaining && !resumePrepared && !cleanupFailure && !retestCleaned && !updatePlugin), 'Reverted retest is limited to the inspected 14.4 Jellyfin or n8n cycle, or an isolated Podman candidate')
assert.ok(!keepRuntime || (selectedHost && selectedTask === 'podman-freebsd' && !resumePrepared && !cleanupFailure && !retestCleaned && !updatePlugin), 'Retained runtime requires an explicit Podman task')
assert.ok(!refreshRemaining || ((selectedHost || parallelHosts) && selectedTask && !resumePrepared && !cleanupFailure && !retestCleaned && !updatePlugin), 'Catalog continuation requires one explicit failed task')
assert.ok(!updatePlugin || process.argv.includes('--setup-only'), 'Plugin updates must be separate from application execution')
assert.ok(!cleanupFailure || (selectedHost && selectedTask && !updatePlugin && !process.argv.includes('--setup-only')), 'Failure cleanup requires one explicit host and task')
assert.ok(!retestCleaned || (selectedHost && selectedTask && !cleanupFailure && !updatePlugin), 'Retest requires one cleaned task')
assert.ok(!resumePrepared || (selectedHost && selectedTask && !cleanupFailure && !retestCleaned && !updatePlugin), 'Resuming preparation requires one explicit host and task')
assert.ok(!selectedHost || hosts.includes(selectedHost))
assert.ok(!selectedTask || listCommonTasks({ platform: 'freebsd' }).some(task => task.id === selectedTask))
const directory = path.resolve(installationChecks ? 'artifacts/freebsd-installation' : podmanCandidates ? 'artifacts/freebsd-podman' : 'artifacts/freebsd-common', ...(absentRuntime ? ['absent-runtime'] : []))
await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700)
const stateFile = path.join(directory, 'state.json')
let state
try { state = JSON.parse(await readFile(stateFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error; state = { hosts: {} } }
let checkpointSettings
for (const hostId of selectedHost ? [selectedHost] : hosts) {
  const saved = state.hosts[hostId]
  if (!saved || !Object.keys(saved.tasks).length) continue
  const dataRoot = process.env.WEBMINAI_DATA_ROOT ?? '/home/vscode/.intentaiops'
  checkpointSettings ??= await new SettingsStore(dataRoot).load()
  assert.ok(checkpointSettings.servers[hostId], 'Checkpoint host is missing from this vault; re-add and verify it before continuation')
  const tasks = new TaskStore(dataRoot, { directoryAliases: new Map([[hostId, checkpointSettings.servers[hostId].historyId]]) })
  assertCheckpointTasks(saved, state.observedAt, id => tasks.get(hostId, id))
}
const safe = text => redactDiagnosticText(String(text).replaceAll(process.env.VAULT_TEST, '[redacted]')).replace(/[\r\n]+/gu, ' ').slice(0, 1600).trim()
let writes = Promise.resolve()
let stopScheduling = null
async function record (message) {
  const observedAt = new Date().toISOString()
  writes = writes.then(async () => {
    state.observedAt = observedAt
    await writeFile(stateFile + '.tmp', JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
    await rename(stateFile + '.tmp', stateFile)
    const line = observedAt + ' ' + safe(message)
    await appendFile('freebsd-lab-validation-status.md', '\n- ' + line + '\n')
    console.log(line)
  })
  return writes
}
const config = path.resolve('artifacts/freebsd-common/ssh_config')
const connection = host => `ssh://${host}?config=${encodeURIComponent(config)}`
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'"
async function inspect (host, command) {
  const ssh = new SystemSsh()
  try {
    const result = await ssh.execute(connection(host), 'sudo -n sh -c ' + quote(command), { timeoutMs: 60000, maxOutputBytes: 1024 * 1024 })
    assert.equal(result.code, 0)
    return result.stdout
  } finally { await ssh.closeSessions() }
}
const packages = "pkg query '%n=%v' | LC_ALL=C sort"
const accounts = "set -eu; printf 'users\\n'; getent passwd | awk -F: '{print $1 \":\" $3 \":\" $4 \":\" $6 \":\" $7}' | LC_ALL=C sort; printf 'groups\\n'; getent group | awk -F: '{print $1 \":\" $3 \":\" $4}' | LC_ALL=C sort"
function catalogPathProbe (paths) {
  assert.ok(paths.every(value => typeof value === 'string' && /^\/[a-zA-Z0-9_./-]+$/u.test(value) && !value.split('/').includes('..')), 'Unexpected catalog path requires review')
  return paths.length ? `set -eu; for p in ${paths.map(quote).join(' ')}; do if test -e "$p" || test -L "$p"; then stat -f '%N %HT %u:%g %Lp' "$p"; if test -f "$p" && ! test -L "$p"; then sha256 -q "$p"; fi; else printf 'absent %s\\n' "$p"; fi; done` : 'true'
}
const baseline = `set -eu; printf '===OS===\\n'; uname -sr; printf '===PACKAGES===\\n'; ${packages}; printf '===SERVICES===\\n'; service -e | LC_ALL=C sort; printf '===FILES===\\n'; for p in /etc/rc.conf /etc/fstab /etc/sysctl.conf; do if test -f "$p"; then sha256 -q "$p"; else printf 'absent %s\\n' "$p"; fi; done; printf '===RESOURCES===\\n'; sysctl -n hw.physmem; swapinfo -k; df -k /; printf '===RUNTIMES===\\n'; command -v podman || true; command -v netdata || true; printf '===APP-PATHS===\\n'; find /var/db -maxdepth 1 -type d -name 'webminai*' -print; printf '===PORTS===\\n'; sockstat -4l`
for (const host of selectedHost ? [selectedHost] : hosts) {
  if (absentRuntime && !state.hosts[host]?.tasks['podman-freebsd']) assert.equal(await inspect(host, 'set -eu; test -z "$(command -v podman || true)"; for p in /var/db/containers /usr/local/etc/containers; do test ! -e "$p"; test ! -L "$p"; done; printf absent'), 'absent', 'Absent-runtime check must not adopt an existing installation')
  state.hosts[host] ??= { tasks: {} }
  if (!state.hosts[host].baselineSaved) {
    const observed = await inspect(host, baseline)
    await writeFile(path.join(directory, host + '-original.txt'), observed, { flag: 'wx', mode: 0o600 })
    state.hosts[host].baselineSaved = true
    await record(host + ': original read-only baseline saved before host registration or activation')
  }
}
process.env.INTENT_WEB_DATA_ROOT = process.env.WEBMINAI_DATA_ROOT ?? '/home/vscode/.intentaiops'
const cli = await launchLabCli({ actions: true })
state = JSON.parse(await readFile(stateFile, 'utf8'))
const launch = new URL(cli.url); const base = launch.origin + launch.pathname.replace(/\/$/u, '')
let cookie; let csrf
async function request (endpoint, body) {
  const response = await fetch(base + endpoint, { method: body ? 'POST' : 'GET', headers: { Origin: launch.origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json', 'X-Intent-CSRF': csrf ?? '' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000) })
  if (endpoint === '/session') cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const result = await response.json()
  assert.ok(response.ok, result.error ?? `HTTP ${response.status}`)
  return result
}
async function operation (hostId, body) {
  if (stopScheduling && body.action === 'execute') throw new Error('Another host test failed; no new execution dispatched')
  const accepted = await request('/operation', { ...body, hostId, requestKey: randomUUID() })
  state.hosts[hostId].operation = { id: accepted.id, action: body.action, taskId: body.taskId ?? null, status: 'running' }
  await record(`${hostId}: ${body.action} accepted ${accepted.id}, task ${body.taskId ?? '-'}`)
  for (;;) {
    const current = await request('/operation?id=' + accepted.id)
    if (current.status !== 'running') {
      state.hosts[hostId].operation.status = current.status
      await record(`${hostId}: ${body.action} ${current.status}${current.error ? '; ' + current.error : ''}`)
      assert.equal(current.status, 'completed', current.error ?? 'Inspect persisted execution before continuation')
      return current.result
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
}
const view = (host, id) => request(`/task?host=${host}&task=${id}`)
try {
  csrf = (await request('/session', { token: launch.hash.slice(1) })).csrf
  const runHosts = async requested => {
    for (const hostId of requested) {
      const hostState = state.hosts[hostId]
      if (hostState.operation?.status === 'running') {
        assert.equal(hostState.operation.action, 'execute', 'Reconcile previous accepted operation before starting more work')
        const saved = await view(hostId, hostState.operation.taskId)
        assert.equal(saved.task.status, 'completed', 'Reconcile previous accepted operation before starting more work')
        assert.ok(saved.commands.every(command => command.status === 'completed'), 'Incomplete command evidence blocks continuation')
        hostState.operation.status = 'completed'
        await record(`${hostId}: recovered completed operation projection from authoritative task history; no command replay`)
      }
      let host = (await request('/workspace')).hosts.find(value => value.id === hostId)
      if (!host) await operation(hostId, { action: 'host-add', connection: connection(hostId), authentication: 'key' })
      await operation(hostId, { action: 'host-connect' })
      const settings = await new SettingsStore(process.env.INTENT_WEB_DATA_ROOT).load()
      const identity = { historyId: settings.servers[hostId].historyId ?? null, hostFingerprint: settings.servers[hostId].hostFingerprint ?? null }
      hostState.identity ??= identity
      assert.deepEqual(identity, hostState.identity, 'Host identity and history must survive concurrent settings updates')
      const tasks = new TaskStore(process.env.INTENT_WEB_DATA_ROOT, { directoryAliases: new Map([[hostId, settings.servers[hostId].historyId]]) })
      if (reconcileOnly) {
        const source = hostState.tasks[selectedTask]
        assert.ok(source, 'No saved task to reconcile')
        const before = await view(hostId, source.id)
        await operation(hostId, { action: 'reconcile', taskId: source.id, expectedVersion: before.stateVersion })
        const after = await view(hostId, source.id)
        source.status = after.task.status
        await record(`${hostId}/${selectedTask}: reconciled existing job only; task ${after.task.status}; commands ${after.commands.map(command => `${command.commandId}=${command.status}`).join(', ')}; no new application command dispatched`)
        assert.ok(!after.commands.some(command => ['uncertain', 'running'].includes(command.status)), 'Outcome remains unresolved; operator investigation required')
        continue
      }
      assert.equal(tasks.interruptedTasks(hostId).length, 0, 'Interrupted work must be reconciled before testing')
      host = (await request('/workspace')).hosts.find(value => value.id === hostId)
      if (updatePlugin || settings.servers[hostId].desiredStage2 !== 'active') await operation(hostId, { action: updatePlugin ? 'stage2-update' : 'stage2-activate', hostVersion: host.hostVersion, approved: true })
      const inventory = await request('/inventory?host=' + hostId)
      if (podmanCandidates) assert.equal(inventory.webminaiDocker?.preference, 'enabled', 'Explicitly enable the candidate container route in the CLI before testing; Automatic remains native pending qualification')
      await writeFile(path.join(directory, hostId + '-capabilities.json'), JSON.stringify({ execution: inventory.webminaiExecution, docker: inventory.webminaiDocker }, null, 2), { mode: 0o600 })
      const catalog = await request('/catalog?host=' + hostId)
      hostState.eligibility = catalog
      await record(`${hostId}: inventory and ${catalog.length} catalog eligibility decisions saved`)
      if (restoreGhostSecurity) {
        assert.equal((await view(hostId, hostState.tasks['ghost-freebsd'].id)).task.status, 'reverted')
        const repair = hostState.ghostSecurityRepair
        assert.equal(repair?.status, 'completed')
        const saved = await view(hostId, repair.id)
        await operation(hostId, { action: 'rollback', taskId: repair.id, expectedVersion: saved.stateVersion, fingerprint: saved.rollbackFingerprint, approved: true })
        repair.status = (await view(hostId, repair.id)).task.status
        assert.equal(repair.status, 'reverted')
        await record(`${hostId}: security-repair staging removed through reviewed rollback; no vulnerable package restored`)
        continue
      }
      if (repairGhostNginx) {
        const source = hostState.tasks['ghost-freebsd']
        assert.equal(source?.id, 17)
        const paused = await view(hostId, source.id)
        assert.equal(paused.control.action, 'pause')
        assert.equal(paused.task.status, 'partial')
        assert.ok(paused.commands.every(command => ['completed', 'pending'].includes(command.status)))
        assert.equal(await inspect(hostId, "pkg query '%n=%v' nginx"), 'nginx=1.30.5_2,3\n')
        assert.equal(await inspect(hostId, "pkg query '%n=%v' pcre2"), 'pcre2=10.49\n')
        const originalAccounts = await readFile(path.join(directory, `${hostId}-${source.id}-accounts.before`), 'utf8')
        assert.ok(!/^mysqlrouter:/mu.test(originalAccounts), 'Do not claim ownership of an original MySQL Router identity')
        assert.equal(await inspect(hostId, "getent passwd mysqlrouter | awk -F: '{print $1 \":\" $3 \":\" $4}'; getent group mysqlrouter | awk -F: '{print $1 \":\" $3}'"), 'mysqlrouter:394:394\nmysqlrouter:394\n')
        const previousRepair = hostState.ghostSecurityRepair
        const task = previousRepair ? tasks.get(hostId, previousRepair.id) : tasks.create(hostId, 'Review fixed nginx package for paused Ghost validation; retain configured repository defaults', { kind: 'ai' })
        if (previousRepair) {
          assert.equal(task.id, 18)
          assert.equal(task.status, 'partial')
          const commands = tasks.executionState(hostId, task.id)
          assert.equal(commands[0].status, 'failed')
          assert.ok(commands.every(command => ['failed', 'pending'].includes(command.status)), 'Never repeat uncertain security work')
        }
        const statePath = `/var/db/webminai/task-state/${task.id}-ghost-security`
        const preparation = previousRepair ? `test ! -L ${quote(statePath)}; [ "$(stat -f '%u:%Lp' ${quote(statePath)})" = '0:700' ]; test -s ${quote(statePath + '/packages.before')}; pkg query -a '%n=%v' | LC_ALL=C sort > ${quote(statePath + '/packages.current')}; cmp ${quote(statePath + '/packages.before')} ${quote(statePath + '/packages.current')}` : `test ! -e ${quote(statePath)}; test ! -L ${quote(statePath)}; install -d -m 0700 ${quote(statePath)}; pkg query -a '%n=%v' | LC_ALL=C sort > ${quote(statePath + '/packages.before')}`
        const command = `set -eu; ${preparation}; ${freebsdNginxSecurityCommand(statePath)}; pkg query -a '%n=%v' | LC_ALL=C sort > ${quote(statePath + '/packages.after')}; sed '/^nginx=/d' ${quote(statePath + '/packages.before')} > ${quote(statePath + '/other.before')}; sed '/^nginx=/d' ${quote(statePath + '/packages.after')} > ${quote(statePath + '/other.after')}; cmp ${quote(statePath + '/other.before')} ${quote(statePath + '/other.after')}; ! service nginx onestatus >/dev/null 2>&1`
        const plan = { summary: 'Review nginx-only security update before Ghost service exposure', changeOverview: 'Fetch one fixed nginx package using the official signed latest catalogue, verify its identity and update nginx only. Keep all configured repository files and other packages unchanged.', modifiedFiles: [statePath, '/usr/local/sbin/nginx'], assumptions: ['pcre2 10.49 and required FreeBSD base libraries already exist'], warnings: ['The vulnerable nginx version will not be restored. Ghost owns nginx and its separately reviewed rollback removes it.'], commands: [{ id: 'update-ghost-nginx-security', command, purpose: 'Verify signed official package and replace vulnerable task-owned nginx only', risk: 'change', requiresSudo: true, timeoutMs: 1800000, executionMode: 'job', dependsOn: [] }], revertCommands: [] }
        plan.revertCommands.push({ id: 'remove-security-staging', command: `set -eu; if pkg info -e nginx >/dev/null 2>&1; then [ "$(pkg version -t "$(pkg query '%v' nginx)" '1.30.6,3')" != '<' ]; fi; if [ -e ${quote(statePath)} ]; then test ! -L ${quote(statePath)}; [ "$(stat -f '%u' ${quote(statePath)})" = 0 ]; rm -rf -- ${quote(statePath)}; fi`, purpose: 'Remove only root-owned security staging; never restore vulnerable nginx or change application services', risk: 'change', requiresSudo: true, timeoutMs: 300000, dependsOn: [] })
        const ghostState = '/var/lib/webminai/task-state/17-ghost-freebsd'
        plan.modifiedFiles.push(ghostState + '/user-mysqlrouter-created', ghostState + '/group-mysqlrouter-created')
        plan.commands.push({ id: 'reconcile-ghost-router-ownership', command: `set -eu; test -d ${quote(ghostState)}; test ! -L ${quote(ghostState)}; test -f ${quote(ghostState + '/packages.before')}; if grep -Fxq mysql80-server ${quote(ghostState + '/packages.before')}; then echo PREEXISTING_MYSQL_OWNERSHIP >&2; exit 78; fi; for kind in user group; do test ! -L ${ghostState}/$kind-mysqlrouter-created; umask 077; : > ${ghostState}/$kind-mysqlrouter-created; done`, purpose: 'Record separately reviewed MySQL Router ownership from preserved original account and package baselines; completed Ghost history stays immutable', risk: 'change', requiresSudo: true, timeoutMs: 300000, dependsOn: ['update-ghost-nginx-security'] })
        validateCommandPlan(plan, rootExecutionPolicy({}), { requireRevert: false })
        if (previousRepair) {
          const before = await view(hostId, task.id)
          const revisionId = tasks.proposeRevision(hostId, task.id, plan, before.stateVersion)
          await operation(hostId, { action: 'approve', taskId: task.id, revisionId, expectedVersion: before.stateVersion, fingerprint: planFingerprint(plan), approved: true })
        } else tasks.savePlan(hostId, task.id, plan)
        hostState.ghostSecurityRepair = { id: task.id, status: 'awaiting-review' }
        await record(`${hostId}: prepared separate security repair #${task.id}; Ghost remains paused`)
        const saved = await view(hostId, task.id)
        await operation(hostId, { action: 'execute', taskId: task.id, expectedVersion: saved.stateVersion, fingerprint: saved.fingerprint, approved: true })
        hostState.ghostSecurityRepair.status = (await view(hostId, task.id)).task.status
        assert.equal(hostState.ghostSecurityRepair.status, 'completed')
        await record(`${hostId}: fixed nginx verified; no other package changed, no service started, repository defaults unchanged`)
        const originalGhost = tasks.get(hostId, source.id)
        const reviewedGhost = { ...originalGhost.plan, revertCommands: buildCommonTask('ghost-freebsd', source.id, { platform: 'freebsd', freebsdExecution: inventory.webminaiExecution }).plan.revertCommands, warnings: [...originalGhost.plan.warnings, 'Separately inspected original account evidence establishes task-owned mysqlrouter cleanup. Completed commands and pending application commands remain unchanged.'] }
        validateCommandPlan(reviewedGhost, rootExecutionPolicy({}))
        const before = await view(hostId, source.id)
        const revisionId = tasks.proposeRevision(hostId, source.id, reviewedGhost, before.stateVersion)
        await operation(hostId, { action: 'approve', taskId: source.id, revisionId, expectedVersion: before.stateVersion, fingerprint: planFingerprint(reviewedGhost), approved: true })
        source.status = 'planned'
        await record(`${hostId}: separately reviewed Ghost rollback ownership revision ${revisionId}; no completed command rewritten, no application command executed`)
        continue
      }
      if (process.argv.includes('--setup-only')) continue
      if (repairNetwork || restoreNetwork) {
        assert.equal(hostState.tasks['podman-freebsd']?.status, 'prerequisite-ready')
        if (restoreNetwork) {
          const source = hostState.networkRepair
          assert.equal(source?.status, 'applied')
          const saved = await view(hostId, source.id)
          await operation(hostId, { action: 'rollback', taskId: source.id, expectedVersion: saved.stateVersion, fingerprint: saved.rollbackFingerprint, approved: true })
          source.status = (await view(hostId, source.id)).task.status
          await record(`${hostId}: separately reviewed network prerequisite rollback ${source.status}`)
          assert.equal(source.status, 'reverted')
          assert.equal(await inspect(hostId, catalogPathProbe(saved.task.plan.modifiedFiles)), await readFile(path.join(directory, `${hostId}-${source.id}-network-paths.before`), 'utf8'))
          assert.equal(await inspect(hostId, packages), await readFile(path.join(directory, `${hostId}-${source.id}-network-packages.before`), 'utf8'))
          assert.equal(await inspect(hostId, accounts), await readFile(path.join(directory, `${hostId}-${source.id}-network-accounts.before`), 'utf8'))
          await record(`${hostId}: PASS temporary network prerequisite reviewed rollback and exact package/path/account baseline`)
          continue
        }
        assert.ok(!hostState.networkRepair, 'Existing network repair requires inspection, never another task')
        assert.equal(await inspect(hostId, 'if test -e /etc/pf.conf || test -L /etc/pf.conf; then printf present; else printf absent; fi'), 'absent')
        let task
        for (let attempt = 0; attempt < 8; attempt++) {
          task = tasks.create(hostId, 'Review temporary CNI networking setup from the trusted local Podman helper; preserve all pre-existing firewall policy', { kind: 'ai' })
          const trusted = buildCommonTask('podman-freebsd', task.id, { platform: 'freebsd', freebsdExecution: inventory.webminaiExecution, docker: inventory.webminaiDocker }).plan
          const network = trusted.commands.find(command => command.id === 'configure-podman-network')
          const rollback = trusted.revertCommands.find(command => command.id === 'restore-podman-network')
          const cleanup = trusted.revertCommands.find(command => command.id === 'remove-podman-task-state')
          const reviewed = { ...trusted, summary: 'Review temporary Podman CNI NAT-only setup', modifiedFiles: [`/var/db/webminai/task-state/${task.id}-freebsd-podman`, '/etc/pf.conf', '/etc/rc.conf'], commands: [{ ...network, dependsOn: [] }], revertCommands: [{ ...rollback, dependsOn: [] }, { ...cleanup, dependsOn: [rollback.id] }] }
          validateCommandPlan(reviewed, rootExecutionPolicy({}))
          tasks.savePlan(hostId, task.id, reviewed)
          const occupied = await inspect(hostId, `for p in /var/lib/webminai/task-state/${task.id}-* /var/db/webminai/task-state/${task.id}-* /var/lib/webminai/tasks/${task.id} /var/db/webminai/tasks/${task.id}; do if test -e "$p" || test -L "$p"; then printf occupied; break; fi; done`)
          if (!occupied) break
          const pending = await view(hostId, task.id)
          await operation(hostId, { action: 'abort', taskId: task.id, expectedVersion: pending.stateVersion })
          task = null
        }
        assert.ok(task, 'Occupied legacy identities block prerequisite repair')
        const saved = await view(hostId, task.id)
        await writeFile(path.join(directory, `${hostId}-${task.id}-network-paths.before`), await inspect(hostId, catalogPathProbe(saved.task.plan.modifiedFiles)), { flag: 'wx', mode: 0o600 })
        await writeFile(path.join(directory, `${hostId}-${task.id}-network-packages.before`), await inspect(hostId, packages), { flag: 'wx', mode: 0o600 })
        await writeFile(path.join(directory, `${hostId}-${task.id}-network-accounts.before`), await inspect(hostId, accounts), { flag: 'wx', mode: 0o600 })
        hostState.networkRepair = { id: task.id, status: 'awaiting-review' }
        await record(`${hostId}: separate temporary network repair #${task.id} prepared from local catalog code; no AI planning and no inherited bootstrap approval`)
        await operation(hostId, { action: 'execute', taskId: task.id, expectedVersion: saved.stateVersion, fingerprint: saved.fingerprint, approved: true })
        hostState.networkRepair.status = (await view(hostId, task.id)).task.status
        assert.equal(hostState.networkRepair.status, 'completed')
        hostState.networkRepair.status = 'applied'
        await record(`${hostId}: reviewed temporary CNI NAT setup applied; exact baseline and separately approved rollback retained`)
        continue
      }
      const definitions = listCommonTasks({ platform: 'freebsd' }).filter(value => !selectedTask || value.id === selectedTask)
      definitions.sort((a, b) => Number(a.category === 'maintenance') - Number(b.category === 'maintenance'))
      if (verifyReplayGuards) {
        const before = await inspect(hostId, packages)
        const accountBaseline = await inspect(hostId, accounts)
        let checked = 0
        for (const definition of definitions.filter(item => item.category === 'application' && !item.prerequisite && hostState.tasks[item.id]?.status === 'reverted')) {
          const saved = await view(hostId, hostState.tasks[definition.id].id)
          assert.equal(saved.task.catalogId, definition.id)
          assert.equal(saved.task.status, 'reverted')
          const events = tasks.allExecutionEvents(hostId, saved.task.id)
          const paths = catalogPathProbe(saved.task.plan.modifiedFiles)
          const pathBaseline = await inspect(hostId, paths)
          await assert.rejects(operation(hostId, { action: 'execute', taskId: saved.task.id, expectedVersion: saved.stateVersion, fingerprint: saved.fingerprint, approved: true }), /rollback has started or completed; prepare a new task/u)
          assert.deepEqual(tasks.allExecutionEvents(hostId, saved.task.id), events)
          assert.equal(await inspect(hostId, paths), pathBaseline)
          checked++
          await record(`${hostId}/${definition.id}: PASS reverted-plan replay rejected before remote execution; journal and paths unchanged`)
        }
        assert.ok(checked > 0, 'No verified reverted application histories to probe')
        assert.equal(await inspect(hostId, packages), before)
        assert.equal(await inspect(hostId, accounts), accountBaseline)
        await record(`${hostId}: PASS ${checked} catalog replay guards; exact package/account state unchanged`)
        continue
      }
      for (const definition of definitions) {
        if (stopScheduling) throw new Error('Another host test failed; current reviewed cycle finished before stopping')
        const eligible = (await request('/catalog?host=' + hostId)).find(value => value.id === definition.id)
        if (!eligible?.eligible) { await record(`${hostId}/${definition.id}: INELIGIBLE ${eligible?.reason ?? 'not offered by current capabilities'}`); continue }
        if (process.argv.includes('--retest-preflight')) {
          const source = hostState.tasks[definition.id]
          assert.ok(source, 'No failed candidate preflight to inspect')
          const saved = await view(hostId, source.id)
          assert.equal(saved.task.status, 'partial')
          assert.equal(saved.commands[0].commandId, 'prepare-podman-application')
          assert.equal(saved.commands[0].status, 'failed')
          assert.ok(saved.commands.slice(1).every(command => command.status === 'pending'), 'Only a confirmed initial preflight failure permits this fresh test')
          const paths = await inspect(hostId, catalogPathProbe(saved.task.plan.modifiedFiles))
          assert.ok(paths.trim().split('\n').every(line => line.startsWith('absent ')), 'Preflight left state; reviewed cleanup is required')
          const application = definition.id.replace(/-freebsd$/u, '')
          const name = `intentaiops-${application}-${source.id}`
          await inspect(hostId, `set -eu; for kind in container network image; do target=${name}; [ "$kind" != image ] || target=localhost/${name}:runtime; if podman "$kind" exists "$target"; then exit 78; else test "$?" -eq 1; fi; done`)
          await operation(hostId, { action: 'abort', taskId: source.id, expectedVersion: saved.stateVersion })
          hostState.preflightFailures ??= []
          hostState.preflightFailures.push({ ...source, catalogId: definition.id, status: 'confirmed-failure-no-resources' })
          delete hostState.tasks[definition.id]
          await record(`${hostId}/${definition.id}: confirmed failed preflight left no paths or Podman resources; original failure retained, a new task requires fresh approval`)
        }
        if (cleanupFailure) {
          const source = hostState.tasks[definition.id]
          assert.ok(source, 'No recorded test to clean up')
          let current = await view(hostId, source.id)
          assert.equal(current.task.status, 'partial')
          assert.ok(!current.commands.some(command => command.status === 'uncertain' || command.status === 'running'))
          assert.ok(current.commands.some(command => command.status === 'failed'), 'Cleanup is only for confirmed failure, never lost observation')
          if (podmanCandidates) {
            const trusted = buildCommonTask(definition.id, source.id, { platform: 'freebsd', freebsdExecution: inventory.webminaiExecution, docker: inventory.webminaiDocker }).plan
            assert.equal(planFingerprint(current.task.plan.revertCommands), planFingerprint(trusted.revertCommands), 'Candidate ownership cleanup changed; inspect before approving')
            const reviewed = { ...trusted, commands: trusted.revertCommands, revertCommands: [], operatorRollback: true }
            validateCommandPlan(reviewed, rootExecutionPolicy({}), { requireRevert: false })
            const revisionId = tasks.proposeRevision(hostId, source.id, reviewed, current.stateVersion)
            await operation(hostId, { action: 'approve', taskId: source.id, revisionId, expectedVersion: current.stateVersion, fingerprint: planFingerprint(reviewed), approved: true })
            current = await view(hostId, source.id)
            await operation(hostId, { action: 'rollback', taskId: source.id, revisionId, expectedVersion: current.stateVersion, fingerprint: planFingerprint(reviewed), approved: true })
            assert.equal((await view(hostId, source.id)).task.status, 'reverted')
            assert.equal(await inspect(hostId, packages), await readFile(path.join(directory, `${hostId}-${source.id}-packages.before`), 'utf8'))
            assert.equal(await inspect(hostId, accounts), await readFile(path.join(directory, `${hostId}-${source.id}-accounts.before`), 'utf8'))
            assert.equal(await inspect(hostId, catalogPathProbe(current.task.plan.modifiedFiles)), await readFile(path.join(directory, `${hostId}-${source.id}-paths.before`), 'utf8'))
            source.status = 'failed-cleaned'
            await record(`${hostId}/${definition.id}: separately reviewed partial candidate cleanup restored exact baselines; no application pass claimed`)
            continue
          }
          if (definition.id === 'wordpress-freebsd') {
            assert.equal(hostId, 'webminai-freebsd-14-4')
            assert.equal(source.id, 10)
            const trusted = buildCommonTask(definition.id, source.id, { platform: 'freebsd', freebsdExecution: inventory.webminaiExecution }).plan
            assert.equal(planFingerprint(current.task.plan.revertCommands), planFingerprint(trusted.revertCommands), 'Catalog rollback mismatch blocks cleanup')
            const reviewed = { ...trusted, commands: trusted.revertCommands, revertCommands: [], operatorRollback: true }
            validateCommandPlan(reviewed, rootExecutionPolicy({}), { requireRevert: false })
            const revisionId = tasks.proposeRevision(hostId, source.id, reviewed, current.stateVersion)
            await operation(hostId, { action: 'approve', taskId: source.id, revisionId, expectedVersion: current.stateVersion, fingerprint: planFingerprint(reviewed), approved: true })
            current = await view(hostId, source.id)
            await operation(hostId, { action: 'rollback', taskId: source.id, revisionId, expectedVersion: current.stateVersion, fingerprint: planFingerprint(reviewed), approved: true })
            assert.equal((await view(hostId, source.id)).task.status, 'reverted')
            source.status = 'rollback-completed-baseline-pending'
            await record(`${hostId}/${definition.id}: separately reviewed confirmed-failure cleanup completed; baseline checks pending`)
            for (const [name, probe] of [['packages', packages], ['accounts', accounts], ['paths', catalogPathProbe(trusted.modifiedFiles)]]) {
              assert.equal(await inspect(hostId, probe), await readFile(path.join(directory, `${hostId}-${source.id}-${name}.before`), 'utf8'), `Original ${name} baseline differs after failed-stack cleanup`)
            }
            hostState.archivedTests ??= []
            hostState.archivedTests.push({ ...source, catalogId: definition.id, status: 'failed-cleaned', reason: '14.4 runtime lacks chown; fresh image and task required' })
            delete hostState.tasks[definition.id]
            await record(`${hostId}/${definition.id}: failed task safely cleaned; original package/path/account baselines restored, application remains unverified`)
            continue
          }
          assert.equal(hostId, 'webminai-freebsd-14-4')
          assert.equal(definition.id, 'jellyfin-freebsd')
          assert.equal(source.id, 2)
          assert.deepEqual(current.commands.filter(command => command.status === 'completed').map(command => command.commandId ?? command.id), ['prepare-jellyfin'])
          const original = tasks.get(hostId, source.id)
          assert.ok(original.results.some(result => result.id === 'install-jellyfin-runtime' && result.status === 'failed' && result.result?.exitCode === 1))
          const before = await readFile(path.join(directory, `${hostId}-${source.id}-packages.before`), 'utf8')
          assert.ok(before.includes('pkg=2.7.5\n'))
          assert.equal(await inspect(hostId, packages), before.replace('pkg=2.7.5\n', 'pkg=2.8.4\n'), 'Unexpected package changes block this case-specific cleanup')
          const owned = ['/var/lib/webminai/task-state/2-jellyfin-freebsd', '/var/db/webminai-jellyfin-18113', '/root/jellyfin_credentials']
          const guard = `set -eu; if pkg info -e jellyfin >/dev/null 2>&1 || pkg info -e nginx >/dev/null 2>&1; then exit 78; fi; test ! -e /etc/rc.conf.d/jellyfin; test ! -e /usr/local/etc/nginx/nginx.conf; for p in ${owned.map(quote).join(' ')}; do test -d "$p"; test ! -L "$p"; test "$(stat -f '%u' "$p")" = 0; done; printf preparation-only`
          assert.equal(await inspect(hostId, guard), 'preparation-only')
          const command = { id: 'remove-confirmed-jellyfin-preparation', command: guard + `; rm -rf -- ${owned.map(quote).join(' ')}`, purpose: 'Remove only the inspected root-owned preparation paths from confirmed failed task 2; retain the pkg upgrade for operator review', risk: 'destructive', requiresSudo: true, timeoutMs: 300000, executionMode: 'job', dependsOn: [] }
          const reviewed = { ...original.plan, summary: 'Review cleanup of confirmed Jellyfin preparation only', commands: [command], revertCommands: [], operatorRollback: true }
          validateCommandPlan(reviewed, rootExecutionPolicy({}), { requireRevert: false })
          const revisionId = tasks.proposeRevision(hostId, source.id, reviewed, current.stateVersion)
          await record(`${hostId}: separately proposed preparation-only rollback revision ${revisionId}; no service stop, package removal, downgrade or original-history rewrite`)
          await operation(hostId, { action: 'approve', taskId: source.id, revisionId, expectedVersion: current.stateVersion, fingerprint: planFingerprint(reviewed), approved: true })
          current = await view(hostId, source.id)
          await operation(hostId, { action: 'rollback', taskId: source.id, revisionId, expectedVersion: current.stateVersion, fingerprint: planFingerprint(reviewed), approved: true })
          assert.equal((await view(hostId, source.id)).task.status, 'reverted')
          source.status = 'rollback-completed-baseline-pending'
          await record(`${hostId}/${definition.id}: confirmed failed task rolled back; baseline comparison is still required, not an application pass`)
          const pathBaseline = await readFile(path.join(directory, `${hostId}-${source.id}-paths.before`), 'utf8')
          assert.equal(await inspect(hostId, catalogPathProbe(current.task.plan.modifiedFiles)), pathBaseline, 'Task-owned paths not restored after failure cleanup')
          await record(`${hostId}/${definition.id}: catalog path baseline restored after reviewed cleanup`)
          assert.ok(await inspect(hostId, packages) === before, 'Package drift remains after reviewed cleanup; preserve original baseline and request operator direction')
          source.status = 'failed-cleaned'
          await record(`${hostId}/${definition.id}: failed task cleanup restored package baseline, application remains unverified`)
          continue
        }
        if (definition.category === 'maintenance' && !process.argv.includes('--include-maintenance')) { await record(`${hostId}/${definition.id}: pending separate --include-maintenance run, no reversible rollback`); continue }
        let prior = hostState.tasks[definition.id]
        if (restoreRuntime) {
          assert.ok(!hostState.networkRepair || hostState.networkRepair.status === 'reverted', 'Review network prerequisite rollback before restoring the runtime')
          assert.equal(prior?.status, 'prerequisite-ready')
          const saved = await view(hostId, prior.id)
          assert.equal(saved.task.status, 'completed')
          await operation(hostId, { action: 'rollback', taskId: prior.id, expectedVersion: saved.stateVersion, fingerprint: saved.rollbackFingerprint, approved: true })
          const restored = await view(hostId, prior.id)
          prior.status = restored.task.status === 'reverted' ? 'rollback-completed-baseline-pending' : restored.task.status
          await record(`${hostId}: retained runtime rollback ${restored.task.status}; original baseline verification follows`)
          assert.equal(restored.task.status, 'reverted')
          assert.equal(await inspect(hostId, packages), await readFile(path.join(directory, `${hostId}-${prior.id}-packages.before`), 'utf8'))
          assert.equal(await inspect(hostId, catalogPathProbe(saved.task.plan.modifiedFiles)), await readFile(path.join(directory, `${hostId}-${prior.id}-paths.before`), 'utf8'))
          assert.equal(await inspect(hostId, accounts), await readFile(path.join(directory, `${hostId}-${prior.id}-accounts.before`), 'utf8'))
          prior.status = 'reverted'
          await record(`${hostId}: PASS retained prerequisite reviewed rollback and original package/path/account baseline`)
          continue
        }
        if (retestReverted && podmanCandidates) {
          assert.ok(['failed-cleaned', 'reverted'].includes(prior?.status), 'Only an exactly restored candidate can be retested')
          const saved = await view(hostId, prior.id)
          assert.equal(saved.task.status, 'reverted')
          assert.equal(await inspect(hostId, packages), await readFile(path.join(directory, `${hostId}-${prior.id}-packages.before`), 'utf8'))
          assert.equal(await inspect(hostId, accounts), await readFile(path.join(directory, `${hostId}-${prior.id}-accounts.before`), 'utf8'))
          assert.equal(await inspect(hostId, catalogPathProbe(saved.task.plan.modifiedFiles)), await readFile(path.join(directory, `${hostId}-${prior.id}-paths.before`), 'utf8'))
          hostState.archivedTests ??= []
          hostState.archivedTests.push({ ...prior, catalogId: definition.id })
          delete hostState.tasks[definition.id]
          prior = null
          await record(`${hostId}/${definition.id}: original reverted candidate and exact cleanup retained; preparing a separately approved fresh test`)
        }
        if (retestReverted && !podmanCandidates) {
          const n8n = definition.id === 'n8n-freebsd'
          assert.equal(prior?.id, n8n ? 21 : 3, 'Only the inspected historical cycle may be superseded')
          const saved = await view(hostId, prior.id)
          assert.equal(saved.task.status, 'reverted')
          assert.equal(await inspect(hostId, catalogPathProbe(saved.task.plan.modifiedFiles)), await readFile(path.join(directory, `${hostId}-${prior.id}-paths.before`), 'utf8'))
          if (n8n) {
            assert.equal(prior.status, 'rollback-completed-baseline-pending')
            const before = await readFile(path.join(directory, `${hostId}-${prior.id}-packages.before`), 'utf8')
            assert.ok(before.includes('pkgconf=2.4.3_1,1\n'))
            assert.equal(await inspect(hostId, packages), before.replace('pkgconf=2.4.3_1,1\n', 'pkgconf=3.0.7,1\n'), 'Only the inspected pkgconf upgrade may be retained')
            assert.equal(await inspect(hostId, accounts), await readFile(path.join(directory, `${hostId}-${prior.id}-accounts.before`), 'utf8'))
          }
          hostState.archivedTests ??= []
          hostState.archivedTests.push({ ...prior, catalogId: definition.id, status: 'reverted-baseline-drift', note: n8n ? 'Operator authorized resolving blockers; retain inspected pkgconf upgrade and preserve original baseline failure, never count as a pass' : 'Application and owned paths reverted; original curl/CA package drift is retained, not a baseline pass' })
          delete hostState.tasks[definition.id]
          prior = null
          await record(`${hostId}/${definition.id}: old reverted cycle archived with its package-baseline failure intact; fresh reviewed cycle will use a new task ID and retain every original baseline`)
        }
        if (keepRuntime && prior?.status === 'reverted') {
          assert.equal((await view(hostId, prior.id)).task.status, 'reverted')
          hostState.archivedTests ??= []
          hostState.archivedTests.push({ ...prior, catalogId: definition.id })
          delete hostState.tasks[definition.id]
          prior = null
          await record(`${hostId}: previous runtime apply/rollback retained in history; separately prepare a temporary prerequisite for dependent application tests`)
        }
        if (refreshRemaining) {
          assert.ok(prior, 'No saved task to continue')
          const saved = await view(hostId, prior.id)
          if (refreshPaused) {
            assert.equal(saved.control.action, 'pause')
            assert.equal(saved.task.status, 'partial')
            assert.ok(saved.commands.some(command => command.status === 'completed'))
            assert.ok(saved.commands.some(command => command.status === 'pending'))
            assert.ok(saved.commands.every(command => ['completed', 'pending'].includes(command.status)), 'Resolve uncertain or failed work before paused catalog refresh')
          } else assert.ok(saved.commands.some(command => command.status === 'failed'), 'Only confirmed failure permits this continuation')
          assert.ok(!saved.commands.some(command => ['uncertain', 'running'].includes(command.status)), 'Uncertain work requires reconciliation')
          if (podmanCandidates && saved.commands.some(command => command.status === 'failed' && /^(?:podman-install-|(?:prepare|verify)-podman-(?:build-|source-|system-|openssl-)|clean-podman-(?:build|package)-cache)/u.test(command.commandId))) {
            const name = `intentaiops-${definition.id.replace(/-freebsd$/u, '')}-${prior.id}`
            assertIdlePodmanProcesses(await inspect(hostId, `podman container inspect --format '{{.State.Pid}}' ${name}; podman exec ${name} ps -ax -o pid -o ppid -o comm`))
          }
          const proposal = await operation(hostId, { action: 'refresh-catalog', taskId: prior.id, expectedVersion: saved.stateVersion })
          await record(`${hostId}/${definition.id}: regenerated remaining catalog steps; completed history and original baseline preserved`)
          await operation(hostId, { action: 'approve', taskId: prior.id, revisionId: proposal.revisionId, expectedVersion: proposal.expectedVersion, fingerprint: proposal.fingerprint, approved: true })
        }
        if (resumePaused) {
          assert.ok(prior, 'No saved paused task')
          const saved = await view(hostId, prior.id)
          assert.equal(saved.control.action, 'pause')
          assert.ok(['partial', 'planned'].includes(saved.task.status))
          assert.ok(saved.commands.some(command => command.status === 'completed'))
          assert.ok(saved.commands.some(command => command.status === 'pending'))
          assert.ok(saved.commands.every(command => ['completed', 'pending'].includes(command.status)), 'Reconcile failed or uncertain work before paused continuation')
          await record(`${hostId}/${definition.id}: separately reviewing paused task #${prior.id}; completed commands and original baselines preserved`)
        }
        if (resumePrepared) {
          assert.ok(prior, 'No existing prepared task')
          assert.equal((await view(hostId, prior.id)).task.status, 'planned')
          assert.ok(tasks.executionEvents(hostId, prior.id).every(event => event.type === 'plan_approved'), 'Previously dispatched work requires reconciliation, not a preparation retry')
          await record(`${hostId}/${definition.id}: re-reviewing unstarted prepared task #${prior.id}; prior rejection dispatched no command`)
        }
        if (prior && definition.category === 'diagnostic' && prior.status === 'awaiting-review') {
          const saved = await view(hostId, prior.id)
          if (saved.task.status === 'completed' && saved.commands.every(command => command.status === 'completed')) {
            prior.status = 'verified-read-only'
            await record(`${hostId}/${definition.id}: recovered completed read-only projection from authoritative CLI history`)
          }
        }
        if (retestCleaned && prior) {
          assert.equal(hostId, 'webminai-freebsd-14-4')
          assert.equal(definition.id, 'jellyfin-freebsd')
          assert.equal(prior.status, 'rollback-completed-baseline-pending')
          const saved = await view(hostId, prior.id)
          assert.equal(saved.task.status, 'reverted')
          assert.equal(await inspect(hostId, catalogPathProbe(saved.task.plan.modifiedFiles)), await readFile(path.join(directory, `${hostId}-${prior.id}-paths.before`), 'utf8'))
          const originalPackages = await readFile(path.join(directory, `${hostId}-${prior.id}-packages.before`), 'utf8')
          assert.ok(originalPackages.includes('pkg=2.7.5\n'))
          assert.equal(await inspect(hostId, packages), originalPackages.replace('pkg=2.7.5\n', 'pkg=2.8.4\n'))
          hostState.archivedTests ??= []
          hostState.archivedTests.push({ ...prior, catalogId: definition.id, retainedUpgrade: 'pkg 2.7.5 -> 2.8.4', status: 'failed-cleaned-upgrade-approved' })
          delete hostState.tasks[definition.id]
          await record(`${hostId}/${definition.id}: operator approved retaining pkg 2.8.4; old paths verified restored; fresh task and baseline follow, original evidence retained`)
        }
        if (hostState.tasks[definition.id] && process.argv.includes('--replace-undispatched')) {
          assert.equal(selectedTask, definition.id, 'Replacement requires one explicit selected task')
          const old = hostState.tasks[definition.id]
          const previous = await view(hostId, old.id)
          assert.equal(previous.task.status, 'planned')
          assert.ok(tasks.executionEvents(hostId, old.id).every(event => event.type === 'plan_approved'), 'Never replace previously dispatched or uncertain execution')
          await operation(hostId, { action: 'abort', taskId: old.id, expectedVersion: previous.stateVersion })
          hostState.blockedTasks ??= []
          hostState.blockedTasks.push({ ...old, catalogId: definition.id, reason: 'legacy identity occupied before dispatch' })
          delete hostState.tasks[definition.id]
          await record(`${hostId}: preserved blocked task #${old.id}; no command was dispatched, new task requires new review`)
        }
        if (['reverted', 'verified-read-only', 'verified-one-way', 'prerequisite-ready'].includes(hostState.tasks[definition.id]?.status)) continue
        assert.ok(!hostState.tasks[definition.id] || resumePrepared || refreshRemaining || resumePaused, 'Existing incomplete test requires explicit reviewed continuation, not another installation')
        let id = resumePrepared || refreshRemaining || resumePaused ? prior.id : null
        for (let attempt = 0; !id && attempt < (podmanCandidates ? 32 : 8); attempt++) {
          const prepared = await operation(hostId, { action: 'prepare', catalogId: definition.id, request: 'Validate FreeBSD common task through reviewed CLI: ' + definition.label })
          id = prepared.results[0].taskId
          assert.ok(Number.isSafeInteger(id) && id > 0)
          hostState.tasks[definition.id] = { id, status: 'awaiting-review' }
          await record(`${hostId}/${definition.id}: prepared #${id}`)
          const occupied = await inspect(hostId, `for p in /var/db/webminai/podman-${id}-* /var/lib/webminai/task-state/${id}-* /var/db/webminai/task-state/${id}-* /var/lib/webminai/tasks/${id} /var/db/webminai/tasks/${id} /var/lib/intentaiops/recovery/task-${id} /var/db/intentaiops/recovery/task-${id}; do if test -e "$p" || test -L "$p"; then printf occupied; break; fi; done`)
          if (!occupied) break
          const pending = await view(hostId, id)
          await operation(hostId, { action: 'abort', taskId: id, expectedVersion: pending.stateVersion })
          hostState.blockedTasks ??= []
          hostState.blockedTasks.push({ id, catalogId: definition.id, reason: 'occupied remote task identity; no dispatch' })
          delete hostState.tasks[definition.id]
          await record(`${hostId}/${definition.id}: preserved occupied identity #${id} without dispatch`)
          id = null
        }
        assert.ok(id, 'Too many occupied legacy identities; stop for operator inspection')
        if (definition.id === 'intent-ai-ops-freebsd' && !refreshRemaining && !resumePaused && !resumePrepared) {
          const ssh = new SystemSsh()
          let source
          try { source = await stageInstallSource(ssh, connection(hostId)) } finally { await ssh.closeSessions() }
          const built = buildCommonTask(definition.id, id, { platform: 'freebsd', freebsdExecution: inventory.webminaiExecution, intentAiOpsInstallSource: source })
          validateCommandPlan(built.plan, rootExecutionPolicy({}))
          assert.equal(tasks.executionEvents(hostId, id).length, 0, 'Never replace a dispatched or approved CLI installation')
          tasks.savePlan(hostId, id, built.plan)
          hostState.tasks[definition.id].installSource = source
          await record(`${hostId}/${definition.id}: staged current branch installer and built package before canonical plan review; no main-branch substitution`)
        }
        const packageFile = path.join(directory, `${hostId}-${id}-packages.before`)
        const before = refreshRemaining || resumePaused ? await readFile(packageFile, 'utf8') : await inspect(hostId, packages)
        if (resumePrepared) assert.equal(before, await readFile(packageFile, 'utf8'), 'Prepared task package baseline changed')
        else if (!refreshRemaining && !resumePaused) await writeFile(packageFile, before, { flag: 'wx', mode: 0o600 })
        const accountFile = path.join(directory, `${hostId}-${id}-accounts.before`)
        const accountBaseline = refreshRemaining || resumePaused ? await readFile(accountFile, 'utf8') : await inspect(hostId, accounts)
        if (resumePrepared) assert.equal(accountBaseline, await readFile(accountFile, 'utf8'), 'Prepared task account baseline changed')
        else if (!refreshRemaining && !resumePaused) await writeFile(accountFile, accountBaseline, { flag: 'wx', mode: 0o600 })
        let current = await view(hostId, id)
        if (!refreshRemaining && !resumePaused) {
          assert.equal(current.task.status, 'planned')
          assert.ok(current.commands.every(command => command.status === 'pending'))
        }
        const paths = current.task.plan.modifiedFiles
        const profileFile = path.join(directory, `${hostId}-${id}-profiles.before`)
        const profileProbe = catalogPathProbe(['/root/.profile', '/root/.cshrc', '/root/.config/fish/config.fish'])
        let profileBaseline
        if (current.task.plan.commands.some(command => /-build-toolchain(?:-catalog-[a-f0-9]+)?$/u.test(command.id) || command.command?.includes('RUSTUP_HOME='))) {
          try { profileBaseline = await readFile(profileFile, 'utf8') } catch (error) {
            if (error.code !== 'ENOENT') throw error
            profileBaseline = await inspect(hostId, profileProbe)
            await writeFile(profileFile, profileBaseline, { flag: 'wx', mode: 0o600 })
          }
        }
        const pathProbe = catalogPathProbe(paths)
        const pathFile = path.join(directory, `${hostId}-${id}-paths.before`)
        const pathBaseline = refreshRemaining || resumePaused ? await readFile(pathFile, 'utf8') : paths.length ? await inspect(hostId, pathProbe) : ''
        if (resumePrepared) assert.equal(pathBaseline, await readFile(pathFile, 'utf8'), 'Prepared task path baseline changed')
        else if (!refreshRemaining && !resumePaused) await writeFile(pathFile, pathBaseline, { flag: 'wx', mode: 0o600 })
        hostState.tasks[definition.id].status = 'execution-requested'
        await record(`${hostId}/${definition.id}: reviewed execution requested for #${id}`)
        await operation(hostId, { action: resumePaused ? 'resume' : 'execute', taskId: id, expectedVersion: current.stateVersion, fingerprint: current.fingerprint, approved: true })
        current = await view(hostId, id)
        hostState.tasks[definition.id].status = current.task.status
        if (podmanCandidates && current.task.status === 'partial' && current.control.action === 'pause' && current.commands.some(command => command.status === 'pending') && current.commands.every(command => ['completed', 'pending'].includes(command.status))) {
          hostState.tasks[definition.id].status = 'paused'
          await record(`${hostId}/${definition.id}: safe-boundary pause confirmed; completed commands preserved, remaining commands await separate review; no application pass claimed`)
          return
        }
        if (current.task.status !== 'completed') {
          const failed = tasks.get(hostId, id).results?.find(result => result.status !== 'completed')
          const uncertain = current.commands.filter(command => command.status === 'uncertain').map(command => command.commandId)
          await record(`${hostId}/${definition.id}: task #${id} ${current.task.status}; command ${failed?.id ?? 'unconfirmed'}, reason ${failed?.failure?.code ?? failed?.status ?? 'inspect journal'}; ${uncertain.length ? `outcome unknown: ${uncertain.join(', ')}; ` : ''}no retry or rollback dispatched`)
        }
        assert.equal(current.task.status, 'completed')
        assert.ok(current.commands.every(command => command.status === 'completed'))
        hostState.tasks[definition.id].status = 'completed'
        await record(`${hostId}/${definition.id}: apply and catalog verification passed`)
        if (podmanCandidates) {
          const { chromium } = await import('@playwright/test')
          const browser = await chromium.launch({ ...(process.env.INTENT_BROWSER_EXECUTABLE ? { executablePath: process.env.INTENT_BROWSER_EXECUTABLE } : {}) })
          try { await verifyFreebsdPodmanBrowser(browser, hostId, definition.id) } finally { await browser.close() }
          await record(`${hostId}/${definition.id}: PASS external browser rendering and same-origin assets after container restart; screenshot saved`)
        }
        if (!stopScheduling) {
          const confirmedEvents = tasks.allExecutionEvents(hostId, id)
          await assert.rejects(operation(hostId, { action: 'execute', taskId: id, expectedVersion: current.stateVersion, fingerprint: current.fingerprint, approved: true }), /already completed; its execution approval is consumed/u)
          assert.deepEqual(tasks.allExecutionEvents(hostId, id), confirmedEvents, 'Repeated approval must dispatch no commands or rewrite confirmed execution')
          await record(`${hostId}/${definition.id}: PASS repeated execution rejected; approved work and journal remain unchanged`)
        } else await record(`${hostId}/${definition.id}: another host failed; skip the repeat probe and finish this completed cycle's reviewed rollback`)
        if (keepRuntime) {
          hostState.tasks[definition.id].status = 'prerequisite-ready'
          await record(`${hostId}/${definition.id}: temporary prerequisite retained for dependent tests; reviewed rollback and saved original baselines remain required after applications finish`)
          continue
        }
        if (!current.task.plan.revertCommands.length) {
          hostState.tasks[definition.id].status = definition.category === 'diagnostic' ? 'verified-read-only' : 'verified-one-way'
          await record(`${hostId}/${definition.id}: PASS; ${hostState.tasks[definition.id].status}`)
          continue
        }
        await operation(hostId, { action: 'rollback', taskId: id, expectedVersion: current.stateVersion, fingerprint: current.rollbackFingerprint, approved: true })
        assert.equal((await view(hostId, id)).task.status, 'reverted')
        hostState.tasks[definition.id].status = 'rollback-completed-baseline-pending'
        await record(`${hostId}/${definition.id}: rollback completed; baseline assertions pending`)
        assert.equal(await inspect(hostId, packages), before, 'Exact package baseline differs after rollback; stop before another application')
        if (paths.length) assert.equal(await inspect(hostId, pathProbe), pathBaseline, 'Catalog path baseline differs after rollback; stop before another application')
        assert.ok(await inspect(hostId, accounts) === accountBaseline, 'Account baseline differs after rollback; inspect task-created users/groups before another application')
        if (profileBaseline !== undefined) assert.equal(await inspect(hostId, profileProbe), profileBaseline, 'Build toolchain changed original root profiles')
        hostState.tasks[definition.id].status = 'reverted'
        await record(`${hostId}/${definition.id}: PASS reviewed apply/rollback and exact package baseline; broader repeated-apply assertions remain separate`)
      }
    }
  }
  if (parallelHosts) {
    const failures = await parallelMap(hosts, 2, async host => {
      try { await runHosts([host]); return null } catch (error) { stopScheduling ??= error; return host + ': ' + safe(error.message) }
    })
    if (failures.some(Boolean)) throw new Error(failures.filter(Boolean).join('; '))
  } else await runHosts(selectedHost ? [selectedHost] : hosts)
  const savedSettings = await new SettingsStore(process.env.INTENT_WEB_DATA_ROOT).load()
  for (const hostId of selectedHost ? [selectedHost] : hosts) {
    assert.deepEqual({ historyId: savedSettings.servers[hostId].historyId ?? null, hostFingerprint: savedSettings.servers[hostId].hostFingerprint ?? null }, state.hosts[hostId].identity, 'Settings updates must preserve every tested host identity and history')
  }
} catch (error) { await record('STOPPED: ' + safe(error.message)); throw new Error(safe(error.message)) } finally { await cli.close() }

function assertIdlePodmanProcesses (output) {
  const lines = output.trim().split(/\r?\n/u)
  const main = Number(lines.shift())
  assert.ok(Number.isSafeInteger(main) && main > 0 && /^\s*PID\s+PPID\s+COMMAND\s*$/u.test(lines.shift() ?? ''), 'Container process evidence unavailable')
  const processes = lines.map(line => {
    const fields = line.trim().split(/\s+/u)
    const pid = Number(fields[0]); const parent = Number(fields[1])
    assert.ok(fields.length === 3 && Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(parent) && parent >= 0, 'Malformed container process evidence')
    return { pid, parent, name: fields[2] }
  })
  assert.ok(processes.some(process => process.pid === main && process.name === 'sh'), 'Container entrypoint changed; inspect before continuation')
  assert.ok(processes.every(process => process.pid === main || (process.parent === main && process.name === 'sleep') || process.name === 'ps'), 'Previous in-container work remains active; observe it before approving another acquisition attempt')
}

function assertCheckpointTasks (saved, observedAt, readTask) {
  const checkpointTime = Date.parse(observedAt) / 1000
  assert.ok(Number.isFinite(checkpointTime), 'Checkpoint observation time is missing')
  for (const [catalogId, reference] of Object.entries(saved.tasks)) {
    const task = readTask(reference.id)
    assert.ok(task.kind === 'catalog' && task.catalogId === catalogId && Number.isFinite(task.createdAt) && task.createdAt <= checkpointTime, 'Checkpoint belongs to different local task history; preserve it and use separate state after vault recreation')
  }
}
