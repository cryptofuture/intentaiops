import assert from 'node:assert/strict'
import test from 'node:test'
import { executeApprovedPlan } from '../src/plan-validator.js'
import {
  detectPlannerPlatform,
  validateDockerAndSecrets,
  validateNetdataFunctions,
  validatePortablePlan,
  validateWindowsPlan
} from '../src/planner-platform-policy.js'

function planWith (command, overrides = {}) {
  return {
    modifiedFiles: [],
    commands: [{
      id: 'command',
      command,
      purpose: 'Exercise deterministic policy',
      risk: 'read',
      timeoutMs: 5000,
      requiresSudo: false,
      dependsOn: []
    }],
    revertCommands: [],
    ...overrides
  }
}

test('planner platform detection preserves inventory precedence and unknown fallback', () => {
  assert.equal(detectPlannerPlatform({ os: 'linux', platform: { os: 'Windows_NT' } }), 'windows')
  assert.equal(detectPlannerPlatform({ info: { agents: [{ application: { kernel: 'FreeBSD 15.1' } }] } }), 'freebsd')
  assert.equal(detectPlannerPlatform({ os: 'plan9' }), 'unknown')
})

test('portable policy rejects placeholders before platform-specific planning', () => {
  assert.throws(
    () => validatePortablePlan(planWith('install -d /var/lib/webminai/task-state/$' + '{TASK_ID}')),
    /unresolved task ID placeholder/u
  )
})

test('Windows policy uses execution inventory for LocalSystem package tools', () => {
  const plan = planWith('choco.exe install brave -y', { modifiedFiles: ['C:\\ProgramData\\WebminAI\\state.json'] })
  assert.throws(
    () => validateWindowsPlan(plan, { webminaiExecution: { commands: { chocolatey: false } } }, 'install a package'),
    /Chocolatey but it is unavailable/u
  )
  assert.doesNotThrow(() => validateWindowsPlan(plan, { webminaiExecution: { commands: { chocolatey: true } } }, 'install a package'))
})

test('Docker credential policy and Netdata function policy remain independent', () => {
  assert.throws(
    () => validateDockerAndSecrets(planWith('docker run example/service'), { webminaiDocker: { preferred: true } }),
    /Docker Compose instead of docker run/u
  )
  const netdataPlan = planWith("curl 'http://127.0.0.1:19999/api/v3/function?function=webminai%3Ahealth'")
  assert.doesNotThrow(() => validateNetdataFunctions(netdataPlan, {
    functions: { functions: [{ name: 'webminai:health' }] }
  }))
})

test('published Joomla login is not a secret and cannot exempt password or arbitrary login literals', () => {
  assert.doesNotThrow(() => validateDockerAndSecrets(planWith('joomla install --admin-username=webminai_admin --site-name=example'), {}))
  for (const command of ['username=webminai_admin', 'password=webminai_admin', 'joomla --admin-username=personal_admin', 'joomla --admin-username=webminai_admin_extra', 'joomla --admin-username=webminai_admin --password=fixture-secret', 'password="--admin-username=webminai_admin"']) {
    assert.throws(() => validateDockerAndSecrets(planWith(command), {}), /literal login or secret/u)
  }
})

test('captured credentials can be written to a private file without being classified as console output', async () => {
  const command = "set -eu; key=$(cat '/root/n8n_credentials/encryption_key'); umask 077; printf 'N8N_ENCRYPTION_KEY=%s\\n' \"$key\" > '/root/n8n_credentials/service.env'; printf 'configured\\n'"
  assert.doesNotThrow(() => validateDockerAndSecrets(planWith(command), {}))
  assert.doesNotThrow(() => validateDockerAndSecrets(planWith("cat /etc/hosts > '/root/n8n_credentials/host-copy'"), {}))
  assert.doesNotThrow(() => validateDockerAndSecrets(planWith("cat > '/root/n8n_credentials/service.env' <<'EOF'\nN8N_PORT=5678\nEOF"), {}))
  const plan = planWith(command, { summary: 'Private handoff', changeOverview: 'Write only the protected configuration' })
  const results = await executeApprovedPlan({
    plan,
    policy: {},
    netdata: { async runCommand () { return { exitCode: 0, stdout: 'synthetic-private-key-value', stderr: 'synthetic-private-key-value' } } },
    approve: async () => true
  })
  assert.equal(results[0].result.stdout, '[redacted sensitive output]')
  assert.equal(results[0].result.stderr, '[redacted sensitive output]')
})

for (const command of [
  "cat '/root/n8n_credentials/encryption_key'",
  "cat -n '/root/n8n_credentials/encryption_key'",
  "cat --number '/root/n8n_credentials/encryption_key'",
  "cat /etc/hosts '/root/n8n_credentials/encryption_key'",
  "cat < '/root/n8n_credentials/encryption_key'",
  "echo \"$(cat '/root/n8n_credentials/encryption_key')\"",
  "printf '%s' \"$(cat '/root/n8n_credentials/encryption_key')\"",
  "key=$(cat '/root/n8n_credentials/encryption_key'); printf '%s' \"$key\"",
  "key=$(cat '/root/n8n_credentials/encryption_key'); umask 077; printf '%s' \"$key\" > /tmp/public",
  "key=$(cat '/root/n8n_credentials/encryption_key'); umask 077; printf '%s' \"$key\" > '/root/n8n_credentials/service.env' >&2",
  "key=$(cat '/root/n8n_credentials/encryption_key'); umask 077; printf '%s' \"$key\" > '/root/n8n_credentials/service.env'; echo \"$key\"",
  `key=$(cat '/root/n8n_credentials/encryption_key'); umask 077; printf '%s' "$key" > '/root/n8n_credentials/service.env'; echo "${'$'}{key}"`,
  `key=$(cat '/root/n8n_credentials/encryption_key'); umask 077; printf '%s' "$key" > '/root/n8n_credentials/service.env'; echo "${'$'}{key@Q}"`,
  "key=$(cat '/root/n8n_credentials/encryption_key'); umask 077; printf '%s' \"$key\" > '/root/n8n_credentials/service.env'; export key; env",
  "key=$(cat '/root/n8n_credentials/encryption_key'); umask 077; printf '%s' \"$key\" > '/root/other_credentials/service.env'",
  "set -x; key=$(cat '/root/n8n_credentials/encryption_key'); umask 077; printf '%s' \"$key\" > '/root/n8n_credentials/service.env'"
]) {
  test(`private credential write exemption does not allow disclosure: ${command.slice(0, 35)}`, () => {
    assert.throws(() => validateDockerAndSecrets(planWith(command), {}), /credential|shell tracing/u)
  })
}
