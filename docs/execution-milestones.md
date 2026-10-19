# Execution reliability milestones

The AI proposes, the operator governs, and Intent AI Ops validates and executes authorized work. These milestones reuse TaskStore, AdminService, MultiHostService, Codex planning, platform policies, signed Netdata execution, and system OpenSSH. No new remote agent, React, Electron, or runtime dependency was added.

## 1. Durable journal and recovery

Per-host databases gain additive `execution_events` and `execution_leases` tables. Append-only events correlate host, group run, task, SHA-256 plan revision, command, UUID attempt, timestamp, and schema version 1. Existing DELETE journaling and synchronous FULL remain unchanged. A 30-second execution lease renews every 10 seconds; journal writes check ownership and the approved fingerprint.

Intent is committed before dispatch. Observed success, failure, acknowledgment, and unknown outcomes are recorded afterward. A pre-dispatch journal failure prevents dispatch. Recovery skips confirmed commands, even if the process crashed before updating the task-result projection. Interrupted tasks are highlighted in the dashboard. Legacy histories remain readable but ambiguous execution without a journal cannot be resumed automatically.

History retries share execution ownership across their linked task family. An
uncertain ancestor, including interrupted legacy execution without journal
evidence, requires reconciliation before a retry can dispatch. Lease acquisition
checks the family in the same SQLite transaction; unrelated tasks remain
independent. The additive `tasks_retry_parent` index preserves existing history.
Inspection rejects cycles, chains reaching 100 tasks, and families exceeding
1,000 tasks rather than assuming their execution state is safe.

Linux system fixtures reject symlinked targets before capturing a baseline.
Rollback requires their captured task-state directory and rejects symlinked
state. This prevents cleanup after a failed preflight from deleting existing
units, logs, runtime files or swap entries.
Previously saved plans remain immutable and do not acquire these new guards.

Native Mattermost and Odoo require an absent PostgreSQL role and database before
exclusive creation. A private task marker binds subsequent use and cleanup to
the cluster system identifier and role/database/owner OIDs. Existing namespaces,
denied inspection, changed identifiers and missing ownership fail closed. SQL
passwords travel over standard input, not process arguments. Partial creation or
partial cleanup retains uncertain ownership for operator review, not automatic
retry. Missing file baselines also block removal of occupied application paths.
Mattermost rejects a pre-existing service account before baseline capture.
Native Ghost now uses the same guarded namespace creation and removal as the PHP
applications, with its MySQL client and distinct account preserved. It refuses
foreign namespaces, missing ownership and symlinked state rather than resetting
passwords or dropping an unowned database. Its native file cleanup also requires
a valid baseline; dangling application paths are rejected before capture. These
guards do not make MariaDB a supported Ghost database or authorize migration.
These guards do not rewrite older approved plans. AlmaLinux Mattermost passed a
live creation, identity check and reviewed cleanup. Other PostgreSQL routes remain
live-unverified; shell fixtures cover refusal, reuse, identity changes and cleanup.
Package-manager and created-cluster removal failures retain recovery state rather
than reporting successful restoration. A failed cleanup still needs review.

Planner references explicitly include the existing direct-command and durable-job
timeout limits, including their defaults. This does not increase execution policy.
Executable commands containing redacted checksum, SSH URL or private-key markers
are rejected, including rollback commands. Ordinary log-redaction filters remain
valid. Redacted history is not a source of replacement secrets or artifact hashes.

New POSIX CLI-install plans preserve occupied launchers and dangling installation
roots before claiming ownership; rollback rejects symlinked ownership state.
Completed task-owned installs can be verified
again without reinstalling. The default upstream archive is staged with bounded
curl retries, a 128 MiB cap and the published SHA256 before npm receives its local
path. Checksum failures stop installation. Custom local package sources retain
their existing behavior. These are download retries, not replay of an interrupted
remote command; recovery and revised plans still require operator review.
The installer uses a task-private npm cache and a child-only 5-second Node address
family connection window, preserving inherited Node options. This recovered a
reproduced openSUSE registry timeout without changing host IPv6 configuration.

Existing Stage 2 signed jobStatus retrieval provides durable remote evidence when the returned job ID was recorded. Journaled jobs retain remote results. Direct commands have no durable retrieval ID; losing the job-start acknowledgment also remains ambiguous because the plugin assigns the ID. Unknown outcomes never authorize retries. Operators can retrieve remote outcomes or attest completed/failed status using independent authoritative evidence. Attestation stores a sanitized evidence fingerprint, not raw credentials or a permission to rerun.

The POSIX native collector now emits status keepalives while idle or waiting for
a direct command, preventing Netdata's idle-reader timeout. Keepalives cannot
interrupt a JSON response frame. Existing hosts need the rebuilt native artifact
installed through plugin-only update; the installer compares binary contents,
not just the unchanged protocol/release version. Linux and Kubernetes builds and
a FreeBSD compatibility compile are checked locally; other native release builds
and the unchanged Windows collector are not covered by those checks.

Rollback has its own fingerprint and journaled attempts, under the same task lease. Completed rollback commands are skipped. Unknown rollback outcomes block further changes. Deployment continuation is rejected after rollback starts. Partial forward execution requires a separately reviewed rollback proposal because the current rollback schema does not identify forward-command mappings.

Explicit rollback proposals use the existing no-further-rollback validation mode
through both the planner and administrative service. Normal changing plans still
require revert commands. Proposal generation does not approve or execute cleanup;
revision review, fingerprints, leases and uncertain-outcome guards still apply.

AI output cannot choose internal rollback mode. The controller derives that mode
from the operator's action. Under the execution lease, reviewed rollback revisions
also reject reused deployment command IDs, including older stored proposals.

Security: journal metadata excludes raw command output and credentials. Local journaling does not guarantee exactly-once remote execution. Retained remote jobs eventually require operator cleanup using the existing signed cleanup operation. Standalone callers without a task ID retain the existing execution API.

SSH execution recovery now attempts reconnection at most three times with 1-second and 2-second delays. Each master connection attempt has a 30-second timeout; host-key/authentication rejection stops retries immediately. It never replays the interrupted request. Known jobs resume status retrieval only, with a two-minute status-recovery window and the existing bounded polling count. Recovery progress is journaled and shown in the CLI/console. Recovered results retain their remote evidence and pause remaining commands for explicit approval. Multi-host recovery also pauses the automatic scheduler. Unknown outcomes remain blocked pending reconciliation.

## 2. Repair-loop protection

`operation-loop-detector.js` reuses failure signatures and chronological retry history. SHA-256 fingerprints cover normalized, redacted commands and failure/diagnostic evidence. Repeated failures, unchanged diagnostic states, alternating repairs, and excessive unsuccessful attempts stop ordinary retries. New evidence and confirmed progress prevent identical-state warnings. Successful bounded retries are not repair loops.

AdminService planning, CLI retries, and multi-host retries require alternative operator instructions when a loop is detected. Plans still need ordinary validation and explicit approval. Optional settings.json `operationLoop` accepts repeatedFailures (default 3, minimum 3) and maxAttempts (default 8, at least repeatedFailures). Progress uses completed-command counts and changed diagnostics, not an invented service-health score. No autonomous repair loop was added.

Structured job/attempt IDs, process IDs and observation timing are excluded from
repair fingerprints. New identifiers alone are not progress. Original evidence
stays unchanged; different error text and diagnostic results still count as new
information. Raw log timestamps are not generically stripped.

## 3. Interactive intervention

Per-host databases also gain `task_controls` and `plan_revisions`. Controls use compare-and-swap versions. Revision plans, parent relationships, and source state versions are immutable; proposed revisions can only transition to approved. Original approved plans remain recorded.

Optional CLI boundary controls offer continue/pause/abort. Task history offers inspection, read-only questions, remote reconciliation, outcome attestation, remaining-step revision, differences, reviewed continuation, and rollback. A pause never kills an in-flight command.

The final pre-dispatch control recheck is silent. Interactive users see one prompt per command attempt, while pauses recorded during approval or evidence collection still prevent dispatch.

AI plans can select the existing signed durable job transport with `executionMode: "job"`. Normal commands use null in AI output, normalized to the existing omitted field before validation and approval. Normal deadlines remain at most five minutes; explicit jobs use the configured job limit (one hour by default). Approval views label durable jobs. Long acquisition must not be detached through an untracked launcher.

Health and update reports reload completed results after operator intervention, rather than using the paused caller's partial results. Empty, failed or uncertain execution cannot produce a completion report. The planner receives bounded, redacted diagnostic supplements alongside its capability index. Secret prompts disable terminal echo before displaying the prompt, including hidden kubeconfig input.

Planner routing, consultation and revisions share an environment allowlist and embedded sanitized references (2 MiB combined limit). Codex runs without its daemon; shell, browser, connectors, hooks, plugins and delegation are disabled. A bounded configuration read identifies inherited MCP servers and disables each with a transport-compatible placeholder. Unverifiable configuration blocks planning. A local mock-provider test checks the installed CLI's actual tools with both default and MiMo profiles, including inherited stdio/HTTP servers; it uses only synthetic authentication and no real host. Provider authentication remains local, with environment API keys limited to names ending in `_API_KEY`. Trusted operator-owned Codex configuration must remain stable during a request. Some profiles retain a non-executing interactive-question tool; no execution or connector tools were advertised in the checked configuration.

Multi-host routing reuses the same eligible common tasks as single-host routing, including health and supported update tasks. Completed health/update tasks retain sanitized assessments per host; report failures do not rewrite execution outcomes. One-way updates use the existing explicitly reviewed exception to rollback requirements. Rollout progress identifies the run, stage and pending count. Linux health withholds unfiltered traditional logs when journal access is unavailable and uses a command-name-only BusyBox process fallback; missing evidence remains unavailable rather than triggering repairs.

Linux catalog baselines reject existing or dangling owned paths before changes. Jellyfin guards existing accounts, executables and ports explicitly; portable rollback preserves unrelated default-package data and services. openSUSE uses the existing profile's `vhosts.d` layout and refuses leftover `conf.d` fixtures rather than overwriting them. Shell fixtures cover these guards; the lab checkpoint distinguishes live command completion from clean lifecycle coverage.

New native WordPress and shared PHP plans refuse existing database/user namespaces instead of adopting them or resetting passwords. Successful exclusive creation records a task-local ownership marker. Rollback requires that marker and drops only the configured local user, not both host variants. Partial SQL failure or a lost acknowledgment before marker persistence requires operator review; it does not authorize automatic cleanup. Existing saved plans remain unchanged and need separate review. Ownership markers do not identify an externally replaced database with the same name.

Native WordPress/shared PHP restoration now stops on failed package removal or a failed restart of a previously active service, retaining task recovery state instead of returning false success and deleting the baseline. Shell regressions cover all six application callers. Existing saved plans retain their original behavior; optional service stops and separate Compose cleanup paths remain outside this fix.

New native PHP file cleanup requires its task-state directory. If that state is
gone, existing owned-path names are preserved and cleanup requests operator
review; already-absent paths remain a no-op. Shell fixtures cover all six callers,
Moodle's separate data root and preservation of shared nginx configuration.
This does not identify resources externally replaced while task state survives.

Native WordPress also refuses dangling owned paths and uses Debian's no-upgrade
package option. Native Moodle refuses an existing or dangling off-web data root
and both cron units before recording its baseline. Late cron creation also
refuses dangling links. New systemd cron cleanup requires recorded ownership,
stops the installer and cron service before removal, and reports service/removal
errors instead of masking them. OpenRC cleanup refuses a still-live installer PID
because a PID file alone cannot exclude PID reuse; it sends no termination signal
and requests inspection instead. Unowned periodic files and cleanup errors also
stop rollback. Automatic cancellation of that live installer remains unsupported.
These guards protect new plans; saved histories
are unchanged. No-upgrade is not proof that every dependency version is restored.

Alpine shared PHP plans validate nginx through the installed OpenRC
`checkconfig` action. Its vendor startup preparation creates the PID directory
before testing configuration, unlike a premature raw `nginx -t`. A live Moodle
failure exposed this ordering; fixtures cover all four shared PHP callers and
prevent service restart when validation fails. Existing saved plans need a
separately reviewed remaining-work revision.

AI plan schemas now carry the existing bounded retry policy, including nullable
no-retry/state restrictions. Planner normalization preserves the validated policy;
the executor still retries only confirmed declared failure results, never an
uncertain dispatch. Operators must review the policy with the command. A live
Moodle repeat proposal exposed the missing schema field and was rejected before
execution; fixtures cover preservation, null handling and invalid retry limits.

Replanning collects fresh inventory through the existing planner and supplies sanitized request/execution/revision evidence. Completed definitions remain unchanged; replacement work receives new IDs. Existing plan and platform policies validate the replacement. Operators see original/proposed plans and added/removed/changed IDs. Approval binds to the proposed fingerprint and source state. Approved replacements start paused and require separately reviewed resume, not inherited approval.

Failed commands may have changed host state. Reviewed rollback proposals must use confirmed evidence. External modifications and actual filesystem state still require operator inspection; replay is not host-state restoration.

The CLI can reopen pending proposals without another AI request. Inspection adds
canonical per-revision fingerprints and differences to its version1 response,
while plan contents remain sanitized. Approval still checks current state and the
stored proposal fingerprint; it executes nothing and leaves continuation paused.

## 4. Shared controller and staged rollout

`OperatorController` serves CLI intervention and browser actions: snapshot, inspection, ordered events, pause, analysis, revisions, reconciliation, continuation, rollback, replay, and export. Stale decisions fail version checks. AdminService remains the only task executor.

MultiHostService retains host-specific planning/compatibility gates. `buildRolloutStages` adds selected-canary and configurable batches without changing the validation-lab scheduler. Concurrency stays bounded. Failure threshold defaults to 1. Later stages require explicit health-verification success, either manual CLI confirmation or the existing external verifier. A non-success verifier cannot release the next stage.

The run store gains additive `run_controls`, so pausing during planning also protects queued hosts. Active hosts stop at their next boundary. Hosts keep independent tasks/outcomes/revisions/rollback evidence. Selected continuation is individually approved and sequential; completed hosts are skipped. Retry runs reject completed targets. Explicit selected continuation does not silently release the paused automatic scheduler.

## 5. Authenticated read-only console

Launch `intentaiops console`, unlock locally, and open the printed URL. Binding is only 127.0.0.1, on an allocated port. A random launch token becomes an HttpOnly SameSite=Strict cookie; the browser removes the URL fragment. Treat that URL as a credential.

The dependency-free browser shows hosts, configured Kubernetes cluster identifiers, task queues/results, runs, pending counts, stages, planning activity, failures, revisions, rollback availability, and an event timeline. Read-only mode does not probe hosts. The existing separate Kubernetes gateway remains unchanged, not a new Kubernetes rollout path.

The additive operator-events.sqlite3 database uses WAL, synchronous FULL, and mode 0600. Orchestration/intervention events are persisted; task journals are mirrored incrementally with durable cursors. Authenticated SSE supports monotonic reconnectable IDs, bounded subscriptions, and backpressure handling without repeatedly fetching complete history.

Catch-up reads one bounded page per host, then commits mirrored events and its cursor in one transaction. Concurrent console sessions cannot rewind the cursor. Failed imports roll back the page without losing the original journal evidence.

## 6. Reviewed operator actions

Enable explicitly with `intentaiops console --console-actions`. Exact Host/Origin checks, same-site checks, a separate CSRF token, self-only script policy, and 32 KiB request bounds protect the API. Read-only mode rejects every action. No generic shell, arbitrary code, skill, or remote-command endpoint exists.

Actions include run/host pause, abort, analysis, forward/rollback proposals, approval, remote reconciliation, outcome attestation, selected continuation, and reviewed rollback. Suggestions do not execute automatically. Rollback has separate display and execution-confirmation steps. SSH authentication remains in the terminal. Existing validation, signed execution, identity checks, and leases remain authoritative.

An operator rollback also updates its linked multi-host outcome and aggregate run status, without changing other hosts or historical execution events.

## 7. Replay and diagnostics

Replay reads chronological recorded command and operator/orchestration events only. It never contacts hosts or restores state. Exports are version 1 JSON with replayOnly:true and a 2 MiB limit. Oversized exports fail rather than silently truncate.

Public views omit duplicate encoded database projections and withhold raw stdout/stderr, including diagnostic output. Credential-named fields, keys, authentication values, SSH URLs, and the vault passphrase are redacted. Vault contents are never serialized. Original results remain local task history. Do not put secrets into operator instructions or attestations.

HTTP error responses use the same vault-aware controller sanitizer as task and event views, including errors without a credential label.

## Version 1 local HTTP interface

All non-static endpoints except login require the session cookie. Actions additionally require enabled actions mode and X-Intent-CSRF.

| Endpoint | Purpose |
| --- | --- |
| POST /session | Launch-token login and CSRF token |
| GET /snapshot | Hosts, configured clusters, runs and rollout state |
| GET /task?host=ID&task=ID | Queue/results/revisions, rollback state, fingerprints, stateVersion |
| GET /events | SSE with Last-Event-ID or after cursor |
| GET /export?run=ID | Sanitized replay/diagnostic bundle |
| POST /action | Whitelisted controller action, never a command string |

Task decisions identify hostId, taskId, expectedVersion. Approval/execution also bind fingerprints and require approved:true. Revision approval identifies revisionId. Selected-run continuation supplies individually reviewed host decisions. Execution is acknowledged asynchronously; errors appear as operator_action_failed events. JSDoc types are in src/operator-api-contracts.js. Typecheck checks contract declarations, not every JavaScript implementation.

## Validation

Local automated tests cover pre-dispatch failure, unknown dispatch, durable job reconciliation, completed-step skipping, immutable completed revisions, competing ownership/approval, abort/revision approval, rollback skipping, safe boundary pause, queued-run pause, canary failure, alternating loops, successful bounded retries, authentication/Origin/CSRF/read-only enforcement, forbidden command endpoints, SSE reconnect, redaction, and remote-free replay.

Executed locally: npm test, npm run lint, npm run typecheck, npm run test:package-install. The tarball and SHA-256 sidecar are rebuilt. Packaging verifies console assets and installed CLI/SQLite operation. Native plugin behavior is unchanged; generated native test rebuilds are not retained.

Linux live validation now includes all four real process-crash boundaries, retained-job/master recovery, common-task pause/revision/rollback, actual failed-probe loop protection, canary failure and success gates, selected continuation, writable-console authorization, and authenticated SSE/replay against real history. See [the lab checkpoint](linux-lab-validation-status.md) for per-host status and exact run results. The complete application catalog matrix is not yet finished.

The following environment-dependent checks remain distinct from those completed Linux scenarios:

1. Exercise Linux, FreeBSD, Windows, and macOS direct/job execution, identity checks, and rollback on disposable or explicitly selected SSH hosts.
2. Kill the CLI before dispatch, during execution, and after remote completion; disconnect SSH and reconcile retained job results. Verify uncertain non-idempotent changes are never repeated.
3. Pause long-running jobs, verify they continue, and revise only remaining work after host inspection.
4. Test canary/batch health failures, queued/run pauses, and independent reviewed continuation across real hosts.
5. Run the existing opt-in Kubernetes gateway regressions. No production host is selected implicitly.
