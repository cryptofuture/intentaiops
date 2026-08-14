import { buildFreebsdWordpressApplication } from './freebsd-wordpress-task.js'

const VERSION = '11.0.0'
const PLUGIN_URL = `https://downloads.wordpress.org/plugin/woocommerce.${VERSION}.zip`
const PLUGIN_SHA256 = 'ba08c7fc58c98a11f22866269c5832d85c52b664806ec206036f09737ba21666'
const SERVICE_ROOT = '/var/db/webminai/apps/woocommerce'
const CREDENTIALS = '/root/woocommerce_credentials'
const PROJECT = 'webminai-woocommerce-18102'
const MARKER = 'WEBMINAI_WOOCOMMERCE_OK'
const APPLICATION = Object.freeze({
  id: 'woocommerce',
  label: 'WooCommerce',
  serviceRoot: SERVICE_ROOT,
  buildRoot: '/var/db/webminai/image-builds/woocommerce',
  credentials: CREDENTIALS,
  project: PROJECT,
  port: 18102,
  subnet: '10.89.102',
  database: 'webminai_woocommerce',
  marker: MARKER
})

export function buildFreebsdWooCommerceTask (taskId, freebsdExecution) {
  const foundation = buildFreebsdWordpressApplication(taskId, freebsdExecution, APPLICATION, {
    deployId: 'deploy-wordpress-foundation',
    verifyId: 'verify-woocommerce',
    afterDeploy: () => [item('install-woocommerce', installWooCommerce(), `Install and activate digest-pinned WooCommerce ${VERSION}, then create a harmless marker product`, ['deploy-wordpress-foundation'], 1200000, 'job')],
    verifyDependsOn: ['install-woocommerce'],
    verifyCommand: verifyWooCommerce,
    verifyApplied: `${primaryAddress()}; curl --header "Host: $address:18102" --fail --location --silent --show-error --max-time 20 http://10.89.102.3/product/webminai-woocommerce-product/ | grep -Fq ${MARKER}`,
    modifiedFiles: [`${CREDENTIALS}/woocommerce.${VERSION}.zip`, `${SERVICE_ROOT}/www/wp-content/plugins/woocommerce`]
  })
  foundation.plan.summary = 'Deploy a learned reversible native FreeBSD WooCommerce store'
  foundation.plan.changeOverview = `Reuse the reviewed FreeBSD WordPress runtime, install digest-pinned WooCommerce ${VERSION}, and expose an isolated store on port 18102.`
  foundation.plan.assumptions.push(`WooCommerce ${VERSION} reuses the verified WordPress 7.0.2, PHP 8.4, and MariaDB 11.8 FreeBSD foundation.`)
  foundation.plan.warnings.push('WooCommerce setup is deliberately minimal; payment, mail, tax, and shipping integrations are not configured.')
  return foundation
}

function verifyWooCommerce () {
  return `set -eu; ${primaryAddress()}; verify_http() { curl --header "Host: $address:18102" --fail --location --silent --show-error --max-time 20 http://10.89.102.3/product/webminai-woocommerce-product/ | grep -Fq ${MARKER}; }; verify_http; podman restart ${PROJECT}_db_1 ${PROJECT}_wordpress_1 >/dev/null; ready=; for attempt in $(jot 60); do verify_http 2>/dev/null && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]`
}

function installWooCommerce () {
  return `set -eu; artifact=${quote(`${CREDENTIALS}/woocommerce.${VERSION}.zip`)}; if [ ! -f "$artifact" ] || [ "$(sha256 -q "$artifact" 2>/dev/null || true)" != ${quote(PLUGIN_SHA256)} ]; then fetch -qo "$artifact.tmp" ${quote(PLUGIN_URL)}; [ "$(sha256 -q "$artifact.tmp")" = ${quote(PLUGIN_SHA256)} ]; mv -f -- "$artifact.tmp" "$artifact"; fi; chmod 0600 "$artifact"; cat > ${quote(`${SERVICE_ROOT}/www/webminai-woocommerce-install.php`)} <<'PHP'
<?php
require __DIR__ . '/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
$zip = new ZipArchive();
if (!is_dir(WP_PLUGIN_DIR . '/woocommerce')) {
    if ($zip->open('/run/secrets/woocommerce.${VERSION}.zip') !== true) { throw new RuntimeException('WooCommerce archive could not be opened'); }
    if (!$zip->extractTo(WP_PLUGIN_DIR)) { throw new RuntimeException('WooCommerce archive could not be extracted'); }
    $zip->close();
}
$plugin = 'woocommerce/woocommerce.php';
if (!is_plugin_active($plugin)) {
    $error = activate_plugin($plugin, '', false, true);
    if (is_wp_error($error)) { throw new RuntimeException($error->get_error_message()); }
}
$existing = get_page_by_path('webminai-woocommerce-product', OBJECT, 'product');
$values = ['post_type' => 'product', 'post_status' => 'publish', 'post_name' => 'webminai-woocommerce-product', 'post_title' => 'WebminAI WooCommerce Product', 'post_content' => '${MARKER}'];
$product = $existing ? wp_update_post(array_merge($values, ['ID' => $existing->ID]), true) : wp_insert_post($values, true);
if (is_wp_error($product)) { throw new RuntimeException($product->get_error_message()); }
update_post_meta($product, '_regular_price', '1.00');
update_post_meta($product, '_price', '1.00');
update_post_meta($product, '_stock_status', 'instock');
if (!defined('WC_VERSION') || WC_VERSION !== '${VERSION}' || !get_option('woocommerce_db_version')) { throw new RuntimeException('WooCommerce activation verification failed'); }
echo '${MARKER}';
PHP
chmod 0600 ${quote(`${SERVICE_ROOT}/www/webminai-woocommerce-install.php`)}; diagnostics=$(mktemp); initialized=; for attempt in $(jot 3); do if output=$(podman exec ${PROJECT}_wordpress_1 php /srv/wordpress/webminai-woocommerce-install.php 2>"$diagnostics") && [ "$output" = ${quote(MARKER)} ]; then initialized=yes; break; fi; sleep 3; done; rm -f -- ${quote(`${SERVICE_ROOT}/www/webminai-woocommerce-install.php`)}; if [ "$initialized" != yes ]; then cat "$diagnostics" >&2; rm -f -- "$diagnostics"; exit 1; fi; rm -f -- "$diagnostics"; ${primaryAddress()}; ready=; for attempt in $(jot 90); do curl --header "Host: $address:18102" --fail --location --silent --show-error --max-time 10 http://10.89.102.3/product/webminai-woocommerce-product/ 2>/dev/null | grep -Fq ${MARKER} && { ready=yes; break; }; sleep 2; done; [ "$ready" = yes ]`
}

function primaryAddress () {
  return 'interface=$(route -n get default | awk \'/interface:/{print $2; exit}\'); address=$(ifconfig "$interface" inet | awk \'/inet /{print $2; exit}\'); [ -n "$address" ]'
}

function item (id, command, purpose, dependsOn = [], timeoutMs = 300000, executionMode = null) {
  return { id, command, purpose, risk: 'change', timeoutMs, requiresSudo: true, dependsOn, ...(executionMode ? { executionMode } : {}) }
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
