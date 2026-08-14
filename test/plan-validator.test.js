import assert from 'node:assert/strict'
import test from 'node:test'
import { rootExecutionPolicy } from '../src/execution-policy.js'
import { executeApprovedPlan, validateCommandPlan } from '../src/plan-validator.js'

const ROOT_POLICY = rootExecutionPolicy({})

function plan () {
  return {
    summary: 'Inspect and then change',
    changeOverview: 'Install htop after inspecting nginx',
    modifiedFiles: ['/usr/bin/htop'],
    assumptions: [],
    warnings: [],
    requiresConfirmation: true,
    commands: [
      {
        id: 'inspect',
        command: 'systemctl status nginx',
        purpose: 'inspect',
        risk: 'read',
        timeoutMs: 5000,
        requiresSudo: false,
        dependsOn: []
      },
      {
        id: 'install',
        command: 'apt-get install -y htop',
        purpose: 'install htop',
        risk: 'change',
        timeoutMs: 10000,
        requiresSudo: true,
        dependsOn: ['inspect']
      }
    ],
    revertCommands: [{
      id: 'remove',
      command: 'apt-get remove -y htop',
      purpose: 'remove htop',
      risk: 'change',
      timeoutMs: 10000,
      requiresSudo: true,
      dependsOn: []
    }]
  }
}

test('plan policy is deterministic and requires preceding dependencies', () => {
  assert.equal(validateCommandPlan(plan(), ROOT_POLICY).commands.length, 2)
  assert.throws(() => validateCommandPlan(plan(), { executionIdentity: 'netdata' }), /forbids/)
  assert.throws(() => validateCommandPlan(plan(), { ...ROOT_POLICY, deniedPatterns: ['apt-get'] }), /denied/)

  const invalid = plan()
  invalid.commands.reverse()
  assert.throws(() => validateCommandPlan(invalid, ROOT_POLICY), /non-preceding/)

  const redundantSudo = plan()
  redundantSudo.commands[1].command = 'sudo apt-get install -y htop'
  assert.throws(() => validateCommandPlan(redundantSudo, ROOT_POLICY), /already executes as root/)

  const recursiveCommand = plan()
  recursiveCommand.commands[0].command = "curl 'http://127.0.0.1:19999/api/v3/function?function=webminai%3Acommand'"
  assert.throws(() => validateCommandPlan(recursiveCommand, ROOT_POLICY), /recursively invokes/)

  const obsoleteEndpoint = plan()
  obsoleteEndpoint.commands[0].command = "curl 'http://127.0.0.1:19999/api/v3/alarms'"
  assert.throws(() => validateCommandPlan(obsoleteEndpoint, ROOT_POLICY), /invalid Netdata API v3 endpoint/)

  const invalidFunctionPath = plan()
  invalidFunctionPath.commands[0].command = "curl 'http://127.0.0.1:19999/api/v3/function/processes'"
  assert.throws(() => validateCommandPlan(invalidFunctionPath, ROOT_POLICY), /function query parameter/)

  const duplicateDependency = plan()
  duplicateDependency.commands[1].dependsOn = ['inspect', 'inspect']
  assert.throws(() => validateCommandPlan(duplicateDependency, ROOT_POLICY), /duplicate dependencies/)

  for (const command of [
    'apt-get purge -y nginx curl',
    'dnf -y remove php-fpm netdata-plugin-go',
    'zypper --non-interactive remove openssh-server',
    'apk del mariadb curl',
    'pacman -Rns --noconfirm nginx netdata',
    'rm -f /usr/local/libexec/webminai-stage2'
  ]) {
    const unsafeRevert = plan()
    unsafeRevert.revertCommands[0].command = command
    assert.throws(() => validateCommandPlan(unsafeRevert, ROOT_POLICY), /Stage 2 prerequisite/)
  }

  const protectedExclusion = plan()
  protectedExclusion.revertCommands[0].command = "apk del $(grep -Ev '^(curl|netdata|openssh)$' /var/lib/webminai/task-state/1/packages-added)"
  assert.equal(validateCommandPlan(protectedExclusion, ROOT_POLICY).revertCommands.length, 1)
})

test('rejected commands block their dependants', async () => {
  const executed = []
  const results = await executeApprovedPlan({
    plan: plan(),
    policy: ROOT_POLICY,
    approve: async item => item.id !== 'inspect',
    netdata: {
      async runCommand (command) {
        executed.push(command)
        return { exitCode: 0 }
      }
    }
  })
  assert.deepEqual(results.map(result => result.status), ['rejected', 'blocked'])
  assert.deepEqual(executed, [])
})

test('controller retries only declared transient exit codes with short remote probes', async () => {
  const retryPlan = plan()
  retryPlan.commands = [{
    id: 'probe-job',
    command: 'test -f /var/lib/webminai/task-state/job.exit || exit 75',
    purpose: 'Probe a detached job',
    risk: 'read',
    timeoutMs: 5000,
    requiresSudo: true,
    dependsOn: [],
    retry: { attempts: 4, intervalMs: 0, exitCodes: [75] }
  }]
  let calls = 0
  const results = await executeApprovedPlan({
    plan: retryPlan,
    policy: ROOT_POLICY,
    approve: async () => true,
    netdata: {
      async runCommand () {
        calls++
        return calls < 3 ? { exitCode: 75, stdout: '', stderr: 'pending' } : { exitCode: 0, stdout: 'ready', stderr: '' }
      }
    }
  })
  assert.equal(calls, 3)
  assert.equal(results[0].status, 'completed')
  assert.equal(results[0].attempts, 3)

  retryPlan.commands[0].retry.attempts = 121
  assert.throws(() => validateCommandPlan(retryPlan, ROOT_POLICY), /invalid retry attempts/)
})

test('only explicitly opted-in commands use durable jobs and their longer timeout policy', async () => {
  const jobPlan = plan()
  jobPlan.commands = [{
    id: 'long-install',
    command: 'perform-long-install',
    purpose: 'Run a bounded long installation.',
    risk: 'change',
    timeoutMs: 30 * 60 * 1000,
    executionMode: 'job',
    requiresSudo: true,
    dependsOn: []
  }]
  assert.equal(validateCommandPlan(jobPlan, ROOT_POLICY), jobPlan)
  const calls = []
  const results = await executeApprovedPlan({
    plan: jobPlan,
    policy: ROOT_POLICY,
    approve: async () => true,
    netdata: {
      async runCommand () { throw new Error('synchronous route must not be used') },
      async runJob (command, options) {
        calls.push({ command, options })
        return { jobId: 'ef'.repeat(16), state: 'succeeded', exitCode: 0, stdout: 'done', stderr: '' }
      }
    }
  })
  assert.deepEqual(calls, [{ command: 'perform-long-install', options: { timeoutSeconds: 1800 } }])
  assert.equal(results[0].status, 'completed')
  assert.equal(results[0].result.jobId, 'ef'.repeat(16))

  const normalPlan = plan()
  normalPlan.commands[0].timeoutMs = 30 * 60 * 1000
  assert.throws(() => validateCommandPlan(normalPlan, ROOT_POLICY), /invalid timeout/)
  jobPlan.commands[0].executionMode = 'detached-shell'
  assert.throws(() => validateCommandPlan(jobPlan, ROOT_POLICY), /invalid execution mode/)
})

test('Windows drive paths are valid modified-file entries', () => {
  const windowsPlan = plan()
  windowsPlan.modifiedFiles = [
    'C:\\ProgramData\\WebminAI\\Tasks\\1\\nginx.conf',
    'C:/ProgramData/WebminAI/Tasks/1/index.html'
  ]
  assert.equal(validateCommandPlan(windowsPlan, ROOT_POLICY).modifiedFiles.length, 2)

  windowsPlan.modifiedFiles = ['ProgramData\\WebminAI\\index.html']
  assert.throws(() => validateCommandPlan(windowsPlan, ROOT_POLICY), /absolute paths/)

  windowsPlan.modifiedFiles = ['/C:\\ProgramData\\WebminAI\\index.html']
  assert.throws(() => validateCommandPlan(windowsPlan, ROOT_POLICY), /absolute paths/)
})

test('execution redacts output from commands that handle root-only service credentials', async () => {
  const sensitivePlan = plan()
  sensitivePlan.commands = [{
    id: 'credentials',
    command: 'umask 077; mkdir -p /root/ghost_credentials; openssl rand -hex 24 > /root/ghost_credentials/database_password',
    purpose: 'generate credentials',
    risk: 'change',
    timeoutMs: 5000,
    requiresSudo: true,
    dependsOn: []
  }]
  sensitivePlan.revertCommands = [{
    id: 'remove-credentials',
    command: 'rm -f /root/ghost_credentials/database_password; rmdir /root/ghost_credentials',
    purpose: 'remove task-created credentials',
    risk: 'destructive',
    timeoutMs: 5000,
    requiresSudo: true,
    dependsOn: []
  }]
  const results = await executeApprovedPlan({
    plan: sensitivePlan,
    policy: ROOT_POLICY,
    approve: async () => true,
    netdata: {
      async runCommand () {
        return { exitCode: 0, stdout: 'secret-value\n', stderr: 'secret-error\n' }
      }
    }
  })
  assert.equal(results[0].result.stdout, '[redacted sensitive output]')
  assert.equal(results[0].result.stderr, '[redacted sensitive output]')
})

test('failed phased commands receive a stable failure signature and fixed safe diagnostics', async () => {
  const calls = []
  const plan = {
    summary: 'Install package',
    changeOverview: 'Install one package.',
    modifiedFiles: ['/usr/bin/example'],
    commands: [{ id: 'install', phase: 'packages', command: 'apt-get install -y missing', purpose: 'Install.', risk: 'change', timeoutMs: 300000, requiresSudo: true, dependsOn: [], diagnostic: { kind: 'package', target: 'missing' } }],
    revertCommands: [{ id: 'revert', phase: 'cleanup', command: 'true', purpose: 'Revert.', risk: 'change', timeoutMs: 1000, requiresSudo: true, dependsOn: [] }]
  }
  const results = await executeApprovedPlan({
    plan,
    policy: { executionIdentity: 'root' },
    approve: async () => true,
    netdata: {
      async runCommand (command) {
        calls.push(command)
        if (calls.length === 1) return { exitCode: 100, stdout: '', stderr: 'E: Unable to locate package missing' }
        return { exitCode: 0, stdout: 'N: Unable to locate package missing', stderr: '' }
      }
    }
  })
  assert.equal(results[0].failure.code, 'PACKAGE_NOT_FOUND')
  assert.equal(results[0].failure.phase, 'packages')
  assert.equal(results[0].diagnostic.kind, 'package')
  assert.match(calls[1], /apt-cache policy 'missing'/u)
})
