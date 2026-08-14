#!/bin/sh
set -eu

project_root=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
dist_directory="$project_root/dist"
manifest="$dist_directory/SHA256SUMS"
action=${1:-write}

digest_file() {
  file=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{ print $1 }'
  elif command -v sha256 >/dev/null 2>&1; then
    sha256 -q "$file"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{ print $1 }'
  else
    echo 'sha256sum, sha256, or shasum is required to create dist checksums' >&2
    exit 1
  fi
}

artifact_names() {
  for artifact in "$dist_directory"/webminai.plugin "$dist_directory"/webminai.plugin-*; do
    if [ -f "$artifact" ]; then
      basename "$artifact"
    fi
  done | LC_ALL=C sort -u
}

write_manifest() {
  mkdir -p "$dist_directory"
  temporary=$(mktemp "$dist_directory/.SHA256SUMS.XXXXXXXX")
  trap 'rm -f "$temporary"' EXIT INT TERM
  count=0
  artifact_names | while IFS= read -r name; do
    digest=$(digest_file "$dist_directory/$name")
    printf '%s  %s\n' "$digest" "$name"
  done > "$temporary"
  count=$(wc -l < "$temporary" | tr -d ' ')
  if [ "$count" -eq 0 ]; then
    echo 'no Intent AI Ops plugin artifacts were found in dist' >&2
    exit 1
  fi
  chmod 0644 "$temporary"
  mv -f "$temporary" "$manifest"
  trap - EXIT INT TERM
  printf 'Wrote %s checksums to %s\n' "$count" "$manifest"
}

verify_manifest() {
  if [ ! -f "$manifest" ]; then
    echo "checksum manifest is missing: $manifest" >&2
    exit 1
  fi
  count=0
  while IFS=' ' read -r expected remainder; do
    name=${remainder# }
    [ -n "$expected" ] || continue
    case "$expected" in
      *[!0-9A-Fa-f]*|'') echo "invalid SHA-256 digest in $manifest" >&2; exit 1 ;;
    esac
    if [ "${#expected}" -ne 64 ]; then
      echo "invalid SHA-256 digest length for $name" >&2
      exit 1
    fi
    case "$name" in
      webminai.plugin|webminai.plugin-*) ;;
      *) echo "unsafe artifact name in $manifest: $name" >&2; exit 1 ;;
    esac
    if [ ! -f "$dist_directory/$name" ]; then
      echo "artifact listed in $manifest is missing: $name" >&2
      exit 1
    fi
    actual=$(digest_file "$dist_directory/$name")
    if [ "$actual" != "$expected" ]; then
      echo "SHA-256 mismatch: $name" >&2
      exit 1
    fi
    count=$((count + 1))
  done < "$manifest"
  if [ "$count" -eq 0 ]; then
    echo "checksum manifest is empty: $manifest" >&2
    exit 1
  fi
  available=0
  for name in $(artifact_names); do
    available=$((available + 1))
    if ! awk -v expected="$name" '$2 == expected { found = 1 } END { exit(found ? 0 : 1) }' "$manifest"; then
      echo "artifact is missing from $manifest: $name" >&2
      exit 1
    fi
  done
  if [ "$count" -ne "$available" ]; then
    echo "checksum manifest contains duplicate or stale artifact entries" >&2
    exit 1
  fi
  printf 'Verified %s artifacts from %s\n' "$count" "$manifest"
}

case "$action" in
  write) write_manifest ;;
  verify) verify_manifest ;;
  *) echo 'usage: dist-checksums.sh [write|verify]' >&2; exit 2 ;;
esac
