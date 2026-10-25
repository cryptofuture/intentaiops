import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { buildMacosComposeTask } from '../src/macos-compose-task.js'
import { runProcess } from '../src/process-runner.js'

for (const available of [false, true]) {
  test(`Moodle checks Buildx before application mutation: available=${available}`, async t => {
    const directory = await mkdtemp('/tmp/imac-buildx-')
    t.after(() => rm(directory, { recursive: true, force: true }))
    await mkdir(`${directory}/bin`)
    await writeFile(`${directory}/bin/docker`, `#!/bin/sh\nprintf '%s\\n' "$*" > '${directory}/calls'\n[ -z "$DOCKER_CONTEXT" ] && [ "$HOME" = /Users/mac ] && [ "$DOCKER_HOST" = unix:///Users/mac/.colima/default/docker.sock ] || exit 2\n[ "$*" = 'buildx version' ] || exit 1\nexit ${available ? 0 : 1}\n`, { mode: 0o755 })
    const built = buildMacosComposeTask('moodle', 108, { platform: 'macos', architecture: 'x86_64', runtimeUser: 'mac', runtimeHome: '/Users/mac' }, { ready: true })
    const guard = built.plan.commands[0]
    assert.equal(guard.id, 'validate-buildx')
    assert.equal(guard.risk, 'read')
    assert.equal(guard.timeoutMs, 30000)
    assert.equal(guard.executionMode, undefined)
    assert.ok(built.plan.commands.find(command => command.id === 'capture-baseline').dependsOn.includes(guard.id))
    assert.match(guard.command, /\/opt\/homebrew\/bin/u)
    const command = guard.command.replace(/PATH='[^']+'/u, `PATH='${directory}/bin:/usr/bin:/bin'`)
    const result = await runProcess('/bin/sh', ['-c', command], { timeoutMs: 2000, env: { ...process.env, DOCKER_CONTEXT: 'unverified-context', HOME: '/tmp/unverified-home' } })
    assert.equal(result.code, available ? 0 : 78)
    if (!available) assert.match(result.stderr, /MACOS_BUILDX_UNAVAILABLE/u)
    assert.equal(await readFile(`${directory}/calls`, 'utf8'), 'buildx version\n')
  })
}
