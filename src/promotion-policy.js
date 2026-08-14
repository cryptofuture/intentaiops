const REQUIRED_STEPS = ['apply1', 'apply2', 'restartRecovery', 'revert1', 'revert2']

export function evaluatePromotionEvidence (evidence) {
  if (!evidence || typeof evidence !== 'object') throw new TypeError('promotion evidence is required')
  const failures = []
  for (const step of REQUIRED_STEPS) {
    if (evidence[step]?.status !== 'completed') failures.push(`${step} did not complete`)
  }
  if (evidence.apply2?.changed === true) failures.push('second apply was not idempotent')
  if (evidence.revert2?.changed === true) failures.push('second revert was not idempotent')
  if (!safeFingerprint(evidence.baselineFingerprint) || !safeFingerprint(evidence.finalFingerprint)) failures.push('baseline fingerprints are missing or invalid')
  else if (evidence.baselineFingerprint !== evidence.finalFingerprint) failures.push('final baseline does not exactly match the initial baseline')
  return {
    promoted: failures.length === 0,
    requiredSteps: [...REQUIRED_STEPS],
    failures
  }
}

function safeFingerprint (value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}
