export function n8nRecoveryBaselineCommand (taskId, family) {
  const packages = {
    debian: `dpkg-query -W -f='${'$'}{binary:Package}\\t${'$'}{Version}\\t${'$'}{db:Status-Abbrev}\\n'`,
    alpine: 'apk info -v',
    arch: 'pacman -Q',
    rhel: "rpm -qa --qf '%{NAME}:%{EPOCHNUM}:%{VERSION}-%{RELEASE}:%{ARCH}\\n'",
    suse: "rpm -qa --qf '%{NAME}:%{EPOCHNUM}:%{VERSION}-%{RELEASE}:%{ARCH}\\n'"
  }
  if (!Object.hasOwn(packages, family)) throw new Error('Native n8n recovery requires an audited package family')
  return [
    'set -eu', '[ "$(id -u)" -eq 0 ]', 'export LC_ALL=C',
    `state='/var/lib/webminai/task-state/${taskId}-n8n-linux'`,
    'safe_parent () { current=$' + '{1%/*}; while [ "$current" != / ]; do [ ! -L "$current" ]; [ "$(find "$current" -prune -type d -user root ! -perm -0020 ! -perm -0002 -print)" = "$current" ]; current=$' + '{current%/*}; [ -n "$current" ] || current=/; done; }',
    'safe_parent "$state"', '[ ! -L "$state" ]',
    '[ "$(find "$state" -prune -type d -user root -perm 0700 -print)" = "$state" ]',
    'evidence=$(stat -c \'%d:%i:%u:%g:%a\' "$state")',
    'file_digest () { file=$1; safe_parent "$file"; [ ! -L "$file" ]; [ "$(find "$file" -prune -type f -links 1 -user root ! -perm -0020 ! -perm -0002 -print)" = "$file" ]; [ "$(wc -c < "$file")" -le 1048576 ]; identity=$(stat -c \'%d:%i:%u:%g:%a:%s\' "$file"); digest=$(openssl dgst -sha256 "$file"); evidence="$evidence\n$file\n$identity\n$digest"; }',
    'file_digest "$state/packages.before"', '[ -s "$state/packages.before" ]',
    "awk '$0 !~ /^[A-Za-z0-9][A-Za-z0-9+_.:-]*$/ { exit 1 }' \"$state/packages.before\"",
    'for name in nginx.active nginx.enabled user-created created-runtime-directory repo-0.existed repo-1.existed repo-2.existed repo-3.existed; do',
    'file="$state/$name"; [ ! -L "$file" ]; if [ -e "$file" ]; then file_digest "$file"; [ ! -s "$file" ]; else evidence="$evidence\n$name=absent"; fi', 'done',
    'safe_parent "$state/repo-backup"', '[ ! -L "$state/repo-backup" ]',
    '[ "$(find "$state/repo-backup" -prune -type d -user root -perm 0700 -print)" = "$state/repo-backup" ]',
    'for index in 0 1 2 3; do file="$state/repo-backup/$index"; [ ! -L "$file" ]; if [ -e "$state/repo-$index.existed" ]; then file_digest "$file"; else [ ! -e "$file" ]; fi; done',
    'for directory in /opt/webminai-n8n-18109 /var/lib/webminai-n8n-18109 /root/n8n_credentials; do',
    'safe_parent "$directory"', '[ ! -L "$directory" ]', '[ -d "$directory" ]',
    "awk -v root=\"$directory\" '$5 == root || index($5, root \"/\") == 1 { found=1 } END { exit found ? 1 : 0 }' /proc/self/mountinfo",
    'identity=$(stat -c \'%d:%i:%u:%g:%a\' "$directory")', 'evidence="$evidence\n$directory\n$identity"', 'done',
    '[ "$(stat -c %u /opt/webminai-n8n-18109)" -eq 0 ]',
    '[ "$(find /opt/webminai-n8n-18109 -prune ! -perm -0020 ! -perm -0002 -print)" = /opt/webminai-n8n-18109 ]',
    '[ "$(stat -c %u /root/n8n_credentials)" -eq 0 ]', '[ "$(stat -c %a /root/n8n_credentials)" = 700 ]',
    'account=$(getent passwd webminai-n8n)', 'evidence="$evidence\n$account"',
    '[ "$(stat -c %u /var/lib/webminai-n8n-18109)" = "$(id -u webminai-n8n)" ]',
    '[ "$(stat -c %a /var/lib/webminai-n8n-18109)" = 700 ]',
    'for file in /opt/webminai-n8n-18109/package.json /opt/webminai-n8n-18109/.webminai-npm-complete /etc/systemd/system/webminai-n8n-18109.service /etc/init.d/webminai-n8n-18109 /etc/nginx/sites-available/webminai-n8n-18109.conf /etc/nginx/conf.d/webminai-n8n-18109.conf /etc/nginx/http.d/webminai-n8n-18109.conf /etc/nginx/vhosts.d/webminai-n8n-18109.conf; do [ ! -L "$file" ]; if [ -e "$file" ]; then file_digest "$file"; else evidence="$evidence\n$file=absent"; fi; done',
    'for file in /usr/share/keyrings/nodesource.gpg /etc/apt/sources.list.d/nodesource.sources /etc/apt/preferences.d/nodejs /etc/apt/preferences.d/nsolid /etc/yum.repos.d/nodesource-nodejs.repo /etc/pki/rpm-gpg/NODESOURCE-NSOLID-GPG-SIGNING-KEY-EL /etc/nginx/nginx.conf; do [ ! -L "$file" ]; if [ -e "$file" ]; then file_digest "$file"; else evidence="$evidence\n$file=absent"; fi; done',
    `packages=$(${packages[family]})`,
    '[ -n "$packages" ]', 'packages=$(printf \'%s\\n\' "$packages" | sort)', 'evidence="$evidence\n$packages"',
    'printf \'%s\\n\' "$evidence" | openssl dgst -sha256'
  ].join('\n')
}
