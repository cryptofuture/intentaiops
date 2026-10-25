import assert from 'node:assert/strict'
import test from 'node:test'
import { collectComposeEvidence } from '../src/container-execution-evidence.js'
import { NetdataClient } from '../src/netdata-client.js'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { runProcess } from '../src/process-runner.js'

const diagnostic = { kind: 'compose', target: '/Users/mac/.webminai/services/n8n' }

test('macOS container diagnostics select Colima and disclose only structured observations', async () => {
  let command
  const client = { async runCommand (value) { command = value; return { exitCode: 0, stdout: JSON.stringify({ Id: 'a'.repeat(64), State: { OOMKilled: true, ExitCode: 137, FinishedAt: new Date(Date.now() - 1000).toISOString() }, Env: ['PASSWORD=private-fixture'] }) } } }
  const result = await collectComposeEvidence(client, diagnostic, new Date(Date.now() - 5000).toISOString(), { platform: 'macos', runtimeHome: '/Users/mac' })
  assert.match(command, /unset DOCKER_CONTEXT/u)
  assert.match(command, /DOCKER_HOST='unix:\/\/\/Users\/mac\/\.colima\/default\/docker\.sock'/u)
  assert.match(command, /label=com\.docker\.compose\.project\.working_dir=\/Users\/mac\/\.webminai\/services\/n8n/u)
  assert.match(command, /label=com\.docker\.compose\.project=\$projects/u)
  assert.match(command, /with index \.State "Health"/u)
  assert.doesNotMatch(command, /if \.State\.Health/u)
  assert.ok(result.some(value => value.code === 'WORKLOAD_OOM_KILLED'))
  assert.doesNotMatch(JSON.stringify(result), /private-fixture|PASSWORD/u)
})

test('unverified or mismatched macOS runtime identities never fall back to another Docker socket', async () => {
  for (const runtimeHome of [undefined, '/var/root', '/Users/other', "/Users/mac';id"]) {
    let calls = 0
    const result = await collectComposeEvidence({ async runCommand () { calls++; throw new Error('must not dispatch') } }, diagnostic, new Date().toISOString(), { platform: 'macos', runtimeHome })
    assert.equal(calls, 0)
    assert.equal(result[0].code, 'EVIDENCE_UNAVAILABLE')
  }
  let unknownCalls = 0
  const unknown = await collectComposeEvidence({ async runCommand () { unknownCalls++; throw new Error('must not dispatch') } }, diagnostic, new Date().toISOString(), { platform: 'unknown' })
  assert.equal(unknownCalls, 0)
  assert.equal(unknown[0].code, 'EVIDENCE_UNAVAILABLE')
})

test('shared Netdata evidence collection obtains the signed macOS runtime identity', async () => {
  const client = new NetdataClient({ ssh: {}, connectionUrl: 'ssh://mac@fixture' })
  client.evidencePlatform = 'macos'
  let inventories = 0
  client.macosExecutionInventory = async () => { inventories++; return { runtimeHome: '/Users/mac' } }
  client.runCommand = async command => command.includes('collectorComplete')
    ? { exitCode: 0, stdout: 'collectorComplete=1\n' }
    : { exitCode: 0, stdout: JSON.stringify({ Id: 'a'.repeat(64), State: { Health: { Status: 'healthy' } } }) }
  const evidence = await client.collectExecutionEvidence({ item: { diagnostic }, before: { platform: 'macos', observedAt: new Date().toISOString() } })
  assert.equal(inventories, 1)
  assert.deepEqual(evidence.workloadDiagnostics, [])
})

test('scoped discovery inspects an explicit Compose project and rejects empty or ambiguous matches', async t => {
  const directory = await mkdtemp('/tmp/icdiag-')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const trace = `${directory}/inspections`
  await writeFile(`${directory}/docker`, `#!/bin/sh
set -eu
if [ "$1" = inspect ]; then printf '%s\\n' "$*" >> '${trace}'; printf '%s\\n' '{"Id":"${'a'.repeat(64)}","State":{"Health":{"Status":"healthy"}}}'; exit 0; fi
[ "$1" = ps ] || exit 1
case " $* " in
  *' --format '*) case "$PROJECT_CASE" in empty) :;; ambiguous) printf 'explicit-project\\nother-project\\n';; *) printf 'explicit-project\\n';; esac;;
  *' --quiet '*) case "$*" in *label=com.docker.compose.project=explicit-project*) printf '%s\\n' '${'a'.repeat(64)}';; *) exit 1;; esac;;
  *) exit 1;;
esac
`, { mode: 0o700 })
  for (const mode of ['explicit', 'empty', 'ambiguous']) {
    await writeFile(trace, '')
    const client = { async runCommand (command) { const result = await runProcess('/bin/sh', ['-c', command], { timeoutMs: 2000, env: { ...process.env, PATH: `${directory}:/usr/bin:/bin`, PROJECT_CASE: mode } }); return { ...result, exitCode: result.code } } }
    const result = await collectComposeEvidence(client, { kind: 'compose', target: '/reviewed/project' }, new Date().toISOString(), { platform: 'linux' })
    const inspected = await readFile(trace, 'utf8')
    if (mode === 'explicit') { assert.deepEqual(result, []); assert.match(inspected, new RegExp('a'.repeat(64), 'u')) } else { assert.equal(result[0].code, 'EVIDENCE_UNAVAILABLE'); assert.equal(inspected, '') }
  }
})
