# Current Linux lab coverage

Updated 2026-10-19 16:59 UTC. Source: the existing normal vault's task journals and cached host inventories, checked through the current checkout. Remote execution uses the binary CLI, not a separate service runner. Exact active owners and recovery obligations are in [the checkpoint](linux-lab-validation-status.md).

## Scope

The current acceptance target is the README's **Linux without Docker**
application column, including its stated distribution restrictions. It contains
87 eligible application/host cases, of which **87 passed reviewed apply/rollback
cycles**, including reviewed recovery/cleanup where required. Ubuntu Ghost57
passed deployment, HTTP/database/restart checks and its original reviewed rollback;
separately approved cleanup61 preserved its leftover MySQL datadir in quarantine.
Package name/version hashes, repository files and scoped host state match the
pre-install baseline. This was not an unattended clean rollback. Platform fixtures,
health reports and system updates below are separate supplementary coverage and
must not inflate application coverage. Docker/Podman is excluded from live tests.
These cycle passes do not prove universal repeated-execution restoration or
completion of the branch-feature audit.

The read-only strict audit now checks the stronger assertions independently:

```sh
node scripts/audit-linux-cli-history.js /home/vscode/.intentaiops --require-repeat-restoration
```

It currently exits1: **15/87 application cases pass,72 lack complete evidence**.
Verified cases are Debian n8n and Jellyfin, Fedora Intent AI Ops install, Alpine Drupal and
Moodle, Arch Moodle, openSUSE Moodle, and Intent AI Ops installs on all nine hosts.
The remaining8 of the23 formal cycles are supplementary system
fixtures. A null `repeatRestoration` identifies a missing application case;
the audit does not contact hosts, decrypt the vault or change history. This is
an unfinished acceptance check, not an additional87-case pass.

Current catalog eligibility resolves to **183 host/task combinations**: 87 application, 78 system, and 18 diagnostic/maintenance combinations. These are eligibility counts, not passes. Eligibility must be refreshed before execution; unsupported routes are not successes. The default picker exposes application, diagnostic and maintenance categories. Explicit `--lab-tasks` also exposes eligible Linux system fixtures, with normal review and approval.

| Host | Eligible application | Eligible system | Diagnostic/maintenance |
| --- | ---: | ---: | ---: |
| AlmaLinux 9 | 10 | 9 | 2 |
| Alpine 3.23 | 8 | 6 | 2 |
| Arch | 9 | 9 | 2 |
| Debian 13 | 10 | 9 | 2 |
| Fedora 44 | 9 | 9 | 2 |
| openSUSE 16 | 9 | 9 | 2 |
| Oracle 9 | 10 | 9 | 2 |
| Rocky 9 | 10 | 9 | 2 |
| Ubuntu 24.04 | 12 | 9 | 2 |

## Fresh application lifecycle evidence

Current authoritative total: **182/183**. Alma21, Alpine16, Arch20, Debian21,
Fedora20, openSUSE20, Oracle21, Rocky21, Ubuntu22. All78 system fixtures, all9
health, all9 Drupal, all9 PrestaShop and all9 Moodle cases pass. Twenty-two formal
repeat/scoped restoration cases pass, including Debian52/53/57/58/59 for n8n
and Fedora33/34/35/36/37 for Intent AI Ops install. The n8n probes exclude protected credentials, its runtime
database and dependency contents. Older totals
below are historical, not current counts.

Ghost57 lifecycle assertion passes seven active forward commands and four
original rollback commands, each once with zero unknown outcomes. Its original
failed package attempt remains recorded, completed baseline was not repeated,
and unapproved AI proposal12 was never executed. Cleanup61 dispatched once;
directory identity `66311:276302480:110:112:700` is preserved under root0700
`/var/lib/webminai/lab-recovery/ubuntu-ghost-task-57/mysql-after`.
The original `/var/lib/mysql` path and all managed Ghost paths are absent;
protected earlier database backups are unchanged and Netdata remains active.
Future Ghost plans stop rollback with `DATABASE_DATA_REMAINS` rather than
silently count newly created database residue as restored baseline.

Latest full checks:720 total/717 passed/0 failed/3 opt-in skips; lint, typecheck,
package-install, native checksums and diff whitespace checks pass. Historical
counts/checks below are not the latest release sign-off.

New apt cases passed the combined read-only lifecycle assertion:
Debian37/38/39/40/41 and Ubuntu45/46/47/48/49. Exact unchanged reapply and both
separately reviewed rollbacks preserved/restored the selected package/path state.
Debian removed only task-added htop; Ubuntu preserved its pre-existing htop.

Run25 Mattermost: Debian34, Oracle35 and Rocky34 passed7 forward/4 separately
reviewed rollback commands, each dispatched once, no unknown outcomes. Oracle's
safe pause preserved5 completed commands; reviewed resume executed only2 pending
steps. Ubuntu44 revision10 also passed7 forward/4 original reviewed rollback
commands, each once, no unknown; current acquisition fix passed live.

Rocky WordPress35 passed10 forward/3 separately reviewed rollback commands,
each dispatched once with no unknown outcome. Lifecycle journal assertion PASS.

Fresh read-only journal audit confirms160 ordinary apply/rollback cases plus3
reviewed recovery cycles: Alma PrestaShop18/revision3, openSUSE Drupal39/revision6,
Ubuntu Odoo42/revision7. Their original failures/unknown events remain intact.
All9 completed health-task forward journals also pass, confirming172 before the
latest Ubuntu Mattermost and Alma update completions.
These are execution-evidence checks, not universal baseline-restoration proof.
Run26 now stages8 one-way current-release updates; Ubuntu is excluded and no
update is counted until its report and journal assertions pass. Alma44 now passes
all3 commands and its report:2 package updates, no reboot, no unknown. Fresh binary
host inspection confirmed Stage2 healthy before the batch-1 gate was approved.
Alpine37 and Arch35 also passed3/3 commands and fresh binary SSH/Stage2 checks.
Alpine updated libexpat; Arch recorded8 package upgrades. Arch's udev hook
reported read-only container sysfs warnings while pacman returned0. They remain
recorded warnings, not fabricated task failures or grounds to change isolation.
Debian35 and Fedora32 passed3/3 update commands and fresh binary SSH/Stage2
checks before their health gate released openSUSE49/Oracle36.
openSUSE49/Oracle36 passed3/3 update commands and fresh binary SSH/Stage2 checks;
Rocky36 also passed3/3 and fresh binary SSH/Stage2 checks. Run26 completed all8
hosts; its AI summaries are read-only follow-up. Ubuntu's update remains last.
The report-content audit then found lexical release sorting hid Alma/Rocky10.x.
Fixed version sorting passed a failing-before shell regression and normal-binary
read-only correction run27 (Alma45/Rocky37), both showing10.2. Original update
dispatches remain1 each; old reports are preserved, not rewritten.

Latest local checks:683total/680passed/0failed/3opt-in skips; npm test, lint,
typecheck, package-install and all5 native checksums PASS. Archive SHA256
0d1c031c8734a3084fbde4a5c2cc0b6153765e679b53b5ba92c5327a25180f9c.
All87 promoted native Linux application routes have explicit eligibility/plan
regression coverage. Mattermost now resumes retained partial download bytes
between bounded fresh curl invocations; real-HTTP truncation failed before the
fix and passes afterward, along with retry-cap/checksum/HTTP-error cases.
CLI rollback now rejects symlinked ownership state; CLI planning foundations no
longer claim databases or container bootstraps. Both regressions failed before
the fix and pass afterward. These checks do not count the in-progress live cases.
Native Linux/Kubernetes collectors now emit status keepalives outside JSON frames;
the idle regression failed before/pass after. Linux/Kubernetes builds and FreeBSD
compatibility compile passed. Ubuntu received the changed artifact through normal
plugin-only update; live idle verification passed over131seconds. Odoo42 passed
separately reviewed rollback revision7 and protected-baseline inspection. Its
original unknown event remains; no uncertain command was automatically replayed.

Alma Mattermost41 completed all7 forward/all4 separately reviewed controller rollback commands, with single dispatches and no unknown result. Positive live PostgreSQL cluster/role/database/owner identity matched the private task marker before cleanup; HTTP health/restart verification passed. Current total **145/183** (Alma19, Arch16; other latest counts unchanged). openSUSE CLI48 has a confirmed npm package-fetch timeout and is not counted. PrestaShop staging remains active, not yet cleanup-complete.

Arch Drupal27 now also passes after separately approved remaining-work revision3 and controller rollback. Baseline dispatched once, original failed package attempt remains journaled, replacement completed once, unsafe revision2 never approved. All13 current forward/rollback commands pass lifecycle assertions. Current total **144/183** (Arch16; other latest host counts unchanged). All nine hosts now have fresh Drupal lifecycle evidence. This is reviewed recovery, not automatic retry or universal repeated-execution proof.

Latest run18 adds reviewed Drupal apply/rollback passes on Fedora28, Oracle31 and Rocky30. Each10 forward/3 rollback commands dispatched once, no unknown outcomes. Current total **143/183**: Debian16, Alma18, Alpine13, Arch15, Fedora16, openSUSE18, Oracle16, Rocky15, Ubuntu16. Arch27 stopped at package synchronization (unreachable mirror) and is not counted. No other host from that run needs a deployment retry.

Current authoritative total: **140/183** fresh distinct reviewed health/apply-and-rollback cases. Debian16, Alma18, Alpine13, Arch15, Fedora15, openSUSE18, Oracle15, Rocky14, Ubuntu16. All78 eligible system fixtures pass, including Ubuntu31-39 and Alpine27-32. Nine formal repeated-execution/scoped-restoration cases pass; lifecycle passes do not imply those stronger assertions. Older125 totals below are historical. Drupal run18 remains active and is not counted; Arch27 recorded a package-mirror connection failure, the other three hosts are pending.

`PASS` means all approved apply commands and reviewed rollback commands completed in the normal vault. It does not imply the formal validator's two-apply/two-rollback or exact baseline-comparison assertions. `Pending` does not invalidate older historical evidence, but that older evidence is not a fresh normal-vault pass.

| Application | Alma | Alpine | Arch | Debian | Fedora | openSUSE | Oracle | Rocky | Ubuntu |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| WordPress | PASS #17 | PASS #8 | PASS #14 | PASS #19 | PASS #7 | PASS #19 | PASS #22 | Pending | PASS #27 |
| WooCommerce | PASS #11 | PASS #10 | PASS #16 | PASS #11 | PASS #8/#9 (fixed check) | PASS #21 | PASS #11 | PASS #11 | PASS #28 |
| Joomla | PASS #12 | PASS #11 | PASS #17 | PASS #13 | PASS #11 | PASS #22 | PASS #12 | PASS #12 | PASS #29 |
| Drupal | PASS #16 | PASS #22; formal repeat #24 | PASS #27 (reviewed recovery) | PASS #12 | PASS #28 | PASS #39 (reviewed recovery) | PASS #31 | PASS #30 | PASS #30 |
| PrestaShop | PASS #18 (reviewed recovery) | PASS #34 | PASS #28 | PASS #31 | PASS #29 | PASS #40 | PASS #32 | PASS #31 | PASS #40 |
| Moodle | PASS #20 | PASS #17; reviewed revision and formal repeat #18 | PASS #30; formal repeat #31 | PASS #32 | PASS #30 (reviewed recovery) | PASS #42; formal repeat #45 | PASS #33 | PASS #32 | PASS #41 |
| n8n | PASS #15 | PASS #14 | PASS #11 | PASS #16 | PASS #5 | PASS #8 | PASS #15 | PASS #16; old outcome unknown | PASS #26 |
| Ghost | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Pending |
| Mattermost | PASS #41 | Unsupported | Unsupported | PASS #34 | Unsupported | Unsupported | PASS #35 (pause/resume) | PASS #34 | Pending #44 |
| Odoo | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | PASS #42 (reviewed rollback recovery) |
| Jellyfin | PASS #9 | Unsupported | PASS #2/#3 | PASS #9 | PASS #1 | PASS #12/#13 | PASS #9 | PASS #9 | PASS #12 (reviewed revision3 recovery) |
| Intent AI Ops install | PASS #43 | PASS #36 | PASS #34 (reviewed private-runtime recovery) | PASS #33 | PASS #31 | PASS #48 (reviewed recovery) | PASS #34 | PASS #33 | PASS #43 |

All nine hosts have completed health tasks in the normal vault. Fedora has fresh reviewed apply/rollback passes for all9 eligible system fixtures: htop #12, jq #13, system-user #14, systemd-service #15, systemd-timer #16, corrected cron #18, logrotate #19, tmpfiles #20 and nginx-static-site #21. Cron #17 was cancelled before execution to fix existing-file preservation. Arch also passes all9: htop18, jq19, system-user20, service21, timer22, cron23, logrotate24, tmpfiles25 and nginx26. Each has exactly one dispatch per forward/rollback command. openSUSE htop24 also passes its lifecycle and formal repeat/restoration assertion; jq28 passes apply/rollback. Fresh lifecycle coverage is now **125/183**, independently counted as distinct completed health/reverted catalog cases across the normal vault. These are CLI lifecycle observations, not universal formal fixture probes or repeated-idempotence assertions. Other hosts' fresh system fixtures and update cases remain pending. Old historical application coverage was 69/87; do not add that number to this table or infer missing results from lost private reports.

Latest recount: **125/183** distinct completed health/reverted catalog cases: Debian16, Alma18, Alpine7, Arch15, Fedora15, openSUSE18, Oracle15, Rocky14, Ubuntu7. Alma htop22 adds a reviewed lifecycle; its full two-rollback assertion passes. All9 openSUSE system fixtures now have reviewed apply/rollback cycles: htop24, jq28, user29, service30, timer31, cron32, logrotate34, tmpfiles35, nginx38. Nginx36 failed before baseline and remains aborted with an unsafe legacy rollback that MUST NOT execute. Existing legacy nginx data/config were preserved by reviewed task37. Task38 cleanup additionally confirmed its root/config/state paths absent and nginx inactive. Its successful verification included a server-name warning, not proof of unique vhost attribution. Alma18/openSUSE39 used separately reviewed four-step recovery revisions after failed rollback, not automatic retry; all recovery commands completed once and scoped cleanup checks passed. These are not formal repeated-execution/full-baseline assertions.

## Feature regression evidence

- Debian20-27/nginx30, Oracle23-30 (plus earlier htop17), and Rocky22-29 (plus earlier htop18) now complete all9 eligible system-fixture lifecycles on each host. Every forward/rollback command has one approved/prepared/dispatched/confirmed attempt. Debian's refused legacy-site preflight28 dispatched no later work; guarded preservation29/fresh30/guarded restoration29 restored the original inodes, owners, modes and hashes. Old28 was explicitly aborted without rollback. Fresh Oracle30 paused after preparation, read-only analysis changed no dispatch, reviewed resume skipped preparation, and reviewed controller rollback completed. Fresh Rocky29 rejected a second normal CLI's explicitly reviewed resume while the original lease remained active, with no extra dispatch or control change; original owner then completed and cleaned up.
- Alma now passes all9 eligible system fixtures: htop22, jq27, user31, service34, timer35, cron37, logrotate38, tmpfiles39 and nginx40. Each forward/rollback command has one prepared/dispatched/confirmed attempt. New shared guards reject symlinked apply targets, missing/symlinked rollback state, and existing systemd runtime markers. Three failing-before/passing-after shell regressions cover these cases; service/timer/cron/logrotate/tmpfiles have positive live Alma evidence. Cancelled32/33 never dispatched and retain their original plans.
- Current local suite: 653 tests, 650 passed, zero failures, three opt-in skips. npm test, lint, typecheck and package-install passed after the newest guards. The installed-Codex/mock-provider opt-in was also explicitly enabled and passed separately; the two real-host integration suites remain skipped. Alpine nginx checkconfig ordering and sanitized missing-path observations also have regressions. New regressions also cover AI retry-schema preservation, cron path ownership, fail-closed systemd/OpenRC cleanup and no blind PID signaling. Earlier regressions cover operator-only rollback mode, rejection of executed IDs under lease, correlated retry evidence, and real rollback planning without a further rollback, WordPress dangling paths/no-upgrade packages, Moodle off-web data ownership, canonical rollback revision identifiers, evidence redaction/stale decisions, bounded Netdata HTTP metadata and URL timeout false positives. Native database ownership has seven shell regressions and positive live WordPress27/WooCommerce28/Joomla29/Drupal30 apply/rollback evidence. Missing-client/partial-SQL cases are fixtures, not induced live failures. Concurrent shared-object host refreshes, child-process writers, stale host refresh, passphrase rotation and crashed lock-owner release have regressions. A two-session binary test also rejected a stale host-refresh save without overwriting the newer model setting.
- Actual binary console checks now pass in read-only and actions-enabled modes: authentication, cross-origin/CSRF rejection, stale/unapproved action denial, nine-host snapshot, sanitized replay export and ordered SSE reconnection. A live catch-up timeout led to transactional host-page import with three new regressions. Console tests approved no remote changes. Arch timer22 also verifies a single intervention prompt with the silent final safety recheck; four regressions preserve approval/evidence pause protection.
- Nine formal repeat/restoration cases pass: Fedora htop22/23/24/25/27, openSUSE htop23/24/25/26/27, Alma htop21/22/23/24/25, Oracle htop16/17/19/20/21, openSUSE Moodle41/42/45/46/47, Alma jq26/27/28/29/30, Alpine Moodle16/17/18/19/20, Rocky htop17/18/19/20/21, and Alpine Drupal21/22/24/25/26. Alpine Moodle includes its approved remaining-work revision while retaining the original confirmed failure and completed history. Both saved rollbacks, identical repeat snapshots and exact selected-baseline restoration pass the read-only journal checker. Moodle includes approved, confirmed exit75 readiness retries. This does not prove whole-host restoration or these assertions for all183 combinations; protected credential paths and recursive directory contents are excluded from Moodle probes.
- Branch audit remains incomplete. Planner isolation now filters child environments, embeds sanitized references and disables execution/connector features and discovered MCP servers. The actual installed CLI advertised no execution or connector tools to a local mock provider under default and MiMo profiles, including enabled inherited stdio/HTTP servers. A normal authenticated binary GPT5.6-sol/low controller consultation also succeeded using recorded evidence without new remote execution; no disclosure was observed. A separate system-user regression confirmed unsafe rollback without task baseline; its new guard and all50 focused catalog/recovery tests pass. Existing saved plans are not rewritten.
- Historical n8n inspection and reviewed prefix preservation completed on all six remaining hosts through staged run15. Alma/Alpine/Ubuntu acquisitions timed out; Debian/Oracle acquisitions succeeded; Rocky's old durable result remains unavailable. Prefixes now reside in private no-clobber recovery directories; old baselines/caches/results are retained. This is not a fresh application lifecycle pass.
- Live WordPress pause/resume and controller rollback: Fedora #7. Baseline and every other deployment/rollback command had exactly one recorded dispatch.
- Live remaining-plan revision recovery: Ubuntu Jellyfin #12 revision3. Preserved3 completed setup commands, separately approved4 replacements and reviewed original3-command rollback. Exactly1 dispatch per completed setup/replacement; obsolete revision2 remained unapproved. This was recovery from a confirmed apt-lock failure, not replay of an uncertain result.
- Live multi-host health: completed run8, with earlier run4 including saved per-host assessments. Run9 Jellyfin tasks are cleaned up, but its old aggregate rollback projection remains stale pending normal reviewed controller refresh. New staged preservation run15 completed its canary and all three gated batches.
- Earlier live crash/recovery, connection reuse, leases, intervention, loop protection, console authorization, streaming and replay results remain documented in the checkpoint. They are historical evidence, not fresh reruns of every scenario on every host.
- Linux-only lab results do not prove real FreeBSD, macOS, Windows, Docker/Podman or Kubernetes behavior. Platform fixtures remain separate evidence.

Never approve old run6 alongside run9, replay uncertain jobs, delete preserved prefixes, or overwrite the original Ubuntu MariaDB backup. Restore original Ubuntu MariaDB only through its reviewed compatible-version recovery workflow.
