export function catalogChoiceRows (definitions) {
  return definitions.map(definition => ({
    value: definition,
    label: definition.label,
    description: definition.description,
    catalogId: definition.id,
    searchText: [definition.label, definition.description, definition.id].filter(Boolean).join(' ')
  }))
}

export function taskHistoryRows (tasks) {
  return tasks.map(task => ({
    value: task.id,
    task,
    label: taskHistoryLabel(task),
    searchText: [
      task.id,
      task.status,
      task.kind,
      task.catalogId,
      task.request,
      task.retryOfTaskId,
      task.groupRunId
    ].filter(value => value !== null && value !== undefined).join(' ')
  }))
}

export function taskHistoryRowText (row, { width = 70 } = {}) {
  const task = row.task
  const id = `#${task.id}`.padEnd(7)
  const status = String(task.status ?? '').padEnd(13)
  const kind = String(task.catalogId ? `catalog:${task.catalogId}` : task.kind ?? '').padEnd(18)
  return truncate(`${id}${status}${kind}${oneLine(task.request)}`, width)
}

export function taskDetailLines (task) {
  if (!task) return ['Select a task to view details.']
  return [
    `Task: #${task.id}`,
    `Status: ${task.status}`,
    `Kind: ${task.kind}`,
    ...(task.catalogId ? [`Common task: ${task.catalogId}`] : []),
    ...(task.retryOfTaskId ? [`Retry of: #${task.retryOfTaskId}`] : []),
    ...(task.groupRunId ? [`Multi-host run: #${task.groupRunId}`] : []),
    `Request: ${task.request}`,
    ...(task.changeOverview ? [`Overview: ${task.changeOverview}`] : [])
  ]
}

export function taskHistoryActions (task, { catalogTask = false } = {}) {
  const actions = []
  if (task.kind === 'ai') {
    actions.push({ label: 'Retry with automatic corrections from history', value: 'retry' })
    actions.push({ label: 'Retry with additional correction instructions', value: 'retry-extra' })
    actions.push({ label: 'Edit request as a separate AI task', value: 'reuse' })
  } else if (task.kind === 'consultation') {
    actions.push({ label: 'Ask this consultation again', value: 'reuse' })
  } else if (catalogTask) {
    actions.push({ label: 'Run this verified common task again', value: 'reuse' })
  } else {
    actions.push({ label: 'Use description as a new AI task', value: 'reuse' })
  }
  if (task.plan?.revertCommands?.length > 0 && task.status !== 'reverted') {
    actions.push({ label: 'Run the saved revert plan', value: 'revert', style: 'warning' })
  }
  actions.push({ label: 'Back', value: 'back' })
  return actions
}

export function multiHostHistoryRows (runs) {
  return runs.map(run => ({
    value: run.id,
    run,
    label: multiHostHistoryLabel(run),
    searchText: [
      run.id,
      run.status,
      run.request,
      run.catalogId,
      run.retryOfRunId,
      ...run.hosts.map(host => host.serverId)
    ].filter(value => value !== null && value !== undefined).join(' ')
  }))
}

export function multiHostHistoryRowText (row, { width = 70 } = {}) {
  const run = row.run
  return truncate(`${`#${run.id}`.padEnd(7)}${String(run.status).padEnd(15)}${String(run.hosts.length).padStart(2)} hosts  ${oneLine(run.request)}`, width)
}

export function multiHostRunDetailLines (run) {
  if (!run) return ['Select a run to view details.']
  return [
    `Run: #${run.id}`,
    `Status: ${run.status}`,
    `Kind: ${run.catalogId ? `catalog:${run.catalogId}` : run.kind}`,
    ...(run.retryOfRunId ? [`Retry of: #${run.retryOfRunId}`] : []),
    `Hosts: ${run.hosts.map(host => host.serverId).join(', ')}`,
    `Request: ${run.request}`
  ]
}

export function multiHostHistoryActions (run) {
  const actions = [
    { label: 'Retry failed hosts only', value: 'retry-failed' },
    { label: 'Retry selected hosts', value: 'retry-selected' }
  ]
  if (run.kind === 'ai') actions.push({ label: 'Retry selected hosts with correction instructions', value: 'retry-extra' })
  if (run.hosts.some(host => host.taskId && host.status !== 'reverted')) actions.push({ label: 'Revert selected hosts', value: 'revert', style: 'warning' })
  actions.push({ label: 'Back', value: 'back' })
  return actions
}

export function failedMultiHostIds (run) {
  return run.hosts.filter(host => ['failed', 'partial', 'revert_failed'].includes(host.status)).map(host => host.serverId)
}

export function cleanupHostIds (run, selectedHosts) {
  return selectedHosts.filter(serverId => {
    const host = run.hosts.find(item => item.serverId === serverId)
    return host?.taskId && !['reverted', 'cancelled'].includes(host.status)
  })
}

export function retryCleanupSucceeded (run, serverIds) {
  return serverIds.every(serverId => run.hosts.find(host => host.serverId === serverId)?.status === 'reverted')
}

export function routingSummaryRows (serverIds, planningHints) {
  return serverIds.map(serverId => {
    const routing = planningHints[serverId]?.routing
    return {
      serverId,
      decision: routing?.decision?.replaceAll('_', ' ') ?? 'ordinary planning',
      context: routing?.catalogId ?? routing?.relevantCatalogIds?.join(', ') ?? '-',
      rationale: routing?.rationale ?? 'Candidate routing was unavailable.'
    }
  })
}

export function taskHistoryLabel (task) {
  const request = oneLine(task.request)
  const summary = request.length > 64 ? `${request.slice(0, 61)}...` : request
  const retry = task.retryOfTaskId ? ` retry-of:#${task.retryOfTaskId}` : ''
  const group = task.groupRunId ? ` group:#${task.groupRunId}` : ''
  const kind = task.kind === 'consultation' ? ' consultation' : ''
  return `#${task.id} [${task.status}]${kind}${retry}${group} ${summary}`
}

export function multiHostHistoryLabel (run) {
  return `#${run.id} [${run.status}] ${run.hosts.length} hosts · ${oneLine(run.request).slice(0, 52)}`
}

function oneLine (value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim()
}

function truncate (value, width) {
  const characters = Array.from(String(value ?? ''))
  if (characters.length <= width) return characters.join('')
  if (width < 2) return '…'.slice(0, Math.max(0, width))
  return `${characters.slice(0, width - 1).join('')}…`
}
