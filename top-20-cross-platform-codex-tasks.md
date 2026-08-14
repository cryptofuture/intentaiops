# Top 20 Cross-Platform Codex Validation Tasks

This runbook turns the applications in `to-do-common-software-to-test.md` into controlled Intent AI Ops learning exercises. The objective is not merely to install each product. Each run should expose gaps in planning, platform detection, package selection, Docker preference, credential handling, verification, history, retry, and rollback.

## Test fleet

Run every Linux task as one parallel AI task against all nine disposable distro hosts:

- `webminai-almalinux-9`
- `webminai-alpine-323`
- `webminai-arch`
- `webminai-debian-13`
- `webminai-fedora-44`
- `webminai-opensuse-160`
- `webminai-oracle-9`
- `webminai-rocky-9`
- `webminai-ubuntu-2404`

Run the same task separately on:

- FreeBSD: `webminai-freebsd-14-4`
- Windows: `windows-11`
- macOS: `macos-15`

Use `ismet` only for the separate automatic-Docker and manual Docker-disable tests below. Do not include it in the nine-host disposable Linux group run.

### Separate `ismet` automatic Docker run

This run proves that Docker installation capability is independent from current Docker readiness and that Compose remains the preferred route:

1. Record `ismet`'s current Docker preference and a Docker state fingerprint so both can be restored exactly.
2. Set or retain preference `auto`, refresh status, and require Intent AI Ops to report a non-container Linux host with a supported Docker installation route. Docker may be absent; absence must be reported as `setup required`, not `unsupported`.
3. Run the shared contract plus the WordPress task. The selected plan must install Docker Engine and the Compose plugin when missing, then use a reviewable Compose project with separate protected credentials.
4. Verify `WEBMINAI_WORDPRESS_OK` from outside the host, verify restart persistence, and confirm history records the Compose route without credential values.
5. Revert WordPress and every task-owned Docker prerequisite. Require the post-revert Docker fingerprint to match the original, including the Docker-absent state when installation belonged to this task.
6. Continue directly to the manual Docker-disable run below, then restore the exact original preference.

### Separate `ismet` manual Docker-disable run

This run verifies that detected Docker capability never overrides an explicit user preference:

1. Record `ismet`'s current Docker preference so it can be restored exactly after the test.
2. Confirm Intent AI Ops detects `ismet` as a non-container Linux host with a supported Docker installation route. Docker and Compose may either already be ready or require installation; readiness and install capability are separate facts.
3. In the host menu, set `Docker preference` to `disabled`, then refresh status. The status should show that Docker is capable but not preferred because the user disabled it.
4. Run the shared contract plus the WordPress task on `ismet` as a separate single-host AI task, adding this instruction:

   ```text
   This host deliberately has Intent AI Ops Docker preference set to disabled for this test. Docker may be installed and fully usable, but it is forbidden for this task. Do not execute docker or docker-compose commands, do not create compose files, containers, images, networks, or volumes, and do not change the saved Docker preference. Use a supported native installation or return a safe no-change compatibility result. State that the manual disabled preference is the reason Docker was not selected.
   ```

5. Before approval, reject the plan if it contains Docker/Compose commands or Docker artifacts. A successful plan must use a native Ubuntu route or make no changes with a precise blocker.
6. If applied, verify the WordPress marker externally, revert it, and prove that no Docker state was created or changed by the task.
7. Restore `ismet`'s exact original Docker preference and refresh status.

### macOS container-parity gate

The macOS candidate wave reuses only the already promoted `ismet` Compose matrices. It must first pass the separate reviewed `colima-macos` prerequisite; do not reinterpret a missing Linux VM as application incompatibility.

1. Refresh `macos-15` inventory through Stage 2 and record the macOS version, architecture, memory, CPU count, Homebrew prefix and owner, `kern.hv_support`, Colima socket, Docker daemon state, and Compose state.
2. Require macOS 13 or newer, `x86_64` or `arm64`, a non-root Homebrew owner, and `kern.hv_support=1` before installing anything. A failed hypervisor gate is a no-change result with stable code `MACOS_HYPERVISOR_UNAVAILABLE`.
3. Install the reviewed Homebrew Colima, Docker CLI, and Compose substrate as the Homebrew owner. Stage 2 remains root, but Homebrew and Colima must never run as root.
4. Keep the shared Colima substrate separate from application ownership. Application reverts remove only their Compose project, task-owned images, volumes, files, and protected credentials.
5. Validate candidates sequentially using the same versions, image digests, ports, credential-file contract, application-native checks, external markers, restart recovery, and two-revert baseline comparison already promoted on `ismet`.
6. Do not promote a macOS catalog route until its complete lifecycle passes on `macos-15`. When resources are insufficient, return a resource compatibility result before pulling application images.

Current gate result (2026-08-11): `macos-15` is macOS 15.7.9 x86_64 with two CPUs, 4 GiB RAM, Homebrew under `/usr/local`, healthy root Stage 2 v0.7.2, and `kern.hv_support=1`. The reviewed `colima-macos` task installed Colima 0.10.3, Docker CLI 29.7.2, and Compose 5.4.0 as the non-root Homebrew owner. Signed inventory reports the Colima socket, Docker daemon, and Compose ready. A disposable nginx container was fetched externally through the macOS address and removed.

Promoted macOS candidates (2026-08-12): macOS now has full parity with every application promoted on Docker-preferred `ismet`: WordPress, WooCommerce, Joomla, Drupal, PrestaShop, Moodle, Magento Open Source, n8n, Ghost, Mattermost, Odoo Community, Jellyfin, and Home Assistant. Every route passed two applies, its application-native and external marker checks, full Compose restart recovery, two reverts, task-owned-state absence, and preservation of the shared Colima substrate on `macos-15`. The routes reuse the exact promoted ismet image/version matrices through one generic reviewed macOS Compose adapter, with a dedicated WordPress adapter retained for its previously promoted lifecycle. macOS credentials remain host-generated and absent from plans/logs; their directory is `0700` and files are `0600` under the detected Colima owner's home so virtiofs can mount them. Learned macOS adaptations include BSD `stat`, `jot`, and primary-address discovery; bounded quiet image pulls; non-root Homebrew/Colima ownership; user-home virtiofs bind paths for Jellyfin and Home Assistant; n8n dependency startup ordering; and state-based Home Assistant verification after onboarding makes that endpoint unavailable.

## How to run each task

1. Confirm Stage 2 is active, the current plugin version is installed, and the plugin reports privileged execution on every selected host.
2. Start with a `?` consultation using the application-specific task text. Record the proposed native, container, or unsupported route.
3. Run the authoritative task without `?`.
4. On Linux, select all nine lab hosts in one multi-host run. A different plan per distribution is expected even though the group has one request.
5. Verify the service from outside the target host using its connection IP and assigned test port.
6. Revert every successful child task from history. Retry only failed hosts and supply correction instructions when useful.
7. Confirm the application, containers, services, test files, firewall rules, credentials, and ports are absent after revert.

An unsupported platform is a valid result only when Codex detects it before mutation, explains the incompatibility, and proposes a practical alternative. It must not run Linux binaries on FreeBSD, macOS, or Windows merely to make the test appear successful.

## Research-backed failure-reduction strategy

The validation process should optimize for reuse and early deterministic rejection, not for asking Codex to rediscover a complete deployment on every host.

- **Make configuration data typed and explicit.** Empirical IaC research found that syntax/configuration defects made up 36.5–62.7% of defects in the four studied organizations. A related study found script size and hard-coded strings to be the strongest correlates of defective IaC scripts. Intent AI Ops should therefore supply a compact typed capability record and compose plans from small reviewed phases instead of producing one large shell program with embedded distro values. Sources: [Bugs in Infrastructure as Code](https://arxiv.org/abs/1809.07937), [Source Code Properties of Defective Infrastructure as Code Scripts](https://arxiv.org/abs/1810.09605).
- **Gather and cache facts, then branch on facts.** Follow the same model as Ansible facts: collect OS, architecture, package manager, service manager, installed packages, service state, filesystem/security facts and runtime versions once; cache stable facts; refresh only volatile facts. Missing helper tools must be represented as unknown rather than silently treated as unsupported. Sources: [Ansible facts](https://docs.ansible.com/projects/ansible/latest/playbook_guide/playbooks_vars_facts.html), [Ansible conditionals](https://docs.ansible.com/projects/ansible/latest/playbook_guide/playbooks_conditionals.html), [`os-release` identification](https://www.man7.org/linux/man-pages/man5/os-release.5.html).
- **Test convergence as a first-class property.** A learned task is not promoted after one successful installation. Run apply, application verification, a second idempotence apply, restart verification, revert, second no-op revert, and baseline comparison. Molecule uses separate converge, idempotence, verify, side-effect and cleanup phases for the same reason. Sources: [Molecule workflow](https://docs.ansible.com/projects/molecule/workflow/), [Molecule advanced test sequences](https://docs.ansible.com/projects/molecule/configuration/).
- **Separate started, ready and healthy.** A running process is not evidence that its database migrations or application bootstrap are ready. Every dependency needs a bounded readiness probe, and slow first startup needs a separate startup budget. Compose should use dependency health conditions where supported. Sources: [Docker Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/), [Kubernetes startup and readiness probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/).
- **Use a representative canary before fleet fan-out.** First run a new stack family on one deliberately chosen host, learn deterministic corrections, reset it, then expand to one host per package family and finally all nine. Interleave black-box verification and automatic rollback between stages. This follows staged rollout guidance and prevents one new assumption from failing everywhere at once. Sources: [Google SRE reliable launches](https://sre.google/sre-book/reliable-product-launches/), [Google SRE canarying releases](https://sre.google/workbook/canarying-releases/).
- **Pin resolved inputs, not guesses.** Resolve a supported application/runtime/database combination from current official metadata before planning; record versions, architectures, URLs and digests in a non-secret manifest; then execute that manifest consistently across hosts. Never use an unqualified `latest` tag in a promoted learned task.

### Required validation ladder for a new stack family

Linux substrate gate (promoted 2026-08-08): before another software candidate is attempted, use the typed stack profiles, explicit compatibility manifest, reviewed foundation phases, application-delta-only Codex planner, structured failure signatures, persistent phase scorecards, and staged scheduler implemented by Intent AI Ops. The live `npm run test:linux-substrate` promotion passed all nine Linux lab distributions plus the reversible Docker/Compose lifecycle on `ismet`, including two applies, restart recovery, two reverts, and exact baseline comparison.

1. Read-only compatibility resolver: official support matrix, host facts, Docker policy, ports and resources.
2. Static plan checks: shell/PowerShell syntax, dependency DAG, secret-flow rules, ownership paths, timeouts and revert coverage.
3. One canary host selected for maximum information, not convenience.
4. Clean canary apply, external marker, application-native health, restart and persistence checks.
5. Second apply must be a verified no-op; inject one safe side effect such as a service restart and verify recovery.
6. Revert and second no-op revert; compare the complete baseline fingerprint.
7. One host per package family in parallel: Debian, RPM, Alpine, Arch and SUSE.
8. Full nine-host run only after family representatives pass without AI correction.
9. Promote reusable facts and phases into a stack profile; retain application-specific initialization as the smaller remaining planning surface.

## Learning waves and priority order

The candidates remain the same, but execution is ordered by transferable knowledge. Completing a wave should produce reusable stack profiles before starting the next wave.

| Wave | Candidates in execution order | Reusable knowledge |
|---|---|---|
| A — PHP web/database | 1 WordPress, 2 WooCommerce, 3 Joomla, 4 Drupal, 5 PrestaShop, 6 Moodle, 7 Nextcloud, 8 Magento Open Source | nginx/PHP-FPM, PHP extension mapping, MariaDB readiness, config ownership, CLI installers, cron and Compose secrets |
| B — Node.js services | 9 n8n, 10 Ghost | Node version selection, package/artifact installation, service identity, base URLs, reverse proxy and protected application secrets |
| C — PostgreSQL applications | 11 Mattermost, 12 Odoo Community | PostgreSQL role/database ownership, migrations, service users and database rollback |
| D — cross-platform single services | 13 Jellyfin, 14 Vaultwarden, 15 Home Assistant | native repositories/binaries, SQLite or local persistence, process supervision and platform-specific service management |
| E — multi-service containers | 16 Immich, 17 Discourse, 18 GitLab Community Edition | resource gates, multiple readiness dependencies, upstream Compose drift, caches/queues and long bootstrap windows |

WooCommerce follows WordPress immediately because it is a WordPress plugin and inherits the learned stack. The remaining PHP applications increase in novelty and operational complexity; Magento stays last in that wave because its official matrix adds Composer, OpenSearch, MariaDB, queues/cache options and tighter version combinations. n8n is the Node.js canary before Ghost so Node/service supervision is learned on the smaller topology first.

## Shared task contract

Paste this contract before one of the 20 application-specific task texts below:

```text
This is a controlled, reversible Intent AI Ops compatibility test on the current host.

Use the supplied Netdata inventory first for platform, resources, containers, ports, and service state. Detect the exact OS, architecture, init/service manager, package manager, whether the host is itself a container, and the effective Docker preference before choosing an installation method.

The supplied inventory is already the controller's pre-task Netdata snapshot. Do not put Netdata API or curl snapshot commands into an application installation or revert plan merely to collect the same information again. Use application-specific health checks for the service being installed. Query Netdata inside the plan only when this task explicitly requests monitoring data or a required current fact is absent from the supplied inventory.

Treat Intent AI Ops's saved Docker preference as authoritative. If the user manually set it to `disabled`, Docker and Docker Compose are forbidden even when capability detection says they are installed, reachable, and supported: do not execute Docker commands, create Compose files or Docker resources, install Docker, or change the preference. Use a supported native route or return a safe no-change result, and record the manual preference as the reason.

Otherwise, when the effective preference allows Docker, Intent AI Ops reports Docker as ready or installable on the host, and the application has a supported container deployment, Docker Compose is the required preferred route. If Docker is installable but not ready, install Engine and the Compose plugin through the detected supported platform route as an owned, reversible prerequisite. Choose a native installation only when Compose is unsupported for this application/platform, Docker cannot be installed safely, the host is itself a protected container, or a documented safety/resource constraint makes Compose unsuitable; record that reason in the plan. For Docker deployments, create a reviewable `compose.yaml`, but keep every password, token, private key, and connection string in separate task-owned credential files. Use Compose `secrets` files where the image supports them; otherwise use a separate mode-0600 environment file referenced by `env_file`. Never put literal credentials in `compose.yaml`. On Linux, handle this exact distribution rather than assuming Debian or systemd. On FreeBSD use FreeBSD packages, rc.d, sysrc, and POSIX sh. On macOS use supported Homebrew packages and launchd/Homebrew services. On Windows use PowerShell 5.1-compatible commands, official signed installers or supported package tooling visible to LocalSystem, Windows services, and Windows paths.

Before changing anything, capture whether the application, packages, services, containers, images, volumes, networks, users, directories, firewall rules, and chosen ports already exist. Never replace or remove pre-existing state. Use a task-specific state directory and make repeated execution idempotent.

Generate all passwords, tokens, private keys, and connection strings on the target host during an approved command. Codex may plan the generation command and the destination path, but it must never generate, choose, infer, receive, or read back the credential value. Do not use fixed example credentials.

Store credentials in one service-specific directory: `/root/<service>_credentials` on Linux and FreeBSD, `/var/root/<service>_credentials` for native macOS services, a mode-0700 directory below the detected non-root Colima owner's home for macOS virtiofs Compose routes, or `C:\ProgramData\WebminAI\credentials\<service>` on Windows. The directory must be owned by the execution/runtime identity and mode 0700 where POSIX modes apply; each credential file must be mode 0600. For example, WordPress uses `/root/wordpress_credentials` on Linux rather than a shared credential file.

Credential values must never appear in the plan text, `compose.yaml`, command-line arguments, stdout, stderr, Codex progress or messages, Netdata output, SQLite history, debug logs, reports, or verification output. Commands may print only the credentials directory or file paths. Do not run `cat`, `Get-Content`, shell tracing, environment dumps, or equivalent output against credential files. If an installer might print a generated credential, redirect that output directly into the protected credential directory and emit only a sanitized success/failure message. Applications and containers must consume secrets directly from Compose `secrets`, `env_file`, protected configuration files, or stdin without displaying their contents.

Use an isolated non-default test port when practical. Configure the smallest necessary local firewall change and record ownership of that rule. Verify process/service health, application-level health, persistent storage, restart behavior, and an HTTP or protocol response containing a unique WEBMINAI marker. Report the exact URL or protocol endpoint for an external controller check.

Provide a complete revert plan. Revert must stop and remove only task-created services, containers, networks, volumes, packages, users, files, credentials, and firewall rules, then verify the original state fingerprint is restored. If this application has no supported and reasonably safe route on the current platform, make no changes and return a read-only compatibility report explaining the blocker and the best supported deployment target.
```

The credential rules in this shared contract are mandatory for every task below. In each application prompt, “protected credentials” means host-generated values stored in that application's service-specific credentials directory; it never means credentials generated by Codex or embedded in a plan.

## Candidate route legend

The routes below are hypotheses to test, not permission to assume compatibility. Codex must validate what is actually supported and available at execution time.

- **Compose**: the default and preferred route whenever the effective preference permits Docker, Docker is usable, and the application supports containers; `compose.yaml` must reference separate protected Compose secret or environment files.
- **Native**: use the platform's supported packages or official installer only when the plan records why Compose cannot or should not be used.
- **Manually disabled Docker**: an absolute prohibition regardless of detected capability; select Native or Expected block and create no Docker artifacts.
- **Evaluate**: perform capability discovery first; install only if a supported route is found.
- **Expected block**: test graceful unsupported-platform handling without mutation.

## 1. WordPress

Candidate routes: Linux Compose/native; FreeBSD native web/PHP/database stack; Windows Linux-container Docker Compose; macOS evaluate Homebrew development-style deployment.

```text
Install a minimal single-site WordPress test deployment with a database, persistent content, a unique WEBMINAI_WORDPRESS_OK page, and production-safe filesystem permissions. Keep database and initial administrator credentials out of logs. Verify the front page, the WordPress health path available for this deployment, database connectivity, and restart persistence. Do not perform interactive browser setup when it can be completed safely through a CLI or generated configuration. Revert the whole task-owned site and prove pre-existing web/database services were untouched.
```

Learning focus: PHP module discovery, database readiness, Compose secret handling, generated configuration ownership, and web-server coexistence.

Linux validation result (2026-08-08): promoted to the verified `wordpress-linux` common task after a clean apply, external marker check, and revert on all nine lab distributions. The separate `ismet` validation also passed both required routes: automatic Docker preference installed the missing Docker/Compose prerequisite, deployed WordPress with Compose, and restored the original Docker-absent fingerprint; manual `disabled` preference selected the native Ubuntu route and left the Docker fingerprint unchanged. Fedora 44 required the learned native profile to use TCP database access because `/var/lib/mysql` is not traversable by the PHP-FPM user, and to keep `wp-config.php` mode 0640 under the PHP-FPM identity.

Windows implementation result (2026-08-10): added the `wordpress-windows` reviewed common task by adapting the verified ismet Compose foundation to Docker Desktop/Windows Engine in Linux-container mode. It adds LocalSystem Docker discovery, protected `C:\ProgramData\WebminAI\credentials\wordpress` secrets, Windows paths, a task-owned firewall rule, durable Docker jobs, restart recovery, and task-owned image/volume/path rollback. Missing Docker now resolves to the separate reviewed `docker-desktop-windows` prerequisite, which validates hardware, enables WSL 2 features, handles explicit resumable reboots, installs the checksum- and Authenticode-verified all-users Docker Desktop build, and verifies Linux Engine plus Compose before the application plan becomes available. Live SSH and Stage 2 pass on `windows-11`; the bootstrap preflight correctly stopped without mutation at `FIRMWARE_VIRTUALIZATION_DISABLED` until virtualization is enabled in BIOS/UEFI.

## 2. WooCommerce

Candidate routes: same platform routes as WordPress, with plugin installation performed through supported WordPress tooling.

```text
Install WordPress plus WooCommerce as an isolated test store. Complete the non-interactive base installation, activate WooCommerce, create a harmless test page or product containing WEBMINAI_WOOCOMMERCE_OK, and keep all administrator/database credentials protected. Verify WordPress, WooCommerce activation, database persistence, page access, and restart behavior. Revert the store, plugin data, database, credentials, and task-owned infrastructure while preserving anything that existed before the task.
```

Learning focus: layered application ownership, wp-cli availability, plugin activation checks, and rollback of database-backed application state.

Linux validation result (2026-08-08): promoted to the verified `woocommerce-linux` common task after the required staged ladder. The Debian canary, one representative for every package family, and all remaining Linux lab hosts passed two applies, restart recovery, two no-leak reverts, external `WEBMINAI_WOOCOMMERCE_OK` verification, and exact baseline comparison. `ismet` separately passed the automatic Docker route: Intent AI Ops installed its owned Docker/Compose prerequisite, deployed the pinned WordPress 7.0.2/PHP 8.3/MariaDB 11.8 foundation and digest-pinned WooCommerce 11.0.0 delta, then restored the original Docker-absent fingerprint. Learned corrections were Alpine package inventory via `apk info`, redirect-aware WordPress probes, detached bounded handling for slow WooCommerce activation, consolidated WP-CLI reconciliation, phase-split Compose teardown, and stable container-state fingerprints that exclude elapsed-time text.

Windows validation result (2026-08-10): promoted the `woocommerce-windows` reviewed common task on the verified Windows Compose foundation. After firmware virtualization was enabled, live SSH and Stage 2 validation on `windows-11` passed with plugin v0.6.1 executing signed commands as LocalSystem. The route deploys isolated WordPress 7.0.2/PHP 8.3-FPM, nginx 1.30.4, MariaDB 11.8.8, and digest-pinned WooCommerce 11.0.0 on port 18102 with SID-protected host-generated credentials. Promotion task #38 passed two applies, stable second-apply state, restart recovery, external `WEBMINAI_WOOCOMMERCE_OK` HTTP verification, two idempotent reverts, and exact baseline restoration while the independent WordPress control site on port 18101 remained HTTP 200. Learned Windows corrections were explicit native Docker process capture, localized ACLs through stable SIDs, quoted Compose tmpfs options, separate WP-CLI secret paths, positive database/readiness output instead of unavailable native exit codes, and bounded non-job phases because the Windows plugin does not yet expose durable-job functions.

FreeBSD validation result (2026-08-11): promoted the `woocommerce-freebsd` reviewed common task on FreeBSD 15.1 with native Podman jail images, WordPress 7.0.2, PHP 8.4/nginx, MariaDB 11.8, and digest-pinned WooCommerce 11.0.0. The live route passed protected on-host credentials, bounded activation retry, marker-product HTTP verification, restart recovery, external access on port 18102, a clean revert, and a clean second apply. The runtime images are shared and retained across application rollback. Fleet learning replaced unsafe `sed` password interpolation with in-container credential-file reads and suppresses transient first-activation database diagnostics unless all bounded attempts fail.

## 3. Joomla

Candidate routes: Linux Compose/native; FreeBSD native/evaluate; Windows Linux-container Docker Compose; macOS evaluate supported PHP deployment.

```text
Install an isolated Joomla site with a supported PHP/database/web stack. Complete initialization without printing secrets, create a page containing WEBMINAI_JOOMLA_OK, and secure or remove installation artifacts as required. Verify frontend health, database access, writable/locked directory expectations, administrator initialization state, and restart persistence. Revert the complete task-owned deployment and confirm no pre-existing web stack was altered.
```

Learning focus: non-interactive initialization, PHP/database portability, and secure installer cleanup.

Linux validation result (2026-08-08): promoted to the verified `joomla-linux` common task with Joomla 5.4.7 after one uninterrupted staged run across all nine Linux lab hosts plus `ismet`. Every host passed two applies, external `WEBMINAI_JOOMLA_OK` verification, database/PHP/web restart recovery, two reverts, and exact baseline comparison. AlmaLinux, Oracle Linux, and Rocky Linux 9 required task-owned PHP 8.3 and nginx 1.26 module streams because their repository defaults (PHP 8.0/nginx 1.20) are below Joomla 5's supported minima; rollback resets only streams enabled by the task. The native installer uses a root-owned PHP bootstrap that resolves database and administrator password files inside PHP, keeping values out of process arguments and output. `ismet` uses the preferred Compose route with pinned official `joomla:5.4.7-php8.3-fpm`, `nginx:1.30.4-alpine`, and `mariadb:11.8.8` images; PHP-FPM communicates with nginx exclusively through the private `/run/php-fpm/webminai.sock` volume and is not published. Initialization deliberately bypasses the image's plaintext administrator-password argument and reuses the same mounted credential-file bootstrap. The nginx/PHP-FPM socket route was revalidated across all nine native distro hosts and `ismet`; Alpine additionally required a bounded OpenRC socket-readiness wait. Learned failure signatures were `ARTIFACT_DOWNLOAD_FAILED` for an incorrect upstream filename slug, a missing EL9 module-baseline hook, an Arch package-installed/module-not-yet-enabled ordering error, and `SERVICE_NOT_READY` when secrets were supplied after the official image entrypoint.

Windows validation result (2026-08-10): promoted the `joomla-windows` reviewed common task by adapting the verified `ismet` Compose matrix to the existing Windows Docker Desktop Linux engine. The route uses pinned `joomla:5.4.7-php8.3-fpm`, `nginx:1.30.4-alpine`, and `mariadb:11.8.8`, exposes only nginx on port 18103, and keeps PHP-FPM on `/run/php-fpm/webminai.sock`. Administrator and database credentials are generated by LocalSystem, protected with stable SID ACLs under `C:\ProgramData\WebminAI\credentials\joomla`, mounted as files, and resolved inside the Joomla PHP installer bootstrap without entering plans or output. Live Stage 2 promotion task #39 passed two applies, stable second-apply state, restart recovery, external `WEBMINAI_JOOMLA_OK` verification, two idempotent reverts, and exact baseline restoration. The independent WordPress control on port 18101 remained healthy throughout.

FreeBSD validation result (2026-08-11): promoted the `joomla-freebsd` reviewed common task with digest-verified Joomla 5.4.7 on FreeBSD 15.1. It introduced shared parameterized MariaDB 11.8 and PHP 8.4/nginx native jail images, protected credential-file argument injection, a per-service PHP configuration, and an isolated static Podman network on port 18103. The route passed database/user validation, external `WEBMINAI_JOOMLA_OK`, restart recovery, clean revert, and a complete second apply. Learned corrections added the split `php84-zlib` extension, enabled Joomla's required zlib output compression, reconciled database roles on every container start, avoided shell command substitution around SQL identifiers, and recreates the task stack after runtime image upgrades. Because FreeBSD Podman uses VFS storage, completed lab candidates are reverted before the next candidate rather than retained concurrently.

## 4. Drupal

Candidate routes: Linux Compose/native; FreeBSD native/evaluate; Windows and macOS evaluate supported PHP/Composer routes.

```text
Install a minimal Drupal site using a supported release, Composer or an official package route, a supported database, and an isolated web endpoint. Create content containing WEBMINAI_DRUPAL_OK and keep administrator/database secrets protected. Verify Drupal status, clean URLs, database connectivity, files-directory permissions, cron, and service restart persistence. Revert Composer artifacts, site data, database, proxy configuration, credentials, and only dependencies introduced by this task.
```

Learning focus: Composer differences, PHP extensions, clean URL configuration, and dependency ownership.

Linux validation result (2026-08-08): promoted to the verified `drupal-linux` common task with Drupal 11.4.4 after the staged ladder across all nine Linux lab distributions plus Docker-enabled `ismet`. Every route passed two applies, restart recovery, external `WEBMINAI_DRUPAL_OK` and clean-URL checks, protected settings and cron proof, administrator/database verification, two reverts, and exact baseline comparison. The native route installs the digest-verified official release and uses a root-owned PHP bootstrap that submits Drupal's official noninteractive installer forms from protected credential-file inputs. AlmaLinux, Oracle Linux, and Rocky Linux 9 use task-owned PHP 8.3, nginx 1.26, and MariaDB 10.11 module streams and reset only streams introduced by the task. Alpine required its split `php83-pdo` and `php83-pdo_mysql` packages; Arch required extension validation after its configuration phase; openSUSE Leap 16 required the reusable PHP profile to include split `php8-openssl` and `php8-tokenizer` packages. A task-owned completion marker distinguishes a finished installation from a partial default `settings.php`, improving safe retries. `ismet` uses pinned `drupal:11.4.4-php8.4-fpm`, `nginx:1.30.4-alpine`, and `mariadb:11.8.8` images, a private PHP-FPM Unix socket, directory-mounted reviewed bootstrap scripts, Compose secrets, and exact baseline restoration. The former Apache image route was removed and the nginx/PHP-FPM socket lifecycle was revalidated on `ismet`.

FreeBSD validation result (2026-08-11): promoted the `drupal-freebsd` reviewed common task with digest-verified Drupal 11.4.4 on FreeBSD 15.1. The task reuses the reviewed Drupal installer and cron reconciler with shared native PHP 8.4/nginx and parameterized MariaDB 11.8 jail images. It passed two clean applies, database and administrator verification, protected settings permissions, cron proof, clean login routing, restart recovery, external `WEBMINAI_DRUPAL_OK` on port 18104, and a task-owned revert. Credentials remain under `/root/drupal_credentials` and values do not enter plans or output.

## 5. PrestaShop

Candidate routes: Linux Compose/native; FreeBSD evaluate native PHP stack; Windows/macOS evaluate supported PHP deployment.

```text
Install an isolated PrestaShop test store with a supported PHP/database/web stack and protected administrator/database credentials. Complete setup non-interactively where supported, remove or lock the installer as required, and expose a test page containing WEBMINAI_PRESTASHOP_OK. Verify HTTP health, database access, writable cache/upload directories, administrative installation state, and restart persistence. Revert only task-created state and confirm the test endpoint closes.
```

Learning focus: installer automation, PHP version selection, filesystem permissions, and post-install hardening.

Linux validation result (2026-08-08): promoted to the verified `prestashop-linux` common task with PrestaShop 9.1.4 after the staged ladder across all nine Linux lab distributions and Docker-enabled `ismet`. Every promoted route used nginx and PHP-FPM over a private Unix socket; no Apache route remains. Native hosts passed two applies, external `WEBMINAI_PRESTASHOP_OK`, database and administrator checks, restart recovery, two reverts, and exact baseline comparison. The `ismet` Compose route used pinned PrestaShop FPM, nginx, and MariaDB images with a shared `/run/php-fpm/webminai.sock` volume and protected credential files. Learned corrections included splitting the long installer into independently retryable phases, checking installed modules and administrative bundles, removing the installer directory, and preserving package/module baselines on each distribution.

FreeBSD validation result (2026-08-11): promoted the `prestashop-freebsd` reviewed common task with digest-verified PrestaShop 9.1.4 on FreeBSD 15.1. It reuses the shared PHP 8.4/nginx and MariaDB 11.8 jail images and the reviewed protected credential bootstrap. Two complete applies passed the split database, module, theme/post-install, and finalize phases, administrator/database verification, protected configuration, installer removal, restart recovery, external `WEBMINAI_PRESTASHOP_OK` on port 18105, and a clean revert.

## 6. Moodle

Candidate routes: Linux Compose/native; FreeBSD native/evaluate; Windows/macOS evaluate supported PHP stack.

```text
Install a minimal Moodle test site with a supported PHP/database/web stack, a data directory outside the web root, cron, and protected administrator/database credentials. Complete initialization and create a page or site name containing WEBMINAI_MOODLE_OK. Verify health, database access, moodledata permissions, cron execution, restart persistence, and external access. Revert all task-created state without disturbing pre-existing PHP or database services.
```

Learning focus: PHP limits/extensions, off-web-root storage, CLI installer behavior, and cron portability.

Linux native validation result (2026-08-09): promoted to the verified `moodle-linux` common task with Moodle 5.2.1 on all nine Linux lab distributions. Every host passed two applies, external `WEBMINAI_MOODLE_OK`, database/data/cron/socket checks, MariaDB/PHP-FPM/nginx restart recovery, two reverts, and exact baseline comparison. All native routes use nginx with a dedicated `/run/webminai-moodle-18106/php-fpm.sock`; no Apache route is generated. Moodle code is digest-pinned, only `public/` is served, `moodledata` stays outside the web root, cron is task-owned, and administrator/database secrets remain in protected files. Alpine and openSUSE required split `ctype`, `soap`, and sodium packages; Arch uses its parallel official PHP 8.3 legacy branch. Fedora 44 and EL9 use a parallel Remi PHP 8.4 SCL because Fedora's PHP 8.5 is unsupported by Moodle 5.2 and EL9's PHP 8.3 stream lacks sodium; the distribution PHP is not replaced. RPM cleanup now owns imported signing keys, supports DNF5 syntax, and preserves an existing EPEL release version exactly. The `ismet` Compose lifecycle remains pending: its intermittent SSH connection dropped while replacing the old Stage 2 plugin, so Netdata was intended to remain installed but the plugin state must be refreshed and reactivated before validation resumes.

FreeBSD validation result (2026-08-11): promoted the `moodle-freebsd` reviewed common task with digest-pinned Moodle 5.2.1 on FreeBSD 15.1. Two clean applies passed the protected CLI installer, MariaDB administrator record, public-only nginx root, off-web `moodledata`, a real initial cron execution, recurring isolated cron service, restart recovery, external `WEBMINAI_MOODLE_OK` on port 18106, and task-owned rollback. The real first cron run takes several minutes and is intentionally handled by the durable Stage 2 job API instead of extending a synchronous Netdata request. Verification now downloads HTTP responses to a temporary file before matching, avoiding benign curl write errors caused by early-closing pipelines.

## 7. Nextcloud

Candidate routes: Linux Compose/native; FreeBSD native/evaluate; Windows and macOS evaluate supported web/PHP deployment.

```text
Install a minimal Nextcloud test instance with a supported database, persistent data directory, background-job configuration, and a page or status response proving WEBMINAI_NEXTCLOUD_OK ownership. Configure trusted domains for only the test endpoint. Keep the admin and database secrets in the protected credentials file. Verify status.php, database connectivity, writable storage, scheduled background work, and restart persistence. Revert without deleting any pre-existing PHP, database, cache, or web-server installation.
```

Learning focus: PHP extensions across distributions, trusted-domain configuration, cron ownership, storage permissions, and large dependency graphs.

FreeBSD validation result (2026-08-11): promoted the `nextcloud-freebsd` reviewed common task with checksum-pinned Nextcloud 33.0.7 on FreeBSD 15.1. Two apply cycles passed the protected CLI installer, MariaDB administrator record, explicit trusted-domain configuration, external `status.php`, `WEBMINAI_NEXTCLOUD_OK` on port 18107, recurring background cron, restart recovery, and two clean reverts. The shared PHP 8.4 image gained the reviewed bcmath, GMP, pcntl, and POSIX extensions. Live data is configured at `/var/nextcloud-data`; the installer-created unused web-root placeholder is removed only after confirming that configured path, and verification checks both the configuration and absence of web-root data.

Scope note: Nextcloud is an additional verified FreeBSD candidate. It is not currently a promoted Docker task on `ismet` and therefore is not counted toward FreeBSD-to-ismet parity.

## 8. Magento Open Source

Candidate routes: Linux Compose/native on sufficiently resourced hosts; other platforms evaluate and commonly reach a safe compatibility/resource block.

```text
Assess resources before installing Magento Open Source. Continue only when CPU, RAM, disk, PHP, database, search service, and supported runtime requirements can be met safely. If viable, deploy an isolated store with cron, cache/search integration, persistent data, protected administrator credentials, and a page containing WEBMINAI_MAGENTO_OK. Verify the application CLI, indexers, cron, search/database connectivity, HTTP response, and restart persistence. Otherwise return a no-change resource or compatibility report. Revert every task-owned dependency.
```

Learning focus: resource gates, OpenSearch compatibility, long timeouts, PHP extension variance, and multi-service rollback.

FreeBSD validation result (2026-08-11): promoted the `magento-freebsd` reviewed native adaptation with checksum-pinned Magento Open Source 2.4.8-p5, PHP 8.4.24-FPM over a Unix socket, MariaDB 11.4.12, OpenSearch 2.19.5, Valkey 8.1.8, cron, and nginx. FreeBSD 15.1 passed two independent source/lockfile installs, 146 production Composer packages, protected administrator and database inputs, 360-table database validation, administrator and CMS marker records, all indexers ready, cache/search health, external `WEBMINAI_MAGENTO_OK` on port 18108, real restart recovery of every service, and two exact reverts. Learned corrections use FreeBSD's `/usr/local/libexec/mariadbd`, supervise MariaDB because its daemon lacks MySQL's `--daemonize`, perform pre-bootstrap readiness over the protected Unix socket, make the PHP-FPM socket directory traversable only by its application owner and nginx group, use `onerestart` for rc services that are intentionally not enabled globally, and validate Magento's populated tables rather than assuming `setup_module` contains rows. Adobe supports Linux rather than FreeBSD, so this route is explicitly a controlled Intent AI Ops source adaptation, not a production support claim.

## 9. n8n

Candidate routes: Linux Compose/native; FreeBSD/macOS/Windows evaluate supported Node.js or container route based on host policy.

```text
Install an isolated production-mode n8n instance with persistent state, a supported database when appropriate, protected encryption/authentication secrets, and an isolated webhook/base URL. Create a harmless workflow or response proving WEBMINAI_N8N_OK without exposing its credentials. Verify health, database/storage persistence, webhook reachability, service restart, and external HTTP access. Revert application, database, proxy, credentials, and task-created persistent storage.
```

Learning focus: runtime version selection, encryption-key secrecy, webhook URL configuration, and cross-platform process supervision.

Linux promotion result (2026-08-10): the verified `n8n-linux` task passed the full promotion gate on `ismet` with the preferred Compose route and on all nine disposable Linux distributions with native routes. Every host passed two applies, n8n health and SQLite persistence, service restart recovery, external `WEBMINAI_N8N_OK` access, two reverts, and a final task-owned-state absence check. The promoted matrix uses NodeSource Node.js 24 where the distribution is supported, Alpine Node.js 24, Arch Node.js 22 LTS, and openSUSE Node.js 24. Fleet learning added npm 12's explicit `sqlite3` install-script approval, post-install native-module readability normalization, Arch nginx `conf.d` inclusion with exact configuration restoration, and durable polling for the large npm acquisition phase. The Compose route uses the pinned official n8n image, an nginx marker container, persistent SQLite storage, and a host-generated root-only encryption key whose value never enters plans or logs.

FreeBSD validation result (2026-08-11): added the `n8n-freebsd` reviewed native route with exact n8n 2.33.7, FreeBSD Node.js 24.18, SQLite persistence, rc.d, nginx, and an on-host encryption key under `/root/n8n_credentials`. FreeBSD 15.1 passed full migration, health, external `WEBMINAI_N8N_OK`, restart recovery, revert, and exact package/identity/path/listener baseline comparison. Native acquisition is intentionally a durable job because n8n resolves more than 2,000 packages and FreeBSD must compile `isolated-vm` and sqlite3 locally. Node.js 24 exports its own hardened SQLite symbols, while historical n8n migrations require legacy double-quoted-string compatibility; the reviewed route checksum-gates sqlite3's source, rebuilds it with `SQLITE_DQS=3`, links the addon with `-Bsymbolic` to prevent Node symbol preemption, and asserts the effective behavior before creating persistent state. npm and node-gyp caches remain inside task state and are removed on revert.

## 10. Ghost

Candidate routes: Linux Compose/native; FreeBSD and macOS evaluate Node.js plus supported database; Windows evaluate supported Node.js service route.

```text
Install a production-mode Ghost test blog with persistent content, a supported database, a process supervisor or service, and a reverse-proxy or isolated direct port. Publish a page containing WEBMINAI_GHOST_OK without exposing administrator or database credentials. Verify application health, database access, restart persistence, and the externally reachable page. Revert all task-created application, proxy, database, service, and credential state.
```

Learning focus: Node.js version compatibility, service identity, MySQL requirements, reverse proxy generation, and clean database rollback.

Linux promotion result (2026-08-10): the verified `ghost-linux` task passed the full promotion gate on Docker-preferred `ismet` and the native Ubuntu 24.04 canary. Both production routes passed two applies, MySQL persistence, real Ghost `/blog/` HTTP readiness, nginx `WEBMINAI_GHOST_OK` access, restart recovery, two reverts, and task-owned-state cleanup. The Compose route uses digest-pinned official Ghost 6.56.0, MySQL 8, and nginx images. The native route uses NodeSource Node.js 22.23+, pinned Ghost-CLI 1.29.1, pinned pnpm 11.15.1, Ghost 6.57.0, Ubuntu MySQL 8, systemd, and nginx. Credentials are generated only on-host under `/root/ghost_credentials`; values do not enter plans or logs. The other eight LXD distributions passed reversible no-change compatibility reporting because automatic Docker is disabled for container hosts and Ghost 6 production requires Oracle MySQL 8 rather than MariaDB or SQLite. Fleet learning corrected a broken containerd ingest directory through service restart, made repeated reverts baseline-aware, replaced redirect-prone container health with the canonical `/blog/` route, preserved the Ghost subpath in nginx, avoided the awk `index` built-in, adopted the official Ghost-CLI acquisition flow, supplied Ghost's pinned pnpm version, used the runtime `config.production.json`, and seeded the external persistent content directory with the official default theme.

FreeBSD validation result (2026-08-11): promoted the `ghost-freebsd` reviewed native route with Ghost 6.57.0, FreeBSD Node.js 22.23.1, Oracle MySQL 8.0.46, rc.d, and nginx. The FreeBSD 15.1 live run passed checksum-gated source acquisition, the archive-locked pnpm dependency graph, migrations, database isolation, seeded default theme, external `WEBMINAI_GHOST_OK` and `/blog/` HTTP checks, restart recovery, and task-owned rollback. Ghost does not officially support FreeBSD, so the catalog labels this as a Intent AI Ops-tested native adaptation. Learned corrections extract the official npm archive before dependency resolution so bundled `file:` packages exist, preserve the archive's pnpm lock instead of re-resolving with npm, add the exact FreeBSD WASM Sharp package, isolate MySQL and Ghost run directories, and remove packages individually with `pkg delete -f` so rollback cannot cascade through baseline-owned Netdata dependencies.

## 11. Mattermost

Candidate routes: Linux Compose/native; FreeBSD, Windows, and macOS evaluate availability of a supported server binary and database.

```text
Install an isolated Mattermost team server with a supported database, persistent file storage, protected administrator/database credentials, and an endpoint containing WEBMINAI_MATTERMOST_OK. Prefer a supported non-interactive bootstrap method. Verify server health API, database connectivity, file storage, service identity, restart persistence, and external HTTP reachability. Revert all task-created application, database, proxy, credential, and service state.
```

Learning focus: platform binary availability, bootstrap automation, service user permissions, and database isolation.

Linux promotion result (2026-08-10): the verified `mattermost-linux` task passed on Docker-preferred `ismet` and all nine disposable Linux distributions. The Compose route completed two independent apply, PostgreSQL migration, API health, external `WEBMINAI_MATTERMOST_OK`, restart-recovery, and exact revert cycles using digest-pinned official Mattermost Team Edition 11.7.8, PostgreSQL 17.6, and nginx images. Native Ubuntu/Debian and AlmaLinux/Rocky/Oracle Linux routes use the checksum-pinned official 11.7.8 archive, PostgreSQL 14+, a dedicated service identity, systemd, and nginx; Debian-family and EL9 canaries each passed two clean apply/revert cycles, and the remaining supported hosts passed the fleet lifecycle. Alpine, Arch, Fedora, and openSUSE passed reversible no-change compatibility reporting because they are outside Mattermost's upstream production OS matrix and automatic Docker is disabled inside the LXD lab. Fleet learning added Debian cluster ownership tracking (including clusters auto-created by package installation), exact package rollback without broad `apt autoremove`, a narrowly scoped EL9 SCRAM HBA rule with exact restoration, literal heredoc terminator preservation, and host-side API readiness for the distroless Mattermost image. Credentials are generated only on-host under `/root/mattermost_credentials`; values never enter plans or logs.

FreeBSD validation result (2026-08-11): promoted the `mattermost-freebsd` reviewed common task with the current FreeBSD-port Mattermost 11.7.3, PostgreSQL 17, and nginx. FreeBSD 15.1 passed two independent applies, API/database/administrator verification, external `WEBMINAI_MATTERMOST_OK`, restart recovery, two reverts, and exact package, identity, credential, path, and listener baseline comparison. The native port trails the ismet container release 11.7.8 and is versioned independently. Learned corrections include explicit PostgreSQL socket/port selection, a writable task-owned Mattermost config, correct rc.d `procname` tracking, bounded stop/start recovery, and removal of package-created service identities only when they did not predate the task.

## 12. Odoo Community

Candidate routes: Linux Compose/native; FreeBSD/macOS evaluate Python/PostgreSQL compatibility; Windows evaluate official server support.

```text
Install an isolated Odoo Community test instance with PostgreSQL, persistent addons/data, a service or supervised process, and protected master/database credentials. Create or expose a harmless page/database marker containing WEBMINAI_ODOO_OK without logging secrets. Verify application health, PostgreSQL connectivity, worker/cron behavior appropriate to the chosen mode, restart persistence, and external reachability. Revert the task-owned database role/database, service, files, credentials, and proxy.
```

Learning focus: Python dependency builds, PostgreSQL role ownership, Windows service differences, and version-aware package selection.

Linux validation result (2026-08-10): the verified `odoo-linux` task completed two clean fleet passes across all nine disposable Linux distributions and two independent Compose lifecycles on Docker-preferred `ismet`. `ismet` uses digest-pinned official Odoo Community 19, PostgreSQL 17, and nginx images; host-generated database and master passwords stay under `/root/odoo_credentials`, PostgreSQL consumes its Compose secret directly, and a root-only one-shot container materializes Odoo's `0600` configuration into a private named volume. Ubuntu 24.04 uses the checksum-pinned official `19.0.20260810` DEB, PostgreSQL 13+, systemd, and nginx. Native Odoo consumes its protected configuration through systemd `LoadCredential=` without weakening `/root` permissions. Both changing routes passed database initialization, Odoo login and marker HTTP checks, PostgreSQL schema validation, restart recovery, repeated apply/revert, and cleanup. Debian 13 records a reversible no-change result because the current official DEB depends on removed `python3-pypdf2`; Fedora 44 does likewise because the current official RPM requires unavailable Python 3.13 distribution dependencies. AlmaLinux, Alpine, Arch, openSUSE, Oracle Linux, and Rocky Linux record reversible no-change results because no satisfiable upstream-packaged Odoo 19 native route exists and Docker is auto-disabled for LXD containers. Fleet learning corrected local-Compose secret-file permissions by using the protected config volume and corrected native `/root` traversal by using systemd credentials; it deliberately did not fabricate dependency packages or improvise a distro-wide Python source stack.

FreeBSD validation result (2026-08-11): promoted the `odoo-freebsd` reviewed native adaptation from a pinned Odoo Community 19 source commit with Python 3.12, PostgreSQL 17.10, rc.d, and nginx. FreeBSD 15.1 passed source checksum verification, the upstream Python dependency matrix, database and least-privilege role initialization, protected master/database/administrator credentials, real Odoo login HTTP readiness, schema validation, external `WEBMINAI_ODOO_OK` on port 18112, Odoo and PostgreSQL restart recovery, and complete rollback while keeping Stage 2 healthy. Odoo does not list FreeBSD as an upstream deployment platform and PDF header/footer support remains outside this route. Learned corrections pin the FreeBSD-available Python branch, prebuild Odoo's pinned gevent with its compatible Cython/greenlet versions, use the system `libev` because bundled libev assumes Linux `sys/statfs.h`, bound caches to task state, and delete task-added packages individually so rollback cannot cascade into baseline-owned packages.

## 13. Jellyfin

Candidate routes: Linux Compose/native; FreeBSD native/evaluate; Windows and macOS Compose/native/evaluate according to Docker availability.

```text
Install an isolated Jellyfin server using a supported native package or container. Use task-owned empty media/config/cache directories, protected initialization data, and a non-conflicting port. Do not alter hardware acceleration, GPU drivers, or real media libraries. Verify the system/info or health API, web UI response containing or paired with WEBMINAI_JELLYFIN_OK, storage permissions, service identity, and restart persistence. Revert the service/application and only task-owned media/config/cache state.
```

Learning focus: one of the strongest native cross-platform cases, service accounts, package repositories, and safe media-directory boundaries.

Linux validation result (2026-08-10): the verified `jellyfin-linux` task completed two clean coordinated fleet passes across all nine disposable Linux distributions, plus two independent Compose lifecycles on Docker-preferred `ismet`. `ismet` uses digest-pinned official Jellyfin 10.11.11 and nginx images. Debian 13 and Ubuntu 24.04 use Jellyfin's signed official repositories and pinned packages. Fedora, AlmaLinux, Rocky Linux, Oracle Linux, Arch, and openSUSE use the checksum-pinned official 10.11.11 x86-64 portable server together with the checksum-pinned official Jellyfin FFmpeg 7.1.4-3 archive; Alpine 3.23 records a reversible no-change result because its musl community packages lag the current security release. Every changing route passed on-host credential generation under `/root/jellyfin_credentials`, startup-wizard completion, health and system-info APIs, web UI, external `WEBMINAI_JELLYFIN_OK`, SQLite persistence, service identity, restart recovery, and exact revert. Fleet learning added the portable FFmpeg runtime, the EL9 `xz` and `icu` prerequisites, reversible Arch nginx `conf.d` inclusion, and bounded systemd journal diagnostics. The final audit found no Jellyfin paths, users, services, ports, or Compose containers on any of the ten hosts.

FreeBSD validation result (2026-08-11): promoted the `jellyfin-freebsd` reviewed common task with the FreeBSD-port Jellyfin 10.11.11 package and nginx on FreeBSD 15.1. Two clean applies passed protected startup-wizard credentials, exact version and server-name identity, web UI, SQLite persistence, restart recovery, external `WEBMINAI_JELLYFIN_OK` on port 18113, and two package-aware reverts. The first container-image experiment was safely abandoned when Podman's VFS layer commit exhausted temporary space; the promoted route installs the native package directly and records the exact package delta for rollback. Non-secret runtime state lives at `/var/db/webminai-jellyfin-18113` so the unprivileged `jellyfin` user does not require traversal through Intent AI Ops's protected `/var/db/webminai` directory.

## 14. Vaultwarden

Candidate routes: Linux Compose/native binary where supported; FreeBSD/macOS/Windows evaluate supported binaries or containers.

```text
Install an isolated Vaultwarden test server with persistent data, WebSocket support where required, protected admin/database secrets, secure file permissions, and a non-conflicting endpoint. Never print the admin token or create real user vault data. Verify the alive/health endpoint, database persistence, restart behavior, WebSocket/proxy configuration when used, and external reachability associated with WEBMINAI_VAULTWARDEN_OK. Revert every task-owned secret, database, container/service, proxy, and data directory.
```

Learning focus: high-sensitivity credential redaction, Rust binary/container availability, proxy correctness, and zero-secret output checks.

## 15. Home Assistant

Candidate routes: Linux Home Assistant Container/Compose on a capable Docker host; otherwise return a safe no-change compatibility result. FreeBSD has a controlled, explicitly unsupported Intent AI Ops source-adaptation route for the disposable lab only. macOS/Windows evaluate supported container or Home Assistant OS routes without host integrations; do not present Core or Supervised adaptations as upstream-supported production installations.

```text
Install an isolated Home Assistant test instance using a supported method that does not require privileged host networking or hardware integrations. Use a task-owned configuration directory and non-conflicting port, and avoid discovering or controlling real devices. Establish a health or HTTP marker associated with WEBMINAI_HOME_ASSISTANT_OK. Verify startup completion, configuration persistence, restart behavior, and external reachability. Revert the task-owned service/container, configuration, credentials, network changes, and storage.
```

Learning focus: container privilege minimization, Python environment compatibility, device-discovery isolation, and lengthy first-start readiness.

Linux validation result (2026-08-10): the verified `home-assistant-linux` task completed two independent clean Compose lifecycles on Docker-preferred `ismet`. It uses the digest-pinned official Home Assistant 2026.8.1 and nginx images on a private bridge network, with no privileged mode, host networking, device mounts, or D-Bus access. Administrator credentials are generated only on-host under `/root/home_assistant_credentials`; the task completes the documented onboarding API without exposing credential values, verifies the exact Home Assistant version, completed onboarding, SQLite persistence, external `WEBMINAI_HOME_ASSISTANT_OK`, UI/API proxying, restart recovery, and exact revert. All nine LXD distributions completed the reversible no-change compatibility route twice because Docker is auto-disabled for container hosts and current upstream-supported Linux installation types do not provide a native Core/Supervised fallback. Fleet learning added a generic API/auth proxy alongside the prefixed UI route and kept the multi-gigabyte image pull in a durable Stage 2 job. The final audit found no Home Assistant data, credentials, Compose files, listeners, or containers on any of the ten Linux hosts.

FreeBSD validation result (2026-08-11): added the `home-assistant-freebsd` controlled native adaptation with checksum-pinned Home Assistant Core 2026.8.1, FreeBSD Python 3.14.7, SQLite, rc.d, nginx, protected onboarding credentials, and no privileged mode, host networking, hardware, D-Bus, Bluetooth, or discovery access. The FreeBSD 15.1 run passed source and exact-version validation, protected onboarding, real frontend and SQLite persistence, external `WEBMINAI_HOME_ASSISTANT_OK` on port 18115, restart recovery, task-owned rollback, and Stage 2 survival. Learned corrections use the durable job API for native Python/Rust builds, disable the unused Nabu Casa grpc transport after its FreeBSD C++ link exhausted the 2 GB lab host, retain only the Nabu Casa URL-helper compatibility subset imported by Core, add FreeBSD's split `py314-sqlite3` package, generate the source archive's onboarding translation artifact, bypass the upstream OS guard through a task-owned wrapper without modifying Home Assistant source, separate daemon output from Home Assistant's writable log, and treat the post-onboarding 404 as completed state rather than a readiness failure. This route is for Intent AI Ops portability testing and is not an upstream-supported production installation.

## 16. Immich

Candidate routes: Linux Compose on a capable Docker host; other platforms normally evaluate only supported Docker environments or return a safe block.

```text
Assess architecture, Docker policy, memory, disk, and the currently supported Immich Compose topology before mutation. If viable, deploy an isolated Immich stack with database, cache, machine-learning service, persistent upload storage, protected credentials, and an API/server response associated with WEBMINAI_IMMICH_OK. Verify every container, application health, storage writes, restart persistence, and external reachability. Otherwise return a no-change report. Revert all task-owned containers, images where safe, networks, volumes, credentials, and files.
```

Learning focus: upstream Compose drift, multi-container readiness, architecture support, and volume cleanup.

## 17. Discourse

Candidate routes: Linux Compose/official container route on a capable non-container host; FreeBSD, Windows, and macOS expected to evaluate or block unless a supported test route exists.

```text
Assess whether this host safely meets Discourse's supported container, memory, disk, hostname, and mail prerequisites. Do not fake mail or public DNS readiness. If a supported isolated test route exists, deploy it with persistent PostgreSQL/Redis state, protected bootstrap credentials, and a page or API response containing WEBMINAI_DISCOURSE_OK. Verify container health, database/cache access, restart persistence, and HTTP response. Otherwise make no changes and report the exact blockers. Revert all task-owned containers and data.
```

Learning focus: strict upstream topology, resource checks, email/DNS blockers, and refusal quality.

## 18. GitLab Community Edition

Candidate routes: Linux Compose/native where supported and sufficiently resourced; other platforms generally evaluate client-only or unsupported server routes.

```text
Assess resources and official platform support before installing GitLab Community Edition. If viable, deploy an isolated instance with protected initial credentials, persistent repositories/configuration, a non-conflicting external URL, and a project or page containing WEBMINAI_GITLAB_OK. Verify all required GitLab services, HTTP readiness, repository creation/access, restart persistence, and background jobs. Otherwise produce a no-change compatibility/resource report. Revert only the task-owned omnibus or container deployment and its data.
```

Learning focus: long-running install readiness, memory gates, generated secrets, omnibus service inspection, and large rollback scope.

## 19. Coolify

Candidate routes: supported Linux Docker hosts only; FreeBSD, Windows, macOS, and containerized Linux are expected to block unless upstream support explicitly provides a safe route.

```text
Determine whether the host meets Coolify's supported Linux, Docker, architecture, networking, resource, and non-container-host requirements. Do not weaken Intent AI Ops's Docker policy or run a remote installer merely to bypass a failed prerequisite. If fully supported, deploy an isolated instance with protected credentials, task-owned persistent data, and an endpoint associated with WEBMINAI_COOLIFY_OK; verify all components and restart persistence. Otherwise make no changes and provide a precise compatibility report. Revert every task-owned component.
```

Learning focus: host-vs-container safeguards, remote installer review, Docker socket privilege, and high-impact refusal behavior.

## 20. Plesk

Candidate routes: only officially supported Linux or Windows editions; FreeBSD and macOS expected to block. Licensing and destructive host-wide integration make a dedicated disposable VM mandatory.

```text
Perform a read-only Plesk support, licensing, resource, hostname, network, and existing-service assessment first. Continue only on a dedicated disposable VM with an officially supported OS and an explicitly available evaluation/license path. Never replace an existing hosting stack. If all gates pass, show the complete official installer plan and its host-wide effects before requesting approval, then verify panel health and an isolated test subscription/page containing WEBMINAI_PLESK_OK. If any gate fails, make no changes. Provide rollback only when the official installation method makes reliable rollback possible; otherwise require VM snapshot restoration and say so before installation.
```

Learning focus: licensing gates, destructive-scope escalation, Windows/Linux divergence, installer trust, and recognizing when snapshot restoration is the only honest rollback.

## Results to record for every child task

Use task history and the multi-host group record to collect:

| Field | Expected evidence |
|---|---|
| Platform detection | OS, version, architecture, package manager, service manager |
| Selected route | Compose, native, or no-change unsupported result |
| Docker decision | detected capability, saved preference, host-container safeguard, and proof that manual `disabled` overrides capability |
| Planning attempts | initial plan, deterministic rejection, corrected plan, user correction |
| Secret generation | generated on the target host by an approved command; no Codex-generated or fixed values |
| Secret storage | service-specific root/LocalSystem directory; Compose secrets or separate `env_file`; paths only in history |
| Secret non-disclosure | no value in prompt, plan, compose file, arguments, progress, output, Netdata, SQLite, debug logs, or reports |
| Apply result | per-command status and duration |
| Service verification | health API, process/service identity, restart persistence |
| External verification | controller URL/protocol probe and unique marker |
| Modified state | files, packages, services, containers, volumes, users, firewall rules |
| Revert result | every revert command plus endpoint closure |
| Baseline restoration | before/after fingerprint or an explained non-reversible exception |

## Process improvements to derive from failures

After each application completes across the fleet, group failures by cause rather than by host:

1. missing distribution/package-manager knowledge;
2. stale upstream version or download selection;
3. unsupported platform detected too late;
4. Docker preference or nested-container misclassification;
5. service-manager mismatch;
6. readiness timeout or weak health probe;
7. credential leakage risk;
8. non-idempotent retry behavior;
9. incomplete ownership tracking;
10. incomplete revert or baseline drift.

Convert recurring deterministic findings into planner policy, inventory fields, validation rules, or regression tests. Keep application deployment itself AI-assisted: the fixed common-task catalog is an internal integration-test fixture and is intentionally not exposed in the interactive task menus.

## Intent AI Ops improvements before scaling the remaining candidates

Implement these in priority order to reduce retries rather than merely making retries easier:

1. **Stack capability registry.** Extend the saved Linux context with typed, versioned profiles for `nginx`, `php-fpm`, PHP extensions, MariaDB, PostgreSQL, Node.js, Python, Composer and Docker Compose. Record package names, binary paths, service units, configuration include paths, runtime identities, sockets/listeners and security-framework state per distro family.
2. **Compatibility resolver and execution manifest.** Before Codex plans commands, resolve one supported application version and its runtime/database/image matrix from official sources. Save a sanitized manifest containing exact versions, architectures, artifact URLs/digests, image digests and selected route. Codex should explain or fill gaps in the manifest, not guess the matrix from scratch.
3. **Reusable phase builders.** Generate reviewed primitives for baseline capture, package diffing, artifact verification, credential generation, database ownership, service readiness, nginx/PHP-FPM configuration, Compose lifecycle, external verification and rollback. Keep application-specific installation/bootstrap as a smaller phase layered on those primitives.
4. **Read-only preflight gate.** Run compatibility, repository/package availability, port, disk, memory, cgroup/container, filesystem mount, SELinux/AppArmor and upstream-network checks before approval. A preflight failure creates a compatibility report and executes no changing command.
5. **Structured failure signatures.** Every phase should return a stable code such as `PACKAGE_NOT_FOUND`, `SERVICE_NOT_READY`, `APP_HTTP_500`, or `BASELINE_DRIFT`, plus bounded non-secret evidence. Automatically collect the phase-specific safe diagnostics before rollback. Match known signatures to learned corrections without another unrestricted planning pass.
6. **Canary scheduler by information value.** For PHP, start with one host whose exact profile is already proven, then one host from each package family. Prefer a host that exercises the newest unresolved branch. Stop the wave at the first new deterministic signature, learn once, reset, and resume only affected families.
7. **Convergence and rollback invariants.** Promote a learned task only after two applies, restart/side-effect recovery, two reverts and exact baseline comparison. Package, service, database, file, port and container fingerprints should be machine-compared rather than summarized by the model.
8. **Evidence promotion with scope.** Store learned facts as structured rules keyed by application major version, distro ID/version, architecture and route. Require evidence from the relevant family before generalizing; expire rules when official compatibility metadata or selected artifacts change.
9. **Failure and latency scorecard.** Track first-pass success, deterministic-plan rejection count, apply failures by phase/signature, median phase duration, rollback success and baseline drift per stack/distro. Use that data to choose the next canary and to decide which phase builder needs work.
10. **Secret-taint tests at every boundary.** Continue generating secrets only on-host, but add automated taint markers in lab runs and assert that values never enter plan JSON, process arguments, stdout/stderr, Netdata results, SQLite history or reports.
