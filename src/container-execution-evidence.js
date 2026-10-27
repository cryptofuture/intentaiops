import { validateDiagnostic, isWindowsComposeTarget } from './deployment-phases.js'
import { windowsDockerPowerShellAdapter } from './windows-compose-foundation.js'
import { containerRuntimeDiagnostics } from './workload-execution-evidence.js'
import { observation } from './execution-diagnostics.js'

export async function collectComposeEvidence (client, diagnostic, startedAt, { platform, runtimeHome } = {}) {
  if (diagnostic?.kind !== 'compose' || !startedAt) return []
  validateDiagnostic(diagnostic)
  const format = '{"Id":{{json .Id}},"State":{"OOMKilled":{{json .State.OOMKilled}},"ExitCode":{{json .State.ExitCode}},"FinishedAt":{{json .State.FinishedAt}},"Health":{"Status":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}}}}}'
  try {
    if (platform === 'windows') return await collectWindowsComposeEvidence(client, diagnostic, startedAt, format)
    let context = ''
    if (platform !== undefined && !['linux', 'freebsd', 'macos'].includes(platform)) throw new Error('Unverified runtime platform')
    if (platform === 'macos') {
      if (!/^\/Users\/[a-z_][a-z0-9_-]{0,31}$/u.test(runtimeHome ?? '') || !diagnostic.target.startsWith(`${runtimeHome}/.webminai/services/`)) throw new Error('Unverified Colima context')
      context = `unset DOCKER_CONTEXT; export HOME='${runtimeHome}' PATH='/usr/local/bin:/usr/local/sbin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin' DOCKER_HOST='unix://${runtimeHome}/.colima/default/docker.sock'; `
    }
    const filter = `label=com.docker.compose.project.working_dir=${diagnostic.target}`
    const project = `projects=$(docker ps --all --filter '${filter}' --format '{{.Label "com.docker.compose.project"}}' | head -n 13 | LC_ALL=C sort -u); case "$projects" in ''|*[!a-z0-9_-]*) exit 1;; esac; [ "\${#projects}" -le 63 ] || exit 1; `
    const command = `set -eu; ${context}${project}ids=$(docker ps --all --quiet --no-trunc --filter '${filter}' --filter "label=com.docker.compose.project=$projects" | head -n 13); [ -n "$ids" ] || exit 1; count=0; for id in $ids; do case "$id" in *[!a-f0-9]*|'') exit 1;; esac; [ "\${#id}" = 64 ] || exit 1; count=$((count+1)); [ "$count" -le 12 ] || { printf '%s\\n' TRUNCATED; break; }; docker inspect --type container --format '${format}' "$id"; done`
    const result = await client.runCommand(command, { timeoutSeconds: 5 })
    if (result.exitCode !== 0 || result.stdoutTruncated || !String(result.stdout ?? '').trim() || String(result.stdout).length > 16384) throw new Error('runtime evidence unavailable')
    return String(result.stdout).trim().split(/\r?\n/u).filter(Boolean).slice(0, 13).flatMap(line => {
      if (line === 'TRUNCATED') return [observation('EVIDENCE_UNAVAILABLE', 'unknown', 'container', 'runtime-inspect', 'Container evidence was limited to twelve project containers.', { availability: 'truncated' })]
      const object = JSON.parse(line)
      return containerRuntimeDiagnostics(object, { id: object.Id, startedAt })
    })
  } catch {
    return [observation('EVIDENCE_UNAVAILABLE', 'unknown', 'container', 'runtime-inspect', 'Container runtime inspection failed or was unavailable. No cause is inferred.')]
  }
}

async function collectWindowsComposeEvidence (client, diagnostic, startedAt, format) {
  if (!isWindowsComposeTarget(diagnostic.target)) throw new Error('Unverified Windows Compose path')
  const prefix = windowsDockerPowerShellAdapter(3000)
  const filter = `label=com.docker.compose.project.working_dir=${diagnostic.target.replaceAll('/', '\\')}`
  const listing = await client.runCommand(`${prefix};& $docker ps --all --quiet --no-trunc --filter '${filter}';if($LASTEXITCODE -ne 0){throw 'Windows Compose enumeration failed'}`, { timeoutSeconds: 5 })
  if (listing.exitCode !== 0 || listing.stdoutTruncated || String(listing.stdout ?? '').length > 1024) throw new Error('Container enumeration unavailable')
  const ids = String(listing.stdout ?? '').trim().split(/\r?\n/u).filter(Boolean)
  if (!ids.length || ids.length > 13 || ids.some(id => !/^[a-f0-9]{64}$/u.test(id)) || new Set(ids).size !== ids.length) throw new Error('Invalid container identities')
  const selected = ids.slice(0, 12)
  const result = await client.runCommand(`${prefix};& $docker inspect --type container --format '${format}' ${selected.join(' ')};if($LASTEXITCODE -ne 0){throw 'Windows container inspection failed'}`, { timeoutSeconds: 5 })
  if (result.exitCode !== 0 || result.stdoutTruncated || String(result.stdout ?? '').length > 16384) throw new Error('Container inspection unavailable')
  const records = String(result.stdout ?? '').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
  if (records.length !== selected.length || new Set(records.map(record => record.Id)).size !== records.length || records.some(record => !selected.includes(record.Id))) throw new Error('Container identity changed')
  const diagnostics = records.flatMap(record => containerRuntimeDiagnostics(record, { id: record.Id, startedAt }))
  if (ids.length > 12) diagnostics.push(observation('EVIDENCE_UNAVAILABLE', 'unknown', 'container', 'runtime-inspect', 'Container evidence was limited to twelve project containers.', { availability: 'truncated' }))
  return diagnostics
}

export async function collectContainerEvidence (client, { runtime, id, startedAt }) {
  if (!['docker', 'podman'].includes(runtime) || !/^[a-f0-9]{64}$/u.test(id ?? '')) throw new TypeError('container evidence requires an explicit runtime and full container ID')
  const result = await client.runCommand(`${runtime} inspect --type container --format '{{json .State.OOMKilled}} {{json .State.ExitCode}} {{json .State.FinishedAt}}' ${id}`, { timeoutSeconds: 5 })
  const match = /^(true|false) (-?\d+) "([0-9TZ:.+-]+)"\s*$/u.exec(result.stdout ?? '')
  if (result.exitCode !== 0 || !match) return [observation('EVIDENCE_UNAVAILABLE', 'unknown', 'container', 'runtime-inspect', 'The exact container could not be inspected.')]
  return containerRuntimeDiagnostics({ Id: id, State: { OOMKilled: match[1] === 'true', ExitCode: Number(match[2]), FinishedAt: match[3] } }, { id, startedAt })
}
