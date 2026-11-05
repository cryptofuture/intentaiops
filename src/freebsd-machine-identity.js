import { createHash, randomUUID } from 'node:crypto'

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const fingerprint = uuid => `SHA256:${createHash('sha256').update(`freebsd:${uuid}`).digest('hex')}`

export function freebsdHostIdChangeScript (previous, next) {
  if (!UUID.test(previous) || !UUID.test(next) || previous === next || next === '00000000-0000-0000-0000-000000000000') throw new Error('Invalid FreeBSD host UUID replacement')
  return `set -eu
PATH=/sbin:/bin:/usr/sbin:/usr/bin; export PATH
test "$(uname -s)" = FreeBSD
test "$(id -u)" = 0
test "$(/sbin/sysctl -n security.jail.jailed)" = 0
test "$(/sbin/sysctl -n kern.securelevel)" -le 0
test "$(/sbin/sysctl -n kern.hostuuid)" = '${previous}'
for tool in /usr/sbin/service /sbin/md5 /etc/rc.d/hostid /etc/rc.d/hostid_save; do test -x "$tool"; done
test ! -L /etc
for p in /etc/hostid /etc/machine-id; do
  test ! -L "$p"
  if [ -e "$p" ]; then
    test -f "$p"
    set -- $(stat -f '%u %Lp %l' "$p")
    test "$1" = 0 && test "$3" = 1 && test "$((0$2 & 0022))" = 0
  fi
done
mounts=$(/sbin/mount -p)
if printf '%s\\n' "$mounts" | awk '$2 == "/etc/hostid" || $2 == "/etc/machine-id" {found=1} END {exit !found}'; then exit 78; fi
if printf '%s\\n' "$mounts" | awk '$3 == "zfs" {found=1} END {exit !found}' || /sbin/sysctl -N kstat.zfs >/dev/null 2>&1; then
  command -v zpool >/dev/null
  pools=$(zpool list -H -o name)
  if [ -n "$pools" ]; then printf '%s\\n' 'Imported ZFS pools require a separate reviewed host-identity procedure' >&2; exit 78; fi
fi
check_config() (
  set +eu
  . /etc/rc.subr || exit 78
  name=$1
  load_rc_config "$name" || exit 78
  test "\${hostid_file:-}" = /etc/hostid || exit 78
  test "\${machine_id_file:-}" = /etc/machine-id || exit 78
  checkyesno hostid_enable || exit 78
)
check_config hostid
check_config hostid_save
if [ -e /etc/hostid ]; then test "$(tr -d '[:space:]' < /etc/hostid)" = '${previous}'; fi
if [ -e /etc/machine-id ]; then test "$(tr -d '[:space:]' < /etc/machine-id)" = '${previous.replaceAll('-', '')}'; fi
umask 077
lock=/etc/.intentaiops-hostid.lock
mkdir -m 700 "$lock"
host_tmp=''; machine_tmp=''
trap 'if [ -n "$host_tmp" ]; then rm -f -- "$host_tmp"; fi; if [ -n "$machine_tmp" ]; then rm -f -- "$machine_tmp"; fi; rmdir "$lock"' 0
prepare() {
  source=$1; destination=$2; value=$3
  owner=0; group=0; mode=444
  if [ -e "$source" ]; then set -- $(stat -f '%u %g %Lp' "$source"); owner=$1; group=$2; mode=$3; fi
  printf '%s\\n' "$value" > "$destination"
  chown "$owner:$group" "$destination"
  chmod "$mode" "$destination"
}
host_tmp=$(mktemp /etc/.intentaiops-hostid.XXXXXXXX)
machine_tmp=$(mktemp /etc/.intentaiops-machine-id.XXXXXXXX)
prepare /etc/hostid "$host_tmp" '${next}'
prepare /etc/machine-id "$machine_tmp" '${next.replaceAll('-', '')}'
test "$(/sbin/sysctl -n kern.hostuuid)" = '${previous}'
mv -f -- "$host_tmp" /etc/hostid; host_tmp=''
mv -f -- "$machine_tmp" /etc/machine-id; machine_tmp=''
/usr/sbin/service hostid onestart >/dev/null
/usr/sbin/service hostid_save onestart >/dev/null
test "$(/sbin/sysctl -n kern.hostuuid)" = '${next}'
digest=$(printf '%s' '${next}' | /sbin/md5)
expected_hostid="0x$(printf '%.8s' "$digest")"
test "$(/sbin/sysctl -n kern.hostid)" = "$((expected_hostid))"
test "$(tr -d '[:space:]' < /etc/hostid)" = '${next}'
test "$(tr -d '[:space:]' < /etc/machine-id)" = '${next.replaceAll('-', '')}'
sync
printf '%s\\n' 'WEBMINAI_FREEBSD_HOST_ID_CHANGED'
`
}

export async function replaceFreeBsdHostId ({ ssh, connectionUrl, expectedFingerprint, runElevated }) {
  if (await ssh.hostFingerprint(connectionUrl) !== expectedFingerprint) throw new Error('Remote machine identity changed before confirmation; no FreeBSD host UUID was replaced')
  const observed = await ssh.execute(connectionUrl, 'test "$(uname -s)" = FreeBSD && /sbin/sysctl -n kern.hostuuid', { timeoutMs: 15000 })
  const previous = observed.stdout.trim()
  if (!UUID.test(previous) || fingerprint(previous) !== expectedFingerprint) throw new Error('FreeBSD host identity cannot be safely matched; no host UUID was replaced')
  const next = randomUUID()
  try {
    const result = await runElevated(freebsdHostIdChangeScript(previous, next))
    if (result.code !== 0 || result.stdout.trim() !== 'WEBMINAI_FREEBSD_HOST_ID_CHANGED') throw new Error('FreeBSD host UUID update was not acknowledged')
    const confirmed = await ssh.hostFingerprint(connectionUrl)
    if (confirmed !== fingerprint(next)) throw new Error('New FreeBSD host identity could not be verified')
    return confirmed
  } catch {
    throw new Error('FreeBSD host UUID replacement was not confirmed. Inspect kern.hostuuid, kern.hostid, /etc/hostid, /etc/machine-id and /etc/.intentaiops-hostid.lock before retrying; no automatic retry was performed')
  }
}
