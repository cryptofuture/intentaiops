#!/bin/sh
set -eu
LC_ALL=C; PATH=/usr/bin:/bin:/usr/sbin:/sbin; export LC_ALL PATH
operation=$1
root=/private/var/db/intentaiops-enrollment
file=$root/host-id
test "$(uname -s)" = Darwin
safe_entry() {
  test ! -L "$1" || return 1
  test "$(stat -f %u "$1")" = 0 || return 1
  mode=$(stat -f %Lp "$1") || return 1
  test "$((0$mode & 0022))" = 0 || return 1
  permissions=$(ls -lde "$1") || return 1
  if printf '%s\n' "$permissions" | grep -Eq '^[[:space:]]*[0-9]+: .* allow '; then return 1; fi
}
for parent in / /private /private/var /private/var/db; do safe_entry "$parent"; test -d "$parent"; test -x "$parent"; done
uuid_valid() { printf '%s' "$1" | grep -Eq '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' && test "$1" != 00000000-0000-0000-0000-000000000000; }
read_id() {
  test ! -L "$root" || return 1
  if [ ! -e "$root" ]; then printf 'MISSING\n'; return; fi
  safe_entry "$root" && test -d "$root" || return 1
  mode=$(stat -f %Lp "$root") || return 1
  test "$((0$mode & 0001))" = 1 || return 1
  test ! -L "$file" || return 1
  if [ ! -e "$file" ]; then printf 'MISSING\n'; return; fi
  safe_entry "$file" && test -f "$file" || return 1
  test "$(stat -f %l "$file")" = 1 || return 1
  mode=$(stat -f %Lp "$file") || return 1
  test "$((0$mode & 0004))" = 4 || return 1
  test "$(stat -f %z "$file")" -le 128 || return 1
  value=$(cat "$file") || return 1
  identifier=${value#intentaiops-host-enrollment-v1:}
  test "$value" = "intentaiops-host-enrollment-v1:$identifier" || return 1
  uuid_valid "$identifier" || return 1
  printf '%s\n' "$identifier"
}
case "$operation" in
  read) read_id; exit ;;
  replace) ;;
  *) exit 78 ;;
esac
test "$(id -u)" = 0
next=$2; previous=$3; native=$4
uuid_valid "$next"
if [ "$previous" != MISSING ]; then uuid_valid "$previous"; test "$next" != "$previous"; fi
current_native() { ioreg -rd1 -c IOPlatformExpertDevice | sed -n 's/.*IOPlatformUUID.*= *"\([^"]*\)".*/\1/p'; }
test "$(current_native)" = "$native"
if [ ! -e "$root" ]; then mkdir -m 0755 "$root" || test -d "$root"; fi
safe_entry "$root"
lock=$root/.write-lock
mkdir -m 0700 "$lock"
trap 'rm -f -- "$lock/identifier"; rmdir "$lock"' 0
trap 'exit 1' HUP INT TERM
test "$(read_id)" = "$previous"
test "$(current_native)" = "$native"
printf 'intentaiops-host-enrollment-v1:%s\n' "$next" > "$lock/identifier"
chown 0:0 "$lock/identifier"
chmod 0444 "$lock/identifier"
mv -f -- "$lock/identifier" "$file"
sync
test "$(read_id)" = "$next"
printf 'INTENTAI_OPS_HOST_ENROLLED\n'
