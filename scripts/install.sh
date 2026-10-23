#!/bin/sh

set -eu

PACKAGE_URL=${INTENTAI_OPS_PACKAGE_URL:-https://raw.githubusercontent.com/cryptofuture/intentaiops/main/dist/intent-ai-ops.tgz}
INSTALL_ROOT=${INTENTAI_OPS_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/intentaiops}
BIN_DIRECTORY=${INTENTAI_OPS_BIN_DIR:-$HOME/.local/bin}
NODE_VERSION=24.16.0

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  printf '%s\n' 'Usage: curl -fsSL https://raw.githubusercontent.com/cryptofuture/intentaiops/main/scripts/install.sh | sh'
  printf '%s\n' 'Installs a private Node.js 24 runtime only when node is absent, then installs Intent AI Ops.'
  printf '%s\n' 'Override the package for testing with INTENTAI_OPS_PACKAGE_URL.'
  exit 0
fi

ensure_freebsd_packages () {
  missing_packages=
  for package do
    pkg info -e "$package" >/dev/null 2>&1 || missing_packages="$missing_packages $package"
  done
  if [ -n "$missing_packages" ]; then
    if [ "$(id -u)" -eq 0 ]; then
      pkg install -y $missing_packages
    else
      command -v sudo >/dev/null 2>&1 || { printf '%s\n' 'ERROR: FreeBSD package installation requires root or sudo.' >&2; exit 1; }
      sudo pkg install -y $missing_packages
    fi
  fi
}

system_name=$(uname -s)
mkdir -p "$INSTALL_ROOT" "$BIN_DIRECTORY"

if ! command -v node >/dev/null 2>&1 && [ -x "$INSTALL_ROOT/runtime/bin/node" ] && [ -x "$INSTALL_ROOT/runtime/bin/npm" ] && "$INSTALL_ROOT/runtime/bin/node" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 24 || (major === 24 && minor >= 7) ? 0 : 1)'; then
  PATH="$INSTALL_ROOT/runtime/bin:$PATH"
  export PATH
fi

if command -v node >/dev/null 2>&1; then
  node_version=$(node -p 'process.versions.node')
  node_major=$(printf '%s' "$node_version" | cut -d. -f1)
  node_minor=$(printf '%s' "$node_version" | cut -d. -f2)
  if [ "$node_major" -lt 24 ] || { [ "$node_major" -eq 24 ] && [ "$node_minor" -lt 7 ]; }; then
    printf 'ERROR: Node.js %s is installed, but Intent AI Ops requires 24.7 or newer. Upgrade it explicitly and rerun this installer.\n' "$node_version" >&2
    exit 1
  fi
  command -v npm >/dev/null 2>&1 || { printf '%s\n' 'ERROR: npm is missing from the installed Node.js runtime.' >&2; exit 1; }
  NODE_COMMAND=$(command -v node)
  NPM_COMMAND=$(command -v npm)
  if [ "$system_name" = FreeBSD ]; then ensure_freebsd_packages python312 gmake; fi
else
  if [ "$system_name" = Linux ] && [ -f /etc/alpine-release ]; then
    if [ "$(id -u)" -eq 0 ]; then
      apk add --no-cache nodejs npm
    else
      command -v sudo >/dev/null 2>&1 || { printf '%s\n' 'ERROR: Alpine Node installation requires root or sudo.' >&2; exit 1; }
      sudo apk add --no-cache nodejs npm
    fi
    NODE_COMMAND=$(command -v node)
    NPM_COMMAND=$(command -v npm)
    "$NODE_COMMAND" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 24 || (major === 24 && minor >= 7) ? 0 : 1)' || { printf '%s\n' 'ERROR: Alpine requires Node.js 24.7 or newer.' >&2; exit 1; }
  elif [ "$system_name" = FreeBSD ]; then
    ensure_freebsd_packages node24 npm-node24 python312 gmake
    NODE_COMMAND=/usr/local/bin/node
    NPM_COMMAND=/usr/local/bin/npm
  else
    command -v curl >/dev/null 2>&1 || { printf '%s\n' 'ERROR: curl is required to install Node.js.' >&2; exit 1; }
    architecture=$(uname -m)
    case "$architecture" in
      x86_64|amd64) node_arch=x64 ;;
      arm64|aarch64) node_arch=arm64 ;;
      *) printf 'ERROR: Unsupported Node.js architecture: %s\n' "$architecture" >&2; exit 1 ;;
    esac
    case "$system_name" in
      Linux) node_platform=linux; extension=tar.gz; extract_flags=xzf ;;
      Darwin) node_platform=darwin; extension=tar.gz; extract_flags=xzf ;;
      *) printf 'ERROR: Unsupported bootstrap platform: %s\n' "$system_name" >&2; exit 1 ;;
    esac
    archive="node-v${NODE_VERSION}-${node_platform}-${node_arch}.${extension}"
    runtime="$INSTALL_ROOT/runtime"
    temporary=$(mktemp -d "${TMPDIR:-/tmp}/intentaiops-install.XXXXXXXX")
    trap 'rm -rf "$temporary"' EXIT HUP INT TERM
    curl --fail --location --retry 3 --retry-all-errors --retry-delay 2 --silent --show-error "https://nodejs.org/dist/v${NODE_VERSION}/$archive" --output "$temporary/$archive"
    curl --fail --location --retry 3 --retry-all-errors --retry-delay 2 --silent --show-error "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" --output "$temporary/SHASUMS256.txt"
    expected=$(awk -v file="$archive" '$2 == file { print $1 }' "$temporary/SHASUMS256.txt")
    [ -n "$expected" ] || { printf '%s\n' 'ERROR: Node.js checksum is unavailable.' >&2; exit 1; }
    if command -v sha256sum >/dev/null 2>&1; then
      actual=$(sha256sum "$temporary/$archive" | awk '{ print $1 }')
    else
      actual=$(shasum -a 256 "$temporary/$archive" | awk '{ print $1 }')
    fi
    [ "$actual" = "$expected" ] || { printf '%s\n' 'ERROR: Node.js checksum verification failed.' >&2; exit 1; }
    rm -rf "$runtime"
    mkdir -p "$runtime"
    tar -"$extract_flags" "$temporary/$archive" -C "$runtime" --strip-components=1
    NODE_COMMAND="$runtime/bin/node"
    NPM_COMMAND="$runtime/bin/npm"
  fi
fi

PATH=$(dirname "$NODE_COMMAND"):$PATH
export PATH
export NODE_OPTIONS="${NODE_OPTIONS:-} --network-family-autoselection-attempt-timeout=5000"
if [ "$system_name" = FreeBSD ] && [ -z "${PYTHON:-}" ]; then
  PYTHON=$(command -v python3.12)
  export PYTHON
fi
set --
npm_major=$("$NPM_COMMAND" --version | cut -d. -f1)
case "$npm_major" in
  ''|*[!0-9]*) ;;
  *) if [ "$npm_major" -ge 12 ]; then set -- --allow-scripts=better-sqlite3,node-pty; fi ;;
esac
"$NPM_COMMAND" install --global --prefix "$INSTALL_ROOT/npm" "$@" "$PACKAGE_URL"
if [ "$(uname -s)" = FreeBSD ]; then
  "$NODE_COMMAND" "$INSTALL_ROOT/npm/lib/node_modules/intent-ai-ops/scripts/install-better-sqlite3.js"
fi
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE_COMMAND" "$INSTALL_ROOT/npm/lib/node_modules/intent-ai-ops/bin/intentaiops.js" > "$BIN_DIRECTORY/intentaiops"
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE_COMMAND" "$INSTALL_ROOT/npm/lib/node_modules/intent-ai-ops/bin/intentops.js" > "$BIN_DIRECTORY/intentops"
chmod 0755 "$BIN_DIRECTORY/intentaiops" "$BIN_DIRECTORY/intentops"

printf '%s\n' 'OK: Intent AI Ops is installed.'
case ":$PATH:" in
  *":$BIN_DIRECTORY:"*) printf '%s\n' 'Run: intentaiops' ;;
  *) printf 'Add %s to PATH, then run: intentaiops\n' "$BIN_DIRECTORY" ;;
esac
