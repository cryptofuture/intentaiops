import { powershellCommand } from './stage2-remote.js'

const UNIX = /\/var\/(?:lib|db)\/(?:webminai|intentaiops)\/task-state\/([1-9][0-9]*(?:-[A-Za-z0-9_-]+)?)(?=\/|['"\s;)\]}]|$)/gu
const WINDOWS = /C:[\\/]ProgramData[\\/](?:WebminAI[\\/]Tasks|IntentAIOps[\\/]task-state)[\\/]([1-9][0-9]*(?:-[A-Za-z0-9_-]+)?)(?=[\\/]|['"\s;)\]}]|$)/giu

export function taskArtifactPaths (tasks) {
  const ids = new Set(tasks.map(task => task.id))
  const paths = new Set()
  for (const task of tasks) {
    const plan = task.plan
    if (!plan) continue
    const reference = [...(plan.modifiedFiles ?? []), ...(plan.commands ?? []).map(command => command.command), ...(plan.revertCommands ?? []).map(command => command.command)].filter(value => typeof value === 'string').join('\n')
    for (const pattern of [UNIX, WINDOWS]) {
      for (const match of reference.matchAll(pattern)) {
        if (ids.has(Number(match[1].split('-')[0]))) paths.add(match[0].replaceAll('\\', '/'))
      }
    }
  }
  if (paths.size > 32) throw new Error('Too many task artifact directories; inspect this task manually')
  return [...paths].sort()
}

export function validateArtifactPaths (paths, platform) {
  if (!Array.isArray(paths) || paths.length > 32 || paths.some(path => typeof path !== 'string' || !(platform === 'windows' ? /^C:\/ProgramData\/(?:WebminAI\/Tasks|IntentAIOps\/task-state)\/[1-9][0-9]*(?:-[A-Za-z0-9_-]+)?$/iu : /^\/var\/(?:lib|db)\/(?:webminai|intentaiops)\/task-state\/[1-9][0-9]*(?:-[A-Za-z0-9_-]+)?$/u).test(path))) throw new Error('Unsafe task artifact directory')
}

function unixCheck (path) {
  return `p='${path}'
if [ -L "$p" ]; then exit 78; fi
parent="$p"
while [ "$parent" != / ]; do
  if [ -L "$parent" ]; then
    case "$(uname -s):$parent:$(readlink "$parent")" in Darwin:/var:private/var|Darwin:/var:/private/var) ;; *) exit 78;; esac
  fi
  parent=$(dirname "$parent")
done
test -d "$p"
case "$(uname -s)" in
  Linux)
    test -r /proc/self/mountinfo
    if awk -v p="$p" '$5 == p || index($5, p "/") == 1 {found=1} END {exit !found}' /proc/self/mountinfo; then exit 78; fi
    identity=$(stat -c '%d:%i:%Y' "$p") ;;
  FreeBSD|Darwin)
    physical=$(CDPATH= cd -P "$p" && pwd)
    mounts=$(mount)
    if printf '%s\\n' "$mounts" | grep -F " on $physical" >/dev/null; then exit 78; fi
    identity=$(stat -f '%d:%i:%m' "$p") ;;
  *) exit 78 ;;
esac
kb=$(du -skx "$p" | awk '{print $1}')
case "$kb" in ''|*[!0-9]*) exit 78;; esac`
}

function windowsCheck (path) {
  return `$p='${path}';$entry=Get-Item -LiteralPath $p -Force -ErrorAction Stop
for($parent=$entry;$parent;$parent=$parent.Parent){if($parent.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse point refused'}}
if(-not $entry.PSIsContainer){throw 'Not a directory'}
if(Get-ChildItem -LiteralPath $p -Force -Recurse -Attributes ReparsePoint -ErrorAction Stop | Select-Object -First 1){throw 'Nested reparse point refused'}
$bytes=[long](Get-ChildItem -LiteralPath $p -Force -Recurse -File -ErrorAction Stop | Measure-Object Length -Sum).Sum
$identity=('{0}:{1}' -f $entry.CreationTimeUtc.Ticks,$entry.LastWriteTimeUtc.Ticks)`
}

export function artifactUsageCommand (paths, platform) {
  validateArtifactPaths(paths, platform)
  if (platform === 'windows') return powershellCommand(`$ErrorActionPreference='Stop';$rows=@();${paths.map(path => `if(Test-Path -LiteralPath '${path}'){${windowsCheck(path)};$rows+=@{path=$p;bytes=$bytes;identity=$identity}}`).join(';')};ConvertTo-Json -InputObject @($rows) -Compress`)
  return `set -eu\n${paths.map((path, index) => `if [ -e '${path}' ] || [ -L '${path}' ]; then\n${unixCheck(path)}\nprintf '${index} %s %s\\n' "$kb" "$identity"\nfi`).join('\n')}`
}

export function parseArtifactUsage (stdout, paths, platform) {
  let entries
  if (platform === 'windows') entries = JSON.parse(stdout)
  else {
    entries = stdout.trim()
      ? stdout.trim().split('\n').map(line => {
        const match = line.match(/^([0-9]+) ([0-9]+) ([0-9]+:[0-9]+:[0-9]+)$/u)
        if (!match || !paths[Number(match[1])]) throw new Error('Invalid task storage response')
        return { path: paths[Number(match[1])], bytes: Number(match[2]) * 1024, identity: match[3] }
      })
      : []
  }
  if (!Array.isArray(entries) || entries.length > paths.length || entries.some(entry => !entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['path', 'bytes', 'identity'].includes(key)) || !paths.includes(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || typeof entry.identity !== 'string' || !/^[0-9:]{1,100}$/u.test(entry.identity)) || new Set(entries.map(entry => entry.path)).size !== entries.length) throw new Error('Invalid task storage response')
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

export function artifactRemovalCommand (entries, platform) {
  validateArtifactPaths(entries.map(entry => entry.path), platform)
  if (entries.some(entry => !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[0-9:]{1,100}$/u.test(entry.identity))) throw new Error('Invalid cleanup precondition')
  if (platform === 'windows') return powershellCommand(`$ErrorActionPreference='Stop';${entries.map(entry => `${windowsCheck(entry.path)};if($identity -ne '${entry.identity}' -or $bytes -ne ${entry.bytes}){throw 'Task storage changed'};Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop`).join(';')}`)
  return `set -eu\n${entries.map(entry => `${unixCheck(entry.path)}\ntest "$identity" = '${entry.identity}'\ntest "$kb" = '${entry.bytes / 1024}'\nfind "$p" -xdev -depth -delete\ntest ! -e "$p"`).join('\n')}`
}
