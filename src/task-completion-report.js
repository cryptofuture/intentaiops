import { hostHealthProfile, isHostHealthTask, redactHealthText } from './host-health-task.js'
import { isSystemUpdateTask, systemUpdateProfile } from './system-update-task.js'

export async function completeTaskReport ({ admin, settings, passphrase, serverId, task, platform, inventory, results, onProgress = () => {} }) {
  const health = isHostHealthTask(task.catalogId)
  const update = isSystemUpdateTask(task.catalogId)
  if ((!health && !update) || task.status !== 'completed') return null
  inventory ??= await admin.refreshInventory({ settings, passphrase, serverId })
  platform ??= (await admin.capabilities({ settings, passphrase, serverId })).platform.os
  results ??= task.results
  const profile = health ? hostHealthProfile(platform, inventory) : systemUpdateProfile(platform)
  const evidence = health ? { ...healthEvidence(results), profile } : { profile, results: results.map(result => ({ id: result.id, status: result.status, stdout: redactHealthText(result.result?.stdout).slice(0, 64 * 1024), stderr: redactHealthText(result.result?.stderr).slice(0, 16 * 1024) })) }
  const report = await admin.consult({ settings, passphrase, serverId, inventory: { ...inventory, [health ? 'webminaiHealthEvidence' : 'webminaiSystemUpdateEvidence']: { format: health ? 'webminai-host-health-evidence' : 'webminai-system-update-evidence', version: 1, platform, collectedAt: new Date().toISOString(), source: 'approved verified common task', ...evidence } }, consultationContext: [], question: health ? hostHealthQuestion() : systemUpdateQuestion(), onProgress: event => { const safe = { ...event, message: redactHealthText(event.message) }; admin.appendTaskProgress(serverId, task.id, safe); onProgress(safe) } })
  const safeReport = { answer: redactHealthText(report.answer), contextSummary: redactHealthText(report.contextSummary) }
  admin.appendTaskProgress(serverId, task.id, { at: new Date().toISOString(), type: health ? 'health_report' : 'system_update_report', message: safeReport.answer, contextSummary: safeReport.contextSummary })
  await admin[health ? 'saveHealthContext' : 'saveUpdateContext'](serverId, { ...profile, observedAt: new Date().toISOString(), taskId: task.id, reportSummary: safeReport.contextSummary })
  return safeReport
}

function systemUpdateQuestion () {
  return [
    'Prepare a concise system-update completion report from webminaiSystemUpdateEvidence.',
    'State whether the update succeeded, then enumerate the software or packages installed, updated, removed, skipped, or failed with before and after versions when present.',
    'State explicitly that no reboot was performed and whether a reboot is now required.',
    'State whether a newer operating-system release or Windows feature upgrade is available, naming it when evidence does so; use unknown when the native check could not determine this.',
    'Do not confuse a package-manager full or dist upgrade inside configured repositories with an operating-system release upgrade.',
    'Mention the retained full audit path if terminal evidence is bounded. Do not propose or execute commands and do not reproduce credentials or secrets.'
  ].join(' ')
}

function healthEvidence (results) {
  const sections = results.filter(item => item.id.startsWith('collect-health-'))
  return {
    stdout: sections.map(item => `=== ${item.id} ===\n${redactHealthText(item.result?.stdout).slice(0, 48 * 1024)}`).join('\n').slice(0, 128 * 1024),
    stderr: sections.map(item => item.result?.stderr ? `=== ${item.id} ===\n${redactHealthText(item.result.stderr).slice(0, 16 * 1024)}` : '').filter(Boolean).join('\n').slice(0, 32 * 1024)
  }
}

function hostHealthQuestion () {
  return [
    'Prepare a concise, decision-useful health report for this host.',
    'Netdata inventory is the primary source for metrics, load, storage, containers, contexts, and alerts. webminaiHealthEvidence is a bounded read-only supplement for recent errors, failed services, updates, reboot state, and platform-specific details.',
    'Report: overall health; immediate issues; load, CPU, memory, storage and swap; service/container reliability; recent errors; pending updates and reboot needs; monitoring gaps; and prioritized next actions.',
    'Distinguish confirmed observations from unavailable or stale checks. Mention evidence timestamps where useful. Do not propose or execute commands. Do not reproduce secrets, tokens, credentials, raw log dumps, or unnecessary personal data.'
  ].join(' ')
}
