import { createServer } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, readdir, lstat } from 'node:fs/promises'
import path from 'node:path'
import { UiPreferences } from './ui-preferences.js'

function equal (left, right) {
  return typeof left === 'string' && /^[a-f0-9]{64}$/u.test(left) && timingSafeEqual(Buffer.from(left), Buffer.from(right))
}

export async function startOperatorConsole ({ controller, port = 0, actions = false, workspace }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('invalid console port')
  const token = randomBytes(32).toString('hex')
  const csrf = randomBytes(32).toString('hex')
  const clients = new Set()
  const cookieName = `intent_session_${randomBytes(8).toString('hex')}`
  const mount = `/workspace/${randomBytes(16).toString('hex')}/`
  const preferences = new UiPreferences(path.dirname(controller.databasePath))
  const assets = new Map()
  const root = new URL('./operator-web/', import.meta.url)
  const loadAssets = async (directory, prefix = '') => {
    for (const name of await readdir(directory)) {
      const file = new URL(name, directory)
      const stat = await lstat(file)
      if (stat.isSymbolicLink()) throw new Error('Unsafe web asset')
      if (stat.isDirectory()) await loadAssets(new URL(name + '/', directory), prefix + name + '/')
      else assets.set('/' + prefix + name, await readFile(file))
    }
  }
  await loadAssets(root)
  const [html, script] = await Promise.all(['operator-console.html', 'operator-console-browser.js'].map(file => readFile(new URL(`./${file}`, import.meta.url), 'utf8')))
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    const json = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(controller.sanitize(value)))
    }
    try {
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'origin denied' })
      const url = new URL(request.url, origin)
      if (url.pathname.startsWith(mount)) url.pathname = '/' + url.pathname.slice(mount.length)
      if (request.method === 'GET' && (['/', '/app.js'].includes(url.pathname) || assets.has(url.pathname))) {
        const name = url.pathname === '/' ? '/index.html' : url.pathname
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain', '.wasm': 'application/wasm' }
        response.setHeader('Content-Type', types[path.extname(name)] ?? 'application/octet-stream')
        return response.end(assets.get(name) ?? (url.pathname === '/' ? html : script))
      }
      let body
      if (request.method === 'POST') {
        if (request.headers['content-type'] !== 'application/json') return json(415, { error: 'JSON required' })
        const chunks = []
        let length = 0
        for await (const chunk of request) {
          length += chunk.length
          if (length > 32768) throw new Error('request exceeds 32 KiB')
          chunks.push(chunk)
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }
      if (url.pathname === '/session' && request.method === 'POST') {
        if (!equal(body?.token, token)) return json(401, { error: 'authentication required' })
        response.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=${mount}`)
        response.writeHead(200, { 'Content-Type': 'application/json' })
        return response.end(JSON.stringify({ csrf, actions }))
      }
      const cookie = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1)
      if (!equal(cookie, token)) return json(401, { error: 'authentication required' })
      if (workspace?.stopping && ['/catalog', '/metrics', '/inventory', '/cluster', '/remote-task', '/remote-tasks'].includes(url.pathname)) return json(503, { error: 'Workspace is shutting down; no new remote observations are accepted' })
      if (request.method === 'GET' && url.pathname === '/session') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        return response.end(JSON.stringify({ csrf, actions }))
      }
      if (['/shells', '/shell', '/shell-events'].includes(url.pathname) && workspace) {
        if (!actions) return json(403, { error: 'console is read-only' })
        if (workspace.stopping) return json(503, { error: 'Workspace is shutting down' })
        if (url.pathname === '/shells' && request.method === 'GET') return json(200, workspace.shells.list())
        if (url.pathname === '/shell' && request.method === 'POST') {
          if (!equal(request.headers['x-intent-csrf'], csrf)) return json(403, { error: 'CSRF check failed' })
          if (!body || Object.keys(body).some(key => !['action', 'id', 'hostId', 'hostVersion', 'requestKey', 'approved', 'cols', 'rows', 'data', 'sequence'].includes(key))) throw new Error('Invalid shell request')
          if (body.action === 'open') return json(200, await workspace.shells.open(body))
          if (body.action === 'input') return json(200, workspace.shells.input(body))
          if (body.action === 'resize') return json(200, workspace.shells.resize(body))
          if (body.action === 'close') { if (body.approved !== true) throw new Error('Explicit shell close approval required'); return json(200, await workspace.shells.end(body.id)) }
          throw new Error('Unsupported shell action')
        }
        if (url.pathname === '/shell-events' && request.method === 'GET') {
          const id = url.searchParams.get('id')
          let cursor = Number(request.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0)
          workspace.shells.events(id, cursor)
          if (clients.size >= 16) return json(429, { error: 'too many subscriptions' })
          response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' })
          response.write(': private interactive shell\n\n')
          let waiting = false
          const send = () => {
            if (waiting || response.destroyed) return
            try {
              const page = workspace.shells.events(id, cursor)
              if (page.gap) response.write('event: gap\ndata: {}\n\n')
              for (const event of page.events) {
                const ready = response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`)
                cursor = event.id
                if (!ready) { waiting = true; response.once('drain', () => { waiting = false; send() }); break }
              }
            } catch { response.destroy() }
          }
          clients.add(response); send()
          const timer = setInterval(send, 100); timer.unref()
          request.on('close', () => { clearInterval(timer); clients.delete(response) })
          return
        }
        return json(404, { error: 'not found' })
      }
      if (request.method === 'GET' && url.pathname === '/preferences') return json(200, preferences.get())
      if (request.method === 'POST' && url.pathname === '/preferences') {
        if (!equal(request.headers['x-intent-csrf'], csrf)) return json(403, { error: 'CSRF check failed' })
        const saved = preferences.save(body.version, body.patch)
        controller.record({ type: 'ui_preferences_changed', preferenceVersion: saved.version })
        return json(200, saved)
      }
      if (request.method === 'GET' && url.pathname === '/workspace') {
        controller.events(0, 1000)
        const cursor = controller.database(db => db.prepare('SELECT coalesce(max(id),0) AS id FROM events').get().id)
        const snapshot = controller.snapshot()
        response.writeHead(200, { 'Content-Type': 'application/json' })
        return response.end(JSON.stringify({ ...snapshot, cursor, notice: workspace?.notice ?? null, operations: workspace?.operations() ?? [], hostStates: controller.sanitize(Object.fromEntries(workspace?.hosts?.states ?? [])) }))
      }
      if (request.method === 'GET' && url.pathname === '/operation' && workspace) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        return response.end(JSON.stringify(workspace.operation(url.searchParams.get('id'))))
      }
      if (request.method === 'GET' && url.pathname === '/catalog' && workspace) return json(200, await workspace.catalog(url.searchParams.get('host')))
      if (request.method === 'GET' && url.pathname === '/cluster' && workspace) return json(200, await workspace.cluster(url.searchParams.get('id')))
      if (request.method === 'GET' && url.pathname === '/cluster-task' && workspace) {
        const view = await controller.kubernetesTasks.inspect(url.searchParams.get('cluster'), Number(url.searchParams.get('task')))
        response.writeHead(200, { 'Content-Type': 'application/json' })
        return response.end(JSON.stringify(view))
      }
      if (request.method === 'GET' && url.pathname === '/cluster-recovery' && workspace) return json(200, await controller.kubernetesTasks.remoteHistory(url.searchParams.get('cluster')))
      if (request.method === 'GET' && url.pathname === '/metrics' && workspace) return json(200, await workspace.metrics.get(url.searchParams.get('host')))
      if (request.method === 'GET' && url.pathname === '/inventory' && workspace) return json(200, await controller.withAdmin(url.searchParams.get('host'), admin => admin.refreshInventory({ settings: controller.settings, passphrase: controller.passphrase, serverId: url.searchParams.get('host') })))
      if (request.method === 'POST' && url.pathname === '/operation' && workspace) {
        if (!actions) return json(403, { error: 'console is read-only' })
        if (!equal(request.headers['x-intent-csrf'], csrf)) return json(403, { error: 'CSRF check failed' })
        return json(202, workspace.submit(body))
      }
      if (request.method === 'GET' && url.pathname === '/snapshot') return json(200, controller.snapshot())
      if (request.method === 'GET' && url.pathname === '/history') {
        const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER)
        if (!Number.isSafeInteger(before) || before < 1) throw new Error('Invalid history cursor')
        return json(200, controller.database(db => db.prepare('SELECT id,payload FROM events WHERE id < ? ORDER BY id DESC LIMIT 300').all(before).reverse().map(row => ({ ...JSON.parse(row.payload), id: row.id }))))
      }
      if (request.method === 'GET' && url.pathname === '/remote-tasks') return json(200, await controller.remoteCommonTasks(url.searchParams.get('host'), url.searchParams.get('after') ?? ''))
      if (request.method === 'GET' && url.pathname === '/remote-task') return json(200, await controller.inspectRemoteCommonTask(url.searchParams.get('host'), url.searchParams.get('execution')))
      if (request.method === 'GET' && url.pathname === '/task') {
        const view = controller.inspect(url.searchParams.get('host'), Number(url.searchParams.get('task')))
        if (url.searchParams.get('projection') === 'review') delete view.task.results
        response.writeHead(200, { 'Content-Type': 'application/json' })
        return response.end(JSON.stringify(view))
      }
      if (request.method === 'GET' && url.pathname === '/task-results') {
        const host = url.searchParams.get('host')
        controller.assertHost(host)
        const offset = Number(url.searchParams.get('after') ?? 0)
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new Error('Invalid results cursor')
        const results = controller.tasks.get(host, Number(url.searchParams.get('task'))).results ?? []
        return json(200, { items: results.slice(offset, offset + 20), nextCursor: offset + 20 < results.length ? offset + 20 : null, outputPolicy: 'Raw stdout/stderr are withheld; native statuses and redacted diagnostics only' })
      }
      if (request.method === 'GET' && url.pathname === '/export') return json(200, controller.exportRun(Number(url.searchParams.get('run'))))
      if (request.method === 'GET' && url.pathname === '/events') {
        let cursor = Number(request.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0)
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('invalid event cursor')
        if (clients.size >= 16) return json(429, { error: 'too many subscriptions' })
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' })
        response.write(': connected\n\n')
        let waitingForDrain = false
        let lastNotice = null
        const send = () => {
          if (waitingForDrain || response.destroyed) return
          try {
            if (workspace?.notice && workspace.notice !== lastNotice) { lastNotice = workspace.notice; response.write(`event: workspace-status\ndata: ${JSON.stringify({ notice: lastNotice })}\n\n`) }
            for (const event of controller.events(cursor)) {
              const ready = response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`)
              cursor = event.id
              if (!ready) {
                waitingForDrain = true
                response.once('drain', () => { waitingForDrain = false; send() })
                break
              }
            }
          } catch { response.destroy() }
        }
        clients.add(response)
        send()
        const timer = setInterval(send, 1000)
        timer.unref()
        request.on('close', () => { clearInterval(timer); clients.delete(response) })
        return
      }
      if (request.method !== 'POST' || url.pathname !== '/action') return json(404, { error: 'not found' })
      if (!actions) return json(403, { error: 'console is read-only' })
      if (!equal(request.headers['x-intent-csrf'], csrf)) return json(403, { error: 'CSRF check failed' })
      if (workspace) return json(202, workspace.submit({ ...body, action: ({ 'resume-run': 'run-resume', 'pause-run': 'run-pause' })[body.action] ?? body.action, requestKey: body.requestKey ?? randomUUID() }))
      const { action, hostId, taskId, expectedVersion, fingerprint } = body
      if (['resume', 'approve', 'rollback', 'resume-run', 'resolve', 'execute-remote-recovery'].includes(action) && body.approved !== true) throw new Error('explicit operator approval required')
      let result
      if (action === 'pause' || action === 'abort') result = controller.control(hostId, taskId, action, expectedVersion)
      else if (action === 'pause-run') result = controller.pauseRun(body.runId, body.serverIds)
      else if (action === 'analyze') result = await controller.analyze(hostId, taskId, body.question)
      else if (action === 'reconcile') result = await controller.reconcile(hostId, taskId, expectedVersion)
      else if (action === 'resolve') result = controller.resolve(hostId, taskId, expectedVersion, body.commandId, body.status, body.evidence, body.rollbackRevision)
      else if (action === 'propose') result = await controller.propose(hostId, taskId, body.instructions, expectedVersion, body.rollback === true)
      else if (action === 'approve') result = controller.approve(hostId, taskId, body.revisionId, expectedVersion, fingerprint)
      else if (action === 'prepare-remote-recovery') result = await controller.prepareRemoteRecovery(hostId, body.executionId)
      else if (action === 'execute-remote-recovery') {
        controller.checkVersion(hostId, taskId, expectedVersion)
        const operation = controller.executeRemoteRecovery(hostId, taskId, expectedVersion, fingerprint, { approved: body.approved, takeoverApproved: body.takeoverApproved, takeoverFingerprint: body.takeoverFingerprint })
        operation.catch(error => controller.record({ type: 'operator_action_failed', hostId, taskId, message: String(error.message) }))
        result = { accepted: true, action }
      } else if (['resume', 'rollback', 'resume-run'].includes(action)) {
        if (action !== 'resume-run') controller.checkVersion(hostId, taskId, expectedVersion)
        else {
          if (!Array.isArray(body.decisions) || !body.decisions.length) throw new Error('select participating hosts')
          for (const decision of body.decisions) controller.checkVersion(decision.hostId, decision.taskId, decision.expectedVersion)
        }
        const operation = action === 'resume'
          ? controller.resume(hostId, taskId, expectedVersion, fingerprint)
          : action === 'rollback'
            ? controller.rollback(hostId, taskId, expectedVersion, fingerprint, body.revisionId)
            : controller.resumeRun(body.runId, body.decisions)
        operation.catch(error => controller.record({ type: 'operator_action_failed', hostId, taskId, message: String(error.message) }))
        result = { accepted: true, action }
      } else throw new Error('unsupported operator action')
      if (action === 'propose' || action === 'prepare-remote-recovery') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        return response.end(JSON.stringify(result))
      }
      return json(200, result)
    } catch (error) {
      return json(409, { error: String(error.message) })
    }
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  await new Promise((resolve, reject) => { server.once('error', error => reject(new Error(error.code === 'EADDRINUSE' ? `Web port ${port} is already occupied` : error.message))); server.listen(port, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${server.address().port}`
  return { server, origin, url: `${origin}${mount}#${token}`, close: async () => { await workspace?.close(); return new Promise(resolve => { for (const client of clients) client.destroy(); server.closeAllConnections(); server.close(resolve) }) } }
}
