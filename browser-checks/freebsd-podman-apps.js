import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'

const hosts = { 'webminai-freebsd-14-4': '192.168.122.18', 'webminai-freebsd-15-1': '192.168.122.31' }
const applications = {
  'odoo-freebsd': { port: 18112, path: '/web/login', selector: 'input[name="login"]', marker: 'WEBMINAI_ODOO_OK' },
  'home-assistant-freebsd': { port: 18115, path: '/', selector: 'input[type="password"]', marker: 'WEBMINAI_HOME_ASSISTANT_OK' },
  'magento-freebsd': { port: 18108, path: '/', marker: 'WEBMINAI_MAGENTO_OK' },
  'ghost-freebsd': { port: 18110, path: '/blog/', selector: 'body', marker: 'WEBMINAI_GHOST_OK', markerPath: '/' },
  'n8n-freebsd': { port: 18109, path: '/', marker: 'WEBMINAI_N8N_OK', markerPath: '/' },
  'mattermost-freebsd': { port: 18111, path: '/', marker: 'WEBMINAI_MATTERMOST_OK', markerPath: '/', apiPath: '/api/v4/system/ping', apiField: 'status', apiValue: 'OK' },
  'jellyfin-freebsd': { port: 18113, path: '/jellyfin/web/index.html', selector: '#txtManualPassword', marker: 'WEBMINAI_JELLYFIN_OK', markerPath: '/', apiPath: '/jellyfin/System/Info/Public', apiField: 'Version', apiValue: '10.11.11' }
}

export async function verifyFreebsdPodmanBrowser (browser, hostId, catalogId) {
  assert.ok(Object.hasOwn(hosts, hostId) && Object.hasOwn(applications, catalogId), 'Explicit supported lab host/application required')
  const application = applications[catalogId]
  const origin = `http://${hosts[hostId]}:${application.port}`
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  try {
    if (catalogId !== 'magento-freebsd') {
      const health = await context.request.get(origin + (application.markerPath ?? '/__intentaiops-health'), { timeout: 10000, maxRedirects: 0 })
      assert.equal(health.status(), 200)
      assert.equal((await health.text()).trim(), application.marker)
    }
    if (application.apiPath) {
      const response = await context.request.get(origin + application.apiPath, { timeout: 10000, maxRedirects: 0 })
      assert.equal(response.status(), 200)
      const info = await response.json()
      assert.equal(info[application.apiField], application.apiValue, 'Application API identity/health differs')
      if (catalogId === 'jellyfin-freebsd') {
        assert.equal(info.ServerName, application.marker, 'Jellyfin server identity differs')
        assert.equal(info.StartupWizardCompleted, true, 'Jellyfin onboarding is incomplete')
      }
    }
    if (catalogId === 'home-assistant-freebsd') {
      for (const path of ['/api/onboarding/users', '/homeassistant/api/onboarding/users', '/%61pi/onboarding/users']) {
        const response = await context.request.head(origin + path, { timeout: 10000, maxRedirects: 0 })
        assert.equal(response.status(), 403, 'Public first-user creation must remain blocked')
      }
    }
    const page = await context.newPage()
    const failures = []
    let stylesheets = 0
    page.on('response', response => {
      if (new URL(response.url()).origin !== origin) return
      const type = response.request().resourceType()
      const pathname = new URL(response.url()).pathname
      if (response.status() >= 400 && ['script', 'stylesheet', 'font'].includes(type)) failures.push(pathname + ': ' + response.status())
      if (response.status() === 200 && ['stylesheet', 'script'].includes(type)) {
        const mime = response.headers()['content-type']?.split(';')[0].trim().toLowerCase()
        const valid = type === 'stylesheet' ? mime === 'text/css' : ['text/javascript', 'application/javascript', 'application/ecmascript', 'text/ecmascript'].includes(mime)
        if (!valid) failures.push(pathname + ': invalid asset MIME type')
        else if (type === 'stylesheet') stylesheets++
      }
    })
    page.on('requestfailed', request => {
      if (new URL(request.url()).origin === origin && ['script', 'stylesheet', 'font'].includes(request.resourceType())) failures.push(new URL(request.url()).pathname + ': network failure')
    })
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    const directory = 'artifacts/browser-screenshots/freebsd-apps'
    await mkdir(directory, { recursive: true })
    try {
      const response = await page.goto(origin + application.path, { waitUntil: 'networkidle', timeout: 60000 })
      assert.ok(response?.ok(), 'Application frontend HTTP failed')
      if (application.selector) await page.locator(application.selector).waitFor({ state: 'visible', timeout: 60000 })
      else await page.getByText(application.marker, { exact: false }).first().waitFor({ state: 'visible', timeout: 60000 })
      assert.deepEqual(failures, [], 'Critical same-origin application assets failed')
      if (catalogId === 'magento-freebsd') {
        assert.ok(stylesheets > 0, 'Magento has no loaded stylesheet')
        assert.ok(await page.locator('body').evaluate(element => element.ownerDocument.defaultView.getComputedStyle(element).fontFamily.includes('Open Sans')), 'Magento storefront theme styles are not applied')
      }
    } finally {
      await page.screenshot({ path: `${directory}/${catalogId}-${hostId}.png`, fullPage: true })
    }
  } finally { await context.close() }
}
