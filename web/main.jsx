import { render } from 'preact'
import { Activity as ActivityIcon, LayoutDashboard, Network, Palette, Plus, Settings as SettingsIcon, Star, TriangleAlert, X } from 'lucide-preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { applyTheme, palettes, resolveTheme, selectTheme } from './themes/index.js'
import './workspace.css'
import logo from '../public/logo.png'
import { ansiSegments } from './ansi.js'
import { BrowserShell } from './shell.jsx'
import { ClusterWorkspace } from './cluster-workspace.jsx'

const { matchMedia, confirm, location, history, EventSource, MutationObserver } = window
const mount = location.pathname.startsWith('/workspace/') ? location.pathname.replace(/\/$/u, '') : ''

const media = matchMedia('(prefers-color-scheme: dark)')
const uuid = () => crypto.randomUUID()
function Badge ({ status = 'unknown' }) { return <span class={'badge status-' + status}>{status.replaceAll('_', ' ')}</span> }
function Button ({ children, primary, danger, icon: Icon = danger ? TriangleAlert : null, ...props }) { return <button class={primary ? /^(Review|Approve|Execute)/u.test(String(children)) ? 'primary approval' : 'primary' : danger ? 'danger' : ''} {...props}>{Icon && <Icon size={16} aria-hidden='true' focusable='false' />}{children}</button> }
function Card ({ title, children, ...props }) { return <section class='card' {...props}>{title && <h3>{title}</h3>}{children}</section> }
function Empty ({ children }) { return <div class='empty'>{children}</div> }
function Data ({ value }) { return <pre class='output'>{JSON.stringify(value, null, 2)}</pre> }
function Output ({ value }) { return <pre class='output'>{ansiSegments(value).map((segment, index) => <span key={index} style={{ color: segment.foreground, background: segment.background, fontWeight: segment.bold ? 600 : undefined }}>{segment.text}</span>)}</pre> }
function Modal ({ title, children, close }) { return <div class='scrim' onKeyDown={e => { if (e.key === 'Escape') close() }}><section class='dialog' role='dialog' aria-modal='true' aria-label={title}><header><h2>{title}</h2><Button onClick={close} aria-label='Close dialog' icon={X} /></header>{children}</section></div> }

function ThemePicker ({ preference, preview, commit, close }) {
  const [query, search] = useState('')
  const [selected, select] = useState(resolveTheme(preference, media.matches).id)
  const [draft, setDraft] = useState(preference)
  const choices = palettes.filter(p => `${p.name} ${p.id}`.toLowerCase().includes(query.toLowerCase()))
  const choose = p => { select(p.id); const value = selectTheme(preference, p.id, media.matches); setDraft(value); preview(value) }
  return (
    <Modal title='Appearance · 27 palettes' close={close}>
      <p>Preview locally. Enter confirms once; Escape discards your preview.</p>
      <input
        autoFocus placeholder='Search palettes…' value={query} onInput={e => search(e.target.value)} onKeyDown={e => {
          if (choices.length && ['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); const index = choices.findIndex(p => p.id === selected); choose(choices[(index + (e.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length]) }
          if (e.key === 'Enter') { e.preventDefault(); commit(draft) }
        }}
      />
      <div class='theme-grid'>{choices.map(p => (
        <button key={p.id} class={p.id === selected ? 'theme selected' : 'theme'} onClick={() => choose(p)} onDblClick={() => commit(selectTheme(preference, p.id, media.matches))} aria-pressed={p.id === selected}>
          <span class='swatches'>{['sidebar', 'canvas', 'surface', 'accent', 'accent2'].map(role => <i key={role} style={{ background: p[role] }} />)}</span><strong>{p.name}</strong><small>{p.dark ? 'Dark' : 'Light'}{p.system_fonts ? ' · System fonts' : ''}</small>
        </button>
      ))}
      </div><footer><Button onClick={close}>Cancel</Button><Button primary onClick={() => commit(draft)}>Use selected palette</Button></footer>
    </Modal>
  )
}

function Composer ({ hosts, initialHost, api, submit, close, actions }) {
  const [selected, setSelected] = useState(initialHost ? [initialHost] : [])
  const [request, setRequest] = useState('')
  const [kind, setKind] = useState('ai')
  const [catalog, setCatalog] = useState([])
  const [catalogId, setCatalogId] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { let active = true; setCatalog([]); if (selected.length === 1) api('/catalog?host=' + encodeURIComponent(selected[0])).then(value => { if (active) setCatalog(value) }).catch(e => { if (active) setError(e.message) }); return () => { active = false } }, [selected.join('|')])
  return (
    <Modal title='Prepare a task' close={close}><p>Preparation saves a plan. No command runs until you review and approve it.</p>
      <fieldset><legend>Explicit target selection</legend>{hosts.map(host => <label class='check' key={host.id}><input type='checkbox' checked={selected.includes(host.id)} onChange={e => setSelected(e.target.checked ? [...selected, host.id] : selected.filter(id => id !== host.id))} />{host.id}</label>)}</fieldset>
      <label>Task type<select value={kind} onChange={e => setKind(e.target.value)}><option value='ai'>Natural-language task</option><option value='consultation'>Read-only consultation</option><option value='catalog'>Verified common task</option></select></label>
      {kind === 'catalog' && <label>Eligible task (select one host to discover)<select value={catalogId} onChange={e => { setCatalogId(e.target.value); setRequest(catalog.find(t => t.id === e.target.value)?.label ?? '') }}><option value=''>Choose a task</option>{catalog.map(task => <option key={task.id} value={task.id} disabled={!task.eligible}>{task.label}{!task.eligible ? ' · ' + task.reason : ''}</option>)}</select></label>}
      <label>{kind === 'consultation' ? 'Question' : 'Request'}<textarea rows={5} value={request} onInput={e => setRequest(e.target.value)} placeholder='Describe the intended outcome, constraints and verification…' /></label>
      {error && <p role='alert'>{error}</p>}<footer><Button onClick={close}>Cancel</Button><Button primary disabled={!actions || !selected.length || !request.trim() || (kind === 'catalog' && !catalogId) || (kind === 'consultation' && selected.length !== 1)} onClick={() => submit({ action: 'prepare', serverIds: selected, request, ...(kind === 'catalog' ? { catalogId } : {}), consultation: kind === 'consultation' }).then(close).catch(e => setError(e.message))}>Prepare for review</Button></footer>
    </Modal>
  )
}

function RecordedResults ({ hostId, taskId, api, refresh, diagnostics }) {
  const [page, setPage] = useState({ items: [], nextCursor: null })
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    api(`/task-results?host=${encodeURIComponent(hostId)}&task=${taskId}`).then(value => { if (live) setPage(value) }).catch(e => { if (live) setError(e.message) })
    return () => { live = false }
  }, [hostId, taskId, refresh])
  const more = () => api(`/task-results?host=${encodeURIComponent(hostId)}&task=${taskId}&after=${page.nextCursor}`).then(next => setPage({ ...next, items: [...page.items, ...next.items].slice(-1000) })).catch(e => setError(e.message))
  return <Card title='Recorded results and diagnostic evidence'><p>Raw stdout/stderr stay private. These are recorded process outcomes, not an interactive terminal.</p>{error && <p role='alert'>{error}</p>}{page.items.map(result => <details key={result.id}><summary>{result.id} · {result.status} · exit {result.result?.exitCode ?? 'unknown'} · {result.durationMs ?? 'unknown'}ms</summary><Data value={result} /></details>)}{page.nextCursor !== null && <Button onClick={more}>Load next result page</Button>}<Data value={diagnostics} /></Card>
}

function TaskPane ({ hostId, taskId, width, height, active, onResize, api, submit, actions, close, refresh }) {
  const element = useRef(null)
  const [view, setView] = useState(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('plan')
  const [selected, setSelected] = useState(null)
  const [instructions, setInstructions] = useState('')
  const [proposal, setProposal] = useState(null)
  const load = () => api(`/task?host=${encodeURIComponent(hostId)}&task=${taskId}&projection=review`).then(setView).catch(e => setError(e.message))
  useEffect(() => { load() }, [hostId, taskId, refresh])
  useEffect(() => {
    if (!active || !view || !element.current) return
    const pane = element.current
    const container = pane.parentElement
    const observer = new MutationObserver(() => focus())
    const focus = () => {
      pane.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      if ([...container.children].every(child => child.classList.contains('task-pane'))) observer.disconnect()
    }
    observer.observe(container, { childList: true, subtree: true })
    focus()
    return () => observer.disconnect()
  }, [active, Boolean(view)])
  if (!view) return <Card title={`${hostId} / #${taskId}`}>{error || 'Loading persisted task…'}</Card>
  const decision = { hostId, taskId, expectedVersion: view.stateVersion, fingerprint: view.fingerprint }
  const act = (action, extra = {}) => submit({ action, ...decision, ...extra }).catch(e => setError(e.message))
  const approve = (action, extra = {}) => { if (confirm('Execute only this reviewed decision? Pause/abort affect the next command boundary, not an in-flight command.')) act(action, { ...extra, approved: true }) }
  const plan = view.task.plan
  const commands = plan?.commands ?? []
  return (
    <section ref={element} class='task-pane' style={{ width: width ? `${width}px` : undefined, height: height ? `${height}px` : undefined }} onPointerUp={event => { if (event.target === event.currentTarget) onResize({ width: Math.max(200, Math.min(4000, Math.round(event.currentTarget.offsetWidth))), height: Math.max(200, Math.min(4000, Math.round(event.currentTarget.offsetHeight))) }) }}><header><span>{hostId} <strong>#{taskId}</strong> <Badge status={view.task.status} /></span><Button onClick={close} aria-label='Close task view only' icon={X} /></header>
      <div class='tabs'>{(view.task.kind === 'consultation' ? ['plan'] : ['plan', 'execution', 'revisions', 'recovery']).map(name => <button key={name} class={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{view.task.kind === 'consultation' ? 'advice' : name}</button>)}</div>
      <div class='pane-content'><h2>{plan?.summary ?? view.task.request}</h2><p>{plan?.changeOverview}</p>{error && <p class='notice' role='alert'>{error}</p>}
        {view.task.kind === 'consultation' && <Card title='Read-only consultation'><p>Saved advice only. This consultation has no executable plan.</p><pre class='output'>{view.task.consultationAnswer ?? 'No saved answer is available.'}</pre><details><summary>Reusable context</summary><pre class='output'>{view.task.consultationSummary}</pre></details></Card>}
        {tab === 'plan' && view.task.kind !== 'consultation' && (
          <>
            <div class='key-values'><span>Review version</span><code>{view.stateVersion}</code><span>Canonical fingerprint</span><code>{view.fingerprint}</code></div>
            <details><summary>Paths, prerequisites and provenance</summary><Data value={{ modifiedFiles: plan?.modifiedFiles, assumptions: plan?.assumptions, warnings: plan?.warnings, compatibility: plan?.compatibilityManifest }} /></details>
            {commands.map(command => <Card key={command.id} title={command.id}><div class='row'><Badge status={command.risk} /><small>{command.timeoutMs}ms · {command.requiresSudo ? 'Privileged' : 'Unprivileged'} · {command.executionMode ?? 'command'}</small></div><p>{command.purpose}</p><Output value={command.command} /><small>Depends on: {command.dependsOn?.join(', ') || 'none'}</small><details><summary>Command provenance</summary><Data value={command.source} /></details>{selected && <label class='check'><input type='checkbox' checked={selected.includes(command.id)} onChange={e => setSelected(e.target.checked ? [...selected, command.id] : selected.filter(id => id !== command.id))} />Approve this command</label>}</Card>)}
            <Card title='Rollback coverage'>{plan?.revertCommands?.length ? plan.revertCommands.map(c => <details key={c.id}><summary>{c.id} · {c.risk}</summary><p>{c.purpose}</p><Output value={c.command} /></details>) : <p>No saved rollback commands. Inspect the plan warnings before approval.</p>}</Card>
            <div class='actions'><Button disabled={!actions || ['completed', 'reverted', 'running', 'reverting'].includes(view.task.status)} primary onClick={() => approve('execute', selected ? { commandIds: selected } : {})}>Review and execute{selected ? ' selected commands' : ' plan'}</Button><Button disabled={!actions} onClick={() => setSelected(selected ? null : [])}>Per-command review</Button></div>
          </>
        )}
        {tab === 'execution' && <><p>Transport loss does not prove command failure. Unknown outcomes must be reconciled, never blindly replayed.</p>{view.commands?.map(command => <Card key={command.commandId} title={command.commandId}><Badge status={command.status} /><Data value={command} /></Card>)}<RecordedResults {...{ hostId, taskId, api, refresh }} diagnostics={view.task.executionDiagnostics} /><div class='actions'>{[['pause', 'Pause before next command'], ['abort', 'Abort remaining work'], ['reconcile', 'Reconcile outcome']].map(([action, label]) => <Button key={action} disabled={!actions} onClick={() => act(action)}>{label}</Button>)}<Button disabled={!actions} primary onClick={() => approve('resume')}>Review and resume</Button></div><label>Read-only question<input value={instructions} onInput={e => setInstructions(e.target.value)} /></label><Button disabled={!actions || !instructions} onClick={() => act('analyze', { question: instructions })}>Ask Codex</Button><Button disabled={!actions || !['partial', 'failed'].includes(view.task.status)} onClick={() => submit({ action: 'prepare', hostId, request: view.task.request, retryOfTaskId: taskId, retryInstructions: instructions || null }).catch(e => setError(e.message))}>Prepare retry for review</Button></>}
        {tab === 'revisions' && <><p>Completed commands remain immutable. Changed work requires new approval.</p><label>Changes to remaining work<textarea value={instructions} onInput={e => setInstructions(e.target.value)} /></label><div class='actions'><Button disabled={!actions || !instructions} onClick={() => act('propose', { instructions })}>Propose revision</Button><Button disabled={!actions || !instructions} onClick={() => act('propose', { instructions, rollback: true })}>Propose reviewed rollback</Button></div>{view.revisions?.map(item => <Card key={item.id} title={`Revision ${item.id} · parent ${item.parentId ?? 'original'}`}><Badge status={item.approved ? 'approved' : 'awaiting-review'} /><Data value={item.differences} /><details><summary>Review replacement plan</summary><Data value={item.plan} /></details><Button disabled={!actions || item.approved} onClick={() => approve('approve', { revisionId: item.id, fingerprint: item.fingerprint })}>Approve revision only</Button></Card>)}</>}
        {tab === 'recovery' && <><p>Inspect or regenerate recovery first. Original deployment approval never approves rollback.</p><Card title='Rollback availability'><Badge status={view.rollbackAvailable ? 'available' : 'unavailable'} /><Data value={view.rollbackCommands} /><Button danger disabled={!actions || !view.rollbackAvailable} onClick={() => approve('rollback', { fingerprint: view.reviewedRollbackFingerprint ?? view.rollbackFingerprint, revisionId: view.revisions?.filter(r => r.approved && r.plan.operatorRollback).at(-1)?.id })}>Review rollback</Button></Card><Button onClick={() => api('/remote-tasks?host=' + encodeURIComponent(hostId)).then(setProposal).catch(e => setError(e.message))}>Inspect signed remote common-task records</Button>{proposal && <Data value={proposal} />}</>}
      </div>
    </section>
  )
}

function Metrics ({ hostId, api }) {
  const [value, setValue] = useState(null)
  useEffect(() => {
    let live = true
    let timer
    const sample = () => { if (document.hidden) { timer = setTimeout(sample, 10000); return }; api('/metrics?host=' + encodeURIComponent(hostId)).then(value => { if (live) setValue(value) }).catch(() => { if (live) setValue({ state: 'unavailable', reason: 'Monitoring request failed' }) }).finally(() => { if (live) timer = setTimeout(sample, 10000) }) }
    sample(); return () => { live = false; clearTimeout(timer) }
  }, [hostId])
  if (!value) return <Empty>Loading monitoring data…</Empty>
  if (value.state !== 'available') return <Empty>{value.reason}</Empty>
  return <div class='metrics'>{value.values?.map(metric => <Card key={metric.context} title={metric.context}><Badge status={metric.state} />{metric.percentage !== null && metric.percentage !== undefined ? <><strong class='gauge'>{metric.percentage.toFixed(1)}%</strong><meter min='0' max='100' value={metric.percentage} /></> : <p>{metric.reason ?? 'Per-series measurements, no combined gauge'}</p>}<small>{metric.observedAt} · {metric.units} · {metric.aggregation}</small><details><summary>Source and series</summary><Data value={metric} /></details></Card>)}</div>
}

function RemoteRecovery ({ hostId, api, submit, actions, operations = [] }) {
  const proposals = operations.filter(operation => operation.status === 'completed' && operation.result?.hostId === hostId && operation.result?.ownership && operation.result?.plan)
  const [records, setRecords] = useState(null)
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => { setRecords(null); setSelected(null) }, [hostId])
  const read = () => api('/remote-tasks?host=' + encodeURIComponent(hostId)).then(setRecords).catch(e => setError(e.message))
  return <Card title='Remote common-task recovery'><p>Signed records are evidence, not executable rollback scripts. Only audited common-task profiles can regenerate recovery.</p><Button onClick={read}>Discover signed records</Button>{error && <p role='alert'>{error}</p>}{records && <><Data value={records} />{(records.executions ?? []).map(record => <div key={record.executionId} class='row'><Button onClick={() => api(`/remote-task?host=${encodeURIComponent(hostId)}&execution=${record.executionId}`).then(setSelected).catch(e => setError(e.message))}>Inspect {record.executionId}</Button><Button disabled={!actions} onClick={() => submit({ action: 'prepare-remote-recovery', hostId, executionId: record.executionId }).catch(e => setError(e.message))}>Prepare recovery for review</Button></div>)}</>}{selected && <Data value={selected} />}{proposals.map(operation => { const proposal = operation.result; return <Card key={operation.id} title={'Regenerated recovery #' + proposal.taskId}><Data value={proposal.plan} /><Data value={proposal.ownership} /><Button danger disabled={!actions} onClick={() => { if (!confirm('Approve this regenerated recovery plan? This does not authorize replay of uncertain work.')) return; const owned = proposal.ownership.owned === true; if (owned && !confirm('This execution has a remote owner. Approve the displayed owner-fingerprint takeover only after inspecting its evidence?')) return; submit({ action: 'execute-remote-recovery', hostId, taskId: proposal.taskId, expectedVersion: proposal.stateVersion, fingerprint: proposal.fingerprint, approved: true, ...(owned ? { takeoverApproved: true, takeoverFingerprint: proposal.ownership.ownerFingerprint } : {}) }).catch(e => setError(e.message)) }}>Approve reviewed remote recovery</Button></Card> })}<small>Prepared recovery appears in task history and operation results. Execution and any ownership takeover need separate approval.</small></Card>
}

function Gallery () {
  const theme = palettes.find(p => p.id === new URLSearchParams(location.search).get('theme')) ?? palettes[0]
  applyTheme(theme); document.body.style.visibility = 'visible'
  return <div class='gallery'><aside><img class='brand-mark' src={logo} alt='Intent AI Ops logo' /><h2>Intent AI Ops</h2><p>Workspace</p><button class='active'><LayoutDashboard size={16} aria-hidden='true' />Overview</button><button><ActivityIcon size={16} aria-hidden='true' />Activity</button><input placeholder='Search hosts…' /><p><Star size={16} aria-hidden='true' /> edge-01</p><Badge status='connected' /></aside><main><h1>{theme.name}</h1><p>Representative workspace components · {theme.id}</p><div class='cards'><Card title='Host · edge-01'><Badge status='active' /><p>Stage 2 ready · Linux</p><meter min='0' max='100' value='37' /><p>CPU 37% · example fixture</p><Button primary>Review plan</Button></Card><Card title='Approval required'><Badge status='awaiting-review' /><label>Operator instructions<input placeholder='Changes to remaining work' /></label><Button>Pause before next command</Button><Button danger>Review rollback</Button></Card><Card title='Recorded failure'><Badge status='failed' /><p>Deadline exceeded. Partial changes are possible.</p><pre class='output'><span class='ansi-1'>EXECUTION_TIMEOUT</span>{'\n'}<span class='ansi-2'>Confirmed durable job result</span>{'\n'}<span class='ansi-11'>Review before continuing</span></pre></Card></div><Card title='Review and revision'><div class='tabs'><button class='active'>Plan</button><button>Execution</button></div><pre>systemctl show example.service</pre><p class='diff-added'>+ new verified diagnostic step</p><p class='diff-removed'>− superseded unexecuted step</p><Button autoFocus>Keyboard focus</Button><Badge status='unknown' /></Card></main></div>
}

function App () {
  const [session, setSession] = useState(null)
  const [preferences, setPreferences] = useState(null)
  const [preview, setPreview] = useState(null)
  const [systemDark, setSystemDark] = useState(media.matches)
  const [data, setData] = useState({ hosts: [], runs: [], clusters: [], operations: [], hostStates: {} })
  const [route, navigate] = useState('overview')
  const [hostId, chooseHost] = useState(null)
  const [hostTab, setHostTab] = useState('overview')
  const [search, setSearch] = useState('')
  const [dialog, chooseDialog] = useState(null)
  const setDialog = value => {
    if (value === 'compose' && route === 'cluster') { document.querySelector('[aria-label="Application"]')?.focus(); return }
    chooseDialog(value)
  }
  const [error, setError] = useState('')
  const [events, setEvents] = useState([])
  const [historyPage, setHistoryPage] = useState(null)
  const [activePane, setActivePane] = useState(null)
  const [connection, setConnection] = useState('connecting')
  const [refresh, setRefresh] = useState(0)
  const [inventory, setInventory] = useState(null)
  const [filter, setFilter] = useState('')
  const [detail, setDetail] = useState(null)
  const [runSelection, selectRun] = useState({})
  const [rollout, setRollout] = useState(true)
  const [canaries, setCanaries] = useState({})
  const cursor = useRef(0)
  const pendingRefresh = useRef(null)
  const refs = useRef({ session, preferences })
  refs.current = { session, preferences }
  const api = async (url, body) => {
    const response = await fetch(mount + url, { credentials: 'same-origin', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Intent-CSRF': refs.current.session?.csrf ?? '' }, body: JSON.stringify(body) } : {}) })
    const value = await response.json()
    if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`)
    return value
  }
  const reload = () => api('/workspace').then(value => { setData(value); setRefresh(v => v + 1); return value })
  const submissions = useRef(new Map())
  const submit = async body => {
    const digest = JSON.stringify(body)
    let entry = submissions.current.get(digest)
    if (entry?.pending) return entry.pending
    if (!entry) { entry = { requestKey: uuid() }; submissions.current.set(digest, entry) }
    entry.pending = api('/operation', { ...body, requestKey: entry.requestKey }).then(value => { entry.id = value.id; reload(); return value }).catch(error => { entry.pending = null; throw error })
    return entry.pending
  }
  useEffect(() => { for (const [key, entry] of submissions.current) if (data.operations.some(operation => operation.id === entry.id && operation.status !== 'running')) submissions.current.delete(key) }, [data.operations])
  const save = async patch => {
    try { const next = await api('/preferences', { version: refs.current.preferences.version, patch }); setPreferences(next); return next } catch (error) { setPreferences(await api('/preferences')); setError(error.message); throw error }
  }
  const panes = preferences?.value.panes ?? []
  const openTask = (id, task) => { setActivePane(`${id}:${task}`); if (panes.some(p => p.hostId === id && p.taskId === task)) { navigate('tasks'); return }; save({ panes: [...panes, { hostId: id, taskId: task }].slice(-8) }); navigate('tasks') }
  useEffect(() => {
    const change = e => setSystemDark(e.matches)
    media.addEventListener('change', change)
    const start = async () => {
      try {
        const token = location.hash.slice(1)
        history.replaceState(null, '', location.pathname + location.search)
        const session = token ? await api('/session', { token }) : await api('/session')
        refs.current.session = session; setSession(session)
        const prefs = await api('/preferences'); setPreferences(prefs)
        applyTheme(resolveTheme(prefs.value.appearance, media.matches)); document.body.style.visibility = 'visible'
        const snapshot = await reload(); cursor.current = snapshot.cursor
        setEvents(await api('/history?before=' + (cursor.current + 1)))
        const stream = new EventSource(mount + '/events?after=' + cursor.current)
        stream.onopen = () => setConnection('live')
        stream.onerror = () => setConnection('reconnecting')
        stream.addEventListener('workspace-status', event => setError(JSON.parse(event.data).notice))
        stream.onmessage = event => {
          const id = Number(event.lastEventId)
          if (!Number.isSafeInteger(id) || id <= cursor.current) return
          cursor.current = id
          const value = JSON.parse(event.data)
          if (value.type === 'workspace_operation' && value.status === 'failed') setError(value.message ?? 'Operation failed; inspect recorded activity')
          if (value.type === 'ui_preferences_changed') { api('/preferences').then(setPreferences).catch(e => setError(e.message)); return }
          setEvents(previous => [...previous, value].slice(-500))
          if (!pendingRefresh.current) pendingRefresh.current = setTimeout(() => { pendingRefresh.current = null; reload().catch(e => setError(e.message)) }, 300)
        }
        return stream
      } catch (error) { setError(error.message); document.body.style.visibility = 'visible'; setConnection('authentication required') }
    }
    const promise = start()
    return () => { media.removeEventListener('change', change); promise.then(stream => stream?.close()); clearTimeout(pendingRefresh.current) }
  }, [])
  useEffect(() => { if (preferences) applyTheme(resolveTheme(preview ?? preferences.value.appearance, systemDark)) }, [preferences?.value.appearance, preview, systemDark])
  if (!session || !preferences) return <main class='welcome'><h1>Intent AI Ops</h1><p>{error || 'Unlocking local workspace…'}</p><p>Open the authenticated launch URL printed in the foreground terminal. A new launch requires a new session.</p></main>
  const actions = session.actions
  const runAction = body => submit(body).catch(e => setError(e.message))
  const favorites = preferences.value.favorites ?? []
  const visibleHosts = [...data.hosts].sort((a, b) => Number(favorites.includes(b.id)) - Number(favorites.includes(a.id))).filter(host => host.id.toLowerCase().includes(search.toLowerCase()))
  const selectedHost = data.hosts.find(h => h.id === hostId)
  const goHost = id => { chooseHost(id); navigate('host'); setInventory(null) }
  const executeRun = async run => {
    try {
      const hosts = run.hosts.filter(h => runSelection[`${run.id}:${h.serverId}`] && h.status !== 'completed' && h.taskId)
      if (!hosts.length) throw new Error('Explicitly select hosts whose persisted plans you reviewed')
      const views = await Promise.all(hosts.map(h => api(`/task?host=${encodeURIComponent(h.serverId)}&task=${h.taskId}`)))
      if (!confirm(`Approve the reviewed saved plans for ${hosts.map(h => h.serverId).join(', ')}?`)) return
      await submit({ action: 'run-resume', runId: run.id, approved: true, decisions: views.map(v => ({ hostId: v.hostId, taskId: v.task.id, expectedVersion: v.stateVersion, fingerprint: v.fingerprint })), concurrency: 4, ...(rollout ? { rollout: { batchSize: 2, ...(run.hosts.some(host => host.serverId === canaries[run.id] && host.status !== 'completed') ? { canaryHost: canaries[run.id] } : {}) } } : {}) })
    } catch (error) { setError(error.message) }
  }
  const retryRun = run => {
    const serverIds = run.hosts.filter(host => runSelection[`${run.id}:${host.serverId}`] && host.status !== 'completed').map(host => host.serverId)
    if (!serverIds.length) { setError('Select unfinished hosts first'); return }
    const instructions = window.prompt('Alternative strategy or constraints for this retry (no credentials):')
    if (instructions === null) return
    runAction({ action: 'prepare', serverIds, request: run.request, ...(run.catalogId ? { catalogId: run.catalogId } : {}), retryOfRunId: run.id, retryInstructions: instructions || null })
  }
  const hostAction = action => runAction({ action, hostId, hostVersion: selectedHost?.hostVersion, ...(['host-edit', 'host-remove', 'stage2-activate', 'stage2-update', 'stage2-deactivate'].includes(action) ? { approved: confirm('Approve this host configuration or Stage 2 lifecycle change? Existing history is retained.') } : {}) })
  return (
    <div class='workspace' style={{ '--sidebar-width': `${preferences.value.sidebar}px` }}>
      <a class='skip-link' href='#workspace-content'>Skip to workspace</a>
      <aside class='sidebar'><div class='brand'><img class='brand-mark' src={logo} alt='Intent AI Ops logo' /><div><strong>Intent AI Ops</strong><small>Local operator workspace</small></div></div><nav>{[['overview', 'Overview', LayoutDashboard], ['runs', 'Multi-host runs', Network], ['activity', 'Activity', ActivityIcon], ['settings', 'Settings', SettingsIcon]].map(([name, label, Icon]) => <button key={name} class={route === name ? 'active' : ''} onClick={() => navigate(name)}><Icon size={16} aria-hidden='true' focusable='false' />{label}</button>)}</nav><input aria-label='Search hosts' placeholder='Search hosts…' value={search} onInput={e => setSearch(e.target.value)} /><h4>Hosts · {data.hosts.length}</h4><div class='host-tree'>{visibleHosts.map(host => <div key={host.id}><button class={host.id === hostId && route === 'host' ? 'active host-name' : 'host-name'} onClick={() => goHost(host.id)}><span class='dot' />{favorites.includes(host.id) && <Star size={14} aria-hidden='true' focusable='false' />}{host.id}</button>{host.tasks.slice(0, 4).map(task => <button key={task.id} class='tree-task' onClick={() => openTask(host.id, task.id)}>#{task.id} {task.request?.slice(0, 32)}<small>{task.status}</small></button>)}</div>)}</div><h4>Clusters</h4>{data.clusters.map(cluster => <button key={cluster.id} onClick={() => { setDetail(cluster); navigate('cluster') }}>{cluster.id} <Badge status={cluster.desiredStage2} /></button>)}<div class='sidebar-bottom'><Badge status={connection} /><small>{actions ? 'Reviewed controls enabled' : 'Read-only mode'}</small><Button disabled={!actions} title={!actions ? 'Restart with --console-actions to manage hosts' : ''} onClick={() => setDialog('add-host')} icon={Plus}>Add host</Button></div></aside>
      <div class='sidebar-resize' role='separator' aria-label='Sidebar width' aria-orientation='vertical' tabIndex='0' onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') save({ sidebar: Math.max(220, Math.min(420, preferences.value.sidebar + (e.key === 'ArrowRight' ? 10 : -10))) }) }} onPointerDown={e => { const target = e.currentTarget; target.setPointerCapture(e.pointerId); const move = event => document.documentElement.style.setProperty('--sidebar-drag', `${Math.max(220, Math.min(420, event.clientX))}px`); const up = event => { save({ sidebar: Math.round(Math.max(220, Math.min(420, event.clientX))) }); document.documentElement.style.removeProperty('--sidebar-drag'); target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up) }; target.addEventListener('pointermove', move); target.addEventListener('pointerup', up) }} />
      <div class='main' id='workspace-content' tabIndex='-1'><header class='toolbar'><span>{route === 'host' ? hostId : ({ overview: 'Overview', runs: 'Multi-host runs', activity: 'Activity', settings: 'Settings', tasks: 'Task workspace', replay: 'Replay', cluster: 'Cluster inspection' }[route] ?? route)}</span><div class='row'><Button onClick={() => setDialog('themes')} icon={Palette}>Appearance</Button><Button primary disabled={!actions} title={!actions ? 'Read-only mode, launch with --console-actions' : ''} onClick={() => setDialog('compose')} icon={Plus}>New task</Button></div></header>{data.notice && <div class='notice' role='alert'>{data.notice}</div>}{error && <div class='notice' role='alert'>{error}<Button onClick={() => setError('')}>Dismiss</Button></div>}{connection !== 'live' && <div class='notice'>Connection: {connection}. Saved views may be stale. No commands are restarted by reconnecting.</div>}
        <div class='task-tabs'>{panes.map(p => <button key={`${p.hostId}:${p.taskId}`} class={route === 'tasks' && activePane === `${p.hostId}:${p.taskId}` ? 'active' : ''} onClick={() => { setActivePane(`${p.hostId}:${p.taskId}`); navigate('tasks') }}>{p.hostId} #{p.taskId}</button>)}{panes.length > 1 && <Button onClick={() => save({ split: preferences.value.split === 'vertical' ? 'horizontal' : 'vertical' })}>Split {preferences.value.split === 'vertical' ? 'side by side' : 'above / below'}</Button>}</div>
        {route === 'overview' && <main class='page'><div class='page-heading'><div><h1>Your infrastructure</h1><p>One workspace. Explicit review. Durable execution.</p></div><Badge status={actions ? 'operator-controls' : 'read-only'} /></div><div class='summary'><Card title='Hosts'><strong class='gauge'>{data.hosts.length}</strong></Card><Card title='Active work'><strong class='gauge'>{data.hosts.flatMap(h => h.tasks).filter(t => ['running', 'reverting'].includes(t.status)).length}</strong></Card><Card title='Needs attention'><strong class='gauge'>{data.hosts.flatMap(h => h.tasks).filter(t => ['partial', 'failed', 'revert_failed'].includes(t.status)).length}</strong></Card></div>{events.filter(e => e.type === 'terminal_input' && e.state !== 'finished').slice(-1).map(e => <p key={e.id} class='notice'>{e.hostId}: check the launch terminal if authentication needs input.</p>)}<div class='cards'>{visibleHosts.map(host => <Card key={host.id}><div class='row spread'><h3>{host.id}</h3><Button aria-label={'Favorite ' + host.id} aria-pressed={favorites.includes(host.id)} onClick={() => save({ favorites: favorites.includes(host.id) ? favorites.filter(id => id !== host.id) : [...favorites, host.id] })} icon={Star} /></div><Badge status={data.hostStates[host.id]?.connection ?? 'not-connected'} /><p>Stage 2: {data.hostStates[host.id]?.stage2 ?? 'not inspected'}</p><small>{host.tasks.length} recent tasks · {data.hostStates[host.id]?.platform?.os ?? 'Platform not inspected'}</small><footer><Button onClick={() => goHost(host.id)}>Open workspace</Button><Button disabled={!actions} onClick={() => runAction({ action: 'host-connect', hostId: host.id })}>Connect</Button></footer></Card>)}</div>{!data.hosts.length && <Empty>No configured hosts. Add a host to begin; its SSH identity is verified in the launch terminal.</Empty>}</main>}
        {route === 'host' && selectedHost && <main class='page'><div class='page-heading'><div><h1>{hostId}</h1><Badge status={data.hostStates[hostId]?.connection ?? 'not-connected'} /></div><div class='actions'><Button disabled={!actions} onClick={() => hostAction('host-connect')}>Connect</Button><Button disabled={!actions} onClick={() => hostAction('host-disconnect')}>Disconnect</Button><Button onClick={() => setDialog('compose')} disabled={!actions}>New task</Button></div></div><div class='tabs'>{['overview', 'tasks', 'inventory', 'activity', 'recovery', 'terminal'].map(name => <button key={name} class={hostTab === name ? 'active' : ''} onClick={() => setHostTab(name)}>{name}</button>)}</div>{hostTab === 'overview' && <><Metrics key={hostId} hostId={hostId} api={api} /><Card title='Connection and execution readiness'><Data value={data.hostStates[hostId] ?? { state: 'not inspected' }} /><div class='actions'>{[['stage2-activate', 'Activate Stage 2'], ['stage2-update', 'Update plugin only'], ['stage2-deactivate', 'Deactivate Stage 2']].map(([action, label]) => <Button key={action} disabled={!actions} onClick={() => hostAction(action)}>{label}</Button>)}<Button disabled={!actions} onClick={() => setDialog('edit-host')}>Edit connection</Button><Button danger disabled={!actions} onClick={() => hostAction('host-remove')}>Remove local configuration</Button></div><small>Removing configuration retains history and does not uninstall remote software. Use the SSH terminal tab for a direct operator shell.</small></Card></>}{hostTab === 'terminal' && <BrowserShell key={hostId} hostId={hostId} hostVersion={selectedHost.hostVersion} api={api} mount={mount} actions={actions} palette={resolveTheme(preview ?? preferences.value.appearance, systemDark)} />}{hostTab === 'tasks' && <TaskList host={selectedHost} openTask={openTask} />}{hostTab === 'inventory' && <Card title='Inventory'><Button onClick={() => api('/inventory?host=' + encodeURIComponent(hostId)).then(setInventory).catch(e => setError(e.message))}>Refresh inventory explicitly</Button>{inventory ? <Data value={inventory} /> : <Empty>Inventory is loaded on request, never on every render.</Empty>}</Card>}{hostTab === 'activity' && <Activity events={events.filter(e => e.hostId === hostId)} filter={filter} setFilter={setFilter} detail={detail} setDetail={setDetail} />}{hostTab === 'recovery' && <RemoteRecovery key={hostId} hostId={hostId} api={api} submit={submit} actions={actions} operations={data.operations} />}</main>}
        {route === 'tasks' && <div class={'panes ' + (preferences.value.split ?? 'horizontal')}>{panes.map(p => <TaskPane key={`${p.hostId}:${p.taskId}`} {...p} active={activePane === `${p.hostId}:${p.taskId}`} api={api} submit={submit} actions={actions} refresh={refresh} onResize={size => save({ panes: panes.map(item => item === p ? { ...item, ...size } : item) })} close={() => save({ panes: panes.filter(item => item !== p) })} />)}{!panes.length && <Empty>Choose a task from a host. Closing a pane never cancels work.</Empty>}</div>}
        {route === 'runs' && <main class='page'><h1>Multi-host operations</h1><p>Each host has its own saved plan and decision. Completed hosts are never repeated.</p><label class='check'><input type='checkbox' checked={rollout} onChange={e => setRollout(e.target.checked)} />Canary first, then batches of two. Stop on any failed or incomplete task.</label>{data.runs.map(run => <Card key={run.id} title={`Run #${run.id} · ${run.request}`}><Badge status={run.status} />{rollout && <label>Canary host<select value={run.hosts.some(host => host.serverId === canaries[run.id] && host.status !== 'completed') ? canaries[run.id] : ''} onChange={event => setCanaries({ ...canaries, [run.id]: event.target.value })}><option value=''>First explicitly selected host</option>{run.hosts.filter(host => host.status !== 'completed').map(host => <option key={host.serverId} value={host.serverId}>{host.serverId}</option>)}</select></label>}<div class='cards'>{run.hosts.map(host => <Card key={host.serverId} title={host.serverId}><Badge status={host.status} /><label class='check'><input type='checkbox' disabled={host.status === 'completed' || !host.taskId} checked={Boolean(runSelection[`${run.id}:${host.serverId}`])} onChange={e => selectRun({ ...runSelection, [`${run.id}:${host.serverId}`]: e.target.checked })} />Select after reviewing this plan</label>{host.taskId && <Button onClick={() => openTask(host.serverId, host.taskId)}>Review #{host.taskId}</Button>}<p>{host.error}</p></Card>)}</div><div class='actions'><Button primary disabled={!actions} onClick={() => executeRun(run)}>Approve and continue selected hosts</Button><Button disabled={!actions} onClick={() => retryRun(run)}>Prepare retry for selected hosts</Button><Button disabled={!actions} onClick={() => runAction({ action: 'run-pause', runId: run.id })}>Pause before next command</Button><Button onClick={() => api('/export?run=' + run.id).then(value => { setDetail(value); navigate('replay') }).catch(e => setError(e.message))}>Replay / export</Button></div><Data value={run.rollout} /><details><summary>Persisted host decisions</summary><Data value={run.reviews} /></details></Card>)}{!data.runs.length && <Empty>Prepare a task with several explicitly selected hosts to create a durable run.</Empty>}</main>}
        {route === 'activity' && <main class='page'><h1>Activity</h1><p>{historyPage ? 'Historical page, live events continue separately.' : 'Live activity with recorded catch-up.'}</p><Button onClick={() => api('/history?before=' + ((historyPage ?? events)[0]?.id ?? Number.MAX_SAFE_INTEGER)).then(setHistoryPage).catch(e => setError(e.message))}>Earlier recorded page</Button>{historyPage && <Button onClick={() => setHistoryPage(null)}>Return to live</Button>}<Activity events={historyPage ?? events} {...{ filter, setFilter, detail, setDetail }} /><h2>Accepted operations</h2>{data.operations.map(operation => <Card key={operation.id} title={operation.id}><Badge status={operation.status} /><p>{operation.error}</p><Data value={operation.result} /></Card>)}</main>}
        {route === 'replay' && <Replay bundle={detail} />}
        {route === 'cluster' && <ClusterWorkspace clusterId={detail.clusterId ?? detail.id} {...{ api, submit, actions, refresh, Button, Card, Badge }} operations={data.operations} />}
        {route === 'settings' && <main class='page'><h1>Workspace settings</h1><Card title='Appearance'><label>Mode<select value={preferences.value.appearance.mode} onChange={e => save({ appearance: { ...preferences.value.appearance, mode: e.target.value } })}><option value='system'>System</option><option value='light'>Light</option><option value='dark'>Dark</option></select></label><p>Light: {preferences.value.appearance.light} · Dark: {preferences.value.appearance.dark}</p><Button primary onClick={() => setDialog('themes')}>Browse all 27 themes</Button><p>Nonsecret preferences are stored in this local profile, independent of the server port. Tasks and views do not reset when colors change.</p></Card><Card title='Runtime'><p>Foreground process · 127.0.0.1 only · {actions ? 'Reviewed actions enabled' : 'Host/task controls disabled'}</p><p>Keep the launch terminal open for vault, SSH and elevation prompts.</p></Card></main>}
      </div>
      {dialog === 'themes' && <ThemePicker preference={preferences.value.appearance} preview={setPreview} close={() => { setPreview(null); setDialog(null) }} commit={value => save({ appearance: value }).then(() => { setPreview(null); setDialog(null) }).catch(() => setPreview(null))} />}
      {dialog === 'compose' && <Composer hosts={data.hosts} initialHost={route === 'host' ? hostId : null} {...{ api, submit, actions }} close={() => setDialog(null)} />}
      {(dialog === 'add-host' || dialog === 'edit-host') && <HostDialog editing={dialog === 'edit-host'} hostId={hostId} hostVersion={selectedHost?.hostVersion} submit={submit} close={() => setDialog(null)} />}
    </div>
  )
}

function Replay ({ bundle }) {
  const events = bundle?.events ?? []
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => setIndex(value => { if (value + 1 >= events.length) { setPlaying(false); return value }; return value + 1 }), 500)
    return () => clearInterval(timer)
  }, [playing, events.length])
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'intentaiops-diagnostics.json'; anchor.click(); URL.revokeObjectURL(url)
  }
  return <main class='page'><h1>Historical replay</h1><p>Recorded events in chronological order. Playback never calls a host or restores its state.</p><div class='actions'><Button onClick={() => setPlaying(!playing)} disabled={!events.length}>{playing ? 'Pause replay' : 'Play replay'}</Button><Button onClick={() => setIndex(Math.max(0, index - 1))}>Previous event</Button><Button onClick={() => setIndex(Math.min(events.length - 1, index + 1))} disabled={!events.length}>Next event</Button><Button onClick={download}>Export sanitized bundle</Button></div><label>Recorded timeline<input type='range' min='0' max={Math.max(0, events.length - 1)} value={index} onInput={e => { setPlaying(false); setIndex(Number(e.target.value)) }} /></label><small>{index + 1} / {events.length} recorded events</small><Card title={events[index]?.type ?? 'No events'}><p>{events[index]?.timestamp} · {events[index]?.hostId} · {events[index]?.commandId}</p><Data value={events[index]} /></Card></main>
}

function TaskList ({ host, openTask }) { return host.tasks.length ? <table><thead><tr><th>Task</th><th>Request</th><th>Status</th><th /></tr></thead><tbody>{host.tasks.map(task => <tr key={task.id}><td>#{task.id}</td><td>{task.request}</td><td><Badge status={task.status} /></td><td><Button onClick={() => openTask(host.id, task.id)}>Inspect</Button></td></tr>)}</tbody></table> : <Empty>No saved tasks yet.</Empty> }
function Activity ({ events, filter, setFilter, detail, setDetail }) { return <><input aria-label='Filter activity' placeholder='Filter events, host, command or status…' value={filter} onInput={e => setFilter(e.target.value)} /><div class='activity'><div>{events.filter(event => JSON.stringify(event).toLowerCase().includes(filter.toLowerCase())).slice(-300).reverse().map(event => <button class='event-row' key={`${event.id}:${event.hostId}`} onClick={() => setDetail(event)}><small>{event.timestamp}</small><strong>{event.type}</strong><span>{event.hostId} {event.commandId}</span></button>)}{!events.length && <Empty>No recorded events loaded. Live events appear here as work progresses.</Empty>}</div><Card title='Recorded detail'>{detail ? <Data value={detail} /> : <Empty>Select an event</Empty>}</Card></div></> }
function HostDialog ({ editing, hostId, hostVersion, submit, close }) {
  const [id, setId] = useState(editing ? hostId : '')
  const [connection, setConnection] = useState('')
  const [authentication, setAuthentication] = useState('auto')
  const [temporary, setTemporary] = useState(false)
  const [error, setError] = useState('')
  return <Modal title={editing ? 'Edit SSH connection' : 'Add SSH host'} close={close}><p>Enter no passwords. SSH host-key verification and secret prompts remain in the launch terminal. Changed identities never inherit Stage 2 authorization.</p><label>Local name<input autoFocus disabled={editing} value={id} onInput={e => setId(e.target.value)} /></label><label>SSH command or URL<input value={connection} onInput={e => setConnection(e.target.value)} placeholder='ssh admin@edge.example' /></label><label>Authentication<select value={authentication} onChange={e => setAuthentication(e.target.value)}><option value='auto'>Automatic</option><option value='key'>Key / agent</option><option value='password'>Password (terminal prompt)</option></select></label><label class='check'><input type='checkbox' checked={temporary} onChange={e => setTemporary(e.target.checked)} />Temporary configuration, removed at clean shutdown</label>{error && <p role='alert'>{error}</p>}<footer><Button onClick={close}>Cancel</Button><Button primary disabled={!id || !connection} onClick={() => { if (editing && !confirm('Verify and replace this connection, retaining previous identity-bound history?')) return; submit({ action: editing ? 'host-edit' : 'host-add', hostId: id, hostVersion, connection, authentication, temporary, ...(editing ? { approved: true } : {}) }).then(close).catch(e => setError(e.message)) }}>Verify identity in terminal</Button></footer></Modal>
}

render(new URLSearchParams(location.search).has('gallery') ? <Gallery /> : <App />, document.getElementById('app'))
