# Kubernetes lab branch validation

## Current checkpoint: 2026-10-25 05:20 UTC

- Dedicated `webminai-system/webminai-recovery` PVC (`standard`,1Gi) is
  explicitly enabled. Its root is initialized0700 only when empty or already
  private; unsafe nonempty roots are preserved and rejected. Gateway updates
  reuse it and deactivation preserves the namespace/PVC/signing material.
- The shared `KubernetesTaskService` now connects CLI and browser catalog task
  preparation, durable review, explicit fingerprint approval, command journaling,
  boundary pause/abort and confirmed-step continuation. Before mutation it
  verifies the actual cluster-bound PVC and single-writer Deployment, not just
  a configuration flag. Public review projections exclude command payloads,
  pod specifications, environment values and raw output.
- The signed fixed gateway recovery function embeds the existing maintained
  OpenSSL P-256 storage implementation. Version2 records add original resource
  UID/path/definition bindings; fresh recovery regenerates catalog-based DELETE
  plans with UID preconditions. Unknown creations and unresolved recovery
  deletions fail closed. A later successful attempt cannot hide an earlier
  uncertain creation. No remote script is accepted as recovery instructions.
- All 832 automated tests pass. Six browser checks passed, including full n8n
  and nginx prepare/reload/review/apply/gateway-restart/fresh-profile recovery
  cycles. The isolated encrypted profiles were removed only after successful
  recovery. Original vault/history remain intact. Signing key fingerprints
  survived gateway restarts, and RBAC rules were unchanged.
- The native health field is `recoveryOpenSslAvailable`; the former field has
  no remaining source references. The final native build was reinstalled and
  tested; final installed-package smoke passed on Linux/x64. Package SHA-256:
  `55c058b8bc7497fc1b7a157407202d901055fd244e7b725cea8fb41f186b487d`.
  Installed Kubernetes plugin SHA-256 matches the rebuilt artifact:
  `3beed78e1aa30d6df7403bd0d2eeb90cd67464ebcf6be4dedb6d5617bb4ff696`.
  Final independent reads reconfirmed empty task resources, a Bound recovery
  PVC, two ready original nginx replicas and an unchanged signing fingerprint.
- Remaining feature limits: cluster workflows accept reviewed catalog plans,
  not arbitrary AI planning/revisions or multi-cluster rollout orchestration.
  Catalog or node-identity drift and unresolved mutations require investigation.
  Do not describe this as universal branch-feature parity.

- All thirteen applications plus nginx passed all-node health and guarded
  cleanup: WordPress, WooCommerce, Joomla, Drupal, PrestaShop, Moodle, Magento
  n8n, Ghost, Mattermost, Odoo, Jellyfin and Home Assistant.
- Independent final API reads confirmed zero task Pods, Deployments,
  ReplicaSets, Jobs, Services, PVCs and related PVs. The unrelated nginx
  Deployment retains both ready replicas. No application test runner remains.
- Magento's original cycle timed out acquiring images, then normal foreground
  cleanup exceeded its first observation window. No force deletion, finalizer
  removal or node restart was used. Image transfer completed; subsequent
  UID-checked cleanup confirmed all original resources absent. A cleanup Job
  collection response was conservatively classified unknown; that original
  outcome remains historical uncertainty, with later empty-state observation.
  The cleanup implementation now reads Jobs and deletes individual owned UIDs,
  never a whole labelled collection. Replaced/unowned targets block deletion.
- Magento passed the stricter setup/schema/index/cron/storefront checks from
  all three nodes after correcting the image account from UID33 to82. Normal
  UID-checked cleanup completed. Failed-cycle receipts, diagnostic Jobs and
  evidence remain in `priorAttempts`; no partial setup was replayed.
  Private logs are bounded to64KiB; only fixed flags and validated summaries
  were retrieved.
- Ghost's cold image acquisition exceeded the original360s observer. Transfer
  progressed without node pressure. A reviewed resourceVersion/UID-checked
  deadline extension preserved the Deployment template, Pod and PVC; explicit
  verification resumed against the original UID, passed, then removed its
  resources normally. The adapter now allows1200s, like Moodle and Magento.
- Product catalog task history/review and persistent signed recovery are now
  connected and tested as described above; arbitrary AI revisions remain absent.
- Earlier milestone: 814 automated tests, lint, typecheck and four live browser checks passed.
  First package smoke timed out fetching npm dependencies; registry connectivity
  later returned and the prefer-offline retry passed without disabling integrity
  checks. That milestone's package SHA-256 (superseded above):
  `b176dd132aca9390dea8d6f1b50a000b24857d213671b7ac9ee4d16ec3de9856`.
- Six additional opt-in live checks passed using signed reads and an isolated
  SQLite task directory (no new vault): gateway scope/signature enforcement,
  rejected approval without dispatch, concurrent-owner exclusion, boundary
  pause, reopened history/immutable commands/stale revisions, and reviewed
  continuation without repeating completed reads. Run:
  `INTENT_KUBERNETES_LIVE=1 INTENT_WEB_DATA_ROOT=/home/vscode/.intentaiops INTENT_WEB_CLUSTER=webminai-k8s node --test test/kubernetes-reliability.integration.test.js`.
  This exercises the actual shared executor/journal but does not claim a
  connected production workflow by itself; separate browser acceptance now
  covers the shared catalog task path and fresh-profile recovery.
- Canonical API-only `runCommand` now works through the shared executor; shell
  payloads are rejected. Live three-node GET exercised ordered callbacks.
  API ambiguity now journals unknown, not failed, and cannot enter configured
  failure retries. Shared output is metadata/status-only and bounded to 32 KiB;
  raw pod specifications, environment, data and error text are withheld.
  This was transport/executor evidence; the subsequent browser checks also
  exercised production cluster TaskStore integration.
- Magento had an independent false-success risk: `setup:install` failure could
  be ignored when `env.php` existed. The corrected initializer requires schema,
  developer mode, CMS marker, reindex, index validity, cache and cron completion
  before readiness; an interrupted attempt blocks automatic setup replay.
  It uses the shared Linux index-validation code and runs Magento as its file
  owner. The canonical URL now includes the internal Service namespace/port;
  node checks require the marker on the actual storefront, not only a dummy
  health file. These stricter changes subsequently passed live qualification.
  References: [schema status](https://experienceleague.adobe.com/en/docs/commerce-operations/installation-guide/tutorials/database-status)
  and [index management](https://experienceleague.adobe.com/en/docs/commerce-operations/configuration-guide/cli/manage-indexers).
- The previously built `a661...` package predates the stricter Magento changes
  and is superseded by the final rebuilt and smoke-tested artifact above.
- Fresh Magento execution `50e25f23-16a7-403e-a6b0-48c28e187894`
  reached running containers, but the initializer entered its exit-78 guard.
  Code inspection exposed `/state/config` created under umask077 without
  traversal for the application owner. A local fixture reproduces that mode
  defect and now verifies0755; the initial live error log was no longer retained
  after guard restarts, so do not call this the sole confirmed live cause.
- Readiness observer session78486 was deliberately stopped with no pending API
  mutation and three confirmed resource receipts. No remote command was killed
  by stopping the observer. Separately reviewed cleanup follows, then a fresh
  corrected attempt. Failed-cycle receipts and historical uncertainty are kept.

## Scope

### Magento ownership diagnosis

The bounded setup log matched the exact fixed message for missing
`Magento\Framework\App\ResourceConnection\Proxy`. A separately recorded
read-only collector confirmed the image's `www-data` UID/GID is82, while
the adapter assigned generated-code directories and cron to33. Developer
mode alone did not resolve this. The adapter now seeds files using the
image account and runs cron as82; regression fixtures cover these values.
Live qualification and normal reviewed cleanup passed at03:29 UTC.
No initializer was replayed against its existing partial database.

Started 2026-10-25. Compare current `yet-to-test` with local `main` without
resetting either branch. Use the existing three-node kind lab, verified TLS,
the normal encrypted vault, actual CLI and the separate signed gateway.
Never route Kubernetes through SSH or claim host-only features apply to clusters.

## Initial baseline before this validation (historical)

- Kubernetes v1.36.1: control-plane and both workers Ready.
- Existing `webminai-stage2` Deployment is ready; its writable storage is
  ephemeral. No persistent recovery signer is configured.
- `webminai-tasks` has no application Deployment or PVC. Preserve the unrelated
  two-replica nginx workload in `webminai-lab-workload` and all system resources.
- Default `standard` storage class exists. No changing lab task started yet.
- Kubernetes plugin rebuilt and reinstalled through the actual CLI. Live
  version0.7.2 matches the local SHA-256
  `be679bbc2d7aec399f8e93d26bab7f6b04ac80284a85a2a6bcb7cc980a373049`.
  All five distribution checksums pass.

## Branch-feature audit, not acceptance claims

| Area | Existing route | Remaining evidence/work |
| --- | --- | --- |
| Signed gateway and diagnostics | API-only commands and separate authenticated fixed recovery protocol | Rebuilt/reinstalled; signature/scope enforcement tested live; no new RBAC |
| Common software | 13 applications plus nginx | All14 validation cycles passed; new browser pipeline additionally exercised n8n and nginx |
| Durable journal, pause/review/resume and revisions | Shared cluster task service, WAL/FULL history and signed pre-dispatch intent | Catalog controls implemented; arbitrary AI revisions remain unsupported |
| Local web workspace | Persisted cluster preparation/review/execution/recovery | Actual CLI/browser reload and fresh-profile acceptance passed |
| Ownership and concurrency | Cluster-scoped local mutation lease, task heartbeat and remote execution owner/head checks | Fixtures reject conflicting owners/stale approvals; privileged cluster administration remains a trust limit |
| Signed fresh-install remote recovery | Dedicated verified PVC and persistent P-256 signer | Live restart/key continuity and fresh-profile UID-bound reviewed recovery passed; ambiguous mutations remain blocked |
| SSH pooling and browser SSH shell | Host-only transports | Not applicable to Kubernetes; keep the separate API route |
| Loop protection, replay/export and uncertainty | Shared mechanisms and Kubernetes diagnostics have fixtures | Establish actual cluster workflow coverage; never replay an uncertain API mutation |

## Application matrix

Passed all-node health and guarded cleanup: nginx, WordPress, WooCommerce,
Joomla, Drupal, PrestaShop, Moodle, Magento, n8n, Ghost, Mattermost, Odoo,
Jellyfin and Home Assistant. No catalog entries remain untested on this lab.

These passes cover catalog validation cycles, not full product workflow parity.
Record failures, cleanup state, resource identities and limitations before
moving to another app.

## 2026-10-25 continuation

- Comparison anchors: local main `fe55614b5ef780dbae582008103a0e905e41cdd2`,
  branch HEAD `43f8f6e8664df6f9ba8d20123afa87e462804c37`, plus current edits.
- Cluster `webminai-k8s` added through the actual CLI to the existing normal
  encrypted vault with `VAULT_TEST`; no new test vault or leaked key file.
- Rebuilt Kubernetes plugin v0.7.2 installed through reviewed CLI activation.
  Deployed digest matches the local artifact:
  `be679bbc2d7aec399f8e93d26bab7f6b04ac80284a85a2a6bcb7cc980a373049`.
  CLI now confirms desired and observed Stage 2 active.
- Initial two-minute readiness wait expired during a normal image pull.
  Assembly exited zero; no crash/OOM/image-pull failure was established.
  The existing pod subsequently became ready without replay. Readiness now
  allows 600 attempts and reports bounded allowlisted pod states, never logs.
- Gateway activation/deactivation in the CLI and lab scripts now share local
  cluster-identity ownership with application validation. This is local
  same-data-root exclusion, not a distributed cross-installation lease.
- App harness now requires explicit disposable-live approval, an empty task
  namespace, cluster-bound checkpoints and creation UID receipts before cleanup.
  Concurrent validation Jobs serialize receipt writes. Uncertain API mutations
  retain their intent and block automatic retry/cleanup. This lab checkpoint is
  not a substitute for production TaskStore/controller integration.
- All 806 automated tests, lint and typecheck pass after these changes. Final
  package rebuild remains pending. App matrix started serially using the saved
  cluster; see appended records below. No application pass is claimed in advance.
- Four opt-in real-browser checks passed using the actual CLI, existing normal
  vault and saved cluster: real three-node/gateway inspection, authenticated
  reload without retained URL token, forged read-only mutation rejection and
  cross-origin rejection for session/cluster/events. Screenshot inspected;
  files are in ignored `artifacts/browser-screenshots/kubernetes-lab-*`.
- Live read-only gateway probes rejected an incorrect command signature,
  `kube-system` pod reads and task-namespace Secret reads. A second local
  operator was excluded while the application runner held cluster ownership.
  These probes issued no workload mutations or privilege changes.
- Persistent recovery storage was requested as a separate operator choice.
  No PVC, signer backend, RBAC expansion or secret migration has been performed.
- Moodle exposed a real timing mismatch: its adapter permits 1200 readiness
  iterations, but Kubernetes defaulted Deployment progress to 600 seconds.
  A cold image pull took about 265 seconds; runtime extension building then
  crossed the controller deadline. There was no recorded OOM or restart.
  The same pod subsequently became healthy without repeating installation.
- Future application Deployments now set progress deadlines from their declared
  readiness budget plus 60 seconds, with matching startup-probe allowance.
  Unit coverage checks Moodle/Magento 1260-second progress and 240 five-second
  startup attempts. The new Moodle deadline was not cold-retested from scratch.
- Explicit `resume moodle-kubernetes --approve-live-tests` verified the original
  Deployment UID and all existing creation receipts, created only the three
  missing verification Jobs, then passed all-node health and guarded rollback.
  Workload/storage creation was not repeated. Namespace resource collections
  are empty. Seven of fourteen entries now pass; remaining matrix continues
  from Magento. Prior failure and resume evidence remain in this checkpoint.
- Browser-runner artifact issue: Playwright's root output cleanup removed prior
  ignored FreeBSD application PNGs. Their previously inspected results, task
  journals and checkpoints remain, but those PNGs have not been restored.
  Playwright output is now isolated under `artifacts/browser-screenshots/playwright`
  so future runs do not clear sibling manual application captures.

- 2026-10-25T02:02:17.295Z nginx-static-site-kubernetes: Started explicitly approved disposable lab cycle; task namespace confirmed empty

- 2026-10-25T02:02:22.776Z nginx-static-site-kubernetes: Application and all-node health checks passed; rollback pending

- 2026-10-25T02:02:24.152Z nginx-static-site-kubernetes: PASS application/all-node health and UID-checked rollback; task namespace empty

- 2026-10-25T02:02:24.246Z wordpress-kubernetes: Started explicitly approved disposable lab cycle; task namespace confirmed empty

- 2026-10-25T02:02:52.152Z wordpress-kubernetes: Application and all-node health checks passed; rollback pending

- 2026-10-25T02:03:23.122Z wordpress-kubernetes: PASS application/all-node health and UID-checked rollback; task namespace empty

- 2026-10-25T02:03:23.232Z woocommerce-kubernetes: Started explicitly approved disposable lab cycle; task namespace confirmed empty

- 2026-10-25T02:04:46.099Z woocommerce-kubernetes: Application and all-node health checks passed; rollback pending

- 2026-10-25T02:05:17.547Z woocommerce-kubernetes: PASS application/all-node health and UID-checked rollback; task namespace empty

- 2026-10-25T02:05:17.667Z joomla-kubernetes: Started explicitly approved disposable lab cycle; task namespace confirmed empty

- 2026-10-25T02:05:50.626Z joomla-kubernetes: Application and all-node health checks passed; rollback pending

- 2026-10-25T02:06:22.660Z joomla-kubernetes: PASS application/all-node health and UID-checked rollback; task namespace empty

- 2026-10-25T02:06:22.763Z drupal-kubernetes: Started explicitly approved disposable lab cycle; task namespace confirmed empty

- 2026-10-25T02:06:50.652Z drupal-kubernetes: Application and all-node health checks passed; rollback pending

- 2026-10-25T02:06:53.091Z drupal-kubernetes: PASS application/all-node health and UID-checked rollback; task namespace empty

- 2026-10-25T02:06:53.191Z prestashop-kubernetes: Started explicitly approved disposable lab cycle; task namespace confirmed empty

- 2026-10-25T02:07:07.800Z prestashop-kubernetes: Application and all-node health checks passed; rollback pending

- 2026-10-25T02:07:39.757Z prestashop-kubernetes: PASS application/all-node health and UID-checked rollback; task namespace empty

- 2026-10-25T02:07:39.878Z moodle-kubernetes: Started explicitly approved disposable lab cycle; task namespace confirmed empty

- 2026-10-25T02:17:41.042Z moodle-kubernetes: Stopped without automatic retry or cleanup; inspect existing resources and recorded mutation intent

- 2026-10-25T02:21:58.412Z moodle-kubernetes: Separately approved verification of the existing Deployment UID; no workload or storage creation will be repeated

- 2026-10-25T02:22:02.658Z moodle-kubernetes: Application and all-node health checks passed; rollback pending

- 2026-10-25T02:22:04.564Z moodle-kubernetes: PASS application/all-node health and UID-checked rollback; task namespace empty

- 2026-10-25T02:22:58.204Z magento-kubernetes: Started explicitly approved disposable lab cycle; task namespace confirmed empty

- 2026-10-25T02:43:21.077Z magento-kubernetes: Stopped without automatic retry or cleanup; inspect existing resources and recorded mutation intent

- 2026-10-25T02:54:48.120Z magento-kubernetes: Separately approved ownership-checked cleanup; existing resources and mutation receipts retained

- 2026-10-25T02:54:48.138Z magento-kubernetes: API mutation outcome unknown; no retry or cleanup authorized automatically

- 2026-10-25T02:54:48.139Z magento-kubernetes: Cleanup not yet confirmed; inspect current deletion state, without force deletion or automatic replay

- 2026-10-25T03:00:37.675Z magento-kubernetes: Separately approved ownership-checked cleanup; existing resources and mutation receipts retained

- 2026-10-25T03:00:37.949Z magento-kubernetes: Reviewed cleanup completed; this is not an application pass, and earlier uncertainty remains recorded

- 2026-10-25T03:00:53.999Z magento-kubernetes: Started explicitly approved disposable lab cycle; task namespace confirmed empty

- 2026-10-25T03:04:27.906Z magento-kubernetes: Separately approved ownership-checked cleanup; existing resources and mutation receipts retained

- 2026-10-25T03:04:59.395Z magento-kubernetes: Reviewed cleanup completed; this is not an application pass, and earlier uncertainty remains recorded

- 2026-10-25T03:06:11.059Z magento-kubernetes: Started explicitly approved disposable lab cycle; task namespace confirmed empty

- 2026-10-25T03:16:58.261Z magento-kubernetes: Separately approved ownership-checked cleanup; existing resources and mutation receipts retained

- 2026-10-25T03:17:29.969Z magento-kubernetes: Reviewed cleanup completed; this is not an application pass, and earlier uncertainty remains recorded

- 2026-10-25T03:17:42.077Z magento-kubernetes: Started explicitly approved disposable lab cycle; task namespace confirmed empty

- 2026-10-25T03:22:26.674Z magento-kubernetes: Separately approved ownership-checked cleanup; existing resources and mutation receipts retained

- 2026-10-25T03:22:58.579Z magento-kubernetes: Reviewed cleanup completed; this is not an application pass, and earlier uncertainty remains recorded

- 2026-10-25T03:23:05.563Z magento-kubernetes: Started explicitly approved disposable lab cycle; task namespace confirmed empty

- 2026-10-25T03:25:51.407Z magento-kubernetes: Separately approved ownership-checked cleanup; existing resources and mutation receipts retained

- 2026-10-25T03:26:23.509Z magento-kubernetes: Reviewed cleanup completed; this is not an application pass, and earlier uncertainty remains recorded

- 2026-10-25T03:26:46.245Z magento-kubernetes: Started explicitly approved disposable lab cycle; task namespace confirmed empty

- 2026-10-25T03:28:46.194Z magento-kubernetes: Application and all-node health checks passed; rollback pending

- 2026-10-25T03:29:17.558Z magento-kubernetes: PASS application/all-node health and UID-checked rollback; task namespace empty

- 2026-10-25T03:29:17.660Z n8n-kubernetes: Started explicitly approved disposable lab cycle; task namespace confirmed empty

- 2026-10-25T03:29:32.260Z n8n-kubernetes: Application and all-node health checks passed; rollback pending

- 2026-10-25T03:29:34.390Z n8n-kubernetes: PASS application/all-node health and UID-checked rollback; task namespace empty

- 2026-10-25T03:29:34.488Z ghost-kubernetes: Started explicitly approved disposable lab cycle; task namespace confirmed empty

- 2026-10-25T03:35:41.178Z ghost-kubernetes: Stopped without automatic retry or cleanup; inspect existing resources and recorded mutation intent

- 2026-10-25T03:36:13.480Z ghost-kubernetes: Reviewed cold-pull observation extension: progress deadline1260s, same Deployment UID/template and PVC; no workload creation or initializer replay

- 2026-10-25T03:36:21.855Z ghost-kubernetes: Separately approved verification of the existing Deployment UID; no workload or storage creation will be repeated

- 2026-10-25T03:37:31.293Z ghost-kubernetes: Application and all-node health checks passed; rollback pending

- 2026-10-25T03:37:36.063Z ghost-kubernetes: PASS application/all-node health and UID-checked rollback; task namespace empty

- 2026-10-25T03:37:36.488Z mattermost-kubernetes: Started explicitly approved disposable lab cycle; task namespace confirmed empty

- 2026-10-25T03:37:56.158Z mattermost-kubernetes: Application and all-node health checks passed; rollback pending

- 2026-10-25T03:37:58.358Z mattermost-kubernetes: PASS application/all-node health and UID-checked rollback; task namespace empty

- 2026-10-25T03:37:58.845Z odoo-kubernetes: Started explicitly approved disposable lab cycle; task namespace confirmed empty

- 2026-10-25T03:38:17.535Z odoo-kubernetes: Application and all-node health checks passed; rollback pending

- 2026-10-25T03:38:19.677Z odoo-kubernetes: PASS application/all-node health and UID-checked rollback; task namespace empty

- 2026-10-25T03:38:20.111Z jellyfin-kubernetes: Started explicitly approved disposable lab cycle; task namespace confirmed empty

- 2026-10-25T03:38:37.891Z jellyfin-kubernetes: Application and all-node health checks passed; rollback pending

- 2026-10-25T03:38:40.059Z jellyfin-kubernetes: PASS application/all-node health and UID-checked rollback; task namespace empty

- 2026-10-25T03:38:40.445Z home-assistant-kubernetes: Started explicitly approved disposable lab cycle; task namespace confirmed empty

- 2026-10-25T03:38:54.058Z home-assistant-kubernetes: Application and all-node health checks passed; rollback pending

- 2026-10-25T03:39:00.372Z home-assistant-kubernetes: PASS application/all-node health and UID-checked rollback; task namespace empty

- 2026-10-25T04:44:52.564Z PASS actual CLI/browser: persisted n8n plan review/reload, all-node execution, gateway restart with unchanged signing key, fresh-profile signature discovery/reconstruction and explicitly approved UID-checked recovery. Execution f9b5fd0359523f905e98d6a2a940832e; task resources absent; RBAC unchanged.

- 2026-10-25T04:55:27.167Z PASS actual CLI/browser: persisted n8n-kubernetes plan review/reload, all-node execution, gateway restart with unchanged signing key, fresh-profile signature discovery/reconstruction and explicitly approved UID-checked recovery. Execution 8b06228bee2cae80365ebaa310fadaca; task resources absent; RBAC unchanged.

- 2026-10-25T04:56:18.170Z PASS actual CLI/browser: persisted nginx-static-site-kubernetes plan review/reload, all-node execution, gateway restart with unchanged signing key, fresh-profile signature discovery/reconstruction and explicitly approved UID-checked recovery. Execution e3167ff4a307b9878b89c3fe67c2d9d9; task resources absent; RBAC unchanged.

- 2026-10-25T05:18:50.281Z PASS actual CLI/browser: persisted n8n-kubernetes plan review/reload, all-node execution, gateway restart with unchanged signing key, fresh-profile signature discovery/reconstruction and explicitly approved UID-checked recovery. Execution 448194a8fffb0bfa6e3e68c210494377; task resources absent; RBAC unchanged.

- 2026-10-25T05:19:43.891Z PASS actual CLI/browser: persisted nginx-static-site-kubernetes plan review/reload, all-node execution, gateway restart with unchanged signing key, fresh-profile signature discovery/reconstruction and explicitly approved UID-checked recovery. Execution 9e172a53963dc8823bb6ddb4e5f29768; task resources absent; RBAC unchanged.
