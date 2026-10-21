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

const hostId = 'ubuntu-2604-netbook'
const destination = 'ssh://user@192.168.1.102'
const applications = ['wordpress-linux', 'woocommerce-linux', 'joomla-linux', 'drupal-linux', 'prestashop-linux', 'moodle-linux', 'magento-linux', 'n8n-linux', 'ghost-linux', 'mattermost-linux', 'odoo-linux', 'jellyfin-linux', 'home-assistant-linux']
const directory = path.resolve('artifacts/netbook-docker')
const checkpoint = 'netbook-docker-validation-status.md'
const selected = process.argv.filter(value => value.startsWith('--task=')).map(value => value.slice(7))
const restoreDocker = process.argv.includes('--restore-docker')
const updateStage2 = process.argv.includes('--update-stage2')
assert.ok(process.argv.includes('--approve-live-tests'), 'Explicit --approve-live-tests is required')
assert.ok(process.env.SSH_HOST_2 && process.env.VAULT_TEST, 'SSH_HOST_2 and VAULT_TEST are required')
assert.ok(selected.every(id => applications.includes(id)), 'Unknown application')
assert.equal(new Set(selected).size, selected.length, 'Duplicate selected application')
if (updateStage2) assert.ok(process.argv.includes('--setup-only') && !selected.length && !restoreDocker, 'Stage 2 update is a separate reviewed setup-only operation')
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
const safe = value => redactDiagnosticText(String(value).split(process.env.SSH_HOST_2).join('[redacted]').split(process.env.VAULT_TEST).join('[redacted]')).replace(/[\r\n]+/gu, ' ').slice(0, 1800)
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
  await writeFile(path.join(directory, 'after-setup.txt'), await inspect(setupBaselineCommand), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  if (process.argv.includes('--setup-only')) { await record('Setup-only checkpoint reached; application tasks not started'); process.exitCode = 0 } else {
    const inventory = await request('/inventory?host=' + hostId)
    assert.equal(inventory.webminaiDocker.ready, true)
    assert.equal(inventory.webminaiDocker.preferred, true)
    if (process.argv.includes('--review-prestashop-pull') || process.argv.includes('--review-moodle-build')) {
      const moodle = process.argv.includes('--review-moodle-build')
      const catalogId = moodle ? 'moodle-linux' : 'prestashop-linux'
      assert.deepEqual(selected, [catalogId])
      const id = state.tasks[catalogId]?.id
      assert.ok(Number.isSafeInteger(id) && id > 0)
      let current = await view(id)
      assert.equal(current.task.status, 'partial')
      assert.ok(!current.commands.some(command => command.status === 'uncertain'))
      assert.deepEqual(current.commands.filter(command => command.status === 'completed').map(command => command.commandId ?? command.id), ['capture-baseline', 'prepare-docker', 'generate-credentials', 'write-compose', ...(moodle ? ['prepare-moodle-swap'] : [])])
      assert.equal(current.commands.find(command => (command.commandId ?? command.id).startsWith('pull-images')).status, 'failed')
      const containerCheck = moodle ? `test "$(docker ps -a --format '{{.Names}}')" = 'buildx_buildkit_webminai-moodle-${id}0'; docker image inspect 'webminai/moodle:5.2.1-php8.4-fpm-r2' >/dev/null` : 'test -z "$(docker ps -aq)"'
      assert.equal((await inspect(`set -eu; if pgrep -x docker >/dev/null || pgrep -x docker-compose >/dev/null; then exit 78; fi; ${containerCheck}; printf inspected-no-active-client`)).trim(), 'inspected-no-active-client')
      const original = tasks.get(hostId, id)
      const trusted = buildCommonTask(catalogId, id, { platform: 'linux', linuxContext: inventory.webminaiLinuxContext, docker: inventory.webminaiDocker, applicationDefaults: await settingsStore.decryptApplicationDefaults({ settings, passphrase: process.env.VAULT_TEST }) }).plan
      if (moodle) {
        const failed = original.results.find(result => result.id === 'pull-images')
        assert.equal(failed?.result?.timedOut, true, 'Reconcile the authoritative acquisition result before revising')
        const baseline = await readFile(path.join(directory, `${id}-${catalogId}-runtime.before.txt`), 'utf8')
        assert.ok(!baseline.includes('moby/buildkit:'), 'Preexisting BuildKit image must not be removed')
        const acquisition = trusted.commands.find(command => command.id === 'pull-images')
        acquisition.command = `set -eu; docker buildx rm --force ${quote(`webminai-moodle-${id}`)} >/dev/null; docker image rm 'moby/buildkit:buildx-stable-1' >/dev/null; ${acquisition.command}`
        acquisition.purpose = 'Separately reviewed cleanup of this timed-out attempt’s builder, reuse its completed Moodle image, then finish trusted image acquisition'
      }
      const revised = regenerateCatalogRevision(original, tasks.executionState(hostId, id), trusted)
      validateCommandPlan(revised, rootExecutionPolicy({}))
      const revisionId = tasks.proposeRevision(hostId, id, revised, current.stateVersion)
      await record(`Proposed ${catalogId} acquisition revision #${revisionId}; no active Docker client, completed setup preserved. ${moodle ? 'Confirmed execution timeout; reviewed task-owned builder cleanup and reuse of the completed image, no OOM claim.' : 'Confirmed Docker CDN timeout; serialize pulls and quiet progress.'} Fresh approval required.`)
      await operation({ action: 'approve', taskId: id, revisionId, expectedVersion: current.stateVersion, fingerprint: planFingerprint(revised), approved: true })
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
      await record(`${catalogId}: PASS with separately reviewed acquisition revision, application verification, rollback and runtime/path baseline comparison.`)
    }
    const cleanupGhost = process.argv.includes('--review-ghost-cleanup')
    const cleanupPartial = process.argv.includes('--review-wordpress-cleanup') || cleanupGhost
    if (cleanupPartial) {
      const catalogId = cleanupGhost ? 'ghost-linux' : 'wordpress-linux'
      if (cleanupGhost) assert.deepEqual(selected, ['ghost-linux'])
      const id = state.tasks[catalogId]?.id
      assert.ok(Number.isSafeInteger(id) && id > 0)
      let current = await view(id)
      assert.equal(current.task.status, 'partial')
      assert.ok(!current.commands.some(command => command.status === 'uncertain'))
      const project = cleanupGhost ? 'webminai-ghost-18110' : 'webminai-wordpress-18101'
      const baselineFile = cleanupGhost ? 'packages.before' : 'docker-ready.before'
      const family = cleanupGhost ? 'ghost' : 'wordpress'
      const observed = await inspect(`set -eu; if pgrep -x docker >/dev/null || pgrep -x docker-compose >/dev/null; then exit 78; fi; test "$(docker ps -aq | sort)" = "$(docker ps -aq --filter label=com.docker.compose.project=${project} | sort)"; test -e /var/lib/webminai/task-state/${id}-${family}-compose/${baselineFile}; printf '%s\\n' reviewed-project-only`)
      assert.equal(observed.trim(), 'reviewed-project-only')
      const original = tasks.get(hostId, id)
      const trusted = buildCommonTask(catalogId, id, { platform: 'linux', linuxContext: inventory.webminaiLinuxContext, docker: inventory.webminaiDocker }).plan
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
      if (cleanupGhost) {
        assert.equal(await inspect(runtimeBaseline), await readFile(path.join(directory, `${id}-${catalogId}-runtime.before.txt`), 'utf8'))
        const paths = original.plan.modifiedFiles
        assert.ok(paths.every(value => /^\/[a-zA-Z0-9_./-]+$/u.test(value) && !value.split('/').includes('..')))
        const probe = `set -eu; for p in ${paths.map(quote).join(' ')}; do if [ -e "$p" ] || [ -L "$p" ]; then stat -c '%n %F %u:%g %a' -- "$p"; else printf 'absent %s\\n' "$p"; fi; done`
        assert.equal(await inspect(probe), await readFile(path.join(directory, `${id}-${catalogId}-paths.before.txt`), 'utf8'))
        state.tasks[catalogId].cleanupReverted = true
        state.tasks[catalogId].status = 'blocked-cpu'
        await record('Ghost partial attempt rolled back with matching runtime/path baselines. Confirmed pinned MySQL image rejects x86-64-v2-incompatible CPU; not an application pass.')
        const prepared = await operation({ action: 'prepare', catalogId, request: 'Verify the new Ghost CPU prerequisite rejects this known incompatible host before creating any task state or credentials' })
        const probeId = prepared.results[0].taskId
        state.tasks[catalogId].prerequisiteTaskId = probeId
        await record(`Saved Ghost CPU prerequisite test #${probeId}; expected fail-closed result, not deployment`)
        current = await view(probeId)
        assert.equal(current.task.status, 'planned')
        await operation({ action: 'execute', taskId: probeId, expectedVersion: current.stateVersion, fingerprint: current.fingerprint, approved: true })
        current = await view(probeId)
        assert.equal(current.commands[0].status, 'failed')
        assert.ok(current.commands.slice(1).every(command => command.status === 'pending'))
        assert.ok(current.task.results[0].diagnostics.some(value => value.code === 'CPU_INSTRUCTION_SET_UNSUPPORTED'))
        assert.equal(await inspect(runtimeBaseline), await readFile(path.join(directory, `${id}-${catalogId}-runtime.before.txt`), 'utf8'))
        assert.equal((await inspect(`set -eu; ${current.task.plan.modifiedFiles.map(value => { assert.ok(/^\/[a-zA-Z0-9_./-]+$/u.test(value) && !value.split('/').includes('..')); return `test ! -e ${quote(value)} && test ! -L ${quote(value)}` }).join('; ')}; printf no-task-paths-created`)).trim(), 'no-task-paths-created')
        state.tasks[catalogId].prerequisiteVerified = true
        await record('Ghost CPU prerequisite rejection verified through the real binary: no later commands dispatched, no task paths or runtime changes. Application remains hardware-blocked.')
      } else {
        state.recoveredWordpressTaskId = id
        delete state.tasks['wordpress-linux']
        await record('Partial WordPress attempt cleaned through reviewed catalog rollback. Not counted as a cold lifecycle pass; original task history retained.')
      }
    }
    const catalog = await request('/catalog?host=' + hostId)
    for (const catalogId of cleanupPartial ? [] : selected.length ? selected : applications) {
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
      assert.equal(await inspect(setupBaselineCommand), await readFile(path.join(directory, 'after-setup.txt'), 'utf8'), 'Setup baseline drift detected; preserve unrelated Docker work and inspect before removing the runtime')
      await writeFile(path.join(directory, 'before-docker-packages.txt'), await inspect(`cat /var/lib/webminai/tasks/${state.dockerTaskId}/linux-docker/packages.before`), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      let current = await view(state.dockerTaskId)
      assert.ok((await readFile(path.join(directory, 'before-docker-network.txt'), 'utf8')).startsWith('===FORWARDING===\n0\n0\n'), 'Original forwarding evidence does not match the reviewed restoration')
      const original = tasks.get(hostId, state.dockerTaskId)
      const commands = original.plan.revertCommands.map(command => ({ ...command, dependsOn: [...command.dependsOn] }))
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
    } else await record('Selected application tests finished. Docker/Stage 2 restoration remains a separate reviewed final step; do not claim original-host restoration yet.')
  }
} catch (error) { await record('STOPPED: ' + safe(error.message)); throw new Error(safe(error.message)) } finally { await cli.close() }
