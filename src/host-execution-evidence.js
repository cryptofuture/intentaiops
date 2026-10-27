import { createHash } from 'node:crypto'
import { validateDiagnostic } from './deployment-phases.js'

const UNIX = `LC_ALL=C; export LC_ALL
os=$(uname -s 2>/dev/null)
case "$os" in
Linux)
  printf 'bootIdentityKind=session\\n'
  printf 'bootId='; cat /proc/sys/kernel/random/boot_id 2>/dev/null
  cg=$(awk -F: '$1 == "0" {print $3}' /proc/self/cgroup 2>/dev/null)
  base=/sys/fs/cgroup
  case "$cg" in /*) if [ -r "$base$cg/memory.events" ]; then base="$base$cg"; fi;; esac
  if [ -r "$base/memory.events" ]; then
    current="$base"; selected="$base"; limit=''; index=0
    while :; do
      if [ "$index" -lt 16 ] && [ -r "$current/memory.events" ]; then
        printf 'scope%s=%s:%s\\n' "$index" "$current" "$(stat -c %i "$current" 2>/dev/null)"
        awk -v scopeIndex="$index" '$1 == "oom_kill" {print "oomKills" scopeIndex "=" $2}' "$current/memory.events"
        index=$((index+1))
      fi
      value=$(cat "$current/memory.max" 2>/dev/null)
      case "$value" in ''|*[!0-9]*) ;; *) if [ -z "$limit" ] || [ "$value" -lt "$limit" ]; then limit="$value"; selected="$current"; fi;; esac
      [ "$current" != /sys/fs/cgroup ] || break
      current=\${current%/*}
      case "$current" in /sys/fs/cgroup|/sys/fs/cgroup/*) ;; *) break;; esac
    done
    base="$selected"
    printf 'scopeId=%s:%s\\n' "$base" "$(stat -c %i "$base" 2>/dev/null)"
    awk '$1 == "oom_kill" {print "oomKills=" $2}' "$base/memory.events"
    printf 'memoryLimitBytes=%s\\n' "$limit"
  else
    cg=$(awk -F: '$2 ~ /(^|,)memory(,|$)/ {print $3}' /proc/self/cgroup 2>/dev/null)
    base=/sys/fs/cgroup/memory
    case "$cg" in /*) if [ -r "$base$cg/memory.failcnt" ]; then base="$base$cg"; fi;; esac
    if [ -r "$base/memory.failcnt" ]; then
      printf 'allocationFailures='; cat "$base/memory.failcnt"
      printf 'memoryLimitBytes='; cat "$base/memory.limit_in_bytes" 2>/dev/null
    fi
  fi
  awk '/^MemAvailable:/ {printf "availableMemoryBytes=%.0f\\n", $2 * 1024} /^SwapFree:/ {printf "freeSwapBytes=%.0f\\n", $2 * 1024}' /proc/meminfo 2>/dev/null
  ;;
Darwin)
  uuid=$(sysctl -n kern.bootsessionuuid 2>/dev/null)
  if [ -n "$uuid" ]; then printf 'bootId=%s\\nbootIdentityKind=session\\n' "$uuid"; else printf 'bootIdentityKind=time\\nbootId='; sysctl -n kern.boottime 2>/dev/null | sed -n 's/.*sec = \\([0-9]*\\),.*/\\1/p'; fi
  ;;
FreeBSD)
  printf 'bootIdentityKind=time\\n'
  printf 'bootId='; sysctl -n kern.boottime 2>/dev/null | sed -n 's/.*sec = \\([0-9]*\\),.*/\\1/p'
  ;;
esac
df -Pk / 2>/dev/null | awk 'NR == 2 {print "rootAvailableKiB=" $4}'
df -Pi / 2>/dev/null | awk 'NR == 2 {print "rootAvailableInodes=" $4}'
printf 'collectorComplete=1\\n'`

const WINDOWS = [
  '$ErrorActionPreference=\'Stop\'; $o=Get-CimInstance Win32_OperatingSystem; $d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'C:\'"',
  '$r=@{bootId=$o.LastBootUpTime.ToUniversalTime().Ticks.ToString(); availableMemoryBytes=([int64]$o.FreePhysicalMemory*1024); rootAvailableKiB=([int64]($d.FreeSpace/1024)); collectorComplete=1}',
  'function Read-Record($key,$filter) {try {$e=Get-WinEvent -FilterHashtable $filter -MaxEvents 1 -ErrorAction Stop; $r[$key]=[int64]$e.RecordId} catch {if ($_.FullyQualifiedErrorId -like \'NoMatchingEventsFound*\') {$r[$key]=0} else {$r[$key+\'Unavailable\']=$true}}}',
  'Read-Record resourceExhaustionRecordId @{LogName=\'System\'; ProviderName=\'Microsoft-Windows-Resource-Exhaustion-Detector\'; Id=2004; StartTime=$o.LastBootUpTime}',
  'Read-Record applicationCrashRecordId @{LogName=\'Application\'; ProviderName=\'Application Error\'; Id=1000; StartTime=$o.LastBootUpTime}',
  '$r | ConvertTo-Json -Compress'
].join('; ')

export function hostEvidenceCommand (platform, filesystemTarget = '/') {
  if (filesystemTarget !== '/') validateDiagnostic({ kind: 'filesystem', target: filesystemTarget })
  if (platform === 'windows') return WINDOWS
  if (['linux', 'freebsd', 'macos'].includes(platform)) return filesystemTarget === '/' ? UNIX : `${UNIX}\ndf -Pk '${filesystemTarget}' 2>/dev/null | awk 'NR == 2 {print "taskAvailableKiB=" $4}'\ndf -Pi '${filesystemTarget}' 2>/dev/null | awk 'NR == 2 {print "taskAvailableInodes=" $4}'`
  return null
}

export function parseHostEvidence (platform, result) {
  const base = { version: 1, platform, observedAt: new Date().toISOString(), availability: 'unavailable' }
  if (result?.exitCode !== 0) return { ...base, availability: result?.timedOut ? 'timeout' : 'unavailable' }
  const output = String(result.stdout ?? '')
  if (output.length > 8192 || result.stdoutTruncated) return { ...base, availability: 'truncated' }
  let fields
  try {
    fields = platform === 'windows' ? JSON.parse(output) : Object.fromEntries(output.split(/\r?\n/u).map(line => { const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)] }))
  } catch { return base }
  if (!fields || Number(fields.collectorComplete) !== 1) return base
  const evidence = { ...base, availability: 'available' }
  if (typeof fields.bootId === 'string' && /^(?:[a-f0-9-]{36}|[0-9]{1,24})$/iu.test(fields.bootId)) evidence.bootId = fields.bootId
  if (typeof fields.scopeId === 'string' && fields.scopeId.length <= 2048) evidence.scopeId = createHash('sha256').update(fields.scopeId).digest('hex').slice(0, 40)
  evidence.bootIdentityKind = ['session', 'time'].includes(fields.bootIdentityKind) ? fields.bootIdentityKind : 'time'
  for (const key of ['oomKills', 'memoryLimitBytes', 'availableMemoryBytes', 'freeSwapBytes', 'rootAvailableKiB', 'rootAvailableInodes', 'taskAvailableKiB', 'taskAvailableInodes', 'allocationFailures', 'resourceExhaustionRecordId', 'applicationCrashRecordId']) {
    if (fields[key] !== undefined && /^\d+$/u.test(String(fields[key])) && Number.isSafeInteger(Number(fields[key]))) evidence[key] = Number(fields[key])
  }
  if (platform === 'windows') evidence.eventLogAvailability = fields.resourceExhaustionRecordIdUnavailable === true || fields.applicationCrashRecordIdUnavailable === true ? 'partially-unavailable' : 'available'
  evidence.memoryScopes = []
  for (let index = 0; index < 16; index++) {
    if (typeof fields['scope' + index] !== 'string' || fields['scope' + index].length > 2048 || !/^\d+$/u.test(fields['oomKills' + index] ?? '') || !Number.isSafeInteger(Number(fields['oomKills' + index]))) continue
    evidence.memoryScopes.push({ scopeId: createHash('sha256').update(fields['scope' + index]).digest('hex').slice(0, 40), oomKills: Number(fields['oomKills' + index]) })
  }
  evidence.memoryEvidence = platform === 'linux' ? (evidence.oomKills !== undefined ? 'cgroup-v2' : evidence.allocationFailures !== undefined ? 'allocation-only' : 'unavailable') : 'unsupported'
  evidence.bootEvidence = evidence.bootId ? 'available' : 'unavailable'
  evidence.filesystemEvidence = evidence.rootAvailableKiB !== undefined ? 'available' : 'unavailable'
  return evidence
}

export async function collectHostEvidence (client, { filesystemTarget = '/' } = {}) {
  try {
    client.evidencePlatform ??= (await (client.getJson ? client.getJson('/api/v3/function?function=webminai%3Ahealth&timeout=3') : client.health())).platform
    const command = hostEvidenceCommand(client.evidencePlatform, filesystemTarget)
    if (!command) return { version: 1, availability: 'unsupported' }
    const evidence = parseHostEvidence(client.evidencePlatform, await client.runCommand(command, { timeoutSeconds: 5 }))
    if (filesystemTarget !== '/') {
      evidence.filesystemTargetId = createHash('sha256').update(filesystemTarget).digest('hex').slice(0, 40)
      evidence.taskFilesystemAvailability = evidence.taskAvailableKiB !== undefined ? 'available' : 'unavailable'
    }
    return evidence
  } catch {
    return { version: 1, platform: client.evidencePlatform ?? null, observedAt: new Date().toISOString(), availability: 'unavailable' }
  }
}

export async function captureExecutionEvidence (client, options = {}) {
  if (!client.collectExecutionEvidence) return undefined
  try { return await client.collectExecutionEvidence(options) } catch {
    return { version: 1, availability: 'unavailable', observedAt: new Date().toISOString() }
  }
}
