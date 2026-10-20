# Linux LXD Docker validation checkpoint

Scope: package installation, prerequisite handling, failure reporting and rollback
on the existing nine Linux lab hosts. Do not enable nesting, change LXD privileges
or claim container/Compose readiness from a package installation alone.

## Current package-only run

The original blocked observations below predate the explicitly approved bypass.
The timestamped entries at the end record actual installation and reviewed
rollback operations. Debian, Ubuntu, Alpine, Arch, openSUSE, Fedora, AlmaLinux and
Oracle have restored their captured package/path baselines. Fedora needed a
separately reviewed cleanup protecting all baseline packages while permitting
removal of newly introduced packages. RPM cleanup also removes the known Docker
repository signing key only when absent from the original snapshot. Both short
RPM key IDs and Fedora's full-fingerprint format were observed and handled.
Rocky's installation cycle and the final Alpine repeat also passed. All nine
hosts have a completed package installation and three completed rollback steps.

| Host | Task | Package installation | Captured package/path baseline |
| --- | --- | --- | --- |
| Debian 13 | 79 | Completed | Restored |
| Ubuntu 24.04 | 73 | Completed | Restored |
| AlmaLinux 9 | 52 | Completed | Restored |
| Alpine 3.23 | 45 (also 43) | Completed | Restored |
| Arch | 47 | Completed | Restored |
| Fedora 44 | 39 | Completed | Restored after reviewed cleanup revisions |
| openSUSE 16.0 | 58 | Completed | Restored |
| Oracle 9 | 43 | Completed | Restored after reviewed cleanup revision |
| Rocky 9 | 50 | Completed | Restored |

Final verified-SSH inspection confirmed Docker CLI, Docker group and the listed
task's Docker baseline directory absent on every host. Ubuntu Netdata is restored
to its original inactive/disabled state. The foreground test CLI exited normally;
no package test remains running. Rocky and the final Alpine repeat reported
`DOCKER_SERVICE_NOT_READY` with allowlisted diagnostics and sensitive output still
withheld. Earlier recorded generic categories were preserved, not rewritten.

Debian and Ubuntu's daemon probes succeeded, but no containers were launched.
The other daemon probes explicitly returned exit 78. These are package-only
results, not verified Docker runtime/container support.

The temporary application-side bypass and its dependent live-test harness were
removed after validation at the operator's request. There is no environment
switch, package-only execution branch or special lab rollback path in the
application. General installer, rollback, redaction and pre-dispatch status fixes
remain. Tests use ordinary native-host fixtures and confirm unsupported container
installations are rejected. Historical records and private JSON checkpoints under
gitignored `artifacts/docker-package-lab/` were preserved.

During the historical run, package hooks could start services, but no container
was launched and no LXD isolation setting changed. Package/path restoration does
not prove every package script's side effects were undone. Fedora's earlier DNF
plugin attempt created an `unbound` account requiring a separate ownership check.

### Automated checks

- Focused Docker/controller/validator/diagnostic regression tests: 71 passed.
- After removing the bypass-specific controller test, 70 focused tests passed.
- `npm run lint` and `npm run typecheck`: passed.
- `npm test`: 836 tests, 832 passed, 3 skipped, 1 pre-existing failure because
  `test/cli-display.test.js` reads deleted `docs/muxin-provenance.md`.
- `npm run test:package-install`: blocked by the same stale required-file check
  in `scripts/build-package-tarball.js`. No attribution files were restored or
  removed as part of Docker validation.

### Reviewed pre-dispatch rejections

Rocky tasks 48/49 and Alpine task 44 were rejected before any command preparation
or dispatch. The old workspace incorrectly labelled them running, blocking later
host work. Verified their zero results, pending execution states and absence of
command preparation/dispatch events, then recorded local inspection, marked them
partial and aborted remaining work under task leases and host ownership. No
remote directories, commands or execution history were deleted or replayed.
The workspace now marks work running at the persisted `command_prepared` event,
not before remote ownership checks. A regression test covers failed preflight.

## Initial read-only checks, before the approved bypass

- Started the actual `bin/intentaiops.js --web --console-actions --no-debug`
  against `/home/vscode/.intentaiops`, unlocking the existing vault through its
  terminal prompt with `VAULT_TEST`. No new vault was created.
- Used authenticated inventory and catalog reads from that foreground process.
- TCP port 22 is reachable on all nine host IPv4 addresses.
- No installation, preference changes, rollback, isolation changes or uncertain
  command replay was performed.

| Host | Observed prerequisite state | Installation/rollback |
| --- | --- | --- |
| webminai-almalinux-9 | LXC; Docker absent; installSupported=false; no install method | Blocked, not attempted |
| webminai-alpine-323 | LXC; Docker absent; installSupported=false; no install method | Blocked, not attempted |
| webminai-arch | LXC; Docker absent; installSupported=false; no install method | Blocked, not attempted |
| webminai-debian-13 | LXC; Docker absent; installSupported=false; no install method | Blocked, not attempted |
| webminai-fedora-44 | LXC; Docker absent; installSupported=false; no install method | Blocked, not attempted |
| webminai-opensuse-160 | LXC; Docker absent; installSupported=false; no install method | Blocked, not attempted |
| webminai-oracle-9 | LXC; Docker absent; installSupported=false; no install method | Blocked, not attempted |
| webminai-rocky-9 | LXC; Docker absent; installSupported=false; no install method | Blocked, not attempted |
| webminai-ubuntu-2404 | Inventory and catalog return HTTP 409: Netdata GET /api/v3/info?options=full failed, SSH command exit 7 | Blocked, not attempted |

## Findings and next decision

`NetdataClient.dockerExecutionInventory()` in `src/netdata-client.js` sets an
installation route only when `containerRuntime=none`. All eight inspected hosts
therefore have no route regardless of an explicit Docker preference override.
`commonTaskEligibility()` refuses `docker-linux` without that route.

Package-only installation cannot currently be verified through this common task
without changing the implementation. Do not bypass the catalog with manual
package commands and report that as a verified common-task pass. An explicit
package-only validation path would need to retain the default LXC safeguard,
require approval, distinguish package installation from daemon/container
readiness, and prove rollback after a partially applied installation.

Ubuntu additionally needs its Netdata connectivity investigated through the
saved, verified connection. A separate direct diagnostic using the repository's
lab known-hosts file was refused because that file lacks its IPv4 host-key entry;
no host key was accepted or changed. The actual CLI connection did reach SSH.

## Automated checks

`node --test test/docker-policy.test.js test/common-tasks.test.js`: 33 passed.
These are deterministic tests, not proof of live package installation or rollback.

## Approved temporary package-only bypass

The operator approved bypassing Docker container eligibility for this lab run.
`INTENT_DOCKER_PACKAGE_LAB_HOSTS` is process-local and restricted to the nine named
LXD hosts. Normal eligibility and explicit disabled preferences remain unchanged.
Plans are labelled LAB ONLY, retain validation/approval/journaling/ownership,
and never run a container or change nesting, cgroups, security profiles or host
privileges. Runtime availability is reported separately from package installation.

Ubuntu Netdata was observed inactive and disabled, with its previous stop recorded
as successful. Start it temporarily to obtain signed Stage 2 access for these tests;
after completed rollback, stop it again and retain its disabled startup state.
Do not stop it while command outcomes remain unresolved.

- 2026-10-20T08:20:45.700Z webminai-debian-13: Default LXC prerequisite blocked; explicit process-local package bypass selected

- 2026-10-20T08:20:45.709Z webminai-debian-13: prepare accepted; operation d1ccce02-b047-4d83-8559-d2948f7f7568

- 2026-10-20T08:20:46.731Z webminai-debian-13 task #78: BLOCKED: Expected values to be strictly equal: 4 !== 0 

- 2026-10-20T08:21:27.718Z webminai-debian-13: Default LXC prerequisite blocked; explicit process-local package bypass selected

- 2026-10-20T08:21:27.728Z webminai-debian-13: prepare accepted; operation 22a45437-fc5c-43b7-9dbe-aa460c54da44

- 2026-10-20T08:21:28.752Z webminai-debian-13 task #79: Reviewed lab plan [redacted-64-hex]; four commands and three guarded rollback steps

- 2026-10-20T08:21:28.758Z webminai-debian-13 task #79: execute accepted; operation 9ded23ee-e5b3-4996-9940-8681e9047e0e

- 2026-10-20T08:24:00.086Z webminai-debian-13 task #79: Observed execution completed: [{"id":"validate-container-host","status":"completed","exitCode":0},{"id":"capture-docker-baseline","status":"completed","exitCode":0},{"id":"install-docker-engine","status":"completed","exitCode":0},{"id":"verify-docker-engine","status":"completed","exitCode":0}]

- 2026-10-20T08:24:00.098Z webminai-debian-13 task #79: rollback accepted; operation 2b985bc7-b00c-4dfe-9285-4e359e45686a

- 2026-10-20T08:24:06.115Z webminai-debian-13 task #79: Rollback reverted: [{"id":"restore-docker-baseline","status":"completed","exitCode":0},{"id":"verify-docker-baseline","status":"completed","exitCode":0},{"id":"remove-docker-task-state","status":"completed","exitCode":0}]

- 2026-10-20T08:24:59.508Z webminai-ubuntu-2404: Default LXC prerequisite blocked; explicit process-local package bypass selected

- 2026-10-20T08:24:59.518Z webminai-ubuntu-2404: prepare accepted; operation 03e0f551-aa2c-4b22-bc0d-ed150115e49e

- 2026-10-20T08:25:01.548Z webminai-ubuntu-2404 task #72: Reviewed lab plan [redacted-64-hex]; four commands and three guarded rollback steps

- 2026-10-20T08:25:01.553Z webminai-ubuntu-2404 task #72: execute accepted; operation 749a1e15-8ae7-4650-b3a6-716b975a1d2c

- 2026-10-20T08:25:03.570Z webminai-ubuntu-2404 task #72: Observed execution completed: [{"id":"validate-container-host","status":"completed","exitCode":0},{"id":"capture-docker-baseline","status":"failed","exitCode":1,"failure":"COMMAND_FAILED"}]; mv: cannot stat '/var/lib/webminai/tasks/72/linux-docker/baseline.sha256.pending': No such file or directory 

- 2026-10-20T08:25:03.581Z webminai-ubuntu-2404 task #72: rollback accepted; operation 032ed77e-ef43-4ceb-834e-fe758cfb9584

- 2026-10-20T08:25:04.589Z webminai-ubuntu-2404 task #72: Rollback partial: []

- 2026-10-20T08:25:04.591Z webminai-ubuntu-2404 task #72: BLOCKED: Rollback incomplete; preserve state and investigate before any new attempt + actual - expected + 'partial' - 'reverted' 

- 2026-10-20T08:25:05.836Z webminai-almalinux-9: Default LXC prerequisite blocked; explicit process-local package bypass selected

- 2026-10-20T08:25:05.845Z webminai-almalinux-9: prepare accepted; operation 5520b69f-58bc-42d4-a808-0a1a018864fc

- 2026-10-20T08:25:06.869Z webminai-almalinux-9 task #51: Reviewed lab plan [redacted-64-hex]; four commands and three guarded rollback steps

- 2026-10-20T08:25:06.875Z webminai-almalinux-9 task #51: execute accepted; operation 00cb670f-98d9-445e-8716-27b058fb9aef

- 2026-10-20T08:25:08.897Z webminai-almalinux-9 task #51: Observed execution completed: [{"id":"validate-container-host","status":"completed","exitCode":0},{"id":"capture-docker-baseline","status":"failed","exitCode":1,"failure":"COMMAND_FAILED"}]; mv: cannot stat '/var/lib/webminai/tasks/51/linux-docker/baseline.sha256.pending': No such file or directory 

- 2026-10-20T08:25:08.912Z webminai-almalinux-9 task #51: rollback accepted; operation dd0835bc-41e0-434c-84b0-2f02467c7b94

- 2026-10-20T08:25:09.918Z webminai-almalinux-9 task #51: Rollback partial: []

- 2026-10-20T08:25:09.919Z webminai-almalinux-9 task #51: BLOCKED: Rollback incomplete; preserve state and investigate before any new attempt + actual - expected + 'partial' - 'reverted' 

- 2026-10-20T08:25:10.369Z webminai-alpine-323: BLOCKED: Host connection failed; inspect the launch terminal

- 2026-10-20T08:25:11.650Z webminai-rocky-9: Default LXC prerequisite blocked; explicit process-local package bypass selected

- 2026-10-20T08:25:11.659Z webminai-rocky-9: prepare accepted; operation 18dac13f-1167-421a-b648-c2fb26bc2588

- 2026-10-20T08:25:12.685Z webminai-rocky-9 task #47: Reviewed lab plan [redacted-64-hex]; four commands and three guarded rollback steps

- 2026-10-20T08:25:12.691Z webminai-rocky-9 task #47: execute accepted; operation cf71cfd9-5235-4fff-a077-33ac13ea7870

- 2026-10-20T08:25:14.719Z webminai-rocky-9 task #47: Observed execution completed: [{"id":"validate-container-host","status":"completed","exitCode":0},{"id":"capture-docker-baseline","status":"failed","exitCode":1,"failure":"COMMAND_FAILED"}]; mv: cannot stat '/var/lib/webminai/tasks/47/linux-docker/baseline.sha256.pending': No such file or directory 

- 2026-10-20T08:25:14.736Z webminai-rocky-9 task #47: rollback accepted; operation 7bb37258-7598-4a2a-80b1-e77ebf577dd5

- 2026-10-20T08:25:15.747Z webminai-rocky-9 task #47: Rollback partial: []

- 2026-10-20T08:25:15.749Z webminai-rocky-9 task #47: BLOCKED: Rollback incomplete; preserve state and investigate before any new attempt + actual - expected + 'partial' - 'reverted' 

- 2026-10-20T08:25:16.283Z webminai-arch: BLOCKED: Host connection failed; inspect the launch terminal

- 2026-10-20T08:25:17.533Z webminai-oracle-9: Default LXC prerequisite blocked; explicit process-local package bypass selected

- 2026-10-20T08:25:17.539Z webminai-oracle-9: prepare accepted; operation f8bd5355-6b29-408c-a32a-c90f94ed37bc

- 2026-10-20T08:25:18.559Z webminai-oracle-9 task #42: Reviewed lab plan [redacted-64-hex]; four commands and three guarded rollback steps

- 2026-10-20T08:25:18.565Z webminai-oracle-9 task #42: execute accepted; operation 69d568a0-2553-4209-8a03-4ca0715bb5ab

- 2026-10-20T08:25:20.592Z webminai-oracle-9 task #42: Observed execution completed: [{"id":"validate-container-host","status":"completed","exitCode":0},{"id":"capture-docker-baseline","status":"failed","exitCode":1,"failure":"COMMAND_FAILED"}]; mv: cannot stat '/var/lib/webminai/tasks/42/linux-docker/baseline.sha256.pending': No such file or directory 

- 2026-10-20T08:25:20.612Z webminai-oracle-9 task #42: rollback accepted; operation 50c61077-044c-466a-9880-ef006b29434b

- 2026-10-20T08:25:21.622Z webminai-oracle-9 task #42: Rollback partial: []

- 2026-10-20T08:25:21.623Z webminai-oracle-9 task #42: BLOCKED: Rollback incomplete; preserve state and investigate before any new attempt + actual - expected + 'partial' - 'reverted' 

- 2026-10-20T08:25:22.202Z webminai-opensuse-160: BLOCKED: Host connection failed; inspect the launch terminal

- 2026-10-20T08:26:14.730Z webminai-fedora-44: Default LXC prerequisite blocked; explicit process-local package bypass selected

- 2026-10-20T08:26:14.739Z webminai-fedora-44: prepare accepted; operation 175d9637-dd32-460e-b873-0ec37e19502d

- 2026-10-20T08:26:15.758Z webminai-fedora-44 task #38: Reviewed lab plan [redacted-64-hex]; four commands and three guarded rollback steps

- 2026-10-20T08:26:15.762Z webminai-fedora-44 task #38: execute accepted; operation 000e75eb-1eff-47c3-8b1f-b1aaf50b92ea

- 2026-10-20T08:26:35.829Z webminai-fedora-44 task #38: Observed execution completed: [{"id":"validate-container-host","status":"completed","exitCode":0},{"id":"capture-docker-baseline","status":"completed","exitCode":0},{"id":"install-docker-engine","status":"failed","exitCode":2,"failure":"COMMAND_FAILED"}]; [redacted sensitive output]

- 2026-10-20T08:26:35.842Z webminai-fedora-44 task #38: rollback accepted; operation 2618f313-834e-4245-a518-62a3e94a8364

- 2026-10-20T08:26:36.849Z webminai-fedora-44 task #38: Rollback partial: []

- 2026-10-20T08:26:36.850Z webminai-fedora-44 task #38: BLOCKED: Rollback incomplete; preserve state and investigate before any new attempt + actual - expected + 'partial' - 'reverted' 

- 2026-10-20T08:29:03.209Z webminai-fedora-44 task #38: propose accepted; operation 66224c61-8fd8-478d-a48f-f8063cdc629d

- 2026-10-20T08:29:05.236Z webminai-fedora-44 task #38: approve accepted; operation 409cf115-7a4f-4ac1-b208-1d81355b1cb4

- 2026-10-20T08:29:05.264Z webminai-fedora-44 task #38: rollback accepted; operation 0bce8be9-574b-4550-945b-ecd6306b67e4

- 2026-10-20T08:29:08.279Z webminai-fedora-44 task #38: Rollback reverted: [{"id":"restore-docker-baseline","status":"completed","exitCode":0},{"id":"verify-docker-baseline","status":"completed","exitCode":0},{"id":"remove-docker-task-state","status":"completed","exitCode":0}]

- 2026-10-20T08:29:08.412Z webminai-ubuntu-2404 task #72: propose accepted; operation c7e72a4e-bf15-4872-9816-b9f4bce863c2

- 2026-10-20T08:29:10.436Z webminai-ubuntu-2404 task #72: approve accepted; operation bbcc001f-685b-47f0-9e37-487304eba55e

- 2026-10-20T08:29:10.462Z webminai-ubuntu-2404 task #72: rollback accepted; operation a75e97a6-39b8-48f7-94c3-0e5cf861230d

- 2026-10-20T08:29:12.474Z webminai-ubuntu-2404 task #72: Rollback reverted: [{"id":"restore-docker-baseline","status":"completed","exitCode":0},{"id":"verify-docker-baseline","status":"completed","exitCode":0},{"id":"remove-docker-task-state","status":"completed","exitCode":0}]

- 2026-10-20T08:29:12.870Z webminai-almalinux-9 task #51: propose accepted; operation 97ba0f1e-9491-4171-bf14-74379671ad9c

- 2026-10-20T08:29:14.911Z webminai-almalinux-9 task #51: approve accepted; operation 8d7a9f20-993c-42f7-a72a-7e7c9588ca86

- 2026-10-20T08:29:14.939Z webminai-almalinux-9 task #51: rollback accepted; operation aacd982f-060d-40f9-9885-13ad16a36317

- 2026-10-20T08:29:16.953Z webminai-almalinux-9 task #51: Rollback reverted: [{"id":"restore-docker-baseline","status":"completed","exitCode":0},{"id":"verify-docker-baseline","status":"completed","exitCode":0},{"id":"remove-docker-task-state","status":"completed","exitCode":0}]

- 2026-10-20T08:29:17.410Z webminai-rocky-9 task #47: propose accepted; operation 9c448c3e-cfa8-41e7-8b14-8ed5b45318c0

- 2026-10-20T08:29:19.448Z webminai-rocky-9 task #47: approve accepted; operation a28ba731-3588-4df9-9149-4d7426006bfd

- 2026-10-20T08:29:19.488Z webminai-rocky-9 task #47: rollback accepted; operation 11b426f1-4b88-430a-9357-9082537241dc

- 2026-10-20T08:29:21.508Z webminai-rocky-9 task #47: Rollback reverted: [{"id":"restore-docker-baseline","status":"completed","exitCode":0},{"id":"verify-docker-baseline","status":"completed","exitCode":0},{"id":"remove-docker-task-state","status":"completed","exitCode":0}]

- 2026-10-20T08:29:21.946Z webminai-oracle-9 task #42: propose accepted; operation 0cd92159-9fa3-49f9-883d-227184af0c40

- 2026-10-20T08:29:23.975Z webminai-oracle-9 task #42: approve accepted; operation 3e4a2eed-4e9f-4970-a4cb-65b63a2a2282

- 2026-10-20T08:29:23.999Z webminai-oracle-9 task #42: rollback accepted; operation 14104779-16b9-40b0-86f2-e180f092c1d2

- 2026-10-20T08:29:26.014Z webminai-oracle-9 task #42: Rollback reverted: [{"id":"restore-docker-baseline","status":"completed","exitCode":0},{"id":"verify-docker-baseline","status":"completed","exitCode":0},{"id":"remove-docker-task-state","status":"completed","exitCode":0}]

- 2026-10-20T08:29:46.176Z webminai-ubuntu-2404: Default LXC prerequisite blocked; explicit process-local package bypass selected

- 2026-10-20T08:29:46.182Z webminai-ubuntu-2404: prepare accepted; operation 8e6e3234-e00f-4947-b181-39e14532c0c7

- 2026-10-20T08:29:48.198Z webminai-ubuntu-2404 task #73: Reviewed lab plan [redacted-64-hex]; four commands and three guarded rollback steps

- 2026-10-20T08:29:48.202Z webminai-ubuntu-2404 task #73: execute accepted; operation 19961df9-1d14-42f5-a824-1b255aeec5ef

- 2026-10-20T08:32:25.541Z webminai-ubuntu-2404 task #73: Observed execution completed: [{"id":"validate-container-host","status":"completed","exitCode":0},{"id":"capture-docker-baseline","status":"completed","exitCode":0},{"id":"install-docker-engine","status":"completed","exitCode":0},{"id":"verify-docker-engine","status":"completed","exitCode":0}]

- 2026-10-20T08:32:25.560Z webminai-ubuntu-2404 task #73: rollback accepted; operation 54e5b863-40cb-4644-812f-adc2e1729abf

- 2026-10-20T08:32:30.577Z webminai-ubuntu-2404 task #73: Rollback reverted: [{"id":"restore-docker-baseline","status":"completed","exitCode":0},{"id":"verify-docker-baseline","status":"completed","exitCode":0},{"id":"remove-docker-task-state","status":"completed","exitCode":0}]

- 2026-10-20T08:33:15.206Z webminai-fedora-44: Default LXC prerequisite blocked; explicit process-local package bypass selected

- 2026-10-20T08:33:15.211Z webminai-fedora-44: prepare accepted; operation ffaeed5e-ede0-44fc-b6e1-62611c364075

- 2026-10-20T08:33:16.227Z webminai-fedora-44 task #39: Reviewed lab plan [redacted-64-hex]; four commands and three guarded rollback steps

- 2026-10-20T08:33:16.231Z webminai-fedora-44 task #39: execute accepted; operation 134956b2-2699-4f1f-9c5a-6a7db5f2d0f3

- 2026-10-20T08:36:28.653Z webminai-fedora-44 task #39: Observed execution completed: [{"id":"validate-container-host","status":"completed","exitCode":0},{"id":"capture-docker-baseline","status":"completed","exitCode":0},{"id":"install-docker-engine","status":"completed","exitCode":0},{"id":"verify-docker-engine","status":"failed","exitCode":78,"failure":"COMMAND_FAILED"}]; [redacted sensitive output]

- 2026-10-20T08:36:28.667Z webminai-fedora-44 task #39: propose accepted; operation 4f72076d-8c1b-4332-8b2e-40265ac6ebad

- 2026-10-20T08:36:29.684Z webminai-fedora-44 task #39: approve accepted; operation 4191eb80-b58c-49ea-be11-7d27c870d3e2

- 2026-10-20T08:36:29.708Z webminai-fedora-44 task #39: rollback accepted; operation e8b1c90e-db16-4c18-bbae-3d34dd4c0ade

- 2026-10-20T08:36:31.717Z webminai-fedora-44 task #39: Rollback revert_failed: [{"id":"restore-docker-baseline","status":"failed","exitCode":123}]; Failed to resolve the transaction: Problem: The operation would result in removing the following protected packages: selinux-policy-targeted 

- 2026-10-20T08:36:31.718Z webminai-fedora-44 task #39: BLOCKED: Rollback incomplete; preserve state and investigate before any new attempt + actual - expected + 'revert_failed' - 'reverted'          ^ 

- 2026-10-20T08:36:33.031Z webminai-alpine-323: Default LXC prerequisite blocked; explicit process-local package bypass selected

- 2026-10-20T08:36:33.035Z webminai-alpine-323: prepare accepted; operation 14af0f2d-618c-4f97-ba24-f7cf31a1c9e2

- 2026-10-20T08:36:34.051Z webminai-alpine-323 task #43: Reviewed lab plan [redacted-64-hex]; four commands and three guarded rollback steps

- 2026-10-20T08:36:34.056Z webminai-alpine-323 task #43: execute accepted; operation 9e5eaa3f-718d-4b70-8813-ab5bc3877115

- 2026-10-20T08:39:28.429Z webminai-alpine-323 task #43: Observed execution completed: [{"id":"validate-container-host","status":"completed","exitCode":0},{"id":"capture-docker-baseline","status":"completed","exitCode":0},{"id":"install-docker-engine","status":"completed","exitCode":0},{"id":"verify-docker-engine","status":"failed","exitCode":78,"failure":"COMMAND_FAILED"}]; [redacted sensitive output]

- 2026-10-20T08:39:28.443Z webminai-alpine-323 task #43: propose accepted; operation df752f8d-d357-4b2d-a50b-d8361dfa1b01

- 2026-10-20T08:39:29.469Z webminai-alpine-323 task #43: approve accepted; operation 4da92542-22b4-4b7a-86f3-7e9a8910baf6

- 2026-10-20T08:39:29.505Z webminai-alpine-323 task #43: rollback accepted; operation 9474fc22-74e9-4094-bb9c-09e14a6eff15

- 2026-10-20T08:39:33.531Z webminai-alpine-323 task #43: Rollback reverted: [{"id":"restore-docker-baseline","status":"completed","exitCode":0},{"id":"verify-docker-baseline","status":"completed","exitCode":0},{"id":"remove-docker-task-state","status":"completed","exitCode":0}]

- 2026-10-20T08:39:35.183Z webminai-arch: Default LXC prerequisite blocked; explicit process-local package bypass selected

- 2026-10-20T08:39:35.188Z webminai-arch: prepare accepted; operation 0ad1c05b-330b-4f75-adcd-78541ce8049c

- 2026-10-20T08:39:37.212Z webminai-arch task #47: Reviewed lab plan [redacted-64-hex]; four commands and three guarded rollback steps

- 2026-10-20T08:39:37.216Z webminai-arch task #47: execute accepted; operation e1f7d735-46a7-4614-923f-a4278cef9697

- 2026-10-20T08:41:34.453Z webminai-arch task #47: Observed execution completed: [{"id":"validate-container-host","status":"completed","exitCode":0},{"id":"capture-docker-baseline","status":"completed","exitCode":0},{"id":"install-docker-engine","status":"completed","exitCode":0},{"id":"verify-docker-engine","status":"failed","exitCode":78,"failure":"COMMAND_FAILED"}]; [redacted sensitive output]

- 2026-10-20T08:41:34.464Z webminai-arch task #47: propose accepted; operation de2947a4-f307-4ed8-9d64-3a563b7520c1

- 2026-10-20T08:41:36.484Z webminai-arch task #47: approve accepted; operation 79baa73a-2ede-4284-98d3-ec8fc3bf061d

- 2026-10-20T08:41:36.513Z webminai-arch task #47: rollback accepted; operation 2b2697d6-01c9-4d60-bf18-e29515fb2257

- 2026-10-20T08:41:39.522Z webminai-arch task #47: Rollback reverted: [{"id":"restore-docker-baseline","status":"completed","exitCode":0},{"id":"verify-docker-baseline","status":"completed","exitCode":0},{"id":"remove-docker-task-state","status":"completed","exitCode":0}]

- 2026-10-20T08:41:43.540Z webminai-opensuse-160: Default LXC prerequisite blocked; explicit process-local package bypass selected

- 2026-10-20T08:41:43.543Z webminai-opensuse-160: prepare accepted; operation ac27e12a-ebd8-40a1-be0b-739af3404b56

- 2026-10-20T08:41:44.568Z webminai-opensuse-160 task #58: Reviewed lab plan [redacted-64-hex]; four commands and three guarded rollback steps

- 2026-10-20T08:41:44.572Z webminai-opensuse-160 task #58: execute accepted; operation 771eaff9-4b9f-4a93-86e1-be3a88754206

- 2026-10-20T08:53:02.843Z webminai-opensuse-160 task #58: Observed execution completed: [{"id":"validate-container-host","status":"completed","exitCode":0},{"id":"capture-docker-baseline","status":"completed","exitCode":0},{"id":"install-docker-engine","status":"completed","exitCode":0},{"id":"verify-docker-engine","status":"failed","exitCode":78,"failure":"COMMAND_FAILED"}]; [redacted sensitive output]

- 2026-10-20T08:53:02.854Z webminai-opensuse-160 task #58: propose accepted; operation 96bc939d-d687-4061-831e-f3c5671588f7

- 2026-10-20T08:53:03.878Z webminai-opensuse-160 task #58: approve accepted; operation d91c61e6-e845-4efe-8783-c4e47e37ab09

- 2026-10-20T08:53:03.902Z webminai-opensuse-160 task #58: rollback accepted; operation b9e14b7b-3b12-4667-b87d-9f3345a58421

- 2026-10-20T08:53:07.915Z webminai-opensuse-160 task #58: Rollback reverted: [{"id":"restore-docker-baseline","status":"completed","exitCode":0},{"id":"verify-docker-baseline","status":"completed","exitCode":0},{"id":"remove-docker-task-state","status":"completed","exitCode":0}]

- 2026-10-20T08:53:09.002Z webminai-almalinux-9: Default LXC prerequisite blocked; explicit process-local package bypass selected

- 2026-10-20T08:53:09.005Z webminai-almalinux-9: prepare accepted; operation a89ea673-0537-475d-a447-a8cfb38762d9

- 2026-10-20T08:53:10.021Z webminai-almalinux-9 task #52: Reviewed lab plan [redacted-64-hex]; four commands and three guarded rollback steps

- 2026-10-20T08:53:10.030Z webminai-almalinux-9 task #52: execute accepted; operation 12dc2101-31c7-4137-9230-0ebd42328d34

- 2026-10-20T08:56:55.474Z webminai-almalinux-9 task #52: Observed execution completed: [{"id":"validate-container-host","status":"completed","exitCode":0},{"id":"capture-docker-baseline","status":"completed","exitCode":0},{"id":"install-docker-engine","status":"completed","exitCode":0},{"id":"verify-docker-engine","status":"failed","exitCode":78,"failure":"COMMAND_FAILED"}]; [redacted sensitive output]

- 2026-10-20T08:56:55.486Z webminai-almalinux-9 task #52: propose accepted; operation 2e49334d-c1c2-4382-b3af-82daaf311606

- 2026-10-20T08:56:56.507Z webminai-almalinux-9 task #52: approve accepted; operation 32495b7c-474b-4e31-aae9-5b4c34cbf127

- 2026-10-20T08:56:56.532Z webminai-almalinux-9 task #52: rollback accepted; operation cd959e44-b129-4b13-9c0c-60c34ac71c2a

- 2026-10-20T08:57:04.550Z webminai-almalinux-9 task #52: Rollback revert_failed: [{"id":"restore-docker-baseline","status":"completed","exitCode":0},{"id":"verify-docker-baseline","status":"failed","exitCode":1}]; Docker package baseline drift --- /var/lib/webminai/tasks/52/linux-docker/packages.before	2026-10-20 08:53:10.966364066 +0000 +++ /var/lib/webminai/tasks/52/linux-docker/packages.final	2026-10-20 08:57:03.560252322 +0000 @@ -75,6 +75,7 @@  gnutls=3.8.10-9.el9_8.x86_64  gpg-pubkey=3228467c-613798eb.(none)  gpg-pubkey=3af28a14-6585b2a3.(none) +gpg-pubkey=621e9f35-58adea78.(none)  gpg-pubkey=65f56346-62beb4e5.(none)  gpg-pubkey=b86b3716-61e69f29.(none)  gpg-pubkey=ecfa8f4f-67d6e009.(none) 

- 2026-10-20T08:57:04.551Z webminai-almalinux-9 task #52: BLOCKED: Rollback incomplete; preserve state and investigate before any new attempt + actual - expected + 'revert_failed' - 'reverted'          ^ 

- 2026-10-20T08:57:05.826Z webminai-rocky-9: Default LXC prerequisite blocked; explicit process-local package bypass selected

- 2026-10-20T08:57:05.830Z webminai-rocky-9: prepare accepted; operation 4e254ed1-c92f-49a1-9065-bafe18263692

- 2026-10-20T08:57:06.839Z webminai-rocky-9 task #48: Reviewed lab plan [redacted-64-hex]; four commands and three guarded rollback steps

- 2026-10-20T08:57:06.849Z webminai-rocky-9 task #48: execute accepted; operation 93ac61dc-d82e-4cee-a58d-efbc64af4106

- 2026-10-20T08:57:07.858Z webminai-rocky-9 task #48: Observed execution failed: []

- 2026-10-20T08:57:07.869Z webminai-rocky-9 task #48: propose accepted; operation df281098-fd58-47ca-b057-9602810daee2

- 2026-10-20T08:57:08.893Z webminai-rocky-9 task #48: approve accepted; operation 58d5c6c9-de42-41a3-a53b-9889e159c401

- 2026-10-20T08:57:08.914Z webminai-rocky-9 task #48: rollback accepted; operation edde7386-a0dd-4dc9-82d8-597765685558

- 2026-10-20T08:57:09.920Z webminai-rocky-9 task #48: Rollback running: []

- 2026-10-20T08:57:09.921Z webminai-rocky-9 task #48: BLOCKED: Rollback incomplete; preserve state and investigate before any new attempt + actual - expected + 'running' - 'reverted' 

- 2026-10-20T08:57:11.120Z webminai-oracle-9: Default LXC prerequisite blocked; explicit process-local package bypass selected

- 2026-10-20T08:57:11.124Z webminai-oracle-9: prepare accepted; operation 39964982-13a7-477e-9708-b7df693e39e8

- 2026-10-20T08:57:12.139Z webminai-oracle-9 task #43: Reviewed lab plan [redacted-64-hex]; four commands and three guarded rollback steps

- 2026-10-20T08:57:12.149Z webminai-oracle-9 task #43: execute accepted; operation 7bb15d78-1c7d-4e1e-ae3d-cd3c08a3a0c0

- 2026-10-20T09:01:13.624Z webminai-oracle-9 task #43: Observed execution completed: [{"id":"validate-container-host","status":"completed","exitCode":0},{"id":"capture-docker-baseline","status":"completed","exitCode":0},{"id":"install-docker-engine","status":"completed","exitCode":0},{"id":"verify-docker-engine","status":"failed","exitCode":78,"failure":"COMMAND_FAILED"}]; [redacted sensitive output]

- 2026-10-20T09:01:13.644Z webminai-oracle-9 task #43: propose accepted; operation ef49c474-00b6-4c07-83ec-89059520f329

- 2026-10-20T09:01:14.671Z webminai-oracle-9 task #43: approve accepted; operation 813e5cc4-c025-465c-8be0-9c38f0f4a56c

- 2026-10-20T09:01:14.692Z webminai-oracle-9 task #43: rollback accepted; operation 5f3b710f-677c-4b81-aecb-17993f75d145

- 2026-10-20T09:01:22.711Z webminai-oracle-9 task #43: Rollback revert_failed: [{"id":"restore-docker-baseline","status":"completed","exitCode":0},{"id":"verify-docker-baseline","status":"failed","exitCode":1}]; Docker package baseline drift --- /var/lib/webminai/tasks/43/linux-docker/packages.before	2026-10-20 08:57:13.277005961 +0000 +++ /var/lib/webminai/tasks/43/linux-docker/packages.final	2026-10-20 09:01:22.022270621 +0000 @@ -64,6 +64,7 @@  gnupg2=2.3.3-5.el9_7.x86_64  gnutls=3.8.10-9.el9_8.x86_64  gpg-pubkey=3af28a14-6585b2a3.(none) +gpg-pubkey=621e9f35-58adea78.(none)  gpg-pubkey=65f56346-62beb4e5.(none)  gpg-pubkey=8b4efbe6-629ec292.(none)  gpg-pubkey=8d8b756f-629e59ec.(none) 

- 2026-10-20T09:01:22.712Z webminai-oracle-9 task #43: BLOCKED: Rollback incomplete; preserve state and investigate before any new attempt + actual - expected + 'revert_failed' - 'reverted'          ^ 

- 2026-10-20T09:02:02.164Z webminai-fedora-44 task #39: propose accepted; operation 1d948ed6-4b38-44db-8263-0a110f5b8dc4

- 2026-10-20T09:02:07.199Z webminai-fedora-44 task #39: approve accepted; operation ce3dd4c8-7db9-4a88-809e-b49c83a287bc

- 2026-10-20T09:02:07.232Z webminai-fedora-44 task #39: rollback accepted; operation 7aa6ce04-4b53-4004-a825-01e330003490

- 2026-10-20T09:02:19.268Z webminai-fedora-44 task #39: Rollback revert_failed: [{"id":"restore-docker-baseline","status":"completed","exitCode":0},{"id":"verify-docker-baseline","status":"failed","exitCode":1}]; Docker package baseline drift --- /var/lib/webminai/tasks/39/linux-docker/packages.before	2026-10-20 08:33:17.242939712 +0000 +++ /var/lib/webminai/tasks/39/linux-docker/packages.final	2026-10-20 09:02:18.443023656 +0000 @@ -84,6 +84,7 @@  google-noto-fonts-common=20251201-2.fc44.noarch  google-noto-sans-vf-fonts=20251201-2.fc44.noarch  gperftools-libs=2.18.1-1.fc44.x86_64 +gpg-pubkey=060a61c51b558a7f742b77aac52feb6b621e9f35-58ade481.(none)  gpg-pubkey=242b813831af09562b6c46f76b88da4e3af28a14-6585b2a3.(none)  gpg-pubkey=36f612dcf27f7d1a48a835e4dbfcf71c6d9f90a6-6786af3b.(none)  gpg-pubkey=6588fdd7b14721fe7c3115e6f9177b5265f56346-62bea285.(none) 

- 2026-10-20T09:02:19.269Z webminai-fedora-44 task #39: BLOCKED: Rollback incomplete; preserve state and investigate before any new attempt + actual - expected + 'revert_failed' - 'reverted'          ^ 

- 2026-10-20T09:02:41.542Z webminai-fedora-44 task #39: propose accepted; operation 0987bb6b-8804-45d0-8331-4f4e99ceae89

- 2026-10-20T09:02:43.578Z webminai-fedora-44 task #39: approve accepted; operation f71c6973-f63c-40af-9e0a-a1aaba96cfdf

- 2026-10-20T09:02:43.603Z webminai-fedora-44 task #39: rollback accepted; operation b08030ba-e2c2-4f57-959b-d56999f7f4db

- 2026-10-20T09:02:46.619Z webminai-fedora-44 task #39: Rollback reverted: [{"id":"restore-docker-baseline","status":"completed","exitCode":0},{"id":"verify-docker-baseline","status":"completed","exitCode":0},{"id":"remove-docker-task-state","status":"completed","exitCode":0}]

- 2026-10-20T09:03:05.442Z webminai-almalinux-9 task #52: propose accepted; operation 51c9d3e4-1082-4adb-8ae2-c532c9d6d3ab

- 2026-10-20T09:03:07.466Z webminai-almalinux-9 task #52: approve accepted; operation 1a814333-a9d5-4a18-9e6c-a1ad5af3baf5

- 2026-10-20T09:03:07.491Z webminai-almalinux-9 task #52: rollback accepted; operation fa0cfa5e-041e-482c-a4fd-26874d274dcc

- 2026-10-20T09:03:10.506Z webminai-almalinux-9 task #52: Rollback reverted: [{"id":"restore-docker-baseline","status":"completed","exitCode":0},{"id":"verify-docker-baseline","status":"completed","exitCode":0},{"id":"remove-docker-task-state","status":"completed","exitCode":0}]

- 2026-10-20T09:03:10.910Z webminai-oracle-9 task #43: propose accepted; operation 042a27fc-e186-4112-86e3-a0b35a7a01be

- 2026-10-20T09:03:12.935Z webminai-oracle-9 task #43: approve accepted; operation 349eb9e1-f2f9-4bf8-9f1d-9de590446590

- 2026-10-20T09:03:12.959Z webminai-oracle-9 task #43: rollback accepted; operation 4e6c0547-4d3f-435a-960d-213c8a37f010

- 2026-10-20T09:03:15.972Z webminai-oracle-9 task #43: Rollback reverted: [{"id":"restore-docker-baseline","status":"completed","exitCode":0},{"id":"verify-docker-baseline","status":"completed","exitCode":0},{"id":"remove-docker-task-state","status":"completed","exitCode":0}]

- 2026-10-20T09:03:17.573Z webminai-rocky-9: Default LXC prerequisite blocked; explicit process-local package bypass selected

- 2026-10-20T09:03:17.582Z webminai-rocky-9: prepare accepted; operation f7284d2b-ca99-42fe-a800-797e939746cb

- 2026-10-20T09:03:18.607Z webminai-rocky-9 task #49: Reviewed lab plan [redacted-64-hex]; four commands and three guarded rollback steps

- 2026-10-20T09:03:18.613Z webminai-rocky-9 task #49: execute accepted; operation 43b81598-8481-4f07-968e-53a86fc50d4e

- 2026-10-20T09:03:19.632Z webminai-rocky-9 task #49: Observed execution failed: []

- 2026-10-20T09:03:19.634Z webminai-rocky-9 task #49: BLOCKED: Other interrupted host work requires inspection and reconciliation before mutation + actual - expected + 'failed' - 'completed' 

- 2026-10-20T09:03:21.038Z webminai-alpine-323: Default LXC prerequisite blocked; explicit process-local package bypass selected

- 2026-10-20T09:03:21.041Z webminai-alpine-323: prepare accepted; operation ec93606b-d31e-4553-bc3c-f2b267e72cf2

- 2026-10-20T09:03:22.053Z webminai-alpine-323 task #44: Reviewed lab plan [redacted-64-hex]; four commands and three guarded rollback steps

- 2026-10-20T09:03:22.057Z webminai-alpine-323 task #44: execute accepted; operation 774ece1f-4cbf-4819-a089-d5d9a407e365

- 2026-10-20T09:03:23.067Z webminai-alpine-323 task #44: Observed execution failed: []

- 2026-10-20T09:03:23.067Z webminai-alpine-323 task #44: BLOCKED: Remote recovery claim failed: legacy task state is occupied; preserve it and review a new task identity; no automatic retry is authorized + actual - expected + 'failed' - 'completed' 

- 2026-10-20T09:06:34.179Z webminai-rocky-9: Default LXC prerequisite blocked; explicit process-local package bypass selected

- 2026-10-20T09:06:34.187Z webminai-rocky-9: prepare accepted; operation 3b994e33-1162-4ddc-9183-941927fe0690

- 2026-10-20T09:06:35.211Z webminai-rocky-9 task #50: Reviewed lab plan [redacted-64-hex]; four commands and three guarded rollback steps

- 2026-10-20T09:06:35.222Z webminai-rocky-9 task #50: execute accepted; operation a26ba72e-e689-4c05-b2a2-4e5a1441109c

- 2026-10-20T09:09:56.673Z webminai-rocky-9 task #50: Observed execution completed: [{"id":"validate-container-host","status":"completed","exitCode":0},{"id":"capture-docker-baseline","status":"completed","exitCode":0},{"id":"install-docker-engine","status":"completed","exitCode":0},{"id":"verify-docker-engine","status":"failed","exitCode":78,"failure":"DOCKER_SERVICE_NOT_READY"}]; [redacted sensitive output]

- 2026-10-20T09:09:56.685Z webminai-rocky-9 task #50: propose accepted; operation effeb7d8-b9a8-492a-9d9d-fa718423ecb0

- 2026-10-20T09:09:57.710Z webminai-rocky-9 task #50: approve accepted; operation eeed08e7-fee8-471e-adbd-87b65bc20121

- 2026-10-20T09:09:57.749Z webminai-rocky-9 task #50: rollback accepted; operation bd647bd0-d07b-4fcc-b5ad-649dcf4ebd2a

- 2026-10-20T09:10:05.780Z webminai-rocky-9 task #50: Rollback reverted: [{"id":"restore-docker-baseline","status":"completed","exitCode":0},{"id":"verify-docker-baseline","status":"completed","exitCode":0},{"id":"remove-docker-task-state","status":"completed","exitCode":0}]

- 2026-10-20T09:10:07.124Z webminai-alpine-323: Default LXC prerequisite blocked; explicit process-local package bypass selected

- 2026-10-20T09:10:07.129Z webminai-alpine-323: prepare accepted; operation 4e2079d1-94b1-4c5b-8156-8a298ff09f66

- 2026-10-20T09:10:09.150Z webminai-alpine-323 task #45: Reviewed lab plan [redacted-64-hex]; four commands and three guarded rollback steps

- 2026-10-20T09:10:09.154Z webminai-alpine-323 task #45: execute accepted; operation 428d9715-7478-4b56-8b1b-8aad7e269be8

- 2026-10-20T09:13:08.531Z webminai-alpine-323 task #45: Observed execution completed: [{"id":"validate-container-host","status":"completed","exitCode":0},{"id":"capture-docker-baseline","status":"completed","exitCode":0},{"id":"install-docker-engine","status":"completed","exitCode":0},{"id":"verify-docker-engine","status":"failed","exitCode":78,"failure":"DOCKER_SERVICE_NOT_READY"}]; [redacted sensitive output]

- 2026-10-20T09:13:08.551Z webminai-alpine-323 task #45: propose accepted; operation f2fb9080-13c1-4e11-aa81-4345fb08d471

- 2026-10-20T09:13:09.580Z webminai-alpine-323 task #45: approve accepted; operation f83fefd7-ae4e-4374-910a-7e37c4306927

- 2026-10-20T09:13:09.617Z webminai-alpine-323 task #45: rollback accepted; operation 0823078d-a2d6-4337-a091-f87a066aaa9b

- 2026-10-20T09:13:13.635Z webminai-alpine-323 task #45: Rollback reverted: [{"id":"restore-docker-baseline","status":"completed","exitCode":0},{"id":"verify-docker-baseline","status":"completed","exitCode":0},{"id":"remove-docker-task-state","status":"completed","exitCode":0}]
