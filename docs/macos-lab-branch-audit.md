# macOS branch-feature audit

Reference: `main` versus current `yet-to-test`. Live target is the fingerprint-bound
`macos-lab` entry. See [checkpoint](macos-lab-validation-status.md) for task IDs,
partial work and restoration requirements. Passing application health is not
equivalent to passing every feature below.

| Feature | Observed evidence | Remaining |
| --- | --- | --- |
| Native plugin | Built on macOS 15.7.9 x86_64 with Apple clang; installed hash equals artifact; signed health and inventory passed | arm64 not built/tested |
| SSH reuse | Three overlapping leases shared one master; releasing one preserved five sequential/five concurrent commands; forced closure reconnected with one remote job start; live idle expiry created exactly one replacement master without cleanup errors | Cross-platform client implementations remain separate scopes |
| Durable jobs | Signed result retrieved after new SSH connection; Joomla observer terminated, original acquisition reconciled with exactly one dispatch before reviewed continuation | Netdata restart |
| Journaling/review | Durable preparation/reload/idempotency passed; Joomla original job reconciled after observer termination; actual Codex revision approval preserved a completed job/attempt after fixing its projection | Broader stale-host/revision combinations use deterministic tests |
| Intervention | Wrong/stale decisions rejected; Ghost paused during acquisition without replay; read-only health task abort blocked resume, reviewed revision reset to pause, then aborted without executing proposed commands | Immediate termination is intentionally not implied by abort/pause |
| Completed work | Continuation retained completed attempts; consumed approval rejected; Drupal, PrestaShop, Ghost, Mattermost, Odoo, Moodle and Magento restored original trusted-probe digests. Colima cleanup restored the complete package/version list and protected profile/CLI hashes | Broader repeated-apply assertions; probes cover catalog scope, not every host byte; original pre-task-2 VM sizing was not captured |
| Diagnostics | Native exit/timeout/cancellation/boot/filesystem passed; cgroups correctly unsupported; Ghost/Mattermost live scoped container inspection passed, including absent health checks | Attributable native OOM/crash and workload-specific failure cases |
| Signed replay protection | Reusing an identical command envelope was rejected | Key rotation acceptance |
| Browser shell/workspace | Chromium shell roundtrip/resize/reload/close and five workspace checks passed, including live CPU/RAM/disk, history and server-side read-only enforcement | Broader changing workspace actions |
| Remote recovery | Automatic signed records and fresh public-key trust/discovery verified on macOS; 58 Drupal records verified without copying a private key or vault | Destructive regeneration remains blocked: audited macOS baseline profiles are not implemented |
| Installation | Updated archive installed in isolated macOS prefix; CLI/SQLite smoke passed; task 13 preserved pre-existing system CLI and passed reviewed rollback/baseline comparison | Pristine-OS managed-root lifecycle |
| Application catalog | All 13 macOS applications passed apply, real health verification and reviewed rollback; Magento survived interrupted observation, then required fresh approval for remaining work | First six cycles lack original state-probe digests; no universal repeated-apply assertion |
| Multi-host scheduling | Existing deterministic regression coverage only | No multi-macOS-host lab available |
| AI planning, loop protection, exports, settings, model selection | Actual Codex revision proposal and persisted read-only consultation passed; latest full 1013-test regression run had 1008 passes/five opt-in skips | All model/reasoning combinations and additional live fault cases |

No reboot, deliberate OOM/disk exhaustion, unrelated image pruning or existing
CLI replacement was authorized or performed. Linux-only service/cgroup changes,
FreeBSD Podman and the Kubernetes gateway are separate validation scopes.
