import assert from 'node:assert/strict'
import test from 'node:test'
import { AdminService } from '../src/admin-service.js'

test('AdminService composes executable verified foundations with only the AI application delta', async () => {
  let deploymentBlueprint
  const foundationCommand = { id: 'capture-baseline', phase: 'baseline', command: 'true', purpose: 'Capture baseline', risk: 'change', timeoutMs: 1000, requiresSudo: true, dependsOn: [], source: { type: 'verified-foundation', id: 'linux-baseline', version: 1 } }
  const foundationRevert = { id: 'restore-baseline', phase: 'cleanup', command: 'true', purpose: 'Restore baseline', risk: 'change', timeoutMs: 1000, requiresSudo: true, dependsOn: [], source: { type: 'verified-foundation', id: 'safe-baseline-rollback', version: 1 } }
  const admin = new AdminService({
    dataRoot: '/tmp/webminai-admin-foundation-test',
    workspace: {
      async loadRules () { return { preferences: { docker: 'auto' }, policy: { executionIdentity: 'root', maxCommands: 20, maxTimeoutMs: 300000, deniedPatterns: [] } } },
      directory () { return '/tmp/webminai-admin-foundation-test/host' }
    },
    planner: {
      async plan (options) {
        deploymentBlueprint = options.deploymentBlueprint
        return {
          summary: 'Initialize custom application',
          changeOverview: 'Add the application-owned phase',
          modifiedFiles: ['/srv/custom-app/config.php'],
          assumptions: [],
          warnings: [],
          requiresConfirmation: true,
          commands: [{ id: 'initialize-custom-app', phase: 'initialize', command: 'true', purpose: 'Initialize application', risk: 'change', timeoutMs: 1000, requiresSudo: true, dependsOn: [], source: { type: 'ai-planned' } }],
          revertCommands: []
        }
      }
    }
  })
  const plan = await admin.plan({
    settings: {},
    passphrase: 'test',
    serverId: 'linux-1',
    request: 'Deploy a custom PHP CMS',
    inventory: { info: { agents: [{ application: { os: 'Linux' } }] }, webminaiDocker: { capable: false } },
    taskId: 1,
    candidateContext: [{ catalogId: 'wordpress-linux', foundationMode: 'executable', foundationIds: ['linux-baseline', 'safe-baseline-rollback'], executablePlan: { modifiedFiles: ['/var/lib/webminai/task-state/1'], commands: [foundationCommand], revertCommands: [foundationRevert] } }]
  })
  assert.equal(deploymentBlueprint.format, 'webminai-foundation-assisted-blueprint')
  assert.deepEqual(plan.commands.map(item => item.source.type), ['verified-foundation', 'ai-planned'])
  assert.deepEqual(plan.commands[1].dependsOn, ['capture-baseline'])
  assert.deepEqual(plan.revertCommands.map(item => item.source.type), ['verified-foundation'])
})

test('Windows planning inventory includes the actual LocalSystem tool environment', async () => {
  let saved
  const admin = new AdminService({
    dataRoot: '/tmp/webminai-admin-service-test',
    settings: {
      async decryptServer () {
        return { connectionUrl: 'ssh://windows.example', actionKey: '11'.repeat(32) }
      }
    },
    workspace: {
      async loadRules () {
        return { preferences: { docker: 'auto' } }
      },
      async loadHealthContext () {
        return { format: 'webminai-host-health-profile', platform: 'windows', reportSummary: 'Previous compact health context.' }
      },
      async loadUpdateContext () {
        return { format: 'webminai-system-update-profile', platform: 'windows', reportSummary: 'Previous compact update context.' }
      },
      async saveObserved (serverId, inventory) {
        saved = { serverId, inventory }
      }
    }
  })
  admin.netdata = () => ({
    async inventory () {
      return { info: { agents: [{ application: { os: 'Microsoft Windows' } }] } }
    },
    async health () {
      return { status: 'ok', platform: 'windows' }
    },
    async windowsExecutionInventory () {
      return {
        platform: 'windows',
        identity: 'LocalSystem',
        powerShellVersion: '5.1.26100.8972',
        commands: { winget: false, chocolatey: false, msiexec: true, curl: true, docker: true },
        docker: { cliAvailable: true, daemonReachable: true, composeAvailable: true, composeCommand: 'docker compose', serverOs: 'linux' }
      }
    }
  })

  const inventory = await admin.refreshInventory({
    settings: {},
    passphrase: 'test',
    serverId: 'windows-11'
  })

  assert.equal(inventory.webminaiExecution.identity, 'LocalSystem')
  assert.equal(inventory.webminaiExecution.commands.winget, false)
  assert.equal(inventory.webminaiDocker.preferred, true)
  assert.equal(inventory.webminaiDocker.ready, true)
  assert.equal(inventory.webminaiHealthContext.reportSummary, 'Previous compact health context.')
  assert.equal(inventory.webminaiUpdateContext.reportSummary, 'Previous compact update context.')
  assert.equal(saved.serverId, 'windows-11')
  assert.deepEqual(saved.inventory, inventory)
})

test('Linux planning inventory applies the saved Docker preference to detected capability', async () => {
  let hostContext
  const admin = new AdminService({
    dataRoot: '/tmp/webminai-admin-service-docker-test',
    settings: {
      async decryptServer () {
        return { connectionUrl: 'ssh://linux.example', actionKey: '22'.repeat(32) }
      }
    },
    workspace: {
      async loadRules () {
        return { preferences: { docker: 'auto' } }
      },
      async saveObserved () {},
      async saveHostContext () {}
    },
    linuxContext: {
      async build ({ execution }) {
        hostContext = { identity: { id: execution.osRelease.ID }, management: { packageManager: 'apt' } }
        return hostContext
      }
    }
  })
  admin.netdata = () => ({
    async inventory () {
      return { info: { agents: [{ application: { os: 'Linux', container: { container: 'lxc' } } }] } }
    },
    async health () {
      return { platform: 'linux' }
    },
    async dockerExecutionInventory () {
      return { platform: 'linux', cliAvailable: true, daemonReachable: true, composeAvailable: true, composeCommand: 'docker compose' }
    },
    async linuxExecutionInventory () {
      return { platform: 'linux', osRelease: { ID: 'ubuntu' }, commands: { apt: true } }
    }
  })
  const inventory = await admin.refreshInventory({ settings: {}, passphrase: 'test', serverId: 'lxd-1' })
  assert.equal(inventory.webminaiDocker.ready, true)
  assert.equal(inventory.webminaiDocker.hostIsContainer, true)
  assert.equal(inventory.webminaiDocker.preferred, false)
  assert.equal(inventory.webminaiLinuxContext, hostContext)
  assert.equal(inventory.webminaiLinuxContext.identity.id, 'ubuntu')
})

test('FreeBSD planning inventory exposes reviewed Podman capability', async () => {
  const admin = new AdminService({
    dataRoot: '/tmp/webminai-admin-service-freebsd-test',
    settings: { async decryptServer () { return { connectionUrl: 'ssh://freebsd.example', actionKey: '55'.repeat(32) } } },
    workspace: {
      async loadRules () { return { preferences: { docker: 'auto' } } },
      async saveObserved () {},
      async saveHostContext () {}
    }
  })
  admin.netdata = () => ({
    async inventory () { return { info: { agents: [{ application: { os: 'FreeBSD' } }] } } },
    async health () { return { platform: 'freebsd' } },
    async freebsdExecutionInventory () {
      return {
        platform: 'freebsd',
        docker: { platform: 'freebsd', installSupported: true, cliAvailable: true, daemonReachable: true, composeAvailable: true, composeCommand: 'podman-compose' }
      }
    }
  })
  const inventory = await admin.refreshInventory({ settings: {}, passphrase: 'test', serverId: 'freebsd-15-1' })
  assert.equal(inventory.webminaiExecution.platform, 'freebsd')
  assert.equal(inventory.webminaiDocker.ready, true)
  assert.equal(inventory.webminaiDocker.preferred, true)
})

test('Admin context persistence fails explicitly when workspace capabilities are missing', async () => {
  const admin = new AdminService({
    dataRoot: '/tmp/webminai-admin-service-context-contract-test',
    workspace: {}
  })

  await assert.rejects(admin.saveHealthContext('linux-1', {}), /workspace\.saveHealthContext must be a function/)
  await assert.rejects(admin.saveUpdateContext('linux-1', {}), /workspace\.saveUpdateContext must be a function/)
  await assert.rejects(admin.refreshLinuxHostContext({
    settings: {},
    passphrase: 'test',
    serverId: 'linux-1',
    inventory: {},
    client: {},
    execution: {}
  }), /workspace\.saveHostContext must be a function/)
})

test('macOS planning inventory exposes a stable hypervisor blocker before Colima setup', async () => {
  const admin = new AdminService({
    dataRoot: '/tmp/webminai-admin-service-macos-test',
    settings: { async decryptServer () { return { connectionUrl: 'ssh://mac.example', actionKey: '66'.repeat(32) } } },
    workspace: {
      async loadRules () { return { preferences: { docker: 'auto' } } },
      async saveObserved () {},
      async saveHostContext () {}
    }
  })
  admin.netdata = () => ({
    async inventory () { return { info: { agents: [{ application: { os: 'macOS Darwin' } }] } } },
    async health () { return { platform: 'macos' } },
    async macosExecutionInventory () {
      return {
        platform: 'macos',
        hypervisorSupport: false,
        runtimeUser: 'mac',
        runtimeHome: '/Users/mac',
        docker: { platform: 'macos', installSupported: false, installMethod: 'homebrew-colima', hypervisorSupport: false }
      }
    }
  })
  const inventory = await admin.refreshInventory({ settings: {}, passphrase: 'test', serverId: 'macos-15' })
  assert.equal(inventory.webminaiExecution.platform, 'macos')
  assert.equal(inventory.webminaiExecution.hypervisorSupport, false)
  assert.equal(inventory.webminaiDocker.capable, false)
  assert.equal(inventory.webminaiDocker.preferred, false)
  assert.equal(inventory.webminaiDocker.installMethod, 'homebrew-colima')
})

test('Linux platform detection understands the nested Netdata v3 agent shape before SSH fallback', async () => {
  const admin = new AdminService({
    dataRoot: '/tmp/webminai-admin-service-netdata-v3-test',
    settings: {
      async decryptServer () {
        return { connectionUrl: 'ssh://linux.example', actionKey: '44'.repeat(32), platformHint: 'windows' }
      }
    },
    workspace: {
      async loadRules () { return { preferences: { docker: 'auto' } } },
      async saveObserved () {},
      async saveHostContext () {}
    },
    stage2: {
      async capabilities () { throw new Error('nested Netdata platform should avoid the SSH platform fallback') }
    },
    linuxContext: {
      async build () { return { identity: { id: 'ubuntu' }, management: { packageManager: 'apt' } } }
    }
  })
  admin.netdata = () => ({
    async inventory () {
      return {
        info: {
          agents: [{
            application: {
              os: { kernel: 'Linux', os: 'Ubuntu', id: 'ubuntu' },
              features: { 'built-for': 'Linux' },
              package: { distro: 'ubuntu 22.04' }
            }
          }]
        }
      }
    },
    async health () { return { status: 'ok' } },
    async dockerExecutionInventory () { return { platform: 'linux', installSupported: true, installMethod: 'official-apt' } },
    async linuxExecutionInventory () { return { platform: 'linux', osRelease: { ID: 'ubuntu' }, commands: { apt: true } } }
  })

  const inventory = await admin.refreshInventory({ settings: {}, passphrase: 'test', serverId: 'linux-v3' })
  assert.equal(inventory.webminaiDocker.platform, 'linux')
  assert.equal(inventory.webminaiLinuxContext.identity.id, 'ubuntu')
})

test('Admin execution forwards standalone revert validation mode', async () => {
  const admin = new AdminService({
    dataRoot: '/tmp/webminai-admin-service-revert-test',
    settings: { async decryptServer () { return { connectionUrl: 'ssh://linux.example', actionKey: '33'.repeat(32) } } },
    workspace: { async loadRules () { return { policy: { executionIdentity: 'root' } } } }
  })
  admin.netdata = () => ({ async runCommand () { return { exitCode: 0, stdout: '', stderr: '' } } })
  const results = await admin.execute({
    settings: {},
    passphrase: 'test',
    serverId: 'linux-1',
    requireRevert: false,
    approve: async () => true,
    plan: {
      summary: 'Standalone cleanup',
      changeOverview: 'Remove task state.',
      modifiedFiles: ['/tmp/task'],
      commands: [{ id: 'cleanup', command: 'true', purpose: 'Clean.', risk: 'destructive', timeoutMs: 1000, requiresSudo: true, dependsOn: [] }],
      revertCommands: []
    }
  })
  assert.equal(results[0].status, 'completed')
})
