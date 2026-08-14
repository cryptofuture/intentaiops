# Top 20 Web-Hosting Applications

This list focuses on applications where a **preconfigured hosting image actually provides value**. I would exclude things like Nginx, Apache, Node.js, PostgreSQL, Docker, Redis, etc., because installing those from a package manager is already trivial.

1. **WordPress**
   Full WordPress installation with web server, PHP, database, HTTPS-ready configuration, permissions, and initial admin setup.

2. **Ghost**
   Ghost blogging/publishing platform with Node.js, database, reverse proxy, system service, and production configuration.

3. **Nextcloud**
   Self-hosted cloud storage with database, PHP, web server, background jobs, caching, and recommended production settings.

4. **WooCommerce**
   WordPress + WooCommerce preconfigured for running an online store, including the required PHP/database environment.

5. **Magento Open Source**
   E-commerce platform with PHP, database, OpenSearch, cron jobs, caching, permissions, and production configuration.

6. **PrestaShop**
   Complete e-commerce environment with PHP, database, web server, permissions, and initial store configuration.

7. **Drupal**
   Drupal CMS with PHP, database, web server, clean URLs, permissions, and production-ready configuration.

8. **Joomla**
   Joomla CMS with database, PHP, web server, permissions, and initial hosting configuration.

9. **Discourse**
   Community/forum platform with its Docker environment, PostgreSQL, Redis, email configuration, reverse proxy, and HTTPS support.

10. **GitLab Community Edition**
    Complete Git hosting and DevOps platform with GitLab services, database, Redis, workers, web interface, and HTTPS-ready configuration.

11. **Mattermost**
    Self-hosted team communication platform with database, application server, reverse proxy, file storage, and system services.

12. **Odoo Community**
    ERP/CRM/business-management platform with PostgreSQL, Odoo server, Python environment, workers, reverse proxy, and persistent storage.

13. **Moodle**
    Learning-management system with PHP, database, Moodle data directory, cron jobs, web server, and correct filesystem permissions.

14. **n8n**
    Workflow-automation platform with persistent storage, database, reverse proxy, HTTPS, webhook configuration, and production execution settings.

15. **Immich**
    Self-hosted photo and video management platform with its multiple services, database, machine-learning service, persistent storage, and Docker configuration.

16. **Jellyfin**
    Media server with persistent media/configuration directories, service configuration, networking, and optional hardware-transcoding preparation.

17. **Vaultwarden**
    Self-hosted Bitwarden-compatible password manager with persistent database/storage, reverse proxy, HTTPS, WebSocket support, and secure defaults.

18. **Home Assistant**
    Home-automation server with persistent configuration, networking, container/service setup, and common host integrations prepared.

19. **Coolify**
    Self-hosted application deployment platform with Docker, networking, proxy, persistent storage, HTTPS automation, and management interface configured.

20. **Plesk**
    Complete hosting control panel with web server, PHP environments, database services, mail/DNS components, security configuration, and hosting-management interface.

## Good Additional Images

If you want more than 20, these would also make sense as preconfigured hosting images:

* **HestiaCP** — complete open-source web-hosting control panel.
* **CyberPanel** — hosting environment built around OpenLiteSpeed.
* **Dokploy** — self-hosted application deployment platform.
* **Gitea / Forgejo** — Git hosting with database, SSH, web server and reverse proxy.
* **OpenProject** — project-management and collaboration platform.
* **Redmine** — project and issue tracking.
* **Zabbix** — infrastructure monitoring with server, database and frontend.
* **Grafana + Prometheus** — pre-integrated monitoring stack rather than installing either individually.
* **Sentry** — error monitoring; particularly valuable as a preconfigured stack because of its dependencies.
* **Mailcow** — complete self-hosted email platform; significantly more useful as a prepared image than individual mail packages.
* **Matrix Synapse + Element** — complete private messaging stack.
* **Mastodon** — federated social server with PostgreSQL, Redis, workers and web services.
* **Pterodactyl** — game-server management panel and supporting services.
* **OpenVPN Access Server** — ready-to-use VPN server rather than a bare OpenVPN installation.
* **WireGuard management stack** — e.g. WireGuard plus a web management interface rather than plain WireGuard.
* **MinIO deployment** — configured S3-compatible object-storage server with persistent disks and management interface.
* **Apache Superset** — analytics/BI stack with database, Redis and workers.
* **Metabase** — ready-to-use BI and database analytics server.
* **Chatwoot** — customer-support/helpdesk platform.
* **ERPNext** — ERP/business platform with its relatively complex supporting stack.

For a VPS provider, I'd prioritize **WordPress, Ghost, Nextcloud, WooCommerce, n8n, Coolify, GitLab, Odoo, Immich, Vaultwarden, Discourse and Mailcow** especially highly: these are cases where clicking **"Deploy"** instead of following a multi-step installation guide gives the customer meaningful value.
