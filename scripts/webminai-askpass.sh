#!/bin/sh
set -eu

password=${SSH_HOST_1:-${SSH_HOST_MAC_PWD:-}}
[ -n "$password" ] || exit 1
printf '%s\n' "$password"
