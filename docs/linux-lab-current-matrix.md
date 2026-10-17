# Current Linux lab coverage

Updated 2026-10-17 08:51 UTC. Source: the existing normal vault's task journals and cached host inventories, checked through the current checkout. Remote execution uses the binary CLI, not a separate service runner. Exact active owners and recovery obligations are in [the checkpoint](linux-lab-validation-status.md).

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
| WordPress | Pending | PASS #8 | PASS #14 | Pending | PASS #7 | PASS #19 | Pending | Pending | Pending |
| WooCommerce | PASS #11 | PASS #10 | PASS #16 | PASS #11 | PASS #8/#9 (fixed check) | PASS #21 | PASS #11 | PASS #11 | Pending |
| Joomla | PASS #12 | PASS #11 | PASS #17 | PASS #13 | PASS #11 | PASS #22 | PASS #12 | PASS #12 | Pending |
| Drupal | Pending | Pending | Pending | PASS #12 | Pending | Pending | Pending | Pending | Pending |
| PrestaShop | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| Moodle | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| n8n | Preserved; fresh pending | Preserved; fresh pending | PASS #11 | Preserved; fresh pending | PASS #5 | PASS #8 | Preserved; fresh pending | Preserved; old outcome unknown | Preserved; fresh pending |
| Ghost | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Pending |
| Mattermost | Pending | Unsupported | Unsupported | Pending | Unsupported | Unsupported | Pending | Pending | Pending |
| Odoo | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Unsupported | Pending |
| Jellyfin | PASS #9 | Unsupported | PASS #2/#3 | PASS #9 | PASS #1 | PASS #12/#13 | PASS #9 | PASS #9 | PASS #12 (reviewed revision3 recovery) |
| Intent AI Ops install | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |

All nine hosts have completed health tasks in the normal vault. Fedora has fresh reviewed apply/rollback passes for all9 eligible system fixtures: htop #12, jq #13, system-user #14, systemd-service #15, systemd-timer #16, corrected cron #18, logrotate #19, tmpfiles #20 and nginx-static-site #21. Cron #17 was cancelled before execution to fix existing-file preservation. These are CLI lifecycle observations, not the formal fixture probes or repeated-idempotence assertions. Other hosts' fresh system fixtures and update cases remain pending. Old historical application coverage was 69/87; do not add that number to this table or infer missing results from lost private reports.

## Feature regression evidence

- Current local suite including settings concurrency protection: 551 tests, 549 passed, zero failures, two opt-in skips. Lint, typecheck, package-install and five native checksums passed. Concurrent shared-object host refreshes, child-process writers, stale host refresh, passphrase rotation and crashed lock-owner release have regressions. A two-session binary test also rejected a stale host-refresh save without overwriting the newer model setting.
- Historical n8n inspection and reviewed prefix preservation completed on all six remaining hosts through staged run15. Alma/Alpine/Ubuntu acquisitions timed out; Debian/Oracle acquisitions succeeded; Rocky's old durable result remains unavailable. Prefixes now reside in private no-clobber recovery directories; old baselines/caches/results are retained. This is not a fresh application lifecycle pass.
- Live WordPress pause/resume and controller rollback: Fedora #7. Baseline and every other deployment/rollback command had exactly one recorded dispatch.
- Live remaining-plan revision recovery: Ubuntu Jellyfin #12 revision3. Preserved3 completed setup commands, separately approved4 replacements and reviewed original3-command rollback. Exactly1 dispatch per completed setup/replacement; obsolete revision2 remained unapproved. This was recovery from a confirmed apt-lock failure, not replay of an uncertain result.
- Live multi-host health: completed run8, with earlier run4 including saved per-host assessments. Run9 Jellyfin tasks are cleaned up, but its old aggregate rollback projection remains stale pending normal reviewed controller refresh. New staged preservation run15 completed its canary and all three gated batches.
- Earlier live crash/recovery, connection reuse, leases, intervention, loop protection, console authorization, streaming and replay results remain documented in the checkpoint. They are historical evidence, not fresh reruns of every scenario on every host.
- Linux-only lab results do not prove real FreeBSD, macOS, Windows, Docker/Podman or Kubernetes behavior. Platform fixtures remain separate evidence.

Never approve old run6 alongside run9, replay uncertain jobs, delete preserved prefixes, or overwrite the original Ubuntu MariaDB backup. Restore original Ubuntu MariaDB only through its reviewed compatible-version recovery workflow.
