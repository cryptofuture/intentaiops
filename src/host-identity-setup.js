import { Stage2Service } from './stage2-service.js'
import { assertHostFingerprintAvailable } from './settings-store.js'
import { parseSshConnection } from './connection.js'

export async function prepareHostIdentity ({ ui, ssh, connectionUrl, serverId, settingsStore, settings, passphrase, chooseElevation, enrollmentOnly = false }) {
  const identity = ssh.hostIdentity ? await ssh.hostIdentity(connectionUrl) : null
  let fingerprint = identity?.fingerprint ?? await ssh.hostFingerprint(connectionUrl)
  let conflict = null
  try { assertHostFingerprintAvailable(settings, serverId, fingerprint) } catch (error) {
    if (error.code !== 'HOST_IDENTITY_CONFLICT') throw error
    conflict = error
  }
  const needsEnrollment = ['macos', 'windows'].includes(identity?.platform) && identity.enrollmentId === null
  if (!conflict && !needsEnrollment) return { hostFingerprint: fingerprint, sudoPassword: null }
  if (conflict) ui.warn(conflict.message)
  const stage2 = new Stage2Service({ ssh })
  const capabilities = await stage2.capabilities({ connectionUrl })
  const platform = capabilities.platform?.os
  const enrollment = ['macos', 'windows'].includes(platform)
  if (!enrollment && (enrollmentOnly || !['linux', 'freebsd'].includes(platform))) throw conflict ?? new Error('This platform does not support confirmed identity setup')
  const hostname = (await ssh.execute(connectionUrl, 'hostname', { timeoutMs: 10000 })).stdout.trim()
  if (conflict) ui.line('Existing configured host', conflict.existingServerId)
  ui.line('New host label', serverId)
  ui.line('Connected hostname', /^[A-Za-z0-9._-]{1,253}$/u.test(hostname) ? hostname : '(unavailable)')
  const identityName = enrollment ? 'Intent AI Ops enrollment ID' : platform === 'freebsd' ? 'FreeBSD host UUID' : 'Linux machine ID'
  if (enrollment) ui.warn('Creates or rotates a protected, persistent Intent AI Ops enrollment ID on this machine. Native OS identity, Netdata GUID, hostname and SSH keys remain unchanged. Keep the record across reinstalls. Rotation changes identity-bound recovery; original host history is never reassociated. No reboot is needed.')
  else ui.warn('Only proceed if this is a DIFFERENT VPS, not another address or account on the existing host. Changing its machine ID can affect DHCP leases, monitoring, licensing, and identity-bound recovery. A later reboot may be needed for running services. The hostname and SSH keys will not change. No reboot is performed.')
  if (platform === 'freebsd') ui.warn('FreeBSD repair refuses jails, elevated securelevel, imported ZFS pools, non-default host-ID paths and unsafe identity files.')
  const question = conflict
    ? `I confirm ${serverId} is a different VPS from ${conflict.existingServerId}. ${enrollment ? 'Create or rotate' : 'Replace only'} its ${identityName}?`
    : `Create a protected ${identityName} on ${serverId} before saving this host?`
  if (!await ui.confirm(question, false)) return null
  if (conflict) {
    const existing = await settingsStore.decryptServer({ settings, passphrase, serverId: conflict.existingServerId })
    const oldTarget = parseSshConnection(existing.connectionUrl)
    const newTarget = parseSshConnection(connectionUrl)
    if (oldTarget.host === newTarget.host && oldTarget.port === newTarget.port) throw new Error('Both entries use the same SSH destination; refusing to change the configured host identity')
  }
  const elevation = await chooseElevation(ui, capabilities)
  if (!elevation) return null
  try {
    const args = { connectionUrl, platform, expectedFingerprint: fingerprint, ...elevation }
    fingerprint = enrollment ? await stage2.replaceHostEnrollment(args) : platform === 'freebsd' ? await stage2.replaceFreeBsdHostId(args) : await stage2.replaceLinuxMachineId(args)
    assertHostFingerprintAvailable(settings, serverId, fingerprint)
    ui.success(`New ${identityName} verified. Original host history and credentials were not changed.`)
    return { hostFingerprint: fingerprint, sudoPassword: elevation.sudoPassword ?? null }
  } finally { elevation.sudoPassword = null }
}
