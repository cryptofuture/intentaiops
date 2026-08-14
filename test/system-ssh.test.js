import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'
import { parseSshConnection } from '../src/connection.js'
import { SystemSsh } from '../src/system-ssh.js'

test('system SSH uses argument arrays and strict non-interactive options', async () => {
  const calls = []
  const ssh = new SystemSsh({
    runner: async (command, args, options) => {
      calls.push({ command, args, options })
      return { code: 0, stdout: 'ok\n', stderr: '' }
    }
  })

  await ssh.execute(
    'ssh://deploy@example.test:2200?identity=%2Fkeys%2Fdeploy&config=%2Fetc%2Fssh%2Fclient.conf',
    'uname -a',
    { input: 'input' }
  )
  assert.equal(calls[0].command, 'ssh')
  assert.deepEqual(calls[0].args.slice(-2), ['deploy@example.test', 'uname -a'])
  assert.ok(calls[0].args.includes('BatchMode=yes'))
  assert.ok(calls[0].args.includes('StrictHostKeyChecking=yes'))
  assert.equal(calls[0].options.input, 'input')

  await ssh.copy(
    'ssh://deploy@example.test',
    '/local/webminai.plugin',
    '/tmp/webminai.A1b2/webminai.plugin'
  )
  assert.equal(calls[1].command, 'scp')
  assert.equal(calls[1].args.at(-1), 'deploy@example.test:/tmp/webminai.A1b2/webminai.plugin')

  await assert.rejects(
    ssh.copy('ssh://example.test', '/local/file', '/tmp/webminai.ok/../../etc/passwd'),
    /temporary directory/
  )
  await assert.rejects(
    ssh.execute('ssh://example.test', 'echo one\necho two'),
    /single line/
  )
})

test('SSH connection URL parsing rejects passwords and invalid users', () => {
  assert.deepEqual(parseSshConnection('ssh://host.example'), {
    host: 'host.example',
    username: '',
    port: 22,
    identityFile: undefined,
    configFile: undefined
  })
  assert.throws(() => parseSshConnection('ssh://user:secret@host.example'), /passwords/)
  assert.throws(() => parseSshConnection('ssh://bad%20user@host.example'), /username/)
  assert.throws(() => parseSshConnection('ssh://domain/user@host.example'), /encode a username slash as %2F/)
  assert.throws(() => parseSshConnection('ssh://host.example?identity=relative-key'), /absolute/)
})

test('system SSH preserves a Windows domain username as one argument', async () => {
  const calls = []
  const ssh = new SystemSsh({
    runner: async (command, args) => {
      calls.push({ command, args })
      return { code: 0, stdout: 'ok\n', stderr: '' }
    }
  })

  await ssh.execute('ssh://DOMAIN%2Fuser@windows.example', 'hostname')
  assert.deepEqual(calls[0].args.slice(-2), ['DOMAIN/user@windows.example', 'hostname'])

  await ssh.copy(
    'ssh://DOMAIN%2Fuser@windows.example',
    '/local/webminai.plugin.exe',
    '/tmp/webminai.A1b2/webminai.plugin.exe'
  )
  assert.equal(calls[1].args.at(-1), 'DOMAIN/user@windows.example:/tmp/webminai.A1b2/webminai.plugin.exe')

  await ssh.execute('ssh://MPC%5Cybyb2@windows.example', 'echo WEBMINAI_SSH_OK')
  assert.deepEqual(calls[2].args.slice(-2), ['MPC\\ybyb2@windows.example', 'echo WEBMINAI_SSH_OK'])

  await ssh.copy(
    'ssh://MPC%5Cybyb2@windows.example',
    '/local/webminai.plugin.exe',
    'C:/Windows/Temp/webminai.Ab12/webminai.plugin.exe'
  )
  assert.equal(calls[3].args.at(-1), 'MPC\\ybyb2@windows.example:C:/Windows/Temp/webminai.Ab12/webminai.plugin.exe')
})

test('SCP retries with its legacy protocol when the SFTP subsystem is unavailable', async () => {
  const calls = []
  const ssh = new SystemSsh({
    runner: async (command, args) => {
      calls.push({ command, args })
      if (calls.length === 1) return { code: 255, stdout: '', stderr: 'scp: Connection closed' }
      return { code: 0, stdout: '', stderr: '' }
    }
  })

  await ssh.copy(
    'ssh://deploy@example.test',
    '/local/webminai.plugin',
    '/tmp/webminai.A1b2/webminai.plugin'
  )

  assert.equal(calls.length, 2)
  assert.equal(calls[0].args.includes('-O'), false)
  assert.equal(calls[1].args.includes('-O'), true)
})

test('interactive SSH authenticates once and reuses a ControlMaster', async () => {
  const calls = []
  const runner = async (command, args, options) => {
    calls.push({ kind: 'captured', command, args, options })
    return { code: 0, stdout: 'ok', stderr: '' }
  }
  const interactiveRunner = async (command, args) => {
    calls.push({ kind: 'interactive', command, args })
    return { code: 0, signal: null }
  }
  const ssh = new SystemSsh({
    runner,
    interactiveRunner,
    terminalCheck: () => true
  })
  const session = await ssh.openInteractiveSession('ssh://deploy@host.example', {
    authentication: 'password'
  })
  try {
    const master = calls[0]
    assert.equal(master.kind, 'interactive')
    assert.ok(master.args.includes('-M'))
    assert.ok(master.args.includes('-fN'))
    assert.ok(master.args.includes('-T'))
    assert.ok(master.args.includes('PreferredAuthentications=password,keyboard-interactive'))
    assert.equal(master.args.includes('BatchMode=yes'), false)

    await session.ssh.execute('ssh://deploy@host.example', 'uname -a')
    const command = calls[1]
    assert.ok(command.args.includes('BatchMode=yes'))
    assert.ok(command.args.some(argument => argument.startsWith('ControlPath=')))

    await session.ssh.interactiveShell('ssh://deploy@host.example')
    assert.equal(calls[2].kind, 'interactive')
    assert.ok(calls[2].args.includes('-tt'))
    assert.ok(calls[2].args.some(argument => argument.startsWith('ControlPath=')))
  } finally {
    await session.close()
  }
  assert.ok(calls.at(-1).args.includes('exit'))
})

test('saved SSH credentials use a temporary askpass file without entering arguments or retained environment values', async () => {
  const calls = []
  let credentialPath
  const credential = 'password/or-key-passphrase'
  const ssh = new SystemSsh({
    terminalCheck: () => true,
    interactiveRunner: async () => { throw new Error('saved credentials must not use inherited interactive input') },
    runner: async (command, args, options = {}) => {
      calls.push({ command, args, options })
      if (args.includes('-M')) {
        credentialPath = options.env.WEBMINAI_ASKPASS_CREDENTIAL
        assert.equal(await readFile(credentialPath, 'utf8'), credential)
        assert.match(await readFile(options.env.SSH_ASKPASS, 'utf8'), /WEBMINAI_ASKPASS_CREDENTIAL/)
        assert.equal(args.includes(credential), false)
        assert.equal(Object.values(options.env).includes(credential), false)
        assert.ok(args.includes('StrictHostKeyChecking=yes'))
      }
      return { code: 0, stdout: '', stderr: '' }
    }
  })
  const session = await ssh.openInteractiveSession('ssh://deploy@host.example', {
    authentication: 'key',
    credential
  })
  await assert.rejects(access(credentialPath), /ENOENT/)
  await session.close()
  assert.ok(calls[0].args.includes('PreferredAuthentications=publickey'))
})

test('saved-credential session restores its ControlMaster without replaying an uncertain command', async () => {
  const calls = []
  let commandAttempts = 0
  const ssh = new SystemSsh({
    terminalCheck: () => true,
    runner: async (command, args) => {
      calls.push(args)
      if (args.at(-1) === 'hostname') {
        commandAttempts++
        if (commandAttempts === 1) return { code: 255, stdout: '', stderr: 'connection reset' }
        return { code: 0, stdout: 'windows-host\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
  })
  const session = await ssh.openInteractiveSession('ssh://deploy@host.example', {
    authentication: 'password',
    credential: 'saved-password'
  })
  try {
    await assert.rejects(
      session.ssh.execute('ssh://deploy@host.example', 'hostname'),
      /SSH command failed with exit code 255/
    )
    const result = await session.ssh.execute('ssh://deploy@host.example', 'hostname')
    assert.equal(result.stdout, 'windows-host\n')
    assert.equal(commandAttempts, 2)
    assert.ok(calls.filter(args => args.includes('-M')).length >= 2)
    assert.ok(calls.some(args => args.includes('-O') && args.includes('exit')))
  } finally {
    await session.close()
  }
})

test('host history fingerprints hash stable machine identity and support Windows fallback', async () => {
  const linuxIdentity = 'linux:0123456789abcdef0123456789abcdef'
  const linux = new SystemSsh({
    runner: async () => ({ code: 0, stdout: `${linuxIdentity}\n`, stderr: '' })
  })
  assert.equal(
    await linux.hostFingerprint('ssh://linux.example'),
    `SHA256:${createHash('sha256').update(linuxIdentity).digest('hex')}`
  )

  let calls = 0
  const windowsIdentity = 'windows:12345678-1234-1234-1234-123456789abc'
  const windows = new SystemSsh({
    runner: async (command, args) => {
      calls++
      if (calls === 1) return { code: 1, stdout: '', stderr: 'not a POSIX shell' }
      assert.match(args.at(-1), /MachineGuid/)
      return { code: 0, stdout: `${windowsIdentity}\r\n`, stderr: '' }
    }
  })
  assert.equal(
    await windows.hostFingerprint('ssh://windows.example'),
    `SHA256:${createHash('sha256').update(windowsIdentity).digest('hex')}`
  )
})
