import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createKubernetesApiCommand, createSignedCommand } from '../src/netdata-client.js'

const ACTION_KEY = '22'.repeat(32)

test('native plugin handles health, signed commands, and replay rejection', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webminai-plugin-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const keyFile = path.join(directory, 'action.key')
  await writeFile(keyFile, `${ACTION_KEY}\n`, { mode: 0o600 })

  const signed = createSignedCommand('printf plugin-ok', ACTION_KEY)
  const envelope = JSON.stringify(signed)
  const input = [
    'FUNCTION health-tx 5 "webminai:health" "any" "test"',
    'FUNCTION_PAYLOAD_BEGIN command-tx 5 "webminai:command" "any" "test" "application/json"',
    envelope,
    'FUNCTION_PAYLOAD_END',
    'FUNCTION_PAYLOAD replay-tx 5 "webminai:command" "any" "test" "application/json"',
    envelope,
    'FUNCTION_PAYLOAD_END',
    ''
  ].join('\n')

  const output = await runPlugin(input, keyFile)
  assert.match(output, /CHART webminai\.status/)
  assert.match(output, /SET active = 1/)
  assert.match(output, /FUNCTION GLOBAL "webminai:health"/)
  assert.match(output, /FUNCTION_RESULT_BEGIN health-tx 200/)
  assert.match(output, /"version":"0\.7\.2"/)
  assert.match(output, /"platform":"linux"/)
  assert.match(output, /"effectiveUid":\d+/)
  assert.match(output, /FUNCTION_RESULT_BEGIN command-tx 200/)
  assert.match(output, /"outputEncoding":"base64"/)
  assert.match(output, /"stdout":"cGx1Z2luLW9r"/)
  assert.match(output, /FUNCTION_RESULT_BEGIN replay-tx 403/)
  assert.match(output, /replayed signed payload/)
})

test('native plugin reports its independent release version', async () => {
  const plugin = fileURLToPath(new URL('../dist/webminai.plugin', import.meta.url))
  const version = await new Promise((resolve, reject) => {
    execFile(plugin, ['--version'], { encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
  })
  assert.equal(version, '0.7.2')
})

test('native plugin returns when an approved shell detaches a pipe-inheriting child', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webminai-plugin-detached-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const keyFile = path.join(directory, 'action.key')
  await writeFile(keyFile, `${ACTION_KEY}\n`, { mode: 0o600 })
  const signed = createSignedCommand('sleep 30 & printf detached-parent-ok', ACTION_KEY)
  const input = [
    'FUNCTION_PAYLOAD_BEGIN detached-tx 2 "webminai:command" "any" "test" "application/json"',
    JSON.stringify(signed),
    'FUNCTION_PAYLOAD_END',
    'QUIT',
    ''
  ].join('\n')

  const startedAt = Date.now()
  const output = await runPlugin(input, keyFile)
  assert.ok(Date.now() - startedAt < 5000, 'detached descendant held the function pipe open')
  assert.match(output, /FUNCTION_RESULT_BEGIN detached-tx 200/)
  assert.match(output, /"stdout":"ZGV0YWNoZWQtcGFyZW50LW9r"/)
})

test('native plugin starts, polls, cancels, and cleans durable command jobs', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webminai-plugin-job-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const keyFile = path.join(directory, 'action.key')
  const jobDirectory = path.join(directory, 'jobs')
  await writeFile(keyFile, `${ACTION_KEY}\n`, { mode: 0o600 })
  const plugin = fileURLToPath(new URL('../dist/webminai.plugin', import.meta.url))
  const session = startPluginSession(plugin, {
    WEBMINAI_KEY_FILE: keyFile,
    WEBMINAI_JOB_DIR: jobDirectory
  })
  t.after(() => session.stop())
  await session.waitFor(output => output.includes('FUNCTION GLOBAL "webminai:job_cleanup"'))

  let transaction = 0
  const request = async (functionName, value) => {
    transaction++
    return session.request(`job-tx-${transaction}`, functionName, createSignedCommand(value, ACTION_KEY))
  }
  const command = 'printf job-started; sleep 2; printf -- "\\njob-finished\\n"'
  const startRequest = `timeoutSeconds=10\ncommand=${Buffer.from(command).toString('base64url')}`
  const started = await request('job_start', startRequest)
  assert.equal(started.statusCode, 202)
  assert.match(started.body.jobId, /^[a-f0-9]{32}$/u)

  await new Promise(resolve => setTimeout(resolve, 700))
  const running = await request('job_status', started.body.jobId)
  assert.equal(running.body.state, 'running')
  assert.equal(Buffer.from(running.body.stdout, 'base64').toString(), 'job-started')

  let completed
  for (let attempt = 0; attempt < 20; attempt++) {
    completed = await request('job_status', started.body.jobId)
    if (completed.body.state !== 'running') break
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  assert.equal(completed.body.state, 'succeeded')
  assert.equal(completed.body.exitCode, 0)
  assert.equal(Buffer.from(completed.body.stdout, 'base64').toString(), 'job-started\njob-finished\n')
  assert.equal((await request('job_cleanup', started.body.jobId)).body.state, 'cleaned')

  const cancelCommand = 'printf cancel-started; sleep 30; printf must-not-run'
  const cancelStart = await request('job_start', `timeoutSeconds=60\ncommand=${Buffer.from(cancelCommand).toString('base64url')}`)
  assert.equal((await request('job_cancel', cancelStart.body.jobId)).body.state, 'cancelling')
  let cancelled
  for (let attempt = 0; attempt < 20; attempt++) {
    cancelled = await request('job_status', cancelStart.body.jobId)
    if (cancelled.body.state === 'cancelled') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(cancelled.body.state, 'cancelled')
  assert.notEqual(cancelled.body.exitCode, 0)
  assert.equal((await request('job_cleanup', cancelStart.body.jobId)).body.state, 'cleaned')

  const orphanStart = await request('job_start', `timeoutSeconds=60\ncommand=${Buffer.from('sleep 30').toString('base64url')}`)
  const controllerFile = path.join(jobDirectory, orphanStart.body.jobId, 'controller.pid')
  let controllerPid
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      controllerPid = Number.parseInt((await readFile(controllerFile, 'utf8')).trim(), 10)
      break
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  assert.ok(Number.isInteger(controllerPid) && controllerPid > 1)
  process.kill(controllerPid, 'SIGKILL')
  const orphaned = await request('job_status', orphanStart.body.jobId)
  assert.equal(orphaned.body.state, 'failed')
  assert.equal(orphaned.body.exitCode, 125)
  assert.match(Buffer.from(orphaned.body.stderr, 'base64').toString(), /controller exited before recording a result/u)
  assert.equal((await request('job_cleanup', orphanStart.body.jobId)).body.state, 'cleaned')
  await session.stop()
})

test('native plugin reports its target platform', async () => {
  const plugin = fileURLToPath(new URL('../dist/webminai.plugin', import.meta.url))
  const platform = await new Promise((resolve, reject) => {
    execFile(plugin, ['--platform'], { encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
  })
  assert.equal(platform, 'linux')
})

test('native plugin preserves FreeBSD API visibility for setgroups', async () => {
  const source = await readFile(fileURLToPath(new URL('../plugin/webminai.plugin.c', import.meta.url)), 'utf8')
  assert.match(source, /#if !defined\(__FreeBSD__\)\n#define _POSIX_C_SOURCE 200809L/)
  assert.match(source, /static bool hmac_sha256/)
  assert.doesNotMatch(source, /HMAC\(EVP_sha256/)
})

test('native Linux plugin isolates durable workers from Netdata systemd restarts without exposing command text', async () => {
  const source = await readFile(fileURLToPath(new URL('../plugin/webminai.plugin.c', import.meta.url)), 'utf8')
  assert.match(source, /systemd-run/u)
  assert.match(source, /--job-worker/u)
  assert.match(source, /#if defined\(WEBMINAI_PLATFORM_LINUX\)\nstatic bool persist_job_input/u)
  assert.match(source, /persist_job_input\(job_id, "command"/u)
  assert.doesNotMatch(source, /"--property=ExecStart=/u)
  assert.match(source, /execle\(shell_path, shell_name, "-c", command/)
})

test('Kubernetes plugin executes only a signed in-cluster API request', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'webminai-kubernetes-plugin-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const keyFile = path.join(directory, 'action.key')
  const tokenFile = path.join(directory, 'token')
  const caFile = path.join(directory, 'ca.crt')
  const curlFile = path.join(directory, 'curl')
  await writeFile(keyFile, `${ACTION_KEY}\n`, { mode: 0o600 })
  await writeFile(tokenFile, 'test-service-account-token\n', { mode: 0o600 })
  await writeFile(caFile, 'test-ca\n', { mode: 0o600 })
  await writeFile(curlFile, `#!/bin/sh
set -eu
method=
url=
authorization=
content_type=
config=
while [ "$#" -gt 0 ]; do
  case $1 in
    --request) method=$2; shift 2 ;;
    --header)
      case $2 in
        Authorization:*) authorization=$2 ;;
        Content-Type:*) content_type=$2 ;;
      esac
      shift 2
      ;;
    --config) config=$2; shift 2 ;;
    --max-time|--cacert|--data-binary) shift 2 ;;
    --*) shift ;;
    *) url=$1; shift ;;
  esac
done
body=$(cat)
[ "$(cat "$config")" = 'header = "Authorization: Bearer test-service-account-token"' ]
printf 'method=%s\\nurl=%s\\ncontent=%s\\nbody=%s\\n' "$method" "$url" "$content_type" "$body"
`)
  await chmod(curlFile, 0o755)

  const apiCommand = createKubernetesApiCommand({
    method: 'POST',
    path: '/apis/batch/v1/namespaces/webminai-stage2/jobs',
    body: { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'test-job' } }
  })
  const signed = createSignedCommand(apiCommand, ACTION_KEY)
  const rejectedShell = createSignedCommand('printf must-not-run', ACTION_KEY)
  const input = [
    'FUNCTION health-tx 5 "webminai:health" "any" "test"',
    'FUNCTION_PAYLOAD_BEGIN command-tx 5 "webminai:command" "any" "test" "application/json"',
    JSON.stringify(signed),
    'FUNCTION_PAYLOAD_END',
    'FUNCTION_PAYLOAD_BEGIN rejected-tx 5 "webminai:command" "any" "test" "application/json"',
    JSON.stringify(rejectedShell),
    'FUNCTION_PAYLOAD_END',
    ''
  ].join('\n')
  const plugin = fileURLToPath(new URL('../dist/webminai.plugin-kubernetes-amd64', import.meta.url))
  const output = await runPluginFile(plugin, input, {
    WEBMINAI_KEY_FILE: keyFile,
    WEBMINAI_KUBERNETES_TOKEN_FILE: tokenFile,
    WEBMINAI_KUBERNETES_CA_FILE: caFile,
    WEBMINAI_KUBERNETES_CURL: curlFile,
    KUBERNETES_SERVICE_HOST: '10.96.0.1',
    KUBERNETES_SERVICE_PORT_HTTPS: '443'
  })

  assert.match(output, /"platform":"kubernetes"/)
  assert.match(output, /"executionMode":"kubernetes-api"/)
  assert.match(output, /FUNCTION_RESULT_BEGIN command-tx 200/)
  assert.match(output, /FUNCTION_RESULT_BEGIN rejected-tx 200/)
  const expected = [
    'method=POST',
    'url=https://10.96.0.1:443/apis/batch/v1/namespaces/webminai-stage2/jobs',
    'content=Content-Type: application/json',
    'body={"apiVersion":"batch/v1","kind":"Job","metadata":{"name":"test-job"}}',
    ''
  ].join('\n')
  assert.match(output, new RegExp(`"stdout":"${Buffer.from(expected).toString('base64')}"`))
  assert.match(output, new RegExp(`"stderr":"${Buffer.from('invalid Kubernetes API request\n').toString('base64')}"`))
})

function runPlugin (input, keyFile) {
  return runPluginFile(fileURLToPath(new URL('../dist/webminai.plugin', import.meta.url)), input, {
    WEBMINAI_KEY_FILE: keyFile
  })
}

function runPluginFile (plugin, input, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(plugin, ['1'], {
      env: { ...process.env, ...environment },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.once('error', reject)
    child.once('close', code => {
      if (code !== 0) reject(new Error(`plugin exited ${code}: ${stderr}`))
      else resolve(stdout)
    })
    child.stdin.end(input)
  })
}

function startPluginSession (plugin, environment) {
  const child = spawn(plugin, ['1'], {
    env: { ...process.env, ...environment },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const state = { stdout: '', stderr: '', closed: false }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', data => { state.stdout += data })
  child.stderr.on('data', data => { state.stderr += data })
  child.once('close', () => { state.closed = true })

  const waitFor = async (predicate, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs
    while (!predicate(state.stdout)) {
      if (state.closed) throw new Error(`plugin closed before expected output: ${state.stderr}`)
      if (Date.now() >= deadline) throw new Error(`timed out waiting for plugin output: ${state.stdout}\n${state.stderr}`)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return state.stdout
  }

  return {
    waitFor,
    async request (transaction, functionName, envelope) {
      const offset = state.stdout.length
      child.stdin.write([
        `FUNCTION_PAYLOAD_BEGIN ${transaction} 10 "webminai:${functionName}" "any" "test" "application/json"`,
        JSON.stringify(envelope),
        'FUNCTION_PAYLOAD_END',
        ''
      ].join('\n'))
      await waitFor(output => output.slice(offset).includes('FUNCTION_RESULT_END'), 10000)
      const response = state.stdout.slice(offset)
      const match = response.match(new RegExp(`FUNCTION_RESULT_BEGIN ${transaction} (\\d+)[^\\n]*\\n([\\s\\S]*?)FUNCTION_RESULT_END`))
      if (!match) throw new Error(`could not parse plugin response: ${response}`)
      return { statusCode: Number(match[1]), body: JSON.parse(match[2].trim()) }
    },
    async stop () {
      if (state.closed) return
      child.stdin.end('QUIT\n')
      await new Promise(resolve => child.once('close', resolve))
    }
  }
}
