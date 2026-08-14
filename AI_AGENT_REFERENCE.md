# Intent AI Ops AI Agent Reference

This is the detailed operational and development reference for AI coding agents working on Intent AI Ops. Human users should start with [README.md](README.md).

Agents should treat the implementation, schemas, and tests as authoritative when this document and the code differ. Before changing behavior, trace the relevant service and preserve the project boundaries: system OpenSSH owns transport, secrets stay outside Codex context and task history, commands remain approval-gated, and remote administration runs through the signed Stage 2 plugin. Prefer focused changes backed by the existing cross-platform tests and live validation scripts.

Use this document to locate setup examples, security invariants, platform notes, lab scripts, common-task validation, and release checks. Do not copy test credentials, connection strings, claim tokens, generated service credentials, or vault material into prompts, logs, fixtures, or documentation.

Intent AI Ops is an early application core for AI-assisted administration over system SSH. It does not install an AI agent on controlled hosts. The local application asks Codex to prepare a structured command plan, validates that plan, requests approval, then sends approved commands through a signed native Netdata function.

## Interactive CLI

Start the terminal interface with either command:

```sh
npm run cli
# or, after linking/installing the package
intentaiops
```

Traditional checkout installation remains `git clone https://github.com/cryptofuture/intentaiops.git`, followed by `cd intentaiops`, `npm i`, and `npm link`.

`intentops`, `webminai`, and `weminai` remain compatibility aliases. Use a different settings directory with `intentaiops --data-root /absolute/path`.

The guided flow is:

1. Create or unlock the encrypted local vault.
2. Add a saved or temporary host by pasting a familiar command such as `ssh -p 2222 -i /keys/edge admin@edge.example`.
3. Choose key/agent, password, or automatic OpenSSH authentication.
4. Let OpenSSH verify the host key, authenticate once, and derive a hashed stable machine fingerprint for history association.
5. Choose whether the connection is saved or temporary and whether an SSH password/private-key passphrase is stored vault-encrypted.
6. Select the host to see SSH, sudo, curl, Netdata, plugin, ownership, and Stage 2 health status.
7. Install Netdata plus the plugin, or install/update only the plugin on an existing Netdata host.
8. Run AI-planned or built-in reversible tasks on one host or a selected group, inspect SQLite history, retry only failed hosts, execute saved revert plans, or open a real SSH shell.
9. Change the passphrase of an unlocked vault and atomically re-encrypt every host secret with a fresh vault salt.

By default, password and private-key passphrase prompts belong to the system `ssh` binary and Intent AI Ops does not retain their answers. A per-host opt-in can instead save one SSH credential inside the encrypted vault. Intent AI Ops supplies that value to system OpenSSH through a short-lived mode-`0600` askpass file, never through the command line; the file is removed immediately after the ControlMaster authenticates. This works for password authentication and passphrase-protected private keys. If sudo needs a separate password, the CLI reads it with hidden input for that one action and does not persist it.

## Full usage example

This walkthrough starts with a new local installation and finishes with activation, an AI-assisted diagnostic task, an SSH shell, and optional removal.

### 1. Check local requirements

Intent AI Ops runs on the administration computer, not on the controlled server. The local computer needs:

- Node.js 24.7 or newer;
- the `ssh` and `scp` OpenSSH binaries;
- an installed and authenticated Codex CLI;
- npm and working access to the GitHub repository.

The installable package contains every reviewed Stage 2 artifact and uses `better-sqlite3` for task, run, and deployment-scorecard persistence. npm normally installs its platform binary automatically; platforms without a matching prebuild also need the native compiler toolchain. Rebuilding Stage 2 plugin artifacts always requires the documented platform toolchain.

Check the important commands:

```sh
node --version
ssh -V
codex --version
cc --version
pkg-config --modversion openssl
```

### 2. Install and start Intent AI Ops

The cross-platform bootstrap installs a private Node.js 24 runtime only when Node is absent, then installs the committed package tarball:

```sh
curl -fsSL https://raw.githubusercontent.com/cryptofuture/intentaiops/main/scripts/install.sh | sh
```

Windows PowerShell uses `irm https://raw.githubusercontent.com/cryptofuture/intentaiops/main/scripts/install.ps1 | iex`. An existing Node older than 24.7 is never silently replaced. With compatible Node and npm already installed, either GitHub source can be used:

```sh
npm install --global https://raw.githubusercontent.com/cryptofuture/intentaiops/main/dist/intent-ai-ops.tgz
# or the current branch archive
npm install --global https://github.com/cryptofuture/intentaiops/archive/refs/heads/main.tar.gz
intentaiops
```

Run the same install command to update. For development from a checkout, use `npm install` and `npm run cli`. New installations keep data under `~/.intentaiops`; an existing `~/.webminai` vault is detected and reused automatically. To choose another location:

```sh
intentaiops --data-root /srv/webminai-data
```

FreeBSD has no upstream `better-sqlite3` prebuild for this package profile. Install `node24`, `npm-node24`, `python312`, and `gmake`; Intent AI Ops's package lifecycle then detects the versioned Python executable and builds the binding during the same tarball installation command. Mainstream Linux, macOS, and Windows installations validate and use the prebuilt binding instead.

`npm run build:package` reproducibly creates `dist/intent-ai-ops.tgz` and its separate `dist/intent-ai-ops.tgz.sha256` checksum without embedding either file inside itself. `npm run test:package-install` installs that exact artifact locally. `npm run test:package-install:remote` transfers the same committed-style artifact to the configured representative Linux, FreeBSD, macOS, and Windows hosts, installs it from a temporary `file://` URL, exercises CLI startup and SQLite history, and cleans up.

On the first run, Intent AI Ops creates the encrypted vault and requests a passphrase:

```text
Intent AI Ops
Manage one or many hosts like a system administrator or DevOps engineer, using natural-language instructions.
------------------------------------------------------------
INFO: Creating settings at /home/alice/.intentaiops/settings.json
Data directory         /home/alice/.webminai
Settings               new
------------------------------------------------------------
Attempt                1 of 3
Vault passphrase: •••••••••••••••••••••
Confirm vault passphrase: •••••••••••••••••••••
```

Use at least 12 characters, preferably five or more random words or at least 20 password-manager-generated characters. This passphrase encrypts the SSH connection details and per-host action keys. It is not saved.

After unlocking, choose `Change vault passphrase` at any time. Intent AI Ops decrypts all host entries with the current in-memory passphrase, generates fresh KDF parameters and a salt, atomically re-encrypts the complete vault with the new passphrase, and keeps the vault unlocked with the new value. The old passphrase no longer decrypts the file.

### 3. Add a host using an SSH key

Choose `Add host` for a persistent connection or `Temporarily add host (removed on exit)` for a session-only connection:

```text
Intent AI Ops
Main dashboard
------------------------------------------------------------
Data directory: /home/alice/.webminai
Hosts: 0 | Stage 2 desired: 0 active / 0 inactive
Default administrator email: intentaiops@example.invalid
------------------------------------------------------------
ACTIONS [current]
> Add host
  Temporarily add host (removed on exit)
  Set default administrator email
  Change vault passphrase
  Quit
```

Enter a short local name and paste the SSH command you would normally use:

```text
Host name (lowercase letters, numbers, _ or -): edge-1
SSH command or ssh:// URL: ssh -p 2222 -i /home/alice/.ssh/edge-1 admin@edge.example.com

How should OpenSSH authenticate?
   1  SSH key or ssh-agent
   2  Password (prompted by OpenSSH)
   3  Automatic OpenSSH selection
Select: 1
```

Leave either the host name or SSH destination blank to cancel and return to the dashboard. The authentication list also includes `Cancel and return to dashboard`, so no connection or settings write occurs until all three inputs are provided.

Intent AI Ops then starts the real system `ssh` binary. On the first connection, OpenSSH may ask you to confirm the host key. If the private key has a passphrase, OpenSSH asks for it directly.

```text
The authenticity of host '[edge.example.com]:2222' can't be established.
Are you sure you want to continue connecting (yes/no/[fingerprint])? yes
Enter passphrase for key '/home/alice/.ssh/edge-1':
OK: SSH connection succeeded.

Should Intent AI Ops save an SSH password or private-key passphrase?
   1  Do not save an SSH credential
   2  Save it encrypted with the vault passphrase

OK: Host edge-1 was saved and associated with its stable fingerprint.
INFO: No SSH credential was saved.
```

The pasted command accepts `-p`, `-i`, `-F`, `-l`, `-4`, and `-6`. Put advanced SSH options, jump hosts, and proxy commands in an OpenSSH config file and pass it with `-F`.

Windows domain usernames may use either separator accepted by the target OpenSSH server. Paste the same command that works locally; Intent AI Ops preserves the username as one argument:

```text
SSH command or ssh:// URL: ssh "DOMAIN/user"@windows.example
# or
SSH command or ssh:// URL: ssh -l 'DOMAIN\user' windows.example
```

When entering an `ssh://` URL directly, encode `/` in the username as `%2F`, for example `ssh://DOMAIN%2Fuser@windows.example`. Pasting the normal `ssh` command performs that encoding automatically.

### 4. Alternative: add a password-authenticated host

The flow is the same, but the SSH command does not contain a password:

```text
Host name (lowercase letters, numbers, _ or -): database-1
SSH command or ssh:// URL: ssh database-admin@192.0.2.40

How should OpenSSH authenticate?
   1  SSH key or ssh-agent
   2  Password (prompted by OpenSSH)
   3  Automatic OpenSSH selection
Select: 2

database-admin@192.0.2.40's password:
OK: SSH connection succeeded.
```

If you choose not to save it, the password is read by OpenSSH through the terminal and is not retained by Intent AI Ops. If you opt in, hidden input stores it only in that host's AES-256-GCM vault payload. When you select the host later, Intent AI Ops lets OpenSSH consume the saved credential through temporary askpass material and reuses the authenticated connection until you disconnect. A stale saved value falls back to the normal OpenSSH prompt, and the host screen can replace or clear the saved credential.

A temporary host exists only in the current Intent AI Ops process: its connection, authentication choice, action key, and optional saved credential are excluded from `settings.json`. Its hashed stable machine fingerprint remains mapped to a non-secret history directory. The host screen also offers `Remove saved host connection (keep task history)`, which removes only the saved local connection entry and does not touch the remote host or history directory. Re-adding the same machine later—even under another local name—reattaches its task history. The raw machine identity is never persisted or displayed, and a fingerprint already used by another currently configured host is rejected.

### 5. Connect and inspect Stage 2 status

Select the configured host:

```text
Intent AI Ops
Main dashboard
--------------------------------------------------------------------------------
Hosts: 23 | Stage 2 desired: 18 active / 5 inactive
Default administrator email: owner@example.com
--------------------------------------------------------------------------------
ACTIONS             | HOSTS                            | HOST DETAILS
  Browse/search...  | Search: edge  2 of 23 hosts      | Host: edge-1
  Add host          | > edge-1  admin@edge.example... | Address: admin@edge.example.com:2222
  Set default...    |   edge-backup  root@backup...    | Desired Stage 2: active
                    |                                  | Runtime: not probed
--------------------------------------------------------------------------------
Tab pane | Up/Down select | Enter open | / search | Esc back | q quit
```

Press Tab to move between dashboard actions and hosts, `/` to search display-safe host fields, and Up/Down or Page Up/Page Down to navigate. The selected host's locally available details appear on the right on wide terminals and below the lists on narrow terminals. Rendering the dashboard does not contact hosts. After returning from a host, the action pane offers a reconnect action for that recent host. The host console also has `Switch to another host`, which closes the current SSH ControlMaster and opens the searchable picker directly.

`Set default administrator email` stores one vault-encrypted application default. Verified tasks that need an initial administrator or contact email—including WordPress, WooCommerce, Joomla, Drupal, PrestaShop, Moodle, and Magento—reuse it across supported Linux and Windows routes. AI-planned tasks receive the same preference when it is relevant. Enter `-` in the setting screen to clear the preset and return to the non-deliverable `intentaiops@example.invalid` fallback.

After OpenSSH authentication, the host console shows the detected abilities:

```text
Connection and Stage 2
──────────────────────────────
SSH                    connected
Remote user            uid 1000
Privilege              sudo password required
Netdata                not installed
curl                   available
Intent AI Ops plugin        not installed
Stage 2 health         inactive
Netdata ownership      unknown
Command identity       root execution unavailable
```

Use `Show server requirements` when activation is unavailable. The controlled server needs:

- working OpenSSH access;
- root access, `sudo`, or passwordless `doas` for installation and removal;
- outbound HTTPS access to `get.netdata.cloud` if Netdata is not installed (`curl` is required on Linux and installed through `pkg` on FreeBSD);
- a supported Linux, FreeBSD, or macOS host with a matching native plugin artifact;
- a plugin filesystem that permits the setuid bit (`nosuid` mounts cannot activate root execution).

### 6. Activate Netdata and the Intent AI Ops plugin

Choose `Activate Stage 2 (install Netdata if needed)`:

```text
Intent AI Ops
Host: edge-1
--------------------------------------------------------------------------------
HOST ACTIONS                         | HOST STATUS
  Refresh status                     | SSH: connected
> Activate Stage 2                   | Platform: Linux x86_64
  Install/update plugin only         | Privilege: sudo password required
  Connect existing Netdata Cloud     | Stage 2 health: inactive
  Deactivate plugin                  | Netdata ownership: unknown
  Remove managed installation        | Command identity: privileged execution unavailable
  Set Docker preference              |
  Run a verified common task         |
  Run an AI-assisted task            |
  Task history and reverts            |
  Open an interactive SSH shell      |
  Show server requirements           |
  Switch to another host             |
  Disconnect                         |
--------------------------------------------------------------------------------
Up/Down select | Enter open | Esc disconnect
```

If the SSH account is root, no sudo prompt is needed. With passwordless sudo, activation proceeds automatically. Otherwise Intent AI Ops asks for the sudo password with hidden input:

```text
› This account needs a sudo password for host changes. It is used once and never saved.
Sudo password: ••••••••••••
Install/activate Netdata and the Intent AI Ops plugin? [Y/n]: y
› Activating Stage 2 and verifying its Netdata function API...
✓ Stage 2 is active.
```

Activation performs these operations through the existing SSH session:

1. Create a restricted remote temporary directory.
2. Copy the installer and native plugin with `scp`.
3. Install Netdata only when it is absent.
4. Select the native plugin for the detected OS and CPU architecture, install it as `root:netdata` mode `4750`, and install its action key as mode `0600` owned by `root:root` on Linux or `root:wheel` on FreeBSD.
5. Restart Netdata and verify through `127.0.0.1:19999` that both functions are registered, health reports effective UID 0, and an authenticated transient root command can create and remove a randomized probe under `/etc`.
6. Remove the remote temporary files.

After refreshing, a healthy installation looks like:

```text
Netdata                installed
Intent AI Ops plugin        installed
Stage 2 health         active
Netdata ownership      managed
Command identity       root (token-authenticated plugin)
```

`managed` means Intent AI Ops installed Netdata. `preexisting` means Netdata was already present and Intent AI Ops will not uninstall it.

### Connect an existing Agent to Netdata Cloud

From the host console, choose `Connect existing Netdata to Netdata Cloud`. Paste the single-line claiming command copied from Netdata Cloud, a claiming-details URL containing the relevant query parameters, or just the claim token. The paste prompt is hidden. Intent AI Ops recognizes Linux kickstart flags, Docker environment variables, Helm `--set` values, Windows `TOKEN`/`ROOMS` values, and the `Claim Token` / `Claim URL` / `Room IDs` details block. It parses this text locally and never executes the pasted command.

When a token, URL, or room ID cannot be extracted consistently, the CLI asks for it separately. The claim URL defaults to `https://app.netdata.cloud`; room IDs must be comma-separated UUIDs. Intent AI Ops shows the non-secret URL and room IDs, keeps the token masked, and asks for confirmation before changing the host.

For an existing Linux or FreeBSD Agent, Intent AI Ops follows Netdata's [configuration-file claiming method](https://learn.netdata.cloud/docs/netdata-cloud/connect-agent#method-2-via-configuration-file):

1. Copy a fixed claiming helper over the authenticated system SSH connection.
2. Send the token, URL, and room IDs only through SSH standard input, never command-line arguments.
3. Atomically create the Agent's `claim.conf` as `root:netdata` mode `0640`.
4. Ask `netdatacli` to reload claiming state, falling back to an Agent restart.
5. Poll the loopback `/api/v3/info` response until its Cloud state reports a claimed Agent.

This action requires Netdata to be installed, but it does not reinstall Netdata, switch its release channel, or run the pasted kickstart/Docker/Helm command. The token is not saved in `settings.json`, SQLite history, debug logs, or Codex input. Netdata necessarily retains it in the protected remote `claim.conf`, as described by its official claiming design. Reclaiming an already-connected Agent displays a warning before replacing that file.

If Netdata already exists, choose `Install/update plugin only`. This mode installs a missing plugin or updates an older plugin, but fails instead of installing Netdata when Netdata itself is absent. It is the normal way to update Intent AI Ops without changing ownership of the existing Netdata installation. The host screen shows the running and bundled plugin versions.

The plugin has an independent release version in `plugin/VERSION`; it is not inferred from the Node.js application version. The build embeds that value in the native binary, `webminai.plugin --version` reports it, and the Netdata health response exposes it. After installation Intent AI Ops requires the health version to exactly match the bundled version. The installer reports `installed`, `updated`, or `unchanged`, including the previous recorded version. When updating, it keeps a root-owned backup until health verification succeeds and restores that backup if the new plugin fails. Plugin-only rollback always preserves Netdata.

### 7. Add optional host context and command rules

After adding `edge-1`, its non-secret files live in `~/.intentaiops/edge-1/` for a new installation. You may create `context.md` with information that is useful to Codex but is safe for the model to see:

```md
# edge-1

- Production reverse proxy.
- nginx configuration is under /etc/nginx.
- Prefer read-only diagnostics before proposing changes.
- Never restart more than one service in a task.
```

The generated `rules.json` contains the deterministic execution policy:

```json
{
  "format": "webminai-server-rules",
  "version": 1,
  "policy": {
    "allowSudo": false,
    "executionIdentity": "root",
    "maxCommands": 20,
    "maxTimeoutMs": 300000,
    "deniedPatterns": []
  },
  "preferences": {
    "docker": "auto"
  }
}
```

For example, add regular-expression patterns to reject commands regardless of what Codex proposes:

```json
"deniedPatterns": [
  "rm\\s+-rf",
  "shutdown|reboot",
  "mkfs"
]
```

Commands already execute as root, so command plans must not include `sudo`. `requiresSudo` remains plan metadata identifying operations that need root; it does not add sudo to the command. The local policy gate still applies command limits, timeouts, denied patterns, dependency ordering, and explicit approval.

The host console detects the Docker CLI, daemon, Compose support, and whether the host itself is a container. `Set Docker preference` has three values:

- `auto` prefers Docker Compose only when Docker is ready on a non-container Linux host. LXD, LXC, Docker, and other container guests default to native installation even when nested Docker happens to work.
- `enabled` explicitly overrides the container safeguard. If Docker is not ready, an AI task may propose an idempotent Docker Engine and Compose installation before the requested service.
- `disabled` prevents AI-generated plans from using or installing Docker.

When Docker is preferred, long-running applications such as Ghost are planned as Compose projects under `/opt/webminai/services/<service>/compose.yaml`; Intent AI Ops rejects `docker run` service plans. Secret values are generated only by the approved remote command, never by Codex. They are stored under `/root/<service>_credentials/` with directory mode `0700` and file mode `0600`, while Compose references an `env_file` or mounted secret file. Commands may verify ownership, modes, and health, but may not print credential files, render resolved Compose configuration, or inspect secret-bearing container environment variables. As a final guard, Intent AI Ops redacts stdout and stderr for commands that generate or handle these credential paths before saving task history or displaying results.

### 8. Run a verified or AI-assisted task

`Run a verified common task` refreshes inventory and exposes only deterministic tasks eligible for the connected platform, distro, container-runtime state, and saved Docker preference. Linux includes a separate distro-specific Docker Engine/Compose task. FreeBSD 15+ non-jail hosts include a separate Podman Suite/Compose task. macOS exposes Colima and Windows exposes Docker Desktop/WSL as explicit prerequisites. Runtime-dependent applications remain hidden until their prerequisite is ready; native application routes remain visible only when their reviewed distro matrix resolves successfully. The same eligible candidate set is passed to semantic AI routing, so a differently phrased exact request can select the verified task, while a custom request can reuse its stack, credential, health-check, phase, and rollback knowledge without being mistaken for the unchanged deployment.

Every supported host also exposes `Collect a concise host health report`. It first refreshes Netdata and treats its metrics, contexts, containers, and alerts as the primary source. Three approved read-only phases then supplement Netdata with bounded recent error records, failed services, cached update/reboot state, and process/container snapshots. Linux profiles select distro-specific journal, syslog, package-manager, init-system, and reboot locations; FreeBSD uses `/var/log/messages`, `/var/log/daemon.log`, `service`, `pkg audit`, and `pkg version`; Windows uses the System and Application Event Logs, CIM, service state, reboot registry keys, and Windows Update Agent; macOS uses the unified log, `launchctl`, `softwareupdate`, and Colima/Docker state. Authentication and security logs are excluded.

Linux, FreeBSD, and Windows hosts also expose `Install all current-release system updates`. This verified maintenance task records an exact package/update baseline, installs every update offered by the configured current-release repositories, retains a full task-owned delta, and produces an AI summary of changed software, failures, reboot requirements, and any detected newer OS release or Windows feature upgrade. Linux uses the detected `apt`, `dnf`/`yum`, `zypper`, `apk`, or `pacman` route; FreeBSD applies same-release `freebsd-update` patches plus `pkg upgrade`; Windows uses the Windows Update Agent while excluding feature upgrades. It never invokes an OS release-upgrade or reboot command. Because cross-package downgrades are not a generally safe rollback, the task has no automatic revert plan and says so before approval. Its compact update context is stored for later planning.

After collection, Codex produces a short report covering overall health, immediate issues, capacity/load, reliability, updates/reboot needs, monitoring gaps, and prioritized next actions. Evidence is redacted before display, AI input, or SQLite persistence. The task history retains the bounded evidence and report, while `health-context.json` keeps only the non-secret platform log/tool profile and compact report context for faster later diagnostics. Missing optional Netdata v3 endpoints are recorded as monitoring gaps instead of discarding the Netdata data that was available. macOS unified-log and update reads, and Windows Update Agent reads, use the durable job bridge so each Netdata HTTP request remains short and cancellable.

Container-runtime preflight is platform-specific. Windows Docker Desktop and macOS Colima require hardware virtualization and report actionable BIOS/UEFI or outer-hypervisor instructions when it is unavailable. Native Linux Docker uses namespaces and cgroups, while FreeBSD Podman uses jails and VFS; neither requires VT-x, AMD-V, or nested virtualization. A Linux container or FreeBSD jail is a separate nesting boundary and is not automatically treated as an eligible outer host. A manually disabled Docker preference continues to suppress Docker/Podman/Colima installation and container-dependent routes.

You may also choose `Run an AI-assisted task`. Before command planning, a separate structured Codex turn compares the meaning of the request with the promoted catalog; it does not rely on product-name or phrase matching. Codex can select an unchanged verified task, request ordinary planning, or select up to three verified candidates as implementation knowledge for a custom plan. In the last case the main planner receives bounded host-resolved references covering the reviewed compatibility matrix, phases, paths, credential protections, health checks, rollback structure, and safe command fragments. The current request remains authoritative, so candidate knowledge cannot silently turn a custom task into that candidate's deployment.

The router selects an unchanged catalog task only when it fully satisfies the requested outcome. Custom topology or integration, migration, upgrades, removal, diagnostics, or material configuration differences remain AI-planned even when a candidate product is mentioned. Routing failure safely falls back to ordinary planning. Consultations and non-Linux hosts retain their existing paths.

Use Up/Down to select a previous request or choose a new task. In the editor, Enter submits, Shift+Enter inserts a new line, Ctrl+J is the compatibility fallback for terminals that do not report Shift+Enter, and Up/Down recalls previous task text:

```text
AI-assisted task / production
------------------------------------------------------------
Describe the server task.
Prefix the request with ? to ask for advice without executing commands.

Recent requests
  #31 [completed] Configure nginx...
------------------------------------------------------------
INFO: Enter submits • Shift+Enter or Ctrl+J adds a line • ↑/↓ recalls task history

› Check current CPU and memory pressure.
  Inspect nginx status and recent errors.
  Propose read-only diagnostic commands only.

› Collecting Netdata inventory and asking Codex for a command plan...
[Codex thread.started] Codex planning session started
[Codex turn.started] Codex is analyzing the task
```

Codex runs with `gpt-5.6-luna` and medium reasoning. Its JSONL progress and reasoning summaries are shown as they arrive and saved with the task. Codex receives the sanitized Netdata inventory, including Agent information, contexts, functions, container visibility, and alerts, plus optional `context.md`, the policy extracted from `rules.json`, and your request. On Linux, this also includes Intent AI Ops's cached host profile: the exact `/etc/os-release` identity, architecture, kernel, init/service and package-manager conventions, detected stack commands and versions, distro-specific package-name candidates, and checked official documentation/package/release links. It does not receive the SSH URL, vault, password, or action key.

The Linux profile refresh is part of an active Stage 2 health/status read. Intent AI Ops derives the host facts through the token-authenticated loopback plugin, checks only a curated official distro release URL from the controller, and never sends the host inventory or SSH details to that site. It stores no raw web page content. Only bounded reachability/version facts and official URLs are retained, with a 24-hour online cache. An unavailable site does not make the host unhealthy: the last profile is retained with a refresh warning, and local facts continue to work.

Prefix a request with `?` to consult Codex without creating or executing a command plan:

```text
? Should this site use the host nginx package or a container? Consider rollback and the existing firewall.
```

Intent AI Ops displays and saves the answer, but never opens command approval or sends a command to the host. It also asks Codex for a compact context summary of at most 4 KiB. A later `?` consultation receives only that minimized summary, not the full earlier conversation, and replaces it only after the new consultation succeeds. This keeps one rolling handoff per host; a failed consultation leaves the last successful summary pending.

When the next ordinary AI task is submitted, Intent AI Ops consumes the pending summary and passes it to the planner as advisory background. The new task text is explicitly authoritative: consultation context cannot add scope, grant permission, or override it. For example:

```text
? Compare a host nginx package with a container for this server.
? Recommend a rollback approach for the preferred option.
Deploy the static site on port 18080 and verify it locally. Do not change the firewall.
```

Only the latest compact combined summary accompanies the final deployment request. Answers and their consumption links remain inspectable in `Task history and reverts`, while retries of that task reuse the same linked summary. An unrelated future task does not inherit already-consumed advice.

For monitoring, statistics, discovery, alerts, services, processes, and containers, the planner is instructed to use the supplied Netdata snapshot or loopback Agent API before direct system utilities. It falls back to OS commands when Netdata lacks the data, for state-changing work, or when the request explicitly asks for another source.

Intent AI Ops shows the entire proposed forward and revert plan before execution:

```text
Codex command plan
--------------------------------------------------------------------------------
Summary                Inspect system pressure and nginx health
Change overview        Read current pressure and service health without changing host state
Confirmation           required

Commands to execute (3)
--------------------------------------------------------------------------------
  ID                 PURPOSE                         RISK       TIMEOUT     ROOT
  load               Read load averages              read       10000ms     no
  memory             Read memory pressure            read       10000ms     no
  nginx              Read nginx alerts               read       10000ms     no

1. load
Purpose                Read load averages
Risk                   read
Timeout                10000ms
Root required          no
Command
-------
curl --fail-with-body --silent --show-error 'http://127.0.0.1:19999/api/v3/data?contexts=system.load&after=-60&points=1'

2. memory
Command
-------
curl --fail-with-body --silent --show-error 'http://127.0.0.1:19999/api/v3/data?contexts=system.ram&after=-60&points=1'

3. nginx
Command
-------
curl --fail-with-body --silent --show-error 'http://127.0.0.1:19999/api/v3/alerts'
--------------------------------------------------------------------------------
```

After reviewing the displayed plan, enter `y` once to approve every forward command exactly as listed:

```text
Execute all 3 commands exactly as shown? [y/N]: y
```

Enter `n` to retain one-command-at-a-time review:

```text
Approve: load
─────────────────────
Purpose                Read load averages
Risk                   read

curl --fail-with-body --silent --show-error 'http://127.0.0.1:19999/api/v3/data?contexts=system.load&after=-60&points=1'

Execute this command? [y/N]: y
```

Rejected commands are not executed. Commands depending on a rejected or failed command are marked as blocked. Output is returned through the signed Netdata function and displayed in the terminal.

Tasks and consultations are saved immediately in the selected server's `tasks.sqlite3`. A consultation record includes its question, live Codex progress, answer, compact summary, and the task or later consultation that consumed it. A task record includes the request, linked consultation summary, live Codex progress, plan, change overview, expected modified paths, every forward result as it arrives, errors, saved revert plan, every revert result, and final status. An interrupted execution therefore retains the results completed before interruption. On the next run, use Up/Down in the editor to recall request text, or open `Task history and reverts` to search task metadata, preview a selected record, ask a saved consultation again, retry a task, edit its request as a separate task, or approve its displayed revert plan in bulk or one command at a time. Result stdout and stderr remain separate and complete. This database stays local and is mode `0600`.

Selecting an AI task in history offers two linked retry modes:

- `Retry with automatic corrections from history` keeps the original request and lets Codex diagnose the saved plan, progress, successful and failed command results, stdout/stderr, errors, and revert results.
- `Retry with additional correction instructions` supplies the same retry history plus a new multiline user correction.

Each retry creates a new task with a `retry-of:#ID` link; it never overwrites the failed attempt. Repeated retries supply the complete retry chain, oldest to newest. Sanitized status and command-result evidence for the whole chain is also embedded directly in the planner prompt, so a correction does not depend on Codex opening the history file. Codex is told to account for commands that already completed and possible partial host state instead of blindly repeating non-idempotent work. If the first proposed plan fails deterministic validation, Intent AI Ops automatically requests one corrected plan before reporting failure. The accepted plan is shown in full and still requires bulk or per-command approval.

Changing AI tasks must include a revert plan. Codex is told to preserve pre-task state under a task-specific `/var/lib/webminai/task-state/TASK_ID` directory and not remove anything that existed before the task. This makes rollback reviewable; it does not make arbitrary generated rollback infallible. Read the forward and revert commands before approving either direction.

For example, this request:

```text
Install htop, report system information, create a persistent 2 GiB swap file,
then report the result of every step.
```

can produce ordinary read commands and, for an Ubuntu host, separately approved root commands such as:

```sh
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y htop
fallocate -l 2G /swapfile
chmod 0600 /swapfile
mkswap /swapfile
swapon /swapfile
grep -q '^/swapfile ' /etc/fstab || printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
```

The CLI still shows the entire plan and asks separately before each command. The exact package-manager commands depend on the detected distribution. A planner proposal containing `sudo` fails deterministic validation because the authenticated plugin already executes approved commands as root.

### Deterministic common-task catalogs

Ten system-level deterministic reversible plans remain available to automated development and integration runners:

1. deploy an nginx static test website on port 18080;
2. install `htop`;
3. install `jq`;
4. create a locked system service user;
5. create and activate an isolated 2 GiB lab swap file;
6. install a systemd oneshot service;
7. install a systemd timer;
8. install a cron.d job;
9. install and validate a logrotate rule;
10. install and apply a systemd-tmpfiles rule.

Each plan uses isolated `webminai-test` names, records relevant pre-task state, and has a saved revert plan. Package tasks snapshot the complete installed Debian package set and purge only packages introduced by the task. They are internal regression fixtures and are not offered as user-selectable host or multi-host tasks.

The 13 promoted application plans are user-selectable on Linux, and their reviewed Windows routes are exposed where implemented. They share the same approval, history, retry, and revert model. Only applications with a reviewed deterministic builder are listed; a candidate appearing in the top-20 research runbook is not enough by itself. On FreeBSD, use `Run an AI-assisted task`; the planner is told to produce POSIX `/bin/sh`, `pkg`, `service`, and `sysrc` commands and to avoid Linux-only tools.

For application-level learning across the Linux lab fleet, FreeBSD, Windows, and macOS, use [top-20-cross-platform-codex-tasks.md](top-20-cross-platform-codex-tasks.md). It provides 20 AI task prompts with compatibility gates, external verification, secret-handling requirements, and baseline-restoring rollback criteria.

### 9. Run one task on multiple hosts

With at least two configured hosts, choose `Run one task on multiple hosts` from the main menu. The plain checkbox list is locally searchable with `/`; move with Up/Down, toggle hosts with Space, use `A` for all or `N` for none, and press Enter to continue. Search covers only display-safe host identity, address, desired Stage 2, and known platform fields. Enter one request for the selected fleet. Codex routes against each Linux host's current profile. When every host independently selects the same unchanged verified task, Intent AI Ops runs that catalog task across the fleet. Otherwise each custom child plan receives the candidate knowledge selected for that host. Intent AI Ops displays every complete plan in one consolidated review and then runs up to four hosts concurrently after one explicit bulk approval.

The same leading `?` works in the multi-host AI editor. It creates an independent consultation for every selected host, using that host's inventory and pending compact summary, and executes no commands. A later ordinary multi-host request consumes each host's summary independently before preparing the host-specific plans.

`Install/update plugin on multiple hosts` uses the same selector and bounded parallelism. It inspects each host sequentially for elevation, renders a current/target/status table, and asks once before updating the eligible hosts. Hosts without Netdata are marked unavailable and must use full Stage 2 activation instead.

The result is one multi-host run with an aggregate status and one ordinary child task in each host's `tasks.sqlite3`. Live planning and command output is prefixed with the host name. This keeps each host's detailed logs, modified paths, results, and rollback state isolated while `multi-host-runs.sqlite3` provides the group overview. A group can be `completed`, `partial`, or `failed` without hiding any per-host outcome.

Choose `Multi-host run history` to:

- retry failed hosts only;
- select an arbitrary subset to retry, optionally adding Codex correction instructions;
- restore selected hosts with their saved revert plans.

A retry creates a new linked group and new linked child tasks only for the selected hosts. Existing successful child tasks are not executed again. Before retrying a child that may have changed its host, the CLI reviews and runs its saved revert plan so the retry starts from the captured pre-task state.

For the nginx task, completion also requires a local HTTP request to every host's connection address on port `18080`; a loopback-only success on the remote host is not sufficient. Revert verification confirms that the Intent AI Ops test page is no longer available. The remote lab integration test performs that complete apply/check/revert sequence:

```sh
VAULT_TEST='your vault passphrase' npm run test:multi-host
```

Set `WEBMINAI_TEST_HOSTS=host-a,host-b` or `WEBMINAI_TEST_CONCURRENCY=2` to restrict that test. It defaults to every configured host whose name starts with `webminai-` and always attempts rollback before reporting an apply failure.

### 10. Open a normal SSH terminal

Choose `Open an interactive SSH shell` to work directly on the server:

```text
› Entering the remote shell. Exit it to return to Intent AI Ops.
admin@edge-1:~$ uname -a
admin@edge-1:~$ exit
```

The shell uses the same authenticated OpenSSH control session. Intent AI Ops resumes the host menu when the remote shell exits.

### 11. Deactivate, uninstall, or reactivate

There are two removal choices:

- `Deactivate plugin and keep Netdata` removes the Intent AI Ops plugin, remote action key, and managed configuration but preserves Netdata.
- `Remove plugin and Intent AI Ops-managed Netdata` also uninstalls Netdata only when its recorded ownership is `managed`. Pre-existing Netdata remains installed.

After deactivation, SSH access and the encrypted host entry remain available:

```text
Stage 2 health         inactive
Intent AI Ops plugin        not installed
```

Select `Activate Stage 2` again whenever you want to reactivate the host. Choosing `Disconnect` closes the temporary OpenSSH control session and returns to the host list. The next Intent AI Ops launch asks for the vault passphrase again.

Hosts activated by an earlier Intent AI Ops version must be activated again once. Activation removes the legacy helper and sudoers rule, installs the plugin with its root execution mode, changes the remote token to root-only permissions, and updates the generated policy. Until then the Stage 2 health probe reports the host as inactive.

### 12. Debug a failed Stage 2 activation

Diagnostic output is enabled by default. Use the same data root you used when adding the host:

```sh
intentaiops

# With a custom data directory:
intentaiops --data-root /srv/webminai-data

# Suppress phase tracing when it is not wanted:
intentaiops --no-debug
```

Connect to the host and select `Activate Stage 2` again. Debug mode prints each phase:

```text
[debug:create-temp] Creating restricted remote temporary directory
[debug:copy] Copying Stage 2 installer
[debug:copy] Copying native Netdata plugin
[debug:install] Running installer with elevation mode: sudo-password
[debug:probe] Checking Netdata info, function registry, and plugin health (attempt 1/31)
```

After Netdata restarts, Intent AI Ops allows about 30 seconds for its HTTP API and external plugin to become callable. Startup responses such as 404, 503, or connection refusal are retried; debug mode shows each attempt. SSH, SCP, sudo, and installer failures include their captured remote exit code, stdout, and stderr. If the final plugin health check still fails, Intent AI Ops collects these read-only diagnostics before rollback:

- operating system and kernel information;
- Netdata version and service status;
- recent `netdata.service` journal entries available to the SSH user;
- installed Intent AI Ops runner, key, and plugin file metadata;
- the loopback Netdata functions API response.

Intent AI Ops still rolls back a failed activation. Debug tracing changes visibility, not lifecycle safety. Diagnostic output automatically redacts SSH URLs and 64-character action keys, but it can contain hostnames, service logs, and other system information; review it before sharing.

## Current architecture

```text
local Node.js application
  ├─ encrypted settings.json
  ├─ system ssh/scp ──────────────┐
  ├─ Codex planner (no secrets)   │
  └─ approval + policy gate       │
                                  ▼
controlled host: loopback Netdata API → webminai.plugin → root command backend
                                      HMAC + timestamp + nonce gate
                                                        ├─ Linux: systemd-run or /bin/bash
                                                        ├─ FreeBSD: /bin/sh + rc.d tools
                                                        └─ macOS: /bin/sh + sudo/bootstrap tools

Windows host: loopback Netdata API → webminai.plugin-windows-amd64.exe
                                   └─ LocalSystem Windows PowerShell backend

Kubernetes: kubeconfig HTTPS → Kubernetes Service proxy → gateway Netdata Agent
                                                        └─ webminai.plugin-kubernetes
                                                           └─ in-cluster Kubernetes HTTPS API
```

System `ssh` remains the permanent bootstrap and recovery transport. Activation copies the installer and native plugin with `scp`, optionally installs Netdata, registers the plugin, and verifies its health and effective UID through `ssh host curl http://127.0.0.1:19999`. No local port forwarding is used.

Stage 2 installs the native plugin as `root:netdata` mode `4750`. Netdata can execute it, but cannot modify it. The plugin ignores caller-controlled key-file environment variables when running setuid, reads the root-only remote action key, and accepts commands only after validating their HMAC, timestamp, request ID, and replay nonce. It also publishes a minimal `webminai.status` chart so Netdata keeps the function provider registered as a valid external collector.

For each authenticated command, the plugin clears supplementary groups, establishes root UID/GID, and uses a fixed environment. On Linux it enters the host mount namespace and calls `systemd-run --wait --pipe --collect` when available, otherwise it executes through `/bin/bash`. FreeBSD and macOS builds have no Linux namespace or systemd dependency and execute through `/bin/sh` in separately timed process groups. There is no sudoers rule or permanent Intent AI Ops root helper. Bootstrap elevation accepts root, sudo, or passwordless doas; command execution after activation does not depend on any of them.

This is intentionally a root administration boundary, not a restricted monitoring collector: a valid approved command can make arbitrary host changes. A native-plugin vulnerability would therefore have root impact. Loopback-only API access, system SSH transport, per-host keys, short-lived signed requests, deterministic plan validation, and interactive approval are all part of the required trust model.

## Data layout

```text
DATA_ROOT/
  settings.json             # encrypted defaults, connection/credential/action key, plus hashed history fingerprints
  multi-host-runs.sqlite3   # group status and child task references; no secrets
  HISTORY_ID/               # stable fingerprint alias; legacy hosts retain their former SERVER_ID directory
    rules.json              # non-secret deterministic command policy
    context.md              # optional non-secret planner context
    host-context.json       # cached Linux distro, stack, and official-source profile
    observed.json           # last Netdata inventory snapshot
    tasks.sqlite3           # local task plans, outcomes, and history
```

`settings.json`, the multi-host run index, and each task database are mode `0600`. A user passphrase is expanded with the self-described Argon2id default (128 MiB, four passes, one lane); when its optional native binary is unavailable, new vaults use the OWASP scrypt profile (`N=2^17`, `r=8`, `p=1`). Authenticated legacy scrypt vaults migrate atomically to Argon2id, while existing Argon2id vaults never downgrade. An encrypted verifier authenticates even an otherwise empty vault. Application defaults and each server secret—including an optional SSH credential—are encrypted with AES-256-GCM. Intent AI Ops generates a separate random 256-bit action key for every host when that host is added; the shared vault passphrase encrypts those distinct keys but does not derive or reuse them. The server ID is authenticated as additional data, so encrypted entries cannot be silently moved between server names. A SHA-256 digest of the authenticated remote machine identity is stored separately to associate history across temporary, removed, renamed, and re-added host entries.

Codex never creates or receives action keys or saved SSH credentials. For every command, Intent AI Ops itself also generates a fresh request ID and nonce and signs the timestamped payload with that host's key. The matching remote key is mode `0600`: `root:root` at `/var/lib/webminai/action.key` on Linux or `root:wheel` at `/var/db/webminai/action.key` on FreeBSD. Task history can contain remote command output and should be protected like administrative logs, but it contains no stored SSH password or action key.

The SSH URL format is:

```text
ssh://USER@HOST:PORT?identity=/absolute/key/path&config=/absolute/ssh/config
```

Host authentication is delegated to OpenSSH. The initial interactive connection performs host-key confirmation and authentication; commands after that use strict host-key checking, batch mode, and the temporary authenticated control socket.

## Codex planner

The planner defaults to `gpt-5.6-luna` with `medium` reasoning. Both are constructor options. Codex runs in a newly created temporary directory containing only:

- sanitized Netdata inventory;
- non-secret server context;
- deterministic command policy;
- one minimized consultation summary when the host has pending advice;
- sanitized retry history when retrying an earlier task.

It runs read-only, non-interactively, ephemerally, with user config and repository rules ignored. It never receives `settings.json`, the SSH connection URL, the action key, or a server-directory view. Retry context is written as `previous-attempts.json` and minimized advice as `consultation-context.json` only inside that temporary planner directory, with secret-shaped fields, SSH URLs, private keys, bearer values, common credential assignments, and 256-bit hexadecimal keys redacted. Consultations must match `schemas/consultation.schema.json`; their response contains prose advice and a bounded rolling summary, never commands for automatic execution. Task output must match `schemas/command-plan.schema.json`, then passes another deterministic validation and explicit per-command or bulk approval step.

## Stage 2 lifecycle

- `activate`: create a remote temporary directory, copy artifacts, install Netdata only when absent, install the signed privileged-execution plugin and host key, restart Netdata, poll API/plugin/identity readiness, verify a real authenticated root or LocalSystem write/delete, then clean up temporary files.
- plugin-only `activate`: require an existing Netdata installation, update only the Intent AI Ops artifacts/configuration, and preserve pre-existing ownership.
- `deactivate`: remove the plugin, remote key, and managed configuration. Legacy Intent AI Ops helper and sudoers files are also removed. Pre-existing Netdata is preserved.
- `deactivate` with managed removal: uninstall Netdata only if Intent AI Ops originally installed it.
- `reactivate`: repeat activation at any time using system SSH.

While Stage 2 is active, its managed Netdata configuration block binds the Agent API to loopback, including for a pre-existing Netdata installation. Removing Stage 2 removes that block and restores the pre-existing configuration. Intent AI Ops reaches the API only through system SSH and remote `127.0.0.1`; it does not create a local tunnel or expose port 19999.

The native artifacts are selected from the detected OS/architecture before any remote mutation. Their independent version is stored in `plugin/VERSION` and embedded at build time. Linux uses `dist/webminai.plugin`; FreeBSD uses `dist/webminai.plugin-freebsd-amd64` or `dist/webminai.plugin-freebsd-arm64`; macOS uses `dist/webminai.plugin-macos-amd64` or `dist/webminai.plugin-macos-arm64`; Windows uses `dist/webminai.plugin-windows-amd64.exe`. Each distributable build atomically refreshes `dist/SHA256SUMS`, which contains every native plugin artifact currently in `dist/`. Run `npm run check:checksums` to verify the manifest. Each installer verifies the selected artifact's platform and version before reporting activation success.

### Kubernetes gateway plugin

Kubernetes uses a separate static artifact rather than the host-root Linux plugin:

```sh
npm run build:plugin:kubernetes
# dist/webminai.plugin-kubernetes-amd64 or -arm64
```

Run one gateway Netdata Agent and this plugin per cluster with its own ServiceAccount and per-cluster action-key Secret. Activation talks directly to the Kubernetes HTTPS API using embedded kubeconfig TLS material; it never invokes a kubeconfig `exec` or auth-provider plugin and rejects disabled TLS verification. It uploads the static plugin as bounded immutable Secret chunks, verifies and assembles them in an init container, and mounts the result into a single gateway pod. This avoids requiring Docker, Helm, kubectl, an image build, or a registry inside Intent AI Ops.

The plugin reports platform `kubernetes` and execution mode `kubernetes-api`. It cannot execute a shell command, enter a host mount namespace, or read a kubeconfig. An authenticated request can only select `GET`, `POST`, `PUT`, `PATCH`, or `DELETE` and an `/api/...`, `/apis/...`, or `/version` path. The plugin reads the projected ServiceAccount token and CA, calls the in-cluster HTTPS API directly, passes request bodies over stdin, and keeps the bearer token out of process arguments and task history.

Intent AI Ops still signs every request with the cluster's unique action key and applies plan validation and approval locally. Kubernetes RBAC is the remote authorization boundary. The managed gateway can read node metadata cluster-wide and manage Pods, logs, Jobs, Deployments, Services, and ConfigMaps only in `webminai-tasks`; it cannot read Secrets or create DaemonSets. An approved node task can create a pinned, short-lived privileged Job through that API and delete it after collecting the result. Do not give an ordinary Netdata child collector ServiceAccount these permissions, and do not install this gateway artifact in every child collector pod.

The signed command payload is generated by `createKubernetesApiCommand()` and then wrapped by the existing `createSignedCommand()` function. Its internal representation is deliberately narrow:

```text
v=1
method=POST
path=<base64url Kubernetes API path>
contentType=application/json
body=<base64url manifest>
```

The default projected paths are `/var/run/secrets/kubernetes.io/serviceaccount/token`, `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`, and `/var/run/secrets/webminai/action.key`. The action key is generated by Intent AI Ops outside the AI planner and mounted read-only. The gateway is a ClusterIP Service with no Ingress, NodePort, or LoadBalancer. Intent AI Ops reaches it through the authenticated Kubernetes API Service proxy, so port 19999 is never published and a long-running `kubectl port-forward` process is unnecessary.

### FreeBSD support

FreeBSD Stage 2 supports amd64 and arm64 artifacts, the standard `/usr/local/etc/netdata` and `/usr/local/libexec/netdata/plugins.d` package layout, `/opt/netdata` installations, rc.d service control, per-host root keys under `/var/db/webminai`, plugin-only update/rollback, deactivation, and managed Netdata removal. For a managed installation it uses FreeBSD's native `netdata` package, records ownership before restarting the service, and removes that package only when managed removal is explicitly selected. If the repository has no `netdata` package, install the Agent manually and use plugin-only activation. Netdata's FreeBSD support and [installation guide](https://learn.netdata.cloud/docs/netdata-agent/installation/freebsd) are community-maintained.

Build the release artifact on the matching FreeBSD architecture:

```sh
npm run build:plugin:freebsd
```

Copy the resulting artifact into `dist/` on the Intent AI Ops machine. Activation detects `FreeBSD amd64` or `FreeBSD arm64` over SSH and selects it automatically. `npm run check:plugin:freebsd` compiles and runs the FreeBSD code path on the development host as a portability check, but it does not produce a deployable FreeBSD binary.

### macOS support

macOS Stage 2 detects `Darwin` over SSH and uses the signed native plugin with a root-only action key under `/var/db/webminai`. It supports both Intel Homebrew under `/usr/local` and Apple Silicon Homebrew under `/opt/homebrew`, and uses sudo/bootstrap tools instead of systemd or Linux namespace features. Build the artifact on a matching macOS architecture:

```sh
npm run build:plugin:macos
```

Copy `dist/webminai.plugin-macos-arm64` or `dist/webminai.plugin-macos-amd64` to the Intent AI Ops machine. A normal Ubuntu toolchain cannot create this Mach-O/CommonCrypto artifact; release automation should use a matching macOS runner, although Ubuntu may coordinate a build on a trusted Mac and copy the result into `dist/`. If Netdata is absent, activation installs the stable Homebrew formula as the non-root Homebrew owner and records it as Intent AI Ops-managed; managed removal stops and uninstalls that formula. Existing Homebrew Netdata can use plugin-only activation. Stage 2 restarts the LaunchAgent as the Homebrew owner, waits for the API and asynchronous plugin-spawn supervisor, and then installs the plugin for live discovery. This ordering avoids Netdata permanently disabling the plugin when its first launch races the supervisor socket. The SSH account must be able to bootstrap through sudo; its password is transient and is never passed to Codex.

### Windows command plugin

The Windows artifact is command-capable rather than health-only. It implements the same Netdata `webminai:health` and signed `webminai:command` function contract as the Unix plugin. It validates the per-host HMAC key, 60-second timestamp window, unique nonce, request size, command size, and UTF-8 input before starting a command. The key is stored at `C:\ProgramData\WebminAI\action.key` with access restricted to `SYSTEM` and `Administrators`.

Commands run through a fixed, ACL-protected Windows PowerShell runner as the Netdata service identity, normally `LocalSystem`. Command text is sent through local named pipes restricted to `SYSTEM` and `Administrators`; it is never placed on the process command line and no child handles are inherited from Netdata. The process uses a minimal environment, has no profile or interactive UI, and is assigned to a Windows Job Object so timeout or plugin shutdown kills its process tree. Stdout and stderr are returned separately as base64 with a 64 KiB limit for each stream. The plugin does not use `ExecutionPolicy Bypass`; this boundary is authentication and explicit Intent AI Ops approval, not a constrained-command sandbox. A valid signed command is equivalent to Windows system-administrator access.

Commands that explicitly opt into `executionMode: job` use four additional signed functions: `webminai:job_start`, `webminai:job_status`, `webminai:job_cancel`, and `webminai:job_cleanup`. Start returns a random job ID immediately; the controller polls through short bounded Netdata requests. A separate copy of the plugin executable runs in internal worker mode, so the command survives a Netdata restart and an installed-plugin upgrade. Every PowerShell tree remains inside a kill-on-close Windows Job Object. Job identity is persisted as both PID and process creation time to reject PID reuse, while results and cancellation state use atomic replacement files.

Windows job state lives under `C:\ProgramData\WebminAI\jobs` with a protected SYSTEM/Administrators-only ACL. The plugin permits at most four active jobs, 64 retained jobs, 24 hours per job, 32 KiB command text, 64 KiB per output stream, and 256 MiB total retained job storage. Terminal jobs are explicitly cleaned by the controller. Status reconciles worker identity after plugin restart and classifies a vanished worker instead of silently treating it as running. Plugin upgrades preserve active and completed jobs; Stage 2 removal first cancels active workers, then removes job state and finally removes the per-host token.

Build the x64 artifact from an x64 Visual Studio Developer PowerShell:

```powershell
& .\scripts\build-native-plugin-windows.ps1
# dist\webminai.plugin-windows-amd64.exe
```

It can also be cross-compiled from Linux when an x64 MinGW-compatible compiler and `llvm-readobj` are installed:

```sh
CC_WINDOWS=x86_64-w64-mingw32-gcc npm run build:plugin:windows
```

The cross-build verifies that the result is an AMD64 PE and treats compiler warnings as errors. Activation is integrated with the same host flow as Linux and FreeBSD. Intent AI Ops connects through system OpenSSH/SCP, detects an elevated Windows SSH identity, installs the official stable Netdata MSI when needed, discovers the installed plugin directory, deploys `webminai.plugin.exe`, applies SID-based ACLs, and restarts the Netdata service. Readiness requires both `isLocalSystem: true` from plugin health and an authenticated write/delete probe under ProgramData. Plugin-only update, rollback, deactivation, and removal of an Intent AI Ops-managed MSI installation use the persistent `C:\ProgramData\WebminAI\stage2.ps1` compatibility runner. No separate Intent AI Ops service or SSH library is required.

Windows domain accounts can be pasted in the normal Add host prompt. Quote the SSH target so the shell-style parser preserves the domain separator:

```text
ssh 'DOMAIN\user'@windows.example
```

An unquoted `DOMAIN\user@windows.example` target is also accepted. Internally the backslash is percent-encoded in the encrypted connection URL and passed back to the system `ssh` binary as a single username argument. The SSH account must already be a Windows administrator for activation; Intent AI Ops does not configure Windows OpenSSH access or elevate a non-administrator account.

Before every Windows planning turn, Intent AI Ops queries the actual LocalSystem command environment through the signed plugin and adds the PowerShell version plus package-tool availability to `inventory.json`. WinGet CLI plans are rejected because Microsoft does not support WinGet CLI under LocalSystem. Chocolatey is accepted only when detected in that execution environment. The planner targets Windows PowerShell 5.1, rejects `New-Item -LiteralPath`, emits native `C:\...` modified paths, and prefers a publisher-verified machine-wide MSI or offline enterprise installer when no system package manager is available. Direct native calls with PowerShell's `&` operator are also rejected: network operations use PowerShell cmdlets, while installers and uninstallers use `Start-Process -Wait -PassThru` with exit-code and task-owned diagnostic handling. `LOCALAPPDATA` is not assumed to exist for LocalSystem, localized registry Publisher strings are not used as security assertions, and already installed requested software is verified as an idempotent success.

The verified Windows catalog includes separate `brave-windows` and `docker-desktop-windows` tasks. The Brave task uses the official stable GitHub endpoint, exact x64 installer and checksum asset, Authenticode verification, machine-wide installation, ownership recording, and guarded rollback. The Docker task first checks the Windows client build, x64 architecture, memory, SLAT, and firmware virtualization without mutation. It then enables only missing WSL and VirtualMachinePlatform features, downloads the pinned official Microsoft WSL x64 MSI, verifies its GitHub-published SHA-256 digest and Authenticode signature, and installs it unattended without a user distribution. Large WSL and Docker artifacts use task-owned BITS transfers that are polled through short signed Stage 2 requests. Docker Desktop uses Docker's pinned all-users MSI, a pinned SHA-256 and Docker Authenticode signature, verbose Windows Installer logging, the WSL engine, automatic helper service, and disabled Windows-container integration. Readiness still requires a Linux engine plus Compose from the same LocalSystem context used by Stage 2. Moodle uses durable image-build and CLI-install phases. Magento further separates image pull, code preparation, dependency readiness, installation, DI compilation, static/index/cron finalization, and restart verification into independently persisted jobs.

Windows feature changes can require a reboot. The reboot is its own displayed and approved command with a 30-second delay; it is never hidden inside another command. Before scheduling it, Intent AI Ops sets the existing Windows OpenSSH service to automatic and registers a self-removing startup recovery task that starts SSH after boot, preserving the only supported management channel. Rerun the Docker task after reconnection to continue from current observed state. While Docker is absent, the eligible catalog exposes the reviewed Docker/WSL prerequisite and withholds Docker-dependent applications; after Docker is healthy, their Compose tasks become eligible. Firmware virtualization is the first validation and cannot be enabled from Windows or the Netdata plugin. `FIRMWARE_VIRTUALIZATION_DISABLED` stops before every other prerequisite and before mutation, and tells a physical-host user to enable AMD SVM/AMD-V or Intel VT-x in BIOS/UEFI, save, and fully restart; a virtual Windows host must instead expose nested virtualization from its outer hypervisor. Other stable prerequisite signatures include `UNSUPPORTED_WINDOWS_VERSION`, `INSUFFICIENT_MEMORY`, `SLAT_UNAVAILABLE`, `WSL_RUNTIME_UNAVAILABLE`, `REBOOT_REQUIRED`, and `DOCKER_SERVICE_NOT_READY`.

The Brave regression path additionally fixes the official stable release endpoint, exact x64 installer and checksum assets, five-minute large-download/installer deadlines, line-anchored checksum parsing, WOW6432Node discovery, quoted or unquoted `DisplayIcon` parsing with an optional `,0` suffix, Authenticode verification, and ownership across a retry chain. A real Windows Stage 2 host can exercise the complete persisted plan/execute/verify flow:

```sh
VAULT_TEST='vault passphrase' SSH_HOST_PWD='Windows SSH password' \
  npm run test:windows-brave -- install

# Read-only checks
VAULT_TEST='vault passphrase' SSH_HOST_PWD='Windows SSH password' \
  node scripts/validate-windows-brave.js verify
```

The live test defaults to `windows-11`, or accepts `WEBMINAI_TEST_SERVER`. It leaves a successful installation in place and records its plan, progress, results, modified paths, and rollback commands in the normal SQLite task history. Pass a task ID to `revert` only when intentionally testing removal.

Netdata currently distributes a native x64 Windows Agent for Windows 10/11 and Windows Server 2019 or later. Its [Windows installation guide](https://learn.netdata.cloud/docs/netdata-agent/installation/windows/), [service control documentation](https://learn.netdata.cloud/docs/netdata-agent/maintenance/service-control), and [external plugin protocol](https://learn.netdata.cloud/docs/developer-and-contributor-corner/external-plugins) describe the platform baseline, service identity, and plugin interface used here.

## Local LXD test lab

On an Ubuntu development host with the Snap LXD package installed and `lxd init` already completed, the lab script creates nine containers with different distributions:

```sh
scripts/lxd-test-lab.sh matrix
scripts/lxd-test-lab.sh up
```

The default matrix is Ubuntu 24.04, Debian 13, Fedora 44, AlmaLinux 9, Rocky Linux 9, openSUSE 16.0, Arch Linux, Alpine 3.23, and Oracle Linux 9. The script verifies every remote alias before creating a container. Canonical's official `ubuntu:` remote is used for Ubuntu; the other cloud variants come from `images:`.

Each container receives:

- a `webminai` user with key-only SSH and passwordless sudo;
- OpenSSH, curl, CA certificates, and basic networking tools installed through its native package manager;
- a dedicated root-owned sudoers entry;
- a stable host-side SSH proxy on `127.0.0.1:2221` through `127.0.0.1:2229`;
- a marker that prevents cleanup from touching an unrelated instance with a similar name;
- default limits of two CPUs and 768 MiB memory.

The lab's Ed25519 key, dedicated known-hosts file, OpenSSH config, and host list are stored under `~/.webminai/lxd-lab` with restricted permissions. Show current state or regenerate the host commands with:

```sh
scripts/lxd-test-lab.sh status
scripts/lxd-test-lab.sh hosts
```

Add a host from `~/.webminai/lxd-lab/webminai-hosts.tsv` by pasting its command into `Add host` or `Temporarily add host (removed on exit)`. For example:

```text
Host name: webminai-ubuntu-2404
SSH command: ssh -F /home/alice/.webminai/lxd-lab/ssh_config webminai-ubuntu-2404
Authentication: SSH key or ssh-agent
```

Create only selected distributions by appending their matrix IDs:

```sh
scripts/lxd-test-lab.sh up ubuntu-2404 debian-13 alpine-323
scripts/lxd-test-lab.sh stop ubuntu-2404 debian-13 alpine-323
```

The normal script has a confirmed, marker-checked destroy action:

```sh
scripts/lxd-test-lab.sh destroy
```

To remove all nine lab containers as root without an interactive confirmation, use the separate cleanup script. It preserves the local SSH key and generated configuration:

```sh
sudo scripts/lxd-test-lab-remove-all.sh
```

The setup is idempotent: running `up` again starts stopped lab instances, reapplies the SSH/user configuration, and verifies connectivity and passwordless sudo. Image downloads and package installation can take several minutes on the first run.

## Local FreeBSD VM test lab

FreeBSD needs its own kernel, so the FreeBSD lab uses QEMU/KVM and system libvirt instead of LXD. It creates FreeBSD 14.4 and 15.1 amd64 VMs from the official BASIC-CLOUDINIT UFS qcow2 images. Each VM has a deterministic libvirt MAC address, direct SSH through the libvirt NAT address, a key-only `webminai` account with passwordless bootstrap sudo, and an internal `clean` snapshot made after native FreeBSD `nuageinit` and SSH validation. The seed writes `/var/db/webminai-lab-ready` after its package, user, sudo, and SSH work is complete; the readiness probe does not depend on Canonical cloud-init paths.

On Ubuntu, install the host requirements and ensure the default libvirt network exists:

```sh
if apt-cache show virt-install >/dev/null 2>&1; then
  VIRT_INSTALL_PACKAGE=virt-install
else
  VIRT_INSTALL_PACKAGE=virtinst
fi
sudo apt-get install qemu-system-x86 qemu-utils libvirt-daemon-system \
  libvirt-clients "$VIRT_INSTALL_PACKAGE" cloud-image-utils genisoimage \
  xz-utils curl
sudo virsh net-list --all
```

Use the ordinary QEMU and libvirt packages together. On Ubuntu 26.04, the `-hwe` QEMU packages depend on `ubuntu-virt-hwe`, while ordinary `qemu-utils` and libvirt depend on the conflicting `ubuntu-virt` stack. Do not mix those two package families.

Show the matrix and create both VMs:

```sh
scripts/freebsd-vm-lab.sh matrix
sudo scripts/freebsd-vm-lab.sh up
```

If Intent AI Ops itself runs in Docker and that container must reach the VMs through the host's libvirt bridge, opt in to host forwarding during `up`:

```sh
sudo scripts/freebsd-vm-lab.sh up --docker-forwarding
```

This writes `/etc/sysctl.d/99-webminai-freebsd-lab-forward.conf`, enables `net.ipv4.ip_forward`, detects the bridge used by `WEBMINAI_FREEBSD_NETWORK` (normally `virbr0`), and idempotently allows `docker0 → virbr0` plus established return traffic. The `iptables` rules are runtime rules and may need reapplication after a reboot or firewall reload; rerunning `up --docker-forwarding` safely checks before inserting them. The option fails clearly when `docker0`, the libvirt bridge, `iptables`, or `ip` is unavailable. Override the Docker bridge name with `WEBMINAI_FREEBSD_DOCKER_INTERFACE`.

When invoked through `sudo`, generated SSH files belong to the invoking user and default to `~/.webminai/freebsd-vm-lab`. Base images, writable overlays, and cloud-init seeds default to `/var/lib/libvirt/images/webminai-freebsd-lab`. The setup script verifies the official SHA-256 checksums before decompressing an image. The first run downloads roughly 650 MiB per release.

Inspect the VMs or regenerate Intent AI Ops-ready SSH commands:

```sh
sudo scripts/freebsd-vm-lab.sh status
sudo scripts/freebsd-vm-lab.sh hosts
ssh -F ~/.webminai/freebsd-vm-lab/ssh_config webminai-freebsd-14-4
```

Add the commands from `~/.webminai/freebsd-vm-lab/webminai-hosts.tsv` through `Add host` or `Temporarily add host (removed on exit)`. Libvirt normally reuses the DHCP address because the VM MAC addresses are stable; rerun `hosts` if the address changes.

Restore both VMs to their post-provisioning baseline, or operate on only one release:

```sh
sudo scripts/freebsd-vm-lab.sh reset --yes
sudo scripts/freebsd-vm-lab.sh reset 14.4 --yes
sudo scripts/freebsd-vm-lab.sh stop 15.1
sudo scripts/freebsd-vm-lab.sh up 15.1
```

Normal destruction requires confirmation and checks the libvirt domain marker before removing anything:

```sh
sudo scripts/freebsd-vm-lab.sh destroy
```

The dedicated root cleanup removes all marked FreeBSD lab domains, writable overlays, seed images, and their snapshots without prompting. Downloaded base images and local SSH material are preserved so the lab can be recreated quickly:

```sh
sudo scripts/remove-freebsd-vm-lab.sh
```

Cloud metadata runs only on a VM's first boot. After updating the lab's seed configuration, recreate an existing pre-snapshot VM so it consumes the new seed; the downloaded base image is retained:

```sh
sudo scripts/freebsd-vm-lab.sh destroy 14.4 --yes
sudo scripts/freebsd-vm-lab.sh up 14.4
```

Hardware virtualization is required by default. On a host without `/dev/kvm`, set `WEBMINAI_FREEBSD_VIRT_TYPE=qemu` for much slower software emulation. Run `scripts/freebsd-vm-lab.sh help` for resource, path, network, and libvirt connection overrides.

## Local Kubernetes Helm test lab

The Kubernetes lab creates a disposable three-node `kind` cluster and deploys a two-replica nginx workload. The baseline deliberately contains no Netdata or Intent AI Ops plugin: it represents an already-running Kubernetes cluster on which Intent AI Ops must perform the real Stage 2 activation. It requires Docker, kind, kubectl, Helm, and curl:

```sh
scripts/kubernetes-helm-lab.sh bootstrap # Ubuntu 26.04 host, run once
scripts/kubernetes-helm-lab.sh up
scripts/kubernetes-helm-lab.sh status
scripts/kubernetes-helm-lab.sh verify
```

`bootstrap` installs base packages and Docker through Ubuntu APT, configures the maintained Kubernetes and Helm APT repositories, installs `kubectl` and Helm, and installs a checksum-verified kind release binary because kind has no maintained Ubuntu APT package. Run it as the intended lab user; it uses sudo when needed and may require one logout/login after adding that user to the `docker` group. It refuses to modify other Ubuntu releases.

To model a cluster that already had ordinary Netdata monitoring before Intent AI Ops activation, install and verify the official chart separately:

```sh
scripts/kubernetes-helm-lab.sh monitoring-up
scripts/kubernetes-helm-lab.sh monitoring-verify
scripts/kubernetes-helm-lab.sh monitoring-remove
```

`monitoring-remove` preserves the kind cluster and nginx workload. This is also the command to return a previous version of the lab to the clean pre-Stage-2 baseline.

### Accessing the kind lab from a Intent AI Ops container

Generate a cluster-admin kubeconfig that uses kind's internal control-plane address:

```sh
scripts/kubernetes-helm-lab.sh container-kubeconfig
# ~/.webminai/kubernetes-helm-lab/kubeconfig.internal
```

When Intent AI Ops and kind use the same Docker daemon, the preferred lab setup is a managed attachment to the existing `kind` network. Run this on the Docker host; it does not require Docker inside Intent AI Ops and does not recreate either the application container or cluster:

```sh
WEBMINAI_CONTAINER_NAME=busy_wescoff \
  scripts/kubernetes-helm-lab.sh container-network-up
# ~/.webminai/kubernetes-helm-lab/kubeconfig.container
```

The action verifies the container identity and running state, removes an obsolete managed cross-bridge route if present, connects only that container to `kind`, writes a mode-`0600` internal kubeconfig, and verifies TCP access from inside Intent AI Ops. Copy or mount that kubeconfig at `scripts/kubeconfig.container`. Undo the managed attachment with `container-network-down`; guarded cluster destruction also disconnects it.

Run the lab script on the Docker host. When Intent AI Ops is an externally managed container on `172.17.0.0/16` and cannot join the kind network itself, add a narrow, reversible host route for its exact address:

```sh
WEBMINAI_K8S_CLIENT_IP=172.17.0.2 \
  scripts/kubernetes-helm-lab.sh container-route-up
```

The action resolves the current kind control-plane address and both host bridge interfaces, enables only `CLIENT_IP/32 -> CONTROL_PLANE_IP/32` TCP port 6443 in `DOCKER-USER` and interface-specific `FORWARD` rules, and adds an equally exact `POSTROUTING` masquerade so replies reliably cross Docker bridges. It writes `kubeconfig.container` and verifies its TLS credentials. Re-running it is idempotent and repairs missing rules. Copy or mount that kubeconfig read-only into Intent AI Ops and configure its path as the Kubernetes connection credential. `container-route-down` removes every managed filter/NAT rule and the generated kubeconfig. The rules deliberately remain non-persistent because kind addresses change when the cluster is recreated.

The Intent AI Ops container needs neither Docker nor SSH. It needs HTTPS reachability to the Kubernetes API and the read-only kubeconfig; Intent AI Ops uses the Kubernetes API for Stage 2 lifecycle operations, while the installed gateway uses its projected ServiceAccount token. A bind mount requires recreating only the Intent AI Ops container, not the kind cluster. This kubeconfig is a lab cluster-admin credential: keep it outside the repository and never include it in Codex planner input.

Ordinary Netdata monitoring, when installed, retains its normal Kubernetes topology: one parent, one Kubernetes-state collector, and one child collector per node. Stage 2 is separate and adds only one small gateway Netdata Deployment. Intent AI Ops uses the selected kubeconfig itself, reaches the gateway through the Kubernetes Service proxy, and uses its dedicated ServiceAccount for approved API operations. A node-root task can use a short-lived privileged Job pinned to the selected node, then collect its output and delete it. This avoids a persistent Intent AI Ops execution agent on every node while retaining explicit node selection. The AI planner receives sanitized inventory and results, never the kubeconfig or ServiceAccount credentials.

Run the end-to-end Stage 2 and nginx test from the Intent AI Ops container after mounting or copying the routed kubeconfig:

```sh
npm run test:kubernetes-stage2
```

The runner creates a lab-only per-cluster action key in the ignored mode-`0600` file `scripts/.kubernetes-stage2-action-key`, activates the gateway, deploys a custom nginx page in `webminai-tasks`, starts one unprivileged HTTP validation Job pinned to each ready node, checks every result, and reverts the nginx resources. It intentionally leaves Stage 2 active for inspection. Use `node scripts/validate-kubernetes-stage2.js deactivate` to remove both managed namespaces and the cluster-scoped node-reader RBAC. The production CLI integration must store the per-cluster key in the encrypted vault instead of this lab file.

The Kubernetes common-task catalog mirrors every reviewed ismet Compose application while adapting it to namespace-scoped Deployments, Services, persistent claims, and per-node validation Jobs. It does not install Docker in cluster nodes and it never grants the gateway access to Kubernetes Secrets. Application credentials are generated inside task-owned persistent state and are removed with that task. Validate and revert every catalog entry sequentially with:

```sh
npm run test:kubernetes-common-tasks
node scripts/validate-kubernetes-common-tasks.js list
node scripts/validate-kubernetes-common-tasks.js run wordpress-kubernetes
node scripts/validate-kubernetes-common-tasks.js revert wordpress-kubernetes
```

The `all` runner reverts each application before moving to the next one. Each successful application is reached through its ClusterIP Service by an unprivileged Job pinned to every ready node. This is an integration test against the configured cluster, not part of the offline unit suite.

The lab demonstrates that node-control boundary with a fixed, harmless write/read/remove probe on every kind node:

```sh
scripts/kubernetes-helm-lab.sh node-test
```

`node-test` is deliberately powerful: its temporary pods use `privileged`, `hostPID`, and a read-write host root mount, which is equivalent to node root. It runs only against the marker-owned kind context, uses a dedicated ServiceAccount that can manage Jobs in the executor namespace and read node names but cannot create DaemonSets, deletes its Jobs after collecting logs, checks that the host markers are gone, and refuses success if a persistent executor DaemonSet exists. Production support should additionally use an admission policy that admits only Intent AI Ops's pinned executor image and exact Job shape; Kubernetes RBAC alone cannot constrain a permitted Job's pod specification enough to make node-root execution narrow.

To inspect the Netdata parent through a loopback-only port-forward:

```sh
scripts/kubernetes-helm-lab.sh access
# http://127.0.0.1:21999
```

An experimental Helm values overlay can be layered onto the official chart without changing the lab script:

```sh
WEBMINAI_K8S_STAGE2_VALUES=/absolute/path/to/stage2-values.yaml \
  scripts/kubernetes-helm-lab.sh monitoring-up
```

Keep the Kubernetes gateway in a dedicated single-replica deployment and ServiceAccount. The official chart's child collectors are a DaemonSet; injecting the gateway plugin or its RBAC into that shared topology would unnecessarily place the administration boundary on every node.

Reset only the lab namespaces, or delete the guarded kind cluster:

```sh
scripts/kubernetes-helm-lab.sh reset
scripts/kubernetes-helm-lab.sh destroy
```

The script never uses the current kubectl context implicitly; every kubectl and Helm operation names `kind-webminai-k8s`. Netdata is installed from its [official Helm repository](https://learn.netdata.cloud/docs/netdata-agent/installation/kubernetes), which deploys a parent plus per-node child collectors for Kubernetes monitoring.

## Development

The promoted Linux application catalog is exposed through the host menu and structured Codex routing. It contains 13 reviewed builders; candidates without a promoted builder remain on the research/AI path. Run the staged Linux-lab and separate Docker-host promotion checks with:

```bash
npm run test:woocommerce-linux
npm run test:joomla-linux
npm run test:drupal-linux
```

Use `node scripts/validate-woocommerce-linux.js --compose-only` when only the separate automatic-Docker lifecycle needs to be repeated after the nine native distro stages have already passed.
Use `npm run test:drupal-linux -- --compose-only` for the corresponding Drupal-only Compose lifecycle.

### Reusable Linux deployment substrate

Supported Linux application work is split into a reviewed foundation and a small Codex application delta. The cached Linux host context contains typed profiles for nginx, PHP-FPM, MariaDB, PostgreSQL, Node.js, Python, Composer, and Docker Compose. A compatibility specification must resolve an explicit application/runtime/database route before delta planning; an unknown repository version produces `requires-preflight`, not a guessed version.

The reviewed builders own baseline capture, package deltas, host-generated credentials, database readiness/provisioning, service readiness, loopback HTTP health, exact package-version comparison, and rollback. Codex delta planning is restricted to `configure`, `initialize`, and `verify`; deterministic validation rejects package managers, secret generation, database/user creation, and service control in a delta. Failed commands retain a stable failure signature such as `PACKAGE_NOT_FOUND`, `SERVICE_NOT_READY`, or `APP_HTTP_500`, plus only a bounded fixed read-only diagnostic.

Phase results are recorded in `deployment-scorecards.sqlite3` by application, route, distribution family, phase, first-pass outcome, failure code, and duration. The validation scheduler selects one information-value canary, one additional representative per package family, then the remaining fleet. Promotion requires two applies, restart recovery, two reverts, and an exact SHA-256 baseline match.

The destructive integration test uses the nine disposable LXD hosts and the password-backed `ismet` host. It validates every profile package route, installs and fully reverts Docker/Compose on ismet when required, and exercises an isolated nginx fixture on TCP 18120 without changing distribution nginx configuration:

```sh
VAULT_TEST='test vault passphrase' SSH_HOST_1='ismet SSH password' \
  npm run test:linux-substrate
```

The successful 2026-08-08 promotion run passed all nine distributions in canary/package-family/fleet order. It also corrected live profile facts for Alpine PostgreSQL 18, Fedora 44 Node.js 24 and PHP modules, openSUSE Leap 16 Python 3.13 and Composer 2, and Oracle Linux's verified upstream Composer route.

Development requirements are Node.js 24, a C17 compiler, `pkg-config`/`pkgconf`, static OpenSSL development libraries, and `readelf` for Linux builds. Runtime history uses `better-sqlite3`. The optional Windows artifact requires either an x64 Visual Studio C toolchain on Windows or an x64 MinGW-compatible cross-compiler plus `llvm-readobj` on Linux.

```sh
npm install
npm run verify
```

`npm run verify` runs StandardJS, compiles the static Linux and Kubernetes gateway plugins, compiles and runs the FreeBSD backend compatibility target, rejects dynamically linked Linux artifacts, and runs the Node test suite. The tests exercise encrypted storage, vault passphrase rotation, per-host key uniqueness, root-only remote key installation, SQLite progress/results/revert history, terminal editing, path confinement, pasted SSH command parsing, interactive ControlMaster reuse, system SSH arguments, planner JSONL progress and model defaults, FreeBSD planning rules and artifact selection, schema compatibility, Netdata loopback requests, HMAC authentication, replay rejection, Kubernetes API-only execution, Windows authentication/process-tree/source invariants, Windows software-planning regressions, host-root readiness, plugin-only lifecycle orchestration, the ten reversible Linux task plans, command policies, dependencies, and the guarded Kubernetes Helm lab workflow. `npm run verify` does not cross-build or execute the Windows artifact; use `npm run build:plugin:windows`, `npm run test:windows-brave`, and a real Windows host for those platform checks.

The opt-in remote integration runner uses the same system `ssh` transport and never passes credentials to Codex:

```sh
VAULT_TEST='test vault passphrase' SSH_HOST_1='test SSH password' \
  node scripts/validate-remote-tasks.js --migrate-only

VAULT_TEST='test vault passphrase' SSH_HOST_1='test SSH password' \
  node scripts/validate-remote-tasks.js --tasks-only

# Validate one catalog item:
VAULT_TEST='test vault passphrase' SSH_HOST_1='test SSH password' \
  node scripts/validate-remote-tasks.js --tasks-only --task=nginx-static-site

# Confirm all fixed catalog artifacts are absent and dpkg is clean:
VAULT_TEST='test vault passphrase' SSH_HOST_1='test SSH password' \
  node scripts/validate-remote-tasks.js --clean-check

# Exercise the real Codex schema/progress path with read-only commands:
VAULT_TEST='test vault passphrase' SSH_HOST_1='test SSH password' \
  node scripts/validate-remote-tasks.js --planner-smoke

# Retry a saved read-only failure with its complete retry chain:
VAULT_TEST='test vault passphrase' SSH_HOST_1='test SSH password' \
  node scripts/validate-remote-tasks.js --retry-smoke=TASK_ID
```

The runner uses `SSH_ASKPASS` only to authenticate the system SSH ControlMaster, decrypts the local test vault with `VAULT_TEST`, records every test task in that host's SQLite history, and stops on the first failed apply, revert, verification, or fingerprint comparison. Use disposable test credentials; shell environments and CI logs require the same care as other secrets.

## Minimal application usage

```js
import { AdminService, rootExecutionPolicy } from 'intent-ai-ops'

const admin = new AdminService({ dataRoot: '/var/lib/webminai' })
const settings = await admin.settings.initialize()
const passphrase = await readPassphraseFromTty()

await admin.addServer({
  settings,
  passphrase,
  serverId: 'edge-1',
  connectionUrl: 'ssh://admin@edge-1.example?identity=/keys/edge-1',
  policy: rootExecutionPolicy({
    maxCommands: 10,
    deniedPatterns: ['rm\\s+-rf']
  })
})

await admin.activate({ settings, passphrase, serverId: 'edge-1' })
const plan = await admin.plan({
  settings,
  passphrase,
  serverId: 'edge-1',
  request: 'Explain current CPU pressure and propose safe diagnostics'
})
```

`readPassphraseFromTty()` represents the application's UI or secret-input mechanism; passphrases should not be persisted.
