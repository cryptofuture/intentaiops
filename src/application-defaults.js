export const FALLBACK_ADMIN_EMAIL = 'intentaiops@example.invalid'
export const LEGACY_FALLBACK_ADMIN_EMAIL = 'webminai@example.invalid'

const EMAIL_PATTERN = /^[A-Za-z0-9._+-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,63}$/

/** @param {{ adminEmail?: unknown }} [value] */
export function normalizeApplicationDefaults (value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('application defaults must be an object')
  }
  const adminEmail = value.adminEmail === undefined || value.adminEmail === null || value.adminEmail === ''
    ? null
    : normalizeAdminEmail(value.adminEmail)
  return { adminEmail }
}

export function normalizeAdminEmail (value) {
  if (typeof value !== 'string') throw new TypeError('administrator email must be a string')
  const email = value.trim()
  if (email.length > 254 || !EMAIL_PATTERN.test(email) || email.includes('..')) {
    throw new TypeError('enter a conventional email address such as admin@example.com')
  }
  return email
}

export function normalizeAdminEmailPreset (value) {
  if (value === '-' || value === '') return null
  return normalizeAdminEmail(value)
}

export function applyApplicationDefaults (value, defaults = {}) {
  const { adminEmail } = normalizeApplicationDefaults(defaults)
  if (!adminEmail) return value
  const replace = text => typeof text === 'string'
    ? text.replaceAll(FALLBACK_ADMIN_EMAIL, adminEmail).replaceAll(LEGACY_FALLBACK_ADMIN_EMAIL, adminEmail)
    : text
  if (value?.plan?.commands && value?.plan?.revertCommands) {
    return {
      ...value,
      plan: {
        ...value.plan,
        commands: value.plan.commands.map(item => ({ ...item, command: replace(item.command) })),
        revertCommands: value.plan.revertCommands.map(item => ({ ...item, command: replace(item.command) }))
      },
      verifyApplied: replace(value.verifyApplied),
      verifyReverted: replace(value.verifyReverted),
      stateProbe: replace(value.stateProbe)
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return replace(value)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, Array.isArray(item) ? item.map(replace) : replace(item)]))
}
