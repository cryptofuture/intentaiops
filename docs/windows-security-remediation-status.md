# Windows security remediation lab

Completed: isolated PHP image remediation passed on Windows, all test-owned Docker resources were removed, prerequisite tasks 35/36 were rolled back, and post-reboot tracked baseline assertions passed. No uncertain work or owned reboot jobs remain. The test uses a fixed repair proposal, not live AI repair selection or a full WordPress deployment.

Instructions below are historical, not pending work. Do not replay tasks 35-39; a future live test needs newly approved prerequisites.

Operator authorized Docker/WSL reinstallation, required lab reboot, an isolated old-image remediation test and restoration of the original baseline.

The initial read-only check found Docker absent. No fixture was created by that check. Do not reuse old Docker task 4/5 approvals or replay their completed rollback commands.

2026-10-27T07:06:38.758Z accepted prepare, operation=14890307-0289-4da4-8002-208920c1dcd6

2026-10-27T07:06:49.805Z Docker prerequisite task=35, prepared through actual CLI binary

2026-10-27T07:06:49.829Z accepted execute, operation=2c326e65-5044-49c4-a870-b906cb551200

2026-10-27T07:09:53.281Z Docker prerequisite task=35, status=completed; validate-virtualization=completed, preflight=completed, enable-wsl=completed, start-wsl-download=completed, wait-wsl-download=completed, verify-wsl-installer=completed, install-wsl-runtime=completed, start-docker-download=completed, wait-docker-download=completed, verify-docker-installer=completed, install-docker-desktop=completed, start-docker-desktop=completed, wait-docker-ready=completed, schedule-required-reboot=completed, audit-software-security=completed

Task 35 confirmed `WEBMINAI_REBOOT_SCHEDULED_30_SECONDS`. SSH subsequently timed out during banner exchange. Wait for the existing authorized reboot and startup SSH/Netdata recovery; do not replay installation or reboot commands. The image fixture has not been created yet.

2026-10-27 07:20 UTC: The configured destination and current `SSH_HOST_WIN` both point to 172.19.0.1:2222. TCP connects but closes before an SSH banner. No further remote mutation is possible. VM console inspection requested. Docker/WSL task 35 remains installed; its reviewed rollback and post-cleanup feature/PATH/reboot baseline checks are still required.

Local verification: 890 regression tests and all 18 workspace browser tests passed; lint, JSDoc contract checks, frontend build, installed-package smoke, checksums and diff whitespace checks passed. Security review screenshot is ignored at `artifacts/browser-screenshots/security-repair-review.png`.

Resume only after SSH/Netdata return:

1. Inspect task 35 and verify Docker readiness. Do not rerun completed installation/reboot commands.
2. Run `INTENT_SECURITY_PATCH_WINDOWS=1 node --test test/windows-security-remediation.integration.test.js` with the existing `VAULT_TEST` and profile. It creates only isolated labeled fixtures, not an exposed service. Its planner is a fixed fixture, so this does not certify AI repair selection.
3. After successful scoped fixture cleanup, run `node scripts/validate-windows-security-lab.js restore 35` through the actual CLI binary.
4. Verify task 35's protected original baseline, including Windows features, PATH and pending reboot. If rollback requires another authorized cleanup reboot, record/review it separately and never repeat completed rollback commands.

Retry inspection: SSH and Netdata returned. Task 35's protected progress confirms `rebootRequired=true`, both feature names in `featuresChanged`, and no `dockerInstalledByTask`/`wslInstalledByTask`. The builder intentionally returns a reboot-required marker and skips installers until reboot. Therefore its completed command states do not mean Docker was installed. Both features now report enabled. No fixture exists. Prepare a new reviewed continuation task with fresh inventory, retain task 35's feature ownership, and roll continuation tasks back before task 35.

2026-10-27T07:33:57.745Z accepted prepare, operation=b97e2547-6efc-47ea-b11a-aadcdc4c6b5a

2026-10-27T07:34:08.781Z Docker prerequisite task=36, prepared through actual CLI binary

2026-10-27T07:34:08.804Z accepted execute, operation=5d868214-1229-4909-b1df-9f936bdfa30b

Task 36 continuation: WSL download, pinned checksum/Authenticode verification and runtime installation completed. Docker Desktop BITS download is active. Observe the existing execution; do not replay completed WSL work. Task 35 still owns the original feature changes.

07:50 UTC: Docker BITS transfer `WebminAI-Docker-36` has transferred 309,227,374 of 1,006,649,344 bytes. This is normal bounded download polling, not an unknown installer outcome. Restore task 36 before task 35 after fixture testing. No fixture exists yet.

08:06 UTC: the same Docker BITS transfer reached 677,156,108 bytes (about 67%). Added reviewed Windows Docker catalog refresh support, retaining the original bounded retry policy, unchanged completed installer commands and unchanged rollback. If polling expires, use `node scripts/validate-windows-security-lab.js refresh 36` after the current CLI runtime closes; this reviews new remaining-work command IDs without restarting the existing download. Focused continuation/CLI tests and the full regression suite passed.

08:12:28 UTC: task 36's declared download polling window ended with confirmed exit 75, status partial. All WSL steps and Docker transfer creation are completed; no unknown installer outcome. BITS continues independently. Starting a reviewed trusted remaining-work refresh for task 36, not a new transfer or a replay of completed commands.

2026-10-27T08:12:28.811Z Docker prerequisite task=36, status=partial; validate-virtualization=completed, preflight=completed, enable-wsl=completed, start-wsl-download=completed, wait-wsl-download=completed, verify-wsl-installer=completed, install-wsl-runtime=completed, start-docker-download=completed, wait-docker-download=failed, verify-docker-installer=pending, install-docker-desktop=pending, start-docker-desktop=pending, wait-docker-ready=pending, schedule-required-reboot=pending, audit-software-security=pending

2026-10-27T08:13:31.432Z accepted reconcile, operation=982ecc37-fcad-4668-a9e0-42a638a9ec7d

2026-10-27T08:13:37.488Z accepted refresh-catalog, operation=6015cd3f-825a-4055-8cc1-9909dc42853e

2026-10-27T08:13:42.981Z accepted approve, operation=16de9082-0102-43f4-a99f-16a99c297e1f

2026-10-27T08:13:42.997Z Docker prerequisite task=36, reviewed trusted revision=35; confirmed completed commands and original rollback preserved

2026-10-27T08:13:43.022Z accepted execute, operation=a5793945-f7d8-48ef-af3a-39b2653322f4

08:18 UTC: existing Docker transfer completed and the installer passed pinned SHA-256 and Authenticode checks. Task 36 revision 35 is running `install-docker-desktop-catalog-e9368b2228b5` as a durable job. Do not replay it while observing the job. WSL and transfer-creation commands remain completed exactly once.

2026-10-27T08:20:49.014Z Docker prerequisite task=36, status=completed; validate-virtualization=completed, preflight=completed, enable-wsl=completed, start-wsl-download=completed, wait-wsl-download=completed, verify-wsl-installer=completed, install-wsl-runtime=completed, start-docker-download=completed, wait-docker-download-catalog-af20ab04fed4=completed, verify-docker-installer-catalog-f91b6f69aa0f=completed, install-docker-desktop-catalog-e9368b2228b5=completed, start-docker-desktop-catalog-c97edad744ee=completed, wait-docker-ready-catalog-3ca3015df6ce=completed, schedule-required-reboot-catalog-2b043f10425b=completed, audit-software-security-catalog-deb737789938=completed

2026-10-27T08:21:01.542Z Docker prerequisite task=36, actual Docker readiness=false; completed reboot-gated phases may require a separately reviewed continuation task

Direct signed Docker preflight subsequently succeeded. Fixture harness task creation initially failed its existing kind/catalog validation before creating any remote fixture; corrected the test to declare its catalog-collector fixture explicitly, not weaken validation. Task 37 now runs the isolated PHP test (explicitly not a WordPress installation). Old PHP image pull completed; pinned patched-image pull is durable job `cc7d550382fe22f368c9a249ea0f0634`. Observe/reconcile that job before cleanup or any repeat. Restore task 36 and then task 35 after task 37's scoped cleanup.

Task 37 passed old-version detection, bad-fingerprint rejection, separate revision approval, replacement with PHP 8.4.27, persistent sentinel verification and no deployment replay. Original cleanup removed containers/images but missed its volume because the Windows Docker adapter returns buffered text, not line objects. Corrected the fixture's line splitting. New reviewed cleanup revision 38 removed that exact owned unattached volume, then its empty-output verification hit a null-handling error; revision 39 verified absence successfully without replaying original deletion. Full fixture rerun started after task 37 returned to reverted, with no uncertain work.

Task 35's protected original baseline was read through signed diagnostics before removal: schema version 2, `dockerExisted=false`, `wslRuntimeExisted=false`, `dockerPathPresent=false`, `VirtualMachinePlatform=Disabled`, `Microsoft-Windows-Subsystem-Linux=Disabled`. These are the explicit final restoration targets; no raw PATH or credentials exported.

Full isolated fixture rerun task 38 PASSED (395.6 seconds): old PHP 8.4.23 detection, stale/bad approval rejection, separately approved replacement with digest-pinned PHP 8.4.27, preserved sentinel, no replay of completed deployment, reviewed rollback and final absence checks for fixture containers/volume. No application installation or AI repair-selection coverage is claimed. Restoring prerequisite task 36, then feature-owner task 35 through the actual CLI.

Task 36 reviewed rollback completed at 08:49:16 UTC: task-owned Docker and WSL MSIs uninstalled, own feature changes handled (none in this continuation), original Docker PATH presence respected and task-owned files/jobs removed. Task 35 feature-owner rollback is now running. Do not repeat task 36 rollback; final baseline comparison/reboot remains to be checked.

2026-10-27T08:35:20.949Z Fixture task=37, new scoped cleanup revision=38; exact owner checked and completed rollback will not be replayed

2026-10-27T08:35:21.617Z accepted approve, operation=507e5c02-c142-428a-ae87-f831053939c2

2026-10-27T08:35:21.659Z accepted rollback, operation=f61f81e5-8d07-48a9-be92-2f08f86d61ba

2026-10-27T08:39:06.864Z Fixture task=37, new scoped cleanup revision=39; exact owner checked and completed rollback will not be replayed

2026-10-27T08:39:07.483Z accepted approve, operation=70175ccb-2628-48e0-acc3-e8bd559a44fc

2026-10-27T08:39:07.514Z accepted rollback, operation=1113e958-e6ce-4f7f-b554-cab3ff2850cb

2026-10-27T08:39:18.562Z Fixture task=37, new reviewed volume cleanup completed with explicit ownership/absence checks

2026-10-27T08:47:36.627Z accepted rollback, operation=0a4c62af-cec1-4606-91eb-1624c6ac7d7d

2026-10-27T08:49:16.315Z Docker prerequisite task=36 reviewed rollback completed; verify original features, PATH and reboot state separately

2026-10-27T08:51:21.764Z accepted rollback, operation=9ab8a333-6509-493d-b782-f41909cc39ad

2026-10-27T08:52:39.967Z Docker prerequisite task=35 reviewed rollback completed; verify original features, PATH and reboot state separately

2026-10-27T08:56:04.509Z Cleanup reboot task=39, source rollback=35; fixed reviewed scheduling and SSH/Netdata startup recovery only

2026-10-27T08:56:05.040Z accepted execute, operation=5c1ccd65-63a5-4a6c-945a-d40bef9e5bcd

2026-10-27T08:56:19.097Z Cleanup reboot task=39 scheduling confirmed; observe the existing restart without repeating it

Post-reboot signed probe confirmed new boot identity `2026-10-27T08:56:58.5000000Z` (previously `2026-10-27T07:26:56.3873240Z`). Docker CLI and WSL runtime are absent, Docker PATH entry count is zero, both optional features are Disabled, task 35/36 state directories are absent and CBS pending reboot is false. Startup recovery removed its own job; the one-time reboot job is awaiting its configured automatic expiry before the final absence assertion.

Final signed assertion passed: Docker/WSL absent, zero Docker PATH entries, both features Disabled, no CBS pending reboot, task 35/36 state absent, changed boot identity and zero `IntentAI-Security-*` scheduled tasks. Local history assertions passed: tasks 35/36/37/38 reverted, reboot task 39 completed, each prerequisite installer and transfer creation dispatched exactly once, cleanup reboot dispatched once. Preexisting user data/caches and persistent audit history were preserved; whole-filesystem equality is not claimed.

Final raw `npm test` summary: 1,069 tests, 1,047 passed, zero failures, 22 opt-in tests skipped. The live Windows fixture passed separately. Lint, JSDoc contract checks, installed-package smoke, checksums and diff checks passed. Earlier compressed runner counts in historical notes are superseded by this raw summary.

Final browser rerun: all 18 workspace tests passed, including security repair review and all 27 theme galleries. The distribution tarball was rebuilt and its installed-package smoke passed after documentation updates. No live lab CLI or fixture processes remain running.

