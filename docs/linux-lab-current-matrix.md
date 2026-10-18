# Current Linux lab coverage

Updated 2026-10-18 02:53 UTC. Source: the existing normal vault's task journals and cached host inventories, checked through the current checkout. Remote execution uses the binary CLI, not a separate service runner. Exact active owners and recovery obligations are in [the checkpoint](linux-lab-validation-status.md).

## Scope

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

`PASS` means all approved apply commands and reviewed rollback commands completed in the normal vault. It does not imply the formal validator's two-apply/two-rollback or exact baseline-comparison assertions. `Pending` does not invalidate older historical evidence, but that older evidence is not a fresh normal-vault pass.

| Application | Alma | Alpine | Arch | Debian | Fedora | openSUSE | Oracle | Rocky | Ubuntu |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| WordPress | PASS #17 | PASS #8 | PASS #14 | Pending | PASS #7 | PASS #19 | Pending | Pending | PASS #27 |
| WooCommerce | PASS #11 | PASS #10 | PASS #16 | PASS #11 | PASS #8/#9 (fixed check) | PASS #21 | PASS #11 | PASS #11 | PASS #28 |
| Joomla | PASS #12 | PASS #11 | PASS #17 | PASS #13 | PASS #11 | PASS #22 | PASS #12 | PASS #12 | PASS #29 |
| Drupal | PASS #16 | Pending | Pending | PASS #12 | Pending | Pending | Pending | Pending | PASS #30 |
| PrestaShop | #18 apply complete; rollback uncertain | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| Moodle | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| n8n | PASS #15 | PASS #14 | PASS #11 | PASS #16 | PASS #5 | PASS #8 | PASS #15 | PASS #16; old outcome unknown | PASS #26 |
| Ghost | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Pending |
| Mattermost | Pending | Unsupported | Unsupported | Pending | Unsupported | Unsupported | Pending | Pending | Pending |
| Odoo | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Pending |
| Jellyfin | PASS #9 | Unsupported | PASS #2/#3 | PASS #9 | PASS #1 | PASS #12/#13 | PASS #9 | PASS #9 | PASS #12 (reviewed revision3 recovery) |
| Intent AI Ops install | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |

All nine hosts have completed health tasks in the normal vault. Fedora has fresh reviewed apply/rollback passes for all9 eligible system fixtures: htop #12, jq #13, system-user #14, systemd-service #15, systemd-timer #16, corrected cron #18, logrotate #19, tmpfiles #20 and nginx-static-site #21. Cron #17 was cancelled before execution to fix existing-file preservation. Arch also passes all9: htop18, jq19, system-user20, service21, timer22, cron23, logrotate24, tmpfiles25 and nginx26. Each has exactly one dispatch per forward/rollback command. openSUSE htop24 also passes its lifecycle and formal repeat/restoration assertion; jq28 passes apply/rollback. Fresh lifecycle coverage is now **71/183**, independently counted as distinct completed health/reverted catalog cases across the normal vault. These are CLI lifecycle observations, not universal formal fixture probes or repeated-idempotence assertions. Other hosts' fresh system fixtures and update cases remain pending. Old historical application coverage was 69/87; do not add that number to this table or infer missing results from lost private reports.

Latest recount: **80/183** distinct completed health/reverted catalog cases: Debian6, Alma7, Alpine5, Arch15, Fedora15, openSUSE15, Oracle5, Rocky5, Ubuntu7. This supersedes71 above. All9 openSUSE system fixtures now have reviewed apply/rollback cycles: htop24, jq28, user29, service30, timer31, cron32, logrotate34, tmpfiles35, nginx38. Nginx36 failed before baseline and remains aborted with an unsafe legacy rollback that MUST NOT execute. Existing legacy nginx data/config were preserved by reviewed task37. Task38 cleanup additionally confirmed its root/config/state paths absent and nginx inactive. Its successful verification included a server-name warning, not proof of unique vhost attribution.

## Feature regression evidence

- Current local suite: 613 tests, 610 passed, zero failures, three opt-in skips. npm test, lint, typecheck and package-install passed. The installed-Codex/mock-provider opt-in was also explicitly enabled and passed separately; the two real-host integration suites remain skipped. New regressions cover canonical rollback revision identifiers, evidence redaction/stale decisions, bounded Netdata HTTP metadata and URL timeout false positives. Native database ownership has seven shell regressions and positive live WordPress27/WooCommerce28/Joomla29/Drupal30 apply/rollback evidence. Missing-client/partial-SQL cases are fixtures, not induced live failures. Concurrent shared-object host refreshes, child-process writers, stale host refresh, passphrase rotation and crashed lock-owner release have regressions. A two-session binary test also rejected a stale host-refresh save without overwriting the newer model setting.
- Actual binary console checks now pass in read-only and actions-enabled modes: authentication, cross-origin/CSRF rejection, stale/unapproved action denial, nine-host snapshot, sanitized replay export and ordered SSE reconnection. A live catch-up timeout led to transactional host-page import with three new regressions. Console tests approved no remote changes. Arch timer22 also verifies a single intervention prompt with the silent final safety recheck; four regressions preserve approval/evidence pause protection.
- Formal Fedora htop repeat/restoration passes: baseline22, apply23, exact reviewed repeat24, restoration25/27, both saved rollbacks. openSUSE also passes baseline23/apply24/repeat25/restoration26/27 with both rollbacks. Read-only `scripts/assert-cli-lifecycle.js` verifies approved same-attempt journal order, unchanged repeat probe and exact reviewed baseline probe restoration. These two cases do not establish those assertions for all183 combinations.
- Branch audit remains incomplete. Planner isolation now filters child environments, embeds sanitized references and disables execution/connector features and discovered MCP servers. The actual installed CLI advertised no execution or connector tools to a local mock provider under default and MiMo profiles, including enabled inherited stdio/HTTP servers. A normal authenticated binary GPT5.6-sol/low controller consultation also succeeded using recorded evidence without new remote execution; no disclosure was observed. A separate system-user regression confirmed unsafe rollback without task baseline; its new guard and all50 focused catalog/recovery tests pass. Existing saved plans are not rewritten.
- Historical n8n inspection and reviewed prefix preservation completed on all six remaining hosts through staged run15. Alma/Alpine/Ubuntu acquisitions timed out; Debian/Oracle acquisitions succeeded; Rocky's old durable result remains unavailable. Prefixes now reside in private no-clobber recovery directories; old baselines/caches/results are retained. This is not a fresh application lifecycle pass.
- Live WordPress pause/resume and controller rollback: Fedora #7. Baseline and every other deployment/rollback command had exactly one recorded dispatch.
- Live remaining-plan revision recovery: Ubuntu Jellyfin #12 revision3. Preserved3 completed setup commands, separately approved4 replacements and reviewed original3-command rollback. Exactly1 dispatch per completed setup/replacement; obsolete revision2 remained unapproved. This was recovery from a confirmed apt-lock failure, not replay of an uncertain result.
- Live multi-host health: completed run8, with earlier run4 including saved per-host assessments. Run9 Jellyfin tasks are cleaned up, but its old aggregate rollback projection remains stale pending normal reviewed controller refresh. New staged preservation run15 completed its canary and all three gated batches.
- Earlier live crash/recovery, connection reuse, leases, intervention, loop protection, console authorization, streaming and replay results remain documented in the checkpoint. They are historical evidence, not fresh reruns of every scenario on every host.
- Linux-only lab results do not prove real FreeBSD, macOS, Windows, Docker/Podman or Kubernetes behavior. Platform fixtures remain separate evidence.

Never approve old run6 alongside run9, replay uncertain jobs, delete preserved prefixes, or overwrite the original Ubuntu MariaDB backup. Restore original Ubuntu MariaDB only through its reviewed compatible-version recovery workflow.
