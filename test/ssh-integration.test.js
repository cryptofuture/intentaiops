import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { SystemSsh } from '../src/system-ssh.js'
import { runProcess } from '../src/process-runner.js'

test('opt-in OpenSSH multiplexing integration uses one master across channels', { skip: process.platform === 'win32' || process.env.INTENT_SSH_TEST_ALLOW !== '1' || !process.env.INTENT_SSH_TEST_HOST }, async () => {
  const host = process.env.INTENT_SSH_TEST_HOST
  const runner = (binary, args, options) => runProcess(binary, path.basename(binary) === 'ssh-add' ? args : ['-o', 'BatchMode=yes', ...args.map(argument => argument === 'StrictHostKeyChecking=ask' ? 'StrictHostKeyChecking=yes' : argument)], options)
  const ssh = new SystemSsh({ runner, interactiveRunner: runner, terminalCheck: () => true })
  try {
    const [a, b] = await Promise.all([ssh.acquireSession(host, { authentication: 'key' }), ssh.acquireSession(host, { authentication: 'key' })])
    for (let index = 0; index < 10; index++) await a.ssh.execute(host, 'true')
    await Promise.all(Array.from({ length: 10 }, () => b.ssh.execute(host, 'true')))
    await a.close()
    await b.ssh.execute(host, 'true')
    await b.close()
    assert.equal(ssh.sessions.diagnostics().mastersEstablished, 1)
    assert.equal(ssh.sessions.diagnostics().channels, 21)
  } finally { await ssh.closeSessions() }
})
