import { readFileSync } from 'node:fs'
import { listCommonTasks } from './common-tasks.js'
import { listKubernetesCommonTasks } from './kubernetes-common-task-catalog.js'
import { assessRuntimeVersion, securityApplication, SECURITY_REVIEW_DATE } from './software-security.js'

const repositories = {
  wordpress: 'WordPress/wordpress-develop', woocommerce: 'woocommerce/woocommerce', joomla: 'joomla/joomla-cms', drupal: 'drupal/drupal', prestashop: 'PrestaShop/PrestaShop', moodle: 'moodle/moodle', magento: 'magento/magento2', n8n: 'n8n-io/n8n', ghost: 'TryGhost/Ghost', mattermost: 'mattermost/mattermost', odoo: 'odoo/odoo', jellyfin: 'jellyfin/jellyfin', 'home-assistant': 'home-assistant/core', nextcloud: 'nextcloud/server', 'intent-ai-ops': 'cryptofuture/intentaiops', docker: 'moby/moby', 'docker-desktop': 'docker/for-win', podman: 'containers/podman', colima: 'abiosoft/colima', brave: 'brave/brave-browser'
}
const packageNames = { wordpress: ['wordpress'], woocommerce: ['woocommerce'], joomla: ['joomla/joomla-cms'], drupal: ['drupal/core'], prestashop: ['prestashop/prestashop'], magento: ['magento/product-community-edition'], n8n: ['n8n'], ghost: ['ghost'], 'home-assistant': ['homeassistant'] }

export function matchesAdvisoryRange (version, range) {
  const parse = value => /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-p(\d{1,4}))?$/u.exec(value)?.slice(1).map(value => Number(value ?? 0))
  const current = parse(version)
  if (!current || typeof range !== 'string' || range.length > 256) return null
  const parts = range.split(',').map(part => /^(<=|>=|<|>|=)?\s*(v?\d+\.\d+\.\d+(?:-p\d+)?)$/u.exec(part.trim()))
  if (!parts.length || parts.length > 4 || parts.some(part => !part)) return null
  return parts.every(part => {
    const required = parse(part[2])
    if (!required) return false
    const index = current.findIndex((value, index) => value !== required[index])
    const difference = index < 0 ? 0 : Math.sign(current[index] - required[index])
    return ({ '<': difference < 0, '<=': difference <= 0, '>': difference > 0, '>=': difference >= 0, '=': difference === 0 })[part[1] ?? '=']
  })
}

export function catalogSecurityInventory () {
  const shared = new Map(listKubernetesCommonTasks().map(task => [task.applicationId, task]))
  const catalog = ['linux', 'freebsd', 'macos', 'windows'].flatMap(platform => listCommonTasks({ platform, category: 'application' }).map(task => ({ ...task, platform })))
  catalog.push(...listKubernetesCommonTasks())
  return catalog.map(task => {
    const application = securityApplication(task.id)
    const release = shared.get(application)
    const candidates = [...new Set([
      `${task.platform}-${application}-task.js`, `${task.platform}-${application}-compose-task.js`, `${application}-task.js`,
      ...(application === 'wordpress' ? ['wordpress-linux-task.js', 'wordpress-compose-task.js'] : []),
      ...(application === 'intent-ai-ops' ? ['intent-ai-ops-install-task.js'] : []),
      ...(application === 'docker' ? ['linux-docker-bootstrap-task.js'] : []),
      ...(application === 'docker-desktop' ? ['windows-docker-bootstrap-task.js'] : []),
      ...(task.platform === 'macos' ? ['macos-compose-task.js'] : [])
    ])]
    const sources = []
    const pins = new Set([release?.version, ...(release?.images ?? []), task.version, ...(task.images ?? [])].filter(Boolean))
    for (const file of candidates) {
      try {
        const source = readFileSync(new URL('./' + file, import.meta.url), 'utf8')
        sources.push('src/' + file)
        for (const match of source.matchAll(/const [A-Z_]*(?:VERSION|IMAGE) = ['"]([^'"\r\n]{1,256})['"]/gu)) pins.add(match[1])
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const php = [...pins].flatMap(pin => {
      const version = /^php:(\d+\.\d+\.\d+)(?:[-@]|$)/u.exec(pin)?.[1]
      return version ? [{ image: pin, ...assessRuntimeVersion('php', version) }] : []
    })
    return { catalogId: task.id, platform: task.platform, application, sources, declaredPins: [...pins].sort(), php, verdict: 'needs_validation', severity: null, unresolved: 'Selected-route build, installed/transitive packages, vendor backports and active runtime configuration require evidence; public source pins are not an installed SBOM.', repository: repositories[application] ?? null }
  })
}

async function githubJson (endpoint, fetchImpl) {
  const response = await fetchImpl('https://api.github.com/' + endpoint, { redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Intent-AI-Ops-security-audit' } })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub returned ${response.status}`) }
  const chunks = []
  let length = 0
  for await (const chunk of response.body) {
    length += chunk.length
    if (length > 2 * 1024 * 1024) throw new Error('Public advisory response exceeds limit')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function auditCatalogSecurity ({ online = false, fetchImpl = fetch } = {}) {
  const rows = catalogSecurityInventory()
  const vendors = new Map()
  if (online) {
    for (const repository of new Set(rows.map(row => row.repository).filter(Boolean))) {
      const result = { repository, release: null, advisories: null, ranges: [], errors: [] }
      try {
        const release = await githubJson(`repos/${repository}/releases/latest`, fetchImpl)
        if (release.prerelease || release.draft || typeof release.tag_name !== 'string' || !/^[A-Za-z0-9_.+@/-]{1,100}$/u.test(release.tag_name) || /alpha|beta|canary|(?:^|[-.])rc\d/iu.test(release.tag_name)) throw new Error('Vendor release is not a recognized stable release')
        result.release = release.tag_name
      } catch (error) { result.errors.push(String(error.message).slice(0, 100)) }
      try {
        const advisories = await githubJson(`repos/${repository}/security-advisories?state=published&per_page=100`, fetchImpl)
        if (!Array.isArray(advisories) || advisories.length > 100) throw new Error('Invalid public advisory listing')
        result.advisories = advisories.filter(item => /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/u.test(item.ghsa_id)).map(item => item.ghsa_id)
        for (const advisory of advisories) {
          if (!result.advisories.includes(advisory.ghsa_id)) continue
          for (const item of (Array.isArray(advisory.vulnerabilities) ? advisory.vulnerabilities : []).slice(0, 50)) {
            if (typeof item.package?.name === 'string' && Object.values(packageNames).some(names => names.includes(item.package.name)) && typeof item.vulnerable_version_range === 'string' && item.vulnerable_version_range.length <= 256) result.ranges.push({ advisory: advisory.ghsa_id, package: item.package.name, range: item.vulnerable_version_range })
          }
        }
        if (advisories.length === 100) result.errors.push('Advisory listing truncated; further pages not inspected')
      } catch (error) { result.errors.push(String(error.message).slice(0, 100)) }
      vendors.set(repository, result)
    }
  }
  const entries = rows.map(row => {
    const vendor = vendors.get(row.repository) ?? null
    const findings = (vendor?.ranges ?? []).filter(item => packageNames[row.application]?.includes(item.package)).flatMap(item => row.declaredPins.filter(pin => matchesAdvisoryRange(pin, item.range) === true).map(version => ({ ...item, declaredVersion: version, verdict: 'needs_validation', severity: null, unresolved: 'Source pin matches a publisher range; confirm selected artifact, installed build and applicability before treating this as an affected deployment.' })))
    return { ...row, vendor, findings }
  })
  return { version: 1, observedAt: new Date().toISOString(), rulesReviewedAt: SECURITY_REVIEW_DATE, online, coverage: { platforms: [...new Set(rows.map(row => row.platform))], catalogEntries: rows.length, scope: 'Public catalog source/release review, not a live fleet security certification' }, entries, limitations: ['Published advisories are candidates, not confirmed affected findings. No absence-of-vulnerabilities conclusion is inferred from missing, failed, empty or truncated feeds. Unsupported version ranges remain unresolved.', 'No exploit, source patch, package installation, skill installation, remote command or approval is performed by this audit.', 'Cloudflare-inspired coverage and evidence separation is used; this is not its full multi-agent source-boundary audit or independent verification workflow.'] }
}
