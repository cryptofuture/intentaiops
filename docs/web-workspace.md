# Local browser workspace

```sh
intentaiops --web
intentaiops --web --console-actions
intentaiops --web --console-actions --web-port 4317
# Compatible aliases:
intentaiops console
intentaiops console --console-actions
```

The server binds only to 127.0.0.1. Default port 0 selects an available port;
occupied fixed ports fail explicitly. `--data-root` selects a separate profile.
Only one full workspace owns each profile at a time. Several browser tabs share
that runtime; other profiles may run separately. Cookies have instance-specific
names and randomized path scopes. Different ports are not treated as security
isolation. Do not send the authenticated launch URL to other people.

Keep the foreground terminal open. Unlock the vault there; OpenSSH host-key,
authentication and elevation prompts remain there, serialized across browser
requests. Connection events tell the browser to check that terminal. No private
keys, passwords or vault settings are sent to the page.

## Tasks and review

Overview shows configured hosts and recorded work. Connect to inspect actual
readiness; absent information is marked uninspected, not assumed healthy.
New task requires explicit targets and offers natural-language planning,
read-only consultation or eligible catalog tasks. Preparation returns an
operation ID and saves plans in the same history used by the CLI. It never
executes them or waits for human review inside an HTTP request.

Open a saved task to review commands, risks, paths, provenance, dependencies and
rollback coverage. Approvals use the server's canonical fingerprint and saved
state version. Per-command review is available. Revisions need their own
approval, then a separate resume. Stale and consumed decisions are rejected.
Review versions are now bound to host identity as well as the saved plan.
Previously prepared approval tickets may need a fresh review after upgrading;
existing task history is retained.
Retries prepare new reviewed work and retain earlier evidence; uncertain work
must first be reconciled. Double submissions reuse a request key.

Pause means **before the next command**. Abort means **abort remaining work**.
Neither kills an in-flight command. Transport loss does not establish failure
or authorize repetition. Reconcile outcome before reviewing continuation.
Rollback and signed remote recovery require separate inspection and approval;
remote records cannot supply executable cleanup. Existing recovery-profile
limitations still apply. Takeover is explicitly reviewed and remains subject
to remote ownership and uncertainty checks.

Multi-host plans persist per host while awaiting review. Select reviewed hosts
explicitly. Continuation uses the shared controller, with configurable bounded
parallelism. The browser's staged option runs a canary then batches of two,
halting on failure, incomplete work or missing successful approved verification
steps. Completed hosts are skipped. Retry preparation preserves the run/task
family and cannot select completed hosts.

Task tabs can be split horizontally or vertically and resized using their lower
right handles. Closing a view does not cancel, approve or repeat anything.
Layout, favorites and appearance are nonsecret profile preferences. Settings
writes use versions; a stale window cannot overwrite another confirmed choice.

## Appearance and monitoring

All 27 palettes are bundled. System mode follows the
OS while remembering separate light and dark palettes. Defaults are Dawn/Dusk.
Search the picker and use arrows to preview, Enter to confirm, or Escape/Cancel
to discard. Previews do not call a mutation endpoint. Confirmed appearance is
available even in read-only mode through a CSRF-protected presentation-only API.
Preferences survive port changes and restarts. The theme applies before the
workspace becomes visible and does not reset task panes or scrollback.

Host overview requests actual Netdata CPU, memory and per-filesystem series.
Collectors and units are discovered, not fabricated. Samples show source,
timestamp, aggregation and unavailable/stale states. FreeBSD RAM uses Netdata's
[in-use calculation](https://github.com/netdata/netdata/blob/v2.12.0/src/health/health.d/ram.conf):
active, wired, laundry and buffers divided by all seven reported RAM categories.
The gauge explains its calculation and stays unavailable if required categories
are missing or ambiguous. Filesystems are not
combined into a misleading single disk gauge. Queries are scoped to the target
Netdata node, not its streamed children. Filesystem capacity may describe a
host-mounted filesystem rather than a container storage quota. Requests share a bounded host
cache; no sampling timer runs on the server without browser demand. Hidden
windows stop sampling. Inventory is refreshed explicitly, not per render.
Cluster inspection uses its separate authenticated Kubernetes API/gateway,
not SSH, host gauges or expanded permissions. Cluster lifecycle/task controls
remain in the CLI; the workspace does not pretend SSH-control parity.

Activity uses one reconnecting SSE subscription per window, with ordered IDs,
catch-up and bounded buffers. Historical replay/export reads recorded evidence
and has no remote effects. Raw stdout/stderr remain withheld from public
diagnostics; command status, native results and sanitized diagnostic evidence
remain inspectable. Task APIs do not accept arbitrary commands or Netdata paths.
The explicitly approved manual SSH channel below is separate from task execution.

Disconnect is rejected while that session has active work. Pause remaining
work and wait for the current command first. Host edits verify SSH identity
before committing: history follows identity, not a display name, and a new
authorization key starts inactive. Removing local configuration never uninstalls
remote software and retains history.

On Ctrl+C/SIGTERM the runtime rejects new work, requests safe-boundary pauses
and waits for accepted operations to settle before releasing sessions. An
in-flight signed job is bounded by its approved deadline (up to one hour), not
silently killed. Read-only session users drain for up to 35 seconds. Planning retains its existing Codex deadline. A forced process
termination can leave remote work running; the next launch marks unobserved
operations interrupted and requires normal reconciliation. It never replays
them. A second interrupt is not a safe cancellation mechanism.

## Development and distribution

```sh
npm install
npm run build:web
npm run test:web # npx playwright install chromium first
# Or use an existing local Chromium/Chrome:
INTENT_BROWSER_EXECUTABLE=/absolute/path/to/chrome npm run test:web
npm test
npm run lint
npm run typecheck
npm run test:package-install
```

Preact/Vite sources are under `web/`; production assets, fonts and licenses are
built to `src/operator-web/`. Packaging builds them explicitly before npm pack.
An installed CLI needs no Vite, development server, CDN or runtime build.
Gallery screenshots and disposable browser artifacts are written under the
gitignored `artifacts/browser-screenshots/` directory inside the project.
No screenshot report server is started. Live platform validation is separate
from mocked/browser tests.
## Design review

Workspace design checks use the [Build with Claude review checklist](https://github.com/davepoon/buildwithclaude/blob/868d035a103b400a88a106b3f609fe573752b4b0/plugins/frontend-design-pro/commands/review.md)
as a manual reference; no external skills or plugins are installed. Browser
checks cover icon/text gaps, keyboard skip navigation, responsive layouts and
all 27 theme galleries. This is not a complete accessibility certification.

## Interactive SSH terminal

Launch with `--console-actions`, open a host, select **terminal**, then approve
**Open SSH shell**. This is a real PTY-backed system OpenSSH session, not a task
output viewer. It runs as the saved SSH user, outside managed plan validation,
automatic provenance and rollback. No AI can type into it. Use reviewed tasks
when those execution guarantees are needed.

The browser uses ghostty-web with a bundled local WebAssembly engine. No CDN
or runtime build is required. Theme changes preserve terminal contents.
Ghostty 0.4 exposes resolved cell colors, so theme changes remap the original
palette and default colors at rendering time. Explicit RGB colors identical
to an original palette color follow that same mapping.

Authentication and host-key prompts stay in the launch terminal. Connections
reuse the existing SSH master where supported. Without multiplexing, only
noninteractive key/agent authentication can work; password-only direct sessions
fail instead of forwarding login passwords through the browser. Native PTY
support comes from optional `node-pty`; a missing native build disables the
shell, not the rest of the CLI. Windows clients require working ConPTY support.

There is at most one interactive shell per host and eight per workspace.
Each holds the same cross-process host ownership used by managed changes.
Other mutating work, edits and disconnects must wait until it exits. Read-only
monitoring may continue. Two views cannot silently submit conflicting input;
an acknowledgment loss blocks further typing until reattachment. Input is never
automatically replayed.

Closing the view, changing themes or refreshing does not execute commands or
end SSH. Use **Attach** or **Reattach view** to reconnect. Output is memory-only,
bounded to 512 KiB per session; a gap is reported when older output expired.
Terminal bytes are never written to the task journal, AI context or exports.
Remote shell history and host auditing still apply.
They may contain secrets, so do not share the authenticated workspace or capture
its terminal without review. Remote clipboard and hyperlink escape handlers
are disabled; only deliberate operator input is sent to the PTY.
Local SSH escape commands, local commands, agent/X11 forwarding and new port
forwardings are disabled for browser shell channels.

**End SSH session** and application shutdown close the local SSH channel and
may terminate a remote foreground process. Background work may continue.
This is not rollback or proof of command completion. A lost connection never
automatically opens another shell or resends input. Clusters remain on their
separate gateway and do not receive an SSH terminal.

## Implementation and verification

The shared CLI/browser preparation and completion-report services retain the
existing validator, executor, history, signed transport and recovery paths.
Additive storage consists of versioned UI preferences, asynchronous operation
records, per-host run decisions, and private SQLite ownership files. No history
is removed. Host ownership is released by SQLite after a process exits; this
never establishes the outcome of remote work.

Verification on Linux includes Node regression tests and Chromium browser tests
(17 fixture workflows, five read-only Debian checks and one opt-in SSH shell),
lint, JSDoc contract checks, frontend build, installed
package smoke and distribution checksum verification. All 27 gallery renders
were captured and inspected, plus representative narrow layouts. Tests cover
canonical/stale approval, duplicate submissions, persistent review, canary halt,
cross-process ownership, prompt serialization, redaction and session isolation.

An opt-in run of the actual `--web` binary read inventory and normalized metrics
from the Debian lab host. It performed no changing host operations. New browser
mutations were tested with disposable mocked services, not live hosts. An
additional approved browser shell ran only `printf`, `uname`, `stty size` and
`uptime` on the Debian lab host, including resize, reload/reattach and close.
Windows,
FreeBSD, macOS, Docker and Kubernetes were not live-validated for this workspace.

## Browser test set and screenshots

`browser-checks/workspace.spec.js` uses disposable local history and mocked remote
services, while exercising the real frontend, HTTP authentication, controller,
review and execution services. It covers:

1. All 27 theme galleries and browser errors.
2. Theme preview, cancellation, confirmation, reload and session restoration.
3. Durable preparation, explicit approval and shared task history.
4. Light/dark responsive galleries.
5. Narrow workspace navigation and case-insensitive host search.
6. System appearance changes and independent light/dark preferences.
7. Closing a pane while its command remains active.
8. Explicit target selection and composer cancellation.
9. Dismissing approval without dispatch.
10. Rejection of stale plan approval.
11. Per-command approval without executing unselected commands.
12. Result pagination, withheld output and hostile text rendering.
13. SSE disconnect, catch-up and event deduplication.
14. Saved consultation answers without execution controls.
15. Multi-host preparation, a halted canary when verification is missing, and
    selected continuation without repeating completed hosts.
16. Real PTY input/output, theme changes, refresh/reattach and explicit close.
17. Dismissing direct shell approval without creating a session.

These browser checks exposed and fixed three UI issues: saved consultation
answers were hidden behind inappropriate execution controls, newly opened task
panes could stay off-screen, and a completed canary selection could block
continuation of remaining hosts. Opening a task or selecting its tab now brings
that pane into view. A completed canary is not reused as a pending target.

`browser-checks/linux-lab.spec.js` launches the actual binary against an existing
vault. Its five read-only checks cover host navigation/control restrictions,
real CPU/RAM/filesystem measurements, explicit inventory refresh, existing CLI
history/results and server-side rejection of a forged mutation. No packages,
services or workloads are changed. It skips unless explicitly configured:

```sh
INTENT_BROWSER_EXECUTABLE=/usr/bin/google-chrome \
INTENT_WEB_HOST=webminai-debian-13 \
INTENT_WEB_DATA_ROOT=/home/vscode/.intentaiops \
npm run test:web
```

`VAULT_TEST` must already be present in the environment. Do not put its value in
the command, report or repository. Close another workspace using that profile
before starting. Open pictures directly from `artifacts/browser-screenshots/`.
It contains per-test subfolders, all 27 gallery captures and responsive views.
Live captures mask code, output and recent-task labels. The folder is gitignored
and excluded from distribution packages. There is no HTML report to serve.

Add `INTENT_WEB_SHELL_TEST=1` to explicitly opt into the real SSH browser test.
It opens the saved lab host with actions enabled and runs only the read-only
commands listed above. The live screenshot shows terminal output; unrelated task-history labels remain masked.
