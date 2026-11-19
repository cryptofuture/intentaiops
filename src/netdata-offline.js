import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runProcess } from './process-runner.js'

export async function transferNetdataOfflineMsi (ssh, connectionUrl, remotePath) {
  const local = await mkdtemp(path.join(os.tmpdir(), 'intent-netdata-msi-'))
  try {
    const reply = await fetch('https://api.github.com/repos/netdata/netdata/releases/latest', { signal: AbortSignal.timeout(15000) })
    if (!reply.ok) throw new Error('Could not read the official Netdata release metadata')
    const asset = (await reply.json()).assets?.find(item => item.name === 'netdata-x64.msi')
    if (!/^sha256:[a-f0-9]{64}$/u.test(asset?.digest ?? '') || !/^https:\/\/github\.com\/netdata\/netdata\/releases\/download\/[\w.-]+\/netdata-x64\.msi$/u.test(asset.browser_download_url)) throw new Error('Official Netdata MSI checksum or URL is unavailable')
    const file = path.join(local, 'netdata-x64.msi')
    const result = await runProcess('curl', ['-q', '-fsSL', '--proto', '=https', '--proto-redir', '=https', '--max-filesize', '536870912', '--output', file, asset.browser_download_url], { timeoutMs: 600000 })
    if (result.code !== 0 || result.timedOut) throw new Error('Could not download the official Netdata MSI locally')
    const digest = createHash('sha256').update(await readFile(file)).digest('hex')
    if (asset.digest !== `sha256:${digest}`) throw new Error('Netdata MSI checksum verification failed')
    await ssh.copy(connectionUrl, file, remotePath)
    return digest
  } finally {
    await rm(local, { recursive: true, force: true })
  }
}

export async function transferNetdataOfflineBundle (ssh, connectionUrl, remoteDirectory, architecture) {
  const arch = { amd64: 'x86_64', arm64: 'aarch64' }[architecture]
  if (!arch) throw new Error('Unsupported Netdata offline architecture')
  const local = await mkdtemp(path.join(os.tmpdir(), 'intent-netdata-'))
  try {
    const script = path.join(local, 'kickstart.sh')
    const bundle = path.join(local, 'bundle')
    const run = async (command, args, timeoutMs) => {
      const result = await runProcess(command, args, { cwd: local, timeoutMs })
      if (result.code !== 0 || result.timedOut) throw new Error('Could not prepare the official Netdata offline bundle locally')
    }
    await run('curl', ['-q', '-fsSL', '--proto', '=https', '--proto-redir', '=https', '--output', script, 'https://get.netdata.cloud/kickstart.sh'], 60000)
    await run('sh', [script, '--non-interactive', '--release-channel', 'stable', '--offline-architecture', arch, '--prepare-offline-install-source', bundle], 600000)
    const names = await readdir(bundle)
    const archive = names.filter(name => /^netdata-[a-z0-9._-]+\.gz\.run$/iu.test(name))
    const required = ['channel', 'kickstart.sh', 'install.sh', 'Manifest', 'sha256sums.txt']
    if (archive.length !== 1 || names.length !== required.length + 1 || !required.every(name => names.includes(name))) throw new Error('Unexpected Netdata offline bundle contents')
    for (const name of names) {
      const info = await lstat(path.join(bundle, name))
      if (!info.isFile() || info.size > (name === archive[0] ? 512 * 1024 * 1024 : 1024 * 1024)) throw new Error('Invalid Netdata offline bundle file')
    }
    const manifest = await readFile(path.join(bundle, 'sha256sums.txt'), 'utf8')
    for (const name of [...required.slice(0, 3), ...archive]) {
      const digest = createHash('sha256').update(await readFile(path.join(bundle, name))).digest('hex')
      if (!manifest.split(/\r?\n/u).includes(`${digest} *${name}`)) throw new Error('Netdata offline bundle checksum verification failed')
    }
    await ssh.execute(connectionUrl, `mkdir -m 700 '${remoteDirectory}'`)
    for (const name of names) await ssh.copy(connectionUrl, path.join(bundle, name), `${remoteDirectory}/${name}`)
  } finally {
    await rm(local, { recursive: true, force: true })
  }
}
