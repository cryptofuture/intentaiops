import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { sanitizePlannerData } from './codex-planner.js'

function equal (left, right) {
  return typeof left === 'string' && /^[a-f0-9]{64}$/u.test(left) && timingSafeEqual(Buffer.from(left), Buffer.from(right))
}

export async function startOperatorConsole ({ controller, port = 0, actions = false }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('invalid console port')
  const token = randomBytes(32).toString('hex')
  const csrf = randomBytes(32).toString('hex')
  const clients = new Set()
  const [html, script] = await Promise.all(['operator-console.html', 'operator-console-browser.js'].map(file => readFile(new URL(`./${file}`, import.meta.url), 'utf8')))
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    const json = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(sanitizePlannerData(value)))
    }
    try {
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'origin denied' })
      const url = new URL(request.url, origin)
      if (request.method === 'GET' && ['/', '/app.js'].includes(url.pathname)) {
        response.setHeader('Content-Type', url.pathname === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8')
        return response.end(url.pathname === '/' ? html : script)
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
        response.setHeader('Set-Cookie', `intent_session=${token}; HttpOnly; SameSite=Strict; Path=/`)
        response.writeHead(200, { 'Content-Type': 'application/json' })
        return response.end(JSON.stringify({ csrf, actions }))
      }
      const cookie = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('intent_session='))?.slice('intent_session='.length)
      if (!equal(cookie, token)) return json(401, { error: 'authentication required' })
      if (request.method === 'GET' && url.pathname === '/snapshot') return json(200, controller.snapshot())
      if (request.method === 'GET' && url.pathname === '/task') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        return response.end(JSON.stringify(controller.inspect(url.searchParams.get('host'), Number(url.searchParams.get('task')))))
      }
      if (request.method === 'GET' && url.pathname === '/export') return json(200, controller.exportRun(Number(url.searchParams.get('run'))))
      if (request.method === 'GET' && url.pathname === '/events') {
        let cursor = Number(request.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0)
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('invalid event cursor')
        if (clients.size >= 16) return json(429, { error: 'too many subscriptions' })
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' })
        response.write(': connected\n\n')
        const send = () => {
          try {
            for (const event of controller.events(cursor)) {
              if (!response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`)) { response.destroy(); break }
              cursor = event.id
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
      const { action, hostId, taskId, expectedVersion, fingerprint } = body
      if (['resume', 'approve', 'rollback', 'resume-run', 'resolve'].includes(action) && body.approved !== true) throw new Error('explicit operator approval required')
      let result
      if (action === 'pause' || action === 'abort') result = controller.control(hostId, taskId, action, expectedVersion)
      else if (action === 'pause-run') result = controller.pauseRun(body.runId, body.serverIds)
      else if (action === 'analyze') result = await controller.analyze(hostId, taskId, body.question)
      else if (action === 'reconcile') result = await controller.reconcile(hostId, taskId, expectedVersion)
      else if (action === 'resolve') result = controller.resolve(hostId, taskId, expectedVersion, body.commandId, body.status, body.evidence, body.rollbackRevision)
      else if (action === 'propose') result = await controller.propose(hostId, taskId, body.instructions, expectedVersion, body.rollback === true)
      else if (action === 'approve') result = controller.approve(hostId, taskId, body.revisionId, expectedVersion, fingerprint)
      else if (['resume', 'rollback', 'resume-run'].includes(action)) {
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
      if (action === 'propose') {
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
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${server.address().port}`
  return { server, origin, url: `${origin}/#${token}`, close: () => new Promise(resolve => { for (const client of clients) client.destroy(); server.closeAllConnections(); server.close(resolve) }) }
}
