#!/usr/bin/env bash
set -Eeuo pipefail

if ((EUID != 0)); then
  printf 'Run this cleanup script as root: sudo %s\n' "$0" >&2
  exit 1
fi

export PATH=/snap/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SCRIPT_DIRECTORY=$(cd "${BASH_SOURCE[0]%/*}" && pwd -P)

printf 'Removing all marked Intent AI Ops LXD test containers...\n'
exec "$SCRIPT_DIRECTORY/lxd-test-lab.sh" destroy --yes
