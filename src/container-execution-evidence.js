import { validateDiagnostic } from './deployment-phases.js'
import { containerRuntimeDiagnostics } from './workload-execution-evidence.js'
import { observation } from './execution-diagnostics.js'

export async function collectComposeEvidence (client, diagnostic, startedAt) {
  if (diagnostic?.kind !== 'compose' || !startedAt) return []
  validateDiagnostic(diagnostic)
  const format = '{"Id":{{json .Id}},"State":{"OOMKilled":{{json .State.OOMKilled}},"ExitCode":{{json .State.ExitCode}},"FinishedAt":{{json .State.FinishedAt}},"Health":{"Status":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}}}'
  const command = `set -eu; ids=$(docker compose --project-directory '${diagnostic.target}' ps --all --quiet); count=0; for id in $ids; do case "$id" in *[!a-f0-9]*|'') exit 1;; esac; [ "\${#id}" = 64 ] || exit 1; count=$((count+1)); [ "$count" -le 12 ] || { printf '%s\\n' TRUNCATED; break; }; docker inspect --type container --format '${format}' "$id"; done`
  try {
    const result = await client.runCommand(command, { timeoutSeconds: 5 })
    if (result.exitCode !== 0 || result.stdoutTruncated || String(result.stdout).length > 16384) throw new Error('runtime evidence unavailable')
    return String(result.stdout).trim().split(/\r?\n/u).filter(Boolean).slice(0, 13).flatMap(line => {
      if (line === 'TRUNCATED') return [observation('EVIDENCE_UNAVAILABLE', 'unknown', 'container', 'runtime-inspect', 'Container evidence was limited to twelve project containers.', { availability: 'truncated' })]
      const object = JSON.parse(line)
      return containerRuntimeDiagnostics(object, { id: object.Id, startedAt })
    })
  } catch {
    return [observation('EVIDENCE_UNAVAILABLE', 'unknown', 'container', 'runtime-inspect', 'Container runtime inspection failed or was unavailable. No cause is inferred.')]
  }
}

export async function collectContainerEvidence (client, { runtime, id, startedAt }) {
  if (!['docker', 'podman'].includes(runtime) || !/^[a-f0-9]{64}$/u.test(id ?? '')) throw new TypeError('container evidence requires an explicit runtime and full container ID')
  const result = await client.runCommand(`${runtime} inspect --type container --format '{{json .State.OOMKilled}} {{json .State.ExitCode}} {{json .State.FinishedAt}}' ${id}`, { timeoutSeconds: 5 })
  const match = /^(true|false) (-?\d+) "([0-9TZ:.+-]+)"\s*$/u.exec(result.stdout ?? '')
  if (result.exitCode !== 0 || !match) return [observation('EVIDENCE_UNAVAILABLE', 'unknown', 'container', 'runtime-inspect', 'The exact container could not be inspected.')]
  return containerRuntimeDiagnostics({ Id: id, State: { OOMKilled: match[1] === 'true', ExitCode: Number(match[2]), FinishedAt: match[3] } }, { id, startedAt })
}
