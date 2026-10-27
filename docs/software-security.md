# Application security checks

Common-task installations include a final, explicitly reviewed, read-only security check. It reads bounded runtime versions and selected package manifests, not application code. Recommendations are saved with task progress and shown in CLI and browser results. Kubernetes reports recommendations without pod execution or extra permissions.

Run `npm run audit:software` for catalog coverage, or `npm run audit:software -- --online --json` to include public vendor releases and advisories. Online checks contact GitHub without credentials. Missing, failed or truncated feeds never mean that software is safe. Source pins are not an installed software inventory.

Findings remain `needs_validation` with no severity until the installed artifact, affected range and impact are established. Publisher backports, active web PHP configuration and transitive dependencies require separate evidence. A successful installation is not a security certification.

## Remediation

Detected tracked issues can now lead to executable updates, not only recommendations. The CLI offers **Prepare and review updates now** after installation; task operator controls and the browser provide **Patch detected security issues**. Codex prepares a revision using fresh inventory and bounded version evidence. Review the patch, health checks, data preservation and rollback before approval. CLI approval can execute that exact revision immediately; in the browser approve the revision, then review and resume.

Native repairs prefer vendor security packages. Docker/Podman repairs update or rebuild images and recreate affected services with data preserved, never patch only a running container. A new fixed read-only collector checks the resulting runtime. Completed deployment commands remain immutable and are not replayed. Original approval does not authorize new updates; uncertain outcomes and stale decisions block continuation. Revisions are AI proposals, not verified catalog recovery templates.

Prefer maintained, patched releases. Source patches require matching provenance, pinned integrity and rebuild/compatibility tests. Unsupported or ambiguous applicability requires investigation; no generic patch is silently applied. No exploit, downloaded patch or skill installation runs as part of detection. Kubernetes runtime discovery remains unavailable here; its gateway does not gain SSH, pod-exec or automatic patching.

Moodle's shared container build now pins PHP 8.4.27 and its official image digest. Its task-owned PHP configuration disables session upload progress. This is mitigation for the separately tracked PHP upload-progress issue, not proof that every PHP vulnerability is fixed. Rebuild and validate the image before deployment; previously built images are unchanged.

Adding the approved security command changes new catalog fingerprints. Historical approved plans remain unchanged; incompatible historical catalog reconstruction fails closed.

## Research references

- [PHP security releases](https://www.php.net/) and [PHP changelog](https://www.php.net/ChangeLog-8.php): branch-specific patch floors and separate upload-progress mitigation.
- [PHP proof of concept](https://github.com/eness/php2shell-CVE-2026-109618-CVE-2026-109619-PoC): background only, never executed.
- [PHP patch collection](https://github.com/Anton-Barinov/php2shell-patches): reviewed-backport reference, not an automatic patch source.
- [OpenAI checker](https://github.com/openai/php2shell-checker): version-evidence approach, not installed as a skill.
- [Vercel checker](https://github.com/vercel-labs/fix-react2shell-next): branch-aware Next.js/React Server Components checks, including follow-up fixes. Plain client React or Preact is not classified as RSC.
- [Cloudflare security audit](https://github.com/cloudflare/security-audit-skill): coverage accounting, explicit unresolved facts and separation of candidates from confirmed findings. This integration does not claim its full independent multi-agent audit or execute its workflow.

The implementation uses original code and public version facts, not vendored skill packages. Fixed-path probes cannot discover every application, container route or dependency. FreeBSD single-container routes, user-owned macOS runtimes and Kubernetes installed versions can remain unavailable. No absence-of-vulnerabilities conclusion follows from unavailable evidence.
