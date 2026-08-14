import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const EXPECTED = [
  ['wordpress', 'WordPress', 'WEBMINAI_WORDPRESS_OK'],
  ['woocommerce', 'WooCommerce', 'WEBMINAI_WOOCOMMERCE_OK'],
  ['joomla', 'Joomla', 'WEBMINAI_JOOMLA_OK'],
  ['drupal', 'Drupal', 'WEBMINAI_DRUPAL_OK'],
  ['prestashop', 'PrestaShop', 'WEBMINAI_PRESTASHOP_OK'],
  ['moodle', 'Moodle', 'WEBMINAI_MOODLE_OK'],
  ['nextcloud', 'Nextcloud', 'WEBMINAI_NEXTCLOUD_OK'],
  ['magento', 'Magento Open Source', 'WEBMINAI_MAGENTO_OK'],
  ['n8n', 'n8n', 'WEBMINAI_N8N_OK'],
  ['ghost', 'Ghost', 'WEBMINAI_GHOST_OK'],
  ['mattermost', 'Mattermost', 'WEBMINAI_MATTERMOST_OK'],
  ['odoo', 'Odoo Community', 'WEBMINAI_ODOO_OK'],
  ['jellyfin', 'Jellyfin', 'WEBMINAI_JELLYFIN_OK'],
  ['vaultwarden', 'Vaultwarden', 'WEBMINAI_VAULTWARDEN_OK'],
  ['home-assistant', 'Home Assistant', 'WEBMINAI_HOME_ASSISTANT_OK'],
  ['immich', 'Immich', 'WEBMINAI_IMMICH_OK'],
  ['discourse', 'Discourse', 'WEBMINAI_DISCOURSE_OK'],
  ['gitlab', 'GitLab Community Edition', 'WEBMINAI_GITLAB_OK'],
  ['coolify', 'Coolify', 'WEBMINAI_COOLIFY_OK'],
  ['plesk', 'Plesk', 'WEBMINAI_PLESK_OK']
]

test('top-20 runbook and Linux validator share the learning-wave order', async () => {
  const [runbook, validator] = await Promise.all([
    readFile(new URL('../top-20-cross-platform-codex-tasks.md', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/validate-top20-linux.js', import.meta.url), 'utf8')
  ])
  const headings = [...runbook.matchAll(/^## (\d+)\. (.+)$/gmu)]
  assert.deepEqual(headings.map(match => [Number(match[1]), match[2]]), EXPECTED.map((item, index) => [index + 1, item[1]]))

  for (const [index, item] of EXPECTED.entries()) {
    const start = headings[index].index
    const end = headings[index + 1]?.index ?? runbook.indexOf('\n## Results to record', start)
    assert.match(runbook.slice(start, end), new RegExp(`\\b${item[2]}\\b`, 'u'))
  }

  const applicationList = validator.match(/const APPLICATIONS = \[([\s\S]*?)\n\]\.map/u)
  assert.ok(applicationList)
  const tuples = [...applicationList[1].matchAll(/\['([^']+)', '([^']+)', '([^']+)'\]/gu)]
    .map(match => match.slice(1))
  assert.deepEqual(tuples, EXPECTED)
})

test('Magento resource override is explicit and remains lab-scoped', async () => {
  const validator = await readFile(new URL('../scripts/validate-top20-linux.js', import.meta.url), 'utf8')
  const planner = await readFile(new URL('../src/codex-planner.js', import.meta.url), 'utf8')

  assert.match(validator, /--force-resource-run is available only with --task=magento/u)
  assert.match(validator, /WEBMINAI_FORCE_RESOURCE_RUN/u)
  assert.match(validator, /forceResourceRun \? 1 : 3/u)
  assert.match(validator, /Do not create or remove swap/u)
  assert.match(planner, /authorized Magento lab stress test requires an executable changing plan and a complete revert/u)
  assert.match(planner, /installs OpenSearch before generating its protected bootstrap credential/u)
  assert.match(planner, /set OPENSEARCH_INITIAL_ADMIN_PASSWORD in the same independently executed apt command/u)
  assert.match(planner, /reclassifies task-owned partial Magento state as pre-existing/u)
  assert.match(planner, /without first configuring the official OpenSearch apt repository/u)
  assert.match(planner, /double-escapes an SQL backtick/u)
  assert.match(validator, /php8\.3-bcmath/u)
  assert.match(validator, /2\.4\.8-p5\.tar\.gz/u)
})
