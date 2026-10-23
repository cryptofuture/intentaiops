import { freebsdInstallMissingPackages } from './freebsd-runtime-packages.js'

const VERSION = '1.99.1'

export function freebsdRustPackageCommand () {
  return `if ! command -v rustc >/dev/null 2>&1; then case "$(uname -m)" in amd64|aarch64|arm64) ${freebsdInstallMissingPackages(['rustup-init'])};; *) ${freebsdInstallMissingPackages(['rust'])};; esac; fi`
}

function checkedState (state) {
  if (!/^\/var\/(?:lib|db)\/webminai\/task-state\/[a-zA-Z0-9-]+$/u.test(state)) throw new TypeError('Invalid FreeBSD Rust task state')
  return state
}

export function freebsdRustEnvironment (state) {
  checkedState(state)
  return `export CARGO_HOME='${state}/cargo' CARGO_BUILD_JOBS=1
if [ -f '${state}/rust-private-ready' ]; then
  export RUSTUP_HOME='${state}/rustup' RUSTUP_TOOLCHAIN=${VERSION} PATH='${state}/cargo/bin':$PATH RUSTC='${state}/cargo/bin/rustc'
else
  rust_root=$(rustc --print sysroot)
  test -x "$rust_root/bin/rustc"; test -x "$rust_root/bin/cargo"
  export PATH="$rust_root/bin:$PATH" RUSTC="$rust_root/bin/rustc"
fi`
}

export function freebsdRustSetupCommand (state) {
  checkedState(state)
  return `set -eu; umask 077; test ! -L '${state}'; test ! -L '${state}/cargo'; test ! -L '${state}/rustup'; test ! -L '${state}/rust-private-ready'
if [ -f '${state}/rust-private-ready' ]; then
  ${freebsdRustEnvironment(state)}
  rustc --version | grep -F 'rustc ${VERSION} '; cargo --version; exit 0
fi
if command -v rustc >/dev/null 2>&1; then rustc --version; cargo --version; exit 0; fi
case "$(uname -m)" in amd64) rust_host=x86_64-unknown-freebsd;; aarch64|arm64) rust_host=aarch64-unknown-freebsd;; *) echo RUST_BUILD_TOOLCHAIN_UNAVAILABLE >&2; exit 78;; esac
export RUSTUP_HOME='${state}/rustup' CARGO_HOME='${state}/cargo' RUSTUP_TOOLCHAIN=${VERSION} RUSTUP_DIST_SERVER=https://static.rust-lang.org RUSTUP_UPDATE_ROOT=https://static.rust-lang.org/rustup
rustup-init -y --no-modify-path --profile minimal --default-host "$rust_host" --default-toolchain ${VERSION}
export PATH='${state}/cargo/bin':$PATH RUSTUP_TOOLCHAIN=${VERSION}
rustc --version | grep -F 'rustc ${VERSION} '; cargo --version
: > '${state}/rust-private-ready'`
}
