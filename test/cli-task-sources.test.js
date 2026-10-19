import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { eligibleInteractiveCommonTasks } from '../src/cli.js'

test('single and multi-host routing share verified health and update candidates', async () => {
  const source = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8')
  assert.match(source, /candidates: eligibleInteractiveCommonTasks\(\{ platform, inventory \}\)/)
  for (const platform of ['linux', 'freebsd', 'macos', 'windows']) {
    const candidates = eligibleInteractiveCommonTasks({ platform })
    assert.ok(candidates.some(task => task.id === `host-health-${platform}`), platform)
    assert.equal(candidates.some(task => task.id === `system-update-${platform}`), platform !== 'macos', platform)
    assert.ok(candidates.every(task => (task.platform ?? 'linux') === platform))
  }
})

test('interactive task menus expose verified platform applications and AI-assisted tasks', async () => {
  const source = [
    await readFile(new URL('../src/cli.js', import.meta.url), 'utf8'),
    await readFile(new URL('../src/cli-display.js', import.meta.url), 'utf8')
  ].join('\n')

  assert.match(source, /Run an AI-assisted task/)
  assert.match(source, /Review a pending plan revision/u)
  assert.match(source, /controller\.approve\(serverId, taskId, revision\.id, view\.stateVersion, revision\.fingerprint\)/u)
  assert.match(source, /Run a verified common task/)
  assert.match(source, /Unfinished execution \(may still be active\)/)
  assert.match(source, /Verified \$\{taskPlatform\} tasks eligible for this host/)
  assert.match(source, /eligibleInteractiveCommonTasks/)
  assert.match(source, /category: 'maintenance'/)
  assert.match(source, /category: 'diagnostic'/)
  assert.match(source, /admin\.routeTask\(/)
  assert.match(source, /buildCandidatePlanningContext\(/)
  assert.match(source, /Describe the task for every selected host/)
  assert.match(source, /await session\?\.close\(\)/)
  assert.match(source, /ui\.withTerminalSuspended\(\(\) => ssh\.interactiveShell\(server\.connectionUrl\)\)/)
  assert.match(source, /buildCommonTask\([\s\S]*applicationDefaults/)
  assert.match(source, /buildCandidatePlanningContext\([\s\S]*applicationDefaults/)
  assert.match(source, /plan = await admin\.plan\([\s\S]*applicationDefaults/)
  assert.match(source, /controller\.run\([\s\S]*applicationDefaults/)
  assert.match(source, /renderAndSaveSystemUpdateReport/)
  assert.match(source, /admin\.saveUpdateContext/)
  assert.match(source, /parallelMap\(serverIds, 4/)
  assert.match(source, /parallelMap\(ready, 4/)
  assert.match(source, /installNetdata: false/)
  assert.match(source, /settingsStore\.setStage2State\(/)
  assert.match(source, /workspace\.enableRootExecution\(/)
  assert.match(source, /Promise\.allSettled\(sessions\.map\(session => session\.close\(\)\)\)/)
  assert.match(source, /appliedNginxVerifier/)
  assert.match(source, /revertedNginxVerifier/)
  assert.doesNotMatch(await readFile(new URL('../src/terminal-ui.js', import.meta.url), 'utf8'), /SettingsStore|SystemSsh|Stage2Service|AdminService/)
})

test('legacy Linux system fixtures require an explicit lab picker opt-in and retain eligibility checks', async () => {
  const options = { platform: 'linux', inventory: { webminaiLinuxContext: { management: { serviceManager: 'systemd' } }, webminaiDocker: { hostIsContainer: true } } }
  assert.ok(!eligibleInteractiveCommonTasks(options).some(task => task.category === 'system'))
  const lab = eligibleInteractiveCommonTasks({ ...options, labTasks: true })
  for (const id of ['install-htop', 'install-jq', 'system-user', 'systemd-service', 'systemd-timer', 'cron-job', 'logrotate-rule', 'tmpfiles-rule', 'nginx-static-site']) assert.ok(lab.some(task => task.id === id), id)
  assert.ok(!lab.some(task => task.id === 'swap-file'))
  const alpine = eligibleInteractiveCommonTasks({ platform: 'linux', labTasks: true, inventory: { webminaiLinuxContext: { management: { serviceManager: 'openrc' } }, webminaiDocker: { hostIsContainer: true } } })
  assert.ok(!alpine.some(task => ['swap-file', 'systemd-service', 'systemd-timer', 'tmpfiles-rule'].includes(task.id)))
  for (const platform of ['freebsd', 'windows', 'macos']) assert.deepEqual(eligibleInteractiveCommonTasks({ platform, labTasks: true }), eligibleInteractiveCommonTasks({ platform }))
  const source = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8')
  assert.match(source, /labTasks: cliOptions\.labTasks === true/u)
  assert.match(source, /status, labTasks: context\.labTasks/u)
  assert.match(source, /argument === '--lab-tasks'/u)
})
