import { buildCommonTask, commonTaskEligibility, listCommonTasks, buildCandidatePlanningContext } from './common-tasks.js'
import { detectOperationLoop } from './operation-loop-detector.js'

export async function prepareTask ({ admin, settings, passphrase, serverId, request, catalogId = null, consultation = false, retryOfTaskId = null, retryInstructions = null, groupRunId = null, onProgress = () => {} }) {
  if (typeof request !== 'string' || !request.trim() || request.length > 128 * 1024) throw new Error('Request must contain 1-131072 characters')
  const connection = { settings, passphrase, serverId }
  const emit = event => onProgress({ ...event, serverId })
  if (consultation) {
    if (catalogId || retryOfTaskId) throw new Error('Consultation cannot select executable work')
    const consultationContext = admin.listPendingConsultations(serverId)
    const task = admin.createTask(serverId, '? ' + request, { kind: 'consultation', consultationIds: consultationContext.map(item => item.id), consumeConsultations: false })
    try {
      const result = await admin.consult({ ...connection, question: request, consultationContext, onProgress: event => { admin.appendTaskProgress(serverId, task.id, event); emit(event) } })
      admin.saveConsultation(serverId, task.id, result)
      return { hostId: serverId, taskId: task.id, consultation: result }
    } catch (error) { admin.saveTaskError(serverId, task.id, error); throw error }
  }
  const capabilities = await admin.capabilities(connection)
  const inventory = await admin.refreshInventory(connection)
  const platform = capabilities.platform?.os
  const applicationDefaults = await admin.settings.decryptApplicationDefaults(connection)
  const options = { platform, linuxContext: inventory.webminaiLinuxContext, windowsExecution: inventory.webminaiExecution, freebsdExecution: inventory.webminaiExecution, macosExecution: inventory.webminaiExecution, docker: inventory.webminaiDocker, applicationDefaults }
  const previousAttempts = retryOfTaskId ? admin.getTaskRetryHistory(serverId, retryOfTaskId) : []
  if (retryOfTaskId) {
    const source = admin.getTask(serverId, retryOfTaskId)
    if (source.results?.length && !admin.tasks.executionEvents(serverId, retryOfTaskId).length) throw new Error('Legacy executed history requires operator investigation before retry preparation')
  }
  if (retryOfTaskId && admin.tasks.executionState(serverId, retryOfTaskId).some(command => command.status === 'uncertain')) throw new Error('Reconcile uncertain work before preparing a retry')
  const loop = detectOperationLoop(previousAttempts, settings.operationLoop)
  if (loop.detected && !retryInstructions?.trim()) throw new Error(`${loop.reason}; alternative instructions required`)
  let routing = { decision: catalogId ? 'verified_task' : 'ordinary_planning', catalogId, relevantCatalogIds: catalogId ? [catalogId] : [], foundationIds: [], foundationMode: 'none' }
  if (!catalogId && !retryOfTaskId) {
    try { routing = await admin.routeTask({ ...connection, request, inventory, candidates: listCommonTasks(options).filter(task => task.category !== 'system' && commonTaskEligibility(task.id, options).eligible), onProgress: emit }) } catch { emit({ type: 'routing_unavailable', message: 'Routing unavailable; ordinary validated planning continues' }) }
  }
  catalogId = routing.decision === 'verified_task' ? routing.catalogId : null
  if (catalogId && !commonTaskEligibility(catalogId, options).eligible) throw new Error('Common task is not eligible for this host')
  const consultationContext = catalogId ? [] : retryOfTaskId ? admin.getTaskConsultations(serverId, retryOfTaskId) : admin.listPendingConsultations(serverId)
  const task = admin.createTask(serverId, request, { kind: catalogId ? 'catalog' : 'ai', catalogId, retryOfTaskId, retryInstructions, groupRunId, consultationIds: consultationContext.map(item => item.id), consumeConsultations: !retryOfTaskId })
  try {
    const plan = catalogId ? buildCommonTask(catalogId, task.id, options).plan : await admin.plan({ ...connection, request, taskId: task.id, inventory, previousAttempts, retryInstructions, consultationContext, applicationDefaults, candidateContext: buildCandidatePlanningContext(routing.relevantCatalogIds, task.id, { ...options, foundationIds: routing.foundationIds, foundationMode: routing.foundationMode ?? 'context-only' }), onProgress: event => { admin.appendTaskProgress(serverId, task.id, event); emit(event) } })
    admin.saveTaskPlan(serverId, task.id, plan, catalogId && settings.servers[serverId].hostFingerprint ? { catalogId, options, target: settings.servers[serverId].hostFingerprint } : undefined)
    return { taskId: task.id, hostId: serverId, awaitingReview: true, inventory, routing }
  } catch (error) { admin.saveTaskError(serverId, task.id, error); throw error }
}
