import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('interactive task menus expose verified platform applications and AI-assisted tasks', async () => {
  const source = [
    await readFile(new URL('../src/cli.js', import.meta.url), 'utf8'),
    await readFile(new URL('../src/cli-display.js', import.meta.url), 'utf8')
  ].join('\n')

  assert.match(source, /Run an AI-assisted task/)
  assert.match(source, /Run a verified common task/)
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
  assert.match(source, /service\.run\([\s\S]*applicationDefaults/)
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
