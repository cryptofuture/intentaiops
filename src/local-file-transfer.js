import { constants, createReadStream } from 'node:fs'
import { chmod, link, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export function validateFileTransfer (transfer) {
  if (!transfer || typeof transfer !== 'object' || Array.isArray(transfer) || Object.keys(transfer).some(key => !['remotePath', 'localPath', 'removeSource'].includes(key))) throw new TypeError('invalid file transfer')
  const { remotePath, localPath, removeSource } = transfer
  if (typeof remotePath !== 'string' || remotePath.length > 4096 || !remotePath.startsWith('/') || /[\0\r\n]/u.test(remotePath) || path.posix.normalize(remotePath) !== remotePath || remotePath.endsWith('/')) throw new TypeError('transfer source must be a normalized absolute Unix file path')
  if (typeof localPath !== 'string' || localPath.length > 4096 || !path.isAbsolute(localPath) || /[\0\r\n]/u.test(localPath) || path.normalize(localPath) !== localPath) throw new TypeError('transfer destination must be an absolute local file path')
  const relative = path.relative(os.homedir(), localPath)
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || relative.split(path.sep).some(part => part.startsWith('.'))) throw new TypeError('transfer destination must be a non-hidden path within the current local user home')
  if (typeof removeSource !== 'boolean') throw new TypeError('transfer cleanup must be explicitly selected')
  return transfer
}

export function fileTransferDescription (transfer) {
  validateFileTransfer(transfer)
  return `Download ${JSON.stringify(transfer.remotePath)} to local ${JSON.stringify(transfer.localPath)}; verify SHA-256${transfer.removeSource ? '; then remove the unchanged remote source' : '; keep the remote source'}`
}

const quote = value => `'${value.replaceAll("'", "'\\''")}'`

function sourceCheck (source) {
  return `source=${quote(source)}
test -f "$source" && test ! -L "$source"
parent=$(dirname "$source")
while [ "$parent" != / ]; do test ! -L "$parent"; parent=$(dirname "$parent"); done
digest() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  elif command -v sha256 >/dev/null 2>&1; then sha256 -q "$1"
  else shasum -a 256 "$1" | cut -d ' ' -f 1; fi
}
identity() {
  case "$(uname -s)" in
    Linux) stat -c '%d:%i:%s:%Y' "$source" ;;
    FreeBSD|Darwin) stat -f '%d:%i:%z:%m' "$source" ;;
    *) exit 78 ;;
  esac
}`
}

export async function downloadRemoteFile ({ ssh, netdata, connectionUrl, item }) {
  const transfer = validateFileTransfer(item.fileTransfer)
  const parent = path.dirname(transfer.localPath)
  if (await realpath(parent) !== parent) throw new Error('Local download directory must not contain symlinks')
  try { await lstat(transfer.localPath); throw new Error('Local destination already exists; choose a new filename') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const health = await netdata.health()
  if (!['linux', 'freebsd', 'macos'].includes(health.platform)) throw new Error('Reviewed local downloads currently require a Unix SSH host, not Windows or Kubernetes')
  const identity = await ssh.execute(connectionUrl, 'id -u; id -g', { timeoutMs: 15000 })
  const ids = identity.stdout.trim().split(/\s+/u)
  if (ids.length !== 2 || ids.some(id => !/^\d{1,10}$/u.test(id))) throw new Error('Unable to establish the authenticated SCP account identity')
  const directory = `/tmp/webminai.${randomBytes(12).toString('hex')}`
  const payload = `${directory}/payload`
  const cleanup = () => netdata.runCommand(`set -eu; test ! -L ${quote(directory)}; rm -f -- ${quote(payload)}; rmdir ${quote(directory)}`, { timeoutSeconds: 15 })
  let localDirectory
  let staged = false
  try {
    const prepared = await netdata.runCommand(`set -eu
${sourceCheck(transfer.remotePath)}
before=$(identity)
hash=$(digest "$source")
umask 077
mkdir ${quote(directory)}
trap ${quote(`rm -f -- ${quote(payload)}; rmdir ${quote(directory)}`)} 0
cp "$source" ${quote(payload)}
test "$(digest ${quote(payload)})" = "$hash"
test "$(identity)" = "$before"
chown ${ids[0]}:${ids[1]} ${quote(payload)}
chmod 400 ${quote(payload)}
chgrp ${ids[1]} ${quote(directory)}
chmod 710 ${quote(directory)}
trap - 0
printf 'WEBMINAI_TRANSFER %s %s\\n' "$hash" "$before"`, { timeoutSeconds: Math.ceil(item.timeoutMs / 1000) })
    if (prepared.exitCode !== 0 || prepared.timedOut) throw new Error('Remote staging failed; source preserved')
    staged = true
    const match = prepared.stdout.trim().match(/^WEBMINAI_TRANSFER ([a-f0-9]{64}) ([0-9]+:[0-9]+:[0-9]+:[0-9]+)$/u)
    if (!match) throw new Error('Invalid remote transfer evidence; source preserved')
    const [, expectedHash, expectedIdentity] = match
    localDirectory = await mkdtemp(path.join(parent, '.intentaiops-download-'))
    const temporary = path.join(localDirectory, 'payload')
    await ssh.download(connectionUrl, payload, temporary, { timeoutMs: item.timeoutMs })
    const file = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if (!(await file.stat()).isFile()) throw new Error('Downloaded payload is not a regular file')
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(temporary, { fd: file.fd, autoClose: false })) hash.update(chunk)
      if (hash.digest('hex') !== expectedHash) throw new Error('Downloaded checksum mismatch; source preserved')
      await chmod(temporary, 0o600)
      await file.sync()
      await link(temporary, transfer.localPath)
    } finally { await file.close() }
    if (process.platform !== 'win32') {
      const handle = await open(parent, 'r')
      try { await handle.sync() } finally { await handle.close() }
    }
    staged = false
    const cleaned = await cleanup()
    if (cleaned.exitCode !== 0 || cleaned.timedOut) throw new Error(`Local file saved, but remote staging cleanup was not confirmed at ${directory}; source preserved`)
    if (transfer.removeSource) {
      const removed = await netdata.runCommand(`set -eu
${sourceCheck(transfer.remotePath)}
test "$(identity)" = ${quote(expectedIdentity)}
test "$(digest "$source")" = ${quote(expectedHash)}
rm -- "$source"`, { timeoutSeconds: 30 })
      if (removed.exitCode !== 0 || removed.timedOut) throw new Error('Local file verified and saved, but remote cleanup was not confirmed. Inspect both locations before retrying')
    }
    return { exitCode: 0, stdout: `Saved verified file to ${transfer.localPath}${transfer.removeSource ? '; remote source removed' : '; remote source retained'}`, stderr: '', transfer: { ...transfer, sha256: expectedHash } }
  } finally {
    if (localDirectory) await rm(localDirectory, { recursive: true, force: true })
    if (staged) {
      try { await cleanup() } catch {}
    }
  }
}
