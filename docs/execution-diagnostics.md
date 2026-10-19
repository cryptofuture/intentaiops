# Execution diagnostics

## Implementation audit

The native Unix and Windows plugins already record durable job IDs, exit status,
timeouts and cancellation. Unix results also carry signals. `NetdataClient`
preserves orphaned jobs as unknown. `executeApprovedPlan` owns attempt IDs and
write-ahead events; `AdminService.reconcileTask` retrieves recorded results.
The SQLite journal, operator controller, SSE and export already carry event
metadata. No destructive database migration or binary result-file change is needed.

Missing evidence: pre-dispatch boot/resource snapshots, scoped memory-counter
deltas, structured runtime/workload observations and a consistent explanation.
Kubernetes uses a separate API-only client, not the host command executor. Its
gateway has task-namespace reads but no existing events permission. Diagnostics
must not broaden that permission or inspect Secrets.

Implementation follows these boundaries: shared additive observations; fixed
signed host collectors; existing API-only Kubernetes reads; shared operator
summaries. Diagnoses never authorize execution, resolve an uncertain outcome or
change approval/retry rules. Unavailable evidence remains explicit.

## Contracts and collection

Observation version 1 contains a stable reason code, confidence, scope, source,
observation timestamp, allowlisted evidence, explanation and safe next action.
The journal event supplies host/run/task/revision/command/attempt identity; job
acknowledgments supply the remote job ID. No new SQLite tables or migrations.

`command_prepared.metadata.evidenceBefore` is saved before dispatch. Terminal
events contain `evidenceAfter` and `diagnostics`. Reconciliation reads the
baseline for the exact attempt and rollback revision and appends observations
through existing `execution_recovery` events without changing unknown outcomes.
Missing acknowledgments can still be inspected, but cannot be resolved by a
host snapshot. Original observations remain immutable.

Structured Netdata HTTP failures carry `NETDATA_API_ERROR` and the HTTP status,
not a presumed remote process result. Only a bounded JSON status from a completed
curl HTTP failure is accepted. A request URL's `timeout` parameter is not evidence
that execution timed out. Transport errors never authorize command replay.

Explicit ENOENT or “No such file or directory” on a failed command yields
`PATH_NOT_FOUND`. This reports missing-path evidence without exposing raw paths
or claiming whether earlier changes completed. Successful warnings stay quiet.

`TARGET_CONFLICT` reports an explicit target-preservation refusal without exposing
the raw path. Existing data requires inspection, not automatic deletion or retry.

`OWNERSHIP_UNCONFIRMED` reports an explicit application, database or cron ownership
guard refusal without exposing private paths or raw output. It requests inspection,
never adoption, retry or deletion of resources whose ownership is unclear.

Host collectors run fixed, signed, read-only commands with five-second remote
limits and an 8 KiB accepted snapshot limit. Platform discovery uses the existing
health endpoint without its normal retry loop. After an unrecovered transport
error, execution records unavailable evidence rather than opening another
diagnostic connection; later reconciliation can collect fresh evidence.
Failed collectors cannot prevent execution. No new agents or binary protocol
changes are required. Existing signed plugin versions remain usable.

## Platform coverage

Explicit apt/dpkg lock-owner errors produce `PACKAGE_MANAGER_BUSY`, separate from
permission denial and unknown causes. Wait for the existing package manager; do
not remove lock files or kill its process. Native Debian/Ubuntu Jellyfin installs
wait up to 120 seconds for the dpkg lock. This neither retries a dispatched task
nor changes approval or uncertain-outcome recovery rules. Other package managers
and translated lock messages are not covered by this classifier.

| Target | Evidence collected or preserved |
| --- | --- |
| All hosts | Remote timeout/cancellation, exit status/signal, controller disappearance, explicit storage/quota/permission/allocation errors, existing application failure categories and bounded transport error-chain classification |
| Linux | Boot UUID, cgroup v2 OOM-kill counter and limit, cgroup identity digest, cgroup v1 allocation-failure context, available memory/swap, root filesystem capacity/inodes |
| FreeBSD | Boot time, root filesystem capacity/inodes, native process results and existing reviewed service diagnostics |
| macOS | Boot-session UUID where available, boot-time fallback, root filesystem capacity/inodes, native process results and existing reviewed service diagnostics |
| Windows | CIM boot time, free physical memory/system-drive capacity, latest resource-exhaustion/application-crash Event Log record IDs where readable, original native status interpreted without losing its unsigned representation |
| Docker | Exact-container OOM/exit/health state; automatic bounded inspection for existing reviewed Compose project diagnostics |
| Podman | Explicit exact-container OOM/exit inspection through `NetdataClient.collectContainerEvidence`, without deriving targets from AI command text |
| Kubernetes | Scoped Pod/Deployment/Job reads; current/previous container termination, OOMKilled, restart count/backoff, image/start/scheduling/readiness/eviction/disruption state, rollout/Job deadlines, API authentication/authorization/conflict/throttling/availability |

OOM counter increases are **suspected**, never proof that the task's process was
killed. Comparisons require matching platform, boot and cgroup identity, ordered
observation times and a window no longer than 24 hours. Counter resets, historical
counts, unrelated scopes and exit 137 alone do not establish OOM. The collector
walks accessible cgroup v2 ancestors up to the mount root to find the effective
memory limit, retaining at most sixteen scope counters plus the limiting scope.
Shared ancestor counters can include other processes, so they never establish
the task's exact victim. Native allocation
errors establish a reported allocation failure, not a kernel OOM kill.

Unique boot-session changes confirm a reboot. Boot-time-only changes are
suspected because clock adjustments cannot be excluded. Neither establishes the
command's completion. Low memory, full filesystems and restart counts are context,
not proof of why an unrelated command stopped.

Kubernetes clients remember up to 64 task-namespace resource references returned
by successful writes and inspect subsequent reads against their UID/generation.
Explicit `collectWorkloadEvidence` accepts only single Pod/Deployment/Job paths
in the configured task namespace. Termination evidence must fall inside the
requested observation window. Reused names and stale generations are rejected.
Unknown mutation outcomes retain `recoveryRequired`; observing desired state
does not automatically reconcile a mutation. No Secrets, pod exec, extra RBAC or
cross-namespace reads are introduced. Structured diagnostics are returned with
API errors/results and delivered to an optional `onDiagnostics` callback. Gateway
activation forwards that callback through its existing progress interface.

Termination identity comes from that termination's own `containerID`, not the
replacement container's current ID. Missing termination IDs remain omitted while
the pod UID, logical container name and observation window still scope the report.
The field is defined by the [official Pod API](https://kubernetes.io/docs/reference/kubernetes-api/core/pod-v1/#ContainerStateTerminated).

## Security and remaining limits

- No raw kernel logs, Event Log messages, container health output, pod specs or
  environment variables are collected into observations. Host cgroup paths and
  container identities are digested. Only known reason codes and selected
  scalar fields cross the public boundary.
- Windows historical `job worker exited without a result` responses are now
  normalized to unknown, matching the existing Unix compatibility handling.
  Cancellation/deadline state cannot complete a step merely because a native
  response contains exit code zero. Local SSH process deadlines remain separate
  from remote command deadlines.
- Exact Linux OOM-victim attribution is not available from shared cgroup
  counters. No PID-only inference is made, avoiding PID-reuse false matches.
  Process-specific kernel/crash-log correlation is not implemented. FreeBSD and
  macOS do not acquire an invented Linux-equivalent OOM counter.
- Windows resource-exhaustion records are host-wide, best effort, and not process
  attribution. Event Log denial, clearing and unavailable CIM providers limit
  evidence. Application-crash events are likewise host-wide observations, not
  process attribution. Service-specific crash Event Log correlation is not
  implemented; native failure status and existing service diagnostics still work.
- Filesystem snapshots cover the root/system drive and, on Unix, a validated
  explicit filesystem diagnostic target when the reviewed step supplies one.
  Paths are not extracted from AI command text. Other mounts are not inspected.
  Explicit ENOSPC cannot distinguish blocks, inodes and filesystem metadata
  exhaustion without additional targeted investigation.
- Kubernetes probe-specific events and node-pressure attribution are unavailable
  through the current scoped collector. Not-ready is not labeled a failed probe.
  Existing RBAC has no events read grant and is unchanged. Missing/expired events
  and inaccessible gateway pods do not prove a cause.
- Kubernetes task execution does not currently share the host SQLite execution
  workflow. Its API observations use result/error metadata and callbacks, not
  fabricated host task IDs. Hosts' journal, SSE, console inspection and exports
  share the same stored observations. Kubernetes callers must retain their API
  results/callback evidence if they need replay beyond the client session.
- Evidence collection does not resolve uncertainty, approve a revision, retry a
  failed command or perform rollback. Existing retry policy remains authoritative.

## Validation

Deterministic tests cover reason classification, native cancellation/deadlines,
bounded/redacted platform parsing, stale/reset/wrong-scope OOM evidence, boot
changes, Windows status preservation, container identities/time windows,
Kubernetes UID/generation/time checks, namespace boundaries, uncertain writes,
collector failures, exact-attempt reconciliation and journal/stream/export
consistency. A local read-only Linux collector smoke test also runs on Linux.

No destructive resource-exhaustion tests are automatic. Windows, FreeBSD, macOS,
Docker/Podman and Kubernetes collector behavior is fixture-tested, not claimed
as live-host validation. Native plugin source and binaries are unchanged by this
  feature.

Signed read-only collector checks passed on AlmaLinux 9, Fedora 44 and openSUSE
16.0. Each reported the effective 2 GiB ancestor limit and its retained OOM
counter without disclosing the cgroup path. This is collector validation, not a
new full application-matrix pass and not a deliberate OOM test.

| Milestone | Reused interfaces and verification | Remaining limit |
| --- | --- | --- |
| Shared observations | Existing failure classifier, process results and journal metadata; reason, timeout, cancellation and redaction regressions | Unknown reasons remain explicit |
| Linux recovery | Signed Netdata commands, exact-attempt journal lookup and controller reconciliation; hierarchy fixture and three live signed collector checks | Shared counters cannot identify the victim |
| Other native platforms | Existing Unix/Windows execution; fixed platform collectors and native-status fixtures | No live FreeBSD/macOS/Windows validation or process-specific crash-log attribution |
| Workloads | Existing runtime commands and Kubernetes signed API gateway; exact ID/UID, generation, timestamp, namespace and mutation uncertainty tests | No extra events RBAC; Kubernetes persistence remains caller-owned |
| Operator reporting | Existing CLI, console inspection, SSE events and sanitized export; exact-attempt replay regression | No new authorization or recovery decision is made |

Final automated checks: `npm test`, `npm run lint`, `npm run typecheck` and
`npm run test:package-install`. Raw TAP totals and package verification are
recorded in the Linux lab checkpoint; generated artifacts are not committed.

Reference contracts: [Windows resource-exhaustion events](https://learn.microsoft.com/en-us/troubleshoot/windows-server/performance/troubleshoot-application-service-memory-leaks)
and [application-crash events](https://learn.microsoft.com/en-us/troubleshoot/windows-server/performance/troubleshoot-application-service-crashing-behavior),
and [Kubernetes pod conditions](https://kubernetes.io/docs/concepts/workloads/pods/pod-condition/).
