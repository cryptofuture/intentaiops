# Linux lab validation checkpoint

Updated 2026-10-19 08:43 UTC. This file supersedes all earlier checkpoint instructions. Full prior evidence remains in [the history](linux-lab-validation-history.md); current coverage is in [the matrix](linux-lab-current-matrix.md).

## Current continuation, supersedes the chronological notes below

- Latest completion supersedes all pending Debian45 notes below. Installation
  dispatched exactly once. The client lost its local lease after dispatch
  (underlying cause unconfirmed); durable job `cd8bc7f2dacb9a2ebdc95991859d586a`
  confirmed exit0. Actual-binary reconciliation confirmed the original attempt
  without replay. Fixed a discovered gap: reconciliation now also signs remote
  completion and current baseline, preserving locally confirmed results first.
  Its deterministic regression passes. The nine signed source records verified.
- Explicitly approved regenerated recovery46 completed once, and all15 signed
  records verify ending `rollback_completed`. Independent binary SSH inspection
  confirms `/opt/intent-ai-ops`, both launchers and task45 state absent, Netdata
  active, ledger root0700 and signing key root0600. Task45 retains its historical
  client-failure status; both command outcomes are now confirmed complete.
  Recovery46 is completed. No remote job remains running. Never rerun task45.
- Current full source suite741 total/738 pass/0 fail/3 opt-in skips; lint,
  typecheck, package-install, five native checksums and diff-check pass after
  reconciliation fix. Installed-Codex boundary53/53 passes. Final package includes
  the updated recovery documentation, SHA256
  `57256e5b34b66fd88b73407273dcfe9f9a55a26472f504ddd28bfb156523fde0`.
  All actual-binary sessions exited normally; no background lab work remains.
  Broader application/database-family
  recovery, partial/unknown-source recovery and universal repeat/exact-baseline
  cycles remain unfinished; no non-Linux/Docker live coverage is claimed.

- Latest continuation supersedes the pending Ghost notes below: Ubuntu62 is
  reverted. Its original restore-stack failed safely with `DATABASE_DATA_REMAINS`.
  Task63's identity guard failed before mutation; corrected, explicitly reviewed
  task64 quarantined the intact new datadir. Approved rollback revision15 then
  ran only the remaining trusted cleanup as `finish-ghost62-baseline`, once.
  No original failed command was replayed and no outcome is unknown. Independent
  binary SSH inspection confirms Ghost paths/account and `/var/lib/mysql` absent,
  package baseline SHA256 unchanged, Netdata active, dpkg audit clean, and all
  protected original backup identities unchanged. Task64's saved restoration
  was NOT executed. Quarantine identity: `66311:276302500:110:112:700`.
- Debian recovery-key rotation passed through the actual binary and existing
  vault. Old fingerprint `2f6751bfdbce4b4a91ec8ebe6f1bdab68e23d1bc5d4f5327d8466a3610372d30`;
  replacement `be5497b5cdecf10bd94d8f85badca11fda5ede2e6a15684c4704f2d9173426d5`.
  Afterwards all nine old signed timer records for execution
  `dad4075cb7dad52118d52220810137ff` verified, ending `rollback_completed`.
  No deployment/recovery command was replayed. Old CLI sessions closed normally.
- Current read-only history audit:87 application cycles,4 reviewed-recovery
  exceptions,87 completed-replay checks,0 host connections. Full suite740 total,
  737 passed,0 failed,3 opt-in skips. Package-install, native checksums and
  diff-check passed before the latest installer-marker fix. Browser race and
  authenticated recovery-action fixtures pass; live browser mutations not tested.
- Native CLI-install recovery profile added with strict ownership/tree/launcher
  integrity checks; Alpine remains excluded. Before live dispatch, review caught
  installation markers inheriting plugin umask0007. Debian44 was rejected before
  execution. Marker creation now explicitly applies0600 without changing installer
  umask. Focused tests and a new live cycle are being run; do not yet claim a live
  verified recovery for this profile. Partial/unknown sources still fail closed.
- Follow-up live cycle: Debian45's capture completed once; installation is running
  as durable job `cd8bc7f2dacb9a2ebdc95991859d586a`, attempt
  `9ecf7bac-d661-4b65-992d-3696af00e3b5`. Actual-binary owner88944,
  read-only inspector4632; logs `/tmp/intent-cli-native-recovery.log` and
  `/tmp/intent-cli-native-inspector.log`. GitHub archive download is progressing
  slowly; new cgroup OOM counters remain zero. Do not resubmit the running command.
  Source checks after marker fix:740 total/737 pass/0 fail/3 opt-in skips;
  lint/typecheck/package-install/checksums/diff-check pass. Archive SHA256
  `e195bf14a1ad2d9037e2473cef2ac56133091bb9aa5f2a81c9d204b07c8bfaf6`.
  Standalone opt-in SSH test was not configured with vault transport credentials
  and failed before a host connection (first missing URL, then alias DNS). This
  is not a live transport regression; normal binary SSH remains connected.
- Actual-binary read-only console follow-up passed with the normal vault:
  Ubuntu62/64 history, run25 export, new Debian remote-task listing and all nine
  post-rotation timer records, token/origin enforcement, authenticated SSE,
  known-secret/private-key exclusion and unchanged Ubuntu execution journal.
  Console exited normally. This verifies new recovery reads, not browser mutations.

- Active continuation, 2026-10-19: new Ubuntu Ghost62 completed all seven
  reviewed current catalog commands without a revision or unknown outcome.
  Its original four-command rollback completed the first three and correctly
  FAILED restore-stack with `DATABASE_DATA_REMAINS`, retaining the baseline
  and new MySQL datadir identity `66311:276302500:110:112:700`. Package baseline
  SHA256 is still `8eda8ad0b3fc87963fe733927525716d7e2cf5b8324d6312d9d0a3a69cb45305`.
  Prior Ghost57 quarantine identity276302480 remains unchanged. Owner44739 is
  idle at Ubuntu host actions; inspector79822 has generated a one-command exact
  JSON-supplied quarantine proposal for `/var/lib/webminai/lab-recovery/ubuntu-ghost-task-62/mysql-after`.
  It is NOT yet approved/dispatched. Compare both stored bodies with the supplied
  originals, approve only the quarantine, then propose a NEW reviewed rollback
  revision for62 containing only the remaining trusted restore-stack body with
  a new ID. Never rerun the original failed rollback or restore quarantines.
- New implementation pending final live checks/documentation: explicit recovery
  key rotation, old-key-signed domain-separated transitions, archived public keys,
  explicit local pin adoption after lost acknowledgement, and fresh-install
  historical verification. POSIX and Windows helper implementations; real OpenSSL
  fixtures pass, Windows source only. Rotation refuses active ledger owners.
  Reviewed ownership takeover is limited to fully confirmed, unchanged supported
  sources with fresh baseline and expected head/owner checks, after explicit
  takeover and execution approval. Partial/unknown sources remain blocked.
- Shared-controller/browser recovery discovery, proposal and separately approved
  execution are implemented with token/origin/CSRF/read-only/version checks.
  New endpoint/controller tests pass. Additional UI race checks and live validation
  remain. Public recovery plans come from trusted local regeneration, never remote
  executable text. No browser signing-key management endpoint was added.
- `scripts/audit-linux-cli-history.js` is a committed-source read-only audit;
  it passed87 actual historical application cycles, including three fingerprint-
  checked recovery exceptions, and87 completed-replay checks with forbidden remote
  stubs. It proves journal ordering and completed-step skipping, not87 complete
  filesystem reinstallation/restoration cycles. New regression tests pass.
- Latest full suite before the latest diagnostic addition:736total/733pass/0fail/
  3skips (`/tmp/intent-recovery-followup-tests.log`). Lint/typecheck pass. The new
  baseline-refusal classifier test passes and fixes future generic unknown-cause
  labels without rewriting Ghost62's stored failure. Package is NOT yet rebuilt
  for these latest changes. Default remains GPT-6.1 Sol/low.

- Model-selection follow-up supersedes earlier MiMo-default notes: the code
  default and this normal vault's selected setting are now `gpt-6.1-sol/low`,
  saved through the actual binary. Existing saved selections are not forcibly
  migrated. The picker reads the installed Codex CLI catalog, including hidden
  entries, and only offers each model's advertised reasoning levels. MiMo retains
  its existing profile and low/medium/high selection. Live structured-routing
  checks passed for both GPT-6.1 Sol/low and MiMo/high, without host commands.
  Source suite723total/720pass/0fail/3 opt-in skips, lint/typecheck/package-install,
  native checksums and diff-check PASS. Log `/tmp/intent-model-settings-tests.log`.
  Updated archive SHA256:
  `75ef99bce7b87e6efb73ac65380b08db131f3b3ce1d9386b5ae7aad1b63dcf14`.
  CLI25706 closed normally; nine existing hosts and vault are preserved.

- Final local handoff checks: owner9789 closed normally after restoring MiMo/high.
  A separate actual-binary read-only console probe (existing vault, no new vault)
  passed token/origin/read-only enforcement, Ghost57/cleanup61 history, run25
  export and authenticated SSE. No known vault secret or private-key block was
  returned; execution journals were unchanged; console exited normally. Fresh
  read-only audit confirms84 ordinary application lifecycles plus three exact
  approved recovery lifecycles (Alma18/openSUSE39/Ubuntu42), total87. New archive
  SHA256 `ca5dacc0476d663cea63e5f297d4874bc419e85523380eab84dd7eb34f44ee74`
  includes the current source and packaged recovery documentation; Linux/x64
  package-install and all5 native checksums passed. Latest audit/checkpoint edits
  are not packaged source. No background remote job or CLI execution owner remains.

- COMPLETED Ghost cycle: task57 seven forward/four original separately approved
  rollback commands pass lifecycle assertions; task61 exact reviewed residue
  quarantine dispatched/completed once, no unknown. Independent final CLI-shell
  probes confirm `/var/lib/mysql` absent and its original directory preserved
  intact at `/var/lib/webminai/lab-recovery/ubuntu-ghost-task-57/mysql-after`,
  identity `66311:276302480:110:112:700`, parent root:root0700. Installed package
  name/version baseline hash matches; all Ghost managed paths/account/listener
  absent, old protected backups unchanged, Netdata active, dpkg audit clean.
  Saved task61 restoration was NOT executed and must not be run casually.
  Task60 was also rejected before dispatch because the generated final assertion
  included erroneous punctuation; neither59 nor60 mutated the host. Application
  coverage is now87/87 reviewed cycles, including reviewed recovery/cleanup,
  not unattended rollback or universal repeat/restoration proof. Aggregate182/183
  includes supplementary fixtures/maintenance; Ubuntu update is outside requested
  application scope. Normal binary9789 restored original MiMo/high. No remote
  work is running. Full branch release audit and universal repeat assertions,
  broad signed recovery profiles/key rotation remain explicitly unfinished.

- Latest continuation checks: full source suite720total/717pass/0fail/3 opt-in
  skips, lint/typecheck/package-install/native-checksums/diff-check PASS. Log:
  `/tmp/intent-linux-native-final-tests.log`. New Ghost baseline marker and
  rollback guard refuse success with newly created MySQL residue, preserving
  data and baseline; seven Ghost unit tests pass. Source changes do not rewrite
  task57's already approved/executed rollback. Inspector61092 and owner90700
  closed normally. Current owner9789 uses the same binary/vault and temporarily
  selected gpt-5.6-luna/low because MiMo cleanup planning timed out before dispatch.
  Task58 has zero dispatches; task59 was explicitly rejected (zero dispatches)
  after review caught decimal-versus-octal permission arithmetic. Corrected
  cleanup planning is pending. Restore original MiMo/high through the binary
  before final handoff. Do not infer cleanup completion from task57's reverted
  projection. Keep the exact residue identity and protected backups below.

- 2026-10-19 continuation: Ubuntu57 is now reverted after separate explicit
  approval of its four original rollback commands. Read-only journal audit
  confirms each rollback dispatched/completed once, no unknown outcomes; the
  original failed install and completed baseline remain immutable. Installed
  package name/version baseline SHA256 matches exactly before/after:
  `8eda8ad0b3fc87963fe733927525716d7e2cf5b8324d6312d9d0a3a69cb45305`.
  All Ghost app/runtime/content/credentials/unit/site/task-state paths are absent,
  port18110 has no listener, Ghost account is absent, nginx/mysql inactive,
  Netdata active. All four NodeSource repository/key/preference hashes and modes
  match; protected database directory identities are unchanged. HOWEVER the
  new MySQL data directory remains at /var/lib/mysql, identity
  `66311:276302480:110:112:700`. Do not count exact baseline restoration yet.
  Inspector61092 has submitted a normal-binary AI task for a guarded move to
  `/var/lib/webminai/lab-recovery/ubuntu-ghost-task-57/mysql-after`, never deletion.
  Planning is pending, not approved or dispatched. Review every generated guard
  before approval; do not execute its restoration rollback afterward. Owner90700
  remains idle at task57 operator controls. Application coverage remains86/87
  until residue handling and final assertions, not a silent87/87 claim.

- 2026-10-19 08:19: Ubuntu57 revision13 FORWARD WORK COMPLETED, all7 active
  commands completed exit0, zero unknown outcomes. Ghost acquisition
  cd92d3e53f5bcca74590f9ab45337311 finished; final verify job
  c158fb1aafe9dee5efe081c457990613, attempt
  a6282466-bc64-41de-ad8e-018142173848, completed once. Approved recipe verifies
  MySQL tables, HTTP marker/blog and service restart. Independent external GETs
  from the workspace returned WEBMINAI_GHOST_OK and HTTP200 for /blog/ on
  10.201.49.200:18110. Original baseline completed once; original install-stack
  exit100 still immutable in the journal. Owner90700 is at operator controls,
  no running remote job. Do NOT rerun the deployment. Next: inspector61092 is
  connecting via normal binary for read-only baseline/repository/package hashes
  and protected-data checks BEFORE the separately reviewed rollback. Ghost is
  still not counted until that rollback and cleanup probes complete. Original
  MiMo/high remains restored. Latest unfiltered tests719total/716pass/0fail/3skips;
  lint/typecheck/checksums/package-install pass, archive32f4c932 is current for
  packaged implementation (checkpoint edits do not affect it).

- 2026-10-19 08:09 live progress: revision13 package/runtime job
  884ff44230f120092cc1fb05bdeb1ab7 completed exit0 once, confirming missing-conffile
  repair, checksum-verified private Node22.23.1, MySQL8 and service startup.
  New credential generation and guarded database initialization also completed
  once. No baseline replay, no unknown outcome. Ghost acquisition now observed
  through durable job `cd92d3e53f5bcca74590f9ab45337311`, attempt
  `38a76804-140b-4955-919f-a2da59ea702d`. Owner90700 is still the only mutation
  owner. Do not duplicate that job or rollback while it runs. The source's old
  install-stack exit100 remains recorded. Ghost is still NOT counted as a pass.

- 2026-10-19 08:04: Ubuntu57 revision13 is explicitly APPROVED and separately
  RESUMED through the normal binary (owner90700). New local-catalog refresh was
  added to the shared controller and CLI after providers timed out or produced
  unsafe transcription. It performs no AI call, validates fresh inventory and
  local policy, preserves completed definitions/dependency closure and the EXACT
  original rollback, rejects unknown outcomes/route/version/host/rollback drift,
  and assigns pending work fresh IDs.55 controller/helper/UI tests passed; raw
  local CLI review now shows actual stored commands instead of public redacted
  browser projections, covered for all5 review paths. Browser output remains
  sanitized. Original MiMo/high settings restored through the binary; no temporary
  model setting remains. Owner3931 closed normally. The rejected AI proposal12
  stays unapproved; original approved snapshot is11, revision13 parent11. Readonly
  comparison proved ALL6 replacement definitions/dependencies exactly match the
  current catalog, baseline unchanged, original4 rollback definitions unchanged,
  ZERO new dispatch before approval, and approval alone remained paused. Resume
  was separately confirmed at08:04. New command IDs:
  install-stack-catalog-9d155fa959f7,
  generate-credentials-catalog-bcb8d4150196,
  initialize-database-catalog-1e9c2d1f81b6,
  install-ghost-catalog-b2631377652c,
  configure-ghost-catalog-e9bb4d230683,
  verify-ghost-catalog-60cb7967b057.
  Observe exact durable jobs; never replay an uncertain command. Ghost is NOT a
  pass until apply/health/restart and separately reviewed rollback complete. Source
  checks718total/715pass/0fail/3skips passed before the last added local-review
  regression (that test14/14PASS); latest npm test passed, lint/typecheck and
  package-install pass. Package32f4c932 includes current implementation; rebuild
  after any further packaged source/doc changes.
  Active package/runtime job884ff44230f120092cc1fb05bdeb1ab7, attempt
  118361da-80cd-4ec7-a5a9-abd30c32ad93, acknowledged once. Baseline was not replayed.

- 2026-10-19 07:30: MiMo/low remaining-work planning also timed out after300s;
  ZERO revisions created/approved and ZERO new task57 commands dispatched. Owner
  37961 is switching through the normal binary to gpt-5.6-luna/low for another
  reviewed planning attempt, then must restart to load the latest Ghost builder.
  Static regression also caught the non-root Ghost process being pointed into
  root-only task-state for npm cache: root installs now use root0700 state cache,
  Ghost gets its own0700 cache under its already owned data directory.6 Ghost
  tests pass. Source tests713total/710pass/0fail/3skips passed before that literal
  path fix and are refreshing in89865. Lint/typecheck pass. The new post-dispatch
  ledger failure test confirms local completed evidence survives, incomplete
  remote history blocks fresh recovery, and local continuation never redispatches
  the completed command. Native package-install checksum9ceee119 is now obsolete
  after the Ghost cache-path fix; rebuild before handoff. Intended final runtime
  settings remain original MiMo/high. Ubuntu MySQL is still inactive/partly
  configured; keep all quarantined/frozen data and the original failure history.

- 2026-10-19 07:17: remaining-work planning in71789 created ZERO revisions and
  dispatched ZERO new commands: the selected gpt-5.6-sol provider returned
  "Selected model is at capacity. Please try a different model." This was recorded
  in operator-events4551 but CLI showed a blank failure because stderr was empty.
  New regression reproduced it; planner now exposes the bounded redacted JSONL
  error (or exit code), without accepting partial output or automatic retry.
  Installed-Codex isolation/planner suite51/51 PASS. CLI now explicitly announces
  replacement planning and its separate approval/resume boundary. Current owner
  is changing to MiMo/low through the binary, then restart to load these fixes
  before resubmitting task57's six remaining catalog commands. Completed baseline
  and original confirmed failed job must remain immutable. No Ghost recovery
  revision is approved yet. Final intended model restoration is MiMo/high.

- 2026-10-19 07:12: Ubuntu57 install-stack job
  `9d5da3a1871c60fa8e399a16c65b248c`, attempt
  `47942e3c-0468-4048-8117-b141288a49cd`, CONFIRMED failed during dpkg
  configuration after package unpacking. Baseline completed once, no later Ghost
  command dispatched. CLI SSH read-only inspection identifies the explicit cause:
  missing `/etc/mysql/debian-start`, dpkg EOF at conffile prompt. mysql-server and
  mysql-server-8.0 are iU8.0.46; core ii8.0.46. MySQL inactive; new data directory
  identity66311:276302480:110:112:755. The quarantined test data and frozen original
  retain identities274219390 and261628643 respectively, no original was opened
  with MySQL. Adequate disk/inodes; no OOM conclusion. Do NOT replay the old job or
  call57 a pass. New catalog install preserves existing conffiles, restores missing
  ones, logs privately0600 and emits at most4000 final error bytes, keeping exit
  status. Regression failed before/passes after. Explicit dpkg conffile EOF now
  yields PACKAGE_CONFIGURATION_CONFLICT instead of CAUSE_UNKNOWN; successful
  warning output stays successful.55 focused tests pass. owner14818 closed
  normally; fresh71789 will propose reviewed remaining-work revision for57,
  preserving completed baseline and original failure history. Temporary sol/low
  remains. Full checks/package require refresh after these latest fixes.

- 2026-10-19 07:04 continuation: owner14818 (normal binary, existing vault) is
  executing Ubuntu57, selected directly from ghost-linux. Full7 forward and4
  rollback definitions matched the current native catalog byte-for-byte before
  explicit approval. Intervention is enabled. capture-baseline completed once;
  install-stack was just released at its normal safe boundary. Observe its
  durable job, never replay an uncertain command. Ghost is NOT counted yet.
  Source fixes also now accept signed execution_recovery events and retain the
  latest completed command's baseline through later non-mutating pause records.
  Reproducing integration regression failed on both defects before fixes; all22
  signed recovery tests pass afterward, including fresh-client proposal and zero
  replay. Current unfiltered suite709total/706pass/0fail/3opt-in skips; npm test
  rerun in34128. Temporary sol/low remains; restore original MiMo/high at handoff.
  Prior60854 and26724 owners closed normally, no other lab mutation is running.

- 2026-10-19 Ubuntu56 cleanup COMPLETED: all3 exact reviewed commands dispatched
  once with normal explicit approval and intervention boundaries. Data directory
  identity66311:274219390:110:112:755 moved intact to
  `/var/lib/webminai/lab-recovery/ubuntu-test-cleanup-20261019/mysql-test-remains`;
  original config and package baseline retained privately beside it. Explicitly
  listed MariaDB packages removed without purge/autoremove, mysql-common restored,
  owned start-policy/masks removed. Final dpkg audit/absence/process probes exit0.
  Older frozen originals were not touched. Saved guarded restoration was NOT run
  and requires fresh review, especially after Ghost; it is not full dependency
  version restoration.55 stays empty partial,54 planning timeout, neither passed.
  Ghost package tracking now distinguishes installed ii packages from residual
  rc entries as well as upgrades, with a failing-before/passing-after regression.
  Restart CLI before Ghost so it loads the updated builder. Temporary sol/low
  still needs restoration to original MiMo/high after all owners finish.

- 2026-10-19 native-only continuation: acceptance scope corrected to the README
  Linux-without-Docker application column:86/87 reviewed application/host cycles;
  Ubuntu Ghost alone remains pending. Platform/maintenance counts are separate.
  Debian42 applied the timer fixture once and43 completed its newly generated,
  explicitly approved signed recovery once. Both journals have one dispatch,
  one completion and zero unknowns. Remote execution
  `dad4075cb7dad52118d52220810137ff` verifies all9 signed records, ending
  rollback_completed. Independent CLI SSH probe confirmed both units, enablement
  link, runtime marker and task42 state absent; Netdata active; ledger/key root
  0700/0600 retained. Debian owner68369 closed normally.
  Ubuntu54 timed out during LOCAL planning, ZERO dispatch.55 is an empty partial
  proposal after the validator refused destructive cleanup without rollback,
  ZERO dispatch; neither is a test pass. Ubuntu owner21761 then safely rejected a
  stale settings save and exited1 without overwriting anything. Fresh60854 set
  temporary gpt-5.6-sol/low through the binary and is planning revised cleanup
  with a separately guarded restoration command. Original MiMo/high must be
  restored through a fresh binary after all owners finish. No Ubuntu cleanup or
  Ghost command has dispatched at this checkpoint. All four protected backup
  identities match the preceding checkpoint; MariaDB inactive, Netdata active.
  New regression reproduced Ghost rollback claiming upgraded pre-existing
  packages; package-name delta fixes both shared callers.47 focused tests pass.
  Baseline hashing now fails closed on per-file hash errors, with regression.
  Current full checks708total/705pass/0fail/3opt-in skips, installed-Codex boundary
  50/50, lint/typecheck/package-install/checksums pass. Package5f102869 is already
  superseded by subsequent packaged documentation; rebuild before final handoff.

- 2026-10-19 signed remote recovery continuation: the user superseded Ubuntu
  cleanup with the signed common-task-record feature. The exact cleanup proposal
  remains local task50 in planning with ZERO dispatch; no MariaDB cleanup/switch
  occurred. Ubuntu51 applied the service fixture, correctly refused unsafe
  recovery-baseline permissions, and completed separately reviewed ordinary
  rollback. New52 applied the fixed private marker; new53 completed its newly
  generated, explicitly reviewed signed-record recovery. Each forward/recovery
  command dispatched once, no unknown outcome. Signature chains verified before
  and after recovery; both fixtures' unit/runtime/state paths are absent.
  Persistent remote ledger/key remain intentionally, root0700/0600. The four
  protected database/config identities are unchanged, MariaDB inactive and
  Netdata active. Original MiMo/high settings were not changed. See
  remote-common-task-recovery.md for implementation scope and outstanding work.
  All CLI owners from this continuation exited normally; readonly audit shows
  ZERO running/reverting tasks and ZERO live execution leases. Full checks now
  707 total /704 passed /0 failed /3 opt-in skips, lint/typecheck pass. The new
  archive includes signed-recovery work and supersedes the older03:27 hash below.
  Final package/install/checksum checks PASS; archive SHA256
  `393adf4d271d4c06e62ee416ca0771f9cd83ec847268d2a475ff8d78f86bfbc2`.
  Coverage remains181/183; Ghost and Ubuntu update are not newly passed.

- Final cleanup:63706 also exited normally after restoring MiMo/high. All binary terminal sessions started in this continuation are closed; no background validation owner remains. Final archive checksum and git diff --check PASS.

- 03:27 handoff: **181/183** checked execution cases; remaining Ubuntu Ghost and its final update. **12 formal scoped repeat/restoration cases**, now across all9 hosts, pass; this is NOT universal restoration/repeat proof for all183 combinations. Current full source checks683total/680passed/0failed/3opt-in skips plus lint/typecheck/package-install/checksums pass. Application archive0d1c031c8734a3084fbde4a5c2cc0b6153765e679b53b5ba92c5327a25180f9c is current. All prior owners closed normally; fresh63706 restored original **mimo-v2.6-pro/high** through the binary and is quitting. Read-only audit:9 configured hosts, ZERO running/reverting tasks, ZERO live execution leases. No command from this continuation remains pending. Preserve historical unknowns and original backups.
- Next authority needed: safe Ghost environment. Async question offered a separate disposable Ubuntu host (preferred) or explicitly reviewed temporary MariaDB/MySQL switch with restoration. No answer received; DO NOT switch database engines, migrate or delete originals, change host isolation, or treat MariaDB as supported Ghost storage. Existing Ghost runtime code unchanged; its Node compatibility also needs actual safe-route testing. All other eligible applications and8non-Ubuntu updates passed. Do not repeat completed updates to refresh metadata; run27 already corrected Alma/Rocky release discovery read-only. See docs/linux-lab-branch-audit.md for tested branch boundaries and remaining release-signoff limits. No commits.

- 03:23 both formal apt cases COMPLETE: `node scripts/assert-cli-lifecycle.js /home/vscode/.intentaiops webminai-debian-13 37 38 39 40 41` and Ubuntu45/46/47/48/49 PASS. Each unchanged repeat is bracketed by equal probes; both separately reviewed rollbacks have fresh restoration probes equal to baseline. All approved/prepared/dispatched/completed attempts exactly once. Debian removed task-added htop3.4.1-5; Ubuntu preserved pre-existing htop. **12 formal scoped cases now pass across all9 lab hosts**, not all183 combinations or arbitrary whole-host state. No formal fixture remains deployed; no remote package/update job active.
- Read-only correction run27 COMPLETE: Alma45/Rocky37 exact reviewed shell, one dispatch each, both report current9.8 and published10.2. Original run26 install-current-release-updates dispatch remains exactly1 each, verified read-only. Original inaccurate reports/history remain immutable; correction is separate evidence. Owner54659 closed normally. All8 update cases now have package/report evidence, with corrections explicitly linked here. Coverage181/183 still; only Ubuntu Ghost and Ubuntu update remain, plus universal repeat/restoration and final release sign-off.
- Owners73569/41884 are closing normally after their final probes; then restore original mimo-v2.6-pro/high through a fresh binary before handoff. Never save settings from an older snapshot over this restoration. Ghost safe-route question remains unanswered; no database engine switch or new host/isolation change has been authorized. Current source checks683/680/0fail/3skips and archive0d1c031c8734a3084fbde4a5c2cc0b6153765e679b53b5ba92c5327a25180f9c remain current; only audit/checkpoint/matrix edits followed.

- 03:18 current full checks683total/680pass/0fail/3opt-in skips; lint/typecheck/package-install/5native checksums PASS. Current archive SHA2560d1c031c8734a3084fbde4a5c2cc0b6153765e679b53b5ba92c5327a25180f9c includes release-index version sorting and milestone docs. No source changes afterward. Native platform limitations unchanged.
- Read-only release correction owner54659 selected ONLY Alma/Rocky. Both routing decisions informed_planning/context-only for system-update-linux, not executable update foundations. Canary disabled because requests are strictly read-only. Run27 plans are being generated; compare each against releaseReportCorrectionCommand before approval, verify no writes/install/restarts/rollback and zero dispatch. Expected new tasks Alma45/Rocky37, confirm actual IDs. Original run26 package jobs must never be repeated.
- Formal apt cases: first-restoration probes Debian40 and Ubuntu48 completed once and match baseline37/45 byte-for-byte. Both original/repeated applies match exact public commands and before/after repeat digests. Debian39 second rollback completed once/no-op; Ubuntu47 second rollback at normal reviewed approval/execution in41884. Debian owner73569 opening AI editor for final probe41; Ubuntu final probe49 next. Only final probes/combined lifecycle assertions remain, do not count prematurely. Helpers debianAptFinalRestorationRequest/ubuntuAptFinalRestorationRequest preserve exact probe shells.

- 03:14 report-content audit caught an additional real bug despite exit0 updates: Alma/Rocky official version lists used lexical sort before tail10, hiding10.x behind9.x and causing incorrect AI statements that no newer major release exists. Regression with real shell/index fixtures failed before/pass after; only those2 Linux case arms now use sort -Vu. All24 common-task tests PASS. Original run26 plans/results remain immutable; do NOT rerun package updates. Need separately reviewed read-only official-release follow-up on Alma/Rocky and record corrections referencing run26 before calling their release reports correct. Native execution coverage remains181/183, but2 report-content checks are now explicitly pending. Full checks/package must rerun, archive6dafe is obsolete after this source change.
- Apt cases: Debian39 and Ubuntu47 reapply completed3/3 once, exact apply/rollback/probe policy comparisons passed and before/after digests identical. First reviewed rollbacks Debian38 and Ubuntu46 completed once; Debian purged only newly introduced htop3.4.1-5, Ubuntu preserved its pre-existing htop. Debian40 first-restoration probe matched exact source and is at approval/execution in73569; Ubuntu48 probe planning in41884. Keep second rollback39/47 pending until first-restoration probes finish, then review separately and run final probes41/49. Both formal cases remain uncounted until final assertions.

- 03:10 formal apt continuation: Debian37 baseline/38 original htop apply completed, each once; catalog38 matched source before approval. Debian39 proposed reapply matched EXACT original capture-install body/policies and rollback, bracketed by exact probe-before/probe-after; approved normally, now executing (owner73569). Ubuntu45 baseline/46 original apply completed once, exact plans verified; Ubuntu47 reapply planning in owner41884. Htop was already present on Ubuntu, so this case must preserve it; Debian38 actually installed htop3.4.1-5. Do not run first rollback until its repeated apply/probes complete. No formal case counted yet. All8 update owners/jobs finished,11603 closed. Ghost choice remains unanswered, no MySQL switch authorized.

- 03:05 run26 completed all8 updates AND all8 read-only AI summaries, owner11603 closed normally. No update job active. Existing coverage181/183. Extra formal apt cases: Debian baseline37 completed once, exact probe comparison and forward journal assertion PASS; original catalog38 matched current source before approval and is now executing htop (owner73569). Ubuntu baseline45 completed once, exact probe comparison and forward assertion PASS; owner41884 opening catalog to prepare expected46 install-htop. Both compare full dpkg name/version/architecture/status-set hash and exact selected htop/state-file hashes/modes/owners. They are not finished formal cases yet. Keep first apply deployed until its separately reviewed repeated apply/probes completes; then review each rollback independently with a restoration probe between them. Helpers debianAptRepeatFixture/ubuntuAptRepeatFixture and verifyAptProbePlanCode hold exact source/probe comparisons. Task36 on Debian remains harmless undispatched empty partial, never count it.

- 03:01 authoritative coverage **181/183**, Rocky21 added. All8 run26 hosts completed3/3 once/no unknown, forward assertions PASS. Fresh binary41884 independently confirmed Rocky SSH identity/active Stage2; final health gate approved. Run26 completed. Owner11603 is generating read-only AI summaries for all8 existing update tasks; no remote mutations remain. Owner41884 disconnecting Rocky, close from dashboard. Ubuntu Ghost and update are the2 remaining eligible combinations; full repeat/restoration assertions are separate unfinished work.
- Debian formal apt case input correction: task36 is PARTIAL with zero commands/results/journal/dispatch, NOT a test pass. The raw PTY submitted at an unintended newline before the probe shell; no host mutation occurred. Owner73569 resubmitted one-line exact probe as baseline37, predicting subsequent catalog38. Helper debianAptRepeatFixture now uses /var/lib/webminai/task-state/38-install-htop and source38 plan. Verify actual IDs/one-command plan before approval. No formal case mutation is approved yet. This was driver input, not evidence of a product shell-execution defect.

- 03:00 all8 run26 update hosts have now completed3/3 once/no unknown; Rocky36 forward assertion PASS with3 package updates. Owner11603 waits at FINAL batch4 health gate, do not approve until fresh Rocky SSH/Stage2 inspection. No remote update job active. Inspector73569 is now generating Debian36 ONE read-only baseline probe for an added apt repeat/restoration case, not executing package changes. Expected subsequent catalog task37 install-htop. Helper debianAptRepeatFixture holds exact probe and source37 plan; state is /var/lib/webminai/task-state/37-install-htop. Compare actual plan before approval and verify actual task IDs; do not assume prediction. Nothing for this formal case dispatched yet. Existing10 formal cases are still the only completed repeat/restoration assertions. Debian update35 is already finished, so no package overlap.

- 02:56 coverage **180/183**, Suse20/Oracle21 added, others unchanged. Suse49/Oracle36 completed3/3 once/no unknown; journal assertions PASS. Inspector73569 confirmed fresh SSH identity/active Stage2 on both before explicit batch3 gate approval. Owner11603 now executes final Rocky36 stage. No Ubuntu task active. Remaining3: Rocky update running, Ubuntu Ghost and Ubuntu update last. Universal repeat/restoration assertions and full release sign-off remain unfinished.
- Post44 read-only binary inspection PASS: all4 protected Ubuntu directory device/inode/owner/group/mode identities unchanged; MariaDB server AND core remain1:10.11.14-0ubuntu0.24.04.1; MariaDB inactive, Netdata active. Mattermost44 state/app/temp-app/data/credentials/unit/links/vhosts/account absent, task-created PostgreSQL root absent. Previous Odoo/Moodle/Presta cleanup still passes. The frozen original was not started or modified. Inspector73569 now on Oracle menu after health verification.
- All current checks PASS after Kubernetes identity fix: npm test682total/679pass/0fail/3opt-in skips; lint/typecheck/package-install/5 native checksums/diff whitespace PASS. Current SHA2566dafe02c1fbb2781061098f99f3bae55795a061eba798dda98b2912ea32ca1cd. Installed-Codex opt-in explicitly rerun50/50 PASS, SSH31pass/1real-host skip, FreeBSD compatibility compile PASS (existing static-glibc linker warnings). New audit/checkpoint/matrix are not packaged files. Async user choice requested for safe Ghost lab route; no response yet and no database switch authorized.

- 02:49 coverage **178/183**, Debian21/Fedora20 added, other counts unchanged. Debian35/Fedora32 update3/3 once/no unknown; journal assertions PASS. Debian2 package updates, Fedora9. Inspector73569 verified fresh SSH identity/active Stage2 on each before explicit batch2 health approval. Run26 owner11603 now executes Suse49/Oracle36; Rocky36 remains gated. Inspector73569 disconnecting Fedora, available for next read-only inspections. No Ubuntu task active; original model restoration pending until owners finish.
- Branch evidence ledger added at docs/linux-lab-branch-audit.md, explicitly not full release sign-off. Continued audit reproduced Kubernetes previous OOM termination being labeled with the current replacement container ID. Verified official ContainerStateTerminated.containerID contract; fixed shared projection to use termination's own ID and omit absent identity, leaving current waiting-state identity separate. Regression failed before/pass after; diagnostic tests13/13 PASS, real Kubernetes remains unavailable. Source/doc changes make cd730252 archive obsolete, rerun full checks/package before handoff. No gateway permission or native protocol/build change for this JavaScript fix.

- 02:45 coverage **176/183**, Alpine16/Arch20 added; other counts unchanged. Run26 Alpine37 and Arch35 completed3/3 once/no unknown, forward journal assertions PASS. Alpine libexpat updated2.8.5→2.9.0; Arch8 package updates including OpenSSH/systemd. Arch udev hook emitted container sysfs permission warnings, pacman exit0; no isolation change. Inspector73569 connected both normally after updates, independently confirming SSH identity and active Stage2 before explicit batch1 gate approval. Run26 owner11603 now releases Debian35/Fedora32 batch2,5hosts pending overall. Owner46377 closed normally after Ubuntu44 cleanup. Inspector73569 currently on Arch host menu; next close normally or use read-only inspection. No Ubuntu task active. Remaining7: Ubuntu Ghost plus Debian/Fedora/Suse/Oracle/Rocky/Ubuntu updates. Protected Ubuntu baseline still needs post44 inspection; never run its update before Ghost/baseline resolution.

- 02:42 authoritative coverage **174/183**: Alma21, Alpine15, Arch19, Debian20, Fedora19, Suse19, Oracle20, Rocky20, Ubuntu21. Ubuntu44 revision10 completed7 forward and4 separately reviewed original cleanup commands, each once/no unknown. Declared-retry/approved-revision lifecycle checker PASS. Owner46377 now leaving controls, close normally before any new proposals so it loads the latest rollback-evidence fix next time. Empty9 remains unapproved.
- Alma44 update canary completed3/3, once/no unknown; forward journal checker PASS. Report records exactly libbson and mongo-c-driver-libs upgraded1.30.12→1.30.13, no reboot/release upgrade. Inspector73569 reconnected through normal binary AFTER completion and verified host identity/active Stage2. Explicit health gate approved; run26 batch1 now executes Alpine37 and Arch35. Remaining Debian35/Fedora32/Suse49/Oracle36/Rocky36 still gated. Ubuntu44 acquisition reached exact411962109bytes, no OOM kills; final native checksum/application health/restart verification and cleanup then passed. Remaining9: Ubuntu Ghost and8updates, including7 selected pending in26 plus Ubuntu last.

- 02:40 full current-source checks PASS: npm test681total/678pass/0fail/3opt-in skips, lint, typecheck, package-install,5 native checksums, git diff --check. Current application SHA256cd730252b224482208b3a72d2e69686cf7c2a5b594e45ac4d5275233e12e5829. Two revised-rollback evidence tests PASS, including rejection of an unapproved diagnostic template. Existing owners do not load this later reconciliation fix until restarted; no uncertain job currently needs reconciliation.
- Fresh bulk read-only journal audit verified160 ordinary reverted catalog cases. All3 exceptions then passed explicit reviewed-cleanup assertions: Alma PrestaShop18/revision3 (original unknown retained, failed operator attestation, original dispatch once), openSUSE Drupal39/revision6 (original confirmed exit1 retained, original dispatch once), Ubuntu Odoo42/revision7 (original unknown retained/failed attestation). All9 health task forward assertions also PASS: Alma8, Alpine7, Arch13, Debian8, Fedora6, Suse18, Oracle8, Rocky8, Ubuntu11. This independently confirms172/183 execution lifecycle cases, NOT universal repeated/baseline guarantees.
- Inspector73569 performed read-only Alma SSH inspection through the binary: update log640bytes, latest metadata refresh02:28:24; cgroup oom/oom_kill0, disk42%used. No evidence of OOM and no reason to replay. It disconnected Alma and now connects Ubuntu for read-only acquisition inspection. Owner11603 still has canary update44 running; owner46377 Ubuntu44 acquisition running after4 confirmed commands. Later update stages remain undispatched.

- 02:36 branch audit found and fixed revised-rollback reconciliation losing its diagnostic command: lookup previously searched only original revertCommands. A deterministic interrupted-job fixture failed before/pass after. Collectors now resolve the exact approved rollback-plan fingerprint; an unapproved proposal is ignored. Existing original revert-plan construction is shared with execution to preserve its fingerprint. Two new cases PASS; focused execution/admin/controller66/66 PASS before adding the unapproved case. No replay or approval change. Owners11603/46377 remain running older code, finish their owned jobs before restart. Archive5c41a150 is now OBSOLETE after this source/doc change; full checks/repackage rerunning. Alma44 update and Ubuntu44 acquisition are acknowledged running, no unknown; no later update stages dispatched yet.

- 02:30 run26 staged system-update-linux approved after exact current-catalog comparison of all24 commands on8 hosts, ZERO prior dispatch: Alma44 canary, Alpine37, Arch35, Debian35, Fedora32, openSUSE49, Oracle36, Rocky36. Owner11603. Ubuntu excluded because its app work remains. Same-release updates only, no reboot/release upgrade, explicitly one-way with no invented rollback. Canary running; later batches require explicit health gates. Do not duplicate or replay interrupted update commands.
- Ubuntu44 proposal10 reviewed against current7 templates and original4 rollback bodies. Only additional shell differences: non-printing `IFS= read -r password` in3 commands instead of cat substitution, and credentials-ready message instead of printing its path; generated password is newline-terminated. Explicitly reviewed these equivalent changes; all other bodies, dependencies, risks, modes, retry policies and timeouts match. Original rollback unchanged; source correctly AI-planned, fixed allowlisted diagnostic annotations, no failure handlers. Approval submitted in46377, separate resume still required. Historical empty9 remains unapproved. No44dispatch at comparison.
- Latest checks679total/676pass/0fail/3opt-in skips; lint/typecheck/package-install and all5 native checksums PASS. Current archive SHA2565c41a15006c121355973ae3ff7de85e801cdfbaa02db88b7e2beba62cd54c66c. Installed-Codex opt-in50/50 previously passed after fixes. Checkpoint/matrix are not packaged files.

- 02:22 continuation: authoritative coverage **172/183**, Rocky20 and all other host counts unchanged from171. Rocky WordPress35 passed10 forward/3 separately reviewed cleanup commands, each once with no unknown; lifecycle assertion PASS. Owner72650 closed normally. Fresh owner46377 loads planner fixes and submitted ubuntu44RevisionInstructionsV2 through normal task44 revision controls. Task44 remains undispatched; compare every proposed body/policy/dependency and original rollback before approval, then separately resume. Empty historical proposal remains unapproved. Full unfiltered tests93721 and lint/typecheck/package-install17481 are running after the latest source/docs changes. Remaining11: Ubuntu Mattermost44, Ubuntu Ghost and9updates last. Universal repeat/baseline assertions and full branch audit remain unfinished.

- 02:11 new live finding: Ubuntu44 AI revision correctly refused because generic redaction removed the public Mattermost digest and symbolic credential-reader fragments. Empty proposal was explicitly REJECTED, original plan unchanged, ZERO44dispatch. It remains an unapproved historical revision, never approve it. Fixed planner context by passing saved task catalogId through controller/AdminService, then rebuilding public command templates inside CodexPlanner from current application code and sanitized host inventory. Historical outputs, passwords and arbitrary64hex remain redacted. No raw historical payload is unredacted. Added guards rejecting new empty replacement proposals AND fresh approval of older empty proposals. Three boundary-forwarding regressions and two empty-proposal cases failed before/pass after as applicable; focused/full final reruns are in progress. Last9d4f52archive is now OBSOLETE and needs rebuilding after these source changes.
- Rocky WordPress35 completed10/10, forward approval/attempt checker PASS. Owner72650 is reviewing separate3-command cleanup; not yet counted. Ubuntu owner21988 still loads OLD planner and must close/restart before any further proposal. Revised instructions should reference Current verified catalog templates, not insist on copying redacted old shell bodies. Helpers ubuntu44ExpectedRevisedCommands still define exact desired7bodies/dependencies and original rollback. All3 run25 Mattermost lifecycle passes already counted171/183; no remote job currently active.

- 01:53 authoritative coverage **171/183**: Alma20, Alpine15, Arch19, Debian20, Fedora19, openSUSE19, Oracle20, Rocky19, Ubuntu20. Run25 Debian34/Oracle35/Rocky34 all reverted through normal consolidated review of12 cleanup commands, Ubuntu44 explicitly excluded. Each7 forward/4 rollback once, approved/prepared/dispatched/completed; lifecycle assertions PASS, no unknown. PostgreSQL identity guards passed creation and removal on all3. Oracle pause/resume preserved5 completed commands and dispatched only2 pending. No active remote jobs. Remaining12: Ubuntu Mattermost44, Rocky WordPress, Ubuntu Ghost,9updates last; stronger universal repeat/baseline assertions and full branch audit remain unfinished.
- Only21988 remains open, returned to dashboard after cleanup. Next: connect Ubuntu, history44, normal operator proposal with ubuntu44RevisionInstructions; compare all7 pending bodies/policies/dependencies and original rollback with ubuntu44ExpectedRevisedCommands before approving, then separately resume. Task44 currently has ZERO dispatch. Ghost runtime remains unchanged pending actual compatibility testing and a safe MySQL lab route; no assumption authorizes modifying protected MariaDB originals.

- 01:44 Oracle35 reviewed resume COMPLETED: configure/verify succeeded, all7 forward commands approved/prepared/dispatched/completed exactly ONCE, no unknown. Forward journal checker PASS. Pause preserved first5 results without replay. Run25 now has Debian34/Oracle35/Rocky34 completed and deployed; Ubuntu44 planned/undispatched. Fresh21988 is returning to dashboard to review cleanup of ONLY those3 completed hosts, then revise pending Ubuntu44 with fixed acquisition. Coverage remains168 until cleanup is confirmed. No active remote jobs now; all earlier owners closed.

- 01:40 update: old run25 finished PARTIAL safely. Rocky34 COMPLETED7/7, original download ultimately verified despite recorded curl18/56 warnings; forward journal checker PASS. Oracle35 completed acquisition successfully, then honored the reviewed pause BEFORE configure/verify: exactly5 completed/once, no unknown, no extra retry. Ubuntu44 remained planned with ZERO dispatch; no later stage ran. Owners26776/84026/2946 closed normally. Fresh binary21988 (loads download fix) is on Oracle to review/resume ONLY its2pending commands, then will revise Ubuntu44 before dispatch. Debian34/Rocky34 still deployed pending reviewed cleanup; no run25 case counted yet.
- Ubuntu44 fixed proposal helpers prepared from current source and readonly normal-vault data: ubuntu44OriginalPlan, ubuntu44FixedCatalogPlan, ubuntu44ExpectedRevisedCommands, ubuntu44RevisionInstructions. Instructions2932characters preserve all7pending bodies except fixed acquisition, use reviewed-ORIGINAL_ID-44 IDs/remapped dependencies, preserve original rollback and all risk/timeouts/modes/retry. Compare every body/policy before fresh approval; do not assume AI reproduced it. No Ubuntu revision approved yet.

- 01:36 current continuation: fixed a reproduced Mattermost acquisition bug rather than removing support. Rocky job progress for ce2da57206781f679b44a29649c0d508 contained allowlisted curl18/56 and connection-reset evidence, not OOM. A local real-HTTP truncation fixture proved curl internal retries repeated offset131072 instead of retained offsets196608/262144. New native acquisition uses up to6 fresh curl processes, recomputes resume offset, bounds connection15s/transfer600s/size, retries only enumerated transient codes, and still verifies pinned SHA256 before extraction. Tests cover retained partial progress,6-attempt cap, corrupt checksum rejection and non-retried HTTP404. No native protocol change or new dependency.
- Current full checks PASS after the download fix: npm test, independent node --test675total/672pass/0fail/3opt-in skips, lint, typecheck and package-install. Current archive SHA2569d4f52de0d2ffc4d94398d9b3b57e3b2ae3a4a4fb1f77937451168ea95c8f89c includes milestone documentation. Existing approved run25 plans remain OLD and unchanged. New code cannot silently change their live commands.
- Owner26776 still runs run25; Oracle35/Rocky34 acquisitions remain active. New owner84026 used normal operator controls to pause Oracle35 at a safe boundary at01:35. This does not terminate its running download. It prevents another old-plan declared attempt after a confirmed timeout. Next pause Rocky34 similarly, wait for authoritative outcomes and lease release, then propose/review only remaining work with fixed acquisition and NEW IDs. Preserve4 completed commands and PostgreSQL identity markers. Do not resolve an active acknowledged job by attestation, cancel it via arbitrary shell, replay uncertain work or approve old pending Ubuntu44 before reviewing the fixed acquisition. Current84026 loads pre-fix builders; restart before generating replacement plans.

- 2026-10-19 01:19 continuation: user requires retaining all main-supported software/routes and fixing setup rather than dropping support. HEAD is now983ff09 (user commit), prior work preserved. Added common-tasks regression covering all87 promoted native Linux application routes, validated plans and refusal to substitute no-change compatibility reports. Focused23/23PASS; npm test PASS; independent node --test670total/667pass/0fail/3opt-in skips; lint/typecheck/diff whitespace PASS. No production source changes in this continuation yet, archive unchanged.
- Run25 still active in26776: Oracle35 and Rocky34 both completed4 commands and are acquiring Mattermost, no uncertain outcome. Inspector75340 observed Oracle archive121839616bytes at01:13:35 and Rocky228114432bytes at01:16:07 with current modification timestamps, disk42%used, oom/oom_kill0. Both downloads were progressing; do not restart them. Inspector is closing normally. Its host refresh makes a fresh owner advisable for later settings-sensitive actions. Debian34 remains deployed, Ubuntu44 still gated.
- Ghost investigation: its current setup requires exact Node22 and attempts a global NodeSource install, which can fail with existing newer Node. A private Node22 runtime was proposed, but NO Ghost runtime source changes implemented yet. User challenged necessity; verified actual npm metadata: ghost6.57.0 engines.node='^22.23.1' (excludes24), while ghost-cli1.29.1 accepts20/22/24. Official https://docs.ghost.org/faq/node-versions/ also marks23+ unsupported. Official Node22.23.1 archive checksums retrieved successfully; linux-x64 tar.gz7a8cb04b4a1df4eaf432125324b81b29a088e73570a23259a8de1c65d07fc129, linux-arm64 tar.gz543fa39e57d4c07855939459a323f4deb9a79dd1bb45e6e99458b0f2de10db8d. Do not silently downgrade system Node or assume24 works. Async user choice for disposable Ghost host versus reviewed temporary MariaDB/MySQL lab switch remains unanswered. Existing protected data unchanged.

- Active run25: binary26776 owns approved staged Mattermost deployment on Debian34 (canary), Oracle35, Rocky34 and Ubuntu44, batchSize2/failureThreshold1. All4 plans exactly matched current catalog commands/rollback/files before approval, zero dispatch. Normal consolidated approval granted28 commands. Wait for canary and stages; do not start duplicate tasks. Each still needs observed completion, separately reviewed rollback and journal/cleanup assertions before counting. Source archive/checks unchanged since last full verification; subsequent edits are checkpoint/matrix only.
- Latest00:48: Oracle35 acknowledged install-stack running, only baseline completed; Rocky34 completed first4 commands and acknowledged install-mattermost running; Ubuntu44 planned with ZERO dispatch. No unknown outcome on any run25 task. Debian34 remains deployed and completed. Poll26776; next stage needs explicit health-gate confirmation. After all stages, close26776 normally and reopen a fresh binary before settings-sensitive actions (inspector refreshed settings), then separately review rollback for every completed host. Partial failure requires its own reviewed recovery, not blind saved rollback. Do not count any run25 host until cleanup assertions pass.
- 00:46 canary Debian34 COMPLETED7/7 exit0, each approved/prepared/dispatched/completed once, no unknown. Forward-only assertCliTaskExecutionEvidence PASS. Exact catalog verification checked API health, version, PostgreSQL tables, nginx marker/API and restart recovery. Explicit canary health gate approved; batch1 Oracle35/Rocky34 now executing, Ubuntu44 still pending. Debian still deployed until separately reviewed rollback; coverage remains168/183. verifyCompletedForwardCode stores the read-only checker. No acquisition retry was needed on Debian.
- 00:41 read-only binary37912 inspection: Debian archive228581376/411962109bytes, current modification timestamp, curl PID85795 elapsed330seconds, cgroup oom/oom_kill0, filesystem42%used. Acquisition is progressing, not a proven stall. Inspector makes no remote changes and is closing normally; close run owner26776 after completion before further settings mutations, since inspector refreshed host settings. Do not interrupt or duplicate the download.

- Before run25, binary SSH preflights on all4 confirmed2GiB limits, no existing PostgreSQL data roots, no Mattermost owned paths/account, inactive/not-found PG. OOM counters0 (Oracle max220/Ubuntu max2382 are context, not kill evidence). Ubuntu protected4directory identities/package version and Odoo/Moodle/Presta cleanup rechecked PASS. At00:38 Debian34 has4 completed commands; install-mattermost is acknowledged running, no unknown outcome. Other3 hosts remain gated.

- Coverage **168/183**, Arch19/Ubuntu20; other host counts unchanged. All9 CLI installation cases pass. Ubuntu CLI43 passed2 forward/1 reviewed rollback, single approved attempts, read-only journal assertion PASS. Arch34 revision5 completed3 current forward/1 reviewed rollback; approved-revision evidence checker PASS. Binary SSH confirmed system Node22.23.3 unchanged and root/links/state/private runtime absent. Odoo42 is reverted through separately approved rollback revision7. All7 forward and4 new cleanup commands passed attempt-bound journal assertions. Original uncertain stop dispatched once, its unknown event remains, and operator attestation records failed or partially applied without claiming a native exit. No automatic replay occurred.
- Binary SSH inspection after cleanup confirmed all4 protected MariaDB directory identities and exact package version unchanged. Odoo state, application, credentials, configuration, unit/vhost links and task-created PostgreSQL data are absent. Pre-existing postgresql-client-common remains, MariaDB inactive and Netdata active.
- Native collector live idle check passed over131seconds with unchanged PID/start identity and fresh chart samples. All9 hosts now have the rebuilt artifact: Ubuntu individually and the other8 through reviewed plugin-only fleet update, all healthy and Netdata preserved. Owners89381/61499 closed normally; only26776 owns current run25.
- Ghost ownership guards are now fixed and tested: exclusive MySQL namespace creation, separate user binding, guarded cleanup, missing/symlinked state and dangling target refusal. Defaults preserve existing PHP callers. Native Ghost still requires MySQL8 and cannot safely use protected Ubuntu MariaDB. A separate disposable compatible host or working Docker route is needed; no migration or isolation change is authorized.
- Final current-source checks PASS: npm test and independent node --test **669total/666passed/0failed/3opt-in skips**, lint, typecheck, package-install,5native checksums and diff whitespace. Package SHA256 **28388d21f245c7396557d2a11b8c0ff5c992035ae47136299254dadab25180e8**. Native cross-platform limitations below remain.
- Additional current-source checks: SSH32total/31pass/1real-host opt-in skip; FreeBSD compatibility compile PASS; installed-Codex boundary opt-in explicitly enabled, planner49/49PASS with local fixture provider. This does not count the direct-service Linux integration harness, which remains skipped because live mutations must use the binary. Inspector37912 closed normally, leaving run owner26776 only.
- Remaining15: Mattermost4 in run25, Rocky WordPress, Ubuntu Ghost and9system updates last. Ten formal scoped repeat/restoration cases pass; universal repeated/baseline assertions and full branch audit remain unfinished. Existing vault and masked VAULT_TEST only. Temporary model gpt-5.6-sol/low, restore original mimo-v2.6-pro/high before final handoff.
- Arch34 recovery is FINISHED: revision5 preserved completed baseline and confirmed failed history, created checksum-verified Node24.16.0 only in task state, installed using child PATH, then separately reviewed cleanup removed it. System Node22.23.3 stayed unchanged. Original partial saved rollback was refused before dispatch; after reviewed replacement completed, cumulative rollback succeeded. Helpers arch34OriginalPlan/RecoveryCommands/RecoveryInstructions/RecoveryProposed/RecoveryRevision retain comparison evidence. No further Arch34 action is needed.

## Earlier continuation (historical, current instructions are above)

### Earlier owner and recovery sequence

- **Only binary89381 is open**, on Ubuntu. It installed the rebuilt native collector through normal plugin-only update; confirmed `updated 0.7.2 to0.7.2` and signed health active. It is returning to the host menu. Next: enter its SSH shell, record plugin PID/start identity and artifact digest, leave Netdata function calls idle for more than120seconds, verify the same collector survives with fresh status samples. Do not claim live keepalive validation before that check.
- **Live keepalive PASS23:49:** binary SSH-only observation, no function calls between23:47:00 and23:49:11 (131seconds). Collector PID26052/start23:44:24 unchanged, age155 to286seconds; installed artifact SHA256fdeba536bff903ba6d6886f1f84b43d3455e1960909353f170e4e028de4c8396 matches rebuilt Linux binary. Status samples stayed fresh/value1. No native collector restart. This does NOT reconcile Odoo's historical unknown rollback.89381 is rechecking its task PID/unit/vhost evidence before normal operator recovery controls.
- **Ubuntu Odoo42 is still deployed and cleanup is uncertain.** All7forward commands passed. First direct rollback stop-odoo request at16:57:39 returned Netdata HTTP503/exitCode null, journaled command_outcome_unknown; no later rollback step dispatched. Task is revert_failed. Never replay original rollback, overwrite its plan/history, or infer success from the collector fix.
- Independent binary SSH inspection repeatedly found original Odoo PID24697 active/enabled since16:51:30, unchanged task-unit261402493, enable-link261402494, vhost261402495/link261402496 with16:51timestamps. PG marker equals authoritative SQL `7698048467220114500|16389|16390|16389`; task healthHTTP200 before attempted cleanup. Those observations show requested stop postconditions are unmet, not proof of zero partial effects. No operator attestation submitted. Reconcile/review conservatively, then use separately reviewed remaining cleanup if evidence permits.
- **23:53:** Through normal binary controls, selected original stop-odoo/rollback and explicitly attested Failed or partially applied using the independent unmet-postcondition evidence above, including inability to infer native exit or exclude partial effects. This appended reviewed failed outcome, executed NOTHING and retained original unknown/HTTP503 history. Next propose ONLY new reviewed4-command rollback, not replay original. Stored ubuntuOdoo42OriginalPlan/CleanupExpected/CleanupInstructions retain exact original4rollback bodies with new reviewed-*-42 IDs/dependencies and original risks/timeouts; no MySQL/recovery/original data changes allowed. No cleanup proposal approved yet.
- **23:57:** Odoo42 reviewed rollback revision7 compared before approval: original forward plan unchanged; exact4original cleanup bodies/risk/timeouts/modes/dependencies with new reviewed-*-42 IDs (only equivalent printf newline quoting differs). Original stop-odoo dispatch ONCE, unknown event retained, reviewed failed/partial attestation retained, ZERO new cleanup dispatch before approval. Approved7; execution still needs separate Review rollback confirmation. This is not an automatic replay. Meanwhile2new Ghost native unowned-namespace regression tests fail as expected before the pending ownership fix; current full suite is temporarily red until fixed. Do not run Ghost or claim final package/checks after those pending edits.
- Netdata collector/daemon allowlisted log observations show read timeout/errno110 at16:57:39.410, followed by collector disconnects, matching failed API request16:57:39.518. Cgroup oom/oom_kill0; max2382 is context, not OOM proof. Source collector emitted one chart sample then blocked awaiting input. New C keepalive uses async-signal-safe write/alarm every15seconds, masks heartbeat across complete JSON frames and restores its handler on exit. Signed protocol/results unchanged. No command retry introduced.
- Native regression failed before/pass after (idle sample plus heartbeat during signed direct command). An immediate-SIGKILL test race was fixed by bounded status polling, not replay. Linux/Kubernetes rebuilt, FreeBSD compatibility compile passed; actual other native releases and unchanged Windows collector unverified. Release remains0.7.2; remote installer461 compares bytes and positively installed changed Linux artifact. Other8lab hosts still need the new collector through normal plugin update after Ubuntu validation.
- **Arch formal case29/30/31/32/33 PASS**: first30 and exact repeated31 approved, identical repeat probes, first rollback30, exact restoration probe32, second rollback31, exact restoration probe33. Full attempt-bound checker passed; readiness retries only confirmed exit75. All paths/package/service hashes restored to29. Both tasks reverted, owner64114 closed. No Arch task remains deployed.
- All older owners closed normally:47650,23604,38388,38877,15350,29367,42377 and earlier ones. Fresh native artifact installation is the only remote change after those closed. Existing vault/masked VAULT_TEST only; no direct mutation harness, test vault, history edits or approval bypass.
- **Do not run Ghost yet.** Its native MySQL namespace setup/drop lacks the shared ownership guard (CREATE IF NOT EXISTS/ALTER USER and unguarded DROP). Fix/regress before approval. Native MySQL8 also conflicts with protected Ubuntu MariaDB; no migration/deletion or host-isolation change is authorized. No Ghost task approved in this continuation.
- Temporary model remains gpt-5.6-sol/low; restore original mimo-v2.6-pro/high through the binary before final handoff, after stale owners close. Full branch audit remains unfinished. Keep every protected original below.

### Current coverage and verified checks

- **165/183** distinct reviewed health/apply-and-rollback cases: Alma20, Alpine15, Arch18, Debian19, Fedora19, openSUSE19, Oracle19, Rocky18, Ubuntu18. All78system fixtures, all9health, all9Drupal, all9PrestaShop and all9Moodle cycles pass. These are lifecycle observations, not universal formal/full-host restoration.
- Remaining18: CLI2 (Arch/Ubuntu), Mattermost4 (Debian/Oracle/Rocky/Ubuntu), Ubuntu Odoo/Ghost, Rocky WordPress and9system updates. Odoo42 is NOT counted until safe cleanup. Updates remain last, reviewed one-way exceptions.
- **Ten formal scoped repeat/restoration cases PASS**: Fedora htop22/23/24/25/27; Suse htop23/24/25/26/27; Alma htop21/22/23/24/25; Oracle htop16/17/19/20/21; Suse Moodle41/42/45/46/47; Alma jq26/27/28/29/30; Alpine Moodle16/17/18/19/20; Rocky htop17/18/19/20/21; Alpine Drupal21/22/24/25/26; Arch Moodle29/30/31/32/33. Credential paths, recursive directory contents and transient one-shot states are excluded.
- Latest current-source checks: npm test **665total/662passed/0failed/3opt-in skips**, independently confirmed by unfiltered node --test. Lint/typecheck/package-install/all5native checksums/git diff --check PASS. Native/controller isolation43/43PASS; lifecycle evidence36/36PASS. Installed Codex isolation and SSH31pass/1skip passed earlier, before unrelated collector changes.
- Current package SHA256 **f29b6a6db6e02ed263c04d6a5718585418621d835fa62ff1832438675682a2a9** includes collector fix/docs. Native Linux/Kubernetes builds changed, other target release artifacts unchanged; no cross-platform live claim. Existing linker warnings unchanged.
- Fresh latest cycles: CLI Alma43/Alpine36 (run22), Debian33/Oracle34/Rocky33 (run23), Fedora31 all reverted2forward/1rollback once. Suse48 reviewed recovery9 reverted4current forward/1rollback, original two confirmed network failures retained. PrestaShop run19 all6reverted plus Arch28, all9cases pass. Drupal run18 all4reverted after reviewed Arch27 recovery, all9cases pass.
- Moodle run20 Debian32/Oracle33/Rocky32/Ubuntu41 reverted13forward/4rollback with declared readiness attempts8/6/8/13. Fedora30 recovered through approved revision3 HTTP/1.1, preserving completed baseline/packages; original confirmed HTTP/2 acquisition failure and rejected unapproved revision2 retained. Readiness12attempts, reviewed4rollback passed. Run20 aggregate asserted reverted. Exported existing assertCliTaskExecutionEvidence validates these retries without weakening single-attempt/revision/approval evidence.
- POSIX CLI launcher/root/symlink rollback, staged SHA256/curl acquisition, child-only Node5000ms family window/private npm cache and correct no-database/no-container routing foundations all have failing-before/passing-after regressions and live evidence. PostgreSQL guard has13fixtures and positive Alma41 creation/identity/drop; Odoo42 creation/identity passed but cleanup unresolved. Do not rewrite approved histories.
- HEAD a71c69a56b805ed4d93185f699866ee1c4cf7d37; main fe55614b5ef780dbae582008103a0e905e41cdd2. Preserve dirty user worktree, no commits. No measured SSH performance claim.

### Latest fixes and evidence limitations

- Retry descendants cannot acquire execution while an ancestor is uncertain or legacy-interrupted without journal evidence. Linked retry families share leases inside the existing IMMEDIATE SQLite transaction; unrelated roots remain independent. Additive parent index, bounded100-task chains/1000-task families, cycle rejection. Four regressions include real AdminService rejection before a mock remote call. This does not infer intent links between separately created unrelated tasks.
- All7 shared system-fixture callers reject symlinked apply targets and missing/symlinked rollback state. Service/timer also reject existing runtime markers before capturing state. Three failing-before/passing-after shell regressions, all62 focused catalog/recovery testsPASS, positive live Alma/Debian cycles. Existing saved histories are immutable.
- Explicit missing-path errors yield sanitized PATH_NOT_FOUND, explicit cleanup ownership failures yield OWNERSHIP_UNCONFIRMED, and exact target-preservation refusals yield TARGET_CONFLICT rather than CAUSE_UNKNOWN. Known-secret/private-path and successful-warning regressions pass. Old28 diagnostics are not rewritten; new29581 loads the final reason.
- Native PHP cleanup preserves later unowned files when task state is missing; all6 caller fixtures, Moodle data root and shared Arch nginx config are covered. It cannot prove ownership of arbitrary external replacements while task state survives.
- Loop fingerprints ignore structured job/attempt/time/PID metadata after redaction, without mutating evidence. Repeated identical failures no longer evade detection just by changing job IDs. Changed diagnostics/progress still prevent false alarms. Raw log timestamps are not generically stripped.
- CLI can review an existing pending revision without regenerating it; canonical fingerprints/differences are exposed through the shared controller. Explicit approval alone leaves pause/no execution; separate reviewed resume is required. Authenticated HTTP fixture also rejects missing consent/stale repeats. Actual Alpine Moodle17 approved revision2, preserved7 completed definitions, executed6 new IDs and retained the original confirmed nginx failure.
- AI retry schema now preserves the existing bounded retry contract, including nullable normalization. Actual openSUSE45 preserved the73-attempt read-only waiter; uncertain outcomes are never retried. Offline lifecycle checker validates bounded approved historical revisions and rejects discarded completed/uncertain history; multi-attempt dropped failures remain unsupported.
- Alpine Moodle uses vendor OpenRC nginx checkconfig before reload/start, verified through the binary SSH shell. Cron ownership/PID guards never blindly signal a pidfile process. Automatic cancellation of a live OpenRC installer remains unsupported.
- Multi-host attempt61152 was stopped BEFORE run creation/planning/dispatch: AI routing intentionally excludes lab system fixtures despite their single-host picker flag. No generic AI substitute was approved. Continue these through the single-host verified picker.
- Ubuntu Netdata was disabled/inactive, Result=success/status0/NRestarts0;2GiB cgroup memory event counters were0. No OOM conclusion. Explicit binary plugin-only activation preserved Netdata and restored observed active Stage2, but a concurrent Alma host refresh caused the local stale-settings save to reject. No overwrite occurred. Both owners closed normally. Recheck on fresh reconnect. Protected MariaDB identities stayed live-copy274219390/original261628643, device66311, uid110/gid112/mode0755.

Protected-original details below remain authoritative. Older chronological notes and source-check counts are historical, not instructions to restart finished work.

## Ubuntu database: matching original baseline copy restored

- Ubuntu **21** completed all4 explicitly reviewed forward commands with intervention at each safe boundary. Durable preparation job `b407214251743e63f3f490b7a7ef2754` completed09:30:04UTC. No replay or rollback.
- Protected original MariaDB remains `/var/lib/webminai/lab-recovery/ubuntu-mariadb-task-58/mysql-before`: **10.11.14-MariaDB**, device66311/inode261628643, uid110/gid112/mode0755. Its original dictionary remains untouched. A verified COPY is now `/var/lib/mysql`.
- Original test MySQL data, device66311/inode274109867, uid110/gid112/mode0700, is preserved at task58/**mysql-after**. Never start MariaDB against it. Old whole `/etc/mysql` is preserved at task58/**restore-20261017/etc-mysql-before**, retaining its0755 metadata beneath private0700 parent. Stage2 recreated `/etc/mysql` from pinned package configurations, not by exposing the old private config.
- Both older MySQL backups remain untouched: `/var/lib/mysql-8.0` and `/var/lib/webminai/lab-recovery/ubuntu-mysql-task-40/mysql-before`. Task58/FROZEN remains the original dangling relative symlink, not a regular file to overwrite.
- **At09:51UTC, MariaDB10.11.14 was ACTIVE and verified through root Unix-socket SELECT VERSION, with TCP3306 listeners restricted to loopback.** Task24 guarded startup job `a42ddac9d7cae76b8daf259fb3caedb1` acknowledged09:51:35 and completed09:51:37; independent read-only verification also completed. Both exit0. Every forward/rollback body/policy was compared with reviewed exact scripts before explicit approval and boundary continuation. Only the five matching owned policy/mask files were removed. `/etc/mysql` is the pinned package configuration; the old whole config remains private. Original data backup was never opened by an incompatible engine or changed. Current service activity after the later restart and catalog tests is documented below.
- Original block creation evidence stays in task58/**restore-20261017/start-blocks.metadata** and `/var/lib/webminai/task-state/21`; do not overwrite it. New private **stage3-intent.json** and **stage3-outcome.json** record this authorized startup and current datadir identity. No failure/rollback handler ran. Normal startup does not establish the original historical service enablement state; that was not independently recorded.
- Exact installed server/core package version is `1:10.11.14-0ubuntu0.24.04.1`; mysql account110:112. Task22 restored common-package configurations with force-confmiss while keeping all blocks active, then verified native version, data identities and preserved backups. Private package logs must not go directly to AI/frontend. No automatic package retry.
- Task22 forward/rollback bodies matched reviewed exact scripts. Explicit approval/intervention began job `3bd03a056e06cf8ee74ac013acfdf7b4`09:35:50; it returned confirmed exit1/guard failure09:35:51. Offline verification was NOT dispatched. Reviewed inspection23 completed: all5 start blocks match recorded identities; original/test/copy identities intact; `/etc/mysql` and package log absent; both server packages absent. Both common packages are **rc**, not ii, in captured baseline and current state: mariadb-common `1:10.11.14-0ubuntu0.24.04.1`, mysql-common `5.8+1.1.0build1`, matching available candidates. The ii-only common-version guard failed BEFORE apt/log creation. The subsequently approved revision changed ONLY those two baseline-version selectors to confirmed rc, use new forward command IDs/dependencies, preserve other guards/rollback, with fresh approval/resume as recorded below. Keep all blocks/data; never replay the old job.
- **Revision5 now explicitly approved and separately resumed.** Comparison proved ONLY the two common-version selector predicates changed ii to rc, plus new forward IDs/dependency. All other bodies, timeouts, root/risk/mode/diagnostics and original rollback body unchanged. Original failed command remains immutable. New IDs: `install-matching-mariadb-retry23` and `verify-matching-mariadb-offline-retry23`. Observe the exact acknowledged new job above; this is reviewed replacement work, not replay of the original job.
- **Revision5 continuation COMPLETED:** new package job `c1ccdeffddcb2f293bfeba41d2a8705f` acknowledged09:41:27, completed09:41:32; subsequent offline verification completed09:41:33. Both exit0. Confirmed exact10.11.14 server/core fully configured, native14 binary, MariaDB-only copied data, original/test/config backups intact, no DB worker, and every owned start block unchanged. Task22 status completed. Private package log retained; no raw log disclosure. Startup subsequently completed in task24, as recorded above.
- Task22's saved separate rollback removes only newly introduced server/core without purge/autoremove, preserves new config privately, and retains all data/blocks. Do not execute it against partial/failed work without new review. New dependencies may remain, so this is not an exact full-package-baseline claim. Task21 rollback is only valid again after server removal and `/etc/mysql` is absent; do not run it now or after startup without fresh review.
- Stage3 rollback was NOT executed. It only stops/reblocks the restored service while retaining packages, live copied data/config and every backup, and writes NEW block identities separately. It does not restore old MySQL data. Older saved rollback guards become stale after unblocking/reblocking and require fresh review. Do not blindly chain database rollback plans.
- Rejected Ubuntu19/20 plans dispatched nothing. Ubuntu18 is only interrupted LOCAL planning, not an interrupted remote mutation.

## Six historical n8n prefixes: preservation complete

Staged run **15** completed with explicitly verified canary/batch gates. Each source directory was moved with no-clobber and verified same inode into a private0700 recovery child. Expected backup location on each host: `/var/lib/webminai/lab-recovery/n8n-prefix-JOB_ID/webminai-n8n-18109`. Old baselines, caches and durable results remain. Saved copy-back rollback was NOT executed and requires separate review.

| Host | Preservation task | Old baseline | Exact old job ID | Old acquisition evidence |
| --- | ---: | ---: | --- | --- |
| Alma | 13 | 73 | d7ee0ca1e603943a26bbe0304c423184 | exit143/signal15/timeout |
| Alpine | 12 | 44 | d1ea87b93c2fa71c8fcd9194e37c2106 | exit143/signal15/timeout |
| Debian | 14 | 155 | 1bec2f5d3b76ed82017b80be9bee4b6c | exit0, completion marker |
| Oracle | 13 | 60 | 0e444471d8e565a6681b88a463b07b9b | exit0, completion marker |
| Rocky | 14 | 57 | ed87816e7c30b79a80f30e5827765060 | **result unavailable, outcome still unknown** |
| Ubuntu | 17 | 78 | 5ec845ce2c456f8702e6c350a1155023 | exit143/signal15/timeout |

Fresh n8n deployment/rollback cycles are now complete on Alma, Alpine, Debian, Oracle and Rocky under run17. Ubuntu26 is still acquiring. Arch11/Fedora5/openSUSE8 have fresh cycles already recorded in the matrix; their earlier protected prefixes also remain, see history. Preservation alone is not a catalog lifecycle pass or permission to retry Rocky's uncertain old job.

## Current Ubuntu baseline and fresh WordPress

- After the environment/lab restart, Ubuntu SSH worked but Netdata was disabled/inactive with Result=success, native status0, no19999 listener. Read-only inspection through the binary showed2GiB memory with roughly1979MiB available; no evidence established OOM. MariaDB was also inactive before WordPress. The binary's explicitly confirmed plugin-only activation preserved installed Netdata and current plugin0.7.2 and restored active Stage2.
- Fresh WordPress27 matched the current deterministic builder including the new ownership guard byte-for-byte. Explicit approval plus safe-boundary intervention completed all10 forward commands, including actual exclusive database/user creation and HTTP/database verification. Package acquisition reported ZERO packages installed/upgraded/removed, keeping MariaDB10.11.14. Separately reviewed rollback completed all3 commands, including ownership-checked namespace removal. This is a fresh lifecycle pass, not a formal repeat/restoration assertion.
- Post-rollback read-only stat through the binary confirmed live-copy inode274219390 and protected original261628643 on device66311, uid110/gid112/mode0755. Protected test-MySQL inode274109867 remains0700; preserved config inode265964532 remains0755 under its private parent. Original/test backups were not restored over or deleted. MariaDB is inactive/dead, Result=success, matching the pre-WordPress service activity; the earlier09:51 active-state observation is historical, not current. Current data ownership remains as restored. No byte-identical live-database claim after normal startup.
- Fresh WooCommerce28 also matched the current builder before approval. All11 forward commands completed, including shared-foundation exclusive database/user creation, digest-pinned plugin11.0.0 installation, marker product and HTTP verification. Acquisition job9e9a51fc82cf76151d2f60f362dda3a7 completed; all3 separately reviewed rollback commands subsequently completed. Installed packages were reused rather than upgraded. This adds a second positive live caller of the shared ownership guard. WordPress/WooCommerce saved plans predate the final missing-client negative-case guard; their histories remain immutable and their proven positive paths do not imply a live missing-client test.
- Joomla29 and Drupal30 each completed all10 forward and all3 separately reviewed rollback commands, using the final ownership guard. Their package steps reused installed packages without upgrades. No restored original database directory is a task-owned deletion target when its recorded existed marker is present.

## First formal repeated-execution/restoration assertion: PASS

- Fedora baseline22, verified htop apply23 (job28532c649facde8d73e45483e6816064), explicitly reviewed AI reapply24 using the exact original command/rollback and state23, first rollback23, probe25, second rollback24, probe27 all completed in journal order. Original task history was not rewritten. Reapply24 is a separate explicitly approved test, not recovery replay.
- Identical before/after repeat probes confirmed unchanged full installed RPM name/version/architecture-set hash, htop binary hash/ownership/mode, version, and private task-state file hashes/metadata. First rollback removed exactly htop3.4.1-3.fc44 and hwloc-libs2.14.0-1.fc44; second rollback was a confirmed no-op. Both restoration probes match baseline22 exactly: binary/state absent, htop absent, package-version-set SHA256 `e2a22c96ea4e3db1473c0625eda4824d9f3cecd15ef472299203a3cb963c6421`.
- `node scripts/assert-cli-lifecycle.js /home/vscode/.intentaiops webminai-fedora-44 22 23 24 25 27` PASS. Offline checker opens only read-only history/settings, no vault key or remote executor. Its guarantee is scoped to this reviewed probe and single-dispatch case, not every host attribute or all183 combinations.
- Probe proposal26 changed Python escaping and was rejected at BOTH approval prompts before dispatch. Corrected proposal27 matched byte-for-byte before approval. Do not count26 as execution evidence.

## Historical source fixes and verification

- Nginx audit after live preflight failure36: two deterministic regressions failed before/pass after. Preparation now rejects existing and dangling owned targets with a named error before capturing state. remove-site rollback now exits when its baseline is absent, preserving unowned sites. All53 focused common/catalog tests pass. Saved36 is NOT retroactively safe; do not run its rollback. Shared static-site state still cannot identify arbitrary external replacement after ownership was established.
- Planner follow-up: disabling the internal code-mode backend caused a nonfatal misleading error frame despite successful tool-free routing/planning. The redundant backend override is removed while code_mode and execution/connector features remain disabled. All47 planner tests, including installed-CLI/default+MiMo mock-provider tool inspection, pass and assert the disabled-backend error is absent. No execution or connector tools are exposed in the checked configuration. Already-running clients need restart to load this change.
- Latest source checks: npm test, lint and typecheck PASS after the nginx/planner follow-ups. Unfiltered node --test confirms **609 total /606passed /0failed /3opt-in skips**. Package-install refresh70046 is being polled; do not treat older archive hashes below as containing these newest changes until it completes.
- Final package refresh after the restoration documentation: package-install PASS, current SHA256 **b1502a106cd19e1d7630bd67abacffc4b45d5d5e70ab9f244dc81051570250d4**. All5 native checksums PASS. This supersedes earlier archive hashes; subsequent checkpoint/matrix edits are not packaged files.
- Native PHP restoration audit: a deterministic shell fixture reproduced false success and recovery-baseline deletion after a failed package removal. Native WordPress and shared PHP restoration now use set -eu, preserving recovery state and returning failure on failed package removal or restarting a previously active service. Twelve scenarios cover both failures across WordPress, WooCommerce, Joomla, Drupal, PrestaShop and Moodle. Regression failed before/pass after; all58 focused catalog/recovery/database tests pass. Saved plans remain immutable; optional best-effort service stops and separate Compose cleanup paths are not fixed by this change. Actual positive live validation of this new restoration guard passed in Alma17.
- Latest checks02:02UTC: npm test, npm run lint, npm run typecheck and npm run test:package-install PASS. Unfiltered node --test confirms **607 total /604passed /0failed /3opt-in skips**. Current application archive SHA256 `d0cdb67cac87e88f422850b924168e22b380e5ef381b9a6bf00d3822338d16ab`; subsequent execution-milestones documentation update needs final package refresh. No source changes after these checks, only docs. No commits.
- Verification2026-10-18: npm test, lint, typecheck and package-install PASS after planner hardening. Unfiltered node --test confirms **606 total /603passed /0failed /3opt-in skips**. The installed-Codex boundary opt-in was ALSO explicitly run and passed, with all47 planner tests and all57 combined planner/foundation tests passing when enabled. Its synthetic local-provider response intentionally rejects after inspecting the request; no real model/host is contacted by that fixture. The other two real-host opt-ins remain skipped. Package SHA256 `4b489489af5b6385ac11c66d1c082220077c1da716fa39660bd1c781173d1350` and all5 native artifact checksums passed. Later documentation updates may require a final package refresh.
- Documentation/package refresh completed afterward: package-install PASS again, current archive SHA256 **d4ac609be716ddfcda0a1fcf025f6c224bbf496f4cc944c81ef140da34f69263**. This supersedes earlier archive hashes. No native protocol change was introduced by planner isolation or the system-user guard. No commits or generated test artifacts.
- Actual normal-vault binary91088 authenticated GPT5.6-sol/low read-only controller consultation after Alma rollback succeeded. It correctly distinguished immutable completed forward history from reverted task outcome using supplied evidence. No new remote command or approval was requested. This confirms the normal authenticated default-provider path after hardening, not every custom provider, model or future CLI release. Old Ubuntu83747/openSUSE53689 still must not make AI calls until restarted. Original MiMo/high restoration through the normal picker remains pending.
- Verification15:46UTC after the system-user guard and task-status display: npm test, npm run lint, npm run typecheck and npm run test:package-install PASS. Unfiltered node --test confirms **601 total /599passed /0failed /2opt-in skips**. Package installation on linux/x64 passed; current archive SHA256 `b7da0b024b5ff5eb14f31897c0298bff51a7d18ea858358fc69208d25b591140`. Native linker warnings remain unchanged. This supersedes the older15:03 package hash below. All-catalog live validation and the planner security audit are NOT complete.
- System-user rollback audit: a shell regression reproduced deletion of an existing same-name account when the task baseline directory was absent. Rollback now exits without action when its baseline is gone. Regression failed before/pass after; all50 common-task/catalog-recovery tests pass. Saved plans remain immutable and are not retroactively fixed. This guard does not establish account identity after an external same-name replacement while task state still exists.
- Planner isolation hardening implemented: shared routing/consultation/planning now uses an allowlisted environment, excludes vault/SSH variables, embeds sanitized references under a2MiB limit, redacts labeled context credentials and disables shell/browser/connectors/plugins/hooks/delegation/goals. All model calls use --no-daemon. Bounded MCP configuration inspection fails closed on failure/invalid identities or transports. Empty-map override alone was experimentally insufficient for inherited profile entries; explicit disabled transport-compatible placeholders now handle stdio and HTTP without copying credentials into arguments. Local installed-Codex/mock-provider tests pass for default and MiMo profiles with inherited enabled shell/stdio/HTTP entries. No execution or connector tools were advertised; MiMo retains only non-executing request_user_input. Configuration ownership/stability is trusted. No AI tool use or disclosure was observed before the fix. Actual normal-binary GPT5.6-sol/low consultation succeeded afterward as recorded above. Fresh CLI91088 loads this fix, while existing Ubuntu83747/openSUSE53689 do not. Do not use AI in those old sessions. Provider API keys named *_API_KEY and normal Codex authentication home are retained; differently named custom authentication variables are not forwarded. The full branch audit is still incomplete.
- Settings: cross-process SQLite serialization plus exact loaded-snapshot compare-and-swap; stale saves reject, concurrent saves sharing one object serialize, re-key snapshots remain consistent, crashed lock owner releases. All16 focused tests pass; actual two-session binary stale-write regression passed. Restart old binaries after upgrade.
- Controller audit fix: operator rollback now updates only its linked host and aggregate run status. Three regressions failed before/pass after, including rollback failure and unaffected-host preservation. Historical run9 still has an older stale projection; do not edit its databases to fake validation. Live controller-path refresh remains to test through normal reviewed UI.
- Console audit fix: all JSON/error responses now use existing vault-aware controller sanitization. A real HTTP fixture reproduced unlabelled passphrase leakage before the fix and passes after. No actual vault value used/disclosed.
- Console event size now measures UTF-8 bytes, not JavaScript characters. Multibyte regression failed before/pass after; oversized events leave no row. All24 controller tests pass.
- Concurrency audit: task updates now validate plan immutability and persist under one immediate SQLite transaction. A deterministic competing-writer interleaving reproduced overwritten execution history before the fix and passes after. Rollback now checks uncertain/partial state AFTER acquiring its execution lease, not before awaited credential/rule loading; its competing-operator regression failed before/pass after. Active older binaries must restart after their owned jobs finish to load these guards.
- Pause audit: the executor rechecks controls after approval/evidence collection and before each dispatch intent. Two regressions reproduced dispatch despite pause before the fix. A third regression ensures a pause before a declared retry retains the prior confirmed failed result instead of discarding it. All three now pass. No in-flight remote cancellation or uncertain replay was added.
- Live interactive follow-up exposed duplicate prompts caused by that final recheck. It now carries a silent recheck flag through AdminService, retaining control/lease checks without calling the human prompt twice. Four regressions cover ordinary attempts, declared retries and pauses during approval/evidence; the duplicate ordinary/retry cases failed before/pass after. Actual Arch timer22 saw one prompt and dispatched once. Older active Ubuntu2524 still shows duplicate prompts until it closes, but its completed history remains valid.
- Operator controls now also display the task projection status above immutable command history. This prevents a reverted task's completed forward commands from looking like a currently deployed result. It is a one-line display change only; fresh Oracle/Rocky binary views show Task status planned correctly before approval. Execution/rollback validation is unchanged. Full checks/package are being rerun for this display change.
- Live binary console audit reproduced a five-second SSE observation timeout during initial catch-up. Per-event database opens were replaced with one bounded host read and transactional page/cursor persistence, preserving WAL/FULL and sanitization. Three regressions cover bounded database accesses, atomic failure and competing stale-page cursors; the first two failed before/pass after. New TaskStore.hostExecutionEvents preserves the existing version1 event shape, with no schema migration or remote protocol change.
- Both actual binary console modes now pass HTTP tests against the normal vault: unauthenticated API/SSE denied, invalid token/cross-origin denied, HttpOnly/SameSite session, nine-host snapshot, sanitized task/export, replayOnly export and ordered Last-Event-ID reconnection. Read-only actions reject; actions-enabled mode rejects missing CSRF, unapproved resume/rollback and stale resume/replanning, with inspected stateVersion unchanged. No remote action was approved or executed by these tests. Two sequential subscriptions took0.056s and0.051s after the fix; these are observations, NOT a controlled before/after benchmark because backlog/cache differed. Console processes closed normally; launch tokens/passphrase were not printed or persisted by the test client.
- n8n audit fixes: Debian native and Compose rollback no longer run global `apt autoremove`; only recorded package additions are passed to purge. Both regressions failed before/pass after. Native n8n no longer advertises a MariaDB foundation for its SQLite workflow; routing regression failed before/pass after, and all six actual binary routes now correctly select unchanged n8n. Existing saved plans are immutable and NOT retroactively changed; cancelled run16 must not be executed. These script/metadata fixes require a new application package, not a new native plugin protocol/build.
- Database audit: a shell regression reproduced native PHP rollback dropping an unowned namespace solely because task state existed. New shared `linux-application-database.js` refuses occupied database/user names, uses exclusive SQL creation without password resets, and persists ownership only after successful creation. WordPress/shared PHP rollback now requires matching ownership and targets only the configured local user. Seven shell regressions cover all six callers, repeated apply/rollback, partial SQL failure, denied/missing client evidence, marker mismatch/symlinks, failed rollback and invalid identities/password input. Missing-client regression also failed before/pass after; unavailable SQL evidence is not an empty namespace. WordPress27 and WooCommerce28 positively exercised actual creation/removal as recorded above. SQL success followed by lost marker persistence remains uncertain and requires reviewed recovery. Saved plans are immutable; old plans are NOT retroactively protected. External same-name database replacement cannot be identified from the marker alone.
- Planner: risk includes mutating failure handlers; Linux shell guidance now matches actual native preference (Bash, bundled Bash, then sh fallback). Guidance is not semantic shell enforcement; operator review remains mandatory.
- Terminal: pasted input redraws coalesce per event-loop turn and cancel on submit/error. Deterministic regression reproduced quadratic output before the fix; all30 terminal tests pass. Current CLI5614 loads this fix; its15563-character Stage2 request was submitted without the old blocking paste problem. Local PTY wrapper only forwards to the binary, not a separate execution path.
- Terminal follow-up: a deferred render error also returns through the existing raw-reader cleanup, rather than becoming an uncaught asynchronous exception. A failing-before/passing-after regression covers it; all31 terminal tests pass.
- Added `scripts/assert-cli-lifecycle.js`, an OFFLINE read-only history checker, not another remote executor. It requires five distinct probe/apply/reapply/restoration task records, complete approved same-attempt journal events in correct chronology, identical reviewed apply/rollback bodies, no duplicate dispatch, unchanged repeated-apply probe state, and both rollback snapshots equal to baseline. Redacted/truncated/unknown/incomplete evidence rejects. All19 deterministic tests pass, including a subprocess proving no vault key or history/settings writes. Fedora's live case now passes, as recorded above. Its guarantee is scoped to the actual reviewed probe, not every host attribute or approved multi-attempt retry case.
- Latest verification15:03UTC: npm test, npm run lint, npm run typecheck and npm run test:package-install PASS. Unfiltered node --test confirms **600 total /598passed /0failed /2opt-in skips**; all5 native checksums and the application archive checksum pass. Current package SHA256 `b97fab5d8fe8f2159eda2a2fef354b24cc1ee3962417b830fa54c7e766890569`. Fedora's offline lifecycle assertion passes again. Native Linux/Kubernetes builds emitted existing static-glibc linker warnings. No commits; generated dist tarball/checksum changes are delivery artifacts, not test artifacts. Already-running binaries do not load later fixes until restarted.

## Earlier remaining-work list (superseded above)

1. All78 eligible system fixtures, all9 Drupal and all9 PrestaShop cases are FINISHED. Arch27 recovered through an approved revision, no mirror change. Debian's nginx preservation/restoration is FINISHED; never repeat29 or execute28 rollback.
2. Finish the remaining18 eligible combinations through the binary, with host-specific plans and separately reviewed cleanup. Current count165/183; unsupported targets are not passes. Preserve all original backups and uncertain-job evidence. Inspect existing PostgreSQL baselines before package changes.
3. Complete remaining repeated-execution/scoped-baseline assertions and the branch-feature audit versus main. Nine formal cases are evidence for those cases, not all183 combinations. Historical crash/recovery/rollout evidence is not a fresh rerun of every scenario. Add binary-based equivalents where the old direct-service live harnesses cannot be used.
4. Keep Ubuntu's compatible MariaDB copy and every frozen original/test backup intact. Rocky's old n8n job remains UNKNOWN. Never restore a preserved prefix over an occupied target or infer approval from a diagnosed cause.
5. After further source fixes, rerun npm test/lint/typecheck/package-install and checksums. Before final handoff, restore original MiMo/high through the binary, close owners normally, and record exact results. Do not commit generated test artifacts.
