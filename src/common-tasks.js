import { buildWordpressLinuxTask } from './wordpress-linux-task.js'
import { buildWordpressComposeTask } from './wordpress-compose-task.js'
import { buildWooCommerceTask } from './woocommerce-task.js'
import { buildJoomlaTask } from './joomla-task.js'
import { buildDrupalTask } from './drupal-task.js'
import { buildPrestaShopTask } from './prestashop-task.js'
import { buildMoodleTask } from './moodle-task.js'
import { buildMagentoTask } from './magento-task.js'
import { buildN8nTask } from './n8n-task.js'
import { buildGhostTask } from './ghost-task.js'
import { buildMattermostTask } from './mattermost-task.js'
import { buildOdooTask } from './odoo-task.js'
import { buildJellyfinTask } from './jellyfin-task.js'
import { buildHomeAssistantTask } from './home-assistant-task.js'
import { annotateVerifiedPlan, buildFoundationPlanningContext } from './deployment-foundations.js'
import { buildWindowsWordpressComposeTask } from './windows-wordpress-compose-task.js'
import { buildWindowsJoomlaComposeTask } from './windows-joomla-compose-task.js'
import { buildWindowsDrupalComposeTask } from './windows-drupal-compose-task.js'
import { buildWindowsPrestaShopComposeTask } from './windows-prestashop-compose-task.js'
import { buildWindowsMoodleComposeTask } from './windows-moodle-compose-task.js'
import { buildWindowsMagentoComposeTask } from './windows-magento-compose-task.js'
import { buildWindowsN8nComposeTask } from './windows-n8n-compose-task.js'
import { buildWindowsGhostComposeTask } from './windows-ghost-compose-task.js'
import { buildWindowsMattermostComposeTask } from './windows-mattermost-compose-task.js'
import { buildWindowsOdooComposeTask } from './windows-odoo-compose-task.js'
import { buildWindowsJellyfinComposeTask } from './windows-jellyfin-compose-task.js'
import { buildWindowsHomeAssistantComposeTask } from './windows-home-assistant-compose-task.js'
import { buildWindowsDockerBootstrapTask } from './windows-docker-bootstrap-task.js'
import { buildWindowsBraveTask } from './windows-brave-task.js'
import { buildFreebsdWordpressTask } from './freebsd-wordpress-task.js'
import { buildFreebsdWooCommerceTask } from './freebsd-woocommerce-task.js'
import { buildFreebsdJoomlaTask } from './freebsd-joomla-task.js'
import { buildFreebsdDrupalTask } from './freebsd-drupal-task.js'
import { buildFreebsdPrestaShopTask } from './freebsd-prestashop-task.js'
import { buildFreebsdMoodleTask } from './freebsd-moodle-task.js'
import { buildFreebsdNextcloudTask } from './freebsd-nextcloud-task.js'
import { buildFreebsdJellyfinTask } from './freebsd-jellyfin-task.js'
import { buildFreebsdMattermostTask } from './freebsd-mattermost-task.js'
import { buildFreebsdN8nTask } from './freebsd-n8n-task.js'
import { buildFreebsdGhostTask } from './freebsd-ghost-task.js'
import { buildFreebsdOdooTask } from './freebsd-odoo-task.js'
import { buildFreebsdHomeAssistantTask } from './freebsd-home-assistant-task.js'
import { buildFreebsdMagentoTask } from './freebsd-magento-task.js'
import { buildMacosColimaBootstrapTask } from './macos-colima-bootstrap-task.js'
import { buildMacosWordpressComposeTask } from './macos-wordpress-compose-task.js'
import { buildMacosComposeTask } from './macos-compose-task.js'
import { buildLinuxDockerBootstrapTask } from './linux-docker-bootstrap-task.js'
import { buildFreebsdPodmanBootstrapTask } from './freebsd-podman-bootstrap-task.js'
import { applyApplicationDefaults } from './application-defaults.js'
import { buildHostHealthTask } from './host-health-task.js'
import { buildSystemUpdateTask } from './system-update-task.js'
import { buildIntentAiOpsInstallTask } from './intent-ai-ops-install-task.js'

const STATE_ROOT = '/var/lib/webminai/task-state'

/** @type {Array<any>} */
const DEFINITIONS = [
  {
    id: 'nginx-static-site',
    label: 'Deploy an nginx static website',
    description: 'Install nginx if needed and serve a test site on port 18080.',
    build: buildNginxSite
  },
  packageTask('install-htop', 'Install htop', 'htop', '/usr/bin/htop'),
  packageTask('install-jq', 'Install jq', 'jq', '/usr/bin/jq'),
  {
    id: 'system-user',
    label: 'Create a system service user',
    description: 'Create a locked webminai-test-user account.',
    build: buildSystemUser
  },
  {
    id: 'swap-file',
    label: 'Create a 2 GiB lab swap file',
    description: 'Create and activate an isolated test swap file.',
    build: buildSwapFile
  },
  {
    id: 'systemd-service',
    label: 'Install a systemd service',
    description: 'Install and run a reversible oneshot service.',
    build: buildSystemdService
  },
  {
    id: 'systemd-timer',
    label: 'Install a systemd timer',
    description: 'Install and enable a reversible maintenance timer.',
    build: buildSystemdTimer
  },
  {
    id: 'cron-job',
    label: 'Install a cron job',
    description: 'Install a reversible cron.d maintenance entry.',
    build: buildCronJob
  },
  {
    id: 'logrotate-rule',
    label: 'Install a logrotate rule',
    description: 'Create a test log and a reversible rotation policy.',
    build: buildLogrotateRule
  },
  {
    id: 'tmpfiles-rule',
    label: 'Install a tmpfiles rule',
    description: 'Create a managed runtime directory using systemd-tmpfiles.',
    build: buildTmpfilesRule
  },
  healthTask('linux'),
  healthTask('freebsd'),
  healthTask('windows'),
  healthTask('macos'),
  systemUpdateTask('linux'),
  systemUpdateTask('freebsd'),
  systemUpdateTask('windows'),
  {
    id: 'docker-linux',
    label: 'Install Docker Engine and Compose on Linux',
    description: 'Reviewed distro-specific Docker installation with native-container preflight, exact package/path baseline, Compose verification, and rollback.',
    category: 'application',
    platform: 'linux',
    prerequisite: true,
    build: (taskId, definition, options) => ({ ...buildLinuxDockerBootstrapTask(taskId, options.linuxContext, options.docker), definition })
  },
  {
    id: 'wordpress-linux',
    label: 'Deploy a verified WordPress site',
    description: 'Reviewed native/Compose nginx, PHP-FPM socket, MariaDB, credential, health, and rollback profile on port 18101.',
    category: 'application',
    platform: 'linux',
    build: (taskId, definition, options) => ({
      ...(options.docker?.preferred
        ? buildWordpressComposeTask(taskId, options.linuxContext, options.docker)
        : buildWordpressLinuxTask(taskId, options.linuxContext)),
      definition
    })
  },
  {
    id: 'woocommerce-linux',
    label: 'Deploy a verified WooCommerce store',
    description: 'Reviewed WordPress foundation plus pinned WooCommerce initialization, health, credentials, and rollback on port 18102.',
    category: 'application',
    platform: 'linux',
    build: (taskId, definition, options) => ({
      ...buildWooCommerceTask(taskId, options.linuxContext, options.docker),
      definition
    })
  },
  {
    id: 'joomla-linux',
    label: 'Deploy a verified Joomla site',
    description: 'Reviewed native/Compose nginx, PHP-FPM socket, MariaDB, Joomla initialization, credentials, health, and rollback on port 18103.',
    category: 'application',
    build: (taskId, definition, options) => ({
      ...buildJoomlaTask(taskId, options.linuxContext, options.docker),
      definition
    })
  },
  {
    id: 'drupal-linux',
    label: 'Deploy a verified Drupal site',
    description: 'Reviewed native/Compose nginx, PHP-FPM socket, MariaDB, Drupal initialization, cron, health, and rollback on port 18104.',
    category: 'application',
    build: (taskId, definition, options) => ({
      ...buildDrupalTask(taskId, options.linuxContext, options.docker),
      definition
    })
  },
  {
    id: 'prestashop-linux',
    label: 'Deploy a verified PrestaShop store',
    description: 'Reviewed native/Compose nginx, PHP-FPM socket, MariaDB, PrestaShop initialization, credentials, health, and rollback on port 18105.',
    category: 'application',
    build: (taskId, definition, options) => ({
      ...buildPrestaShopTask(taskId, options.linuxContext, options.docker),
      definition
    })
  },
  {
    id: 'moodle-linux',
    label: 'Deploy a verified Moodle site',
    description: 'Reviewed native/Compose nginx, PHP-FPM socket, MariaDB, off-web data, cron, credentials, health, and rollback on port 18106.',
    category: 'application',
    build: (taskId, definition, options) => ({
      ...buildMoodleTask(taskId, options.linuxContext, options.docker),
      definition
    })
  },
  {
    id: 'magento-linux',
    label: 'Deploy a verified Magento Open Source store',
    description: 'Reviewed Magento Compose PHP, database, OpenSearch, cron, credentials, health, resource, and rollback matrix on port 18108.',
    category: 'application',
    build: (taskId, definition, options) => ({
      ...buildMagentoTask(taskId, options.linuxContext, options.docker),
      definition
    })
  },
  {
    id: 'n8n-linux',
    label: 'Deploy a verified n8n automation service',
    description: 'Reviewed native/Compose Node.js, persistent SQLite, encryption-key, webhook, nginx, health, and rollback profile on port 18109.',
    category: 'application',
    build: (taskId, definition, options) => ({
      ...buildN8nTask(taskId, options.linuxContext, options.docker),
      definition
    })
  },
  {
    id: 'ghost-linux',
    label: 'Deploy a verified Ghost publishing service',
    description: 'Reviewed Ghost 6 Node.js 22, MySQL 8, nginx, Compose/native, credential, health, compatibility, and rollback profile on port 18110.',
    category: 'application',
    build: (taskId, definition, options) => ({
      ...buildGhostTask(taskId, options.linuxContext, options.docker),
      definition
    })
  },
  {
    id: 'mattermost-linux',
    label: 'Deploy a verified Mattermost collaboration service',
    description: 'Reviewed Mattermost, PostgreSQL, nginx, Compose/native, credential, health, compatibility, and rollback profile on port 18111.',
    category: 'application',
    build: (taskId, definition, options) => ({
      ...buildMattermostTask(taskId, options.linuxContext, options.docker),
      definition
    })
  },
  {
    id: 'odoo-linux',
    label: 'Deploy a verified Odoo Community service',
    description: 'Reviewed Odoo Community 19, PostgreSQL, nginx, Compose/native, credential, health, compatibility, and rollback profile on port 18112.',
    category: 'application',
    build: (taskId, definition, options) => ({
      ...buildOdooTask(taskId, options.linuxContext, options.docker),
      definition
    })
  },
  {
    id: 'jellyfin-linux',
    label: 'Deploy a verified Jellyfin media service',
    description: 'Reviewed Jellyfin package/portable/Compose, isolated media, initialization, SQLite, health, compatibility, and rollback profile on port 18113.',
    category: 'application',
    build: (taskId, definition, options) => ({
      ...buildJellyfinTask(taskId, options.linuxContext, options.docker),
      definition
    })
  },
  {
    id: 'home-assistant-linux',
    label: 'Deploy a verified Home Assistant service',
    description: 'Reviewed isolated Home Assistant Container, bridge proxy, onboarding, SQLite, no-device, health, compatibility, and rollback profile on port 18115.',
    category: 'application',
    platform: 'linux',
    build: (taskId, definition, options) => ({
      ...buildHomeAssistantTask(taskId, options.linuxContext, options.docker),
      definition
    })
  },
  {
    id: 'podman-freebsd',
    label: 'Install Podman Suite and Compose on FreeBSD',
    description: 'Reviewed FreeBSD 15+ non-jail Podman installation with jail/VFS preflight, package/path baseline, container verification, and rollback.',
    category: 'application',
    platform: 'freebsd',
    prerequisite: true,
    build: (taskId, definition, options) => ({ ...buildFreebsdPodmanBootstrapTask(taskId, options.freebsdExecution ?? options.inventory?.webminaiExecution, options.docker), definition })
  },
  {
    id: 'wordpress-freebsd',
    label: 'Deploy a verified native FreeBSD WordPress site',
    description: 'Build minimal native FreeBSD OCI images for MariaDB and PHP/nginx, then deploy WordPress on port 18101.',
    category: 'application',
    platform: 'freebsd',
    build: (taskId, definition, options) => ({ ...buildFreebsdWordpressTask(taskId, options.freebsdExecution ?? options.inventory?.webminaiExecution), definition })
  },
  {
    id: 'woocommerce-freebsd',
    label: 'Deploy a verified native FreeBSD WooCommerce store',
    description: 'Reuse the reviewed FreeBSD WordPress runtime and deploy digest-pinned WooCommerce on port 18102.',
    category: 'application',
    platform: 'freebsd',
    build: (taskId, definition, options) => ({ ...buildFreebsdWooCommerceTask(taskId, options.freebsdExecution ?? options.inventory?.webminaiExecution), definition })
  },
  {
    id: 'joomla-freebsd',
    label: 'Deploy a verified native FreeBSD Joomla site',
    description: 'Use shared native FreeBSD PHP/nginx and MariaDB runtimes to deploy digest-verified Joomla on port 18103.',
    category: 'application',
    platform: 'freebsd',
    build: (taskId, definition, options) => ({ ...buildFreebsdJoomlaTask(taskId, options.freebsdExecution ?? options.inventory?.webminaiExecution), definition })
  },
  {
    id: 'drupal-freebsd',
    label: 'Deploy a verified native FreeBSD Drupal site',
    description: 'Use shared native FreeBSD PHP/nginx and MariaDB runtimes to deploy digest-verified Drupal on port 18104.',
    category: 'application',
    platform: 'freebsd',
    build: (taskId, definition, options) => ({ ...buildFreebsdDrupalTask(taskId, options.freebsdExecution ?? options.inventory?.webminaiExecution), definition })
  },
  {
    id: 'prestashop-freebsd',
    label: 'Deploy a verified native FreeBSD PrestaShop store',
    description: 'Use shared native FreeBSD PHP/nginx and MariaDB runtimes with the reviewed phased PrestaShop installer on port 18105.',
    category: 'application',
    platform: 'freebsd',
    build: (taskId, definition, options) => ({ ...buildFreebsdPrestaShopTask(taskId, options.freebsdExecution ?? options.inventory?.webminaiExecution), definition })
  },
  {
    id: 'moodle-freebsd',
    label: 'Deploy a verified native FreeBSD Moodle site',
    description: 'Use shared native FreeBSD runtimes with public-root isolation, off-web data, protected installation, and recurring cron on port 18106.',
    category: 'application',
    platform: 'freebsd',
    build: (taskId, definition, options) => ({ ...buildFreebsdMoodleTask(taskId, options.freebsdExecution ?? options.inventory?.webminaiExecution), definition })
  },
  {
    id: 'nextcloud-freebsd',
    label: 'Deploy a verified native FreeBSD Nextcloud instance',
    description: 'Use shared native FreeBSD runtimes with isolated data, trusted-domain configuration, background cron, health, and rollback on port 18107.',
    category: 'application',
    platform: 'freebsd',
    build: (taskId, definition, options) => ({ ...buildFreebsdNextcloudTask(taskId, options.freebsdExecution ?? options.inventory?.webminaiExecution), definition })
  },
  {
    id: 'jellyfin-freebsd',
    label: 'Deploy a verified native FreeBSD Jellyfin server',
    description: 'Build the exact FreeBSD-port Jellyfin runtime with protected onboarding, isolated storage, nginx, health, and rollback on port 18113.',
    category: 'application',
    platform: 'freebsd',
    build: (taskId, definition, options) => ({ ...buildFreebsdJellyfinTask(taskId, options.freebsdExecution ?? options.inventory?.webminaiExecution), definition })
  },
  {
    id: 'mattermost-freebsd',
    label: 'Deploy a verified native FreeBSD Mattermost server',
    description: 'Install the current FreeBSD Mattermost port with PostgreSQL 17, protected bootstrap credentials, nginx, health, and rollback on port 18111.',
    category: 'application',
    platform: 'freebsd',
    build: (taskId, definition, options) => ({ ...buildFreebsdMattermostTask(taskId, options.freebsdExecution ?? options.inventory?.webminaiExecution), definition })
  },
  {
    id: 'n8n-freebsd',
    label: 'Deploy a verified native FreeBSD n8n service',
    description: 'Install exact n8n with FreeBSD Node.js 24, protected encryption state, SQLite persistence, rc.d, health, and rollback on port 18109.',
    category: 'application',
    platform: 'freebsd',
    build: (taskId, definition, options) => ({ ...buildFreebsdN8nTask(taskId, options.freebsdExecution ?? options.inventory?.webminaiExecution), definition })
  },
  {
    id: 'ghost-freebsd',
    label: 'Deploy a verified native FreeBSD Ghost site',
    description: 'Install exact Ghost with FreeBSD Node.js 22, isolated Oracle MySQL 8, protected database credentials, rc.d, nginx, health, and rollback on port 18110.',
    category: 'application',
    platform: 'freebsd',
    build: (taskId, definition, options) => ({ ...buildFreebsdGhostTask(taskId, options.freebsdExecution ?? options.inventory?.webminaiExecution), definition })
  },
  {
    id: 'odoo-freebsd',
    label: 'Deploy a verified native FreeBSD Odoo Community service',
    description: 'Install pinned Odoo Community 19 source with Python 3.12, isolated PostgreSQL 17, protected administrator credentials, rc.d, nginx, health, and rollback on port 18112.',
    category: 'application',
    platform: 'freebsd',
    build: (taskId, definition, options) => ({ ...buildFreebsdOdooTask(taskId, options.freebsdExecution ?? options.inventory?.webminaiExecution), definition })
  },
  {
    id: 'home-assistant-freebsd',
    label: 'Deploy a verified native FreeBSD Home Assistant service',
    description: 'Build pinned Home Assistant Core with Python 3.14, isolated configuration, protected onboarding credentials, rc.d, nginx, health, and rollback on port 18115.',
    category: 'application',
    platform: 'freebsd',
    build: (taskId, definition, options) => ({ ...buildFreebsdHomeAssistantTask(taskId, options.freebsdExecution ?? options.inventory?.webminaiExecution), definition })
  },
  {
    id: 'magento-freebsd',
    label: 'Deploy a verified native FreeBSD Magento Open Source store',
    description: 'Build pinned Magento Open Source with PHP 8.4-FPM over a Unix socket, isolated MariaDB, OpenSearch, Valkey, protected administrator credentials, cron, nginx, health, and rollback on port 18108.',
    category: 'application',
    platform: 'freebsd',
    build: (taskId, definition, options) => ({ ...buildFreebsdMagentoTask(taskId, options.freebsdExecution ?? options.inventory?.webminaiExecution), definition })
  },
  {
    id: 'colima-macos',
    label: 'Install Colima and Docker Compose on macOS',
    description: 'Validate macOS hardware virtualization before mutation, then install a reversible Homebrew Colima Linux-container substrate for verified application routes.',
    category: 'application',
    platform: 'macos',
    prerequisite: true,
    build: (taskId, definition, options) => ({ ...buildMacosColimaBootstrapTask(taskId, options.macosExecution ?? options.inventory?.webminaiExecution, options.docker), definition })
  },
  {
    id: 'wordpress-macos',
    label: 'Deploy a verified macOS WordPress site',
    description: 'Reuse the promoted ismet WordPress Compose matrix through Colima on port 18101.',
    category: 'application',
    platform: 'macos',
    build: (taskId, definition, options) => ({ ...buildMacosWordpressComposeTask(taskId, options.macosExecution ?? options.inventory?.webminaiExecution, options.docker), definition })
  },
  ...[
    ['woocommerce', 'WooCommerce store', 18102],
    ['joomla', 'Joomla site', 18103],
    ['drupal', 'Drupal site', 18104],
    ['prestashop', 'PrestaShop store', 18105],
    ['moodle', 'Moodle site', 18106],
    ['magento', 'Magento Open Source store', 18108],
    ['n8n', 'n8n automation service', 18109],
    ['ghost', 'Ghost publishing service', 18110],
    ['mattermost', 'Mattermost collaboration service', 18111],
    ['odoo', 'Odoo Community service', 18112],
    ['jellyfin', 'Jellyfin media service', 18113],
    ['home-assistant', 'Home Assistant service', 18115]
  ].map(([application, label, port]) => ({
    id: `${application}-macos`,
    label: `Deploy a verified macOS ${label}`,
    description: `Reuse the promoted ismet ${label} Compose matrix through Colima on port ${port}.`,
    category: 'application',
    platform: 'macos',
    build: (taskId, definition, options) => ({ ...buildMacosComposeTask(application, taskId, options.macosExecution ?? options.inventory?.webminaiExecution, options.docker), definition })
  })),
  {
    id: 'brave-windows',
    label: 'Install verified Brave Browser on Windows',
    description: 'Reviewed official stable Brave installer, checksum, Authenticode, verification, ownership, and rollback profile.',
    category: 'application',
    platform: 'windows',
    build: (taskId, definition, options) => ({ ...buildWindowsBraveTask(taskId, options.windowsExecution), definition })
  },
  {
    id: 'docker-desktop-windows',
    label: 'Install WSL 2 and Docker Desktop on Windows',
    description: 'Reviewed first-step virtualization validation with enablement guidance, WSL features/runtime, signed Docker Desktop, explicit reboot, Linux-engine, Compose, and rollback profile.',
    category: 'application',
    platform: 'windows',
    prerequisite: true,
    build: (taskId, definition, options) => ({ ...buildWindowsDockerBootstrapTask(taskId, options.windowsExecution, options.docker), definition })
  },
  {
    id: 'wordpress-windows',
    label: 'Deploy a verified WordPress site with Windows Docker',
    description: 'Reviewed Linux-container Docker Compose deployment with protected Windows credentials, firewall, health, restart, and rollback on port 18101.',
    category: 'application',
    platform: 'windows',
    build: (taskId, definition, options) => ({
      ...(options.docker?.ready
        ? buildWindowsWordpressComposeTask(taskId, options.windowsExecution, options.docker)
        : buildWindowsDockerBootstrapTask(taskId, options.windowsExecution, options.docker, { continuation: 'WordPress' })),
      definition
    })
  },
  {
    id: 'woocommerce-windows',
    label: 'Deploy a verified WooCommerce store with Windows Docker',
    description: 'Reviewed Windows Docker WordPress foundation plus digest-pinned WooCommerce, protected credentials, health, restart, and rollback on port 18102.',
    category: 'application',
    platform: 'windows',
    build: (taskId, definition, options) => ({
      ...(options.docker?.ready
        ? buildWindowsWordpressComposeTask(taskId, options.windowsExecution, options.docker, { wooCommerce: true })
        : buildWindowsDockerBootstrapTask(taskId, options.windowsExecution, options.docker, { continuation: 'WooCommerce' })),
      definition
    })
  },
  {
    id: 'joomla-windows',
    label: 'Deploy a verified Joomla site with Windows Docker',
    description: 'Reviewed ismet Joomla Compose matrix adapted to Windows paths, SID-protected credentials, health, restart, and rollback on port 18103.',
    category: 'application',
    platform: 'windows',
    build: (taskId, definition, options) => ({
      ...(options.docker?.ready
        ? buildWindowsJoomlaComposeTask(taskId, options.windowsExecution, options.docker)
        : buildWindowsDockerBootstrapTask(taskId, options.windowsExecution, options.docker, { continuation: 'Joomla' })),
      definition
    })
  },
  {
    id: 'drupal-windows',
    label: 'Deploy a verified Drupal site with Windows Docker',
    description: 'Reviewed ismet Drupal Compose matrix adapted to Windows paths, protected credentials, health, restart, and rollback on port 18104.',
    category: 'application',
    platform: 'windows',
    build: (taskId, definition, options) => ({
      ...(options.docker?.ready
        ? buildWindowsDrupalComposeTask(taskId, options.windowsExecution, options.docker)
        : buildWindowsDockerBootstrapTask(taskId, options.windowsExecution, options.docker, { continuation: 'Drupal' })),
      definition
    })
  },
  {
    id: 'prestashop-windows',
    label: 'Deploy a verified PrestaShop store with Windows Docker',
    description: 'Reviewed ismet PrestaShop Compose matrix adapted to Windows paths, protected credentials, staged initialization, health, and rollback on port 18105.',
    category: 'application',
    platform: 'windows',
    build: (taskId, definition, options) => ({
      ...(options.docker?.ready
        ? buildWindowsPrestaShopComposeTask(taskId, options.windowsExecution, options.docker)
        : buildWindowsDockerBootstrapTask(taskId, options.windowsExecution, options.docker, { continuation: 'PrestaShop' })),
      definition
    })
  },
  {
    id: 'moodle-windows',
    label: 'Deploy a verified Moodle site with Windows Docker',
    description: 'Reviewed ismet Moodle image build, PHP-FPM socket, nginx, MariaDB, cron, protected credentials, durable jobs, health, and rollback on port 18106.',
    category: 'application',
    platform: 'windows',
    build: (taskId, definition, options) => ({
      ...(options.docker?.ready
        ? buildWindowsMoodleComposeTask(taskId, options.windowsExecution, options.docker)
        : buildWindowsDockerBootstrapTask(taskId, options.windowsExecution, options.docker, { continuation: 'Moodle' })),
      definition
    })
  },
  {
    id: 'magento-windows',
    label: 'Deploy a verified Magento Open Source store with Windows Docker',
    description: 'Reviewed ismet digest-pinned Magento, nginx, MariaDB, OpenSearch, Valkey, cron, protected credentials, durable jobs, health, and rollback on port 18108.',
    category: 'application',
    platform: 'windows',
    build: (taskId, definition, options) => ({
      ...(options.docker?.ready
        ? buildWindowsMagentoComposeTask(taskId, options.windowsExecution, options.docker)
        : buildWindowsDockerBootstrapTask(taskId, options.windowsExecution, options.docker, { continuation: 'Magento Open Source' })),
      definition
    })
  },
  {
    id: 'n8n-windows',
    label: 'Deploy a verified n8n service with Windows Docker',
    description: 'Reviewed ismet n8n Compose topology adapted to Windows with a protected encryption key, SQLite persistence, health, restart, and rollback on port 18109.',
    category: 'application',
    platform: 'windows',
    build: (taskId, definition, options) => ({
      ...(options.docker?.ready
        ? buildWindowsN8nComposeTask(taskId, options.windowsExecution, options.docker)
        : buildWindowsDockerBootstrapTask(taskId, options.windowsExecution, options.docker, { continuation: 'n8n' })),
      definition
    })
  },
  {
    id: 'ghost-windows',
    label: 'Deploy a verified Ghost site with Windows Docker',
    description: 'Reviewed ismet digest-pinned Ghost, MySQL, and nginx topology with protected credentials, health, restart, and rollback on port 18110.',
    category: 'application',
    platform: 'windows',
    build: (taskId, definition, options) => ({
      ...(options.docker?.ready
        ? buildWindowsGhostComposeTask(taskId, options.windowsExecution, options.docker)
        : buildWindowsDockerBootstrapTask(taskId, options.windowsExecution, options.docker, { continuation: 'Ghost' })),
      definition
    })
  },
  {
    id: 'mattermost-windows',
    label: 'Deploy a verified Mattermost service with Windows Docker',
    description: 'Reviewed ismet digest-pinned Mattermost, PostgreSQL, and nginx topology with protected credentials, API health, restart, and rollback on port 18111.',
    category: 'application',
    platform: 'windows',
    build: (taskId, definition, options) => ({
      ...(options.docker?.ready
        ? buildWindowsMattermostComposeTask(taskId, options.windowsExecution, options.docker)
        : buildWindowsDockerBootstrapTask(taskId, options.windowsExecution, options.docker, { continuation: 'Mattermost' })),
      definition
    })
  },
  {
    id: 'odoo-windows',
    label: 'Deploy a verified Odoo Community service with Windows Docker',
    description: 'Reviewed ismet digest-pinned Odoo, PostgreSQL, and nginx topology with protected credentials, database initialization, restart, and rollback on port 18112.',
    category: 'application',
    platform: 'windows',
    build: (taskId, definition, options) => ({
      ...(options.docker?.ready
        ? buildWindowsOdooComposeTask(taskId, options.windowsExecution, options.docker)
        : buildWindowsDockerBootstrapTask(taskId, options.windowsExecution, options.docker, { continuation: 'Odoo Community' })),
      definition
    })
  },
  {
    id: 'jellyfin-windows',
    label: 'Deploy a verified Jellyfin service with Windows Docker',
    description: 'Reviewed ismet digest-pinned Jellyfin and nginx topology with protected onboarding, health, restart, and rollback on port 18113.',
    category: 'application',
    platform: 'windows',
    build: (taskId, definition, options) => ({
      ...(options.docker?.ready
        ? buildWindowsJellyfinComposeTask(taskId, options.windowsExecution, options.docker)
        : buildWindowsDockerBootstrapTask(taskId, options.windowsExecution, options.docker, { continuation: 'Jellyfin' })),
      definition
    })
  },
  {
    id: 'home-assistant-windows',
    label: 'Deploy a verified Home Assistant service with Windows Docker',
    description: 'Reviewed isolated ismet Home Assistant and nginx topology with protected onboarding, health, restart, and rollback on port 18115.',
    category: 'application',
    platform: 'windows',
    build: (taskId, definition, options) => ({
      ...(options.docker?.ready
        ? buildWindowsHomeAssistantComposeTask(taskId, options.windowsExecution, options.docker)
        : buildWindowsDockerBootstrapTask(taskId, options.windowsExecution, options.docker, { continuation: 'Home Assistant' })),
      definition
    })
  },
  ...['linux', 'freebsd', 'macos', 'windows'].map(platform => ({
    id: `intent-ai-ops-${platform}`,
    label: `Install Intent AI Ops on ${platform}`,
    description: 'Install the reviewed GitHub CLI package and bootstrap Node.js 24 only when Node is absent.',
    category: 'application',
    platform,
    build: (taskId, definition, options) => ({ ...buildIntentAiOpsInstallTask(taskId, platform, options.intentAiOpsInstallSource), definition })
  }))
]

export function listCommonTasks (options = {}) {
  const { category = null, platform = null } = options
  if (category !== null && !['application', 'diagnostic', 'maintenance', 'system'].includes(category)) throw new TypeError('common task category must be application, diagnostic, maintenance, or system')
  if (platform !== null && !['freebsd', 'linux', 'macos', 'windows'].includes(platform)) throw new TypeError('common task platform must be freebsd, linux, macos, or windows')
  return DEFINITIONS
    .filter(item => category === null || (item.category ?? 'system') === category)
    .filter(item => platform === null || (item.platform ?? 'linux') === platform)
    .map(({ id, label, description, category: itemCategory, platform: itemPlatform, prerequisite = false }) => ({
      id,
      label,
      description,
      category: itemCategory ?? 'system',
      platform: itemPlatform ?? 'linux',
      prerequisite,
      foundationIds: catalogFoundationIds(id, { ...options, platform: itemPlatform ?? 'linux' })
    }))
}

export function listEligibleCommonTasks (options = {}) {
  const available = listCommonTasks(options)
  return available.filter(task => commonTaskEligibility(task.id, options).eligible)
}

export function commonTaskEligibility (catalogId, options = {}) {
  const definition = DEFINITIONS.find(item => item.id === catalogId)
  if (!definition) throw new Error(`unknown common task: ${catalogId}`)
  const platform = options.platform ?? 'linux'
  const targetPlatform = definition.platform ?? 'linux'
  if (platform !== targetPlatform) return { eligible: false, reason: `requires ${targetPlatform}` }
  if (platform === 'linux') {
    const linuxContext = options.linuxContext ?? options.inventory?.webminaiLinuxContext
    const serviceManager = linuxContext?.management?.serviceManager
    const docker = options.docker ?? options.inventory?.webminaiDocker ?? {}
    if (['systemd-service', 'systemd-timer', 'tmpfiles-rule'].includes(catalogId) && serviceManager !== 'systemd') {
      return { eligible: false, reason: 'requires systemd' }
    }
    if (catalogId === 'swap-file' && docker.hostIsContainer === true) {
      return { eligible: false, reason: 'swap activation is controlled by the outer container host' }
    }
  }
  if ((definition.category ?? 'system') !== 'application') return { eligible: true, reason: 'platform supported' }

  const docker = options.docker ?? options.inventory?.webminaiDocker ?? {}
  if (definition.prerequisite) {
    if (docker.preference === 'disabled') return { eligible: false, reason: 'container runtime disabled by host preference' }
    if (catalogId === 'docker-linux' && !docker.ready && (!docker.installSupported || !['official-apt', 'official-rpm', 'distribution-packages'].includes(docker.installMethod))) return { eligible: false, reason: 'no reviewed Docker installation route' }
    const freebsdExecution = options.freebsdExecution ?? options.inventory?.webminaiExecution
    if (catalogId === 'podman-freebsd' && !docker.ready && freebsdExecution?.docker?.installSupported !== true && docker.installSupported !== true) return { eligible: false, reason: 'requires FreeBSD 15+ outside a jail' }
  }

  if (platform === 'windows' && !definition.prerequisite && !['brave-windows', 'intent-ai-ops-windows'].includes(catalogId) && !docker.ready) {
    return { eligible: false, reason: 'install and verify Docker Desktop first', prerequisiteCatalogId: 'docker-desktop-windows' }
  }
  if (platform === 'macos' && !['colima-macos', 'intent-ai-ops-macos'].includes(catalogId) && !docker.ready) {
    return { eligible: false, reason: 'install and verify Colima first', prerequisiteCatalogId: 'colima-macos' }
  }

  try {
    const built = buildCommonTask(catalogId, 1, options)
    if (unsupportedPlan(built.plan)) return { eligible: false, reason: 'no supported route for the observed distro/runtime' }
    return { eligible: true, reason: definition.prerequisite ? 'runtime is ready or installable' : 'reviewed route resolved' }
  } catch (error) {
    return { eligible: false, reason: String(error.message).slice(0, 1000) }
  }
}

export function isLinuxApplicationCommonTask (catalogId) {
  return DEFINITIONS.some(item => item.id === catalogId && item.category === 'application' && (item.platform ?? 'linux') === 'linux')
}

export function isApplicationCommonTask (catalogId, platform = null) {
  return DEFINITIONS.some(item => item.id === catalogId && item.category === 'application' && (platform === null || (item.platform ?? 'linux') === platform))
}

export function buildCandidatePlanningContext (catalogIds, taskId, options = {}) {
  if (!Array.isArray(catalogIds) || catalogIds.length > 3) throw new TypeError('candidate catalog ids must contain at most three entries')
  if (new Set(catalogIds).size !== catalogIds.length) throw new TypeError('candidate catalog ids must be unique')
  return catalogIds.map(catalogId => {
    const definition = DEFINITIONS.find(item => item.id === catalogId && ['application', 'diagnostic', 'maintenance'].includes(item.category))
    if (!definition) throw new Error(`unknown application, diagnostic, or maintenance common task: ${catalogId}`)
    const declaredFoundationIds = catalogFoundationIds(catalogId, options)
    const foundationIds = Array.isArray(options.foundationIds)
      ? options.foundationIds.filter(id => declaredFoundationIds.includes(id))
      : declaredFoundationIds
    const foundationMode = options.foundationMode ?? 'context-only'
    const reference = {
      catalogId,
      label: definition.label,
      description: definition.description,
      foundationIds,
      foundations: buildFoundationPlanningContext({
        foundationIds,
        platform: options.platform ?? definition.platform ?? 'linux',
        docker: options.docker ?? {},
        mode: foundationMode
      })
    }
    try {
      const built = buildCommonTask(catalogId, taskId, options)
      const candidate = { ...reference, foundationMode, verifiedPlan: compactCandidatePlan(built.plan) }
      Object.defineProperty(candidate, 'executablePlan', { value: built.plan, enumerable: false })
      return candidate
    } catch (error) {
      return { ...reference, foundationMode, unavailableForHost: String(error.message).slice(0, 1000) }
    }
  })
}

export function buildCommonTask (catalogId, taskId, options = {}) {
  const { platform = 'linux' } = options
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  const definition = DEFINITIONS.find(item => item.id === catalogId)
  if (!definition) throw new Error(`unknown common task: ${catalogId}`)
  const targetPlatform = definition.platform ?? 'linux'
  if (platform !== targetPlatform) throw new Error(`common task ${catalogId} supports ${targetPlatform}, not ${platform}; use an AI-assisted task`)
  const built = applyApplicationDefaults(
    definition.build(taskId, definition, { ...options, platform }),
    options.applicationDefaults
  )
  const diagnostic = definition.category === 'diagnostic'
  const foundationIds = catalogFoundationIds(catalogId, options)
  return {
    ...built,
    plan: annotateVerifiedPlan({
      summary: definition.label,
      assumptions: [diagnostic ? 'Stage 2 supplies Netdata metrics and executes the supplementary read-only collector with its authenticated host identity.' : platform === 'windows' ? 'Windows host with the reviewed LocalSystem and Docker execution environment' : platform === 'freebsd' ? 'FreeBSD host with the reviewed root Stage 2 and native Podman jail execution environment' : platform === 'macos' ? 'macOS host with root Stage 2, a non-root Homebrew owner, and an Apple virtualization-backed Colima route' : 'Linux host with a supported package manager and system utilities'],
      warnings: [diagnostic ? 'Review the bounded diagnostic collector before execution; it does not change host state.' : 'This deterministic task executes as root and must be approved command by command.'],
      requiresConfirmation: true,
      ...built.plan
    }, { catalogId, foundationIds })
  }
}

export function commonTaskFoundationIds (catalogId, options = {}) {
  if (!DEFINITIONS.some(item => item.id === catalogId)) throw new Error(`unknown common task: ${catalogId}`)
  return catalogFoundationIds(catalogId, options)
}

function catalogFoundationIds (catalogId, options) {
  const platform = options.platform ?? DEFINITIONS.find(item => item.id === catalogId)?.platform ?? 'linux'
  const common = ['host-generated-credentials', 'service-verification', 'safe-baseline-rollback']
  if (catalogId === 'docker-linux') return ['linux-docker-readiness', 'safe-baseline-rollback']
  if (catalogId === 'docker-desktop-windows') return ['windows-docker-wsl-readiness', 'safe-baseline-rollback']
  if (catalogId === 'podman-freebsd') return ['freebsd-podman-readiness', 'safe-baseline-rollback']
  if (catalogId === 'colima-macos') return ['macos-colima-compose', 'safe-baseline-rollback']
  if (!isApplicationCommonTask(catalogId, platform)) {
    return []
  }
  if (platform === 'windows') return ['windows-docker-wsl-readiness', 'windows-powershell-compose-adapter', 'windows-docker-compose', ...common]
  if (platform === 'freebsd') return ['freebsd-podman-readiness', 'freebsd-podman-compose', ...common]
  if (platform === 'macos') return ['macos-colima-compose', ...common]

  const planUsesDocker = options.docker?.preferred === true
  const phpApplications = new Set(['wordpress-linux', 'woocommerce-linux', 'joomla-linux', 'drupal-linux', 'prestashop-linux', 'moodle-linux', 'magento-linux'])
  if (planUsesDocker) return ['linux-baseline', 'linux-docker-readiness', 'linux-docker-compose', ...common]
  const database = catalogId === 'mattermost-linux' || catalogId === 'odoo-linux' ? 'linux-postgresql' : 'linux-mariadb'
  return phpApplications.has(catalogId)
    ? ['linux-baseline', 'linux-nginx-site', 'linux-php-fpm-socket', database, ...common]
    : ['linux-baseline', database, ...common]
}

function healthTask (platform) {
  return {
    id: `host-health-${platform}`,
    label: 'Collect a concise host health report',
    description: `Use Netdata plus bounded ${platform} service, error-log, update, reboot, process, and container evidence to produce an AI health assessment.`,
    category: 'diagnostic',
    platform,
    build: (taskId, definition, options) => buildHostHealthTask(taskId, definition, options)
  }
}

function systemUpdateTask (platform) {
  return {
    id: `system-update-${platform}`,
    label: 'Install all current-release system updates',
    description: `Update ${platform} packages and same-release system components without an OS release upgrade or reboot, then report exact changes and newer-release availability.`,
    category: 'maintenance',
    platform,
    build: (taskId, definition, options) => buildSystemUpdateTask(taskId, definition, options)
  }
}

function packageTask (id, label, packageName, binaryPath) {
  return {
    id,
    label,
    description: `Install and then safely remove ${packageName} when it was not previously installed.`,
    build (taskId, definition, options) {
      const state = stateDirectory(taskId, id)
      const oracleEpel = id === 'install-htop' && options.linuxContext?.identity?.id === 'ol'
      const install = oracleEpel
        ? `if rpm -q oracle-epel-release-el9 >/dev/null 2>&1; then : > ${quote(`${state}/oracle-epel-was-present`)}; else dnf -y install oracle-epel-release-el9; fi; dnf -y install ${quote(packageName)}`
        : packageInstall(packageName)
      const removeRepository = oracleEpel
        ? `; if [ ! -e ${quote(`${state}/oracle-epel-was-present`)} ] && rpm -q oracle-epel-release-el9 >/dev/null 2>&1; then dnf -y remove oracle-epel-release-el9; fi`
        : ''
      const repositoryProbe = oracleEpel ? `; ${packageStateProbe('oracle-epel-release-el9')}` : ''
      return {
        plan: {
          changeOverview: `Install ${packageName} while recording whether it existed before the task.`,
          modifiedFiles: [binaryPath, state],
          commands: [command('capture-install', `set -eu; if [ ! -e ${quote(`${state}/apply-complete`)} ]; then ${packageCapture(state, packageName)}; if [ ! -e ${quote(`${state}/was-present`)} ]; then ${install}; fi; : > ${quote(`${state}/apply-complete`)}; fi`, `Install ${packageName} only when absent`, 'change', 300000)],
          revertCommands: [command('remove-if-added', `set -eu; if [ -d ${quote(state)} ] && [ ! -e ${quote(`${state}/was-present`)} ] && ${packagePresent(packageName)}; then ${packageRemove(packageName, state)}; fi${removeRepository}; rm -rf -- ${quote(state)}`, `Remove ${packageName} and dependencies introduced only by this task`, 'change', 300000)]
        },
        verifyApplied: `command -v ${packageName} >/dev/null 2>&1`,
        verifyReverted: `test ! -e ${quote(state)}`,
        stateProbe: `${packageStateProbe(packageName)}${repositoryProbe}; ${fileStateProbe([state])}`,
        definition
      }
    }
  }
}

function compactCandidatePlan (plan) {
  const compactCommand = item => ({
    id: item.id,
    phase: item.phase,
    purpose: item.purpose,
    risk: item.risk,
    timeoutMs: item.timeoutMs,
    executionMode: item.executionMode,
    source: item.source,
    commandFragment: item.command.length > 2048 ? `${item.command.slice(0, 2045)}...` : item.command
  })
  return {
    summary: plan.summary,
    changeOverview: plan.changeOverview,
    assumptions: plan.assumptions,
    warnings: plan.warnings,
    modifiedFiles: plan.modifiedFiles,
    compatibilityManifest: plan.compatibilityManifest,
    foundationComposition: plan.foundationComposition,
    commands: plan.commands.map(compactCommand),
    revertCommands: plan.revertCommands.map(compactCommand)
  }
}

function unsupportedPlan (plan) {
  return plan?.compatibilityManifest?.status === 'unsupported' ||
    plan?.compatibilityManifest?.selectedRoute?.status === 'unsupported' ||
    plan?.selectedRoute?.status === 'unsupported'
}

function buildNginxSite (taskId, definition) {
  const state = stateDirectory(taskId, definition.id)
  const root = '/var/www/webminai-test-site'
  const config = '/etc/nginx/conf.d/webminai-test-site.conf'
  const alpineConfig = '/etc/nginx/http.d/webminai-test-site.conf'
  return {
    plan: {
      changeOverview: 'Install nginx if absent and deploy an isolated static website on port 18080.',
      modifiedFiles: [root, config, alpineConfig, '/etc/nginx/nginx.conf', state],
      commands: [
        command('prepare-nginx', `set -eu; if [ ! -e ${quote(`${state}/prepare-complete`)} ]; then test ! -e ${quote(root)}; test ! -e ${quote(config)}; test ! -e ${quote(alpineConfig)}; ${packageCapture(state, 'nginx')}; if ${serviceIsActive('nginx')}; then : > ${quote(`${state}/was-active`)}; fi; if [ ! -e ${quote(`${state}/was-present`)} ]; then ${packageInstall('nginx')}; fi; : > ${quote(`${state}/prepare-complete`)}; fi`, 'Capture nginx state and install it only when absent', 'change', 300000),
        command('write-site', `set -eu; config=${quote(config)}; if [ -d /etc/nginx/http.d ]; then config=${quote(alpineConfig)}; elif [ ! -d /etc/nginx/conf.d ]; then cp -a /etc/nginx/nginx.conf ${quote(`${state}/nginx-conf-before`)}; install -d -o root -g root -m 0755 /etc/nginx/conf.d; : > ${quote(`${state}/created-config-directory`)}; sed -i '$i\\    include /etc/nginx/conf.d/*.conf;' /etc/nginx/nginx.conf; fi; install -d -o root -g root -m 0755 ${quote(root)}; printf '%s\n' '<!doctype html><title>WebminAI test</title><h1>WebminAI nginx task</h1>' > ${quote(`${root}/index.html`)}; chmod 0644 ${quote(`${root}/index.html`)}; printf '%s\n' 'server {' '    listen 18080;' '    server_name _;' '    root /var/www/webminai-test-site;' '    location / { try_files $uri $uri/ =404; }' '}' > "$config"; chmod 0644 "$config"; printf '%s\n' "$config" > ${quote(`${state}/config-path`)}`, 'Write the website and nginx server block', 'change', 30000, ['prepare-nginx']),
        command('verify-nginx', `set -eu; nginx -t; ${serviceStartOrReload('nginx')}; curl --fail --silent --show-error --retry 5 --retry-connrefused --retry-delay 1 --max-time 10 http://127.0.0.1:18080/ | grep -q 'WebminAI nginx task'`, 'Load the nginx configuration and fetch the new website', 'change', 30000, ['write-site'])
      ],
      revertCommands: [
        command('remove-site', `set -eu; rm -rf -- ${quote(root)}; rm -f -- ${quote(config)} ${quote(alpineConfig)}; if [ -f ${quote(`${state}/nginx-conf-before`)} ]; then cp -a ${quote(`${state}/nginx-conf-before`)} /etc/nginx/nginx.conf; fi; if [ -e ${quote(`${state}/created-config-directory`)} ]; then rmdir /etc/nginx/conf.d; fi`, 'Remove the test website and restore the nginx configuration', 'change', 30000),
        command('restore-nginx', `set -eu; if [ -d ${quote(state)} ]; then if [ -e ${quote(`${state}/was-active`)} ]; then ${serviceReload('nginx')}; else ${serviceStop('nginx')}; fi; if [ ! -e ${quote(`${state}/was-present`)} ] && ${packagePresent('nginx')}; then ${packageRemove('nginx', state)}; fi; fi; rm -rf -- ${quote(state)}`, 'Restore nginx package, dependency, and service state', 'change', 300000, ['remove-site'])
      ]
    },
    verifyApplied: 'curl --fail --silent --max-time 10 http://127.0.0.1:18080/ | grep -q \'WebminAI nginx task\'',
    verifyReverted: `test ! -e ${quote(root)} && test ! -e ${quote(config)} && test ! -e ${quote(alpineConfig)} && test ! -e ${quote(state)}`,
    stateProbe: `${packageStateProbe('nginx')}; if command -v nginx >/dev/null 2>&1; then if ${serviceIsActive('nginx')}; then printf 'nginx-service=active\n'; else printf 'nginx-service=inactive\n'; fi; else printf 'nginx-service=absent\n'; fi; ${fileStateProbe([root, config, alpineConfig, '/etc/nginx/nginx.conf', state])}`,
    definition
  }
}

function serviceIsActive (service) {
  return `{ if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl is-active --quiet ${quote(service)}; elif command -v rc-service >/dev/null 2>&1; then rc-service ${quote(service)} status >/dev/null 2>&1; elif [ -r /run/${service}/${service}.pid ]; then kill -0 "$(cat /run/${service}/${service}.pid)" 2>/dev/null; else pgrep -x ${quote(service)} >/dev/null 2>&1; fi; }`
}

function serviceStartOrReload (service) {
  return `if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then if systemctl is-active --quiet ${quote(service)}; then systemctl reload ${quote(service)}; else systemctl start ${quote(service)}; fi; elif command -v rc-service >/dev/null 2>&1; then if rc-service ${quote(service)} status >/dev/null 2>&1; then rc-service ${quote(service)} reload; else rc-service ${quote(service)} start; fi; elif ${serviceIsActive(service)}; then ${quote(service)} -s reload; else ${quote(service)}; fi`
}

function serviceReload (service) {
  return `if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl reload ${quote(service)}; elif command -v rc-service >/dev/null 2>&1; then rc-service ${quote(service)} reload; else ${quote(service)} -s reload; fi`
}

function serviceStop (service) {
  return `if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl stop ${quote(service)} 2>/dev/null || true; elif command -v rc-service >/dev/null 2>&1; then rc-service ${quote(service)} stop 2>/dev/null || true; else ${quote(service)} -s quit 2>/dev/null || true; fi`
}

function buildSystemUser (taskId, definition) {
  const state = stateDirectory(taskId, definition.id)
  const user = 'webminai-test-user'
  return simpleTask(definition, state, {
    overview: `Create the locked system user ${user} only when it does not exist.`,
    files: ['/etc/passwd', '/etc/shadow', '/etc/group', state],
    apply: `set -eu; install -d -m 0700 ${quote(state)}; if id ${user} >/dev/null 2>&1; then : > ${quote(`${state}/was-present`)}; elif command -v useradd >/dev/null 2>&1; then useradd --system --no-create-home --shell /usr/sbin/nologin ${user}; elif command -v adduser >/dev/null 2>&1; then adduser -S -D -H -s /sbin/nologin ${user}; else echo 'supported system-user tool not found' >&2; exit 2; fi`,
    applyPurpose: 'Capture user state and create the account when absent',
    revert: `set -eu; if [ ! -e ${quote(`${state}/was-present`)} ] && id ${user} >/dev/null 2>&1; then if command -v userdel >/dev/null 2>&1; then userdel ${user}; else deluser ${user}; fi; fi; rm -rf -- ${quote(state)}`,
    revertPurpose: 'Remove only the account created by this task',
    verifyApplied: `id ${user} >/dev/null 2>&1`,
    verifyReverted: `test ! -e ${quote(state)}`,
    stateProbe: `getent passwd ${user} 2>/dev/null || printf 'user=absent\n'; getent group ${user} 2>/dev/null || printf 'group=absent\n'; ${fileStateProbe(['/etc/passwd', '/etc/shadow', '/etc/group', state])}`
  })
}

function buildSwapFile (taskId, definition) {
  const state = stateDirectory(taskId, definition.id)
  const swap = '/swapfile-webminai-test'
  return simpleTask(definition, state, {
    overview: 'Create and activate an isolated 2 GiB lab swap file.',
    files: [swap, '/etc/fstab', state],
    apply: `set -eu; test ! -e ${quote(swap)}; install -d -m 0700 ${quote(state)}; fallocate -l 2G ${quote(swap)}; chmod 0600 ${quote(swap)}; mkswap ${quote(swap)} >/dev/null; swapon ${quote(swap)}; printf '%s none swap sw 0 0\n' ${quote(swap)} >> /etc/fstab`,
    applyPurpose: 'Create, activate, and persist the test swap file',
    revert: `set -eu; swapoff ${quote(swap)} 2>/dev/null || true; sed -i '\\|^/swapfile-webminai-test[[:space:]]|d' /etc/fstab; rm -f -- ${quote(swap)}; rm -rf -- ${quote(state)}`,
    revertPurpose: 'Disable and remove the test swap file and fstab entry',
    verifyApplied: 'awk \'$1 == "/swapfile-webminai-test" { found=1 } END { exit !found }\' /proc/swaps',
    verifyReverted: `test ! -e ${quote(swap)} && ! grep -q '^/swapfile-webminai-test[[:space:]]' /etc/fstab && test ! -e ${quote(state)}`,
    stateProbe: `awk '$1 == "/swapfile-webminai-test" { print }' /proc/swaps; ${fileStateProbe([swap, '/etc/fstab', state])}`
  })
}

function buildSystemdService (taskId, definition) {
  const state = stateDirectory(taskId, definition.id)
  const unit = '/etc/systemd/system/webminai-test.service'
  return simpleTask(definition, state, {
    overview: 'Install and run an isolated systemd oneshot service.',
    files: [unit, '/run/webminai-test-service', state],
    apply: `set -eu; test ! -e ${quote(unit)}; install -d -m 0700 ${quote(state)}; printf '%s\n' '[Unit]' 'Description=Intent AI Ops reversible test service' '[Service]' 'Type=oneshot' 'ExecStart=/usr/bin/touch /run/webminai-test-service' 'RemainAfterExit=yes' > ${quote(unit)}; chmod 0644 ${quote(unit)}; systemctl daemon-reload; systemctl start webminai-test.service`,
    applyPurpose: 'Install and start the test service',
    revert: `set -eu; systemctl stop webminai-test.service 2>/dev/null || true; rm -f -- ${quote(unit)} /run/webminai-test-service; systemctl daemon-reload; systemctl reset-failed webminai-test.service 2>/dev/null || true; rm -rf -- ${quote(state)}`,
    revertPurpose: 'Stop and remove the test service',
    verifyApplied: 'systemctl is-active --quiet webminai-test.service && test -e /run/webminai-test-service',
    verifyReverted: `test ! -e ${quote(unit)} && test ! -e /run/webminai-test-service && test ! -e ${quote(state)}`,
    stateProbe: fileStateProbe([unit, '/run/webminai-test-service', state])
  })
}

function buildSystemdTimer (taskId, definition) {
  const state = stateDirectory(taskId, definition.id)
  const service = '/etc/systemd/system/webminai-test-timer.service'
  const timer = '/etc/systemd/system/webminai-test.timer'
  return simpleTask(definition, state, {
    overview: 'Install and enable an isolated systemd maintenance timer.',
    files: [service, timer, '/run/webminai-test-timer', state],
    apply: `set -eu; test ! -e ${quote(service)}; test ! -e ${quote(timer)}; install -d -m 0700 ${quote(state)}; printf '%s\n' '[Service]' 'Type=oneshot' 'ExecStart=/usr/bin/touch /run/webminai-test-timer' > ${quote(service)}; printf '%s\n' '[Unit]' 'Description=Intent AI Ops reversible test timer' '[Timer]' 'OnActiveSec=1s' 'Unit=webminai-test-timer.service' '[Install]' 'WantedBy=timers.target' > ${quote(timer)}; chmod 0644 ${quote(service)} ${quote(timer)}; systemctl daemon-reload; systemctl enable --now webminai-test.timer`,
    applyPurpose: 'Install and enable the test timer',
    revert: `set -eu; systemctl disable --now webminai-test.timer 2>/dev/null || true; rm -f -- ${quote(service)} ${quote(timer)} /run/webminai-test-timer; systemctl daemon-reload; systemctl reset-failed webminai-test-timer.service 2>/dev/null || true; rm -rf -- ${quote(state)}`,
    revertPurpose: 'Disable and remove the test timer',
    verifyApplied: 'systemctl is-active --quiet webminai-test.timer',
    verifyReverted: `test ! -e ${quote(service)} && test ! -e ${quote(timer)} && test ! -e ${quote(state)}`,
    stateProbe: fileStateProbe([service, timer, '/run/webminai-test-timer', state])
  })
}

function buildCronJob (taskId, definition, options) {
  const state = stateDirectory(taskId, definition.id)
  const manager = options.linuxContext?.management?.packageManager
  const alpine = manager === 'apk'
  const packageName = manager === 'apk' ? 'dcron' : ['dnf', 'yum', 'pacman'].includes(manager) ? 'cronie' : 'cron'
  const file = alpine ? '/etc/crontabs/root' : '/etc/cron.d/webminai-test'
  const apply = alpine
    ? `${packageCapture(state, packageName)}; if [ -f ${quote(file)} ]; then cp -a ${quote(file)} ${quote(`${state}/root-crontab-before`)}; else : > ${quote(`${state}/root-crontab-absent`)}; fi; if [ ! -e ${quote(`${state}/was-present`)} ]; then ${packageInstall(packageName)}; fi; grep -v 'WEBMINAI_TEST_CRON' ${quote(file)} > ${quote(`${state}/root-crontab-new`)} || true; printf '%s\n' '17 3 * * * /usr/bin/touch /tmp/webminai-cron-ran # WEBMINAI_TEST_CRON' >> ${quote(`${state}/root-crontab-new`)}; install -o root -g root -m 0600 ${quote(`${state}/root-crontab-new`)} ${quote(file)}`
    : `${packageCapture(state, packageName)}; if [ ! -e ${quote(`${state}/was-present`)} ]; then ${packageInstall(packageName)}; fi; install -d -o root -g root -m 0755 /etc/cron.d; printf '%s\n' '17 3 * * * root /usr/bin/touch /tmp/webminai-cron-ran' > ${quote(file)}; chmod 0644 ${quote(file)}`
  const restore = alpine
    ? `if [ -f ${quote(`${state}/root-crontab-before`)} ]; then cp -a ${quote(`${state}/root-crontab-before`)} ${quote(file)}; elif [ -e ${quote(`${state}/root-crontab-absent`)} ]; then rm -f -- ${quote(file)}; fi`
    : `rm -f -- ${quote(file)}`
  return simpleTask(definition, state, {
    overview: 'Install an isolated scheduled cron entry using the distribution scheduler.',
    files: [file, '/tmp/webminai-cron-ran', state],
    apply: `set -eu; test ! -e /tmp/webminai-cron-ran; ${apply}`,
    applyPurpose: 'Install the cron maintenance entry and its scheduler when needed',
    revert: `set -eu; if [ -d ${quote(state)} ]; then ${restore}; if [ ! -e ${quote(`${state}/was-present`)} ] && ${packagePresent(packageName)}; then ${packageRemove(packageName, state)}; fi; fi; rm -f -- /tmp/webminai-cron-ran; rm -rf -- ${quote(state)}`,
    revertPurpose: 'Restore the cron entry and scheduler package baseline',
    verifyApplied: `test -f ${quote(file)} && grep -Eq 'WEBMINAI_TEST_CRON|/tmp/webminai-cron-ran' ${quote(file)}`,
    verifyReverted: `test ! -e ${quote(state)} && test ! -e /tmp/webminai-cron-ran`,
    stateProbe: `${packageStateProbe(packageName)}; ${fileStateProbe([file, '/tmp/webminai-cron-ran', state])}`
  })
}

function buildLogrotateRule (taskId, definition) {
  const state = stateDirectory(taskId, definition.id)
  const file = '/etc/logrotate.d/webminai-test'
  const log = '/var/log/webminai-test.log'
  return simpleTask(definition, state, {
    overview: 'Install an isolated logrotate policy and test log.',
    files: [file, log, state],
    apply: `set -eu; test ! -e ${quote(file)}; test ! -e ${quote(log)}; install -d -m 0700 ${quote(state)}; printf '%s\n' '/var/log/webminai-test.log {' '    daily' '    rotate 2' '    missingok' '    notifempty' '    su root root' '}' > ${quote(file)}; printf '%s\n' 'Intent AI Ops logrotate test' > ${quote(log)}; chmod 0644 ${quote(file)} ${quote(log)}; if command -v logrotate >/dev/null 2>&1; then logrotate --debug ${quote(file)} >/dev/null; fi`,
    applyPurpose: 'Create and validate the logrotate rule',
    revert: `set -eu; rm -f -- ${quote(file)} ${quote(log)}; rm -rf -- ${quote(state)}`,
    revertPurpose: 'Remove the test log and rotation rule',
    verifyApplied: `test -f ${quote(file)} && test -f ${quote(log)}`,
    verifyReverted: `test ! -e ${quote(file)} && test ! -e ${quote(log)} && test ! -e ${quote(state)}`,
    stateProbe: fileStateProbe([file, log, state])
  })
}

function buildTmpfilesRule (taskId, definition) {
  const state = stateDirectory(taskId, definition.id)
  const file = '/etc/tmpfiles.d/webminai-test.conf'
  const directory = '/run/webminai-test-tmpfiles'
  return simpleTask(definition, state, {
    overview: 'Install an isolated systemd-tmpfiles directory rule.',
    files: [file, directory, state],
    apply: `set -eu; test ! -e ${quote(file)}; test ! -e ${quote(directory)}; install -d -m 0700 ${quote(state)}; printf '%s\n' 'd /run/webminai-test-tmpfiles 0750 root root -' > ${quote(file)}; chmod 0644 ${quote(file)}; systemd-tmpfiles --create ${quote(file)}`,
    applyPurpose: 'Install and apply the tmpfiles rule',
    revert: `set -eu; rm -rf -- ${quote(directory)}; rm -f -- ${quote(file)}; rm -rf -- ${quote(state)}`,
    revertPurpose: 'Remove the runtime directory and tmpfiles rule',
    verifyApplied: `test -f ${quote(file)} && test -d ${quote(directory)}`,
    verifyReverted: `test ! -e ${quote(file)} && test ! -e ${quote(directory)} && test ! -e ${quote(state)}`,
    stateProbe: fileStateProbe([file, directory, state])
  })
}

function simpleTask (definition, state, options) {
  return {
    plan: {
      changeOverview: options.overview,
      modifiedFiles: options.files,
      commands: [command('apply', `set -eu; if [ ! -e ${quote(`${state}/apply-complete`)} ]; then ${options.apply}; : > ${quote(`${state}/apply-complete`)}; fi`, options.applyPurpose, 'change', 300000)],
      revertCommands: [command('revert', options.revert, options.revertPurpose, 'change', 300000)]
    },
    verifyApplied: options.verifyApplied,
    verifyReverted: options.verifyReverted,
    stateProbe: options.stateProbe ?? fileStateProbe(options.files),
    definition
  }
}

function command (id, commandText, purpose, risk, timeoutMs, dependsOn = []) {
  return {
    id,
    command: commandText,
    purpose,
    risk,
    timeoutMs,
    requiresSudo: risk !== 'read',
    dependsOn
  }
}

function stateDirectory (taskId, catalogId) {
  return `${STATE_ROOT}/${taskId}-${catalogId}`
}

function packageCapture (state, packageName) {
  return `set -eu; test ! -e ${quote(state)}; install -d -m 0700 ${quote(state)}; if command -v dpkg-query >/dev/null 2>&1; then dpkg-query -W -f='\${binary:Package}\n' | LC_ALL=C sort -u > ${quote(`${state}/packages-before`)}; fi; if ${packagePresent(packageName)}; then : > ${quote(`${state}/was-present`)}; fi`
}

function packagePresent (packageName) {
  return `{ if command -v dpkg-query >/dev/null 2>&1; then dpkg-query -W -f='\${Status}' ${quote(packageName)} 2>/dev/null | grep -q 'install ok installed'; elif command -v rpm >/dev/null 2>&1; then rpm -q ${quote(packageName)} >/dev/null 2>&1; elif command -v apk >/dev/null 2>&1; then apk info -e ${quote(packageName)} >/dev/null 2>&1; elif command -v pacman >/dev/null 2>&1; then pacman -Q ${quote(packageName)} >/dev/null 2>&1; else false; fi; }`
}

function packageInstall (packageName) {
  return `if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y ${quote(packageName)}; elif command -v dnf >/dev/null 2>&1; then dnf -y install ${quote(packageName)}; elif command -v yum >/dev/null 2>&1; then yum -y install ${quote(packageName)}; elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install ${quote(packageName)}; elif command -v apk >/dev/null 2>&1; then apk add ${quote(packageName)}; elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm --needed ${quote(packageName)}; else echo 'supported package manager not found' >&2; exit 2; fi`
}

function packageRemove (packageName, state) {
  return `if command -v apt-get >/dev/null 2>&1; then current=$(mktemp); trap 'rm -f -- "$current"' EXIT; dpkg-query -W -f='\${binary:Package}\n' | LC_ALL=C sort -u > "$current"; LC_ALL=C comm -13 ${quote(`${state}/packages-before`)} "$current" > ${quote(`${state}/packages-added`)}; if [ -s ${quote(`${state}/packages-added`)} ]; then DEBIAN_FRONTEND=noninteractive xargs -r apt-get purge -y -- < ${quote(`${state}/packages-added`)}; fi; rm -f -- "$current"; trap - EXIT; elif command -v dnf >/dev/null 2>&1; then dnf -y remove ${quote(packageName)}; elif command -v yum >/dev/null 2>&1; then yum -y remove ${quote(packageName)}; elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive remove ${quote(packageName)}; elif command -v apk >/dev/null 2>&1; then apk del ${quote(packageName)}; elif command -v pacman >/dev/null 2>&1; then pacman -Rns --noconfirm ${quote(packageName)}; else echo 'supported package manager not found' >&2; exit 2; fi`
}

function packageStateProbe (packageName) {
  return `if ${packagePresent(packageName)}; then printf 'package=${packageName} present '; if command -v dpkg-query >/dev/null 2>&1; then dpkg-query -W -f='\${Version}\\n' ${quote(packageName)}; elif command -v rpm >/dev/null 2>&1; then rpm -q --qf '%{VERSION}-%{RELEASE}\\n' ${quote(packageName)}; elif command -v apk >/dev/null 2>&1; then apk info -e ${quote(packageName)}; else pacman -Q ${quote(packageName)}; fi; else printf 'package=${packageName} absent\\n'; fi; if command -v dpkg-query >/dev/null 2>&1; then printf 'dpkg-packages='; dpkg-query -W -f='\${binary:Package}\\n' | LC_ALL=C sort -u | sha256sum | awk '{print $1}'; printf 'dpkg-audit='; dpkg --audit | sha256sum | awk '{print $1}'; fi`
}

function fileStateProbe (paths) {
  return paths.map(file => `if [ -f ${quote(file)} ]; then printf 'file=%s ' ${quote(file)}; sha256sum ${quote(file)} | awk '{print $1}'; elif [ -d ${quote(file)} ]; then printf 'dir=%s\\n' ${quote(file)}; else printf 'absent=%s\\n' ${quote(file)}; fi`).join('; ')
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
