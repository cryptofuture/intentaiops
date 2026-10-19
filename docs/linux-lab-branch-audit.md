# Linux lab branch audit

Updated 2026-10-19 16:59 UTC. Comparison: `main` at
`fe55614b5ef780dbae582008103a0e905e41cdd2`, checkout HEAD
`d81e10e236f2335690a3fc61f758cef267dae2c4` plus uncommitted fixes.
This is an evidence ledger, not a completed release sign-off.

Live acceptance scope is the README's Linux-without-Docker application column:
87/87 eligible application/host cycles pass with reviewed recovery/cleanup
where required, not universal unattended rollback. System
fixtures and maintenance remain supplementary evidence, not application passes.

All live mutations use the normal binary, existing vault, signed Stage2 and
reviewed plans. Offline journal assertions open SQLite read-only. They do not
decrypt the vault, contact hosts or repair history projections.

## Feature evidence

| Area changed from main | Automated evidence | Actual Linux/binary evidence |
| --- | --- | --- |
| Durable journal, leases and recovery | `test/execution-journal.test.js`, `test/operator-controller.test.js`: ordered intent, ownership, immutable history, uncertain ancestors, completed-step skipping and no uncertain replay | Fresh read-only audit of all163 previously completed apply/rollback cases plus9 health tasks passed. Ubuntu44 subsequently added an approved-revision lifecycle pass. Three cleanup-recovery exceptions use their approved replacement plans, retaining original failures/unknown events. |
| Repair-loop protection | Identical/alternating failures, changed diagnostic evidence, distinct job IDs and successful bounded retries in `test/execution-journal.test.js` | Not deliberately induced against live package managers. Existing failure histories remain available; fixtures establish loop decisions without destructive repair attempts. |
| Safe pause and plan intervention | Final boundary checks, pauses during approval/evidence/retry, immutable completed prefixes, stale approval and empty-proposal rejection | Oracle35 paused after its running acquisition completed, then reviewed resume ran only2 pending commands. Ubuntu44 revision10 separately approved7 replacement IDs and separately resumed; all7 forward/4 original cleanup commands dispatched once. Empty proposal9 stayed unapproved. |
| Shared controller and staged rollout | `test/multi-host-service.test.js`, `test/operator-controller.test.js`: failed-canary stop, planning-time pause, independently recorded hosts and linked rollback projection | Run25 retained independent Debian/Oracle/Rocky/Ubuntu task histories. Run26 now exercises current-release updates with explicit canary/batch health gates. Its remaining stages are not passes yet. |
| Local console, actions, SSE and export | Real HTTP fixtures in `test/operator-controller.test.js`: authentication, origin, CSRF, stale decisions, sanitized errors, atomic catch-up, reconnect and backpressure | Both normal-vault binary console modes previously passed authentication/SSE/export and rejected-action checks, recorded in the checkpoint. No browser mutation was approved merely to test an endpoint. Replay/export had no remote actions. |
| OpenSSH reuse and recovery | `test/system-ssh.test.js`, `test/ssh-session-manager.test.js`, `test/host-session-factory.test.js`: coalescing, identities, ownership, expiry, reconnect, shutdown, compression and SCP fallback | All9 hosts use normal binary SSH/Stage2 workflows. Prior five-repetition measurements cover8 hosts, with limitations in the checkpoint. Fresh Arch SSH and Stage2 remained healthy after its OpenSSH/systemd update. No general performance claim follows from lab timings. |
| Failure/interruption evidence | `test/execution-diagnostics.test.js`: timeout/cancellation, reboot/cgroup correlation, native statuses, runtime identity, scoped Kubernetes evidence and redaction | Linux observations are present in live attempt journals. Acquisition inspections found no new OOM kills; low memory or old counters were not promoted to a cause. A131-second idle collector check retained process identity. Revised rollback reconciliation now resolves only its exact approved diagnostic plan; regression failed before/pass after. |
| Catalog setup and restoration | Catalog, database-ownership, recovery and application tests; explicit eligibility/plan checks for all87 native Linux application routes | Current total182/183:87/87 application,78/78 system-fixture,9/9 health and8/9 update cases. Ghost required reviewed residue quarantine after its original rollback. All5 eligible Mattermost hosts and all9 WordPress hosts passed reviewed apply/cleanup. Protected old n8n prefixes and database originals remain recovery evidence, not disposable test debris. |
| Settings and planner boundaries | `test/settings-store.test.js`, `test/codex-planner.test.js`, admin/controller forwarding tests | Previous real two-session stale-write rejection and authenticated read-only consultation passed. Installed-Codex boundary opt-in passed50/50 after public catalog-template fixes. AI historical context remains redacted; rebuilt public templates confer no execution approval. |
| Signed remote common-task records | Real OpenSSL storage, isolated fresh-install clients, signature/identity/CAS/baseline tests. New regression reproduces and fixes rejection of execution_recovery events and lost baseline selection after a confirmed completion followed by pause. | Ubuntu51/52/53 service and Debian42/43 timer cycles use the real binary. Debian source chain verifies9 records; independent SSH inspection confirms fixture paths absent and ledger/key root0700/0600. No real fresh second vault, key rotation, broad task-family recovery or forced disconnect is claimed by these cycles. |

## Latest continuation

- Stronger live assertions now pass for15/87 application cases: all9 native CLI
  host cases, Debian n8n and Jellyfin, Alpine Drupal and three Moodle cases.
  Seventy-two application assertions remain;23 scoped cycles include8 system
  fixtures. Ubuntu's old task66 swap directory is preserved after a pre-dispatch
  collision, and its new67/68/69/70/71 cycle passes without adopting that state.
- Additional Jellyfin audit reproduced false-success cleanup and deletion of
  later unowned files. Native cleanup now requires its valid nonsymlink baseline,
  skips missing state without deleting later files, propagates service/account/
  package restoration failures and retains unresolved baseline evidence. All32
  restore-failure/success cases,9 baseline cases and3 service-failure fixtures
  pass. Previously saved plans are immutable. Reviewed Rocky45 and Arch45
  cleanup now restores each selected baseline44, confirmed by fresh probe46.
  Debian74/75 additionally passes both repeated apply and both rollbacks through
  fresh probes76/77. No Docker live coverage is claimed.
- openSUSE56 demonstrates confirmed execution-timeout diagnostics, not OOM:
  failed FFmpeg job recorded exit143, signal15 and timed_out. Its retained
  partial archive motivated bounded, checksum-verified resumable acquisition.
  The new downloader passes deterministic fixtures and openSUSE56 live
  continuation: all4 replacement steps completed once, original4 were not
  replayed, independent HTTP health passed, and reviewed original rollback
  completed all3 steps. Final restoration probe57 exactly matches55. Full suite
  PASS801 total/798 passed/3 opt-in skips; lint/typecheck/package-install and
  artifact checksums PASS. Broader recovery profiles remain unimplemented.
- Debian Jellyfin70 completed all7 forward commands. Exact repeat proposal71
  hit a catalog/planner-policy mismatch, then changed its initializer; both
  approvals were declined and zero commands dispatched. The catalog now uses
  captured one-line `sed` readers instead of `cat`, matching existing policy
  without a new secret-read exemption. Regression covers the native plan and
  shared initializer; protected execution output remains redacted. Source70's
  original strict rollback is being validated, not counted as an exact-repeat pass.

- Arch37 reproduced a genuine setup gap: released installer refused the existing
  Node22.23.3. Its empty task-owned root/state were removed by separately reviewed
  guarded rollback revision7, retaining the original failure. The trusted Linux
  common-task builder now supplies checksum-verified private Node24.16.0 without
  replacing system Node, bounds downloads, removes temporary archives and sets
  umask022. Six isolated regressions pass, including checksum failures, compatible
  system reuse, repeat/double cleanup and hostile inherited umask. Native37 was
  not replayed; fresh39 installed successfully. Independent binary SSH confirmed
  both versions, safe ownership and removed downloads. Its exact repeat40 passed
  unchanged snapshots, current-catalog remote recovery proposal41 regenerated
  successfully but was declined, and its first original rollback removed only
  the private runtime. Final assertion38/39/40/42/43 now PASSES: both restoration
  probes match baseline38, including unchanged global Node22 and Netdata state.
- Alma46/47/48/49/50 and Alpine38/39/40/41/42 now pass full scoped repeat/restore
  assertions. These add two application cases, not new platform-family recovery
  claims. Including Arch, nine application cases and17 scoped cycles overall
  are verified so far; the strict audit reports78 missing application assertions.
- Ubuntu66 was blocked before task dispatch by a real legacy-ID collision with
  old root-owned0700 swap state. It remains preserved. Remote transport now
  reports only exact allowlisted conflict/busy messages with safe next actions,
  never arbitrary stderr. Regression failed before/pass after, including secret
  exclusion and inherited-object-property inputs. The guard is unchanged; no
  occupied state is adopted or removed, and no retry is automatic.

- Current-profile native n8n remote recovery is now live-verified on Debian:
  source60 completed six commands once, followed by reviewed regenerated
  recovery63's single guarded job. All27 source records verified before recovery
  and all33 afterwards, ending rollback_completed/completed. Independent normal
  binary SSH inspection confirms task-owned paths/account absent and Netdata
  active. Acquisition took43 minutes with no observed OOM kill. Other Linux
  families have reconstruction/collector fixtures, not extra live recovery passes.

- Fedora33/34/35/36/37 now passes the complete selected-tree/package/service
  repeat/restoration assertion. Both applies and both reviewed rollbacks dispatched
  once; fresh probes after each rollback exactly match baseline33. Signed source34
  also proves pause after completed baseline and resume of only the pending
  installer. All18 remote records verify through rollback completion. Application
  repeat/restoration coverage is now6/87 with81 missing;14 formal cycles overall
  include8 supplementary system cases. Debian n8n60 is still acquiring packages.
- Regenerated n8n cleanup plans pass the authoritative executor validator for
  all five reconstructed Linux families, in addition to shell parsing and ordering
  fixtures. Live current-profile n8n recovery still awaits source60 completion.

- The strict read-only application repeat/restoration gate is implemented and
  regression-tested. It currently fails honestly:5/87 cases verified,82 missing.
  The broader13 formal cycles include8 supplementary system fixtures. The gate
  makes no remote calls and does not change the normal audit's narrower meaning.
- Signed pause/resume is now also live-verified on Debian61, through a fresh
  binary. The source's six records verified before recovery62 and all11 verified
  afterwards, ending rollback_completed/completed. One apply and one reviewed
  recovery dispatched. Independent SSH inspection confirms fixture paths absent
  and Netdata active. Source60 n8n acquisition continues separately.

- Superseding validation:782 tests total,779 passed,0 failed,3 opt-in skips;
  lint, typecheck, package-install and five artifact checksums pass. The archive
  SHA-256 before this documentation refresh is
  `462adbff6d3cc6d2c2f277bc84e010d98b8119ad8afd5203e25c17cefd74de35`.
- Debian n8n52/53/57/58/59 passes the formal scoped two-apply/two-rollback
  assertion, bringing that stronger coverage to13 cycles, not all87 application
  cases. Both original and repeated cleanup completed once, with exact selected
  static-file/package/service baseline restoration. Private runtime contents were
  outside the probe scope. The planner-policy private-file handoff false positive
  was fixed without relaxing output redaction or approval.
- Remote pause/resume now goes through the shared signed-event hook. New remote
  execution claims refuse occupied legacy task-state paths instead of reusing
  unsigned leftovers after local task-ID collisions. Focused recovery/admin/
  journal tests63/63 pass. Windows path checks are fixture-only.
- Source60 is the fresh current-catalog n8n application test. Acquisition is
  running without intervention; do not replay it or treat it as complete. Normal
  binary inspection confirms0700 state/backup and0600 package baseline. Current
  n8n remote-recovery execution remains pending, as do broader application/database
  profiles and universal live repeated-apply/exact-restoration assertions.

- Native n8n recovery now has a fixed Linux baseline collector, current-catalog
  reconstruction, customized-target rejection and one guarded dependency-ordered
  cleanup job. Fixtures cover all five Linux families, tampered package lists,
  repository drift, unsafe backups and mounts, and stopping on cleanup failure.
  Live inspection of Debian53 caught implicit state-parent creation at0755;
  the new explicit0700 creation regression failed before the fix and passes now.
  Repository writes also get an explicit022 umask. Source53 is an immutable older
  plan and cannot count as live coverage for these final catalog changes. Its
  acquisition remains active; see the checkpoint before any continuation.
- Four isolated complete-tree restoration fixtures now execute unchanged apply
  twice and rollback twice while preserving unrelated contents and links.
  These are not extra live application passes. Probe version2 hashes selected
  recursive contents, not only root-directory metadata. Protected application
  credentials/runtime databases remain explicitly outside the current Debian
  n8n live probe scope. No whole-host restoration claim follows.
- Shared heartbeat failures stop further renewals, retain their original error,
  and record timing/drift without owner secrets. The earlier Debian45 lease loss
  remains unexplained. CLI remote-history inspection now also shows the recorded
  outcome, so a terminal event with a partial outcome is not shown as success.

- Superseding check:741 total/738 passed/0 failed/3 opt-in skips; lint,
  typecheck, package-install, native checksums and diff-check pass. Installed
  Codex boundary53/53 also passes. Application history remains87/87 reviewed
  cycles; completed-step replay is checked separately from filesystem restoration.
- Native Debian CLI recovery is now live-verified: task45 installed once,
  suffered client lease loss after dispatch (underlying cause unconfirmed), and
  was reconciled from the same successful durable job without replay. The
  discovered missing remote-ledger reconciliation path is fixed and regression
  tested. Nine source records verified before separately approved recovery46;
  all15 records verify afterwards, ending `rollback_completed`. Independent
  binary SSH checks confirm task-owned paths absent and Netdata/ledger intact.
  The original client-failure history is retained, not rewritten.
- New console recovery reads also passed through the actual binary with the
  existing vault, including historical signatures after rotation, token/origin
  protection, SSE/export, secret exclusion and an unchanged execution journal.
  Browser mutation coverage remains fixture-only. Broad database/application
  recovery and universal repeated-apply/exact-restoration cycles remain open.

- Current reproducible check:
  `node scripts/audit-linux-cli-history.js /home/vscode/.intentaiops` passes87
  application cycles,4 reviewed-recovery exceptions and87 completed-step replay
  assertions with0 host connections. This is not universal filesystem restoration.
- Ubuntu62 exercised the new Ghost residue guard: original restore-stack failed
  with `DATABASE_DATA_REMAINS`. Task63 refused an incorrect directory-mode
  assumption before mutation; task64 moved only the identity-bound new datadir
  intact. Explicitly approved rollback revision15 completed only the remaining
  cleanup. Final independent baseline probes passed; historical failures remain.
- Debian key rotation and post-rotation verification of nine old timer records
  passed through the actual binary. Browser/shared-controller recovery actions,
  stale-selection protection, reviewed ownership takeover and native CLI-install
  baseline profiles have deterministic coverage. Native CLI-install recovery and
  browser mutations are not yet live-verified. Partial/unknown recovery stays
  blocked, and application/database families remain unregistered.
- Current full suite740 total/737 passed/0 failed/3 skipped. Lint/typecheck,
  package-install, five native checksums and diff-check passed before the latest
  marker-permissions fix; focused catalog/recovery tests42/42 pass after that fix.

- A fresh read-only audit across all nine normal-vault histories confirms84
  ordinary application lifecycles. The three approved recovery exceptions
  (Alma18, openSUSE39, Ubuntu42) separately pass original forward assertions and
  exact approved rollback fingerprint/parent/attempt/order/result checks. Their
  historical failed/unknown evidence is preserved, not rewritten as success.
- The normal binary's default read-only console was retested against Ghost57,
  cleanup61 and run25 export. Missing/invalid tokens return401; foreign origins
  and attempted actions return403. Authenticated history, export and SSE pass,
  known vault secret/private-key material is absent, and execution-event counts
  remain unchanged. The console shut down normally. No remote action was sent.
- Ghost's remaining residue was moved intact by separately reviewed task61.
  Exact stored forward/rollback bodies matched the supplied plan before approval;
  the forward command dispatched/completed once, zero unknown. Final independent
  CLI-shell probes confirm the source path absent, quarantine identity unchanged,
  package baseline hash equal, all managed Ghost paths absent, protected older
  backups unchanged and Netdata active. Tasks59/60 were rejected without dispatch;
  task58 timed out without dispatch. This completes the application cycle, not
  proof of fresh-install verified Ghost recovery or universal repeated execution.
- Ubuntu57 completed its seven active Ghost commands and four separately
  reviewed rollback commands once each. The lifecycle assertion passes, including
  immutable original failure evidence and zero unknown outcomes. External
  marker/blog checks passed. Installed-package baseline hashes match exactly;
  repository files, inactive nginx/MySQL state and protected backups match.
  MySQL left a newly created data directory; task61 supplied the separately
  reviewed quarantine described above rather than deleting it.
- New Ghost plans record an absent MySQL datadir baseline and refuse rollback
  success while newly created data remains. The baseline stays available and
  no database files are deleted. Directory/dangling-symlink regressions pass.
- Current checks: full suite720 total/717 passed/0 failed/3 opt-in skips;
  lint, typecheck, package-install and native checksums pass. These supersede
  the historical683-test check below. Current packaging includes the guard;
  documentation edits require rebuilding before final distribution.
- Ubuntu56 completed the three exact reviewed test-residue cleanup commands once
  each, with explicit approval and intervention boundaries. Test data was moved
  intact to a private quarantine, specified MariaDB packages removed without
  purge/autoremove, mysql-common restored and owned temporary masks removed.
  Its separately guarded restoration has not executed. Older backups remain.
- Ghost package rollback now compares installed package identities, not version
  changes. It preserves upgraded pre-existing packages while recognizing an rc
  entry as not installed. Both shared callers pass executable shell regression.
- Fresh feature-boundary tests105/105 and installed-Codex isolation50/50 pass.
  Full source tests and packaging are being refreshed after the latest changes;
  the checks and archive in the historical section below are not current sign-off.

## Current checks

`npm test`:720 total,717 passed,0 failed,3 opt-in skips.
`npm run lint`, `npm run typecheck`, `npm run test:package-install`, all5 native
artifact checksums and `git diff --check` passed after the Ghost residue guard.
Installed-Codex opt-in51/51 passed earlier this continuation; SSH31passed with1
real-host opt-in skip and FreeBSD compatibility compile are earlier checks, not
new live platform claims.
Application archive SHA256:
`ca5dacc0476d663cea63e5f297d4874bc419e85523380eab84dd7eb34f44ee74`.
Later edits to this audit, checkpoint and matrix are not packaged source files.

## Remaining sign-off work

- Run26 completed all8 selected update hosts, with independent normal-binary
  SSH/Stage2 checks before every health gate. Updates are one-way maintenance,
  not rollback-restoration tests. Report audit exposed lexical sorting hiding
  Alma/Rocky10.x; fixed ordering passed a shell regression and read-only run27
  (Alma45/Rocky37) showing10.2. Original update dispatches remain1 each.
- Ghost's native Ubuntu MySQL8/private-Node22 route now has live apply/rollback
  and separately reviewed residue-quarantine evidence. No unrelated global Node
  downgrade or protected MariaDB-original mutation occurred. Its new residue
  failure guard has fixture coverage, not a second full live Ghost deployment.
  Ubuntu's current-release update remains optional maintenance outside the
  current application acceptance scope, not an untested application.
- Protected Ubuntu directory identities and MariaDB server/core versions were
  rechecked after Mattermost44 cleanup and passed. Keep them protected during
  any separately reviewed Ghost setup.
- Twelve formal repeated-execution/scoped-restoration cases have passed across
  all9 hosts, including Debian37/38/39/40/41 and Ubuntu45/46/47/48/49. They do
  not prove identical restoration of every path or all183 combinations. Finish
  the outstanding assertions before claiming universal repeat/restoration.
- A fixture pass is not a live FreeBSD/macOS/Windows/Kubernetes or Docker/Podman
  test. This Linux LXC lab cannot supply those environments. Native build and
  platform evidence limitations remain in the milestone/diagnostic documents.
- Original MiMo/high was restored through a fresh binary. Previous owners closed
  normally; no running/reverting tasks or live execution leases remain. Preserve
  all unknown historical execution evidence, not just successful projections.

See [current coverage](linux-lab-current-matrix.md) and the
[resumption checkpoint](linux-lab-validation-status.md) for task IDs and owners.
