#!/usr/bin/env node

import { randomBytes } from 'node:crypto'
import { accessSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'

const NODE_VERSION = '24.16.0'
const TARGETS = [
  { serverId: 'webminai-ubuntu-2404', platform: 'linux' },
  { serverId: 'webminai-freebsd-15-1', platform: 'freebsd' },
  { serverId: 'macos-15', platform: 'macos', credentialEnv: 'SSH_HOST_MAC_PWD' },
  { serverId: 'windows-11', platform: 'windows', credentialEnv: 'SSH_HOST_PWD' }
]

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write('Usage: validate-package-install-remote.js [--host=SERVER_ID]\nRequires VAULT_TEST and any host credential environment variables not already stored in the vault.\n')
  process.exit(0)
}
if (!process.env.VAULT_TEST) throw new Error('VAULT_TEST is required')
const requested = process.argv.find(value => value.startsWith('--host='))?.slice(7)
const targets = requested ? TARGETS.filter(target => target.serverId === requested) : TARGETS
if (targets.length === 0) throw new Error(`unknown package-install test host: ${requested}`)

const projectRoot = path.resolve(import.meta.dirname, '..')
const tarball = path.join(projectRoot, 'dist', 'intent-ai-ops.tgz')
const dataRoot = path.resolve(process.env.WEBMINAI_DATA_ROOT ?? path.join(os.homedir(), '.webminai'))
const settingsStore = new SettingsStore(dataRoot)
const settings = await settingsStore.load()

accessSync(tarball)
for (const target of targets) await validateTarget(target, tarball)

async function validateTarget (target, tarball) {
  const server = await settingsStore.decryptServer({ settings, passphrase: process.env.VAULT_TEST, serverId: target.serverId })
  const credential = server.sshCredential ?? (target.credentialEnv ? process.env[target.credentialEnv] : null)
  const session = await new SystemSsh({ terminalCheck: () => true }).openInteractiveSession(server.connectionUrl, {
    authentication: server.authentication,
    credential
  })
  const token = randomBytes(8).toString('hex')
  const remoteDirectory = target.platform === 'windows'
    ? `C:/Windows/Temp/webminai.${token}`
    : `/tmp/webminai.${token}`
  const remoteTarball = `${remoteDirectory}/intent-ai-ops.tgz`
  try {
    await session.ssh.execute(server.connectionUrl, createDirectoryCommand(target.platform, remoteDirectory), { timeoutMs: 30000 })
    await session.ssh.copy(server.connectionUrl, tarball, remoteTarball, { timeoutMs: 120000 })
    const result = await session.ssh.execute(server.connectionUrl, validationCommand(target.platform, remoteDirectory), { timeoutMs: 300000 })
    if (!result.stdout.includes('PACKAGE_INSTALL_OK')) throw new Error(`${target.serverId} did not return its package-install marker`)
    process.stdout.write(`PASS: ${target.serverId} (${target.platform}) installed dist/intent-ai-ops.tgz and ran Intent AI Ops\n`)
  } finally {
    try {
      await session.ssh.execute(server.connectionUrl, cleanupCommand(target.platform, remoteDirectory), { timeoutMs: 120000 })
    } catch {}
    await session.close()
  }
}

function createDirectoryCommand (platform, directory) {
  if (platform === 'windows') return powershell(`New-Item -ItemType Directory -Path '${directory}' -Force|Out-Null`)
  return `install -d -m 0700 '${directory}'`
}

function cleanupCommand (platform, directory) {
  if (platform === 'windows') return powershell(`Remove-Item -LiteralPath '${directory}' -Recurse -Force -ErrorAction SilentlyContinue`)
  if (platform === 'freebsd') return `rm -rf -- '${directory}'; sudo -n pkg delete -y npm-node24 node24 >/dev/null 2>&1 || true`
  return `rm -rf -- '${directory}'`
}

function validationCommand (platform, directory) {
  if (platform === 'linux') return linuxValidation(directory)
  if (platform === 'macos') return macosValidation(directory)
  if (platform === 'freebsd') return freebsdValidation(directory)
  if (platform === 'windows') return windowsValidation(directory)
  throw new Error(`unsupported package-install platform: ${platform}`)
}

function linuxValidation (directory) {
  const archive = `node-v${NODE_VERSION}-linux-x64.tar.xz`
  return `set -eu; cd '${directory}'; curl --fail --location --silent --show-error 'https://nodejs.org/dist/v${NODE_VERSION}/${archive}' --output '${archive}'; printf '%s  %s\\n' d804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9 '${archive}' | sha256sum -c - >/dev/null; tar -xJf '${archive}'; export PATH="$PWD/node-v${NODE_VERSION}-linux-x64/bin:$PATH"; npm install --global --prefix "$PWD/prefix" "file://$PWD/intent-ai-ops.tgz" >/dev/null; "$PWD/prefix/bin/intentaiops" --help | grep -Fq 'Usage: intentaiops'; ${posixStoreSmoke(directory, `node-v${NODE_VERSION}-linux-x64/bin/node`)}; printf '%s\\n' PACKAGE_INSTALL_OK`
}

function macosValidation (directory) {
  const archive = `node-v${NODE_VERSION}-darwin-x64.tar.gz`
  return `set -eu; cd '${directory}'; curl --fail --location --silent --show-error 'https://nodejs.org/dist/v${NODE_VERSION}/${archive}' --output '${archive}'; printf '%s  %s\\n' 298b4c7b3cb80765c8703e42b90324a4ece3b6634947b89e769c3c980ab55185 '${archive}' | shasum -a 256 -c >/dev/null; tar -xzf '${archive}'; export PATH="$PWD/node-v${NODE_VERSION}-darwin-x64/bin:$PATH"; npm install --global --prefix "$PWD/prefix" "file://$PWD/intent-ai-ops.tgz" >/dev/null; "$PWD/prefix/bin/intentaiops" --help | grep -Fq 'Usage: intentaiops'; ${posixStoreSmoke(directory, `node-v${NODE_VERSION}-darwin-x64/bin/node`)}; printf '%s\\n' PACKAGE_INSTALL_OK`
}

function freebsdValidation (directory) {
  return `set -eu; sudo -n pkg install -y node24 npm-node24 python312 gmake >/dev/null; cd '${directory}'; npm install --global --prefix "$PWD/prefix" "file://$PWD/intent-ai-ops.tgz" >/dev/null; "$PWD/prefix/bin/intentaiops" --help | grep -Fq 'Usage: intentaiops'; ${posixStoreSmoke(directory, '/usr/local/bin/node')}; printf '%s\\n' PACKAGE_INSTALL_OK`
}

function posixStoreSmoke (directory, node) {
  const module = `file://${directory}/prefix/lib/node_modules/intent-ai-ops/src/task-store.js`
  const script = `import {TaskStore} from '${module}';const s=new TaskStore('${directory}/data');const t=s.create('install-smoke','Validate installed package');s.cancel('install-smoke',t.id);if(s.get('install-smoke',t.id).status!=='cancelled')process.exit(1)`
  return `'${node}' --input-type=module --eval ${shellQuote(script)}`
}

function windowsValidation (directory) {
  const archive = `node-v${NODE_VERSION}-win-x64.zip`
  const script = [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)',
    `$root='${directory}'`,
    `$archive=Join-Path $root '${archive}'`,
    `& curl.exe --fail --location --silent --show-error 'https://nodejs.org/dist/v${NODE_VERSION}/${archive}' --output $archive`,
    "if($LASTEXITCODE-ne 0){throw 'Node download failed.'}",
    "if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()-ne'edaca9bd58ec8e92037dac4e877d52f6b8f430b81c18b57e264b4e2fb111cd56'){throw 'Node checksum mismatch.'}",
    'Expand-Archive -LiteralPath $archive -DestinationPath $root -Force',
    `$nodeRoot=Join-Path $root 'node-v${NODE_VERSION}-win-x64'`,
    '$env:Path=$nodeRoot+\';\'+$env:Path',
    '$prefix=Join-Path $root \'prefix\'',
    '$packageUrl=\'file:///\'+(Join-Path $root \'intent-ai-ops.tgz\').Replace([char]92,[char]47)',
    '& (Join-Path $nodeRoot \'npm.cmd\') install --global --prefix $prefix $packageUrl|Out-Null',
    "if($LASTEXITCODE-ne 0){throw 'npm package installation failed.'}",
    '$help=& (Join-Path $prefix \'intentaiops.cmd\') --help|Out-String',
    "if($LASTEXITCODE-ne 0-or$help-notmatch'Usage: intentaiops'){throw 'Installed CLI help failed.'}",
    '$moduleUrl=\'file:///\'+(Join-Path $prefix \'node_modules/intent-ai-ops/src/task-store.js\').Replace([char]92,[char]47)',
    '$data=(Join-Path $root \'data\').Replace([char]92,[char]47)',
    '$smoke="import {TaskStore} from \'"+$moduleUrl+"\';const s=new TaskStore(\'"+$data+"\');const t=s.create(\'install-smoke\',\'Validate installed package\');s.cancel(\'install-smoke\',t.id);if(s.get(\'install-smoke\',t.id).status!==\'cancelled\')process.exit(1)"',
    '& (Join-Path $nodeRoot \'node.exe\') --input-type=module --eval $smoke',
    "if($LASTEXITCODE-ne 0){throw 'Installed SQLite smoke test failed.'}",
    "Write-Output 'PACKAGE_INSTALL_OK'"
  ].join(';')
  return powershell(script)
}

function powershell (script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
}

function shellQuote (value) {
  return `'${value.replaceAll("'", '\'"\'"\'')}'`
}
