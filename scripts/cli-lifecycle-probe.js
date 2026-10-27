import path from 'node:path'

export function buildCliLifecycleProbe ({ paths, packageManager, serviceManager, services = [] }) {
  const packages = {
    apt: `dpkg-query -W -f='${'$'}{binary:Package}\\t${'$'}{Version}\\t${'$'}{Architecture}\\t${'$'}{db:Status-Abbrev}\\n'`,
    dnf: "rpm -qa --qf '%{NAME}\\t%{EPOCHNUM}:%{VERSION}-%{RELEASE}\\t%{ARCH}\\n'",
    yum: "rpm -qa --qf '%{NAME}\\t%{EPOCHNUM}:%{VERSION}-%{RELEASE}\\t%{ARCH}\\n'",
    zypper: "rpm -qa --qf '%{NAME}\\t%{EPOCHNUM}:%{VERSION}-%{RELEASE}\\t%{ARCH}\\n'",
    apk: 'apk info -v',
    pacman: 'pacman -Q'
  }
  if (!Object.hasOwn(packages, packageManager) || !['systemd', 'openrc'].includes(serviceManager)) throw new TypeError('unsupported Linux probe environment')
  if (!Array.isArray(paths) || !paths.length || paths.length > 80 || paths.some(value => typeof value !== 'string' || !value.startsWith('/') || value.length > 512 || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || path.posix.normalize(value) !== value) || new Set(paths).size !== paths.length) throw new TypeError('invalid probe paths')
  if (!Array.isArray(services) || services.length > 16 || services.some(value => typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]{0,127}$/u.test(value)) || new Set(services).size !== services.length) throw new TypeError('invalid probe services')
  const serviceRead = serviceManager === 'systemd'
    ? 'observed=$(systemctl show --property=LoadState,ActiveState,UnitFileState -- "$service" 2>/dev/null) || { case "$observed" in *LoadState=not-found*) :;; *) exit 1;; esac; }'
    : 'if [ -f "/etc/init.d/$service" ]; then status=0; rc-service "$service" status >/dev/null 2>&1 || status=$?; observed="status-code=$status"; else observed=absent; fi'
  const treeEntry = [
    'set -eu; for item do',
    'metadata=$(stat -c "%F:%a:%u:%g" -- "$item")',
    `name=$(printf "%s" "$item" | sha256sum); name=${'$'}{name%% *}`,
    'digest=none',
    'if [ -L "$item" ]; then target=$(readlink -- "$item" && printf "."); digest=$(printf "%s" "$target" | sha256sum)',
    'elif [ -f "$item" ]; then [ "$(stat -c %s -- "$item")" -le 1073741824 ]; digest=$(sha256sum < "$item")',
    'elif [ ! -d "$item" ]; then exit 1; fi',
    `printf "%s|%s|%s\\n" "$name" "$metadata" "${'$'}{digest%% *}"; done`
  ].join('\n')
  return [
    'set -eu', 'export LC_ALL=C',
    `packages=$(${packages[packageManager]}) || exit 1`,
    'test -n "$packages" || exit 1',
    'sorted=$(printf \'%s\\n\' "$packages" | sort) || exit 1',
    'package_digest=$(printf \'%s\\n\' "$sorted" | sha256sum) || exit 1',
    "manifest=''",
    `for entry in ${paths.map(quote).join(' ')}; do metadata=absent; digest=none; if [ -e "$entry" ] || [ -L "$entry" ]; then metadata=$(stat -c '%F:%a:%u:%g' -- "$entry") || exit 1; if [ -L "$entry" ]; then target=$(readlink -- "$entry" && printf '.') || exit 1; digest=$(printf '%s' "$target" | sha256sum) || exit 1; elif [ -f "$entry" ]; then digest=$(sha256sum < "$entry") || exit 1; elif [ -d "$entry" ]; then records=$(find "$entry" -xdev -exec sh -c ${quote(treeEntry)} sh {} +) || exit 1; count=$(printf '%s\\n' "$records" | wc -l); [ "$count" -le 20000 ] || exit 1; sorted=$(printf '%s\\n' "$records" | sort) || exit 1; digest=$(printf '%s\\n' "$sorted" | sha256sum) || exit 1; else exit 1; fi; fi; manifest="$manifest|$entry|$metadata|\${digest%% *}"; done`,
    'path_digest=$(printf \'%s\' "$manifest" | sha256sum) || exit 1',
    "service_manifest=''",
    ...(serviceManager === 'openrc' ? ['runlevels=$(rc-update show default) || exit 1', 'service_manifest=$(printf \'%s\\n\' "$runlevels" | sort) || exit 1'] : []),
    ...(services.length ? [`for service in ${services.map(quote).join(' ')}; do ${serviceRead}; service_manifest="$service_manifest|$service|$observed"; done`] : []),
    'service_digest=$(printf \'%s\' "$service_manifest" | sha256sum) || exit 1',
    `printf 'probe-version=2\\npaths=%s\\npackages=%s\\nservices=%s\\n' "${'$'}{path_digest%% *}" "${'$'}{package_digest%% *}" "${'$'}{service_digest%% *}"`
  ].join('; ')
}

function quote (value) { return `'${value.replaceAll("'", "'\\''")}'` }
