import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyFreebsdPodmanBrowser } from '../browser-checks/freebsd-podman-apps.js'

test('new candidate browser checks validate declared markers and bounded application APIs', async () => {
  for (const [application, marker, field, value] of [['ghost', 'GHOST'], ['n8n', 'N8N'], ['mattermost', 'MATTERMOST', 'status', 'OK'], ['jellyfin', 'JELLYFIN', 'Version', '10.11.11']]) {
    for (const valid of field ? [true, false] : [true]) {
      const events = []
      const page = { on: () => {}, route: async () => {}, goto: async () => ({ ok: () => true }), locator: () => ({ waitFor: async () => {} }), getByText: () => ({ first: () => ({ waitFor: async () => {} }) }), screenshot: async () => events.push('screen') }
      const context = { request: { get: async url => ({ status: () => 200, text: async () => `WEBMINAI_${marker}_OK`, json: async () => ({ [field]: valid ? value : 'wrong', ServerName: `WEBMINAI_${marker}_OK`, StartupWizardCompleted: true }) }) }, newPage: async () => page, close: async () => events.push('close') }
      const result = verifyFreebsdPodmanBrowser({ newContext: async () => context }, 'webminai-freebsd-15-1', `${application}-freebsd`)
      if (valid) { await result; assert.deepEqual(events, ['screen', 'close']) } else { await assert.rejects(result, /API identity\/health differs/u); assert.deepEqual(events, ['close']) }
    }
  }
})

test('Jellyfin browser qualification rejects the wrong server or incomplete onboarding', async () => {
  for (const info of [{ Version: '10.11.11', ServerName: 'unrelated', StartupWizardCompleted: true }, { Version: '10.11.11', ServerName: 'WEBMINAI_JELLYFIN_OK', StartupWizardCompleted: false }]) {
    let closed = false
    const context = { request: { get: async () => ({ status: () => 200, text: async () => 'WEBMINAI_JELLYFIN_OK', json: async () => info }) }, newPage: () => assert.fail('Invalid server must not reach browser qualification'), close: async () => { closed = true } }
    await assert.rejects(verifyFreebsdPodmanBrowser({ newContext: async () => context }, 'webminai-freebsd-15-1', 'jellyfin-freebsd'), /identity differs|onboarding is incomplete/u)
    assert.equal(closed, true)
  }
})

test('Magento browser qualification rejects HTTP-200 assets with wrong MIME and unapplied styles', async () => {
  for (const scenario of ['pass', 'css-mime', 'script-mime', 'missing-css', 'unstyled']) {
    const events = []; const handlers = {}
    const page = {
      on: (name, callback) => { handlers[name] = callback },
      route: async () => {},
      goto: async url => {
        assert.equal(url, 'http://192.168.122.31:18108/')
        for (const type of ['script', ...(scenario === 'missing-css' ? [] : ['stylesheet'])]) handlers.response({ url: () => url + (type === 'script' ? 'app.js' : 'app.css'), status: () => 200, request: () => ({ resourceType: () => type }), headers: () => ({ 'content-type': scenario === 'css-mime' && type === 'stylesheet' ? 'application/octet-stream' : scenario === 'script-mime' && type === 'script' ? 'text/html' : type === 'stylesheet' ? 'text/css; charset=utf-8' : 'application/javascript' }) })
        return { ok: () => true }
      },
      getByText: () => ({ first: () => ({ waitFor: async () => {} }) }),
      locator: name => ({ evaluate: async () => { assert.equal(name, 'body'); return scenario !== 'unstyled' } }),
      screenshot: async () => events.push('screenshot')
    }
    const context = { newPage: async () => page, close: async () => events.push('close') }
    const result = verifyFreebsdPodmanBrowser({ newContext: async () => context }, 'webminai-freebsd-15-1', 'magento-freebsd')
    if (scenario === 'pass') await result
    else await assert.rejects(result, scenario === 'missing-css' ? /no loaded stylesheet/u : scenario === 'unstyled' ? /styles are not applied/u : /assets failed/u)
    assert.deepEqual(events, ['screenshot', 'close'])
  }
})

test('application browser checks reject unrelated targets before creating a browser context', async () => {
  const browser = { newContext: () => assert.fail('Must not open unapproved targets') }
  for (const [host, task] of [['production', 'odoo-freebsd'], ['__proto__', 'odoo-freebsd'], ['webminai-freebsd-15-1', 'unknown'], ['webminai-freebsd-15-1', 'constructor']]) {
    await assert.rejects(verifyFreebsdPodmanBrowser(browser, host, task), /Explicit supported lab/u)
  }
})

test('application browser checks preserve failures, close contexts and block external loads', async () => {
  for (const scenario of ['pass', 'public-onboarding', 'asset', 'network', 'http', 'selector']) {
    const events = []; const heads = []; const handlers = {}; let routeHandler
    const page = {
      on: (event, callback) => { handlers[event] = callback },
      route: async (pattern, callback) => { assert.equal(pattern, '**/*'); routeHandler = callback },
      goto: async url => {
        assert.equal(url, 'http://192.168.122.31:18115/')
        for (const [url, expected] of [['http://192.168.122.31:18115/app.js', 'continue'], ['https://external.invalid/font', 'abort']]) {
          await routeHandler({ request: () => ({ url: () => url }), continue: async () => events.push('continue'), abort: async () => events.push('abort') })
          assert.equal(events.at(-1), expected)
        }
        if (scenario === 'asset') handlers.response({ url: () => url + 'app.js', status: () => 404, request: () => ({ resourceType: () => 'script' }) })
        if (scenario === 'network') handlers.requestfailed({ url: () => url + 'app.css', resourceType: () => 'stylesheet' })
        return { ok: () => scenario !== 'http' }
      },
      locator: selector => ({ waitFor: async () => { assert.equal(selector, 'input[type="password"]'); if (scenario === 'selector') throw new Error('Missing login') } }),
      screenshot: async ({ path }) => { assert.ok(path.endsWith('/home-assistant-freebsd-webminai-freebsd-15-1.png')); events.push('screenshot') }
    }
    const context = {
      request: {
        get: async () => ({ status: () => 200, text: async () => 'WEBMINAI_HOME_ASSISTANT_OK\n' }),
        head: async (url, options) => { heads.push(url); assert.equal(options.maxRedirects, 0); return { status: () => scenario === 'public-onboarding' ? 200 : 403 } }
      },
      newPage: async () => page,
      close: async () => events.push('close')
    }
    const check = verifyFreebsdPodmanBrowser({ newContext: async () => context }, 'webminai-freebsd-15-1', 'home-assistant-freebsd')
    if (scenario === 'pass') await check
    else await assert.rejects(check, scenario === 'public-onboarding' ? /first-user/u : ['asset', 'network'].includes(scenario) ? /assets failed/u : scenario === 'http' ? /HTTP failed/u : /Missing login/u)
    assert.equal(events.at(-1), 'close')
    assert.equal(events.includes('screenshot'), scenario !== 'public-onboarding')
    assert.equal(heads.length, scenario === 'public-onboarding' ? 1 : 3)
  }
})
