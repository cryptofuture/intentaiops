import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CodexPlanner } from '../src/codex-planner.js'
import { listCommonTasks } from '../src/common-tasks.js'

test('Codex semantically routes requests against the verified Linux catalog', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-routing-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  let call
  const planner = new CodexPlanner({
    runner: async (binary, args, options) => {
      call = {
        binary,
        prompt: options.input,
        schema: JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8'))
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          decision: 'informed_planning',
          catalogId: 'none',
          relevantCatalogIds: ['wordpress-linux', 'moodle-linux'],
          confidence: 'high',
          rationale: 'The custom PHP learning portal can reuse the reviewed nginx, PHP-FPM socket, database, credential, and rollback patterns.'
        }),
        stderr: ''
      }
    }
  })
  const routed = await planner.routeTask({
    serverDirectory,
    request: 'Build an internal PHP learning portal with scheduled jobs and protected accounts.',
    inventory: { os: 'linux' },
    candidates: [
      { id: 'wordpress-linux', label: 'WordPress', description: 'Reviewed PHP site' },
      { id: 'moodle-linux', label: 'Moodle', description: 'Reviewed PHP site with cron' }
    ]
  })
  assert.equal(call.binary, 'codex')
  assert.match(call.prompt, /Judge semantic intent, not keywords or phrasing/u)
  assert.match(call.prompt, /reviewed application, runtime-prerequisite, diagnostic, and maintenance tasks eligible for the observed host platform/u)
  assert.match(call.prompt, /Never claim that installing only the prerequisite fully completes the application request/u)
  assert.match(call.prompt, /Build an internal PHP learning portal/u)
  assert.deepEqual(call.schema.required, ['decision', 'catalogId', 'relevantCatalogIds', 'foundationIds', 'foundationMode', 'confidence', 'rationale'])
  assert.deepEqual(call.schema.properties.catalogId.enum.filter(id => id !== 'none'), [
    ...listCommonTasks({ category: 'application' }).map(item => item.id),
    ...listCommonTasks({ category: 'diagnostic' }).map(item => item.id),
    ...listCommonTasks({ category: 'maintenance' }).map(item => item.id)
  ])
  assert.equal(routed.decision, 'informed_planning')
  assert.deepEqual(routed.relevantCatalogIds, ['wordpress-linux', 'moodle-linux'])
})

test('Codex routing accepts an exact verified host-health diagnostic task', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-health-routing-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  const planner = new CodexPlanner({
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify({
        decision: 'verified_task',
        catalogId: 'host-health-linux',
        relevantCatalogIds: ['host-health-linux'],
        confidence: 'high',
        rationale: 'The request exactly asks for the reviewed read-only host health report.'
      }),
      stderr: ''
    })
  })
  const routed = await planner.routeTask({
    serverDirectory,
    request: 'Give me a concise full health report for this server.',
    inventory: { os: 'linux' },
    candidates: listCommonTasks({ category: 'diagnostic', platform: 'linux' })
  })
  assert.equal(routed.catalogId, 'host-health-linux')
  assert.equal(routed.decision, 'verified_task')
})

test('Codex routing accepts the verified current-release system update task', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-update-routing-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  const planner = new CodexPlanner({
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify({
        decision: 'verified_task',
        catalogId: 'system-update-freebsd',
        relevantCatalogIds: ['system-update-freebsd'],
        confidence: 'high',
        rationale: 'The request exactly asks for the reviewed same-release update without an OS upgrade or reboot.'
      }),
      stderr: ''
    })
  })
  const routed = await planner.routeTask({
    serverDirectory,
    request: 'Install all current FreeBSD updates, do not upgrade the release, and do not reboot.',
    inventory: { os: 'freebsd' },
    candidates: listCommonTasks({ category: 'maintenance', platform: 'freebsd' })
  })
  assert.equal(routed.catalogId, 'system-update-freebsd')
  assert.equal(routed.decision, 'verified_task')
})

test('Codex planner reads bounded verified candidate intelligence for custom tasks', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-candidate-context-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  let reference
  let prompt
  const planner = new CodexPlanner({
    runner: async (binary, args, options) => {
      prompt = options.input
      reference = JSON.parse(await readFile(path.join(options.cwd, 'verified-candidate-context.json'), 'utf8'))
      return {
        code: 0,
        stdout: JSON.stringify({
          summary: 'Inspect the custom PHP service',
          changeOverview: 'Read service state without changing it',
          modifiedFiles: [],
          assumptions: [],
          warnings: [],
          requiresConfirmation: false,
          commands: [{ id: 'inspect', command: 'php -v', purpose: 'Read the installed PHP version', risk: 'read', timeoutMs: 5000, requiresSudo: false, dependsOn: [] }],
          revertCommands: []
        }),
        stderr: ''
      }
    }
  })
  const planned = await planner.plan({
    serverDirectory,
    request: 'Inspect my custom PHP service',
    inventory: { os: 'linux' },
    policy: {},
    applicationDefaults: { adminEmail: 'owner@example.test' },
    candidateContext: [{ catalogId: 'wordpress-linux', verifiedPlan: { summary: 'Reviewed WordPress plan' } }]
  })
  assert.equal(reference[0].catalogId, 'wordpress-linux')
  assert.match(prompt, /verified-candidate-context\.json/u)
  assert.match(prompt, /Do not turn the custom task into the referenced application deployment/u)
  assert.match(prompt, /use the user preset owner@example\.test/u)
  assert.deepEqual(planned.commands[0].source, { type: 'ai-planned' })
})

test('Codex planner uses luna medium in an isolated sanitized job directory', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  await writeFile(path.join(serverDirectory, 'context.md'), 'Role: web server\n')

  let call
  const output = {
    summary: 'Inspect the host',
    changeOverview: 'Read system load without changing files',
    modifiedFiles: [],
    assumptions: [],
    warnings: [],
    requiresConfirmation: false,
    commands: [{
      id: 'uptime',
      command: 'uptime',
      purpose: 'Read load averages',
      risk: 'read',
      timeoutMs: 5000,
      requiresSudo: false,
      dependsOn: []
    }],
    revertCommands: []
  }
  const planner = new CodexPlanner({
    runner: async (binary, args, options) => {
      call = {
        binary,
        args,
        options,
        schema: JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8')),
        inventory: await readFile(path.join(options.cwd, 'inventory.json'), 'utf8'),
        context: await readFile(path.join(options.cwd, 'context.md'), 'utf8')
      }
      return { code: 0, stdout: JSON.stringify(output), stderr: '' }
    }
  })

  const result = await planner.plan({
    serverDirectory,
    request: 'check load',
    inventory: {
      os: 'linux',
      connectionUrl: undefined,
      webminaiLinuxContext: { identity: { id: 'ubuntu', versionId: '24.04' }, management: { packageManager: 'apt' } },
      contexts: { contexts: { 'system.load': { live: true } } },
      functions: { functions: [{ name: 'containers-vms', help: 'List containers' }] }
    },
    policy: { allowSudo: false, executionIdentity: 'root' }
  })
  assert.equal(result.commands[0].command, 'uptime')
  assert.equal(call.binary, 'codex')
  assert.deepEqual(call.args.slice(0, 2), ['exec', '--cd'])
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'gpt-5.6-luna')
  assert.equal(call.args[call.args.indexOf('--config') + 1], 'model_reasoning_effort="medium"')
  assert.ok(call.args.includes('approval_policy="never"'))
  assert.ok(call.args.includes('--strict-config'))
  assert.ok(call.args.includes('--ignore-user-config'))
  assert.ok(call.args.includes('--ignore-rules'))
  assert.match(call.options.input, /check load/)
  assert.match(call.options.input, /Commands execute as root\. Never include sudo/)
  assert.match(call.options.input, /target operating system is Linux/)
  assert.match(call.options.input, /webminaiLinuxContext as the initial Linux platform baseline/)
  assert.match(call.options.input, /candidatePackages list is a distro-specific starting point/)
  assert.match(call.options.input, /Use `set -eu` without xtrace/)
  assert.match(call.options.input, /NodeSource nodejs package bundles npm/)
  assert.match(call.options.input, /Netdata is the preferred source for monitoring/)
  assert.match(call.options.input, /use information already present there instead of adding redundant shell probes/)
  assert.match(call.options.input, /do not add Netdata curl\/API commands merely to capture another pre-task or post-task snapshot/)
  assert.match(call.options.input, /Never invoke the webminai:command function/)
  assert.match(call.options.input, /\/api\/v3\/charts and \/api\/v3\/alarms do not exist/)
  assert.match(call.options.input, /contexts query parameter \(not chart\)/)
  assert.match(call.options.input, /never use \/api\/v3\/function\/NAME/)
  assert.match(call.options.input, /Do not wrap a command in sh -c or bash -c/)
  assert.match(call.options.input, /commands and revertCommands are independent dependency graphs/)
  assert.match(call.options.input, /never make a revertCommand depend on a forward command ID/)
  assert.match(call.options.input, /when the user explicitly asks for them/)
  assert.match(call.options.input, /"system\.load"/)
  assert.match(call.options.input, /"containers-vms"/)
  assert.match(call.options.input, /"webminaiLinuxContext"/)
  assert.match(call.options.input, /"versionId": "24\.04"/)
  assert.match(call.inventory, /"os": "linux"/)
  assert.equal(call.inventory.includes('ssh://'), false)
  assert.equal(call.context, 'Role: web server\n')
  assert.equal(call.schema.properties.commands.items.properties.dependsOn.uniqueItems, undefined)
  assert.equal(new RegExp(call.schema.properties.modifiedFiles.items.pattern).test('C:\\ProgramData\\WebminAI\\state.json'), true)
  await assert.rejects(readFile(call.options.cwd), /ENOENT/)
})

test('Codex planner prefers Compose and keeps generated service credentials out of output', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  let prompt
  const output = {
    summary: 'Deploy Ghost with Compose',
    changeOverview: 'Create a Compose application and root-only generated credentials',
    modifiedFiles: ['/opt/webminai/services/ghost/compose.yaml', '/root/ghost_credentials/credentials.env'],
    assumptions: [],
    warnings: [],
    requiresConfirmation: true,
    commands: [{
      id: 'prepare-ghost',
      command: "umask 077; install -d -m 0700 /root/ghost_credentials; openssl rand -hex 32 > /root/ghost_credentials/database_password; chmod 0600 /root/ghost_credentials/database_password; install -d -m 0755 /opt/webminai/services/ghost; printf '%s\\n' 'services:' '  ghost:' '    image: ghost:6' '    env_file: /root/ghost_credentials/credentials.env' > /opt/webminai/services/ghost/compose.yaml",
      purpose: 'Create root-only credentials and Compose definition without printing values',
      risk: 'change',
      timeoutMs: 30000,
      requiresSudo: true,
      dependsOn: []
    }, {
      id: 'start-ghost',
      command: 'docker compose -f /opt/webminai/services/ghost/compose.yaml up -d',
      purpose: 'Start Ghost through Compose',
      risk: 'change',
      timeoutMs: 300000,
      requiresSudo: true,
      dependsOn: ['prepare-ghost']
    }],
    revertCommands: [{
      id: 'stop-ghost',
      command: 'docker compose -f /opt/webminai/services/ghost/compose.yaml down; rm -f /opt/webminai/services/ghost/compose.yaml /root/ghost_credentials/database_password; rmdir /opt/webminai/services/ghost /root/ghost_credentials',
      purpose: 'Stop the Compose service and remove task-created files',
      risk: 'destructive',
      timeoutMs: 300000,
      requiresSudo: true,
      dependsOn: []
    }]
  }
  const planner = new CodexPlanner({
    runner: async (binary, args, options) => {
      prompt = options.input
      return { code: 0, stdout: JSON.stringify(output), stderr: '' }
    }
  })
  const plan = await planner.plan({
    serverDirectory,
    request: 'set up a Ghost blog',
    inventory: {
      os: 'linux',
      webminaiDocker: {
        preference: 'auto',
        preferred: true,
        ready: true,
        reason: 'Docker Compose is available on a non-container host'
      }
    },
    policy: { executionIdentity: 'root' }
  })
  assert.equal(plan.commands[1].command.startsWith('docker compose'), true)
  assert.match(prompt, /Prefer Docker Compose/)
  assert.match(prompt, /Never place a generated or literal password/)
  assert.match(prompt, /\/root\/<service>_credentials/)
})

test('Codex planner accepts quoted references to host-generated credential variables', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  const output = {
    summary: 'Configure an application',
    changeOverview: 'Generate and consume a protected credential',
    modifiedFiles: ['/root/example_credentials/admin_password'],
    assumptions: [],
    warnings: [],
    requiresConfirmation: true,
    commands: [{
      id: 'generate',
      command: 'set -o errexit -o nounset -o xtrace; umask 077; install -d -m 0700 /root/example_credentials; openssl rand -hex 32 > /root/example_credentials/admin_password; chmod 0600 /root/example_credentials/admin_password',
      purpose: 'Generate a protected password',
      risk: 'change',
      timeoutMs: 30000,
      requiresSudo: true,
      dependsOn: []
    }, {
      id: 'consume',
      command: 'set -eu; admin_password=$(sed -n 1p /root/example_credentials/admin_password); example-installer --admin-password "$admin_password"',
      purpose: 'Consume the protected password by variable reference',
      risk: 'change',
      timeoutMs: 30000,
      requiresSudo: true,
      dependsOn: ['generate']
    }],
    revertCommands: [{
      id: 'remove',
      command: 'rm -f /root/example_credentials/admin_password; rmdir /root/example_credentials',
      purpose: 'Remove the protected credential',
      risk: 'destructive',
      timeoutMs: 30000,
      requiresSudo: true,
      dependsOn: []
    }]
  }
  const planner = new CodexPlanner({
    runner: async () => ({ code: 0, stdout: JSON.stringify(output), stderr: '' })
  })
  const plan = await planner.plan({
    serverDirectory,
    request: 'configure an example application',
    inventory: { os: 'linux' },
    policy: { executionIdentity: 'root' }
  })
  assert.match(plan.commands[0].command, /^set -o errexit -o nounset;/u)
  assert.doesNotMatch(plan.commands[0].command, /\bset\s+-[A-Za-z]*x[A-Za-z]*\b|\b-o\s+xtrace\b/u)
  assert.equal(plan.commands[1].id, 'consume')
})

test('Codex planner supplies Linux WordPress checksum and external listener facts', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  let prompt
  const planner = new CodexPlanner({
    runner: async (binary, args, options) => {
      prompt = options.input
      return {
        code: 0,
        stdout: JSON.stringify({
          summary: 'Prepare WordPress task state',
          changeOverview: 'Create the exact task state directory',
          modifiedFiles: ['/var/lib/webminai/task-state/42'],
          assumptions: [],
          warnings: [],
          requiresConfirmation: true,
          commands: [{ id: 'prepare-state', command: "install -d -m 0700 '/var/lib/webminai/task-state/42'", purpose: 'Prepare task state', risk: 'change', timeoutMs: 5000, requiresSudo: true, dependsOn: [] }],
          revertCommands: [{ id: 'remove-state', command: "rmdir '/var/lib/webminai/task-state/42'", purpose: 'Remove task state', risk: 'destructive', timeoutMs: 5000, requiresSudo: true, dependsOn: [] }]
        }),
        stderr: ''
      }
    }
  })
  await planner.plan({
    serverDirectory,
    request: 'install WordPress on port 18101',
    taskId: 42,
    inventory: {
      os: 'linux',
      webminaiDocker: { preference: 'disabled', preferred: false, ready: true, reason: 'manually disabled' },
      webminaiLinuxContext: { identity: { id: 'ubuntu', versionId: '24.04' }, management: { packageManager: 'apt' } }
    },
    policy: { executionIdentity: 'root' }
  })
  assert.match(prompt, /latest\.tar\.gz\.sha1 response may contain only the hexadecimal digest/)
  assert.match(prompt, /do not pass the raw downloaded response to sha1sum -c/)
  assert.match(prompt, /effective listener on 0\.0\.0\.0 or ::/)
  assert.match(prompt, /Do not configure the WordPress home URL, site URL, or wp core install --url as localhost/)
  assert.match(prompt, /webminaiLinuxContext\.applications\.wordpress as the authoritative deployment profile/)
  assert.match(prompt, /profile wpCliPhar through the profile phpBinary/)
  assert.match(prompt, /profile databaseHost exactly/)
  assert.match(prompt, /task-owned Unix socket \/run\/webminai-wordpress-18101\/php-fpm\.sock/)
  assert.match(prompt, /nginx fastcgi_pass unix:\/run\/webminai-wordpress-18101\/php-fpm\.sock/)
  assert.match(prompt, /fastcgi_param HTTP_HOST \$http_host/)
  assert.match(prompt, /profile primaryAddressCommand based on ip -o -4 addr show scope global/)
  assert.match(prompt, /Do not use reload for this fleet task/)
  assert.match(prompt, /pipe the protected single value to wp config create --prompt=dbpass/)
  assert.match(prompt, /raw\.githubusercontent\.com\/wp-cli\/builds\/gh-pages\/phar\/wp-cli\.phar/)
  assert.match(prompt, /checksum response is a bare 128-hex digest/)
  assert.match(prompt, /without disabling SELinux/)
  assert.match(prompt, /latest\.tar\.gz\.sha1 is exactly 40 hexadecimal bytes and has no trailing newline/)
  assert.match(prompt, /put --output PATH before the URL/)
  assert.match(prompt, /must never remove, replace, disable, or reconfigure Intent AI Ops Stage 2 prerequisites/)
  assert.match(prompt, /Use one stable application ownership identity across the complete retry chain/)
  assert.match(prompt, /openSUSE Leap 16 uses nginx, mariadb, php8-fpm, php8-mysql, php8-dom/)
  assert.match(prompt, /Alpine 3\.23 uses nginx, mariadb, mariadb-client/)
  assert.match(prompt, /--no-recommends is accepted by the install subcommand/)
  assert.match(prompt, /Commands execute independently and do not share shell variables/)
  assert.match(prompt, /Give package installation commands timeoutMs 300000/)
  assert.match(prompt, /Use a stable site identity webminai-wordpress-18101/)
  assert.match(prompt, /exact task-state directory for this plan is \/var\/lib\/webminai\/task-state\/42/)
  assert.doesNotMatch(prompt, /<taskId>/)
  assert.match(prompt, /Keep package installation, upstream artifact retrieval\/verification, credential generation/)
  assert.match(prompt, /Never use apt-cache policy, apk search, dnf\/yum repoquery\/list, zypper search/)
  assert.match(prompt, /installedPackages and availableServiceUnits are current facts/)
})

test('Codex planner keeps the original task-state directory across retries', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  let prompt
  const output = {
    summary: 'Reuse WordPress task ownership',
    changeOverview: 'Reuse the initial retry-chain state directory',
    modifiedFiles: ['/var/lib/webminai/task-state/36'],
    assumptions: [],
    warnings: [],
    requiresConfirmation: true,
    commands: [{ id: 'state', command: "test -d '/var/lib/webminai/task-state/36'; touch '/var/lib/webminai/task-state/36/retried'", purpose: 'Reuse state', risk: 'change', timeoutMs: 30000, requiresSudo: true, dependsOn: [] }],
    revertCommands: [{ id: 'remove', command: "rm -f '/var/lib/webminai/task-state/36/retried'", purpose: 'Remove retry marker', risk: 'destructive', timeoutMs: 30000, requiresSudo: true, dependsOn: [] }]
  }
  const planner = new CodexPlanner({
    runner: async (binary, args, options) => {
      prompt = options.input
      return { code: 0, stdout: JSON.stringify(output), stderr: '' }
    }
  })
  await planner.plan({
    serverDirectory,
    request: 'install WordPress on port 18101',
    taskId: 38,
    previousAttempts: [{ id: 36, status: 'failed', results: [] }, { id: 37, status: 'failed', results: [] }],
    inventory: { os: 'linux', webminaiDocker: { preferred: false } },
    policy: { executionIdentity: 'root' }
  })
  assert.match(prompt, /exact task-state directory for this plan is \/var\/lib\/webminai\/task-state\/36/)
  assert.doesNotMatch(prompt, /exact task-state directory for this plan is \/var\/lib\/webminai\/task-state\/38/)
})

test('Codex planner automatically rejects unresolved task ID placeholders', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  let calls = 0
  let correctedPrompt
  const planner = new CodexPlanner({
    runner: async (binary, args, options) => {
      calls++
      if (calls === 2) correctedPrompt = options.input
      return {
        code: 0,
        stdout: JSON.stringify(calls === 1
          ? {
              summary: 'Prepare WordPress state',
              changeOverview: 'Use an unresolved task state placeholder',
              modifiedFiles: ['/var/lib/webminai/task-state/<taskId>'],
              assumptions: [],
              warnings: [],
              requiresConfirmation: true,
              commands: [{ id: 'state', command: "install -d -m 0700 '/var/lib/webminai/task-state/<taskId>'", purpose: 'Create state', risk: 'change', timeoutMs: 30000, requiresSudo: true, dependsOn: [] }],
              revertCommands: [{ id: 'remove-state', command: "rmdir '/var/lib/webminai/task-state/<taskId>'", purpose: 'Remove state', risk: 'destructive', timeoutMs: 30000, requiresSudo: true, dependsOn: [] }]
            }
          : {
              summary: 'Prepare exact WordPress state',
              changeOverview: 'Use the supplied concrete task state path',
              modifiedFiles: ['/var/lib/webminai/task-state/42'],
              assumptions: [],
              warnings: [],
              requiresConfirmation: true,
              commands: [{ id: 'state', command: "install -d -m 0700 '/var/lib/webminai/task-state/42'", purpose: 'Create state', risk: 'change', timeoutMs: 30000, requiresSudo: true, dependsOn: [] }],
              revertCommands: [{ id: 'remove-state', command: "rmdir '/var/lib/webminai/task-state/42'", purpose: 'Remove state', risk: 'destructive', timeoutMs: 30000, requiresSudo: true, dependsOn: [] }]
            }),
        stderr: ''
      }
    }
  })

  await planner.plan({
    serverDirectory,
    request: 'install WordPress on port 18101',
    taskId: 42,
    inventory: { os: 'linux', webminaiDocker: { preferred: false } },
    policy: { executionIdentity: 'root' }
  })
  assert.equal(calls, 2)
  assert.match(correctedPrompt, /unresolved task ID placeholder/)
})

test('Codex planner automatically rejects Linux WordPress repository availability gates', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  let calls = 0
  let correctedPrompt
  const planner = new CodexPlanner({
    runner: async (binary, args, options) => {
      calls++
      if (calls === 2) correctedPrompt = options.input
      return {
        code: 0,
        stdout: JSON.stringify(calls === 1
          ? {
              summary: 'Preflight WordPress packages',
              changeOverview: 'Reject packages using a repository query',
              modifiedFiles: [],
              assumptions: [],
              warnings: [],
              requiresConfirmation: false,
              commands: [{ id: 'packages', command: 'dnf repoquery --available nginx php-fpm', purpose: 'Gate package availability', risk: 'read', timeoutMs: 30000, requiresSudo: false, dependsOn: [] }],
              revertCommands: []
            }
          : {
              summary: 'Prepare corrected WordPress state',
              changeOverview: 'Use the exact task state path without a repository gate',
              modifiedFiles: ['/var/lib/webminai/task-state/42'],
              assumptions: [],
              warnings: [],
              requiresConfirmation: true,
              commands: [{ id: 'prepare', command: "install -d -m 0700 '/var/lib/webminai/task-state/42'", purpose: 'Prepare corrected state', risk: 'change', timeoutMs: 5000, requiresSudo: true, dependsOn: [] }],
              revertCommands: [{ id: 'remove', command: "rmdir '/var/lib/webminai/task-state/42'", purpose: 'Remove corrected state', risk: 'destructive', timeoutMs: 5000, requiresSudo: true, dependsOn: [] }]
            }),
        stderr: ''
      }
    }
  })

  await planner.plan({
    serverDirectory,
    request: 'install WordPress on port 18101',
    taskId: 42,
    inventory: { os: 'linux', webminaiDocker: { preferred: false } },
    policy: { executionIdentity: 'root' }
  })
  assert.equal(calls, 2)
  assert.match(correctedPrompt, /unreliable repository-availability gate/)
})

test('Codex planner rejects Docker when effective host preference disables it', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  const output = {
    summary: 'Run a service',
    changeOverview: 'Incorrectly use Docker on a disabled host',
    modifiedFiles: ['/opt/webminai/services/demo/compose.yaml'],
    assumptions: [],
    warnings: [],
    requiresConfirmation: true,
    commands: [{ id: 'start', command: 'docker compose -f /opt/webminai/services/demo/compose.yaml up -d', purpose: 'start', risk: 'change', timeoutMs: 30000, requiresSudo: true, dependsOn: [] }],
    revertCommands: [{ id: 'stop', command: 'docker compose -f /opt/webminai/services/demo/compose.yaml down', purpose: 'stop', risk: 'change', timeoutMs: 30000, requiresSudo: true, dependsOn: [] }]
  }
  const planner = new CodexPlanner({ runner: async () => ({ code: 0, stdout: JSON.stringify(output), stderr: '' }) })
  await assert.rejects(planner.plan({
    serverDirectory,
    request: 'deploy a service',
    inventory: {
      os: 'linux',
      webminaiDocker: { preference: 'auto', preferred: false, ready: true, reason: 'automatic Docker use is disabled because this host is a lxc' }
    },
    policy: { executionIdentity: 'root' }
  }), /Docker is not enabled/)
})

test('Codex planner requires POSIX and FreeBSD administration conventions for a FreeBSD inventory', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  let prompt
  const planner = new CodexPlanner({
    runner: async (binary, args, options) => {
      prompt = options.input
      return {
        code: 0,
        stdout: JSON.stringify({
          summary: 'Install a package',
          changeOverview: 'Install htop with pkg',
          modifiedFiles: [],
          assumptions: [],
          warnings: [],
          requiresConfirmation: true,
          commands: [{
            id: 'install-htop',
            command: 'pkg install -y htop',
            purpose: 'Install htop',
            risk: 'change',
            timeoutMs: 120000,
            requiresSudo: true,
            dependsOn: []
          }],
          revertCommands: [{
            id: 'remove-htop',
            command: 'pkg delete -y htop',
            purpose: 'Remove htop installed by this task',
            risk: 'change',
            timeoutMs: 120000,
            requiresSudo: true,
            dependsOn: []
          }]
        }),
        stderr: ''
      }
    }
  })

  await planner.plan({
    serverDirectory,
    request: 'install htop',
    inventory: {
      info: {
        agents: [{ application: { os: { name: 'FreeBSD', version: '14.3' } } }]
      }
    },
    policy: { executionIdentity: 'root' },
    taskId: 18
  })

  assert.match(prompt, /target operating system is FreeBSD/)
  assert.match(prompt, /executed by \/bin\/sh, not Bash/)
  assert.match(prompt, /Use pkg for packages, service\/sysrc for rc\.d services/)
  assert.match(prompt, /one-shot actions such as onestart, onestop, onerestart, and onereload/)
  assert.match(prompt, /local address is field 6/)
  assert.match(prompt, /restrictive umask/)
  assert.match(prompt, /explicitly set the required ownership and modes/)
  assert.match(prompt, /restore an unrelated file merely as a precaution/)
  assert.match(prompt, /restore its exact prior state/)
  assert.match(prompt, /\/var\/db\/webminai\/task-state\/18/)
})

test('Codex planner uses Windows PowerShell conventions for a Windows inventory', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  let prompt
  const planner = new CodexPlanner({
    runner: async (binary, args, options) => {
      prompt = options.input
      return {
        code: 0,
        stdout: JSON.stringify({
          summary: 'Inspect a Windows service',
          changeOverview: 'Read service state without changing files',
          modifiedFiles: [],
          assumptions: [],
          warnings: [],
          requiresConfirmation: false,
          commands: [{
            id: 'inspect-service',
            command: 'Get-Service -Name Netdata',
            purpose: 'Read Netdata service state',
            risk: 'read',
            timeoutMs: 5000,
            requiresSudo: false,
            dependsOn: []
          }],
          revertCommands: []
        }),
        stderr: ''
      }
    }
  })

  await planner.plan({
    serverDirectory,
    request: 'inspect Netdata',
    inventory: {
      info: { agents: [{ application: { os: 'Windows 11' } }] },
      webminaiExecution: {
        identity: 'LocalSystem',
        powerShellVersion: '5.1.26200.6899',
        nativeProcessMode: 'start-process-wait',
        commands: { winget: false, chocolatey: false, msiexec: true, curl: true }
      }
    },
    policy: { executionIdentity: 'root' }
  })

  assert.match(prompt, /target operating system is Windows/)
  assert.match(prompt, /Windows PowerShell 5\.1 as LocalSystem/)
  assert.match(prompt, /Commands execute as LocalSystem/)
  assert.match(prompt, /Do not use Bash, sudo, systemctl, Unix package managers/)
  assert.match(prompt, /New-Item accepts -Path but not -LiteralPath/)
  assert.match(prompt, /may not define LOCALAPPDATA/)
  assert.match(prompt, /Publisher values can be localized/)
  assert.match(prompt, /if the requested product is already installed/)
  assert.match(prompt, /WinGet CLI is unsupported/)
  assert.match(prompt, /Do not invoke a native executable with the PowerShell call operator/)
  assert.match(prompt, /Start-Process -Wait -PassThru/)
  assert.match(prompt, /"nativeProcessMode": "start-process-wait"/)
  assert.match(prompt, /"winget": false/)
  assert.match(prompt, /official x64 MSI or offline enterprise installer/)
  assert.match(prompt, /C:\\ProgramData\\WebminAI\\Tasks\\unknown/)
})

test('Codex planner automatically replaces direct native Windows invocation', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  let calls = 0
  let correctedPrompt
  const base = {
    summary: 'Fetch release metadata',
    changeOverview: 'Inspect release metadata without changing the host',
    modifiedFiles: [],
    assumptions: [],
    warnings: [],
    requiresConfirmation: false,
    revertCommands: []
  }
  const planner = new CodexPlanner({
    runner: async (binary, args, options) => {
      calls++
      if (calls === 1) {
        return {
          code: 0,
          stdout: JSON.stringify({
            ...base,
            commands: [{ id: 'fetch', command: "& curl.exe --fail 'https://example.test/releases'", purpose: 'Fetch metadata', risk: 'read', timeoutMs: 30000, requiresSudo: false, dependsOn: [] }]
          }),
          stderr: ''
        }
      }
      correctedPrompt = options.input
      return {
        code: 0,
        stdout: JSON.stringify({
          ...base,
          commands: [{ id: 'fetch', command: "Invoke-RestMethod -UseBasicParsing -Uri 'https://example.test/releases'", purpose: 'Fetch metadata', risk: 'read', timeoutMs: 30000, requiresSudo: false, dependsOn: [] }]
        }),
        stderr: ''
      }
    }
  })

  const plan = await planner.plan({
    serverDirectory,
    request: 'inspect release metadata',
    inventory: {
      info: { agents: [{ application: { os: 'Windows 11' } }] },
      webminaiExecution: { nativeProcessMode: 'start-process-wait', commands: { curl: true } }
    },
    policy: { executionIdentity: 'root' }
  })

  assert.equal(calls, 2)
  assert.match(plan.commands[0].command, /Invoke-RestMethod/)
  assert.match(correctedPrompt, /directly invokes a native process with &/)
})

test('Codex planner rejects incompatible Windows package and cmdlet plans before approval', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  const planner = new CodexPlanner({
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify({
        summary: 'Install a package',
        changeOverview: 'Use an incompatible package command',
        modifiedFiles: ['C:\\ProgramData\\WebminAI\\Tasks\\4\\state.json'],
        assumptions: [],
        warnings: [],
        requiresConfirmation: true,
        commands: [{
          id: 'install',
          command: "New-Item -ItemType Directory -LiteralPath 'C:\\ProgramData\\WebminAI\\Tasks\\4'; winget install Example.App",
          purpose: 'Install an application',
          risk: 'change',
          timeoutMs: 300000,
          requiresSudo: true,
          dependsOn: []
        }],
        revertCommands: [{
          id: 'remove',
          command: 'winget uninstall Example.App',
          purpose: 'Remove the application',
          risk: 'change',
          timeoutMs: 300000,
          requiresSudo: true,
          dependsOn: []
        }]
      }),
      stderr: ''
    })
  })

  await assert.rejects(planner.plan({
    serverDirectory,
    request: 'install an application',
    inventory: {
      info: { agents: [{ application: { os: 'Windows 11' } }] },
      webminaiExecution: { commands: { winget: false, chocolatey: false } }
    },
    policy: { executionIdentity: 'root' }
  }), /New-Item -LiteralPath|WinGet/)
})

test('Codex planner automatically requests one correction after deterministic rejection', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  let calls = 0
  let correctedPrompt
  const base = {
    summary: 'Install a package',
    changeOverview: 'Install an application',
    modifiedFiles: ['C:\\ProgramData\\WebminAI\\Tasks\\5\\state.json'],
    assumptions: [],
    warnings: [],
    requiresConfirmation: true
  }
  const planner = new CodexPlanner({
    runner: async (binary, args, options) => {
      calls++
      if (calls === 1) {
        return {
          code: 0,
          stdout: JSON.stringify({
            ...base,
            commands: [{ id: 'install', command: 'winget install Example.App', purpose: 'Install', risk: 'change', timeoutMs: 300000, requiresSudo: true, dependsOn: [] }],
            revertCommands: [{ id: 'remove', command: 'winget uninstall Example.App', purpose: 'Remove', risk: 'change', timeoutMs: 300000, requiresSudo: true, dependsOn: [] }]
          }),
          stderr: ''
        }
      }
      correctedPrompt = options.input
      return {
        code: 0,
        stdout: JSON.stringify({
          ...base,
          commands: [{ id: 'install', command: "Write-Output 'vendor installer verified and installed'", purpose: 'Install', risk: 'change', timeoutMs: 300000, requiresSudo: true, dependsOn: [] }],
          revertCommands: [{ id: 'remove', command: "Write-Output 'owned installation removed'", purpose: 'Remove', risk: 'change', timeoutMs: 300000, requiresSudo: true, dependsOn: [] }]
        }),
        stderr: ''
      }
    }
  })

  const plan = await planner.plan({
    serverDirectory,
    request: 'install an application',
    inventory: { info: { agents: [{ application: { os: 'Windows 11' } }] }, webminaiExecution: { commands: { winget: false } } },
    policy: { executionIdentity: 'root' }
  })

  assert.equal(calls, 2)
  assert.equal(plan.commands[0].id, 'install')
  assert.match(correctedPrompt, /previous proposed plan was rejected/)
  assert.match(correctedPrompt, /WinGet.*unsupported under LocalSystem/)
})

test('Codex planner allows two deterministic correction passes before accepting a plan', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  let calls = 0
  const progress = []
  const base = {
    summary: 'Install an application',
    changeOverview: 'Install through a supported vendor route',
    modifiedFiles: ['C:\\ProgramData\\WebminAI\\Tasks\\5\\state.json'],
    assumptions: [],
    warnings: [],
    requiresConfirmation: true
  }
  const planner = new CodexPlanner({
    runner: async (binary, args) => {
      calls++
      const command = calls < 3
        ? 'winget install Example.App'
        : "Write-Output 'vendor installer verified and installed'"
      const revert = calls < 3
        ? 'winget uninstall Example.App'
        : "Write-Output 'owned installation removed'"
      const output = JSON.stringify({
        ...base,
        commands: [{ id: 'install', command, purpose: 'Install', risk: 'change', timeoutMs: 300000, requiresSudo: true, dependsOn: [] }],
        revertCommands: [{ id: 'remove', command: revert, purpose: 'Remove', risk: 'change', timeoutMs: 300000, requiresSudo: true, dependsOn: [] }]
      })
      await writeFile(args[args.indexOf('--output-last-message') + 1], output)
      return {
        code: 0,
        stdout: '',
        stderr: ''
      }
    }
  })

  await planner.plan({
    serverDirectory,
    request: 'install an application',
    inventory: { info: { agents: [{ application: { os: 'Windows 11' } }] }, webminaiExecution: { commands: { winget: false } } },
    policy: { executionIdentity: 'root' },
    onProgress: event => progress.push(event)
  })

  assert.equal(calls, 3)
  assert.deepEqual(progress.filter(event => event.type === 'validation_retry').map(event => event.message.match(/correction \d of 2/u)?.[0]), [
    'correction 1 of 2',
    'correction 2 of 2'
  ])
})

test('Codex planner corrects a multi-package diagnostic with actionable feedback', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  let calls = 0
  let correctedPrompt = ''
  const planner = new CodexPlanner({
    runner: async (binary, args, options) => {
      calls++
      if (calls === 2) correctedPrompt = options.input
      const output = JSON.stringify({
        summary: 'Install mc and htop and show uptime',
        changeOverview: 'Install two packages and show the existing uptime metric',
        modifiedFiles: ['/usr/bin/mc', '/usr/bin/htop'],
        assumptions: [],
        warnings: [],
        requiresConfirmation: true,
        commands: [{
          id: 'install_packages',
          command: 'DEBIAN_FRONTEND=noninteractive apt-get install -y mc htop',
          purpose: 'Install mc and htop',
          risk: 'change',
          timeoutMs: 300000,
          requiresSudo: true,
          phase: 'packages',
          diagnostic: calls === 1 ? { kind: 'package', target: 'mc htop' } : null,
          dependsOn: []
        }, {
          id: 'show_uptime',
          command: "curl --fail --silent --show-error 'http://127.0.0.1:19999/api/v3/data?contexts=system.uptime&after=-60&points=1'",
          purpose: 'Show server uptime',
          risk: 'read',
          timeoutMs: 30000,
          requiresSudo: false,
          phase: 'verify',
          diagnostic: { kind: 'http', target: 'http://127.0.0.1:19999/api/v3/data' },
          dependsOn: ['install_packages']
        }],
        revertCommands: [{
          id: 'remove_packages',
          command: 'DEBIAN_FRONTEND=noninteractive apt-get remove -y mc htop',
          purpose: 'Remove the requested packages',
          risk: 'change',
          timeoutMs: 300000,
          requiresSudo: true,
          phase: 'cleanup',
          diagnostic: null,
          dependsOn: []
        }]
      })
      return { code: 0, stdout: output, stderr: '' }
    }
  })

  const planned = await planner.plan({
    serverDirectory,
    request: 'install mc and htop and show server uptime',
    taskId: 167,
    inventory: { info: { agents: [{ application: { os: 'Linux' } }] } },
    policy: { executionIdentity: 'root' }
  })

  assert.equal(calls, 2)
  assert.equal(planned.commands[0].diagnostic, null)
  assert.match(correctedPrompt, /command install_packages has invalid package diagnostic target "mc htop"/u)
  assert.match(correctedPrompt, /must be exactly one identifier without spaces or prose/u)
})

test('Codex planner accepts a database restart and readiness probe before WordPress database creation', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  const planner = new CodexPlanner({
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify({
        summary: 'Prepare WordPress database',
        changeOverview: 'Restart MariaDB, wait for its socket and create the task database',
        modifiedFiles: ['/var/lib/webminai/task-state/42'],
        assumptions: [],
        warnings: [],
        requiresConfirmation: true,
        commands: [
          { id: 'state', command: "install -d -m 0700 '/var/lib/webminai/task-state/42'", purpose: 'Create state', risk: 'change', timeoutMs: 30000, requiresSudo: true, dependsOn: [] },
          { id: 'database-ready', command: "systemctl restart mariadb.service; for try in 1 2 3 4 5; do mariadb -uroot -e 'SELECT 1' >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1", purpose: 'Restart and wait for MariaDB', risk: 'change', timeoutMs: 30000, requiresSudo: true, dependsOn: ['state'] },
          { id: 'database-create', command: "mariadb -uroot -e 'CREATE DATABASE IF NOT EXISTS webminai_wordpress_18101'", purpose: 'Create database', risk: 'change', timeoutMs: 30000, requiresSudo: true, dependsOn: ['database-ready'] }
        ],
        revertCommands: [{ id: 'remove-state', command: "rm -rf '/var/lib/webminai/task-state/42'", purpose: 'Remove task state', risk: 'destructive', timeoutMs: 30000, requiresSudo: true, dependsOn: [] }]
      }),
      stderr: ''
    })
  })

  const plan = await planner.plan({
    serverDirectory,
    request: 'install WordPress on port 18101',
    taskId: 42,
    inventory: { os: 'linux', webminaiDocker: { preferred: false } },
    policy: { executionIdentity: 'root' }
  })

  assert.equal(plan.commands[2].id, 'database-create')
})

test('Codex planner accepts a resolved MariaDB client readiness probe before WordPress database creation', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  const planner = new CodexPlanner({
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify({
        summary: 'Prepare WordPress database',
        changeOverview: 'Resolve the database client, wait for its socket and create the task database',
        modifiedFiles: ['/var/lib/webminai/task-state/42'],
        assumptions: [],
        warnings: [],
        requiresConfirmation: true,
        commands: [
          { id: 'state', command: "install -d -m 0700 '/var/lib/webminai/task-state/42'", purpose: 'Create state', risk: 'change', timeoutMs: 30000, requiresSudo: true, dependsOn: [] },
          { id: 'database-ready', command: "systemctl start mariadb.service; client=$(command -v mariadb || command -v mysql); for try in 1 2 3 4 5; do \"$client\" -uroot -e 'SELECT 1' >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1", purpose: 'Start and wait for MariaDB', risk: 'change', timeoutMs: 30000, requiresSudo: true, dependsOn: ['state'] },
          { id: 'database-create', command: "mariadb -uroot -e 'CREATE DATABASE IF NOT EXISTS webminai_wordpress_18101'", purpose: 'Create database', risk: 'change', timeoutMs: 30000, requiresSudo: true, dependsOn: ['database-ready'] }
        ],
        revertCommands: [{ id: 'remove-state', command: "rm -rf '/var/lib/webminai/task-state/42'", purpose: 'Remove task state', risk: 'destructive', timeoutMs: 30000, requiresSudo: true, dependsOn: [] }]
      }),
      stderr: ''
    })
  })
  const plan = await planner.plan({
    serverDirectory,
    request: 'install WordPress on port 18101',
    taskId: 42,
    inventory: { os: 'linux', webminaiDocker: { preferred: false } },
    policy: { executionIdentity: 'root' }
  })
  assert.equal(plan.commands[2].id, 'database-create')
})

test('Codex planner replaces the obsolete WordPress FPM TCP listener with the reviewed Unix socket', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  let calls = 0
  const planner = new CodexPlanner({
    runner: async () => {
      calls++
      const listener = calls === 1 ? '127.0.0.1:19101' : '/run/webminai-wordpress-18101/php-fpm.sock'
      return {
        code: 0,
        stdout: JSON.stringify({
          summary: 'Configure WordPress PHP-FPM',
          changeOverview: 'Write the task-owned PHP-FPM pool',
          modifiedFiles: ['/var/lib/webminai/task-state/42', '/etc/php-fpm.d/webminai-wordpress-18101.conf'],
          assumptions: [],
          warnings: [],
          requiresConfirmation: true,
          commands: [{ id: 'pool', command: `printf '%s\n' '[webminai-wordpress-18101]' 'listen = ${listener}' > /etc/php-fpm.d/webminai-wordpress-18101.conf`, purpose: 'Write pool', risk: 'change', timeoutMs: 30000, requiresSudo: true, dependsOn: [] }],
          revertCommands: [{ id: 'remove-pool', command: 'rm -f /etc/php-fpm.d/webminai-wordpress-18101.conf', purpose: 'Remove pool', risk: 'destructive', timeoutMs: 30000, requiresSudo: true, dependsOn: [] }]
        }),
        stderr: ''
      }
    }
  })

  const plan = await planner.plan({
    serverDirectory,
    request: 'install WordPress on port 18101',
    taskId: 42,
    inventory: { os: 'linux', webminaiDocker: { preferred: false } },
    policy: { executionIdentity: 'root' }
  })

  assert.equal(calls, 2)
  assert.match(plan.commands[0].command, /listen = \/run\/webminai-wordpress-18101\/php-fpm\.sock/)
})

test('Codex planner corrects Linux WordPress assumptions that failed on the distro fleet', async t => {
  const cases = [{
    name: 'system WP-CLI',
    family: 'rpm',
    invalid: '/usr/local/bin/wp config create --allow-root --dbname=webminai_wordpress_18101',
    error: /assumes a system WP-CLI command/
  }, {
    name: 'hostname address discovery',
    family: 'arch',
    invalid: "address=$(hostname -I | awk '{print $1}')",
    error: /profile ip-based primaryAddressCommand/
  }, {
    name: 'TCP database host substitution',
    family: 'alpine',
    invalid: '/usr/bin/php83 /var/lib/webminai/webminai-wordpress-18101/wp-cli.phar config create --allow-root --dbhost=127.0.0.1',
    error: /profile databaseHost/
  }, {
    name: 'openSUSE PHP binary',
    family: 'suse',
    invalid: '/usr/bin/php8 /var/lib/webminai/webminai-wordpress-18101/wp-cli.phar --allow-root --info',
    error: /reviewed openSUSE php8-cli package/
  }, {
    name: 'empty WP-CLI database password option',
    family: 'rpm',
    invalid: "printf '%s\\n' \"$db_password\" | /usr/bin/php /var/lib/webminai/webminai-wordpress-18101/wp-cli.phar config create --allow-root --dbpass= --prompt=dbpass; db_password=$(sed -n 1p /root/wordpress_credentials/db_password)",
    error: /omit --dbpass entirely/
  }]
  for (const item of cases) {
    await t.test(item.name, async t => {
      const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
      t.after(() => rm(serverDirectory, { recursive: true, force: true }))
      let calls = 0
      let correction
      const planner = new CodexPlanner({
        runner: async (binary, args, options) => {
          calls++
          if (calls === 2) correction = options.input
          return {
            code: 0,
            stdout: JSON.stringify({
              summary: 'Prepare WordPress state',
              changeOverview: 'Prepare task-owned state',
              modifiedFiles: ['/var/lib/webminai/task-state/42'],
              assumptions: [],
              warnings: [],
              requiresConfirmation: true,
              commands: [{ id: 'prepare', command: calls === 1 ? item.invalid : 'install -d -m 0700 /var/lib/webminai/task-state/42', purpose: 'Prepare', risk: 'change', timeoutMs: 30000, requiresSudo: true, dependsOn: [] }],
              revertCommands: [{ id: 'remove', command: 'rm -rf /var/lib/webminai/task-state/42', purpose: 'Remove', risk: 'destructive', timeoutMs: 30000, requiresSudo: true, dependsOn: [] }]
            }),
            stderr: ''
          }
        }
      })
      const plan = await planner.plan({
        serverDirectory,
        request: 'install WordPress on port 18101',
        taskId: 42,
        inventory: { os: 'linux', webminaiDocker: { preferred: false }, webminaiLinuxContext: { family: item.family } },
        policy: { executionIdentity: 'root' }
      })
      assert.equal(calls, 2)
      assert.equal(plan.commands[0].id, 'prepare')
      assert.match(correction, item.error)
    })
  }
})

test('Codex planner requires openSUSE WordPress package plans to include CLI and Phar packages', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  let calls = 0
  const planner = new CodexPlanner({
    runner: async () => {
      calls++
      return {
        code: 0,
        stdout: JSON.stringify({
          summary: 'Install openSUSE WordPress prerequisites',
          changeOverview: 'Install reviewed packages',
          modifiedFiles: ['/var/lib/webminai/task-state/42'],
          assumptions: [],
          warnings: [],
          requiresConfirmation: true,
          commands: [{ id: 'packages', command: `zypper --non-interactive install --no-recommends php8${calls === 1 ? '' : ' php8-cli php8-phar'}`, purpose: 'Install packages', risk: 'change', timeoutMs: 300000, requiresSudo: true, dependsOn: [] }],
          revertCommands: [{ id: 'remove', command: 'rm -rf /var/lib/webminai/task-state/42', purpose: 'Remove state', risk: 'destructive', timeoutMs: 30000, requiresSudo: true, dependsOn: [] }]
        }),
        stderr: ''
      }
    }
  })
  await planner.plan({
    serverDirectory,
    request: 'install WordPress on port 18101',
    taskId: 42,
    inventory: { os: 'linux', webminaiDocker: { preferred: false }, webminaiLinuxContext: { family: 'suse' } },
    policy: { executionIdentity: 'root' }
  })
  assert.equal(calls, 2)
})

test('Codex planner permits WP-CLI execution after download and verification in the same artifact command', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  const planner = new CodexPlanner({
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify({
        summary: 'Verify WP-CLI',
        changeOverview: 'Download, verify and inspect the profile WP-CLI artifact',
        modifiedFiles: ['/var/lib/webminai/webminai-wordpress-18101/wp-cli.phar'],
        assumptions: [],
        warnings: [],
        requiresConfirmation: true,
        commands: [{
          id: 'artifact',
          command: "curl --fail --location --output /var/lib/webminai/webminai-wordpress-18101/wp-cli.phar https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar; curl --fail --location --output /var/lib/webminai/webminai-wordpress-18101/wp-cli.phar.sha512 https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar.sha512; expected=$(tr -d '\\r\\n' < /var/lib/webminai/webminai-wordpress-18101/wp-cli.phar.sha512); actual=$(sha512sum /var/lib/webminai/webminai-wordpress-18101/wp-cli.phar | awk '{print $1}'); [ \"$actual\" = \"$expected\" ]; /usr/bin/php /var/lib/webminai/webminai-wordpress-18101/wp-cli.phar --allow-root --info",
          purpose: 'Verify WP-CLI',
          risk: 'change',
          timeoutMs: 30000,
          requiresSudo: true,
          dependsOn: []
        }],
        revertCommands: [{ id: 'remove', command: 'rm -f /var/lib/webminai/webminai-wordpress-18101/wp-cli.phar /var/lib/webminai/webminai-wordpress-18101/wp-cli.phar.sha512', purpose: 'Remove artifacts', risk: 'destructive', timeoutMs: 30000, requiresSudo: true, dependsOn: [] }]
      }),
      stderr: ''
    })
  })
  const plan = await planner.plan({
    serverDirectory,
    request: 'install WordPress on port 18101',
    inventory: { os: 'linux', webminaiDocker: { preferred: false } },
    policy: { executionIdentity: 'root' }
  })
  assert.equal(plan.commands[0].id, 'artifact')
})

test('Codex planner rejects an invented Brave MSI and supplies official release guidance', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  let prompt
  const planner = new CodexPlanner({
    runner: async (binary, args, options) => {
      prompt = options.input
      return {
        code: 0,
        stdout: JSON.stringify({
          summary: 'Install Brave',
          changeOverview: 'Install an invented MSI',
          modifiedFiles: ['C:\\ProgramData\\WebminAI\\Tasks\\6\\BraveBrowser.msi'],
          assumptions: [],
          warnings: [],
          requiresConfirmation: true,
          commands: [{ id: 'install', command: "Invoke-WebRequest 'https://example.test/BraveBrowser.msi' -OutFile 'C:\\ProgramData\\WebminAI\\Tasks\\6\\BraveBrowser.msi'", purpose: 'Install', risk: 'change', timeoutMs: 300000, requiresSudo: true, dependsOn: [] }],
          revertCommands: [{ id: 'remove', command: "Remove-Item -LiteralPath 'C:\\ProgramData\\WebminAI\\Tasks\\6\\BraveBrowser.msi'", purpose: 'Remove', risk: 'change', timeoutMs: 300000, requiresSudo: true, dependsOn: [] }]
        }),
        stderr: ''
      }
    }
  })

  await assert.rejects(planner.plan({
    serverDirectory,
    request: 'install brave browser',
    inventory: { info: { agents: [{ application: { os: 'Windows 11' } }] }, webminaiExecution: { commands: {} } },
    policy: { executionIdentity: 'root' }
  }), /does not publish a BraveBrowser\.msi/)
  assert.match(prompt, /official brave\/brave-browser GitHub releases/)
  assert.match(prompt, /releases\/latest/)
  assert.match(prompt, /paginated releases list/)
  assert.match(prompt, /exact checksum asset BraveBrowserStandaloneSetup\.exe\.sha256/)
  assert.match(prompt, /possibly versioned filename/)
  assert.match(prompt, /never remove all non-hex characters/)
  assert.match(prompt, /timeoutMs value 300000/)
  assert.match(prompt, /Get-AuthenticodeSignature/)
  assert.match(prompt, /BraveSoftware Brave-Browser/)
  assert.match(prompt, /trailing icon index such as ,0/)
})

test('Codex planner rejects an English-only Brave registry Publisher filter', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  const planner = new CodexPlanner({
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify({
        summary: 'Install and verify Brave',
        changeOverview: 'Install Brave and use a localized registry field incorrectly',
        modifiedFiles: ['C:\\ProgramData\\WebminAI\\Tasks\\8\\BraveBrowserStandaloneSetup.exe'],
        assumptions: [],
        warnings: [],
        requiresConfirmation: true,
        commands: [{
          id: 'install',
          command: "$api='https://api.github.com/repos/brave/brave-browser/releases/latest'; $checksumName='BraveBrowserStandaloneSetup.exe.sha256'; Invoke-WebRequest -Uri $api -OutFile 'C:\\ProgramData\\WebminAI\\Tasks\\8\\BraveBrowserStandaloneSetup.exe'; Get-AuthenticodeSignature -LiteralPath 'C:\\ProgramData\\WebminAI\\Tasks\\8\\BraveBrowserStandaloneSetup.exe'; Start-Process -FilePath 'C:\\ProgramData\\WebminAI\\Tasks\\8\\BraveBrowserStandaloneSetup.exe' -Wait -PassThru; Get-ItemProperty 'HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object { $_.Publisher -like '*Brave Software*' }",
          purpose: 'Install and verify Brave',
          risk: 'change',
          timeoutMs: 300000,
          requiresSudo: true,
          dependsOn: []
        }],
        revertCommands: [{ id: 'remove', command: "Remove-Item -LiteralPath 'C:\\ProgramData\\WebminAI\\Tasks\\8\\BraveBrowserStandaloneSetup.exe'", purpose: 'Remove task artifact', risk: 'destructive', timeoutMs: 30000, requiresSudo: true, dependsOn: [] }]
      }),
      stderr: ''
    })
  })

  await assert.rejects(planner.plan({
    serverDirectory,
    request: 'install brave browser',
    inventory: { info: { agents: [{ application: { os: 'Windows 11' } }] }, webminaiExecution: { commands: {} } },
    policy: { executionIdentity: 'root' }
  }), /English Brave registry Publisher value/)
})

test('Codex planner rejects checksum parsing that mixes filename hex characters into the hash', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  const planner = new CodexPlanner({
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify({
        summary: 'Install Brave',
        changeOverview: 'Download Brave and parse its checksum incorrectly',
        modifiedFiles: ['C:\\ProgramData\\WebminAI\\Tasks\\9\\BraveBrowserStandaloneSetup.exe'],
        assumptions: [],
        warnings: [],
        requiresConfirmation: true,
        commands: [{
          id: 'install',
          command: "$api='https://api.github.com/repos/brave/brave-browser/releases/latest'; $checksumName='BraveBrowserStandaloneSetup.exe.sha256'; $expected=(Get-Content -Raw 'C:\\ProgramData\\WebminAI\\Tasks\\9\\BraveBrowserStandaloneSetup.exe.sha256') -replace '[^0-9A-Fa-f]',''; Invoke-WebRequest -Uri $api -OutFile 'C:\\ProgramData\\WebminAI\\Tasks\\9\\BraveBrowserStandaloneSetup.exe'; Get-AuthenticodeSignature -LiteralPath 'C:\\ProgramData\\WebminAI\\Tasks\\9\\BraveBrowserStandaloneSetup.exe'; Start-Process -FilePath 'C:\\ProgramData\\WebminAI\\Tasks\\9\\BraveBrowserStandaloneSetup.exe' -Wait -PassThru",
          purpose: 'Install Brave',
          risk: 'change',
          timeoutMs: 300000,
          requiresSudo: true,
          dependsOn: []
        }],
        revertCommands: [{ id: 'remove', command: "Remove-Item -LiteralPath 'C:\\ProgramData\\WebminAI\\Tasks\\9\\BraveBrowserStandaloneSetup.exe'", purpose: 'Remove task artifact', risk: 'destructive', timeoutMs: 30000, requiresSudo: true, dependsOn: [] }]
      }),
      stderr: ''
    })
  })

  await assert.rejects(planner.plan({
    serverDirectory,
    request: 'install brave browser',
    inventory: { info: { agents: [{ application: { os: 'Windows 11' } }] }, webminaiExecution: { commands: {} } },
    policy: { executionIdentity: 'root' }
  }), /line-anchored 64-hex token/)
})

test('Codex planner rejects treating an already installed Brave as an installation failure', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  const planner = new CodexPlanner({
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify({
        summary: 'Install Brave',
        changeOverview: 'Fail when Brave is already installed',
        modifiedFiles: ['C:\\ProgramData\\WebminAI\\Tasks\\10\\BraveBrowserStandaloneSetup.exe'],
        assumptions: [],
        warnings: [],
        requiresConfirmation: true,
        commands: [{
          id: 'install',
          command: "$api='https://api.github.com/repos/brave/brave-browser/releases/latest'; $checksumName='BraveBrowserStandaloneSetup.exe.sha256'; $baseline=[pscustomobject]@{ExistingInstallation=$true}; if ($baseline.ExistingInstallation) { throw 'Brave already exists.' }; Invoke-WebRequest -Uri $api -OutFile 'C:\\ProgramData\\WebminAI\\Tasks\\10\\BraveBrowserStandaloneSetup.exe'; [regex]::Match($checksum,'(?im)^\\s*([0-9a-f]{64})(?:\\s+.*)?$'); Get-AuthenticodeSignature -LiteralPath 'C:\\ProgramData\\WebminAI\\Tasks\\10\\BraveBrowserStandaloneSetup.exe'; Start-Process -FilePath 'C:\\ProgramData\\WebminAI\\Tasks\\10\\BraveBrowserStandaloneSetup.exe' -Wait -PassThru",
          purpose: 'Install Brave',
          risk: 'change',
          timeoutMs: 300000,
          requiresSudo: true,
          dependsOn: []
        }],
        revertCommands: [{ id: 'remove', command: "Remove-Item -LiteralPath 'C:\\ProgramData\\WebminAI\\Tasks\\10\\BraveBrowserStandaloneSetup.exe'", purpose: 'Remove task artifact', risk: 'destructive', timeoutMs: 30000, requiresSudo: true, dependsOn: [] }]
      }),
      stderr: ''
    })
  })

  await assert.rejects(planner.plan({
    serverDirectory,
    request: 'install brave browser',
    inventory: { info: { agents: [{ application: { os: 'Windows 11' } }] }, webminaiExecution: { commands: {} } },
    policy: { executionIdentity: 'root' }
  }), /idempotent success/)
})

test('Codex planner refuses a symlinked context file', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  const outsideFile = path.join(serverDirectory, '..', `webminai-secret-${process.pid}.json`)
  t.after(() => Promise.all([
    rm(serverDirectory, { recursive: true, force: true }),
    rm(outsideFile, { force: true })
  ]))
  await writeFile(outsideFile, '{"secret":"must-not-leak"}')
  await symlink(outsideFile, path.join(serverDirectory, 'context.md'))

  let called = false
  const planner = new CodexPlanner({
    runner: async () => {
      called = true
      return { code: 0, stdout: '{}', stderr: '' }
    }
  })
  await assert.rejects(planner.plan({
    serverDirectory,
    request: 'inspect',
    inventory: {},
    policy: {}
  }), error => ['ELOOP', 'EMLINK'].includes(error.code))
  assert.equal(called, false)
})

test('Codex planner supplies sanitized retry history and correction instructions', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  let retryHistory
  let prompt
  const planner = new CodexPlanner({
    runner: async (binary, args, options) => {
      prompt = options.input
      retryHistory = JSON.parse(await readFile(path.join(options.cwd, 'previous-attempts.json'), 'utf8'))
      return {
        code: 0,
        stdout: JSON.stringify({
          summary: 'Correct the failed probe',
          changeOverview: 'Read from the corrected endpoint',
          modifiedFiles: [],
          assumptions: [],
          warnings: [],
          requiresConfirmation: false,
          commands: [{
            id: 'probe',
            command: "curl 'http://127.0.0.1:19999/api/v3/alerts'",
            purpose: 'Use the corrected Netdata endpoint',
            risk: 'read',
            timeoutMs: 5000,
            requiresSudo: false,
            dependsOn: []
          }],
          revertCommands: []
        }),
        stderr: ''
      }
    }
  })

  await planner.plan({
    serverDirectory,
    request: 'inspect alerts',
    inventory: {},
    policy: { executionIdentity: 'root' },
    taskId: 9,
    previousAttempts: [{
      id: 8,
      request: 'inspect alerts',
      status: 'failed',
      plan: { commands: [{ command: "curl 'http://127.0.0.1:19999/api/v3/alarms'" }] },
      results: [{ id: 'install', status: 'failed', result: { stderr: 'WinGet is not available to LocalSystem. token=visible-secret ssh://admin@example.test' } }],
      progress: [
        { type: 'reasoning', message: 'used obsolete endpoint' },
        { type: 'post_failure_diagnostic', message: 'Publisher was localized in the registry.' }
      ],
      error: `action key ${'ab'.repeat(32)}`
    }],
    retryInstructions: 'Use the current alerts endpoint'
  })

  assert.equal(retryHistory[0].id, 8)
  assert.match(retryHistory[0].results[0].result.stderr, /token=\[redacted\]/)
  assert.doesNotMatch(JSON.stringify(retryHistory), /visible-secret|ssh:\/\/|abababab/)
  assert.match(prompt, /Read previous-attempts\.json before planning/)
  assert.match(prompt, /WinGet is not available to LocalSystem/)
  assert.match(prompt, /Publisher was localized in the registry/)
  assert.match(prompt, /Use the current alerts endpoint/)
})

test('Codex planner streams JSONL progress while reading the final schema response from file', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-server-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  const output = {
    summary: 'Read uptime',
    changeOverview: 'No host changes',
    modifiedFiles: [],
    assumptions: [],
    warnings: [],
    requiresConfirmation: true,
    commands: [{
      id: 'uptime',
      command: 'uptime',
      purpose: 'Read uptime',
      risk: 'read',
      timeoutMs: 5000,
      requiresSudo: false,
      dependsOn: []
    }],
    revertCommands: []
  }
  const events = []
  const planner = new CodexPlanner({
    runner: async (binary, args, options) => {
      assert.ok(args.includes('--json'))
      const destination = args[args.indexOf('--output-last-message') + 1]
      await writeFile(destination, JSON.stringify(output))
      options.onStdout('{"type":"thread.started"}\n')
      options.onStdout('{"type":"item.completed","item":{"type":"reasoning","text":"Checking inventory"}}\n')
      return { code: 0, stdout: '', stderr: '' }
    }
  })
  const result = await planner.plan({
    serverDirectory,
    request: 'uptime',
    inventory: {},
    policy: { executionIdentity: 'root' },
    taskId: 7,
    onProgress: event => events.push(event)
  })
  assert.equal(result.summary, 'Read uptime')
  assert.deepEqual(events.map(event => event.type), ['thread.started', 'reasoning'])
})

test('Codex consultation returns advice and only compact summaries flow into the authoritative task', async t => {
  const serverDirectory = await mkdtemp(path.join(os.tmpdir(), 'webminai-consultation-planner-test-'))
  t.after(() => rm(serverDirectory, { recursive: true, force: true }))
  const calls = []
  const plan = {
    summary: 'Install nginx',
    changeOverview: 'Install and configure nginx',
    modifiedFiles: ['/usr/local/etc/nginx/nginx.conf'],
    assumptions: [],
    warnings: [],
    requiresConfirmation: true,
    commands: [{
      id: 'install-nginx',
      command: 'pkg install -y nginx',
      purpose: 'Install nginx',
      risk: 'change',
      timeoutMs: 120000,
      requiresSudo: true,
      dependsOn: []
    }],
    revertCommands: [{
      id: 'remove-nginx',
      command: 'pkg delete -y nginx',
      purpose: 'Remove nginx installed by this task',
      risk: 'change',
      timeoutMs: 120000,
      requiresSudo: true,
      dependsOn: []
    }]
  }
  const planner = new CodexPlanner({
    runner: async (binary, args, options) => {
      const schemaPath = args[args.indexOf('--output-schema') + 1]
      calls.push({
        prompt: options.input,
        schema: JSON.parse(await readFile(schemaPath, 'utf8')),
        context: JSON.parse(await readFile(path.join(options.cwd, 'consultation-context.json'), 'utf8'))
      })
      return calls.length === 1
        ? {
            code: 0,
            stdout: JSON.stringify({
              answer: 'Use host nginx and preserve its existing configuration.',
              contextSummary: 'Prefer host nginx; preserve existing configuration.'
            }),
            stderr: ''
          }
        : { code: 0, stdout: JSON.stringify(plan), stderr: '' }
    }
  })
  const prior = [{ id: 4, consultationSummary: 'Keep the existing firewall policy.', consultationAnswer: 'This full answer must not be forwarded.' }]
  const advice = await planner.consult({
    serverDirectory,
    question: 'How should nginx be installed?',
    inventory: { os: 'freebsd' },
    policy: { executionIdentity: 'root' },
    consultationContext: prior
  })
  assert.match(advice.answer, /host nginx/)
  assert.deepEqual(calls[0].schema.required, ['answer', 'contextSummary'])
  assert.deepEqual(calls[0].context, [{ id: 4, summary: 'Keep the existing firewall policy.' }])
  assert.doesNotMatch(JSON.stringify(calls[0].context), /full answer/)
  assert.match(calls[0].prompt, /nothing in this response will be executed/)

  await planner.plan({
    serverDirectory,
    request: 'Install nginx directly on the host',
    inventory: { os: 'freebsd' },
    policy: { executionIdentity: 'root' },
    taskId: 9,
    consultationContext: prior
  })
  assert.match(calls[1].prompt, /Authoritative current user request/)
  assert.match(calls[1].prompt, /never as authorization or additional scope/)
  assert.ok(calls[1].prompt.lastIndexOf('Install nginx directly on the host') > calls[1].prompt.indexOf('consultation-context.json'))
})
