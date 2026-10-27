export function startExecutionHeartbeat (tasks, serverId, taskId, owner) {
  let lastMonotonic = performance.now()
  let lastWall = Date.now()
  let failure
  const timer = setInterval(() => {
    const monotonic = performance.now()
    const wall = Date.now()
    const elapsedMs = Math.max(0, Math.round(monotonic - lastMonotonic))
    const wallClockDeltaMs = Math.round(wall - lastWall - elapsedMs)
    lastMonotonic = monotonic
    lastWall = wall
    let renewalFailed = false
    let reason = 'EXECUTION_LEASE_RENEWAL_FAILED'
    try { tasks.renewExecution(serverId, taskId, owner) } catch (error) {
      failure ??= error
      clearInterval(timer)
      renewalFailed = true
      if (['EXECUTION_LEASE_MISSING', 'EXECUTION_LEASE_REPLACED', 'EXECUTION_LEASE_EXPIRED'].includes(error.code)) reason = error.code
    }
    if (renewalFailed || elapsedMs >= 20000 || Math.abs(wallClockDeltaMs) >= 1000) {
      try {
        tasks.appendProgress(serverId, taskId, {
          phase: 'execution-ownership',
          state: renewalFailed ? 'ownership_lost' : 'heartbeat_delayed',
          reason: renewalFailed ? reason : 'EXECUTION_HEARTBEAT_TIMING_CHANGED',
          elapsedMs,
          wallClockDeltaMs,
          message: renewalFailed
            ? `Local execution ownership was lost (${reason}). Heartbeat interval ${elapsedMs} ms; wall-clock drift ${wallClockDeltaMs} ms. Reconcile the existing remote job; do not replay it.`
            : `Local heartbeat interval ${elapsedMs} ms; wall-clock drift ${wallClockDeltaMs} ms. This does not establish the remote command outcome.`
        })
      } catch {}
    }
  }, 10000)
  timer.unref()
  return {
    check () { if (failure) throw failure },
    stop () { clearInterval(timer) }
  }
}
