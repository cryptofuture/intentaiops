import { createHash, randomUUID } from 'node:crypto'

export function linuxMachineIdChangeScript (previous, next) {
  if (!/^[a-f0-9]{32}$/iu.test(previous) || !/^[a-f0-9]{32}$/u.test(next) || previous.toLowerCase() === next || /^0+$/u.test(next)) throw new Error('Invalid machine ID replacement')
  return `set -eu
test "$(uname -s)" = Linux
test "$(id -u)" = 0
for parent in /etc /var /var/lib; do test ! -L "$parent"; done
test -f /etc/machine-id && test ! -L /etc/machine-id
test "$(tr -d '[:space:]' < /etc/machine-id)" = '${previous}'
test -r /proc/self/mountinfo
if awk '$5 == "/etc/machine-id" || $5 == "/var/lib/dbus/machine-id" {found=1} END {exit !found}' /proc/self/mountinfo; then exit 78; fi
dbus=no
if [ -L /var/lib/dbus ]; then exit 78; fi
if [ -L /var/lib/dbus/machine-id ]; then
  test "$(readlink -f /var/lib/dbus/machine-id)" = /etc/machine-id
elif [ -e /var/lib/dbus/machine-id ]; then
  test -f /var/lib/dbus/machine-id
  test "$(tr -d '[:space:]' < /var/lib/dbus/machine-id)" = '${previous}'
  dbus=yes
fi
main_tmp=''; dbus_tmp=''
umask 077
lock=/etc/.intentaiops-machine-id.lock
mkdir -m 700 "$lock"
trap 'if [ -n "$main_tmp" ]; then rm -f -- "$main_tmp"; fi; if [ -n "$dbus_tmp" ]; then rm -f -- "$dbus_tmp"; fi; rmdir "$lock"' 0
prepare() {
  source=$1; destination=$2
  set -- $(stat -c '%u %g %a' "$source")
  test "$1" = 0
  test "$((0$3 & 0022))" = 0
  printf '%s\\n' '${next}' > "$destination"
  chown "$1:$2" "$destination"
  chmod "$3" "$destination"
  if [ -e /sys/fs/selinux/enforce ]; then chcon --reference="$source" "$destination"; fi
}
main_tmp=$(mktemp /etc/.intentaiops-machine-id.XXXXXXXX)
prepare /etc/machine-id "$main_tmp"
if [ "$dbus" = yes ]; then
  dbus_tmp=$(mktemp /var/lib/dbus/.intentaiops-machine-id.XXXXXXXX)
  prepare /var/lib/dbus/machine-id "$dbus_tmp"
fi
test "$(tr -d '[:space:]' < /etc/machine-id)" = '${previous}'
if [ "$dbus" = yes ]; then mv -f -- "$dbus_tmp" /var/lib/dbus/machine-id; dbus_tmp=''; fi
mv -f -- "$main_tmp" /etc/machine-id
main_tmp=''
sync
printf '%s\\n' 'WEBMINAI_MACHINE_ID_CHANGED'
`
}

export async function replaceLinuxMachineId ({ ssh, connectionUrl, expectedFingerprint, runElevated }) {
  if (await ssh.hostFingerprint(connectionUrl) !== expectedFingerprint) throw new Error('Remote machine identity changed before confirmation; no machine ID was replaced')
  const observed = await ssh.execute(connectionUrl, 'test "$(uname -s)" = Linux && test ! -L /etc/machine-id && tr -d \'[:space:]\' < /etc/machine-id', { timeoutMs: 15000 })
  const previous = observed.stdout.trim()
  if (!/^[a-f0-9]{32}$/iu.test(previous) || `SHA256:${createHash('sha256').update(`linux:${previous}`).digest('hex')}` !== expectedFingerprint) throw new Error('Linux machine identity cannot be safely matched; no machine ID was replaced')
  const next = randomUUID().replaceAll('-', '')
  try {
    const result = await runElevated(linuxMachineIdChangeScript(previous, next))
    if (result.code !== 0 || result.stdout.trim() !== 'WEBMINAI_MACHINE_ID_CHANGED') throw new Error('Machine ID update was not acknowledged')
    const fingerprint = await ssh.hostFingerprint(connectionUrl)
    if (fingerprint !== `SHA256:${createHash('sha256').update(`linux:${next}`).digest('hex')}`) throw new Error('New machine identity could not be verified')
    return fingerprint
  } catch {
    throw new Error('Machine ID replacement was not confirmed. Inspect /etc/machine-id, /var/lib/dbus/machine-id and /etc/.intentaiops-machine-id.lock on this VPS before retrying; no automatic retry was performed')
  }
}
