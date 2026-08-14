const ALLOWED_FORWARD_PHASES = new Set(['configure', 'initialize', 'verify'])
const ALLOWED_REVERT_PHASES = new Set(['configure', 'cleanup', 'verify'])
const FOUNDATION_COMMAND = /\b(?:apt(?:-get)?|dnf|yum|apk|pacman|zypper)\b|\b(?:systemctl|rc-service|service)\b|\bopenssl\s+rand\b|\b(?:CREATE\s+(?:DATABASE|USER|ROLE)|GRANT\s+ALL|ALTER\s+USER)\b/iu

export function validateApplicationDeltaPlan (plan) {
  if (!plan || !Array.isArray(plan.commands) || !Array.isArray(plan.revertCommands)) throw new TypeError('application delta requires command arrays')
  for (const item of plan.commands) validateItem(item, ALLOWED_FORWARD_PHASES)
  for (const item of plan.revertCommands) validateItem(item, ALLOWED_REVERT_PHASES)
  return plan
}

export function deploymentBlueprint ({ manifest, foundationPhases, foundationPaths = [] }) {
  if (manifest?.status !== 'resolved' || !manifest.selectedRoute) throw new Error('application delta requires a resolved compatibility manifest')
  if (!Array.isArray(foundationPhases) || foundationPhases.length === 0 || !Array.isArray(foundationPaths)) throw new TypeError('application delta requires a reviewed foundation contract')
  return {
    format: 'webminai-application-delta-blueprint',
    version: 1,
    application: manifest.application,
    compatibility: {
      route: manifest.selectedRoute.id,
      kind: manifest.selectedRoute.kind,
      components: manifest.selectedRoute.components
    },
    foundationPhases: [...foundationPhases],
    foundationPaths: [...foundationPaths],
    allowedForwardPhases: [...ALLOWED_FORWARD_PHASES],
    allowedRevertPhases: [...ALLOWED_REVERT_PHASES]
  }
}

function validateItem (item, phases) {
  if (!phases.has(item.phase)) throw new Error(`application delta command ${item.id} uses foundation-owned phase ${item.phase ?? 'unlabelled'}`)
  if (FOUNDATION_COMMAND.test(item.command)) throw new Error(`application delta command ${item.id} attempts a foundation-owned package, secret, database, or service operation`)
}
