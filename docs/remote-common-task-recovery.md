# Signed remote common-task recovery

## Current validation scope

Live acceptance testing targets the existing Linux lab with native installations
only. Docker/Podman, Kubernetes, Windows, FreeBSD and macOS are not part of this
live validation and must not be reported as verified. Their existing execution
paths and deterministic regression coverage must remain intact. This limits the
validation claim, not the security requirements or implementation requirements.

## Implementation audit

The existing executor (`executeApprovedPlan`) awaits journal callbacks before
dispatch. `AdminService` owns local leases and the shared host execution path;
the CLI and multi-host service both use it. These are the integration points
for remote intent and observed outcomes. Local SQLite journals remain
authoritative local history, not imported copies of remote events.

The host plugin already authenticates requests and supplies privileged execution
through system OpenSSH. Linux and FreeBSD link OpenSSL, macOS uses CommonCrypto,
and Windows uses CNG. A universal remote Node runtime is not available. Remote
signing must use platform-native maintained crypto, not require a new agent.

The Kubernetes gateway is separate and its current Deployment uses `emptyDir`
for writable storage. Its task ServiceAccount cannot read Secrets. Durable
recovery cannot be enabled by writing to that ephemeral filesystem or silently
granting new permissions. It needs explicitly configured persistent storage and
an established cluster identity before claiming this capability.

Existing common-task builders can regenerate commands and their provenance, but
their rollback scripts consume different baseline formats. A signature does not
make those files safe. Recovery eligibility therefore needs an explicit audited
profile, independent of catalog eligibility. Unregistered tasks must fail closed.

## Trust boundaries

Records contain allowlisted identifiers, hashes and execution states, never
commands, output, credentials, requests or complete inventory. Signatures are
domain separated. Host identity and the signing key pin are checked separately.
Verified records are evidence, not approval or executable instructions.

An authenticated fresh connection can establish the first public-key pin.
Existing pins may not change silently. Root/LocalSystem or an authorized gateway
administrator can forge records if they can use the signing key. Neither a hash
chain nor a signature proves that the newest records were not deleted when no
independent checkpoint survives.

`ssh-host-fingerprint-v1` uses the existing `SystemSsh.hostFingerprint` stable
machine-identity hash observed through authenticated OpenSSH. It is checked again
before ledger access. It is distinct from both OpenSSH host-key verification
and the recovery-signing public-key fingerprint; none replaces another.

## Implemented milestone

- Strict canonical version1 records, domain-separated signatures, ordered hash
  chains, target binding and bounded retrieval. Ed25519 and P-256 verification;
  POSIX storage signs with OpenSSL P-256 and Windows with CNG P-256/P1363.
- Automatic recording for newly planned, unchanged common tasks through the CLI
  and multi-host service. Existing tasks are not retroactively signed. Metadata
  writes use the existing authenticated Stage2 command path, not AI commands.
- Separate local WAL/FULL SQLite storage holds public-key pins, remote execution
  pointers and proposal preconditions. Existing task databases are not migrated.
- Read-only remote discovery, verified SSH first-use pinning, rejection of changed
  pins, local checkpoint rollback/fork checks and newly generated recovery plans.
- Explicit key rotation verifies a domain-separated old-key-signed transition,
  retains historical public keys and refuses active ledger owners. A lost local
  acknowledgement can be handled by separately reviewing the published change.
  Unexpected key changes are never adopted automatically. Historical public keys
  can be retrieved over the authenticated connection after checking the active pin.
- Target-side exclusive operation ownership, expected-head comparisons and
  persistent task-ID reservations prevent overwrite and conflicting recovery.
  Local history contains only actual local recovery commands, not fabricated
  imported deployment events.
- Linux `systemd-service` and `systemd-timer` are explicitly registered recovery
  profiles. Their signed baseline covers durable unit bytes, inode/owner/mode
  identity, the private task-state directory and its completion marker. A fixed
  guard rechecks these before the destructive command. Missing or altered evidence
  blocks recovery. Native `intent-ai-ops-linux` adds a separate profile on
  non-Alpine Linux: protected baseline markers, the task-owned installation tree
  and both launchers are fingerprinted and rechecked before its single rollback.
  It rejects writable/multiply linked files, unsafe paths and changed tree contents.
  Collection is limited to512MiB,30000 entries and10 seconds, so large or unusual
  installations may fail closed. Deterministic fixtures and a reviewed Debian
  install/discovery/recovery cycle pass. Other families are recorded but not recoverable.
- A CLI host action retrieves and inspects records, prepares a new plan and uses
  normal validation, approval and local leases to execute it. Generic history
  execution cannot bypass source-head and ownership checks for these proposals.
  The shared operator controller also exposes discovery, proposal and explicitly
  approved execution to the local browser console. Existing token, origin, CSRF,
  read-only and stale-version checks apply. The browser sees regenerated trusted
  catalog commands, never executable text from remote records. Signing-key
  management remains CLI-only.
- Transport-recovery events are valid signed records. Reconnection and a pause
  do not discard the baseline from the latest confirmed command completion;
  recovery still requires every catalog command confirmed, fresh matching baseline
  evidence and explicit approval. A later failed/unknown attempt cannot inherit
  an earlier completion or baseline.

## Storage and compatibility

Linux uses `/var/lib/intentaiops/recovery`; FreeBSD uses
`/var/db/intentaiops/recovery`; macOS uses
`/private/var/db/intentaiops/recovery`. POSIX requires the existing OpenSSL CLI.
Keys and record files are root-owned0600 beneath private0700 storage. Writable
ancestors, symlinks and multiply linked files are rejected. A bounded atomic mkdir
lock serializes metadata publication. A lock left by a killed metadata writer is
not automatically deleted. POSIX publication uses ordered `sync` and rename;
its global flush cost needs live measurement before performance claims.

Windows uses `C:\ProgramData\IntentAIOps\Recovery`, LocalSystem execution,
SYSTEM/Administrators-only ACLs, CNG, write-through files and atomic publication.
Its backend is implemented but has not been executed on a Windows host here.
FreeBSD/macOS storage is likewise not claimed live-validated by Linux fixtures.

No new native plugin protocol or build is needed for these host helpers. They
are bundled fixed administrative collectors executed through the existing signed
function. No persistent helper process or new remote agent is installed.

A fresh vault still needs normal Stage2 authorization. Plugin-only activation can
provision its execution action key without deleting the separate recovery ledger
or recovery-signing key. This existing action can invalidate another installation's
old execution action key; coordinate operators before changing it. The feature
does not retrieve or expose that secret through public recovery records.

Before dispatch, failure to persist remote intent stops the command. A failure
after execution preserves locally confirmed journal evidence and never repeats
the command. An incomplete remote ledger can remain insufficient for recovery.
Long-lived operation owners are not stolen on timeout. A fully completed,
unchanged source can use explicitly reviewed takeover, bound to its current head
and owner fingerprint. This fences the previous owner without exposing its token.
Partial/uncertain or interrupted recovery still requires investigation.
A source record with prior rollback/recovery
activity cannot be treated as a fresh untouched deployment.

## Still required for the full task

1. Additional audited task-family baseline profiles. Do not treat current catalog
   support as verified recovery coverage, particularly for package lists,
   databases, application backups and container volumes.
2. Reviewed reconciliation of partial recovery.
   Current uncertain/partial sources and already-started recovery are blocked,
   not guessed or replayed.
3. Kubernetes persistent volume configuration, established cluster identity,
   gateway-native signing/storage and replica concurrency. Current CLI reports
   unavailable and performs no RBAC mutation, pod-exec or SSH fallback.
4. Native Windows, FreeBSD and macOS live validation, plus reboot/crash testing
   on disposable targets. Source/crypto fixtures are not native OS coverage.
5. Live validation of browser recovery mutations. Controller/HTTP/browser fixtures
   and actual-binary console reads are not live browser-mutation coverage.

The earlier Ubuntu task50 cleanup proposal was not dispatched. Subsequent,
independently reviewed test-residue cleanup task56 is recorded in the lab
checkpoint; it quarantined test data and preserved older frozen backups.
Historical unsigned task records remain unchanged.

## Local catalog refresh

The shared controller also exposes `proposeCatalogRefresh` for native Linux
applications with local execution history. It reads fresh authorized inventory
and rebuilds the same local catalog task ID, without asking AI to transcribe
commands. Completed definitions and their dependency closure must match the
current catalog exactly; rollback definitions, application version, route and
host compatibility cannot change through this action. Uncertain outcomes,
legacy interrupted history and started rollback block refresh. Pending commands
receive new identifiers. Normal policy validation, stale-version rejection,
explicit approval and separate resume still apply. This creates no new browser
action or execution endpoint and does not extend audited remote recovery profiles.

The local CLI reviews the actual stored proposal and results, rather than the
sanitized public-console projection. Browser views and exports remain sanitized.

Native Ubuntu Ghost now records whether `/var/lib/mysql` was absent before
installation. If newly created data remains after package removal, rollback
stops with `DATABASE_DATA_REMAINS` and retains its baseline for inspection.
It does not delete database files or declare baseline restoration complete.
A separately reviewed cleanup must preserve unrelated data. Historical plans
without this marker are unchanged and still need independent residue checks.

## Live Linux validation, 2026-10-19

All host operations used the ordinary CLI, its existing vault and signed Stage2.
No direct-service remote mutation driver or replacement vault was used.

- Ubuntu task51 applied the service fixture once and produced four verified
  signed records. Recovery inspection correctly refused its group-writable
  completion marker, created under the plugin's umask0007. The original records
  were not rewritten or retroactively supplied with a successful baseline.
- A shell regression failed before and passed after explicitly creating the
  shared fixture completion marker as0600. Task51 then completed its separately
  reviewed ordinary rollback. Its archive retains ten records including rollback.
- Fresh task52 applied the corrected fixture once. The real CLI retrieved and
  verified its signed chain, inspected the private baseline and generated a new
  guarded recovery plan as task53. After explicit review/approval, task53 executed
  that recovery once. Its events contain only the actual local recovery command,
  not fabricated imported deployment events. The source archive now has nine
  verified records ending with recovery rollback completion.
- Read-only inspection through the CLI SSH shell confirmed the unit, runtime
  marker and both task51/52 state directories are absent. The persistent signing
  directory remains root0700 and the key root0600. No private key was returned.
- Ubuntu's four recorded MariaDB/MySQL/config backup directory identities were
  unchanged. MariaDB remained inactive and Netdata active. No database package,
  data, network isolation or Kubernetes permission was changed.
- Debian task42 applied the timer profile once. The normal CLI verified its four
  signed records and generated a new guarded recovery as task43, explicitly
  approved and dispatched once. Read-only journal assertions confirm one dispatch
  and one completion per command, with no unknown outcome. Retrieval after
  recovery verified all nine records ending in `rollback_completed`. Independent
  CLI SSH inspection confirmed both units, the enablement link, runtime marker
  and task-state directory absent; Netdata remained active. The persistent ledger
  and signing key remain root-owned0700/0600. This also exercises the hardened
  baseline collector, which now refuses a failed per-file hash rather than hiding
  it behind a successful final pipeline command.
- Debian's signing key was explicitly rotated through the normal CLI. The
  transition and replacement pin verified; afterwards the same nine historical
  timer records still verified through discovery. No task was replayed.
- Debian45 installed the native CLI once. The client lost its local execution
  lease after dispatch; the underlying reason for the lease expiry is unconfirmed.
  The existing durable job subsequently confirmed success. Normal CLI
  reconciliation now appends signed completion and current baseline evidence,
  retaining the original attempt and never replaying it. Previously this path
  only updated local history; a deterministic regression covers the fix.
- The same CLI verified those nine signed source records, regenerated recovery46
  from the current trusted catalog and freshly matching full-tree evidence, then
  executed its single destructive command after explicit approval. All15 resulting
  records verify and end with `rollback_completed`. Independent binary SSH checks
  confirm the installation, both launchers and task state absent, Netdata active,
  ledger root0700 and key root0600. Original task45's client failure is preserved,
  while its journal confirms both commands completed; recovery46 is completed.

This is an actual Linux apply/discovery/regeneration/recovery cycle. The isolated
fresh-installation scenario additionally passes automated tests using real
OpenSSL storage and two separate local data directories; a second real CLI vault
was not created. It is not a native Windows/FreeBSD/macOS or Kubernetes live pass.

## Verification

- Latest full source suite:741 total,738 passed, zero failed, three opt-in skips.
  The unfiltered log is `/tmp/intent-recovery-final-tests.log`.
- `npm run lint` and `npm run typecheck`: passed.
- `npm run test:package-install`: passed on Linux/x64; package checks require both
  fixed storage helpers and the recovery modules.
- `npm run check:checksums` and `git diff --check`: passed before final handoff.
- Existing static-glibc linker warnings remain. No new native protocol/build was
  introduced, and there is no claim of a native non-Linux feature test.

These results cover this milestone, not the outstanding full-task requirements
listed above. Key rotation has Linux live coverage; application/database-family
recovery and partial recovery are not claimed implemented or verified.
