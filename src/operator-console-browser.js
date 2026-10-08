/* global document, location, history, fetch, EventSource, URL, Blob */
const byId = id => document.getElementById(id)
let csrf
let selected
let proposal
let replay = []
let stream
const show = (id, value) => { byId(id).textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
async function api (url, body) {
  const response = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Intent-CSRF': csrf ?? '' }, body: JSON.stringify(body) } : {})
  const value = await response.json()
  if (!response.ok) throw new Error(value.error)
  return value
}
function handle (operation) {
  return async () => { try { await operation(); show('message', '') } catch (error) { show('message', error.message) } }
}
async function inspect (hostId, taskId) {
  selected = await api(`/task?host=${encodeURIComponent(hostId)}&task=${taskId}`)
  proposal = null
  byId('approve').hidden = true
  byId('execute-rollback').hidden = true
  show('task', selected)
  show('proposal', '')
}
async function refresh () {
  const snapshot = await api('/snapshot')
  byId('hosts').replaceChildren()
  for (const host of snapshot.hosts) {
    const title = document.createElement('h3')
    title.textContent = host.id
    byId('hosts').append(title)
    for (const task of host.tasks) {
      const button = document.createElement('button')
      button.textContent = `#${task.id} ${task.status}: ${task.request}`
      button.onclick = handle(() => inspect(host.id, task.id))
      byId('hosts').append(button)
    }
  }
  show('clusters', snapshot.clusters)
  byId('runs').replaceChildren()
  for (const run of snapshot.runs) {
    const panel = document.createElement('pre')
    panel.textContent = JSON.stringify(run, null, 2)
    byId('runs').append(panel)
    if (!byId('actions').hidden) {
      const pause = document.createElement('button')
      pause.textContent = `Pause run #${run.id}`
      pause.onclick = handle(() => api('/action', { action: 'pause-run', runId: run.id }))
      byId('runs').append(pause)
      for (const host of run.hosts.filter(host => host.taskId)) {
        const inspectHost = document.createElement('button')
        inspectHost.textContent = `Inspect ${host.serverId}: ${host.status}`
        inspectHost.onclick = handle(() => inspect(host.serverId, host.taskId))
        byId('runs').append(inspectHost)
      }
      const resume = document.createElement('button')
      resume.textContent = `Review selected hosts in run #${run.id}`
      resume.onclick = handle(async () => {
        const hosts = run.hosts.filter(host => host.taskId && host.status !== 'completed' && globalThis.confirm(`Include ${host.serverId} in reviewed continuation?`))
        const decisions = []
        for (const host of hosts) {
          const view = await api(`/task?host=${encodeURIComponent(host.serverId)}&task=${host.taskId}`)
          show('task', view)
          await new Promise(resolve => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)))
          if (!globalThis.confirm(`Approve the remaining plan for ${host.serverId}, as displayed?`)) continue
          decisions.push({ hostId: host.serverId, taskId: host.taskId, expectedVersion: view.stateVersion, fingerprint: view.fingerprint })
        }
        if (decisions.length) await api('/action', { action: 'resume-run', runId: run.id, decisions, approved: true })
      })
      byId('runs').append(resume)
    }
  }
}
async function action (name, extra = {}) {
  if (!selected) throw new Error('select a task first')
  return api('/action', { action: name, hostId: selected.hostId, taskId: selected.task.id, expectedVersion: selected.stateVersion, ...extra })
}
byId('token').value = location.hash.slice(1)
history.replaceState(null, '', '/')
byId('connect').onclick = handle(async () => {
  const session = await api('/session', { token: byId('token').value })
  byId('token').value = ''
  csrf = session.csrf
  byId('login').hidden = true
  byId('main').hidden = false
  byId('actions').hidden = !session.actions
  show('mode', session.actions ? 'Operator actions enabled. Changed commands require explicit review and approval.' : 'Read-only console')
  await refresh()
  stream?.close()
  stream = new EventSource('/events')
  const events = []
  stream.onmessage = message => { events.push(JSON.parse(message.data)); if (events.length > 500) events.shift(); show('events', events) }
})
byId('refresh').onclick = handle(refresh)
for (const button of document.querySelectorAll('[data-action]')) button.onclick = handle(async () => { await action(button.dataset.action); await inspect(selected.hostId, selected.task.id) })
byId('analyze').onclick = handle(async () => show('proposal', await action('analyze', { question: byId('instructions').value })))
byId('propose').onclick = handle(async () => {
  proposal = await action('propose', { instructions: byId('instructions').value, rollback: globalThis.confirm('Propose rollback of confirmed changes? Cancel means revise remaining deployment work.') })
  show('proposal', proposal)
  byId('approve').hidden = false
})
byId('approve').onclick = handle(async () => {
  if (!proposal || !globalThis.confirm('Approve the displayed replacement plan exactly as reviewed?')) return
  await action('approve', { revisionId: proposal.revisionId, expectedVersion: proposal.expectedVersion, fingerprint: proposal.fingerprint, approved: true })
  await inspect(selected.hostId, selected.task.id)
})
byId('resume').onclick = handle(async () => {
  if (!selected || !globalThis.confirm('Resume the displayed plan, skipping verified completed commands?')) return
  await action('resume', { fingerprint: selected.fingerprint, approved: true })
  await refresh()
})
byId('rollback').onclick = handle(async () => {
  if (!selected) throw new Error('select a task first')
  const revision = [...selected.revisions].reverse().find(item => item.approved && item.plan.operatorRollback)
  show('proposal', revision?.plan.commands ?? selected.task.plan.revertCommands)
  byId('execute-rollback').hidden = false
})
byId('execute-rollback').onclick = handle(async () => {
  if (!selected) throw new Error('select a task first')
  const revision = [...selected.revisions].reverse().find(item => item.approved && item.plan.operatorRollback)
  if (!globalThis.confirm('Review the displayed rollback commands. Execute them?')) return
  await action('rollback', { fingerprint: revision ? selected.reviewedRollbackFingerprint : selected.rollbackFingerprint, revisionId: revision?.id, approved: true })
})
byId('reconcile').onclick = handle(async () => { await action('reconcile'); await inspect(selected.hostId, selected.task.id) })
byId('resolve').onclick = handle(async () => {
  if (!selected) throw new Error('select a task first')
  const uncertain = [...selected.commands, ...selected.rollbackCommands].filter(command => command.status === 'uncertain')
  if (!uncertain.length) throw new Error('no uncertain commands')
  const commandId = globalThis.prompt(`Command ID to reconcile: ${uncertain.map(command => command.commandId).join(', ')}`)
  const candidates = uncertain.filter(command => command.commandId === commandId)
  if (candidates.length !== 1) throw new Error('select an unambiguous command ID; use CLI reconciliation for duplicate rollback IDs')
  const status = globalThis.prompt('Independently verified outcome: completed or failed')
  const evidence = globalThis.prompt('Describe authoritative remote evidence. Do not include credentials.')
  if (!globalThis.confirm('Attest this independently verified outcome? This will not rerun the command.')) return
  await action('resolve', { commandId, status, evidence, rollbackRevision: candidates[0].rollbackRevision, approved: true })
  await inspect(selected.hostId, selected.task.id)
})
async function bundle () { return api(`/export?run=${Number(byId('run-id').value)}`) }
byId('replay').onclick = handle(async () => {
  replay = (await bundle()).events
  byId('position').max = Math.max(0, replay.length - 1)
  byId('position').value = 0
  show('replay-event', replay[0] ?? 'No recorded events')
})
byId('position').oninput = () => show('replay-event', replay[Number(byId('position').value)] ?? 'No recorded event')
byId('export').onclick = handle(async () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(await bundle(), null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'intentaiops-diagnostics.json'
  link.click()
  URL.revokeObjectURL(url)
})
