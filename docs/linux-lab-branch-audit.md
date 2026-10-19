# Linux lab branch audit

Updated 2026-10-19 08:43 UTC. Comparison: `main` at
`fe55614b5ef780dbae582008103a0e905e41cdd2`, checkout HEAD
`983ff09aa5c82823516c4207f60a503b1112bfa7` plus uncommitted fixes.
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
