#!/bin/sh
set -eu

project_root=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
source_file="$project_root/plugin/webminai.plugin.c"
windows_source_file="$project_root/plugin/webminai.plugin.windows.c"
version=$(tr -d '\r\n' < "$project_root/plugin/VERSION")
compiler=${CC:-cc}
target=${1:-linux}

crypto_flags() {
  flags=''
  if command -v pkg-config >/dev/null 2>&1; then
    flags=$(pkg-config --static --libs libcrypto 2>/dev/null || true)
  elif command -v pkgconf >/dev/null 2>&1; then
    flags=$(pkgconf --static --libs libcrypto 2>/dev/null || true)
  fi
  if [ -n "$flags" ]; then
    if [ "$(uname -s)" = FreeBSD ]; then
      printf '%s -lpthread\n' "$flags"
    else
      printf '%s\n' "$flags"
    fi
  else
    if [ "$(uname -s)" = FreeBSD ]; then
      printf '%s\n' '-lcrypto -lpthread'
    else
      printf '%s\n' '-lcrypto'
    fi
  fi
}

build() {
  output=$1
  platform_define=$2
  mkdir -p "$(dirname "$output")"
  # crypto_flags is controlled by the installed compiler metadata and is
  # intentionally split into compiler arguments here.
  # shellcheck disable=SC2046
  "$compiler" -O2 -Wall -Wextra -Werror -Wno-deprecated-declarations -std=c17 -static \
    $platform_define \
    -DWEBMINAI_PLUGIN_VERSION=\"$version\" \
    -o "$output" "$source_file" $(crypto_flags)
}

case "$target" in
  linux)
    if [ "$(uname -s)" != Linux ]; then
      echo 'the Linux plugin must be built on Linux' >&2
      exit 1
    fi
    output="$project_root/dist/webminai.plugin"
    build "$output" ''
    if ! command -v readelf >/dev/null 2>&1; then
      echo 'readelf is required to verify the Linux plugin artifact' >&2
      exit 1
    fi
    if readelf -l "$output" | grep -q INTERP; then
      echo 'Linux plugin artifact is dynamically linked' >&2
      exit 1
    fi
    ;;
  freebsd)
    if [ "$(uname -s)" != FreeBSD ]; then
      echo 'the release FreeBSD plugin must be built on FreeBSD' >&2
      exit 1
    fi
    case "$(uname -K)" in
      14*) ;;
      *)
        echo 'the release FreeBSD plugin must be built on the oldest supported FreeBSD major (14.x) for backward-compatible static libc syscalls' >&2
        exit 1
        ;;
    esac
    case "$(uname -m)" in
      amd64|x86_64) architecture=amd64 ;;
      arm64|aarch64) architecture=arm64 ;;
      *) echo "unsupported FreeBSD architecture: $(uname -m)" >&2; exit 1 ;;
    esac
    output="$project_root/dist/webminai.plugin-freebsd-$architecture"
    build "$output" '-DWEBMINAI_TARGET_FREEBSD=1'
    if [ "$("$output" --platform)" != freebsd ]; then
      echo 'FreeBSD plugin platform metadata is invalid' >&2
      exit 1
    fi
    if ldd "$output" >/dev/null 2>&1; then
      echo 'FreeBSD plugin artifact is dynamically linked' >&2
      exit 1
    fi
    ;;
  freebsd-compat)
    temporary_file=$(mktemp "${TMPDIR:-/tmp}/webminai-freebsd-compat.XXXXXXXX")
    trap 'rm -f "$temporary_file"' EXIT INT TERM
    # This compiles the FreeBSD execution branch against the local POSIX APIs.
    # It is a portability check, not a distributable FreeBSD binary.
    build "$temporary_file" '-DWEBMINAI_TARGET_FREEBSD=1'
    "$temporary_file" --version >/dev/null
    if [ "$("$temporary_file" --platform)" != freebsd ]; then
      echo 'FreeBSD compatibility build reported the wrong platform' >&2
      exit 1
    fi
    if ! printf '%s\n' 'FUNCTION freebsd-health 5 "webminai:health" "any" "compat"' 'QUIT' |
      "$temporary_file" 1 | grep -q '"platform":"freebsd"'; then
      echo 'FreeBSD compatibility build did not complete its health protocol check' >&2
      exit 1
    fi
    ;;
  macos)
    if [ "$(uname -s)" != Darwin ]; then
      echo 'the macOS plugin must be built on macOS' >&2
      exit 1
    fi
    case "$(uname -m)" in
      arm64) architecture=arm64 ;;
      x86_64|amd64) architecture=amd64 ;;
      *) echo "unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
    esac
    output="$project_root/dist/webminai.plugin-macos-$architecture"
    mkdir -p "$(dirname "$output")"
    # macOS does not support fully static executables; link against the
    # platform's OpenSSL installation and keep the plugin self-contained at
    # the application level.
    # shellcheck disable=SC2046
    "$compiler" -O2 -Wall -Wextra -Werror -Wno-deprecated-declarations -std=c17 \
      -DWEBMINAI_TARGET_MACOS=1 \
      -DWEBMINAI_PLUGIN_VERSION=\"$version\" \
      -o "$output" "$source_file" $(crypto_flags)
    if [ "$($output --platform)" != macos ]; then
      echo 'macOS plugin platform metadata is invalid' >&2
      exit 1
    fi
    ;;
  kubernetes)
    if [ "$(uname -s)" != Linux ]; then
      echo 'the Kubernetes gateway plugin must be built on Linux' >&2
      exit 1
    fi
    case "$(uname -m)" in
      x86_64|amd64) architecture=amd64 ;;
      aarch64|arm64) architecture=arm64 ;;
      *) echo "unsupported Kubernetes gateway architecture: $(uname -m)" >&2; exit 1 ;;
    esac
    output="$project_root/dist/webminai.plugin-kubernetes-$architecture"
    build "$output" '-DWEBMINAI_TARGET_KUBERNETES=1'
    if [ "$("$output" --platform)" != kubernetes ]; then
      echo 'Kubernetes gateway plugin platform metadata is invalid' >&2
      exit 1
    fi
    if ! command -v readelf >/dev/null 2>&1; then
      echo 'readelf is required to verify the Kubernetes gateway artifact' >&2
      exit 1
    fi
    if readelf -l "$output" | grep -q INTERP; then
      echo 'Kubernetes gateway plugin artifact is dynamically linked' >&2
      exit 1
    fi
    if ! printf '%s\n' 'FUNCTION kubernetes-health 5 "webminai:health" "any" "compat"' 'QUIT' |
      "$output" 1 | grep -q '"executionMode":"kubernetes-api"'; then
      echo 'Kubernetes gateway build did not complete its health protocol check' >&2
      exit 1
    fi
    ;;
  windows)
    windows_compiler=${CC_WINDOWS:-x86_64-w64-mingw32-gcc}
    if ! command -v "$windows_compiler" >/dev/null 2>&1; then
      echo "Windows cross-compiler not found: $windows_compiler" >&2
      echo 'set CC_WINDOWS or run scripts/build-native-plugin-windows.ps1 from Visual Studio Developer PowerShell' >&2
      exit 1
    fi
    output="$project_root/dist/webminai.plugin-windows-amd64.exe"
    mkdir -p "$(dirname "$output")"
    "$windows_compiler" -O2 -Wall -Wextra -Werror -std=c17 -static \
      -DUNICODE -D_UNICODE \
      -DWEBMINAI_PLUGIN_VERSION=\"$version\" \
      -o "$output" "$windows_source_file" -lbcrypt -ladvapi32
    if ! command -v llvm-readobj >/dev/null 2>&1; then
      echo 'llvm-readobj is required to verify the Windows plugin artifact' >&2
      exit 1
    fi
    if ! llvm-readobj --file-headers "$output" | grep -Eq 'Machine: (IMAGE_FILE_MACHINE_AMD64|AMD64)'; then
      echo 'Windows plugin artifact is not an x64 PE executable' >&2
      exit 1
    fi
    ;;
  *)
    echo 'usage: build-native-plugin.sh [linux|freebsd|freebsd-compat|macos|kubernetes|windows]' >&2
    exit 2
    ;;
esac

if [ "$target" != freebsd-compat ]; then
  sh "$project_root/scripts/dist-checksums.sh" write
fi
