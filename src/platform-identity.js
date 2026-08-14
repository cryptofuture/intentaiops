const SUPPORTED_PLATFORMS = new Set(['freebsd', 'linux', 'macos', 'windows'])

export function normalizePlatformIdentity (value) {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (!text) return null
  const matches = new Set()
  if (/(?:^|[^a-z0-9])windows(?:_nt)?(?:$|[^a-z0-9])/u.test(text)) matches.add('windows')
  if (/(?:^|[^a-z0-9])freebsd(?:$|[^a-z0-9])/u.test(text)) matches.add('freebsd')
  if (/(?:^|[^a-z0-9])(?:darwin|macos|mac os)(?:$|[^a-z0-9])/u.test(text)) matches.add('macos')
  if (/(?:^|[^a-z0-9])linux(?:$|[^a-z0-9])/u.test(text)) matches.add('linux')
  return matches.size === 1 ? [...matches][0] : null
}

export function detectPersistedPlatform (inventory) {
  const explicit = normalizeSupportedPlatform(inventory?.webminaiExecution?.platform)
  if (explicit) return explicit

  const directCandidates = [
    inventory?.webminaiLinuxContext?.identity?.platform,
    inventory?.platform?.os,
    inventory?.os
  ]
  for (const candidate of directCandidates) {
    const platform = normalizePlatformIdentity(candidate)
    if (platform) return platform
  }

  const agents = Array.isArray(inventory?.info?.agents) ? inventory.info.agents : []
  for (const agent of agents) {
    const application = agent?.application
    const os = application?.os
    const candidates = [
      typeof os === 'string' ? os : null,
      application?.kernel,
      os?.kernel,
      os?.os,
      os?.name,
      application?.features?.['built-for']
    ]
    for (const candidate of candidates) {
      const platform = normalizePlatformIdentity(candidate)
      if (platform) return platform
    }
  }
  return null
}

function normalizeSupportedPlatform (value) {
  if (typeof value !== 'string') return null
  const platform = value.trim().toLowerCase()
  return SUPPORTED_PLATFORMS.has(platform) ? platform : null
}
