const PACKAGES = ['podman-suite', 'py312-podman-compose', 'qemu-user-static']
const PATHS = ['/usr/local/etc/containers', '/var/db/containers']

export function buildFreebsdPodmanBootstrapTask (taskId, execution = {}, docker = {}) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  if (execution.platform !== 'freebsd') throw new Error('Podman bootstrap requires a FreeBSD execution inventory')
  if (docker.preference === 'disabled') throw new Error('Podman is disabled by this host Docker preference; enable Automatic or Enable Docker preference first')
  if (execution.docker?.hostIsContainer || docker.hostIsContainer) throw new Error('reviewed FreeBSD Podman installation is unavailable inside a jail')
  if (!docker.ready && execution.docker?.installSupported !== true && docker.installSupported !== true) throw new Error('reviewed Podman installation requires FreeBSD 15 or newer on a non-jailed host')
  const state = `/var/db/webminai/task-state/${taskId}-freebsd-podman`
  return {
    plan: {
      summary: 'Install and verify Podman Compose on FreeBSD',
      changeOverview: 'Confirm the native FreeBSD jail runtime requirements, capture package/path/module state, install Podman Suite and the packaged podman-compose implementation, and verify an isolated Linux-container workload.',
      modifiedFiles: [state, ...PATHS, '/etc/fstab', '/etc/sysctl.conf', '/etc/rc.conf'],
      assumptions: ['FreeBSD Podman uses jails and VFS storage; CPU hardware virtualization and nested virtualization are not required.'],
      warnings: ['FreeBSD Podman support is reviewed only for FreeBSD 15+ non-jailed hosts. The runtime is root-equivalent and application images must explicitly target a compatible Linux platform where required.'],
      requiresConfirmation: true,
      commands: [
        item('validate-freebsd-container-host', preflight(), 'Require FreeBSD 15+, a non-jailed host, pkg, and the native jail/VFS prerequisites before mutation'),
        item('capture-podman-baseline', capture(state), 'Capture package, path, fdescfs, kernel-module, and service state exactly once', ['validate-freebsd-container-host']),
        item('install-podman-suite', install(state), 'Install Podman Suite and podman-compose and initialize required FreeBSD facilities', ['capture-podman-baseline'], 1200000, 'job'),
        item('verify-podman-suite', verify(), 'Verify Podman info, Compose, and a disposable container', ['install-podman-suite'], 600000, 'job')
      ],
      revertCommands: [
        item('restore-podman-baseline', restore(state), 'Remove only packages, paths, mounts, and configuration introduced by this task', [], 1200000, 'job', 'destructive'),
        item('verify-podman-baseline', verifyBaseline(state), 'Require exact package and owned-path baseline restoration', ['restore-podman-baseline']),
        item('remove-podman-task-state', `set -eu; rm -rf -- ${quote(state)}`, 'Remove task-owned baseline after exact comparison', ['verify-podman-baseline'], 30000, undefined, 'destructive')
      ]
    },
    verifyApplied: 'podman info >/dev/null && podman-compose version >/dev/null',
    verifyReverted: `test ! -e ${quote(state)}`,
    stateProbe: `if command -v podman >/dev/null 2>&1; then printf 'podman-cli=present\n'; podman info >/dev/null 2>&1 && printf 'podman-runtime=ready\n' || printf 'podman-runtime=unavailable\n'; else printf 'podman-cli=absent\n'; fi; test ! -e ${quote(state)} || printf 'task-state=present\n'`
  }
}

function preflight () {
  return [
    'set -eu',
    '[ "$(uname -s)" = FreeBSD ]',
    'major=$(freebsd-version -u | sed -E \'s/^([0-9]+).*/\\1/\')',
    'case "$major" in ""|*[!0-9]*) printf \'FREEBSD_VERSION_UNSUPPORTED: could not identify FreeBSD\n\' >&2; exit 78;; esac',
    '[ "$major" -ge 15 ] || { printf \'FREEBSD_VERSION_UNSUPPORTED: Podman common task requires FreeBSD 15 or newer; upgrade the host before retrying\n\' >&2; exit 78; }',
    '[ "$(sysctl -n security.jail.jailed 2>/dev/null || printf 0)" = 0 ] || { printf \'FREEBSD_JAIL_UNSUPPORTED: install Podman on the outer FreeBSD host; nested jail delegation is not enabled for this common task\n\' >&2; exit 78; }',
    'command -v pkg >/dev/null',
    "printf '%s\n' 'FREEBSD_NATIVE_CONTAINERS: Podman uses jails and VFS; VT-x, AMD-V, and nested virtualization are not required'"
  ].join('; ')
}

function capture (state) {
  const paths = PATHS.map(path => `key=$(printf '%s' ${quote(path)} | tr '/.' '__'); [ ! -e ${quote(path)} ] || : > ${quote(state)}/"$key.existed"`).join('; ')
  return `set -eu; umask 077; install -d -m 0700 ${quote(state)}; if [ ! -s ${quote(`${state}/packages.before`)} ]; then pkg query '%n=%v' | LC_ALL=C sort > ${quote(`${state}/packages.before`)}; sha256 -q ${quote(`${state}/packages.before`)} > ${quote(`${state}/baseline.sha256`)}; ${paths}; mount | grep -Eq ' on /dev/fd .*fdescfs' && : > ${quote(`${state}/fdescfs.mounted`)} || true; grep -Eq '^[[:space:]]*fdesc[[:space:]]+/dev/fd[[:space:]]+fdescfs' /etc/fstab 2>/dev/null && : > ${quote(`${state}/fdescfs.configured`)} || true; grep -Eq '^[[:space:]]*net[.]pf[.]filter_local=1([[:space:]]|$)' /etc/sysctl.conf 2>/dev/null && : > ${quote(`${state}/pf-filter.configured`)} || true; sysctl -n net.pf.filter_local > ${quote(`${state}/pf-filter.before`)} 2>/dev/null || printf '0\n' > ${quote(`${state}/pf-filter.before`)}; kldstat -q -m pf && : > ${quote(`${state}/pf.loaded`)} || true; kldstat -q -m linux && : > ${quote(`${state}/linux.loaded`)} || true; service podman status >/dev/null 2>&1 && : > ${quote(`${state}/podman.active`)} || true; sysrc -n podman_enable > ${quote(`${state}/podman-enable.before`)} 2>/dev/null || true; fi`
}

function install (state) {
  return `set -eu; state=${quote(state)}; env ASSUME_ALWAYS_YES=yes pkg install -y ${PACKAGES.join(' ')}; pkg query '%n=%v' | LC_ALL=C sort > "$state/packages.after"; comm -13 "$state/packages.before" "$state/packages.after" | cut -d= -f1 > "$state/packages.added"; if ! mount | grep -Eq ' on /dev/fd .*fdescfs'; then mount -t fdescfs fdesc /dev/fd; : > "$state/fdescfs.added-mount"; fi; if ! grep -Eq '^[[:space:]]*fdesc[[:space:]]+/dev/fd[[:space:]]+fdescfs' /etc/fstab; then printf '%s\n' 'fdesc /dev/fd fdescfs rw 0 0' >> /etc/fstab; : > "$state/fdescfs.added-config"; fi; if ! test -c /dev/pf; then kldload pf; : > "$state/pf.added-module"; fi; sysctl net.pf.filter_local=1 >/dev/null; if ! grep -Eq '^[[:space:]]*net[.]pf[.]filter_local=1([[:space:]]|$)' /etc/sysctl.conf; then printf '%s\n' 'net.pf.filter_local=1' >> /etc/sysctl.conf; : > "$state/pf-filter.added-config"; fi; if ! kldstat -q -m linux; then service linux onestart >/dev/null; : > "$state/linux.added-module"; fi; sysrc podman_enable=YES >/dev/null; service podman start >/dev/null 2>&1 || true; install -d -m 0700 /var/db/containers/tmp`
}

function verify () {
  return "set -eu; podman info >/dev/null; podman-compose version >/dev/null; podman run --rm --os=linux docker.io/library/alpine:3.23 /bin/sh -c 'printf podman-ready' | grep -Fxq podman-ready"
}

function restore (state) {
  const paths = PATHS.map(path => `key=$(printf '%s' ${quote(path)} | tr '/.' '__'); [ -e "$state/$key.existed" ] || rm -rf -- ${quote(path)}`).join('; ')
  return `set -eu; [ -d ${quote(state)} ] || exit 0; state=${quote(state)}; [ -e "$state/podman.active" ] || service podman stop >/dev/null 2>&1 || true; if [ -s "$state/podman-enable.before" ]; then sysrc podman_enable="$(cat "$state/podman-enable.before")" >/dev/null; else sysrc -x podman_enable >/dev/null 2>&1 || true; fi; if [ -e "$state/fdescfs.added-mount" ]; then umount /dev/fd >/dev/null 2>&1 || true; fi; if [ -e "$state/fdescfs.added-config" ]; then sed -i '' '\\|^[[:space:]]*fdesc[[:space:]][[:space:]]*/dev/fd[[:space:]][[:space:]]*fdescfs[[:space:]]|d' /etc/fstab; fi; if [ -e "$state/pf-filter.added-config" ]; then sed -i '' '\\|^[[:space:]]*net[.]pf[.]filter_local=1[[:space:]]*$|d' /etc/sysctl.conf; fi; sysctl net.pf.filter_local="$(cat "$state/pf-filter.before")" >/dev/null 2>&1 || true; if [ -e "$state/linux.added-module" ]; then service linux onestop >/dev/null 2>&1 || true; fi; if [ -e "$state/pf.added-module" ]; then kldunload pf >/dev/null 2>&1 || true; fi; if [ -s "$state/packages.added" ]; then env ASSUME_ALWAYS_YES=yes xargs pkg delete -y -- < "$state/packages.added"; fi; ${paths}`
}

function verifyBaseline (state) {
  if (!state) throw new TypeError('state path is required')
  return `[ ! -d ${quote(state)} ] || { ${verifyCapturedBaseline(state)}; }`
}

function verifyCapturedBaseline (state) {
  const paths = PATHS.map(path => `key=$(printf '%s' ${quote(path)} | tr '/.' '__'); if [ -e ${quote(state)}/"$key.existed" ]; then [ -e ${quote(path)} ] || exit 1; else [ ! -e ${quote(path)} ] || exit 1; fi`).join('; ')
  return `set -eu; pkg query '%n=%v' | LC_ALL=C sort > ${quote(`${state}/packages.final`)}; sha256 -q ${quote(`${state}/packages.final`)} > ${quote(`${state}/final.sha256`)}; cmp -s ${quote(`${state}/baseline.sha256`)} ${quote(`${state}/final.sha256`)} || { diff -u ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.final`)} | sed -n '1,120p' >&2; exit 1; }; ${paths}`
}

function item (id, command, purpose, dependsOn = [], timeoutMs = 30000, executionMode, risk = 'change') {
  return { id, command, purpose, risk, timeoutMs, requiresSudo: true, dependsOn, ...(executionMode ? { executionMode } : {}) }
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
