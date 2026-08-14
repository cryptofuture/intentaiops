import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSshConnection } from '../src/connection.js'
import { parseSshCommand } from '../src/ssh-command.js'

test('pasted SSH commands become constrained connection URLs', () => {
  const url = parseSshCommand("ssh -p 2202 -i '/keys/edge one' deploy@edge.example")
  assert.deepEqual(parseSshConnection(url), {
    host: 'edge.example',
    username: 'deploy',
    port: 2202,
    identityFile: '/keys/edge one',
    configFile: undefined
  })

  const configured = parseSshCommand('ssh -F /etc/ssh/webminai.conf -l root production')
  assert.deepEqual(parseSshConnection(configured), {
    host: 'production',
    username: 'root',
    port: 22,
    identityFile: undefined,
    configFile: '/etc/ssh/webminai.conf'
  })

  const windowsDomain = parseSshCommand('ssh "DOMAIN/user"@windows.example')
  assert.equal(windowsDomain, 'ssh://DOMAIN%2Fuser@windows.example')
  assert.deepEqual(parseSshConnection(windowsDomain), {
    host: 'windows.example',
    username: 'DOMAIN/user',
    port: 22,
    identityFile: undefined,
    configFile: undefined
  })

  const windowsBackslash = parseSshCommand("ssh -l 'DOMAIN\\user' windows.example")
  assert.equal(parseSshConnection(windowsBackslash).username, 'DOMAIN\\user')

  const unquotedWindowsBackslash = parseSshCommand('ssh DOMAIN\\user@windows.example')
  assert.equal(parseSshConnection(unquotedWindowsBackslash).username, 'DOMAIN\\user')
})

test('SSH command parser rejects remote commands and unsupported options', () => {
  assert.throws(() => parseSshCommand('ssh host.example uname -a'), /no remote command/)
  assert.throws(() => parseSshCommand('ssh -J jump.example host.example'), /unsupported SSH option/)
  assert.throws(() => parseSshCommand('ssh -i relative-key host.example'), /absolute/)
  assert.throws(() => parseSshCommand('scp file host:/tmp'), /ssh command/)
})
