export function recoveryBaselineCommand (catalogId, taskId) {
  if (!Number.isSafeInteger(taskId) || taskId < 1 || taskId > 2147483647) throw new Error('Invalid recovery baseline task identity')
  if (catalogId === 'intent-ai-ops-linux') return cliInstallBaselineCommand(taskId)
  const files = catalogId === 'systemd-service'
    ? ['/etc/systemd/system/webminai-test.service']
    : catalogId === 'systemd-timer'
      ? ['/etc/systemd/system/webminai-test-timer.service', '/etc/systemd/system/webminai-test.timer']
      : null
  if (!files) throw new Error('No audited remote recovery baseline profile for this common task')
  const state = `/var/lib/webminai/task-state/${taskId}-${catalogId}`
  return [
    'set -eu', '[ "$(id -u)" -eq 0 ]',
    'safe_parent () { current=$' + '{1%/*}; while [ "$current" != / ]; do [ ! -L "$current" ]; [ "$(find "$current" -prune -type d -user root ! -perm -0020 ! -perm -0002 -print)" = "$current" ]; current=$' + '{current%/*}; [ -n "$current" ] || current=/; done; }',
    `state=${quote(state)}`, 'safe_parent "$state"', '[ ! -L "$state" ]',
    '[ "$(find "$state" -prune -type d -user root -perm 0700 -print)" = "$state" ]',
    '[ "$(find "$state" -mindepth 1 -maxdepth 1 -printf \'%f\\n\')" = apply-complete ]',
    'for file in "$state/apply-complete" ' + files.map(quote).join(' ') + '; do',
    'safe_parent "$file"', '[ ! -L "$file" ]',
    '[ "$(find "$file" -prune -type f -links 1 -user root ! -perm -0020 ! -perm -0002 -print)" = "$file" ]',
    '[ "$(wc -c < "$file")" -le 16384 ]', 'done',
    'evidence=$(stat -c \'%d:%i:%u:%g:%a\' "$state")',
    'for file in "$state/apply-complete" ' + files.map(quote).join(' ') + '; do',
    'identity=$(stat -c \'%d:%i:%u:%g:%a:%s\' "$file")',
    'digest=$(openssl dgst -sha256 "$file")',
    'evidence="$evidence\n$identity\n$digest"', 'done',
    'printf \'%s\\n\' "$evidence" | openssl dgst -sha256'
  ].join('\n')
}

function cliInstallBaselineCommand (taskId) {
  const state = `/var/lib/webminai/tasks/${taskId}/intent-ai-ops-install`
  return [
    'set -eu', '[ "$(id -u)" -eq 0 ]',
    'safe_parent () { current=$' + '{1%/*}; while [ "$current" != / ]; do [ ! -L "$current" ]; [ "$(find "$current" -prune -type d -user root ! -perm -0020 ! -perm -0002 -print)" = "$current" ]; current=$' + '{current%/*}; [ -n "$current" ] || current=/; done; }',
    `state=${quote(state)}`, 'safe_parent "$state"', '[ ! -L "$state" ]',
    '[ "$(find "$state" -prune -type d -user root -perm 0700 -print)" = "$state" ]',
    'test -f "$state/baseline"',
    'for entry in "$state"/* "$state"/.[!.]* "$state"/..?*; do [ -e "$entry" ] || [ -L "$entry" ] || continue; name=$' + '{entry##*/}; case "$name" in baseline|command.before|preexisting|root.existed|owns-root|installed|install.sh|package.sha256|package.tgz|npm-cache) :;; *) exit 1;; esac; done',
    'evidence=$(stat -c \'%d:%i:%u:%g:%a\' "$state")',
    'for name in baseline command.before preexisting root.existed owns-root installed; do',
    'file="$state/$name"', '[ ! -L "$file" ]',
    'if [ -e "$file" ]; then',
    '[ "$(find "$file" -prune -type f -links 1 -user root -perm 0600 -print)" = "$file" ]',
    '[ "$(wc -c < "$file")" -le 4096 ]',
    'identity=$(stat -c \'%d:%i:%u:%g:%a:%s\' "$file")', 'digest=$(openssl dgst -sha256 "$file")',
    'evidence="$evidence\n$name\n$identity\n$digest"',
    'else evidence="$evidence\n$name=absent"; fi', 'done',
    'if [ -e "$state/owns-root" ]; then',
    '[ ! -e "$state/preexisting" ] && [ ! -e "$state/root.existed" ] && [ -e "$state/installed" ]',
    'root=/opt/intent-ai-ops', 'safe_parent "$root"', 'test -d "$root"', 'test ! -L "$root"',
    'size=$(du -sk --apparent-size "$root")', 'size=$' + '{size%%[[:space:]]*}', '[ "$size" -le 524288 ]',
    'count=$(find "$root" -xdev -printf .)', '[ "$' + '{#count}" -le 30000 ]',
    "unsafe=$(find \"$root\" -xdev '(' ! -user root -o '(' ! -type l '(' -perm -0020 -o -perm -0002 ')' ')' -o '(' ! -type d ! -type f ! -type l ')' -o '(' -type f ! -links 1 ')' ')' -print)", '[ -z "$unsafe" ]',
    'device=$(stat -c %d "$root")', 'devices=$(find "$root" -xdev -printf \'%D\\n\')', 'devices=$(printf \'%s\\n\' "$devices" | LC_ALL=C sort -u)', '[ "$devices" = "$device" ]',
    'find "$root" -xdev -exec sh -c \'for entry do case "$entry" in *[!a-zA-Z0-9_./@+,:=%-]*) exit 1;; esac; if [ -L "$entry" ]; then target=$(readlink "$entry"); case "$target" in *[!a-zA-Z0-9_./@+,:=%-]*) exit 1;; esac; fi; done\' sh {} +',
    'metadata=$(find "$root" -xdev -printf \'%y|%D:%i:%U:%G:%m:%s:%T@|%p|%l\\n\')',
    'sorted=$(printf \'%s\\n\' "$metadata" | LC_ALL=C sort)',
    'hashes=$(find "$root" -xdev -type f -exec openssl dgst -sha256 {} +)',
    'hashes=$(printf \'%s\\n\' "$hashes" | LC_ALL=C sort)',
    'evidence="$evidence\n$sorted\n$hashes"',
    'for file in /usr/local/bin/intentaiops /usr/local/bin/intentops; do',
    'safe_parent "$file"', '[ ! -L "$file" ]',
    '[ "$(find "$file" -prune -type f -links 1 -user root ! -perm -0020 ! -perm -0002 -print)" = "$file" ]',
    '[ "$(wc -c < "$file")" -le 4096 ]', 'identity=$(stat -c \'%d:%i:%u:%g:%a:%s\' "$file")', 'digest=$(openssl dgst -sha256 "$file")',
    'evidence="$evidence\n$identity\n$digest"', 'done', 'fi',
    'printf \'%s\\n\' "$evidence" | openssl dgst -sha256'
  ].join('\n')
}

export async function inspectRecoveryBaseline (client, catalogId, taskId) {
  const result = await client.runCommand(recoveryBaselineCommand(catalogId, taskId), { timeoutSeconds: 10 })
  if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated || Buffer.byteLength(result.stdout ?? '') > 256) throw new Error('Recovery baseline ownership or integrity inspection failed')
  const match = /^(?:SHA2?-?256\([^\n]*\)|SHA256|\(stdin\))?\s*=?\s*([a-f0-9]{64})\s*$/u.exec(result.stdout.trim())
  if (!match) throw new Error('Invalid recovery baseline digest')
  return match[1]
}

export function guardRecoveryBaseline (command, catalogId, taskId, digest) {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('Invalid expected recovery baseline digest')
  const probe = recoveryBaselineCommand(catalogId, taskId)
  const check = `observed=$(sh -c ${quote(probe)}); observed=\${observed##* }; [ "$observed" = ${quote(digest)} ] || { printf '%s\\n' 'RECOVERY_BASELINE_CHANGED' >&2; exit 1; }`
  return { ...command, command: `set -eu; ${check}; ${command.command}` }
}

function quote (value) { return "'" + String(value).replaceAll("'", "'\\''") + "'" }
