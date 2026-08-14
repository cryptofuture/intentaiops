import assert from 'node:assert/strict'
import test from 'node:test'
import { kubernetesCommonTask, listKubernetesCommonTasks } from '../src/kubernetes-common-task-catalog.js'

test('Kubernetes catalog mirrors every ismet application without exposing host runtime installation', () => {
  const tasks = listKubernetesCommonTasks()
  assert.deepEqual(tasks.map(task => task.id), [
    'nginx-static-site-kubernetes',
    'wordpress-kubernetes',
    'woocommerce-kubernetes',
    'joomla-kubernetes',
    'drupal-kubernetes',
    'prestashop-kubernetes',
    'moodle-kubernetes',
    'magento-kubernetes',
    'n8n-kubernetes',
    'ghost-kubernetes',
    'mattermost-kubernetes',
    'odoo-kubernetes',
    'jellyfin-kubernetes',
    'home-assistant-kubernetes'
  ])
  assert.equal(tasks.some(task => task.id === 'docker-linux'), false)
  assert.equal(tasks.every(task => task.platform === 'kubernetes'), true)
  assert.equal(tasks.every(task => task.images.length > 0), true)
  assert.equal(tasks.every(task => task.foundationIds.includes('kubernetes-api-workload')), true)
})

test('Kubernetes application metadata retains source catalog and pinned image provenance', () => {
  const wordpress = kubernetesCommonTask('wordpress-kubernetes')
  assert.equal(wordpress.sourceCatalogId, 'wordpress-linux')
  assert.equal(wordpress.sourceRoute, 'ismet-compose')
  assert.equal(wordpress.version, '7.0.2')
  assert.deepEqual(wordpress.images, [
    'wordpress:7.0.2-php8.3-fpm',
    'wordpress:cli-2.12.0-php8.3',
    'nginx:1.30.4-alpine',
    'mariadb:11.8.8'
  ])
  assert.throws(() => kubernetesCommonTask('docker-linux'), /unknown Kubernetes common task/u)
})
