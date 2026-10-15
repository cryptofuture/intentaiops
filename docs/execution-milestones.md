# Execution reliability milestones

The AI proposes, the operator governs, and Intent AI Ops validates and executes authorized work. These milestones reuse TaskStore, AdminService, MultiHostService, Codex planning, platform policies, signed Netdata execution, and system OpenSSH. No new remote agent, React, Electron, or runtime dependency was added.

## 1. Durable journal and recovery

Per-host databases gain additive `execution_events` and `execution_leases` tables. Append-only events correlate host, group run, task, SHA-256 plan revision, command, UUID attempt, timestamp, and schema version 1. Existing DELETE journaling and synchronous FULL remain unchanged. A 30-second execution lease renews every 10 seconds; journal writes check ownership and the approved fingerprint.

Intent is committed before dispatch. Observed success, failure, acknowledgment, and unknown outcomes are recorded afterward. A pre-dispatch journal failure prevents dispatch. Recovery skips confirmed commands, even if the process crashed before updating the task-result projection. Interrupted tasks are highlighted in the dashboard. Legacy histories remain readable but ambiguous execution without a journal cannot be resumed automatically.

Existing Stage 2 signed jobStatus retrieval provides durable remote evidence when the returned job ID was recorded. Journaled jobs retain remote results. Direct commands have no durable retrieval ID; losing the job-start acknowledgment also remains ambiguous because the plugin assigns the ID. Unknown outcomes never authorize retries. Operators can retrieve remote outcomes or attest completed/failed status using independent authoritative evidence. Attestation stores a sanitized evidence fingerprint, not raw credentials or a permission to rerun.

Rollback has its own fingerprint and journaled attempts, under the same task lease. Completed rollback commands are skipped. Unknown rollback outcomes block further changes. Deployment continuation is rejected after rollback starts. Partial forward execution requires a separately reviewed rollback proposal because the current rollback schema does not identify forward-command mappings.

Security: journal metadata excludes raw command output and credentials. Local journaling does not guarantee exactly-once remote execution. Retained remote jobs eventually require operator cleanup using the existing signed cleanup operation. Standalone callers without a task ID retain the existing execution API.

SSH execution recovery now attempts reconnection at most three times with 1-second and 2-second delays. Each master connection attempt has a 30-second timeout; host-key/authentication rejection stops retries immediately. It never replays the interrupted request. Known jobs resume status retrieval only, with a two-minute status-recovery window and the existing bounded polling count. Recovery progress is journaled and shown in the CLI/console. Recovered results retain their remote evidence and pause remaining commands for explicit approval. Multi-host recovery also pauses the automatic scheduler. Unknown outcomes remain blocked pending reconciliation.

## 2. Repair-loop protection

`operation-loop-detector.js` reuses failure signatures and chronological retry history. SHA-256 fingerprints cover normalized, redacted commands and failure/diagnostic evidence. Repeated failures, unchanged diagnostic states, alternating repairs, and excessive unsuccessful attempts stop ordinary retries. New evidence and confirmed progress prevent identical-state warnings. Successful bounded retries are not repair loops.

AdminService planning, CLI retries, and multi-host retries require alternative operator instructions when a loop is detected. Plans still need ordinary validation and explicit approval. Optional settings.json `operationLoop` accepts repeatedFailures (default 3, minimum 3) and maxAttempts (default 8, at least repeatedFailures). Progress uses completed-command counts and changed diagnostics, not an invented service-health score. No autonomous repair loop was added.

## 3. Interactive intervention

Per-host databases also gain `task_controls` and `plan_revisions`. Controls use compare-and-swap versions. Revision plans, parent relationships, and source state versions are immutable; proposed revisions can only transition to approved. Original approved plans remain recorded.

Optional CLI boundary controls offer continue/pause/abort. Task history offers inspection, read-only questions, remote reconciliation, outcome attestation, remaining-step revision, differences, reviewed continuation, and rollback. A pause never kills an in-flight command.

Replanning collects fresh inventory through the existing planner and supplies sanitized request/execution/revision evidence. Completed definitions remain unchanged; replacement work receives new IDs. Existing plan and platform policies validate the replacement. Operators see original/proposed plans and added/removed/changed IDs. Approval binds to the proposed fingerprint and source state. Approved replacements start paused and require separately reviewed resume, not inherited approval.

Failed commands may have changed host state. Reviewed rollback proposals must use confirmed evidence. External modifications and actual filesystem state still require operator inspection; replay is not host-state restoration.

## 4. Shared controller and staged rollout

`OperatorController` serves CLI intervention and browser actions: snapshot, inspection, ordered events, pause, analysis, revisions, reconciliation, continuation, rollback, replay, and export. Stale decisions fail version checks. AdminService remains the only task executor.

MultiHostService retains host-specific planning/compatibility gates. `buildRolloutStages` adds selected-canary and configurable batches without changing the validation-lab scheduler. Concurrency stays bounded. Failure threshold defaults to 1. Later stages require explicit health-verification success, either manual CLI confirmation or the existing external verifier. A non-success verifier cannot release the next stage.

The run store gains additive `run_controls`, so pausing during planning also protects queued hosts. Active hosts stop at their next boundary. Hosts keep independent tasks/outcomes/revisions/rollback evidence. Selected continuation is individually approved and sequential; completed hosts are skipped. Retry runs reject completed targets. Explicit selected continuation does not silently release the paused automatic scheduler.

## 5. Authenticated read-only console

Launch `intentaiops console`, unlock locally, and open the printed URL. Binding is only 127.0.0.1, on an allocated port. A random launch token becomes an HttpOnly SameSite=Strict cookie; the browser removes the URL fragment. Treat that URL as a credential.

The dependency-free browser shows hosts, configured Kubernetes cluster identifiers, task queues/results, runs, pending counts, stages, planning activity, failures, revisions, rollback availability, and an event timeline. Read-only mode does not probe hosts. The existing separate Kubernetes gateway remains unchanged, not a new Kubernetes rollout path.

The additive operator-events.sqlite3 database uses WAL, synchronous FULL, and mode 0600. Orchestration/intervention events are persisted; task journals are mirrored incrementally with durable cursors. Authenticated SSE supports monotonic reconnectable IDs, bounded subscriptions, and backpressure handling without repeatedly fetching complete history.

## 6. Reviewed operator actions

Enable explicitly with `intentaiops console --console-actions`. Exact Host/Origin checks, same-site checks, a separate CSRF token, self-only script policy, and 32 KiB request bounds protect the API. Read-only mode rejects every action. No generic shell, arbitrary code, skill, or remote-command endpoint exists.

Actions include run/host pause, abort, analysis, forward/rollback proposals, approval, remote reconciliation, outcome attestation, selected continuation, and reviewed rollback. Suggestions do not execute automatically. Rollback has separate display and execution-confirmation steps. SSH authentication remains in the terminal. Existing validation, signed execution, identity checks, and leases remain authoritative.

## 7. Replay and diagnostics

Replay reads chronological recorded command and operator/orchestration events only. It never contacts hosts or restores state. Exports are version 1 JSON with replayOnly:true and a 2 MiB limit. Oversized exports fail rather than silently truncate.

Public views omit duplicate encoded database projections and withhold raw stdout/stderr, including diagnostic output. Credential-named fields, keys, authentication values, SSH URLs, and the vault passphrase are redacted. Vault contents are never serialized. Original results remain local task history. Do not put secrets into operator instructions or attestations.

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
