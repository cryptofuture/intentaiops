import { createHash } from 'node:crypto'

export function planFingerprint (plan) {
  return createHash('sha256').update(JSON.stringify(canonical(plan)) ?? 'null').digest('hex')
}

function canonical (value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

export function journalMetadata (value) {
  if (Array.isArray(value)) return value.slice(0, 100).map(journalMetadata)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key,
      key === 'rollbackRevision' && /^[a-f0-9]{64}$/u.test(item)
        ? item
        : /password|passwd|secret|token|credential|authorization|private.?key|connectionurl|command|stdout|stderr/i.test(key)
          ? '[redacted]'
          : journalMetadata(item)
    ]))
  }
  if (typeof value !== 'string') return value
  return value.slice(0, 4096)
    .replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/gu, '[redacted-key]')
    .replace(/(?:ssh|https?):\/\/[^\s]+/giu, '[redacted-url]')
    .replace(/\b(?:password|passwd|secret|token|authorization)\s*[=:]\s*\S+/giu, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{48,}\b/gu, '[redacted-long-value]')
}

export const EXECUTION_EVENTS = new Set([
  'plan_approved', 'command_prepared', 'command_dispatched', 'command_acknowledged',
  'command_completed', 'command_failed', 'command_outcome_unknown', 'execution_paused',
  'execution_resumed', 'execution_recovery', 'plan_revised', 'rollback_started', 'rollback_completed'
])
