const contexts = ['system.cpu', 'system.ram', 'disk.space']
export function normalizeMetrics (context, metadata, response) {
  const result = response?.result
  const labels = result?.labels
  const row = result?.data?.[0]
  const units = response?.view?.units ?? metadata?.units
  if (!Array.isArray(labels) || !Array.isArray(row) || row.length !== labels.length || !Number.isFinite(row[0])) return { state: 'unavailable', reason: 'Unsupported or empty metric response' }
  const observedAt = new Date(row[0] * 1000).toISOString()
  const series = labels.slice(1).map((dimension, i) => ({ dimension: String(dimension).slice(0, 160), value: Number.isFinite(row[i + 1]) ? row[i + 1] : null }))
  let percentage = null
  let memoryCalculation = null
  if (context === 'system.cpu' && ['%', 'percentage'].includes(units)) {
    const idle = series.find(s => s.dimension === 'idle')
    if (idle?.value !== null && idle) percentage = 100 - idle.value
    else if (series.length && series.every(s => s.value !== null)) percentage = series.reduce((v, s) => v + s.value, 0)
  }
  if (context === 'system.ram' && ['MiB', 'MB', 'GiB', 'bytes'].includes(units)) {
    const used = series.find(s => s.dimension === 'used')
    const total = series.reduce((v, s) => v + (s.value ?? 0), 0)
    if (used?.value !== null && used && total > 0 && series.every(s => s.value !== null)) percentage = used.value / total * 100
    const freebsdDimensions = ['free', 'active', 'inactive', 'wired', 'cache', 'laundry', 'buffers']
    if (!used && total > 0 && series.length === freebsdDimensions.length && freebsdDimensions.every(name => series.filter(s => s.dimension === name).length === 1) && series.every(s => s.value !== null && s.value >= 0)) {
      percentage = series.filter(s => ['active', 'wired', 'laundry', 'buffers'].includes(s.dimension)).reduce((sum, s) => sum + s.value, 0) / total * 100
      memoryCalculation = 'FreeBSD RAM in use: (active + wired + laundry + buffers) / total reported RAM'
    }
  }
  return { state: Date.now() - Date.parse(observedAt) > 30000 ? 'stale' : 'available', source: 'Netdata /api/v3/data', context, units: String(units ?? 'unknown').slice(0, 32), observedAt, aggregation: context === 'disk.space' ? 'per-filesystem dimensions, not a fleet-wide gauge' : 'latest 5-second average' + (memoryCalculation ? '; ' + memoryCalculation : ''), percentage: percentage !== null && percentage >= 0 && percentage <= 100 ? percentage : null, series: series.slice(0, 100) }
}

export class OperatorMetrics {
  constructor (controller) { this.controller = controller; this.cache = new Map(); this.active = 0; this.closed = false }
  async get (hostId) {
    this.controller.assertHost(hostId)
    if (this.closed) throw new Error('Metrics stopped')
    const cached = this.cache.get(hostId)
    if (cached?.pending) return cached.pending
    if (cached && Date.now() < cached.until) return cached.value
    if (this.active >= 4) return { state: 'unavailable', reason: 'Metrics concurrency limit; try again shortly' }
    const entry = { until: 0 }
    this.active++
    const pending = this.controller.withAdmin(hostId, async admin => {
      const server = await admin.serverSecrets({ settings: this.controller.settings, passphrase: this.controller.passphrase, serverId: hostId })
      const client = admin.netdata(server)
      const info = await client.info()
      const agents = info.agents ?? []
      const local = agents.find(agent => agent.ai === 0) ?? (agents.length === 1 ? agents[0] : null)
      const sourceNode = local?.mg ?? info.machine_guid
      if (typeof sourceNode !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(sourceNode)) return { state: 'unavailable', reason: 'Netdata local node identity is unavailable; host metrics cannot be attributed safely' }
      const discovered = await client.contexts()
      const available = discovered.contexts ?? discovered
      const values = []
      for (const context of contexts) {
        if (!Object.hasOwn(available, context)) { values.push({ context, state: 'unavailable', reason: 'Collector is not available' }); continue }
        try {
          const grouping = context === 'disk.space' ? 'instance,dimension' : 'dimension'
          const response = await client.getJson(`/api/v3/data?scope_nodes=${sourceNode}&contexts=${context}&after=-5&points=1&group=average&group_by=${grouping}&format=json&options=jsonwrap`)
          if (Array.isArray(response.summary?.nodes) && response.summary.nodes.some(node => node.mg && node.mg !== sourceNode)) throw new Error('Ambiguous node attribution')
          values.push(normalizeMetrics(context, available[context], response))
        } catch { values.push({ context, state: 'unavailable', reason: 'Collector query failed' }) }
      }
      return { state: 'available', sampledAt: new Date().toISOString(), sourceNode, values }
    }).catch(() => ({ state: 'unavailable', reason: 'Netdata monitoring is not reachable' })).finally(() => { this.active-- })
    entry.pending = pending
    this.cache.set(hostId, entry)
    const value = await pending
    entry.value = value; entry.pending = null; entry.until = Date.now() + (value.state === 'available' ? 5000 : 15000)
    return value
  }

  close () { this.closed = true; this.cache.clear() }
}
