export const SECURITY_REVIEW_DATE = '2026-10-27'
export const PHP_FIXED = Object.freeze({ 8.2: '8.2.35', 8.3: '8.3.36', 8.4: '8.4.27', 8.5: '8.5.12' })
export const NEXT_FIXED = Object.freeze({ 14.2: '14.2.35', '15.0': '15.0.8', 15.1: '15.1.12', 15.2: '15.2.9', 15.3: '15.3.9', 15.4: '15.4.11', 15.5: '15.5.10', '16.0': '16.0.11', 16.1: '16.1.5' })
const RSC_FIXED = Object.freeze({ '19.0': '19.0.4', 19.1: '19.1.5', 19.2: '19.2.4' })
export const RSC_PACKAGES = Object.freeze(['next', 'react-server-dom-webpack', 'react-server-dom-parcel', 'react-server-dom-turbopack'])
const PHP_APPS = new Set(['wordpress', 'woocommerce', 'joomla', 'drupal', 'prestashop', 'moodle', 'magento', 'nextcloud'])
const APPLICATIONS = new Set([...PHP_APPS, 'n8n', 'ghost', 'mattermost', 'odoo', 'jellyfin', 'home-assistant', 'intent-ai-ops', 'docker', 'docker-desktop', 'podman', 'colima', 'brave', 'nginx-static-site'])

export function securityApplication (catalogId) {
  if (typeof catalogId !== 'string') return null
  const match = /^(.*)-(linux|freebsd|macos|windows|kubernetes)$/u.exec(catalogId)
  return match && APPLICATIONS.has(match[1]) ? match[1] : null
}

function exactVersion (value) {
  if (typeof value !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,4}(?:[-+~][A-Za-z0-9.+~_-]{1,80})?$/u.test(value) || /(?:^|[-+~.])(?:dev|alpha|beta|rc|canary)/iu.test(value)) return null
  return value.split(/[-+~]/u)[0].split('.').map(Number)
}

export function assessRuntimeVersion (name, version) {
  const parsed = exactVersion(version)
  const cves = name === 'php' ? ['CVE-2026-109618', 'CVE-2026-109619'] : ['CVE-2025-55182', 'CVE-2025-66478', 'CVE-2025-55183', 'CVE-2025-55184', 'CVE-2025-67779', 'CVE-2026-23864']
  if (name !== 'php' && !RSC_PACKAGES.includes(name)) return { name, status: 'not_applicable', version: null, fixedVersion: null, cves: [] }
  const fixed = parsed && (name === 'php' ? PHP_FIXED : name === 'next' ? NEXT_FIXED : RSC_FIXED)[parsed.slice(0, 2).join('.')]
  const safeVersion = parsed ? version : null
  if (name === 'php' && parsed && ['5.4', '5.5', '5.6', '7.0', '7.1', '7.2', '7.3', '7.4', '8.0', '8.1'].includes(parsed.slice(0, 2).join('.'))) return { name, version, status: 'potentially_vulnerable', fixedVersion: null, cves }
  if (name === 'next' && parsed && parsed[0] === 13 && parsed[1] >= 3) return { name, version, status: 'potentially_vulnerable', fixedVersion: '14.2.35', cves }
  if (!parsed || !fixed) return { name, version: safeVersion, status: 'unknown', fixedVersion: null, cves }
  const minimum = fixed.split('.').map(Number)
  const older = parsed.some((part, index) => part < minimum[index] && parsed.slice(0, index).every((value, i) => value === minimum[i]))
  return { name, version: safeVersion, status: older ? 'potentially_vulnerable' : 'meets_tracked_floor', fixedVersion: fixed, cves }
}

export function parseSecurityEvidence (results = []) {
  const observations = []
  if (!Array.isArray(results)) return { observations, complete: false }
  const result = results.filter(item => /^audit-software-security(?:-(?:catalog-)?[a-f0-9]{12})?$/u.test(item.id ?? '')).at(-1)
  if (!result || result.status !== 'completed' || result.result?.stdoutTruncated || result.result?.stderrTruncated) return { observations, complete: false }
  const output = result.result?.stdout ?? ''
  if (typeof output !== 'string' || Buffer.byteLength(output) > 32768) return { observations, complete: false }
  for (const line of output.split(/\r?\n/u).slice(0, 256)) {
    const match = /^INTENT_SECURITY_(PHP|NPM) ([a-zA-Z0-9_.:-]{1,80}) (?:(next|react-server-dom-webpack|react-server-dom-parcel|react-server-dom-turbopack) )?([0-9][A-Za-z0-9.+~_-]{0,95})$/u.exec(line)
    if (!match || (match[1] === 'NPM') !== Boolean(match[3])) continue
    if (!/^(?:host-cli(?:-php(?:8[2345])?)?|container-[a-f0-9]{12,64}|runtime)$/u.test(match[2])) continue
    observations.push({ scope: match[2], ...assessRuntimeVersion(match[3] ?? 'php', match[4]) })
    if (observations.length === 64) break
  }
  return { observations, complete: output.split(/\r?\n/u).includes('INTENT_SECURITY_END') }
}

export function securityRemediationInstructions (results) {
  const evidence = parseSecurityEvidence(results)
  if (!evidence.complete) throw new Error('Security collection is incomplete; collect fresh evidence before remediation')
  const findings = evidence.observations.filter(item => item.status === 'potentially_vulnerable')
  if (!findings.length) throw new Error('No actionable tracked security issue was detected')
  return [
    'Prepare executable security updates for the following bounded version observations, not another recommendation-only report.',
    JSON.stringify(findings),
    'First verify that each observation belongs to this task and inspect the exact installed artifact and current service state. A host CLI version does not identify an application web worker. Check vendor backports before classifying a distro package as affected.',
    'For native installations, prefer supported vendor security packages in the existing release line. For Docker/Podman, update or rebuild the correct task-owned image and recreate only affected services, preserving volumes, credentials and configuration. Never patch only a running container. Kubernetes must use the separate gateway, never SSH or pod-exec.',
    'Capture previous package/image identities and recovery evidence before mutation. Keep original deployment rollback coverage and add rollback for the security change. Do not remove data or upgrade unrelated software. No OS upgrades, unreviewed major migrations, arbitrary downloaded patches or disabled signature checks.',
    'If a source patch is necessary, require an official matching patch with pinned integrity, an owned build context and rebuild/compatibility checks. If provenance, ownership, applicability or rollback cannot be established, return no executable commands and explain the blocker.',
    'After updating, restart only affected services and verify application health and the actual running patched artifact. Do not claim remediation from a pull/build alone. No exploits or secret disclosure. New commands require normal explicit review and approval.'
  ].join('\n')
}

export function applicationSecurityReport (catalogId, results = []) {
  const application = securityApplication(catalogId)
  if (!application) return null
  const evidence = parseSecurityEvidence(results)
  const recommendations = [
    'Install security updates from the application and operating-system vendors. A pinned image digest or successful installation is not proof that software is free of vulnerabilities.',
    'Use TLS, restrict administrative access, replace bootstrap credentials, configure backups and review vendor security advisories regularly.'
  ]
  if (PHP_APPS.has(application)) {
    recommendations.unshift(
      'PHP: require a supported vendor-patched build. Upstream floors for CVE-2026-109618/109619 are 8.2.35, 8.3.36, 8.4.27 and 8.5.12. Older distro builds need vendor backport evidence, not a version-only safe verdict.',
      'Keep session.upload_progress.enabled=0 in the active web SAPI configuration before request parsing and restart every PHP worker, following the PHP advisory for CVE-2026-115560. This is not a substitute for updating PHP.',
      'If upgrading is impossible, review the official matching source backport first. Community patches require exact source/build matching, integrity checks, rebuild tests and a separate approved rollback plan. Never apply a downloaded patch blindly.'
    )
  }
  recommendations.push('For Next.js/RSC dependencies, inspect resolved production versions and upgrade to the latest supported security release in the compatible line; rebuild and redeploy. Refresh lockfiles only in a separately approved change. Plain client-side React/Preact is not React Server Components.')
  if (evidence.observations.some(item => item.status === 'potentially_vulnerable')) recommendations.unshift('ATTENTION: a collected runtime is below a tracked security floor. Restrict exposure and review a vendor upgrade or verified backport before production use. If previously exposed, investigate compromise and rotate affected secrets after remediation.')
  const limitations = 'Bounded read-only runtime checks are not an exploit test, complete dependency/SBOM scan, vendor-backport verification or proof of the running web worker configuration. Missing/future/prerelease versions remain unknown. Container and Kubernetes coverage must not be inferred from the host CLI.'
  const lines = ['Security recommendations', ...evidence.observations.map(item => `${item.scope}: ${item.name} ${item.version ?? 'unknown'}: ${item.status}${item.fixedVersion ? ` (tracked floor ${item.fixedVersion})` : ''}`), ...(!evidence.observations.length ? ['Runtime patch state: unknown; no supported runtime version was observed.'] : []), ...(!evidence.complete ? ['Runtime collection incomplete or unavailable.'] : []), ...recommendations, limitations]
  return { version: 1, reviewedAt: SECURITY_REVIEW_DATE, application, ...evidence, recommendations, limitations, answer: lines.join('\n') }
}

export function recordApplicationSecurity ({ admin, serverId, task, results, onProgress }) {
  const report = applicationSecurityReport(task.catalogId, results)
  if (!report) return null
  const event = { type: 'security_report', phase: 'security', at: new Date().toISOString(), message: report.answer, report }
  admin.appendTaskProgress(serverId, task.id, event)
  onProgress?.(event)
  return report
}
