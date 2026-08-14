import { wordpressComposeRelease } from './wordpress-compose-task.js'
import { wooCommerceRelease } from './woocommerce-task.js'
import { joomlaRelease } from './joomla-task.js'
import { drupalRelease } from './drupal-task.js'
import { prestaShopRelease } from './prestashop-task.js'
import { moodleRelease } from './moodle-task.js'
import { magentoComposeRelease } from './magento-task.js'
import { n8nRelease } from './n8n-task.js'
import { ghostRelease } from './ghost-task.js'
import { mattermostRelease } from './mattermost-task.js'
import { odooRelease } from './odoo-task.js'
import { jellyfinRelease } from './jellyfin-task.js'
import { homeAssistantRelease } from './home-assistant-task.js'

const APPLICATIONS = Object.freeze([
  application('wordpress', 'WordPress', 18101, wordpressComposeRelease),
  application('woocommerce', 'WooCommerce', 18102, () => {
    const wordpress = wordpressComposeRelease()
    const plugin = wooCommerceRelease()
    return { version: plugin.version, images: wordpress.images }
  }),
  application('joomla', 'Joomla', 18103, () => releaseWithSharedImages(joomlaRelease(), ['nginx:1.30.4-alpine', 'mariadb:11.8.8'])),
  application('drupal', 'Drupal', 18104, () => releaseWithSharedImages(drupalRelease(), ['nginx:1.30.4-alpine', 'mariadb:11.8.8'])),
  application('prestashop', 'PrestaShop', 18105, () => releaseWithSharedImages(prestaShopRelease(), ['nginx:1.30.4-alpine', 'mariadb:11.8.8'])),
  application('moodle', 'Moodle', 18106, () => {
    const release = moodleRelease()
    return { ...release, images: [release.phpImage, 'nginx:1.30.4-alpine', 'mariadb:11.8.8'] }
  }),
  application('magento', 'Magento Open Source', 18108, magentoComposeRelease),
  application('n8n', 'n8n', 18109, () => {
    const release = n8nRelease()
    return { ...release, images: [release.image, release.nginxImage] }
  }),
  application('ghost', 'Ghost', 18110, ghostRelease),
  application('mattermost', 'Mattermost', 18111, mattermostRelease),
  application('odoo', 'Odoo Community', 18112, odooRelease),
  application('jellyfin', 'Jellyfin', 18113, jellyfinRelease),
  application('home-assistant', 'Home Assistant', 18115, homeAssistantRelease)
])

const NGINX = Object.freeze({
  id: 'nginx-static-site-kubernetes',
  label: 'Deploy a verified nginx static website on Kubernetes',
  description: 'Deploy a namespace-scoped nginx workload and verify its Service from every ready cluster node.',
  category: 'application',
  platform: 'kubernetes',
  sourceCatalogId: 'nginx-static-site',
  sourceRoute: 'linux-nginx',
  applicationId: null,
  port: 18080,
  version: '1.30.4',
  images: Object.freeze(['nginx:1.30.4-alpine']),
  foundationIds: Object.freeze(['kubernetes-api-workload', 'service-verification', 'safe-baseline-rollback'])
})

const TASKS = Object.freeze([NGINX, ...APPLICATIONS])

export function listKubernetesCommonTasks () {
  return TASKS.map(task => ({ ...task, images: [...task.images], foundationIds: [...task.foundationIds] }))
}

export function kubernetesCommonTask (catalogId) {
  const task = TASKS.find(candidate => candidate.id === catalogId)
  if (!task) throw new Error(`unknown Kubernetes common task: ${catalogId}`)
  return { ...task, images: [...task.images], foundationIds: [...task.foundationIds] }
}

function application (id, label, port, release) {
  const selected = release()
  return Object.freeze({
    id: `${id}-kubernetes`,
    label: `Deploy a verified ${label} workload on Kubernetes`,
    description: `Adapt the reviewed ismet Docker topology to namespace-scoped Kubernetes resources on service port ${port}.`,
    category: 'application',
    platform: 'kubernetes',
    sourceCatalogId: `${id}-linux`,
    sourceRoute: 'ismet-compose',
    applicationId: id,
    port,
    version: selected.version,
    images: Object.freeze([...selected.images]),
    foundationIds: Object.freeze(['kubernetes-api-workload', 'host-generated-credentials', 'service-verification', 'safe-baseline-rollback'])
  })
}

function releaseWithSharedImages (release, shared) {
  return { ...release, images: [release.image, ...shared] }
}
