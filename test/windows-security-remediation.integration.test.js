import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'
import { AdminService } from '../src/admin-service.js'
import { OperatorController } from '../src/operator-controller.js'
import { windowsDockerPowerShellAdapter } from '../src/windows-compose-foundation.js'
import { moodleRelease } from '../src/moodle-task.js'
import { parseSecurityEvidence } from '../src/software-security.js'

test('Windows signed Docker remediation detects old PHP, requires fresh approval and preserves a disposable volume', {
  skip: process.env.INTENT_SECURITY_PATCH_WINDOWS !== '1' || !process.env.VAULT_TEST,
  timeout: 1800000
}, async () => {
  const dataRoot = process.env.INTENT_WEB_DATA_ROOT ?? '/home/vscode/.intentaiops'
  const store = new SettingsStore(dataRoot)
  const settings = await store.load()
  const serverId = 'windows-lab'
  const host = await store.decryptServer({ settings, passphrase: process.env.VAULT_TEST, serverId })
  const ssh = new SystemSsh()
  const lease = await ssh.acquireSession(host.connectionUrl, { authentication: host.authentication, credential: host.sshCredential })
  try {
    assert.equal(await lease.ssh.hostFingerprint(host.connectionUrl), host.hostFingerprint)
    const admin = new AdminService({ dataRoot, ssh: lease.ssh, settings: store })
    if (settings.servers[serverId].historyId) admin.workspace.setDirectoryAlias(serverId, settings.servers[serverId].historyId)
    const client = admin.netdata(host)
    assert.equal((await client.health()).platform, 'windows')
    const oldImage = 'php:8.4.23-fpm-bookworm'
    const fixedImage = moodleRelease().phpImage
    const tag = 'intent-security-' + randomBytes(6).toString('hex')
    const old = tag + '-old'; const fixed = tag + '-fixed'; const volume = tag + '-data'
    const label = `io.intentaiops.security-fixture=${tag}`
    const project = 'webminai-wordpress-18101'
    const ps = body => "$ErrorActionPreference='Stop';" + windowsDockerPowerShellAdapter(900000) + ';' + body + ";if($LASTEXITCODE-ne 0){throw 'Fixture Docker operation failed'}"
    const probe = await client.runCommand(ps(`$ids=@(& $docker ps -a --filter 'label=com.docker.compose.project=${project}' --format '{{.ID}}');if($ids.Count){throw 'Existing WordPress project prevents isolated fixture testing'};foreach($image in @('${oldImage}','${fixedImage}')){& $docker image inspect $image *> $null;Write-Output ('BASELINE '+$image+' '+[int]($LASTEXITCODE-eq 0))};$global:LASTEXITCODE=0`), { timeoutSeconds: 60 })
    assert.equal(probe.exitCode, 0, `Windows Docker must already be installed and the fixture project unoccupied: ${probe.stderr?.slice(0, 2048)}`)
    const added = [oldImage, fixedImage].filter(image => probe.stdout.includes(`BASELINE ${image} 0`))
    const item = (id, body, dependsOn = [], risk = 'change') => ({ id, command: ps(body), purpose: 'Disposable isolated PHP security remediation fixture', phase: 'verify', risk, timeoutMs: 900000, executionMode: 'job', requiresSudo: true, dependsOn })
    const run = name => `& $docker run -d --name '${name}' --network none --label '${label}' --label 'com.docker.compose.project=${project}' --mount 'type=volume,source=${volume},target=/fixture' `
    const inspect = name => `$version=(& $docker exec '${name}' php -n -r 'echo PHP_VERSION;').Trim();if($LASTEXITCODE-ne 0){throw 'Runtime inspection failed'};Write-Output ('INTENT_SECURITY_PHP runtime '+$version);Write-Output 'INTENT_SECURITY_END'`
    const cleanup = [
      `foreach($name in @('${old}','${fixed}')){$found=@(& $docker ps -a --filter ('name=^/'+$name+'$') --filter 'label=${label}' --format '{{.ID}}');if($found.Count){& $docker rm -f $name;if($LASTEXITCODE-ne 0){throw 'Fixture container cleanup failed'}}}`,
      `$owned=@(([string](& $docker volume ls --filter 'label=${label}' --format '{{.Name}}')) -split '\\r?\\n'|Where-Object {$_});if($owned -contains '${volume}'){& $docker volume rm '${volume}';if($LASTEXITCODE-ne 0){throw 'Fixture volume cleanup failed'}}`,
      ...added.map(image => `& $docker image inspect '${image}' *> $null;if($LASTEXITCODE-eq 0){& $docker image rm '${image}';if($LASTEXITCODE-ne 0){throw 'New fixture image is still in use; inspect before cleanup'}}`),
      '$global:LASTEXITCODE=0'
    ].join(';')
    const task = admin.createTask(serverId, `Isolated PHP Docker security fixture ${tag}; WordPress collector fixture, not a WordPress installation; no exposed ports or application data.`, { kind: 'catalog', catalogId: 'wordpress-windows' })
    const plan = {
      summary: 'Disposable old PHP image and persistent sentinel',
      changeOverview: 'No production workload or exploit',
      modifiedFiles: [],
      commands: [
        item('pull-fixture-old', `& $docker pull '${oldImage}'`),
        item('pull-fixture-fixed', `& $docker pull '${fixedImage}'`, ['pull-fixture-old']),
        item('start-fixture', `$present=@(& $docker volume ls --filter 'name=^${volume}$' --format '{{.Name}}');if($present.Count){throw 'Fixture volume already exists'};& $docker volume create --label '${label}' '${volume}';if($LASTEXITCODE-ne 0){throw 'Fixture volume creation failed'};$owner=(& $docker volume inspect '${volume}' --format '{{json .Labels}}'|ConvertFrom-Json);if($owner.'io.intentaiops.security-fixture'-ne '${tag}'){throw 'Fixture volume ownership mismatch'};${run(old)}'${oldImage}' sleep infinity;if($LASTEXITCODE-ne 0){throw 'Old container creation failed'};& $docker exec '${old}' sh -c 'printf preserved > /fixture/sentinel'`, ['pull-fixture-fixed']),
        item('audit-software-security', inspect(old), ['start-fixture'], 'read')
      ],
      revertCommands: [item('remove-security-fixture', cleanup, [], 'destructive')]
    }
    admin.saveTaskPlan(serverId, task.id, plan)
    const controller = new OperatorController({ dataRoot, settings, passphrase: process.env.VAULT_TEST, tasks: admin.tasks, adminFor: async () => admin })
    let started = false
    try {
      let view = controller.inspect(serverId, task.id)
      started = true
      await controller.resume(serverId, task.id, view.stateVersion, view.fingerprint)
      view = controller.inspect(serverId, task.id)
      assert.equal(view.task.status, 'completed')
      assert.equal(view.securityRemediationAvailable, true)
      assert.ok(parseSecurityEvidence(admin.getTask(serverId, task.id).results).observations.some(item => item.version === '8.4.23'))
      // Fixed fixture plan tests execution/review, not Codex's choice of a repair.
      admin.plan = async options => {
        assert.match(options.retryInstructions, /rebuild the correct task-owned image/u)
        return {
          ...plan,
          summary: 'Replace old PHP container with pinned patched image',
          commands: [
            item('replace-fixture-image', `& $docker stop '${old}';if($LASTEXITCODE-ne 0){throw 'Old container stop failed'};${run(fixed)}'${fixedImage}' sleep infinity;if($LASTEXITCODE-ne 0){throw 'Patched container creation failed'};$sentinel=(& $docker exec '${fixed}' cat /fixture/sentinel).Trim();if($sentinel-ne 'preserved'){throw 'Persistent data changed'};$v=(& $docker exec '${fixed}' php -n -r 'echo PHP_VERSION;').Trim();if($v-ne '8.4.27'){throw 'Patched runtime verification failed'}`)
          ]
        }
      }
      const proposal = await controller.proposeSecurityRemediation(serverId, task.id, view.stateVersion)
      assert.equal(controller.inspect(serverId, task.id).fingerprint, view.fingerprint)
      await assert.rejects(controller.resume(serverId, task.id, view.stateVersion, view.fingerprint), /completed/u)
      assert.throws(() => controller.approve(serverId, task.id, proposal.revisionId, proposal.expectedVersion, '0'.repeat(64)), /approval/u)
      controller.approve(serverId, task.id, proposal.revisionId, proposal.expectedVersion, proposal.fingerprint)
      view = controller.inspect(serverId, task.id)
      await controller.resume(serverId, task.id, view.stateVersion, view.fingerprint)
      const finished = admin.getTask(serverId, task.id)
      assert.equal(finished.status, 'completed')
      assert.equal(controller.inspect(serverId, task.id).securityRemediationAvailable, false)
      assert.ok(parseSecurityEvidence(finished.results).observations.some(item => item.status === 'meets_tracked_floor' && item.version === '8.4.27'))
      assert.equal(admin.tasks.allExecutionEvents(serverId, task.id).filter(event => event.type === 'command_dispatched' && event.commandId === 'start-fixture').length, 1)
      console.log(`Windows security fixture task ${task.id}: PHP 8.4.23 detected, reviewed replacement 8.4.27 verified; sentinel preserved`)
    } finally {
      if (started) {
        const view = controller.inspect(serverId, task.id)
        assert.ok(!view.commands.some(command => command.status === 'uncertain'), `Task ${task.id} has uncertain work; reconcile before fixture cleanup, do not replay`)
        await controller.rollback(serverId, task.id, view.stateVersion, view.rollbackFingerprint)
        assert.equal(admin.getTask(serverId, task.id).status, 'reverted')
        const remaining = await client.runCommand(ps(`$containers=@(& $docker ps -a --filter 'label=${label}' --format '{{.ID}}');$volumes=@(& $docker volume ls --filter 'label=${label}' --format '{{.Name}}');if($containers.Count -or $volumes.Count){throw 'Fixture remnants remain'};Write-Output 'FIXTURE_BASELINE_RESTORED'`), { timeoutSeconds: 60 })
        assert.equal(remaining.exitCode, 0, remaining.stderr?.slice(0, 2048))
        assert.match(remaining.stdout, /FIXTURE_BASELINE_RESTORED/u)
      }
    }
  } finally { await lease.close(); await ssh.closeSessions() }
})
