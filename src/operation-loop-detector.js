import { createHash } from 'node:crypto'
import { classifyFailure } from './failure-signature.js'
import { sanitizePlannerData } from './codex-planner.js'

export function detectOperationLoop (history, { repeatedFailures = 3, maxAttempts = 8 } = {}) {
  if (!Number.isInteger(repeatedFailures) || repeatedFailures < 3 || !Number.isInteger(maxAttempts) || maxAttempts < repeatedFailures) throw new TypeError('invalid loop detection thresholds')
  const evidence = []
  for (const task of history ?? []) {
    if (task.results?.length && task.results.every(result => result.status === 'completed')) { evidence.length = 0; continue }
    const failed = task.results?.find(result => result.status === 'failed')
    if (!failed) continue
    const item = task.plan?.commands?.find(command => command.id === failed.id)
    if (!item) continue
    const signature = failed.failure ?? classifyFailure({ item, result: failed.result })
    const command = sanitizePlannerData(item.command).replace(/\s+/gu, ' ').trim()
    const result = sanitizePlannerData(failed.result)
    if (result && typeof result === 'object') for (const key of ['jobId', 'attemptId', 'observedAt', 'startedAt', 'finishedAt', 'durationMs', 'pid']) delete result[key]
    const fingerprint = createHash('sha256').update(JSON.stringify([command, signature.code, result, sanitizePlannerData(failed.diagnostic)])).digest('hex')
    const diagnosticFingerprint = createHash('sha256').update(JSON.stringify([signature.code, sanitizePlannerData(failed.diagnostic) ?? result])).digest('hex')
    evidence.push({ taskId: task.id, fingerprint, diagnosticFingerprint, failureCode: signature.code, completed: (task.results ?? []).filter(result => result.status === 'completed').length })
  }
  const tail = evidence.slice(-repeatedFailures)
  const noProgress = tail.length === repeatedFailures && tail.every(entry => entry.completed <= tail[0].completed)
  const identical = noProgress && tail.every(entry => entry.fingerprint === tail[0].fingerprint || entry.diagnosticFingerprint === tail[0].diagnosticFingerprint)
  const alternating = evidence.length >= repeatedFailures * 2 && evidence.slice(-repeatedFailures * 2).every((entry, index, entries) => index < 2 || (entry.fingerprint === entries[index - 2].fingerprint && entry.completed <= entries[index - 2].completed))
  return {
    version: 1,
    detected: identical || alternating || (evidence.length >= maxAttempts && noProgress),
    reason: identical
      ? 'Identical failed operation and diagnostic evidence repeated without progress'
      : alternating
        ? 'Alternating failed operations repeated without progress'
        : evidence.length >= maxAttempts && noProgress ? 'Repair attempt limit reached without progress' : null,
    evidence
  }
}
