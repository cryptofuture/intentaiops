import { randomBytes } from 'node:crypto'
import { planFingerprint } from './execution-journal.js'

export function regenerateCatalogRevision (task, execution, trusted) {
  if (task.kind !== 'catalog' || !task.catalogId || task.plan?.operatorRollback) throw new Error('A local common-task deployment is required')
  if (execution.some(command => command.status === 'uncertain')) throw new Error('Reconcile uncertain commands before refreshing catalog work')
  if (planFingerprint(rollbackDefinitions(task.plan.revertCommands)) !== planFingerprint(rollbackDefinitions(trusted.revertCommands))) throw new Error('Catalog rollback changed; separately reviewed investigation is required')
  const originalManifest = task.plan.compatibilityManifest
  const currentManifest = trusted.compatibilityManifest
  if (originalManifest?.selectedRoute?.id !== currentManifest?.selectedRoute?.id || originalManifest?.application?.id !== currentManifest?.application?.id || originalManifest?.application?.version !== currentManifest?.application?.version) throw new Error('Catalog version or execution route changed; separately reviewed investigation is required')
  for (const field of ['distribution', 'distributionVersion', 'architecture', 'family']) {
    if (originalManifest?.host?.[field] !== currentManifest?.host?.[field]) throw new Error('Catalog host compatibility changed')
  }
  const completedIds = new Set(execution.filter(command => command.status === 'completed').map(command => command.commandId))
  const completed = task.plan.commands.filter(command => completedIds.has(command.id))
  const replacements = new Map()
  for (const command of completed) {
    const matches = trusted.commands.filter(candidate => planFingerprint(executionDefinition(candidate)) === planFingerprint(executionDefinition(command)))
    if (matches.length !== 1 || replacements.has(matches[0].id)) throw new Error('Completed commands cannot be reproduced uniquely by the current catalog')
    replacements.set(matches[0].id, command.id)
  }
  for (const command of trusted.commands.filter(command => replacements.has(command.id))) {
    if (command.dependsOn.some(id => !replacements.has(id))) throw new Error('Completed catalog dependencies are not confirmed')
  }
  const pending = trusted.commands.filter(command => !replacements.has(command.id))
  if (!pending.length) throw new Error('No remaining catalog work')
  for (const command of pending) replacements.set(command.id, `${command.id.slice(0, 40)}-catalog-${randomBytes(6).toString('hex')}`)
  return {
    ...trusted,
    summary: `Refresh remaining ${task.catalogId} catalog steps`,
    modifiedFiles: [...new Set([...task.plan.modifiedFiles, ...trusted.modifiedFiles])],
    warnings: [...(trusted.warnings ?? []), 'Confirmed failures can leave partial changes. Review this new plan against current state. Approval does not resume execution. This is not fresh-install verified recovery.'],
    commands: [...completed, ...pending.map(command => ({ ...command, id: replacements.get(command.id), dependsOn: command.dependsOn.map(id => replacements.get(id)) }))],
    revertCommands: task.plan.revertCommands,
    operatorRollback: false
  }
}

function executionDefinition (command) {
  return { command: command.command, risk: command.risk, timeoutMs: command.timeoutMs, requiresSudo: command.requiresSudo, executionMode: command.executionMode ?? null, phase: command.phase ?? null, diagnostic: command.diagnostic ?? null, retry: command.retry ?? null }
}

function rollbackDefinitions (commands) {
  return commands.map(command => ({ ...executionDefinition(command), id: command.id, dependsOn: command.dependsOn ?? [] }))
}
