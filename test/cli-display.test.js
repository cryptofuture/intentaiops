import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runCli, buildDashboardHostRows, resolveDefaultDataRoot } from '../src/cli.js'
import {
  buildDashboardHostRow,
  configuredHostDetailLines,
  connectedHostActionOptions,
  dashboardHostRowText,
  mainActionOptions,
  sanitizedSshDestination
} from '../src/cli-display.js'

test('dashboard actions preserve zero, one, multiple, and recent-host availability', () => {
  const values = options => options.map(option => option.value)
  assert.deepEqual(values(mainActionOptions({ hostCount: 0 })), [
    'multi-history', 'add', 'add-temporary', 'add-kubernetes', 'application-defaults', 'change-passphrase', 'quit'
  ])
  assert.deepEqual(values(mainActionOptions({ hostCount: 1 })), [
    'browse-hosts', 'multi-history', 'add', 'add-temporary', 'add-kubernetes', 'application-defaults', 'change-passphrase', 'quit'
  ])
  assert.deepEqual(values(mainActionOptions({ hostCount: 2 })), [
    'browse-hosts', 'multi-task', 'multi-plugin', 'multi-history', 'add', 'add-temporary', 'add-kubernetes', 'application-defaults', 'change-passphrase', 'quit'
  ])
  assert.equal(mainActionOptions({ hostCount: 1, recentServerId: 'alpha' })[0].value, 'host:alpha')
  assert.deepEqual(values(mainActionOptions({ hostCount: 0, clusterCount: 1 })).slice(0, 2), [
    'browse-kubernetes', 'multi-history'
  ])
})

test('dashboard host rows are sorted, sanitized, unprobed, and exclude global email and secrets', async () => {
  const settings = {
    servers: {
      zebra: { desiredStage2: 'inactive', netdataOwnership: 'unknown' },
      alpha: { desiredStage2: 'active', netdataOwnership: 'preexisting' }
    }
  }
  const decrypted = {
    zebra: { connectionUrl: 'ssh://admin@zebra.test:2222?identity=%2Fsecret%2Fzebra', authentication: 'key' },
    alpha: { connectionUrl: 'ssh://root@alpha.test?config=%2Fsecret%2Fssh-config', authentication: 'auto' }
  }
  const rows = await buildDashboardHostRows({
    context: {
      settings,
      passphrase: 'not-rendered-vault-secret',
      hostRuntime: new Map(),
      settingsStore: { decryptServer: async ({ serverId }) => decrypted[serverId] },
      workspace: { loadObserved: async () => ({ inventory: {} }) }
    },
    serverIds: ['zebra', 'alpha'],
    recentServerId: 'zebra'
  })
  assert.deepEqual(rows.map(row => row.serverId), ['alpha', 'zebra'])
  assert.equal(rows[0].address, 'root@alpha.test')
  assert.equal(rows[0].runtime, 'not probed')
  assert.equal(rows[1].address, 'admin@zebra.test:2222')
  assert.equal(rows[1].recent, true)
  const rendered = rows.flatMap(row => [dashboardHostRowText(row), ...configuredHostDetailLines(row), row.searchText]).join('\n')
  assert.doesNotMatch(rendered, /secret|not-rendered|owner@example/)
  assert.match(rows[0].searchText, /alpha.*root@alpha\.test.*active.*not probed/)
})

test('dashboard identifies Ismet as Linux without searching false Windows plugin flags', async () => {
  const inventory = {
    info: {
      agents: [{
        application: {
          os: { kernel: 'Linux', os: 'Ubuntu', version: '22.04.5 LTS' },
          features: { 'built-for': 'Linux' },
          plugins: { windows: false, 'windows-events': false }
        }
      }]
    }
  }
  const rows = await buildDashboardHostRows({
    context: {
      settings: { servers: { ismet: { desiredStage2: 'active', netdataOwnership: 'preexisting' } } },
      passphrase: 'not-rendered',
      hostRuntime: new Map(),
      settingsStore: {
        async decryptServer () {
          return { connectionUrl: 'ssh://root@ismet.example', authentication: 'key' }
        }
      },
      workspace: { async loadObserved () { return { inventory } } }
    },
    serverIds: ['ismet']
  })
  assert.equal(rows[0].platform, 'linux')
  assert.match(configuredHostDetailLines(rows[0]).join('\n'), /Platform: linux/u)
  assert.match(rows[0].searchText, /linux/u)
  assert.doesNotMatch(rows[0].searchText, /windows/u)
})

test('live runtime platform overrides a persisted dashboard platform', async () => {
  const rows = await buildDashboardHostRows({
    context: {
      settings: { servers: { host: { desiredStage2: 'active', netdataOwnership: 'managed' } } },
      passphrase: 'not-rendered',
      hostRuntime: new Map([['host', { state: 'active', platform: 'Linux x86_64' }]]),
      settingsStore: {
        async decryptServer () {
          return { connectionUrl: 'ssh://root@host.example', authentication: 'key' }
        }
      },
      workspace: {
        async loadObserved () {
          return { inventory: { webminaiExecution: { platform: 'windows' } } }
        }
      }
    },
    serverIds: ['host']
  })
  assert.equal(rows[0].platform, 'Linux x86_64')
  assert.match(rows[0].searchText, /Linux x86_64/u)
  assert.doesNotMatch(rows[0].searchText, /windows/u)
})

test('host display model searches only display-safe configured and runtime values', () => {
  const row = buildDashboardHostRow({
    serverId: 'production',
    configured: { desiredStage2: 'active', netdataOwnership: 'managed' },
    server: {
      connectionUrl: 'ssh://root@example.test:2200?identity=%2Froot%2Fprivate-key',
      authentication: 'password',
      sshCredential: 'never-render-this-password',
      temporary: true
    },
    runtime: { state: 'connected', platform: 'linux' }
  })
  assert.equal(row.address, 'root@example.test:2200')
  assert.match(row.searchText, /production.*root@example\.test:2200.*active.*connected.*linux/)
  assert.doesNotMatch(row.searchText, /private-key|never-render|password|administrator@example/)
  const details = configuredHostDetailLines(row).join('\n')
  assert.doesNotMatch(details, /private-key|never-render/)
  assert.match(details, /Saved SSH credential: vault encrypted/)
  assert.match(details, /Persistence: current process only/)
  assert.equal(sanitizedSshDestination('ssh://example.test'), 'example.test')
  assert.equal(sanitizedSshDestination('ssh://root@[2001:db8::1]:2222'), 'root@[2001:db8::1]:2222')
})

test('connected host actions preserve every operation and platform availability', () => {
  const values = platform => connectedHostActionOptions({
    status: { capabilities: { platform: { os: platform } } },
    dockerPreference: 'auto'
  }).map(option => option.value)
  const linux = values('linux')
  for (const action of [
    'refresh', 'activate', 'activate-plugin', 'claim-cloud', 'deactivate', 'remove',
    'docker-preference', 'ssh-credential', 'common-application', 'task', 'history', 'shell',
    'requirements', 'switch', 'forget-host', 'back'
  ]) assert.ok(linux.includes(action), `missing connected-host action: ${action}`)
  assert.equal(values('windows').includes('common-application'), true)
  assert.equal(values('freebsd').includes('common-application'), true)
  assert.equal(values('macos').includes('common-application'), true)
  assert.match(connectedHostActionOptions({ status: { capabilities: {} }, dockerPreference: 'auto' }).find(option => option.value === 'forget-host').label, /saved host connection/u)
  assert.match(connectedHostActionOptions({ status: { capabilities: {} }, dockerPreference: 'auto', temporary: true }).find(option => option.value === 'forget-host').label, /temporary host now/u)
})

test('help stays ordinary output and non-TTY behavior stays unchanged', async () => {
  const help = terminal({ isTTY: false })
  await runCli({ argv: ['--help'], input: help.input, output: help.output })
  assert.match(help.output.text, /^Usage: intentaiops/m)
  assert.match(help.output.text, /https:\/\/intentaiops\.top/m)
  assert.equal(hasSgr(help.output.text), false)

  const nonTty = terminal({ isTTY: false })
  await assert.rejects(runCli({ input: nonTty.input, output: nonTty.output }), /requires a TTY/)
})

test('default data root prefers the new directory and reuses a legacy vault', async () => {
  const existing = new Set(['/home/test/.webminai'])
  const access = async value => {
    if (existing.has(value)) return
    const error = new Error('missing')
    error.code = 'ENOENT'
    throw error
  }
  assert.equal(await resolveDefaultDataRoot('/home/test', access), '/home/test/.webminai')
  existing.add('/home/test/.intentaiops')
  assert.equal(await resolveDefaultDataRoot('/home/test', access), '/home/test/.intentaiops')
  existing.clear()
  assert.equal(await resolveDefaultDataRoot('/home/test', access), '/home/test/.intentaiops')
})

test('package metadata exposes Intent AI Ops while retaining legacy command aliases', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(packageJson.name, 'intent-ai-ops')
  assert.equal(packageJson.homepage, 'https://intentaiops.top')
  assert.equal(packageJson.author, 'Intent AI Ops <admin@intentaiops.top>')
  assert.equal(packageJson.license, 'Apache-2.0')
  assert.equal(packageJson.files.includes('LICENSE'), true)
  assert.equal(packageJson.files.includes('NOTICE'), true)
  assert.equal(packageJson.scripts.prepare, undefined)
  assert.equal(packageJson.dependencies['better-sqlite3'], '13.0.3')
  assert.equal(packageJson.scripts.install, undefined)
  assert.equal(packageJson.scripts['verify:sqlite'], 'node scripts/install-better-sqlite3.js')
  assert.equal(packageJson.bin.intentaiops, './bin/intentaiops.js')
  assert.equal(packageJson.bin.intentops, './bin/intentops.js')
  assert.equal(packageJson.bin.webminai, './bin/webminai.js')
  assert.equal(packageJson.bin.weminai, './bin/webminai.js')
})

test('package metadata adds no UI framework or rendering dependency', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies }
  for (const dependency of ['react', 'ink', 'blessed', 'neo-blessed', 'react-blessed']) {
    assert.equal(dependencies[dependency], undefined)
  }
})

function terminal ({ isTTY }) {
  const input = new EventEmitter()
  input.isTTY = isTTY
  input.isRaw = false
  input.isPaused = () => true
  input.pause = () => {}
  input.resume = () => {}
  input.setRawMode = value => { input.isRaw = value }
  const output = new EventEmitter()
  output.isTTY = isTTY
  output.text = ''
  output.write = value => { output.text += value }
  return { input, output }
}

function hasSgr (value) {
  return new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'u').test(value)
}
