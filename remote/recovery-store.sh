#!/bin/sh
set -eu
umask 077
LC_ALL=C
export LC_ALL

operation=$1
platform=$2
case "$platform" in
  linux) root=/var/lib/intentaiops/recovery ;;
  freebsd) root=/var/db/intentaiops/recovery ;;
  macos) root=/private/var/db/intentaiops/recovery ;;
  *) exit 1 ;;
esac

safe_directory() {
  [ ! -L "$1" ] && [ "$(find "$1" -prune -type d -user root ! -perm -0020 ! -perm -0002 -print)" = "$1" ]
}

private_file() {
  [ ! -L "$1" ] && [ "$(find "$1" -prune -type f -links 1 -user root -perm 0600 -print)" = "$1" ] || return 1
  [ "$(wc -c < "$1")" -le 8192 ]
}

[ "$(id -u)" -eq 0 ]
command -v openssl >/dev/null
case "$operation" in
  key|list|read|verification-key|ownership) [ -e "$root" ] || { printf '{"available":false}\n'; exit 0; } ;;
  initialize|claim|append|release|rotate-key|takeover) ;;
  *) exit 1 ;;
esac

parent=${root%/*}
ancestor=${parent%/*}
safe_directory "${ancestor%/*}"
safe_directory "$ancestor"
current=${ancestor%/*}
while [ "$current" != / ]; do
  safe_directory "$current"
  current=${current%/*}
  [ -n "$current" ] || current=/
done
case "$operation" in
  initialize|claim|append|release|rotate-key|takeover)
    [ -e "$parent" ] || mkdir -m 0700 "$parent" || test -d "$parent"
    safe_directory "$parent"
    [ -e "$root" ] || mkdir -m 0700 "$root" || test -d "$root"
    ;;
esac
safe_directory "$parent"
safe_directory "$root"
[ "$(find "$root" -prune -type d -perm 0700 -print)" = "$root" ]

case "$operation" in
  initialize|claim|append|release|rotate-key|takeover)
    attempts=0
    until mkdir -m 0700 "$root/.write-lock" 2>/dev/null; do
      attempts=$((attempts + 1))
      [ "$attempts" -lt 50 ] || { printf 'recovery storage is busy or requires stale-lock investigation\n' >&2; exit 1; }
      sleep 0.05
    done
    trap 'rm -f -- "$root/.write-lock/payload" "$root/.write-lock/signature" "$root/.write-lock/record" "$root/.write-lock/head" "$root/.write-lock/key" "$root/.write-lock/public" "$root/.write-lock/old-public" "$root/.write-lock/rotation" "$root/.write-lock/owner"; rmdir "$root/.write-lock"' EXIT
    trap 'exit 1' HUP INT TERM
    ;;
esac

if [ "$operation" = initialize ] && [ ! -e "$root/signing.pem" ]; then
  test ! -L "$root/signing.pem"
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$root/.write-lock/key" 2>/dev/null
  chmod 0600 "$root/.write-lock/key"
  sync
  mv "$root/.write-lock/key" "$root/signing.pem"
  sync
fi
private_file "$root/signing.pem"

if [ "$operation" = rotate-key ]; then
  expected=$3
  target=$4
  case "$expected" in ''|*[!a-f0-9]*) exit 1 ;; esac
  [ "${#expected}" -eq 64 ]
  case "$target" in SHA256:*) identity=${target#SHA256:} ;; *) exit 1 ;; esac
  case "$identity" in ''|*[!a-f0-9]*) exit 1 ;; esac
  [ "${#identity}" -eq 64 ]
  for execution in "$root"/????????????????????????????????; do
    [ -e "$execution" ] || continue
    safe_directory "$execution"
    [ ! -e "$execution/owner" ]; [ ! -L "$execution/owner" ]
  done
  openssl pkey -in "$root/signing.pem" -pubout -outform DER -out "$root/.write-lock/old-public" 2>/dev/null
  actual=$(openssl dgst -sha256 "$root/.write-lock/old-public" | awk '{print $NF}')
  [ "$actual" = "$expected" ]
  [ -e "$root/keys" ] || mkdir -m 0700 "$root/keys"
  safe_directory "$root/keys"
  [ "$(find "$root/keys" -prune -type d -perm 0700 -print)" = "$root/keys" ]
  test ! -e "$root/keys/$expected.der"; test ! -L "$root/keys/$expected.der"
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$root/.write-lock/key" 2>/dev/null
  openssl pkey -in "$root/.write-lock/key" -pubout -outform DER -out "$root/.write-lock/public" 2>/dev/null
  next_key=$(openssl dgst -sha256 "$root/.write-lock/public" | awk '{print $NF}')
  public=$(openssl base64 -A -in "$root/.write-lock/public")
  rotation_id=$(openssl rand -hex 16)
  observed=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
  printf '{"newFingerprint":"%s","newPublicKey":"%s","observedAt":"%s","oldFingerprint":"%s","rotationId":"%s","target":"%s","version":1}' "$next_key" "$public" "$observed" "$expected" "$rotation_id" "$target" > "$root/.write-lock/rotation"
  printf 'intentaiops.remote-common-task.key-rotation.v1\n' > "$root/.write-lock/payload"
  cat "$root/.write-lock/rotation" >> "$root/.write-lock/payload"
  openssl dgst -sha256 -sign "$root/signing.pem" -out "$root/.write-lock/signature" "$root/.write-lock/payload"
  signature=$(openssl base64 -A -in "$root/.write-lock/signature" | tr '+/' '-_' | tr -d '=')
  payload=$(openssl base64 -A -in "$root/.write-lock/rotation" | tr '+/' '-_' | tr -d '=')
  printf '{"algorithm":"ECDSA-P256-SHA256","format":"intentaiops-recovery-key-rotation","keyFingerprint":"%s","payload":"%s","signature":"%s","version":1}' "$expected" "$payload" "$signature" > "$root/.write-lock/record"
  test ! -e "$root/keys/$next_key.rotation.json"; test ! -L "$root/keys/$next_key.rotation.json"
  sync
  mv "$root/.write-lock/old-public" "$root/keys/$expected.der"
  mv "$root/.write-lock/record" "$root/keys/$next_key.rotation.json"
  sync
  mv "$root/.write-lock/key" "$root/signing.pem"
  sync
  operation=key
fi

case "$operation" in
  key|initialize)
    public=$(openssl pkey -in "$root/signing.pem" -pubout -outform DER 2>/dev/null | openssl base64 -A)
    fingerprint=$(openssl pkey -in "$root/signing.pem" -pubout -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')
    printf '{"available":true,"publicKey":"%s"' "$public"
    if [ -e "$root/keys/$fingerprint.rotation.json" ]; then
      safe_directory "$root/keys"
      private_file "$root/keys/$fingerprint.rotation.json"
      printf ',"rotation":'
      cat "$root/keys/$fingerprint.rotation.json"
    fi
    printf '}\n'
    exit 0
    ;;
  verification-key)
    fingerprint=$3
    case "$fingerprint" in ''|*[!a-f0-9]*) exit 1 ;; esac
    [ "${#fingerprint}" -eq 64 ]
    safe_directory "$root/keys"
    private_file "$root/keys/$fingerprint.der"
    public=$(openssl base64 -A -in "$root/keys/$fingerprint.der")
    printf '{"available":true,"publicKey":"%s"}\n' "$public"
    exit 0
    ;;
  list)
    after=$3
    case "$after" in *[!a-f0-9]*) exit 1 ;; esac
    [ -z "$after" ] || [ "${#after}" -eq 32 ]
    printf '{"executions":['
    separator= count=0
    for directory in "$root"/????????????????????????????????; do
      test -e "$directory" || continue
      safe_directory "$directory"
      name=${directory##*/}
      case "$name" in *[!a-f0-9]*) exit 1 ;; esac
      [ -z "$after" ] || [ "$name" \> "$after" ] || continue
      private_file "$directory/head"
      IFS=' ' read -r sequence head < "$directory/head"
      case "$sequence" in ''|*[!0-9]*) exit 1 ;; esac
      case "$head" in *[!a-f0-9]*) exit 1 ;; esac
      [ "${#head}" -eq 64 ]
      printf '%s{"executionId":"%s","sequence":%s,"head":"%s"}' "$separator" "$name" "$sequence" "$head"
      separator=, count=$((count + 1))
      [ "$count" -lt 10 ] || break
    done
    printf ']}\n'
    exit 0
    ;;
esac

execution=$3
sequence=$4
case "$execution" in ''|*[!a-f0-9]*) exit 1 ;; esac
[ "${#execution}" -eq 32 ]
case "$sequence" in ''|*[!0-9]*) exit 1 ;; esac
[ "$sequence" -le 100000 ]
directory=$root/$execution

if [ "$operation" = read ]; then
  [ "$sequence" -gt 0 ]
  safe_directory "$directory"
  private_file "$directory/$sequence.json"
  [ "$(wc -c < "$directory/$sequence.json")" -le 8192 ]
  cat "$directory/$sequence.json"
  exit 0
fi

head=$5
case "$head" in -) [ "$sequence" -eq 0 ] ;; *[!a-f0-9]*) exit 1 ;; *) [ "${#head}" -eq 64 ]; [ "$sequence" -gt 0 ] ;; esac
if [ "$operation" = ownership ]; then
  safe_directory "$directory"
  private_file "$directory/head"
  [ "$(cat "$directory/head")" = "$sequence $head" ]
  if [ -e "$directory/owner" ]; then
    private_file "$directory/owner"
    fingerprint=$(openssl dgst -sha256 "$directory/owner" | awk '{print $NF}')
    printf '{"owned":true,"ownerFingerprint":"%s"}\n' "$fingerprint"
  else
    test ! -L "$directory/owner"
    printf '{"owned":false,"ownerFingerprint":null}\n'
  fi
  exit 0
fi
owner=$6
case "$owner" in ''|*[!a-f0-9]*) exit 1 ;; esac
[ "${#owner}" -eq 32 ]

if [ "$operation" = claim ] && [ ! -e "$directory" ]; then
  task=$7
  case "$task" in ''|*[!0-9]*) exit 1 ;; esac
  [ "$task" -gt 0 ]; [ "$task" -le 2147483647 ]; [ "$sequence" -eq 0 ]
  test ! -e "$root/task-$task"; test ! -L "$root/task-$task"
  mkdir -m 0700 "$directory"
  printf '%s' "$execution" > "$root/task-$task"
fi
safe_directory "$directory"
if [ -e "$directory/head" ]; then
  private_file "$directory/head"
  actual=$(cat "$directory/head")
else
  actual='0 -'
fi
[ "$actual" = "$sequence $head" ]

if [ "$operation" = takeover ]; then
  expected_owner=$7
  case "$expected_owner" in ''|*[!a-f0-9]*) exit 1 ;; esac
  [ "${#expected_owner}" -eq 64 ]
  private_file "$directory/owner"
  actual_owner=$(openssl dgst -sha256 "$directory/owner" | awk '{print $NF}')
  [ "$actual_owner" = "$expected_owner" ]
  printf '%s' "$owner" > "$root/.write-lock/owner"
  sync
  mv "$root/.write-lock/owner" "$directory/owner"
  sync
  printf '{"claimed":true}\n'
  exit 0
fi

if [ "$operation" = claim ]; then
  if [ -e "$directory/owner" ]; then
    private_file "$directory/owner"
    [ "$(cat "$directory/owner")" = "$owner" ]
  else
    test ! -L "$directory/owner"
    printf '%s' "$owner" > "$directory/owner"
  fi
  sync
  printf '{"claimed":true}\n'
  exit 0
fi
private_file "$directory/owner"
[ "$(cat "$directory/owner")" = "$owner" ]
if [ "$operation" = release ]; then
  rm -- "$directory/owner"
  sync
  printf '{"released":true}\n'
  exit 0
fi

[ "$operation" = append ]
fingerprint=$7
payload=$8
signing=$9
case "$fingerprint" in ''|*[!a-f0-9]*) exit 1 ;; esac
[ "${#fingerprint}" -eq 64 ]
case "$payload" in ''|*[!A-Za-z0-9_-]*) exit 1 ;; esac
case "$signing" in ''|*[!A-Za-z0-9+/=]*) exit 1 ;; esac
[ "${#payload}" -le 5500 ]; [ "${#signing}" -le 5600 ]
actual_key=$(openssl pkey -in "$root/signing.pem" -pubout -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')
[ "$actual_key" = "$fingerprint" ]
printf '%s' "$signing" | openssl base64 -d -A > "$root/.write-lock/payload"
openssl dgst -sha256 -sign "$root/signing.pem" -out "$root/.write-lock/signature" "$root/.write-lock/payload"
signature=$(openssl base64 -A -in "$root/.write-lock/signature" | tr '+/' '-_' | tr -d '=')
printf '{"algorithm":"ECDSA-P256-SHA256","format":"intentaiops-remote-recovery","keyFingerprint":"%s","payload":"%s","signature":"%s","version":1}' "$fingerprint" "$payload" "$signature" > "$root/.write-lock/record"
next=$((sequence + 1))
test ! -e "$directory/$next.json"; test ! -L "$directory/$next.json"
sync
mv "$root/.write-lock/record" "$directory/$next.json"
sync
hash=$(openssl dgst -sha256 "$directory/$next.json" | awk '{print $NF}')
printf '%s %s\n' "$next" "$hash" > "$root/.write-lock/head"
sync
mv "$root/.write-lock/head" "$directory/head"
sync
cat "$directory/$next.json"
