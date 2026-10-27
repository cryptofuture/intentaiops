import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

test('remote recovery browser ignores stale host proposals and submits only the displayed host decision', async () => {
  const elements = new Map()
  const element = () => ({ hidden: true, value: '', textContent: '', children: [], append (child) { this.children.push(child) }, replaceChildren () { this.children = [] } })
  const get = id => {
    if (!elements.has(id)) elements.set(id, element())
    return elements.get(id)
  }
  const requests = []
  let releaseOld
  const response = value => ({ ok: true, json: async () => value })
  const context = {
    document: { getElementById: get, createElement: element, querySelectorAll: () => [] },
    location: { hash: '#' + 'a'.repeat(64) },
    history: { replaceState () {} },
    EventSource: class { close () {} },
    confirm: () => true,
    fetch: async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : null
      requests.push({ url, body })
      if (url === '/session') return response({ csrf: 'c'.repeat(64), actions: true })
      if (url === '/snapshot') return response({ hosts: [{ id: 'first', tasks: [] }, { id: 'second', tasks: [] }], clusters: [], runs: [] })
      if (url.startsWith('/remote-tasks?')) return response({ executions: [{ executionId: 'b'.repeat(32), sequence: 4 }] })
      if (url.startsWith('/remote-task?')) return response({ records: [{ catalogId: 'systemd-service' }] })
      if (body?.action === 'prepare-remote-recovery') {
        if (body.hostId === 'first') return new Promise(resolve => { releaseOld = () => resolve(response({ taskId: 11, fingerprint: '1'.repeat(64), stateVersion: 'old', ownership: { owned: false } })) })
        return response({ taskId: 22, fingerprint: '2'.repeat(64), stateVersion: 'current', ownership: { owned: false }, plan: { summary: 'Second host trusted cleanup' } })
      }
      if (body?.action === 'execute-remote-recovery') return response({ accepted: true })
      if (url.startsWith('/task?')) return response({ task: { id: 22 } })
      assert.fail('unexpected browser request')
    }
  }
  vm.runInNewContext(await readFile(new URL('../src/operator-console-browser.js', import.meta.url), 'utf8'), context)
  await get('connect').onclick()
  const browse = async host => {
    await get('hosts').children.find(node => node.textContent === `Inspect remote records: ${host}`).onclick()
    await get('remote-records').children[0].onclick()
  }
  await browse('first')
  const oldProposal = get('prepare-remote').onclick()
  await new Promise(resolve => setImmediate(resolve))
  await browse('second')
  releaseOld()
  await oldProposal
  assert.equal(get('execute-remote').hidden, true)
  assert.equal(get('remote-plan').textContent, '')
  assert.ok(!requests.some(request => request.body?.action === 'execute-remote-recovery'))
  await get('prepare-remote').onclick()
  assert.match(get('remote-plan').textContent, /Second host trusted cleanup/u)
  assert.equal(get('execute-remote').hidden, false)
  await get('execute-remote').onclick()
  const execution = requests.find(request => request.body?.action === 'execute-remote-recovery').body
  assert.equal(execution.hostId, 'second')
  assert.equal(execution.taskId, 22)
  assert.equal(execution.expectedVersion, 'current')
  assert.equal(execution.fingerprint, '2'.repeat(64))
  assert.equal(execution.approved, true)
})
