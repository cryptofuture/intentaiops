import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildFreebsdJellyfinTask } from '../src/freebsd-jellyfin-task.js'

test('FreeBSD Jellyfin cold acquisition has an explicit bounded durable-job budget', () => {
  const command = buildFreebsdJellyfinTask(1, { platform: 'freebsd' }).plan.commands.find(command => command.id === 'install-jellyfin-runtime')
  assert.equal(command.executionMode, 'job')
  assert.equal(command.timeoutMs, 3600000)
})

test('FreeBSD Jellyfin runtime accepts its exact version response without accepting crashes or other failures', () => {
  const probe = buildFreebsdJellyfinTask(1, { platform: 'freebsd' }).verifyRuntime
  const fixture = 'su () { printf "%s\\n" "$PROBE_TEXT" >&2; return "$PROBE_STATUS"; }; '
  for (const [status, text, accepted] of [[0, 'Jellyfin.Server 10.11.11.0', true], [1, 'Jellyfin.Server 10.11.11.0', true], [137, 'Jellyfin.Server 10.11.11.0', false], [1, 'Failed to create CoreCLR', false], [0, 'Jellyfin.Server 10.11.12.0', false], [1, '', false], [2, 'Jellyfin.Server 10.11.11.0', false], [1, 'Jellyfin.Server 10.11.11.0\nFailed to create CoreCLR', false]]) {
    const result = spawnSync('/bin/sh', ['-c', fixture + probe], { encoding: 'utf8', env: { ...process.env, PROBE_TEXT: text, PROBE_STATUS: String(status) }, timeout: 3000 })
    assert.equal(result.status === 0, accepted, `${status}: ${text}`)
  }
})

test('FreeBSD Jellyfin accepts only the reviewed upstream release and numeric packaging revisions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'intent-freebsd-pkg-'))
  try {
    await writeFile(path.join(directory, 'pkg'), '#!/bin/sh\nif [ "$1" = update ]; then exit 0; fi\nprintf "%s\\n" "$FIXTURE_PACKAGE_VERSION"\n', { mode: 0o700 })
    const command = buildFreebsdJellyfinTask(1, { platform: 'freebsd' }).plan.commands.find(item => item.id === 'install-jellyfin-runtime').command
    const preflight = command.split('; env ASSUME_ALWAYS_YES=yes pkg install')[0]
    assert.notEqual(preflight, command)
    for (const [version, accepted] of [['10.11.11', true], ['10.11.11_1', true], ['10.11.11_12,1', true], ['10.11.12', false], ['10.11.11_1;id', false], ['10.11.11\n10.11.11_1', false], ['', false]]) {
      const result = spawnSync('/bin/sh', ['-c', preflight], { encoding: 'utf8', env: { ...process.env, PATH: directory + ':' + process.env.PATH, FIXTURE_PACKAGE_VERSION: version }, timeout: 5000 })
      assert.equal(result.status, accepted ? 0 : 78, version)
      if (!accepted) assert.match(result.stderr, /PACKAGE_VERSION_MISMATCH/u)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
