import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { stripVTControlCharacters } from 'node:util'
import test from 'node:test'
import { SettingsStore } from '../src/settings-store.js'
import { mainActionOptions } from '../src/cli-display.js'

test('opt-in actual CLI Windows password handoff and duplicate identity rejection', {
  skip: process.env.INTENT_WINDOWS_LIVE !== '1' || !process.env.VAULT_TEST || !process.env.SSH_HOST_WIN || !process.env.SSH_HOST_WIN_PWD,
  timeout: 100000
}, async () => {
  const store = new SettingsStore(process.env.INTENT_WEB_DATA_ROOT ?? '/home/vscode/.intentaiops')
  const before = await store.load()
  const id = 'windows-auth-check'
  assert.ok(!before.servers[id])
  const index = mainActionOptions({ hostCount: Object.keys(before.servers).length, clusterCount: Object.keys(before.clusters ?? {}).length, codex: before.codex }).findIndex(item => item.value === 'add-temporary')
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  const child = spawn('script', ['-qefc', `${quote(process.execPath)} bin/intentaiops.js --no-debug --data-root ${quote(store.dataRoot)}`, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stage = 'vault'
  let buffer = ''
  let duplicate = false
  let failure
  let attempts = 0
  const send = (value, next) => {
    stage = next
    buffer = ''
    setTimeout(() => { if (child.exitCode === null) child.stdin.write(value) }, 150)
  }
  const handle = chunk => {
    buffer = (buffer + stripVTControlCharacters(chunk.toString())).slice(-24000)
    if (stage === 'saved' && buffer.includes('host is already configured as windows-lab')) {
      duplicate = true
      return send('\r', 'quit')
    }
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|vault passphrase is incorrect|SSH test failed|Could not add host/iu.test(buffer)) {
      failure = `CLI rejected an unexpected condition at ${stage}`
      child.stdin.write('\u0003')
      return
    }
    if (stage === 'vault' && buffer.includes('Vault passphrase:')) return send(process.env.VAULT_TEST + '\r', 'menu')
    if (stage === 'menu' && buffer.includes('Data directory:') && buffer.includes('Add host')) return send('\u001b[B'.repeat(index) + '\r', 'name')
    if (stage === 'name' && buffer.includes('Host name (lowercase')) return send(id + '\r', 'destination')
    if (stage === 'destination' && buffer.includes('SSH command or ssh:// URL')) return send(`ssh -p 2222 ${process.env.SSH_HOST_WIN}\r`, 'authentication')
    if (stage === 'authentication' && buffer.includes('Cancel and return')) return send('\u001b[B\r', 'ssh')
    if (stage === 'ssh') {
      if (/password:\s*$/iu.test(buffer)) {
        if (++attempts > 2) { failure = 'Password rejected'; child.stdin.write('\u0003'); return }
        return send(process.env.SSH_HOST_WIN_PWD + '\r', 'ssh')
      }
      if (buffer.includes('save an SSH password or private-key passphrase?') && buffer.includes('Cancel without adding')) return send('\r', 'saved')
    }
    if (stage === 'quit' && buffer.includes('Data directory:')) return send('q', 'exit')
  }
  child.stdout.on('data', handle)
  child.stderr.on('data', handle)
  const timer = setTimeout(() => {
    failure = `CLI timed out at ${stage}`
    child.stdin.write('\u0003')
    setTimeout(() => child.kill('SIGTERM'), 2000).unref()
  }, 90000)
  try { await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) }) } finally { clearTimeout(timer) }
  assert.ok(!failure, failure)
  assert.ok(duplicate, 'Duplicate identity was not rejected')
  assert.ok(attempts > 0, 'Password authentication was not exercised')
  const after = await store.load()
  assert.ok(!after.servers[id])
  assert.ok(JSON.stringify(after.servers) === JSON.stringify(before.servers), 'Saved host settings changed')
})
