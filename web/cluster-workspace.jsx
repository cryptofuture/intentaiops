import { useEffect, useState } from 'preact/hooks'

export function ClusterWorkspace ({ clusterId, api, submit, actions, refresh, operations, Button, Card, Badge }) {
  const [cluster, setCluster] = useState(null)
  const [taskId, selectTask] = useState(null)
  const [view, setView] = useState(null)
  const [catalogId, setCatalogId] = useState('n8n-kubernetes')
  const [records, setRecords] = useState(null)
  const [executionId, setExecutionId] = useState('')
  const [pending, setPending] = useState(null)
  const [error, setError] = useState('')
  const [takeover, setTakeover] = useState(false)
  const [version, setVersion] = useState(0)
  const setTaskId = id => { selectTask(id); setVersion(value => value + 1) }
  const load = () => api('/cluster?id=' + encodeURIComponent(clusterId)).then(setCluster).catch(error => setError(error.message))
  useEffect(() => { setCluster(null); setTaskId(null); setView(null); setRecords(null); setPending(null); setError(''); load() }, [clusterId])
  useEffect(() => {
    if (!taskId) return
    let current = true
    api('/cluster-task?cluster=' + encodeURIComponent(clusterId) + '&task=' + taskId).then(value => { if (current) setView(value) }).catch(error => { if (current) setError(error.message) })
    return () => { current = false }
  }, [clusterId, taskId, refresh, version])
  useEffect(() => {
    if (!pending) return
    const operation = operations.find(operation => operation.id === pending)
    if (!operation || operation.status === 'running') return
    setPending(null)
    if (operation.status !== 'completed') setError(operation.error ?? 'Operation interrupted; inspect saved state before continuation')
    else if (operation.result?.taskId) { setTaskId(operation.result.taskId); setView(null); setVersion(value => value + 1); setTakeover(false) } else if (operation.result?.alreadyAbsent) setError(operation.result.message)
    load()
  }, [operations, pending])
  const act = async body => {
    try { setError(''); const accepted = await submit({ ...body, clusterId }); if (!['cluster-pause', 'cluster-abort'].includes(body.action)) setPending(accepted.id) } catch (error) { setError(error.message) }
  }
  const review = () => {
    if (!view || !window.confirm(view.recovery ? 'Approve deletion of only these signed original resource UIDs? Deleting the PVC permanently removes task-created application data.' : 'Approve exactly this persisted plan for this cluster?')) return
    act({ action: 'cluster-execute', taskId, approved: true, expectedVersion: view.expectedVersion, fingerprint: view.fingerprint, takeoverApproved: takeover, ...(view.takeoverFingerprint ? { takeoverFingerprint: view.takeoverFingerprint } : {}) })
  }
  const blocked = view?.status === 'completed' || view?.control?.action === 'abort' || view?.execution?.some(command => command.status === 'uncertain')
  return (
    <main class='page'>
      <h1>Cluster inspection</h1>
      <p>Tasks use persisted reviews and the separate signed Kubernetes gateway. Closing this view never starts, stops or repeats work.</p>
      <Button onClick={load}>Inspect API and gateway</Button>
      {error && <p role='alert' class='notice'>{error}</p>}
      {!cluster
        ? <p>Loading verified cluster identity and history…</p>
        : (
          <>
            <div class='cards'><Card title={clusterId}><Badge status={cluster.stage2} /><p>{cluster.version} · {cluster.nodeCount} nodes</p><p>Signed recovery: {cluster.recoveryAvailable ? 'persistent storage enabled' : 'unavailable; enable a dedicated PVC in the CLI'}</p></Card><Card title='Verified nodes'><pre class='output'>{cluster.nodes.map(node => `${node.name}: ${node.ready}`).join('\n')}</pre></Card></div>
            <Card title='Prepare a common-task plan'><p>Preparation is read-only on the cluster. Existing installations are never adopted or overwritten.</p><label>Application<select aria-label='Application' value={catalogId} onChange={event => setCatalogId(event.target.value)}>{cluster.catalog.map(task => <option key={task.id} value={task.id}>{task.label}</option>)}</select></label><Button disabled={!actions || !cluster.recoveryAvailable || Boolean(pending)} onClick={() => act({ action: 'cluster-prepare', catalogId })}>Prepare cluster plan</Button>{!actions && <p>Read-only mode. Restart with --console-actions for reviewed task controls.</p>}</Card>
            <Card title='Cluster task history'>{cluster.tasks.length ? <table><thead><tr><th>Task</th><th>Request</th><th>Status</th><th /></tr></thead><tbody>{cluster.tasks.map(task => <tr key={task.id}><td>#{task.id}</td><td>{task.request}</td><td><Badge status={task.status} /></td><td><Button onClick={() => { setTaskId(task.id); setView(null) }}>Review task #{task.id}</Button></td></tr>)}</tbody></table> : <p>No saved cluster tasks.</p>}</Card>
          </>
          )}
      {pending && <p role='status'>Operation accepted. Durable progress continues independently of this browser.</p>}
      {view && (
        <Card title={`Task #${view.taskId}: ${view.summary}`}>
          <Badge status={view.status} /><p>Execution: {view.executionId}</p>
          {view.warnings?.map(warning => <p key={warning} class='notice'>{warning}</p>)}
          <table><thead><tr><th>Step</th><th>API operation</th><th>Purpose and risk</th><th>State</th></tr></thead><tbody>{view.commands.map(command => <tr key={command.id}><td>{command.id}</td><td><code>{command.method} {command.path}</code>{command.resourceUid && <p>Original UID: {command.resourceUid}</p>}{command.images?.map(image => <p key={image}>{image}</p>)}</td><td>{command.purpose}<p>{command.risk}</p></td><td><Badge status={view.execution.find(state => state.commandId === command.id)?.status ?? 'pending'} /></td></tr>)}</tbody></table>
          {view.takeoverRequired && <label class='check'><input type='checkbox' checked={takeover} onChange={event => setTakeover(event.target.checked)} />I inspected the prior operation and explicitly approve ownership takeover. Lease expiry alone is not permission to replay work.</label>}
          <div class='row'>
            <Button primary disabled={!actions || blocked || Boolean(pending) || (view.takeoverRequired && !takeover)} title={blocked ? 'No continuation is authorized: completed, aborted or uncertain work requires inspection, not replay' : ''} onClick={review}>{view.recovery ? 'Approve recovery plan' : 'Approve and continue cluster task'}</Button>
            <Button disabled={!actions || view.status === 'completed'} onClick={() => act({ action: 'cluster-pause', taskId, expectedVersion: view.expectedVersion })}>Pause before next command</Button>
            <Button danger disabled={!actions || view.status === 'completed'} onClick={() => { if (window.confirm('Abort remaining work? In-flight API requests and workloads are not killed.')) act({ action: 'cluster-abort', taskId, expectedVersion: view.expectedVersion }) }}>Abort remaining work</Button>
            {!view.recovery && <Button danger disabled={!actions || Boolean(pending)} onClick={() => act({ action: 'cluster-prepare-recovery', executionId: view.executionId })}>Prepare recovery review</Button>}
          </div>
          <p>Pause and abort affect subsequent commands, not running workloads. Unknown mutations are never replayed.</p>
        </Card>
      )}
      <Card title='Fresh-install signed recovery'><p>Read-only discovery does not initialize a key or execute a remote rollback script. A new recovery plan is generated from the trusted local catalog and current resource UIDs.</p><Button onClick={() => api('/cluster-recovery?cluster=' + encodeURIComponent(clusterId)).then(value => { setRecords(value.executions); setExecutionId(value.executions[0]?.executionId ?? '') }).catch(error => setError(error.message))}>Discover remote records</Button>{records && <><label>Signed execution<select value={executionId} onChange={event => setExecutionId(event.target.value)}>{records.map(record => <option key={record.executionId} value={record.executionId}>{record.executionId} · {record.sequence} records</option>)}</select></label>{!records.length && <p>No published signed records.</p>}<Button disabled={!actions || !executionId || Boolean(pending)} onClick={() => act({ action: 'cluster-prepare-recovery', executionId })}>Verify and prepare recovery</Button></>}</Card>
    </main>
  )
}
