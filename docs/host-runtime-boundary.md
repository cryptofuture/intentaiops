# Host runtime ownership

Intent AI Ops keeps terminal navigation in `cli.js`, but one host connection has one runtime owner.

| Concern | Owner |
| --- | --- |
| Decrypt configured host connection | `HostSessionFactory` |
| OpenSSH authentication and saved-credential fallback | `HostSessionFactory` through `SystemSsh` |
| SSH session lifetime | Caller receives one factory handle and closes its `session` in `finally` |
| Host-key fingerprint and history alias | `HostSessionFactory` with `SettingsStore` and `ServerWorkspace` |
| Host-scoped `Stage2Service` and `AdminService` composition | `HostSessionFactory` |
| Stage 2 active precondition for fleet tasks | `HostSessionFactory.open({ requireActive: true })` |
| Capability, task, persistence, and revert operations | Public `AdminService` methods |
| Multi-host scheduling and run persistence | `MultiHostService` |
| Prompts, approvals, rendering, and navigation result | `cli.js` and `TerminalUi` |

Dependencies point inward from the CLI to the factory and public services. `MultiHostService`
accepts a narrow admin provider and does not access `AdminService.stage2` or other nested service
properties. Neither services nor the host factory import terminal UI code.

The factory closes a newly opened session if fingerprint registration, workspace aliasing, Stage 2
preflight, or host-scoped composition fails. Once a handle is returned, the enclosing single-host
or fleet workflow is the sole lifetime owner and closes it exactly once in `finally`.
