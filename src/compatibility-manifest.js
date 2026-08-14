import { stackProfileIds } from './linux-stack-profiles.js'

const FORMAT = 'webminai-compatibility-manifest'
const VERSION = 1
const ROUTES = new Set(['native', 'compose'])
const STATES = new Set(['resolved', 'requires-preflight', 'unsupported'])
const KNOWN_PROFILES = new Set(stackProfileIds())

export function resolveCompatibilityManifest ({ application, specification, linuxContext, dockerPolicy = {}, repositoryVersions = {}, now = () => new Date() }) {
  validateApplication(application)
  validateSpecification(specification)
  const profiles = linuxContext?.stackProfiles?.profiles
  if (!profiles) throw new TypeError('a Linux context with typed stack profiles is required')

  const candidates = specification.routes
    .filter(route => route.applicationVersions.includes(application.version))
    .filter(route => route.architectures.length === 0 || route.architectures.includes(linuxContext.identity.architecture))
    .map(route => evaluateRoute(route, profiles, dockerPolicy, repositoryVersions))
  const viable = candidates.filter(candidate => candidate.status !== 'unsupported')
  const selected = viable.sort(compareRoute)[0] ?? null
  const status = selected?.status ?? 'unsupported'
  const manifest = {
    format: FORMAT,
    version: VERSION,
    generatedAt: now().toISOString(),
    application: { id: application.id, version: application.version },
    host: {
      fingerprint: linuxContext.fingerprint,
      distribution: linuxContext.identity.id,
      distributionVersion: linuxContext.identity.versionId,
      architecture: linuxContext.identity.architecture,
      family: linuxContext.management.family
    },
    status,
    selectedRoute: selected,
    evaluatedRoutes: candidates,
    reason: selected?.reason ?? 'no compatibility row supports this application, host, and execution policy'
  }
  validateCompatibilityManifest(manifest)
  return manifest
}

export function validateCompatibilityManifest (value) {
  if (value?.format !== FORMAT || value.version !== VERSION || !STATES.has(value.status)) throw new TypeError('invalid compatibility manifest')
  validateApplication(value.application)
  if (!value.host || typeof value.host.fingerprint !== 'string' || typeof value.host.distribution !== 'string') throw new TypeError('invalid compatibility manifest host')
  if (!Array.isArray(value.evaluatedRoutes)) throw new TypeError('compatibility manifest requires evaluated routes')
  for (const route of value.evaluatedRoutes) validateEvaluatedRoute(route)
  if (value.selectedRoute !== null) validateEvaluatedRoute(value.selectedRoute)
  if (value.status === 'unsupported' && value.selectedRoute !== null) throw new TypeError('unsupported compatibility manifest cannot select a route')
  return value
}

function evaluateRoute (route, profiles, dockerPolicy, repositoryVersions) {
  if (route.kind === 'compose' && dockerPolicy.preferred !== true) {
    return evaluated(route, 'unsupported', 'Compose is disabled by host policy', [], [])
  }
  const missingProfiles = route.profiles.filter(id => !profiles[id] || profiles[id].status === 'blocked')
  if (missingProfiles.length) return evaluated(route, 'unsupported', `required profiles are blocked: ${missingProfiles.join(', ')}`, missingProfiles, [])

  const versionChecks = Object.entries(route.components).map(([profileId, constraint]) => {
    const observed = profiles[profileId]?.version ?? repositoryVersions[profileId] ?? null
    return {
      profileId,
      allowedVersions: [...constraint.allowedVersions],
      selectedVersion: observed,
      source: profiles[profileId]?.version ? 'installed' : repositoryVersions[profileId] ? 'repository' : null,
      status: observed === null ? 'unknown' : versionAllowed(observed, constraint.allowedVersions) ? 'supported' : 'unsupported'
    }
  })
  const incompatible = versionChecks.filter(check => check.status === 'unsupported')
  if (incompatible.length) {
    return evaluated(route, 'unsupported', `unsupported component versions: ${incompatible.map(check => `${check.profileId}=${check.selectedVersion}`).join(', ')}`, [], versionChecks)
  }
  const unknown = versionChecks.filter(check => check.status === 'unknown')
  if (unknown.length) {
    return evaluated(route, 'requires-preflight', `repository version preflight required for: ${unknown.map(check => check.profileId).join(', ')}`, [], versionChecks)
  }
  return evaluated(route, 'resolved', 'all required profiles and component versions match an explicit compatibility row', [], versionChecks)
}

function evaluated (route, status, reason, missingProfiles, components) {
  return {
    id: route.id,
    kind: route.kind,
    priority: route.priority,
    status,
    reason,
    requiredProfiles: [...route.profiles],
    missingProfiles,
    components
  }
}

function compareRoute (left, right) {
  const rank = { resolved: 0, 'requires-preflight': 1, unsupported: 2 }
  return rank[left.status] - rank[right.status] || left.priority - right.priority || left.id.localeCompare(right.id)
}

function versionAllowed (observed, allowed) {
  const normalized = normalizeVersion(observed)
  return allowed.some(value => normalized === normalizeVersion(value) || normalized.startsWith(`${normalizeVersion(value)}.`))
}

function normalizeVersion (value) {
  const match = String(value).match(/\d+(?:\.\d+){0,3}/u)
  return match?.[0] ?? ''
}

function validateApplication (application) {
  if (!application || !safeId(application.id) || !safeVersion(application.version)) throw new TypeError('application id and version are required')
}

function validateSpecification (specification) {
  if (!specification || specification.version !== 1 || !Array.isArray(specification.routes) || specification.routes.length === 0) throw new TypeError('compatibility specification requires version 1 routes')
  const ids = new Set()
  for (const route of specification.routes) {
    if (!safeId(route?.id) || ids.has(route.id) || !ROUTES.has(route.kind)) throw new TypeError('invalid compatibility route')
    ids.add(route.id)
    if (!Number.isInteger(route.priority) || route.priority < 0 || !Array.isArray(route.applicationVersions) || !route.applicationVersions.every(safeVersion)) throw new TypeError(`invalid compatibility route metadata: ${route.id}`)
    if (!Array.isArray(route.architectures) || !route.architectures.every(safeArchitecture)) throw new TypeError(`invalid compatibility route architectures: ${route.id}`)
    if (!Array.isArray(route.profiles) || route.profiles.some(id => !KNOWN_PROFILES.has(id)) || new Set(route.profiles).size !== route.profiles.length) throw new TypeError(`invalid compatibility route profiles: ${route.id}`)
    if (!route.components || typeof route.components !== 'object' || Array.isArray(route.components)) throw new TypeError(`invalid compatibility route components: ${route.id}`)
    for (const [profileId, constraint] of Object.entries(route.components)) {
      if (!route.profiles.includes(profileId) || !Array.isArray(constraint.allowedVersions) || constraint.allowedVersions.length === 0 || !constraint.allowedVersions.every(safeVersion)) throw new TypeError(`invalid compatibility component constraint: ${route.id}/${profileId}`)
    }
  }
}

function validateEvaluatedRoute (route) {
  if (!safeId(route?.id) || !ROUTES.has(route.kind) || !STATES.has(route.status) || typeof route.reason !== 'string') throw new TypeError('invalid evaluated compatibility route')
  if (!Array.isArray(route.requiredProfiles) || !Array.isArray(route.missingProfiles) || !Array.isArray(route.components)) throw new TypeError('invalid evaluated compatibility route details')
}

function safeId (value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,62}$/u.test(value)
}

function safeVersion (value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/u.test(value)
}

function safeArchitecture (value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,32}$/u.test(value)
}
