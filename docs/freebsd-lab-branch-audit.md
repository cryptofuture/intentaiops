# FreeBSD branch-feature validation

Comparison: `main` at `fe55614b5ef780dbae582008103a0e905e41cdd2`, branch
`yet-to-test` at `3a44b7431acfcfa5836c85c933e7b9f3834e6afc`, plus current
lab harness and rebuilt FreeBSD plugin. The common-task matrix and this feature
matrix are separate acceptance criteria. An installation pass does not prove
crash recovery, interactive controls or browser behavior.

Live evidence and operation IDs: [checkpoint](../freebsd-lab-validation-status.md).
Private originals and resumable state are in gitignored
`artifacts/freebsd-common/`. Do not reset the VMs or delete old recovery state.

## Scope and current evidence

| Changed area | Live acceptance case | Current result |
| --- | --- | --- |
| Shared prepare/review/execute | CLI-created durable plans, canonical fingerprint approval, journalled dispatch and results | Health and eleven applications completed reviewed apply/rollback cycles on each host. Both n8n and Ghost now pass exact package/path/account restoration. Earlier failed baselines remain preserved, not relabelled as passes |
| Native FreeBSD protocol | Build current source on oldest supported major, deploy through reviewed update, compare installed hashes | Passed build on 14.4; both installed hashes match |
| Host registration and identity | Existing vault, supplied SSH key/known hosts, distinct fingerprint-bound histories | Both added and verified, strict SSH checking retained |
| Journal and ownership | Before-dispatch intent, stable attempt/job identifiers, completed-step skipping, conflicting execution rejection | Intent/dispatch/results recorded; collision guard blocked before dispatch. An independent interactive CLI was refused a shell on 14.4 while application task 3 owned the host, with original preparation dispatched once. Crash tests remain pending |
| Reconnection and uncertain work | Lose observation of an isolated durable marker job, reconnect/reconcile, no duplicated write, reviewed continuation | Actual 15.1 n8n memory-pressure incident killed Netdata. After restoring its original service, existing durable job c5f24ed4cc11fad3de2c614f41b21a14 was reconciled to recorded exit 137 without replay. Deliberate marker-job crash/reconnection coverage remains pending; identifying memory pressure did not authorize retry |
| Pause and abort | Pause before next command without killing active work; inspect pending queue; abort remaining steps | 14.4 WordPress task 10 finished its acknowledged image build, recorded boundary pause before deployment, then separately reviewed resume skipped both confirmed image builds. Later deployment failed on a missing runtime utility and was separately cleaned with exact baselines. Fresh task 13 passed. Abort-after-dispatch fixture remains pending |
| Plan revision | Preserve completed evidence, compare remaining steps, reject stale approval, approve a changed fingerprint | 15.1 n8n task 16 used trusted FreeBSD catalog refresh, separate approval and execution after confirmed npm failures. Its original preparation and runtime each dispatched exactly once across three revisions. Stale-approval regression tests pass; final apply, verification, rollback and exact baselines passed |
| Reviewed rollback | Apply/verification/restart, reviewed rollback, exact package/path baseline | Eleven applications on each host passed reviewed rollback and package/path/account baselines: WordPress, WooCommerce, Joomla, Drupal, PrestaShop, Moodle, Nextcloud, Jellyfin, Mattermost, n8n and Ghost. Historical failures remain immutable. Odoo, Home Assistant, Magento and CLI installation still need complete cycles |
| Remote signed ledger | Persistent target-bound records, signature/chain verification, redacted discovery | Records created; live retrieval and tamper-fixture checks pending |
| Fresh-install catalog recovery | Reject unsupported profiles; never execute saved remote shell code | Current `commonTaskRecoverySupported` allows Linux profiles only. FreeBSD verified regeneration is unavailable, not a claimed pass |
| Evidence-based diagnoses | Native nonzero exit, bounded timeout versus cancellation, boot identity, denied/unavailable evidence | Health records include FreeBSD boot-time/filesystem evidence. Actual missing-package error exposed a classifier gap, fixed with failing-then-passing regression. Both Odoo runtime jobs recorded authoritative TIMEOUT during package download; unchanged package versions, Python integrity, absent application roots and process cleanup were checked before separately approved continuation. Explicit cancellation coverage remains pending; Linux cgroup OOM evidence is not applicable |
| SSH reuse | Same compatible host reuses a master; SCP update and command channels share transport; independent hosts remain independent | All 28 benchmark workload/mode combinations completed on the two hosts, two repetitions each. Pooled mode established two masters, recorded 14 reuse hits and 164 channels, with zero cleanup failures. Reconnection fault cases remain pending |
| Loop protection | Identical failures stop automatic repair; changed evidence remains eligible for review | Deterministic regression coverage required; no unattended repair loop will be started on a host |
| Multi-host rollout | Two-host simple tasks, per-host review, canary failure halts next stage, selected continuation does not repeat completed hosts | Pending; use fixtures, not concurrent application installs |
| Browser workspace | Authenticated real FreeBSD host/task states, SSE reconnect, pause/review/recovery controls, safe shell and metrics availability | Actual Chromium Playwright shell test passed on 15.1: connection, command roundtrip, PTY resize, reload/reattach, retained output, theme and explicit close. Real node-scoped RAM responses on both hosts exposed a Linux-only gauge; the fixed adapter follows Netdata's FreeBSD category formula and passed live checks plus incomplete/ambiguous-data regressions. Full managed-workspace browser checks remain pending |
| Secrets and settings | Concurrent guarded writes, no credentials in events/exports, history retained across reconnect | Credentials not written in checkpoints; export/redaction and settings regression checks pending |
| Planner/model changes | Read-only/simple FreeBSD request uses local planner, correct platform restrictions and approved execution | Pending; model availability itself is not proven by a host-health pass |
| Replay/export | Replay recorded FreeBSD events without any host mutation | Pending |
| Package installation | Installed tarball contains current native artifact and launches CLI/web without development build | Rebuilt tarball installed successfully in Linux/x64 smoke test; native FreeBSD CLI installation is still pending |

Kubernetes-only gateway controls, Windows Job Objects, Linux cgroups and Docker
Linux CPU/image alternatives are not validated by these FreeBSD VMs. Keep their
automated checks separate from FreeBSD live coverage.

## Native build provenance

Built with the repository's `scripts/build-native-plugin.sh freebsd` on
FreeBSD 14.4 using its existing clang 19 compiler. No compiler packages were
installed. The temporary build directory was removed after fetching the
artifact. The build checked platform metadata and static linkage.

Source SHA-256:
`e844497d27764b54255fea25d716adf0e87c3b0265f11d5335e79b9b6cebe6dd`.
New amd64 artifact and both installed copies:
`b02f14b83f7287dcfb167b5cd2e84be1a05d3dcc74086a8fd772b56bc203f584`.
Reported protocol version remains `0.7.2`. All five distribution checksums
verified after replacing the artifact. This is an artifact refresh from current
source, not a new protocol or a claimed FreeBSD arm64 build.

## Historical verification checkpoint

After the Jellyfin package-revision and failure-classifier fixes, `npm test`
reported 873 tests: 870 passed, three opt-in skips, zero failures. Lint,
typecheck, five-artifact checksum verification and package-install smoke passed.
The package SHA-256 is
`4fd61583caf660b1e7ec1a77a4c3317f9231e1b4a23786275471e50ab651f6e9`.

The Jellyfin fix was live-retested as FreeBSD 14.4 task 3. Apply, native
HTTP/version/storage/database checks, restart checks and reviewed rollback
completed. Exact package restoration did not pass: existing curl and CA-root
packages upgraded during installation. Original baselines remain retained.
The earlier pkg 2.7.5 to 2.8.4 upgrade was retained following continuation approval.

Current-release maintenance task 4 on 14.4 exposed the five-minute direct-call
limit. Base files changed, package downloads stopped, and the journal correctly
marks the update outcome unknown. No updater process remained at inspection;
this alone does not establish the command's complete outcome. No automatic
replay was attempted. FreeBSD maintenance now uses the existing durable-job
mechanism with a one-hour bound, matching Linux maintenance. A focused test
checks the execution mode and bound. Task 4 on 15.1 is testing that path.

Runtime package names for n8n, Ghost, Home Assistant, Odoo and Magento now
select the supported package family rather than removed patch-specific names;
runtime compatibility checks remain. Mattermost's reviewed package is 11.7.10_1.
These changes require live application validation, not just package lookup.

SSH measurements are saved privately in `artifacts/freebsd-common/ssh-benchmark.json`.
Two repetitions are useful transport coverage, not a statistical performance
guarantee. Browser logs are in the same private directory. The inspected shell
screenshot is under `artifacts/browser-screenshots/freebsd-lab/` (gitignored).
