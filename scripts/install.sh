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

mkdir -p "$INSTALL_ROOT" "$BIN_DIRECTORY"

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
else
  system_name=$(uname -s)
  if [ "$system_name" = FreeBSD ]; then
    if [ "$(id -u)" -eq 0 ]; then
      pkg install -y node24 npm-node24 python312 gmake
    else
      command -v sudo >/dev/null 2>&1 || { printf '%s\n' 'ERROR: FreeBSD Node installation requires root or sudo.' >&2; exit 1; }
      sudo pkg install -y node24 npm-node24 python312 gmake
    fi
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
    curl --fail --location --silent --show-error "https://nodejs.org/dist/v${NODE_VERSION}/$archive" --output "$temporary/$archive"
    curl --fail --location --silent --show-error "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" --output "$temporary/SHASUMS256.txt"
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
"$NPM_COMMAND" install --global --prefix "$INSTALL_ROOT/npm" "$PACKAGE_URL"
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE_COMMAND" "$INSTALL_ROOT/npm/lib/node_modules/intent-ai-ops/bin/intentaiops.js" > "$BIN_DIRECTORY/intentaiops"
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE_COMMAND" "$INSTALL_ROOT/npm/lib/node_modules/intent-ai-ops/bin/intentops.js" > "$BIN_DIRECTORY/intentops"
chmod 0755 "$BIN_DIRECTORY/intentaiops" "$BIN_DIRECTORY/intentops"

printf '%s\n' 'OK: Intent AI Ops is installed.'
case ":$PATH:" in
  *":$BIN_DIRECTORY:"*) printf '%s\n' 'Run: intentaiops' ;;
  *) printf 'Add %s to PATH, then run: intentaiops\n' "$BIN_DIRECTORY" ;;
esac
