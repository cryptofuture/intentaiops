# Security validation checkpoint

Observed: 2026-10-27.

## Completed

- Catalog coverage: 76 entries across Linux, FreeBSD, macOS, Windows and Kubernetes.
- PHP and Next.js/RSC version rules, bounded collectors, reviewed plan integration, saved CLI/browser recommendations and public advisory candidate matching.
- Cloudflare's coverage/evidence separation incorporated without skill installation. No independent multi-agent audit claimed.
- Moodle container PHP base updated to 8.4.27 with the official multiarchitecture digest; shared image revision bumped to r3. Task-owned container and FreeBSD PHP configuration disables session upload progress.
- `npm test`: 886 tests passed.
- `npm run lint`, `npm run typecheck`, `npm run build:web`, `npm run test:package-install`, `npm run check:checksums`, `git diff --check`: passed.
- Live Windows signed read-only collector and bounded native-process helper: passed. No software changed.

## Unfinished or unavailable

- FreeBSD 14.4/15.1 live collector checks require terminal authentication. macOS at 172.30.0.2 timed out. No live Linux host check ran in this security pass.
- The new Moodle r3 image has not been cold-built or application-tested. Prior r2 validation does not cover it.
- Online public review at 06:45:57 UTC encountered GitHub 403 rate limits, release-feed 404s and a truncated n8n advisory listing. These are coverage gaps, not clean results.
- Advisory/source-pin matches remain candidates without severity. Selected runtime, vendor backports, transitive dependencies and active worker configuration need validation.
- No blanket software upgrade or automatic source-patch deployment performed. Review compatible maintained releases and test each changed route before claiming remediation.
- No exploit testing or full independent Cloudflare-style source audit performed.

Resume with `npm run audit:software -- --online --json` after public API limits reset. Recheck named disposable hosts using the opt-in test in `test/software-security.integration.test.js`; never infer a safe verdict from an unavailable collector.

## Reviewed remediation workflow

- Added CLI post-install offer and operator action, browser repair action and shared controller preparation of executable security-update revisions.
- Uses allowlisted runtime findings, fresh planning inventory, ordinary validation, canonical approval and host/task ownership. Completed installation commands remain immutable. A new uniquely identified collector checks the updated runtime; an older successful assessment cannot hide a failed latest assessment.
- Native repairs request vendor packages; Docker/Podman repairs request an updated/rebuilt image and service recreation with data preserved. These are reviewed AI proposals, not a universal deterministic patch engine. Kubernetes remediation is not added.
- Regression suite after these changes: 889 tests reported passed. Lint, contract checks, frontend build and installed package smoke passed.
- Added `test/windows-security-remediation.integration.test.js`, opt-in with `INTENT_SECURITY_PATCH_WINDOWS=1` and the existing `VAULT_TEST`. It uses a fixed fixture repair plan, not AI plan selection, to check PHP 8.4.23 detection, separate approval, replacement with pinned PHP 8.4.27, preserved volume data, no deployment replay and scoped cleanup.
- The live Windows attempt stopped during read-only preflight: `docker.exe` is unavailable to LocalSystem. No fixture task, image, container or volume was created. Docker/WSL were removed by the earlier baseline restoration. Reinstallation/reboot approval has been requested; the live update result remains unverified.
- Operator subsequently authorized reinstallation and restoration. Actual CLI prerequisite task 35 completed, scheduled its authorized reboot, and SSH has not yet returned. Follow `docs/windows-security-remediation-status.md`; do not repeat task 35's completed installation/reboot commands.
- All 18 workspace browser tests passed using `/usr/bin/google-chrome`, including security revision review, normal task approval, reload, multi-host handling and the 27-theme gallery. Security review screenshot: ignored `artifacts/browser-screenshots/security-repair-review.png`.
- Final regression rerun: 890 tests passed. Package installation and checksums passed again. Windows SSH remains unavailable more than ten minutes after task 35's scheduled reboot; fixture validation and prerequisite restoration remain pending, not passed.

## Completed Windows follow-up

Windows SSH returned. Task 35 was the reboot-gated feature phase, not a completed Docker installation. Continuation task 36 installed verified WSL/Docker; a reviewed trusted-catalog refresh continued its slow BITS download without repeating installers. Added focused coverage for this Windows prerequisite refresh and recognition of refreshed security-collector IDs.

The full isolated Windows fixture task 38 passed: PHP 8.4.23 detected, separate canonical approval required, digest-pinned PHP 8.4.27 replacement verified, sentinel preserved, completed deployment not replayed, reviewed cleanup and final resource absence verified. Task 37's earlier fixture cleanup bugs were corrected through new reviewed cleanup revisions, not replay of completed deletion. The fixed fixture does not verify Codex's repair choice or a full application installation.

Prerequisite tasks 36 and 35 were rolled back in order. Authorized cleanup reboot task 39 completed once. Signed post-reboot assertions confirm the tracked original baseline and no owned reboot jobs. Details: [Windows checkpoint](windows-security-remediation-status.md).

Final raw automated summary: 1,069 tests, 1,047 passed, zero failures, 22 opt-in skips; live Windows fixture passed separately. Historical compressed runner counts above are superseded. Other platforms, arbitrary source patches and universal application remediation remain unverified, not implied by this Windows test.
