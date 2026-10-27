export function freebsdInstallMissingPackages (packages) {
  if (!Array.isArray(packages) || !packages.length || packages.some(name => typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_+.-]*$/u.test(name))) throw new TypeError('Invalid FreeBSD package families')
  return `missing_packages=; for package in ${packages.map(name => `'${name}'`).join(' ')}; do pkg info -e "$package" >/dev/null 2>&1 || missing_packages="$missing_packages $package"; done; if [ -n "$missing_packages" ]; then env ASSUME_ALWAYS_YES=yes pkg install -y $missing_packages; fi`
}

export function freebsdInstallCompilerIfMissing () {
  return `if ! command -v cc >/dev/null 2>&1 || ! command -v c++ >/dev/null 2>&1; then ${freebsdInstallMissingPackages(['llvm19'])}; fi`
}

export function freebsdCompilerEnvironment () {
  return "if command -v cc >/dev/null 2>&1 && command -v c++ >/dev/null 2>&1; then CC=$(command -v cc); CXX=$(command -v c++); elif command -v clang19 >/dev/null 2>&1 && command -v clang++19 >/dev/null 2>&1; then CC=$(command -v clang19); CXX=$(command -v clang++19); else printf 'BUILD_COMPILER_UNAVAILABLE: a native C/C++ compiler is required\\n' >&2; exit 78; fi; export CC CXX; export CARGO_TARGET_X86_64_UNKNOWN_FREEBSD_LINKER=\"$CC\" CARGO_TARGET_AARCH64_UNKNOWN_FREEBSD_LINKER=\"$CC\""
}

export function freebsdSourceCompilerEnvironment () {
  const tools = [['AR', 'ar', 'llvm-ar19'], ['RANLIB', 'ranlib', 'llvm-ranlib19'], ['NM', 'nm', 'llvm-nm19'], ['STRIP', 'strip', 'llvm-strip19'], ['LD', 'ld', 'ld.lld19']]
  return freebsdCompilerEnvironment() + '; ' + tools.map(([variable, system, fallback]) => `if command -v ${system} >/dev/null 2>&1; then ${variable}=$(command -v ${system}); elif command -v ${fallback} >/dev/null 2>&1; then ${variable}=$(command -v ${fallback}); else printf 'BUILD_ARCHIVER_UNAVAILABLE: ${system}\n' >&2; exit 78; fi; export ${variable}`).join('; ')
}

export function freebsdBuildLog (state, command) {
  if (!/^\/var\/(?:lib|db)\/webminai\/task-state\/[a-zA-Z0-9-]+$/u.test(state) || typeof command !== 'string' || !command.trim() || command.includes('\nINTENTAI_OPS_BUILD\n')) throw new TypeError('Invalid private FreeBSD build log input')
  return `set -eu; umask 077; test ! -L '${state}'; test -d '${state}'; log=$(mktemp '${state}/application-build.XXXXXX')
if /bin/sh > "$log" 2>&1 <<'INTENTAI_OPS_BUILD'
set -eu
${command}
INTENTAI_OPS_BUILD
then tail -c 1000 "$log"; else status=$?; printf 'Private build log: %s\n' "$log" >&2; tail -c 3000 "$log" >&2; exit "$status"; fi`
}
