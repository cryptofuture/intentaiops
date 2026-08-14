#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AdminService } from '../src/admin-service.js'
import { CodexPlanner } from '../src/codex-planner.js'
import { MultiHostService } from '../src/multi-host-service.js'
import { SettingsStore } from '../src/settings-store.js'
import { SystemSsh } from '../src/system-ssh.js'

const ALL_HOSTS = [
  'webminai-almalinux-9',
  'webminai-alpine-323',
  'webminai-arch',
  'webminai-debian-13',
  'webminai-fedora-44',
  'webminai-opensuse-160',
  'webminai-oracle-9',
  'webminai-rocky-9',
  'webminai-ubuntu-2404'
]
const requestedHosts = process.argv.find(argument => argument.startsWith('--hosts='))?.slice(8).split(',').filter(Boolean)
const HOSTS = requestedHosts ?? ALL_HOSTS
if (HOSTS.length === 0 || new Set(HOSTS).size !== HOSTS.length || HOSTS.some(serverId => !ALL_HOSTS.includes(serverId))) {
  throw new Error('--hosts must contain a unique comma-separated subset of the nine Linux lab hosts')
}

const APPLICATIONS = [
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
].map((item, index) => ({ slug: item[0], name: item[1], marker: item[2], port: 18101 + index }))

const LEARNED_GUIDANCE = {
  n8n: [
    'Prefer the signed NodeSource repository on supported DEB and RHEL-family distributions when a newer Node major is required. For n8n 2.33.x select Node 24; use a verified tarball only on NodeSource-unsupported families whose distro package cannot satisfy n8n engines.',
    'On Debian and Ubuntu, install only the NodeSource nodejs package. It already bundles npm and conflicts with the distribution npm package; verify node and npm after installation instead of requesting both packages.',
    'When a pinned Node.js tarball is installed below /opt, npm and every package lifecycle script must run with that exact bin directory prepended to PATH. Invoking npm by absolute path is insufficient because its /usr/bin/env node shebang and child lifecycle scripts still resolve node through PATH.',
    'Node archive acquisition and npm installation are long phases. Preserve a partial curl download only if it is validated; otherwise replace it atomically, and assign these phases to Stage 2 jobs with a 900-second budget rather than a 30-second command request.',
    'Set npm_config_cache to a task-owned directory under the stable n8n task state during installation, so retries can resume downloads and revert can remove the cache without touching unrelated root npm state.',
    'Run npm installation with umask 022 so the non-root n8n service can traverse and read the installed tree. Do not recursively chmod or chown the multi-gigabyte node_modules tree after npm completes; that can exceed the long-job deadline after an otherwise successful install. Verify the generated launcher directly and apply ownership only to small task-owned state/config directories.',
    'A local npm prefix install creates the n8n launcher at PREFIX/node_modules/.bin/n8n (with its package entry below PREFIX/node_modules/n8n), not PREFIX/bin/n8n. Verify and supervise the actual local launcher or invoke the package entry with the pinned Node binary.',
    'A global-prefix npm install (`npm install --global --prefix PREFIX`) is different: it creates PREFIX/bin/n8n. Never validate or supervise PREFIX/node_modules/.bin/n8n after using --global. Retry preflight must reuse the exact install mode and launcher path from the completed acquisition command.',
    'If current inventory or execution proves a compatible n8n 2.33.x launcher is already installed at /usr/bin/n8n before the new baseline, treat that runtime as pre-existing: verify its version and reuse it for the service without reinstalling or removing it during revert.',
    'Node SHASUMS256.txt lines are HASH two-spaces FILENAME. Select with awk `$2 == archiveName`, then write `HASH  archivePath` for sha256sum -c. Do not compare $1 to the filename, and do not use bash process substitution in a portable Stage 2 shell command.',
    'Keep nginx generation plain POSIX sh with ASCII-only variable names. Use the supplied primaryAddressCommand only to set n8n base/webhook URLs; command diagnostics and local health checks must use loopback.',
    'Within the remote plan, curl n8n health at 127.0.0.1:5678 and the nginx marker at 127.0.0.1:18109 only. Do not construct a curl URL from an address shell variable; the controller independently verifies the externally reachable host-IP URL.',
    'For the compatibility marker, a task-owned nginx root response containing WEBMINAI_N8N_OK is sufficient when n8n health and persistent storage are verified separately. Do not fabricate an n8n workflow export schema merely to produce the marker; importing active workflows is version-sensitive and obscures safe diagnostics.',
    'Keep n8n on its default internal path for this compatibility deployment. After systemd start, poll http://127.0.0.1:5678/healthz for up to ten minutes because a first boot can remain active while applying many SQLite migrations; systemctl is-active immediately after restart is not readiness. On failure, return bounded journalctl output after ensuring the unit environment never prints the encryption key. The public nginx / marker and the internal n8n health check are separate assertions.',
    'When N8N_USER_FOLDER is set to a directory such as /var/lib/n8n, n8n creates its state below that directory in .n8n. Verify SQLite persistence at N8N_USER_FOLDER/.n8n/database.sqlite, not directly at N8N_USER_FOLDER/database.sqlite.',
    'Never use shell tracing in any n8n command or generated wrapper. Use set -eu, never set -x/set -eux/set -o xtrace, because retry commands frequently reuse protected credential paths.'
  ],
  ghost: [
    'Ghost 6.57.x requires Node ^22.23.1 and MySQL 8 in production. Prefer the signed NodeSource Node 22 repository on supported DEB and RHEL-family distributions; Node 24 is not supported by Ghost 6.',
    'Treat MariaDB as incompatible with Ghost production rather than silently substituting it for MySQL 8. Use the official Ghost 6 Compose image with MySQL 8 on Docker-preferred hosts.'
  ],
  magento: [
    'On Debian-family hosts, generate /root/magento_credentials/opensearch_password before the OpenSearch apt command, then load it and set OPENSEARCH_INITIAL_ADMIN_PASSWORD in that same command. The environment does not persist between commands.',
    'Before attempting apt installation of OpenSearch, install its signing key and configure the official https://artifacts.opensearch.org/releases/bundle/opensearch/2.x/apt repository. Ubuntu 24.04 does not provide an opensearch package from its default repositories.',
    'On retry, reuse the exact OpenSearch apt source and Signed-By key path established by the earliest attempt. Never add a second source for the same repository with a different key path; apt rejects conflicting Signed-By values. Remove only a duplicate source proven task-owned before apt-get update.',
    'When an apt Signed-By conflict already exists, make repository deduplication the first executable correction. Every dpkg --configure -a, apt-get update, and apt-get install command must depend on that correction; a package-repair command cannot run successfully before the source conflict is removed.',
    'If any supplied apt source references a missing Signed-By key, repair or temporarily disable that source before the first general apt-get update, even when the current task has not reached its own repository phase. Debian 13 was observed with an OpenSearch source referencing missing /usr/share/keyrings/opensearch-keyring.gpg; base package installation cannot precede that repair.',
    'Debian 13 apt 3/sqv in the 2026 lab rejects the OpenSearch 2.x repository key binding because its SHA-1 certification violates current crypto policy. Do not weaken apt or Sequoia policy. Remove the task-owned broken OpenSearch apt source and install OpenSearch 2.19.6 from the official self-contained x64 tarball at artifacts.opensearch.org, verifying the adjacent .sha512 file before extraction. Create a task-owned opensearch user, /opt/webminai/opensearch-2.19.6 tree, data/log paths, and systemd unit exactly as the official tarball guidance requires, with complete rollback ownership.',
    'The observed Ubuntu retry conflict includes /etc/apt/sources.list.d/opensearch.list and /etc/apt/sources.list.d/opensearch-2.x.list. Select one canonical task-owned source, then inspect every file under /etc/apt/sources.list.d for the exact OpenSearch repository URL and remove all other matching task-created source files before apt-get update; checking only two guessed filenames is insufficient.',
    'Repository deduplication is idempotent and must succeed when no duplicate remains. For this retry chain the canonical pair is /etc/apt/sources.list.d/opensearch-2.x.list with /usr/share/keyrings/opensearch-keyring.gpg. Create or normalize that canonical source first, remove other matching sources second, run apt-get update, and never require a now-removed duplicate such as opensearch.list to exist.',
    'After installing or reconfiguring OpenSearch, restore opensearch:opensearch ownership recursively on the task-used /var/lib/opensearch and /var/log/opensearch paths before starting the service. A previous root-run configuration or cleanup can leave /var/lib/opensearch/nodes inaccessible; classify java.nio.file.AccessDeniedException there as PERMISSION_DENIED rather than a generic service timeout.',
    'For Magento 2.4.8-p5 source acquisition, the verified GitHub tag archive route is https://github.com/magento/magento2/archive/refs/tags/2.4.8-p5.tar.gz. Do not invent a GitHub release asset or checksum URL that returns 404.',
    'Ubuntu 24.04 requires the split php8.3-bcmath package before Composer validates the Magento lock file. Include it in the explicit package phase rather than discovering it during acquisition.',
    'Set COMPOSER_ALLOW_SUPERUSER=1 for the approved root-owned non-interactive Composer phase and keep --no-dev --no-interaction --prefer-dist --no-progress.',
    'Composer runs as root and can recreate vendor files with root-only modes. After every Composer install or retry, chown the complete Magento tree to the PHP-FPM service identity and restore directory/file traversal and read modes before restarting PHP-FPM. An HTTP 500 with Vendor autoload is not found while vendor/autoload.php exists is a permission failure.',
    'Permission normalization must preserve executable modes on Magento command scripts, especially bin/magento. Do not chmod every regular file to 0644; explicitly chmod 0755 bin/magento after normalization. A 200 marker with an otherwise empty verify failure can be the [ -x bin/magento ] gate.',
    'The required WEBMINAI_MAGENTO_OK marker must appear in an unauthenticated GET of the site root, not only in a separate pub/webminai-marker.txt file. Configure a Magento-rendered homepage/head marker and flush cache, or make nginx root return the marker while preserving a separate application health path; verification and controller curl must request the same endpoint.',
    'Use the fixed validated database identifier magento_18108 without SQL backticks. Never emit double-escaped backticks inside a here-document; MariaDB receives the backslash and rejects the statement.',
    'A retry must reuse the earliest baseline and task-owned /srv/webminai-magento-18108, /var/lib/webminai/webminai-magento-18108, and /root/magento_credentials state. Never back up or record those partial resources as pre-existing in a retry.',
    'A retry baseline gate may require only artifacts actually created by the earliest completed baseline command, such as baseline and packages.before. Do not require packages-added.txt or another later-phase artifact when the first attempt failed before that artifact was recorded; derive it idempotently from packages.before and the current package set.',
    'On the Debian 13 retry chain, the earliest baseline marker is named baseline.complete (not baseline) alongside packages.before. Reuse those exact observed filenames and never invent or rename a baseline gate.',
    'Download the Magento tag archive to a task-owned temporary file with curl retries, validate it with tar -tzf, and only then atomically replace the stable archive. On retry, discard a truncated prior temporary or stable archive instead of attempting to extract it.',
    'When promoting a fully composed Magento .new directory on retry, do not use mv -T over a non-empty existing directory. Move the existing task-owned root to a .previous sibling, move .new into the stable path, then remove .previous only after promotion succeeds; restore it if promotion fails.',
    'Generate database and Magento administrator usernames as well as passwords on the host under /root/magento_credentials. Load them only inside the command that consumes them; never place literal login values in the plan, task output, or diagnostics.',
    'Resolve the database version before package installation. Magento 2.4.8-p5 rejects Ubuntu 24.04 MariaDB 10.11; use the distribution MySQL 8 route there instead of bypassing database validation. Supported MariaDB branches are 10.2-10.6 and 11.4-11.8.',
    'For this isolated loopback-only single-node compatibility deployment, write plugins.security.disabled: true in the task-owned OpenSearch configuration and pass --opensearch-enable-auth=0 to Magento. Do not enable the security plugin after replacing the package SSL configuration, because OpenSearch then fails with No SSL configuration found.',
    'Write the complete task-owned OpenSearch YAML atomically or remove every prior plugins.security.disabled line before adding exactly one. Retries must never append the same YAML key; OpenSearch rejects duplicate fields.',
    'Keep the OpenSearch HTTP port consistent across service configuration, setup:install, Magento stored catalog/search/opensearch_server_port, and retry maintenance. This Ubuntu canary uses 9200. Before setup:upgrade or reindex, reconcile Magento config to the actually listening port; No alive nodes with OpenSearch healthy on 9200 indicates stale Magento port 19200.',
    'On the 2 GiB lab hosts, add a task-owned /etc/opensearch/jvm.options.d/webminai-magento-18108.options containing -Xms512m and -Xmx512m before starting OpenSearch. Include that exact file in baseline ownership and rollback; the package default 1 GiB heap can trigger the host OOM killer during startup.',
    'On Ubuntu MySQL 8 with binary logging enabled, add the task-owned /etc/mysql/mysql.conf.d/webminai-magento-18108.cnf with a [mysqld] log_bin_trust_function_creators=1 setting and restart MySQL before setup:install. Magento creates indexer triggers and otherwise fails with SQLSTATE 1419. Baseline and revert must preserve or remove that exact drop-in according to prior ownership.'
  ],
  wordpress: [
    'Do not add Netdata API or curl inventory snapshots to the command plan; the controller already supplied current inventory and separately verifies the final HTTP endpoint.',
    'Use webminaiLinuxContext.applications.wordpress as the authoritative reviewed profile for this distro. Use its exact packages, PHP/PHP-FPM binaries, services, pool/vhost paths, users/groups and fixed deployment paths unless execution proves a particular field is absent.',
    'Keep verified WordPress and WP-CLI artifacts under the profile stable artifactDirectory. Invoke the profile wpCliPhar through the profile phpBinary; never assume a wp command exists or install an untracked /usr/local/bin/wp.',
    'Use the profile databaseHost localhost exactly. Do not substitute 127.0.0.1 for wp config create unless the plan explicitly creates and owns that distinct MariaDB account.',
    'If the profile sets nginxIncludeRequired, preserve nginxMainConfig, add nginxIncludeDirective exactly once inside http {}, and restore the original file during revert. Arch nginx does not load conf.d by default.',
    'With WP-CLI --prompt=dbpass, omit --dbpass completely. An additional empty --dbpass= option can override or disrupt the protected stdin prompt.',
    'Use the profile task-owned PHP-FPM Unix socket and nginxFastcgiPass exactly. Create phpFpmRuntimeDirectory with the PHP-FPM service identity, use socket owner/group from the profile and mode 0660, require test -S after restart, and do not discover or scan unrelated PHP-FPM pools.',
    'Set all profile nginxRequiredFastcgiParams in the PHP location, especially HTTP_HOST $http_host and SERVER_PORT $server_port. A distro fastcgi_params file may omit HTTP_HOST and cause a WordPress canonical self-redirect loop.',
    'Do not assume WordPress core or WP-CLI exists as an OS package. If the distribution repositories do not provide it, use an official upstream artifact selected at execution time and verify it using upstream integrity metadata before execution or extraction.',
    'The official latest.tar.gz.sha1 response may be only a 40-hex digest. Validate and compare that digest explicitly with sha1sum output; do not use the raw response as a sha1sum -c checksum file.',
    'The current latest.tar.gz.sha1 is exactly 40 hexadecimal bytes with no newline. Strip only CR/LF, reject empty or non-hex content, require the shell string length to equal 40, and compare sha1sum field 1. Do not use printf without a newline piped to wc -l or a run of ? wildcards.',
    'For curl, put --output PATH before the URL; never put -- before -o/--output, which makes curl stream the archive to stdout and history.',
    'Resolve PHP extensions and service unit names from the exact distribution. In particular, do not assume an openSUSE package named php8-xml, and do not assume RPM-family repositories provide packages named wordpress or wp-cli.',
    'For openSUSE Leap 16, use the locally verified split packages php8-dom, php8-xmlreader and php8-xmlwriter rather than requiring a php8-xml metapackage.',
    'For openSUSE run the profile packageRefreshCommand before installation so stale mirror metadata cannot keep pointing at replaced RPMs.',
    'For openSUSE Leap 16 install the split php8-cli and php8-phar packages and invoke /usr/bin/php; php8 alone provides neither the CLI binary nor the Phar class, and /usr/bin/php8 is absent.',
    'For openSUSE Leap 16, php-fpm.service and /usr/sbin/php-fpm are the verified unit and binary; use zypper --non-interactive install --no-recommends because Leap 16 rejects --no-recommends as a global option. Alpine requires the separate mariadb-client package for its CLI.',
    'Minimal containers may lack tar or have a missing CA bundle. Include ca-certificates, tar, gzip, and openssl in the explicit package installation when the supplied command inventory says they are absent; stop immediately if download, digest validation, or extraction fails.',
    'Shell variable names may contain only portable identifier characters; never derive a variable name directly from a service name containing a hyphen, such as php-fpm.',
    'Use stable application ownership webminai-wordpress-18101 across the retry chain. Numeric task IDs belong only below /var/lib/webminai/task-state and must not appear in site, database, pool, service, web-root, or credentials names.',
    'Keep package installation, core and WP-CLI retrieval, credentials, database bootstrap, web configuration, and verification as separate commands so sanitized failures still identify the failing stage.',
    'Commands execute independently: every command that references db_password or admin_password must load that variable from its protected file in the same command. No shell variable survives from an earlier command.',
    'Use timeoutMs 300000 for package installs; set DEBIAN_FRONTEND=noninteractive for apt/apt-get. Treat an empty package-added diff as success with an explicit || true.',
    'Start and, when needed, initialize MariaDB in a preceding command, then wait with bounded retries for a non-secret SELECT 1 before any command issues CREATE DATABASE; the database command must depend on that ready-service command.',
    'Preserve MariaDB/MySQL root socket authentication: never ALTER the root password and never set MYSQL_PWD to the application password on a -uroot administrative command. Apply the generated password only to the task-owned application user.',
    'On Arch and Alpine, restart MariaDB after initialization rather than only starting an already-active unit, then require its local socket SELECT 1 probe to succeed before continuing. Package installation may leave an active process whose socket path was removed by earlier cleanup.',
    'Create /run/mariadb and /run/mysqld with mysql:mysql ownership before restarting MariaDB; Fedora 44 galera_recovery requires /run/mariadb during ExecStartPre.',
    'For nginx -t, PHP-FPM validation, package installation, and service-start failures, expose bounded non-secret diagnostics instead of only a generic marker. Keep database and bootstrap logs suppressed because they may contain credentials.',
    'Write the exact fixed loopback TCP listener into the task-owned PHP-FPM pool. On unprivileged LXD, direct nginx -t may fail on a package default port-80 listener because the Stage 2 child lacks CAP_NET_BIND_SERVICE; preserve and move/disable a newly installed default listener or validate through the service manager. Explicitly reload/restart nginx after writing a virtual host; enable --now alone does not load it.',
    'On Debian-family versioned PHP-FPM, use the versioned binary default for -t or derive /etc/php/VERSION/fpm/php-fpm.conf from the version. Never construct /etc/php/fpm/fpm/php-fpm.conf from basename of the pool parent.',
    'When awk builds a PHP-FPM pool using ENVIRON, put environment assignments before awk or use awk -v. Assignments after the awk program do not populate ENVIRON and can create an empty user/group.',
    'On RPM-family hosts begin a task pool directly with [webminai-wordpress-18101]; do not prepend an ad-hoc comment or token that this PHP-FPM parser may treat as a NULL ini entry.',
    'Every WP-CLI invocation runs under the Stage 2 root identity and must include --allow-root (or set WP_CLI_ALLOW_ROOT=1 in that same command).',
    'Never put the database or administrator password in WP-CLI argv. Pipe each protected value through stdin to the corresponding --prompt=dbpass or --prompt=admin_password option and suppress output.',
    'Use the official stable WP-CLI URLs under raw.githubusercontent.com/wp-cli/builds/gh-pages/phar for wp-cli.phar and wp-cli.phar.sha512. The wp-cli/wp-cli GitHub release does not publish those assets. The SHA-512 response is only a bare 128-hex digest, so compare it explicitly with sha512sum field 1 rather than using sha512sum -c.',
    'Never set WordPress core --url, home, or siteurl to localhost or 127.0.0.1. Resolve the primary non-loopback address during execution and use http://ADDRESS:18101, otherwise external verification follows a redirect into the controller loopback.',
    'Use the profile ip-based primaryAddressCommand. Do not resolve socket.gethostname(), hostname -i, or the local hostname through DNS because an LXD hostname need not resolve.',
    'On Arch, enable required bundled PHP modules in a task-owned INI/configuration step before checking php -m; package installation alone does not enable gd, intl, or mysqli.',
    'On Alpine 3.23, include php83-phar before executing the official WP-CLI phar; PHP and php83-fpm alone do not provide the split Phar extension.',
    'Never curl http://0.0.0.0; 0.0.0.0 is only a bind wildcard. Use 127.0.0.1 for local verification and the concrete primary address for externally canonical URLs.',
    'Do not double-escape SQL backticks inside a Bash double-quoted client argument. Prefer the fixed validated database identifier webminai_wordpress_18101, or use exactly one shell escape.',
    'Here-documents in a command string require real newline characters. Never put literal backslash-n text between the <<SQL opener, SQL body, and terminator.',
    'Do not pass a backslash-n-filled single quoted configuration blob to printf %s; it writes literal \\n into PHP-FPM/nginx files. Use one printf argument per line, real command newlines, a here-document, or carefully bounded printf %b.',
    'Do not source an unquoted generated environment file containing discovered runtime values. Record exactly one validated PHP-FPM listener or read it directly and quote the assignment.',
    'Always restart nginx after writing the virtual host and verify it is active. Do not use reload on this fleet because the clean baseline intentionally leaves nginx inactive.',
    'For nginx Unix-socket PHP forwarding use fastcgi_pass unix:/absolute/socket/path, never a bare /run path. Write one safely quoted server-block line per printf argument so shell expansion cannot move location directives outside server {}.',
    'On these unprivileged LXD hosts omit direct nginx -t entirely. Restart nginx through systemd/OpenRC, verify the active listener, and show bounded service logs when restart fails.',
    'Filter protected packages while creating the forward packages.added file. Revert should consume that already-sanitized file and must not repeat protected package names beside an apk/apt/dnf/zypper/pacman removal command.',
    'Never remove curl, Netdata, OpenSSH, the Intent AI Ops runner, action key, or plugin. Exclude them from every computed package-added rollback list.',
    'Use portable base-system tools in reverts; do not require rg. Do not run a repository-availability pass/fail preflight. Check installed packages, then let one explicit package installation command resolve missing packages; an empty apt-cache/apk search/repoquery/zypper search result is not a blocker.',
    'Make the selected virtual host answer unauthenticated GET / with the marker on 0.0.0.0 or :: at the fixed port. Repair permissions and SELinux labels when applicable without disabling SELinux; a localhost-only health path is not sufficient.',
    'Do not fail only because /wp-json/ is unavailable under the chosen rewrite setup. WordPress core is-installed, the public root marker, database connectivity, and restart persistence are authoritative health checks.',
    'SELinux repair is conditional: use restorecon when available, but semanage only when SELinux is enabled and its policy store is manageable. Disabled or unmanaged SELinux is a successful no-op.',
    'Treat retry state as partially applied. Reconcile only task-owned files, database objects, services, and packages, and make each correction command safely idempotent.',
    'Reuse the exact baseline filenames written by completed earlier commands; never invent packages.baseline, ownership.baseline, or another marker absent from the saved plan. When the failure occurred before artifacts/configuration, perform that missing stage idempotently rather than requiring its output.',
    'Never create an "unknown-after-prior-partial-apply" replacement baseline or a guessed static packages.added list. Preserve the earliest factual baseline and compute package additions from its real before/after difference.',
    'Credential files such as /root/wordpress_credentials/db_password contain one raw value. Read the first line without printing it; do not parse a db_password= prefix unless the saved generation command actually wrote that format.'
  ]
}

const requestedSlug = process.argv.find(argument => argument.startsWith('--task='))?.slice(7)
const runAll = process.argv.includes('--all')
const useLearnedPlan = process.argv.includes('--learned-plan')
const forceResourceRun = process.argv.includes('--force-resource-run')
const maxRetriesArgument = process.argv.find(argument => argument.startsWith('--retries='))?.slice(10) ?? '2'
const maxRetries = Number(maxRetriesArgument)
const retryRunArgument = process.argv.find(argument => argument.startsWith('--retry-run='))?.slice(12)
const initialRetryRunId = retryRunArgument === undefined ? null : Number(retryRunArgument)
if (!process.env.VAULT_TEST) throw new Error('VAULT_TEST is required')
if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new Error('--retries must be between 0 and 5')
if (initialRetryRunId !== null && (!Number.isInteger(initialRetryRunId) || initialRetryRunId < 1)) throw new Error('--retry-run must be a positive run id')
if (!runAll && !requestedSlug) throw new Error('usage: validate-top20-linux.js --task=SLUG [--retries=N] | --all [--retries=N]')
if (runAll && initialRetryRunId !== null) throw new Error('--retry-run can only be used with one --task')
if (forceResourceRun && (requestedSlug !== 'magento' || runAll)) throw new Error('--force-resource-run is available only with --task=magento')
if (useLearnedPlan && (!['wordpress', 'n8n', 'ghost', 'mattermost', 'odoo', 'jellyfin', 'home-assistant'].includes(requestedSlug) || runAll)) throw new Error('--learned-plan currently supports only --task=wordpress, --task=n8n, --task=ghost, --task=mattermost, --task=odoo, --task=jellyfin, or --task=home-assistant')
if (useLearnedPlan && maxRetries !== 0) throw new Error('--learned-plan requires --retries=0; fix and reset the deterministic plan instead of retrying partial state')

const selectedApplications = runAll
  ? APPLICATIONS
  : APPLICATIONS.filter(application => application.slug === requestedSlug)
if (selectedApplications.length === 0) throw new Error(`unknown task slug: ${requestedSlug}`)

const dataRoot = path.resolve(process.env.WEBMINAI_DATA_ROOT ?? path.join(os.homedir(), '.webminai'))
const settingsStore = new SettingsStore(dataRoot)
const settings = await settingsStore.load()
for (const serverId of HOSTS) {
  if (!settings.servers[serverId]) throw new Error(`Linux validation host is missing: ${serverId}`)
}

const source = await readFile(new URL('../top-20-cross-platform-codex-tasks.md', import.meta.url), 'utf8')
const sharedContract = extractCodeBlock(source, '## Shared task contract')
const admins = new Map()
const addresses = new Map()
for (const serverId of HOSTS) {
  const server = await settingsStore.decryptServer({ settings, passphrase: process.env.VAULT_TEST, serverId })
  addresses.set(serverId, new URL(server.connectionUrl).hostname)
  admins.set(serverId, new AdminService({
    dataRoot,
    ssh: new SystemSsh(),
    settings: settingsStore,
    planner: new CodexPlanner()
  }))
}

const service = new MultiHostService({
  dataRoot,
  concurrency: Number(process.env.WEBMINAI_TEST_CONCURRENCY ?? (forceResourceRun ? 1 : 3)),
  adminFor: serverId => admins.get(serverId)
})

let failed = false
for (const application of selectedApplications) {
  const succeeded = await validateApplication(application)
  if (!succeeded) {
    failed = true
    if (runAll) break
  }
}
if (failed) process.exitCode = 1

async function validateApplication (application) {
  const applicationTask = extractCodeBlock(source, `## ${APPLICATIONS.indexOf(application) + 1}. ${application.name}`)
  const request = [
    sharedContract,
    applicationTask,
    `For this Linux fleet validation, use the fixed externally reachable test port ${application.port} and ensure an HTTP GET of / contains ${application.marker}.`,
    `Use /root/${application.slug.replaceAll('-', '_')}_credentials as the only credentials directory.`,
    'Every selected host is an LXD test container with effective Docker preference auto-disabled. Do not use Docker or Docker Compose on this run.',
    ...(['n8n', 'ghost'].includes(application.slug)
      ? [`This is an executable native Linux learning run for ${application.name}, not a profile-discovery consultation. The absence of a prebuilt Intent AI Ops application profile is not a compatibility blocker. Use the supplied Node.js stack profile and exact distro facts, install a supported pinned runtime from an official upstream source when the distro package is outside the application matrix, supervise the service without Docker, and provide a complete task-owned revert. A genuine upstream platform or database incompatibility may produce a no-change result only when it is identified precisely and is not safely resolvable with a reviewed upstream package or artifact. Omit every command diagnostic field; verification belongs in the command itself and the controller's external probe.`]
      : []),
    ...(application.slug === 'mattermost'
      ? ['This is an executable native Linux learning run for Mattermost, not a profile-discovery consultation. Resolve the current upstream 64-bit Linux and PostgreSQL matrix, use the checksum-verified official Team Edition archive on supported distributions, isolate the PostgreSQL role/database, supervise Mattermost as a dedicated service identity, and provide a complete task-owned revert. Do not introduce Node.js: Mattermost Server is distributed as a native Go binary. A genuine upstream platform incompatibility may produce a reviewed no-change result.']
      : []),
    ...(application.slug === 'odoo'
      ? ['This is an executable native Linux learning run for Odoo Community 19, not a profile-discovery consultation. Odoo 19 requires Python 3.10+ and PostgreSQL 13+. Use the checksum-pinned official nightly DEB on Ubuntu. The current Debian 13 DEB route is blocked by its removed python3-pypdf2 dependency, and the current Fedora 44 RPM route is blocked by unavailable Python 3.13 distribution dependencies. Do not fabricate dependency packages or improvise an unreviewed source/Python stack on other distributions. Isolate its PostgreSQL role/database, supervise Odoo as a dedicated service identity behind nginx, and provide exact rollback. A reviewed no-change compatibility result is correct on an LXD distribution without a satisfiable upstream-packaged native route.']
      : []),
    ...(application.slug === 'jellyfin'
      ? ['This is an executable native Linux learning run for Jellyfin 10.11.11, not a profile-discovery consultation. Use Jellyfin’s signed official repository on Debian 13 and Ubuntu 24.04. On x86-64 glibc distributions use the checksum-pinned official portable archive rather than third-party repositories. Alpine 3.23 must produce a no-change compatibility result because its musl community packages lag the current security release. Use isolated empty media/config/cache state, do not configure hardware devices or discovery, complete initialization from protected host-generated administrator credentials, expose nginx port 18113, and provide exact rollback.']
      : []),
    ...(application.slug === 'home-assistant'
      ? ['This is an executable Home Assistant 2026.8.1 compatibility run, not a request to improvise a Python host installation. Current supported installation methods are Home Assistant OS and Home Assistant Container. Every selected LXD host has Docker auto-disabled, so record a reversible no-change compatibility result without installing packages, Python environments, services, containers, credentials, or application data. The Docker-preferred physical host is validated separately with the official digest-pinned Container image.']
      : []),
    ...(['nextcloud', 'magento'].includes(application.slug)
      ? ['This is an executable Linux learning run, not a profile-discovery consultation. Use the supplied exact distro facts to select a supported native route and produce changing commands plus a complete revert. Return a no-change compatibility result only if the supplied host facts prove the application cannot run safely (for example an unsupported architecture); absence of a prebuilt Intent AI Ops profile or low current RAM is not by itself a blocker. Keep lab prerequisites such as swap in the separate common-task run; do not create or remove them as part of the application task. For safe diagnostics, omit the diagnostic field unless its target is a simple package/service identifier or a loopback HTTP URL accepted by the supplied schema.']
      : []),
    ...(forceResourceRun
      ? ['WEBMINAI_FORCE_RESOURCE_RUN. The user explicitly authorizes this disposable lab stress test despite Magento resource recommendations. A resource assessment is still required for diagnostics, but CPU count, current RAM, current swap, or recommended production sizing must not produce a no-change plan. Produce an executable installation plan and complete rollback. Do not create or remove swap: the hardware test prerequisite is owned by the separate common task. An actual package, runtime, storage, or process failure during execution must be reported as a failed phase and corrected from history. On Debian-family systems, generate /root/magento_credentials/opensearch_password before installing OpenSearch, then load it without printing and set OPENSEARCH_INITIAL_ADMIN_PASSWORD in the same independently executed apt installation command; this environment variable does not persist between commands and interrupted dpkg state must be repaired before unrelated package installation.']
      : []),
    ...(forceResourceRun ? LEARNED_GUIDANCE.magento.map(item => `Verified Magento fleet fact: ${item}`) : [])
  ].join('\n\n')
  process.stdout.write(`\n=== ${application.name} on ${HOSTS.length} Linux distributions (port ${application.port}) ===\n`)

  const runs = []
  const ancestorRuns = collectAncestorRuns(initialRetryRunId)
  const passed = new Set()
  const blocked = new Set()
  const initialRun = initialRetryRunId === null ? null : service.getRun(initialRetryRunId)
  if (initialRun) {
    for (const host of initialRun.hosts) {
      if (host.status !== 'completed') continue
      passed.add(host.serverId)
      const task = host.taskId ? admins.get(host.serverId).getTask(host.serverId, host.taskId) : null
      if (isCompatibilityOnly(task?.plan)) blocked.add(host.serverId)
    }
  }
  let remaining = initialRun === null
    ? [...HOSTS]
    : initialRun.hosts.filter(host => host.status !== 'completed').map(host => host.serverId)
  let parentRunId = initialRetryRunId
  for (let attempt = 0; attempt <= maxRetries && remaining.length > 0; attempt++) {
    const retryNumber = initialRetryRunId === null ? attempt : attempt + 1
    const run = await service.run({
      settings,
      passphrase: process.env.VAULT_TEST,
      serverIds: remaining,
      request,
      kind: useLearnedPlan ? 'catalog' : 'ai',
      catalogId: useLearnedPlan ? `${application.slug}-linux` : null,
      retryOfRunId: parentRunId,
      retryInstructions: parentRunId === null ? null : correctionInstructions(application, retryNumber),
      review: ({ hosts }) => reviewPlans(hosts, application),
      externalVerify: ({ serverId, plan }) => verifyApplicationOutcome(application, serverId, plan, true),
      onEvent: renderEvent
    })
    runs.push(run)
    for (const host of run.hosts) {
      if (host.status === 'completed') {
        passed.add(host.serverId)
        const task = host.taskId ? admins.get(host.serverId).getTask(host.serverId, host.taskId) : null
        if (isCompatibilityOnly(task?.plan)) blocked.add(host.serverId)
      }
    }
    remaining = run.hosts.filter(host => host.status !== 'completed').map(host => host.serverId)
    parentRunId = run.id
    printRun(run)
  }

  let revertFailed = false
  const revertRuns = uniqueRuns([...runs].reverse(), ancestorRuns)
  for (const run of revertRuns) {
    const candidates = run.hosts.filter(host => isRevertCandidate(host)).map(host => host.serverId)
    if (candidates.length === 0) continue
    const reverted = await service.revert({
      settings,
      passphrase: process.env.VAULT_TEST,
      runId: run.id,
      serverIds: candidates,
      review: async () => true,
      externalVerify: ({ serverId, taskId, admin }) => verifyApplicationOutcome(application, serverId, admin.getTask(serverId, taskId).plan, false),
      onEvent: renderEvent
    })
    printRun(reverted)
    if (reverted.hosts.some(host => candidates.includes(host.serverId) && host.status !== 'reverted')) revertFailed = true
  }

  const allPassed = HOSTS.every(serverId => passed.has(serverId))
  process.stdout.write(`${application.name}: apply=${allPassed ? 'all-hosts-passed' : `failed:${HOSTS.filter(id => !passed.has(id)).join(',')}`} revert=${revertFailed ? 'failed' : 'passed'}\n`)
  if (allPassed && !revertFailed && blocked.size === 0) {
    process.stdout.write(`PROMOTION_READY ${application.slug}: eligible for a learned deterministic Linux common task\n`)
  } else if (blocked.size > 0) {
    process.stdout.write(`${application.name}: COMPATIBILITY_BLOCK ${[...blocked].join(',')}; no changes were required and no learned deployment was promoted.\n`)
  }
  return allPassed && !revertFailed
}

function reviewPlans (hosts, application) {
  for (const host of hosts) {
    if (['nextcloud', 'magento', 'n8n', 'ghost', 'mattermost', 'odoo', 'jellyfin', 'home-assistant'].includes(application.slug)) {
      for (const command of host.plan.commands) {
        if (command.risk !== 'read' && (command.timeoutMs >= 300000 || /\b(?:acquire|download|install|initialize|migrate|index|compile|build|configure|package|runtime)\b/iu.test(`${command.id} ${command.phase ?? ''}`))) {
          command.executionMode = 'job'
          command.timeoutMs = Math.max(command.timeoutMs, 900000)
          if (application.slug === 'n8n' && /\b(?:npm|n8n)[-_ ]?install|\binstall[-_ ]?n8n\b/iu.test(`${command.id} ${command.command}`)) {
            command.timeoutMs = Math.max(command.timeoutMs, 1800000)
          }
        }
      }
      for (const command of host.plan.revertCommands) {
        if (command.risk !== 'read' && command.timeoutMs >= 300000) {
          command.executionMode = 'job'
          command.timeoutMs = Math.max(command.timeoutMs, 900000)
        }
      }
    }
    const commands = [...host.plan.commands, ...host.plan.revertCommands].map(command => command.command).join('\n')
    if (/(?:^|\n|&&|\|\||[;|])\s*(?:(?:sudo|doas|exec|command\s+-v)\s+)?docker(?:-compose)?(?:\s|$)/u.test(commands)) {
      process.stderr.write(`${host.serverId}: rejected plan because Docker is forbidden for the LXD fleet\n`)
      return false
    }
  }
  return true
}

async function verifyHttp (application, serverId, shouldExist) {
  const url = `http://${addresses.get(serverId)}:${application.port}/`
  const attempts = shouldExist ? 60 : 5
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
      const body = await response.text()
      const found = response.ok && body.includes(application.marker)
      if (shouldExist && found) return { message: `${url} returned ${application.marker}`, url, marker: application.marker }
      if (!shouldExist && !found) return { message: `${url} no longer returns the task marker`, url }
      lastError = new Error(`${url} returned HTTP ${response.status} without the expected marker state`)
    } catch (error) {
      if (!shouldExist) return { message: `${url} is closed after revert`, url }
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error(`external verification failed for ${serverId}: ${lastError?.message ?? url}`)
}

function verifyApplicationOutcome (application, serverId, plan, shouldExist) {
  if (plan?.compatibilityManifest?.selectedRoute?.status === 'unsupported') {
    return Promise.resolve({
      message: shouldExist
        ? `${serverId} recorded the reviewed no-change compatibility result`
        : `${serverId} removed the task-owned compatibility result`,
      compatibility: 'unsupported'
    })
  }
  return verifyHttp(application, serverId, shouldExist)
}

function isCompatibilityOnly (plan) {
  return (plan?.commands?.length === 0 && plan?.revertCommands?.length === 0) ||
    plan?.compatibilityManifest?.selectedRoute?.status === 'unsupported'
}

function correctionInstructions (application, attempt) {
  const learned = LEARNED_GUIDANCE[application.slug] ?? []
  return [
    `Correction attempt ${attempt} for ${application.name}. Diagnose the complete saved command history for this host and correct only the distro-specific failure.`,
    `Preserve ownership from earlier partial commands, keep Docker forbidden, keep all credentials host-generated under /root/${application.slug.replaceAll('-', '_')}_credentials without exposing values, use fixed port ${application.port}, make / return ${application.marker}, and retain a complete baseline-restoring revert.`,
    ...learned.map(item => `Fleet learning: ${item}`)
  ].join('\n')
}

function collectAncestorRuns (runId) {
  const runs = []
  let currentId = runId
  while (currentId !== null) {
    const run = service.getRun(currentId)
    runs.push(run)
    currentId = run.retryOfRunId
  }
  return runs
}

function uniqueRuns (...groups) {
  const seen = new Set()
  return groups.flat().filter(run => {
    if (seen.has(run.id)) return false
    seen.add(run.id)
    return true
  })
}

function isRevertCandidate (host) {
  if (!host.taskId || ['reverted', 'cancelled'].includes(host.status)) return false
  const task = admins.get(host.serverId).getTask(host.serverId, host.taskId)
  return Array.isArray(task.plan?.revertCommands) && task.plan.revertCommands.length > 0
}

function extractCodeBlock (markdown, heading) {
  const headingIndex = markdown.indexOf(heading)
  if (headingIndex < 0) throw new Error(`missing task heading: ${heading}`)
  const opening = markdown.indexOf('```text\n', headingIndex)
  if (opening < 0) throw new Error(`missing task text block after: ${heading}`)
  const start = opening + '```text\n'.length
  const end = markdown.indexOf('\n```', start)
  if (end < 0) throw new Error(`unterminated task text block after: ${heading}`)
  return markdown.slice(start, end).trim()
}

function renderEvent (event) {
  if (event.type === 'planner-progress') {
    const message = event.event?.message
    if (message) process.stdout.write(`[${event.serverId}] Codex: ${String(message).replaceAll(/\s+/gu, ' ').slice(0, 300)}\n`)
    return
  }
  if (['planning', 'planned', 'running', 'completed', 'failed', 'verified', 'reverting', 'reverted', 'revert-failed'].includes(event.type)) {
    process.stdout.write(`[${event.serverId}] ${event.type}: ${event.message ?? ''}\n`)
  }
}

function printRun (run) {
  process.stdout.write(`run #${run.id} ${run.status}: ${run.hosts.map(host => `${host.serverId}=${host.status}`).join(' ')}\n`)
}
