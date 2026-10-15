# SSH connection reuse

## Audit before changing behavior

SystemSsh.openInteractiveSession creates a randomized temporary ControlMaster socket. Its session.ssh shares that socket with SSH, SCP (including legacy SCP fallback), interactive shells, Netdata inventory, signed Stage 2 requests, and installation/update operations. Commands that lose transport confirmation are not replayed. Reconnection is already coalesced within a session.

HostSessionFactory creates a new master for every open call. The connected-host menu reuses one session until leaving the host. Multi-host workflows retain a separate session/admin per host within one operation, then close all sessions. Fleet updates, later retries/rollback, console actions, and reopening a host create new masters. New-host verification opens its own temporary session before encrypted registration.

Standalone AdminService/SystemSsh callers without an opened session establish independent SSH connections. They have no application lifecycle or authenticated interactive session to pool implicitly. The Kubernetes gateway uses its separate API transport and is not an SSH consumer.

## Implementation

`SystemSsh.acquireSession()` owns one lightweight `SshSessionManager` per application transport. `HostSessionFactory` returns reference-counted leases over the existing session. Concurrent acquisition shares one establishment promise per compatible identity; unrelated hosts have independent promises. SSH, SCP, interactive shells, Netdata, retry, rollback, and multi-host services continue using the same transport and signed execution policies. Standalone callers must acquire a lease explicitly to share connections and call `closeSessions()` in their application shutdown handler.

Lease release waits for its own active channels. Shutdown waits for active operations, cancels outstanding establishment, exits owned masters, and removes owned directories. Idle connections expire after 600 seconds by default. The CLI closes its pool in its normal exit path. Abrupt process termination can leave temporary resources; the application never scans or deletes another process's sockets.

Pool identity includes the requested alias, port, user, identity and config files, effective `ssh -G` transport/proxy options, identity-file fingerprints, agent public identities, authentication method, credential context, and process environment. Keys are process-private HMACs, never diagnostic output. Unknown or unsupported identity contexts disable reuse rather than guessing. Kerberos contexts are not pooled.

Idle reacquisition checks the master with OpenSSH's control protocol. Active sessions throttle checks to once per 30 seconds. Reconnection is coalesced, with the existing bounded recovery delays. An exit code 255 never replays the command. A healthy master is retained when an individual channel fails, avoiding disruption of other channels. Unknown remote outcomes still require the existing recovery and operator approval flow.

## Configuration and security

The optional top-level `ssh` settings are `multiplexing` (boolean, default true), `idleTimeoutSeconds` (integer 0-86400, default 600), and `compression` (boolean, default false). Zero closes a master when its last lease releases. Existing encrypted host settings and vault formats are unchanged. Compression uses `Compression=yes`, never `CompressionLevel`, and remains off unless explicitly requested.

Owned socket directories are randomized, mode 0700, and checked for ownership, replacement, and unsafe sockets. Socket paths are kept within 100 bytes, with a short private `/tmp` directory when necessary. Strict host-key verification and saved-credential authentication are preserved. No secrets or command payloads appear in counters.

Windows clients and known unsupported multiplexing clients fall back to ordinary SSH. On Windows clients, authentication uses the terminal or keys rather than Unix askpass scripts. Connections are not retained in fallback mode. Remote Windows hosts can still use multiplexing from a supported local client. No remote agents or SSH server changes are introduced.

`--debug` reports master establishments, reuse hits, channels, reconnects, active/idle masters, total establishment duration, and cleanup failures. Routine channels do not generate normal CLI messages.

## Tests and benchmarks

Run `npm run test:ssh` for deterministic transport, lease, settings-adjacent, and factory coverage. The real OpenSSH test is skipped unless both `INTENT_SSH_TEST_ALLOW=1` and `INTENT_SSH_TEST_HOST=ssh://your-disposable-host` are set. It requires trusted host keys and key authentication; it executes only `true` commands.

For measurements against disposable POSIX hosts with trusted host keys and key authentication:

```sh
npm run benchmark:ssh -- --allow-ssh --host ssh://user@disposable-host --host ssh://user@second-disposable-host --repetitions 5
```

The script compares disabled multiplexing, existing per-workflow sessions, pooled reuse, and pooled reuse with compression. It measures one, ten, and fifty sequential commands, ten concurrent commands, small SCP, read-only Netdata health/inventory, and multi-host operations. SCP creates and removes only its own temporary file and directory. Netdata absence is recorded as an unavailable workload.

JSON output includes total elapsed time, median and p95 channel latency, connection-acquisition latency, and transport counters. Per-workflow sessions include a new handshake each trial; pooled trials include an initial cold connection and subsequent warm acquisitions. Repeat the same host list and client conditions for comparisons. Multi-host measurements require at least two hosts to be meaningful.

Linux live validation and five-repetition benchmarks have now run on eight verified disposable hosts. See [the lab checkpoint](linux-lab-validation-status.md) for measurements, host-specific failures, and remaining platform checks. Results describe this local lab only, not a general performance guarantee.

Local validation passed: `npm test`, `npm run lint`, `npm run typecheck`, `npm run test:ssh`, and `npm run test:package-install`. SSH-specific tests passed 31 cases and skipped the opt-in OpenSSH case. Coverage includes coalesced establishment/reconnection, independent hosts and authentication contexts, lease lifetimes, idle expiry, private and missing socket checks, saved credentials, compression, and legacy SCP fallback. No production hosts were contacted.
