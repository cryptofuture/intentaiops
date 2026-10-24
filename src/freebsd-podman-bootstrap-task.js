const PACKAGES = ['podman-suite', 'py312-podman-compose', 'qemu-user-static']
const PATHS = ['/usr/local/etc/containers', '/var/db/containers']

export function buildFreebsdPodmanBootstrapTask (taskId, execution = {}, docker = {}) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  if (execution.platform !== 'freebsd') throw new Error('Podman bootstrap requires a FreeBSD execution inventory')
  if (docker.preference === 'disabled') throw new Error('Podman is disabled by this host Docker preference; enable Automatic or Enable Docker preference first')
  if (execution.docker?.hostIsContainer || docker.hostIsContainer) throw new Error('reviewed FreeBSD Podman installation is unavailable inside a jail')
  if (!docker.ready && execution.docker?.installSupported !== true && docker.installSupported !== true) throw new Error('reviewed Podman installation requires FreeBSD 14.4 or 15.1+ on a non-jailed host')
  const state = `/var/db/webminai/task-state/${taskId}-freebsd-podman`
  return {
    plan: {
      summary: 'Install and verify Podman Compose on FreeBSD',
      changeOverview: 'Confirm the native FreeBSD jail runtime requirements, capture package/path/module state, install Podman Suite and the packaged podman-compose implementation, and verify an isolated Linux-container workload.',
      modifiedFiles: [state, ...PATHS, '/etc/fstab', '/etc/sysctl.conf', '/etc/rc.conf', '/etc/pf.conf'],
      assumptions: ['FreeBSD Podman uses jails and VFS storage; CPU hardware virtualization and nested virtualization are not required.'],
      warnings: ['FreeBSD Podman support is reviewed only for FreeBSD 14.4 or 15.1+ non-jailed hosts. The runtime is root-equivalent and application images must explicitly target a compatible Linux platform where required.'],
      requiresConfirmation: true,
      commands: [
        item('validate-freebsd-container-host', preflight(), 'Require FreeBSD 14.4 or 15.1+, a non-jailed host, pkg, and the native jail/VFS prerequisites before mutation'),
        item('capture-podman-baseline', capture(state), 'Capture package, path, fdescfs, kernel-module, and service state exactly once', ['validate-freebsd-container-host']),
        item('install-podman-suite', install(state), 'Install Podman Suite and podman-compose and initialize required FreeBSD facilities', ['capture-podman-baseline'], 1200000, 'job'),
        item('configure-podman-storage', configureStorage(state), 'Configure VFS only for new task-owned storage; preserve existing container settings', ['install-podman-suite']),
        item('configure-podman-network', configureNetwork(state), 'Preserve existing PF policy or initialize reviewed NAT-only rules when no policy exists', ['configure-podman-storage']),
        item('verify-podman-suite', verify(), 'Verify Podman info, Compose, and a disposable container', ['configure-podman-network'], 600000, 'job')
      ],
      revertCommands: [
        item('restore-podman-network', restoreNetwork(state), 'Restore only unchanged task-created NAT policy after every container has stopped', [], 30000, undefined, 'destructive'),
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
    'case "$(freebsd-version -r)" in 14.4-*|15.[1-9]*-*) ;; *) printf \'FREEBSD_VERSION_UNSUPPORTED: Podman common task requires a reviewed FreeBSD 14.4 or 15.1+ kernel\\n\' >&2; exit 78;; esac',
    '[ "$(sysctl -n security.jail.jailed 2>/dev/null || printf 0)" = 0 ] || { printf \'FREEBSD_JAIL_UNSUPPORTED: install Podman on the outer FreeBSD host; nested jail delegation is not enabled for this common task\n\' >&2; exit 78; }',
    'command -v pkg >/dev/null',
    "printf '%s\n' 'FREEBSD_NATIVE_CONTAINERS: Podman uses jails and VFS; VT-x, AMD-V, and nested virtualization are not required'"
  ].join('; ')
}

function capture (state) {
  const paths = PATHS.map(path => `key=$(printf '%s' ${quote(path)} | tr '/.' '__'); [ ! -e ${quote(path)} ] || : > ${quote(state)}/"$key.existed"`).join('; ')
  return `set -eu; umask 077; install -d -m 0700 ${quote(state)}; if [ ! -s ${quote(`${state}/packages.before`)} ]; then pkg query '%n=%v' | LC_ALL=C sort > ${quote(`${state}/packages.before`)}; sha256 -q ${quote(`${state}/packages.before`)} > ${quote(`${state}/baseline.sha256`)}; test ! -L /etc/rc.conf; test "$(stat -f '%u' /etc/rc.conf)" = 0; cp -p /etc/rc.conf ${quote(`${state}/rc.conf.before`)}; chmod 0600 ${quote(`${state}/rc.conf.before`)}; sha256 -q /etc/rc.conf > ${quote(`${state}/rc.before.sha256`)}; stat -f '%u:%g:%Lp' /etc/rc.conf > ${quote(`${state}/rc.metadata`)}; ${paths}; mount | grep -Eq ' on /dev/fd .*fdescfs' && : > ${quote(`${state}/fdescfs.mounted`)} || true; grep -Eq '^[[:space:]]*fdesc[[:space:]]+/dev/fd[[:space:]]+fdescfs' /etc/fstab 2>/dev/null && : > ${quote(`${state}/fdescfs.configured`)} || true; grep -Eq '^[[:space:]]*net[.]pf[.]filter_local=1([[:space:]]|$)' /etc/sysctl.conf 2>/dev/null && : > ${quote(`${state}/pf-filter.configured`)} || true; sysctl -n net.pf.filter_local > ${quote(`${state}/pf-filter.before`)} 2>/dev/null || printf '0\n' > ${quote(`${state}/pf-filter.before`)}; kldstat -q -m pf && : > ${quote(`${state}/pf.loaded`)} || true; (kldstat -q -n linux.ko || kldstat -q -n linux64.ko) && : > ${quote(`${state}/linux-any.loaded`)} || true; kldstat -q -n linux64.ko && : > ${quote(`${state}/linux.loaded`)} || true; command -v podman >/dev/null 2>&1 && : > ${quote(`${state}/podman.preexisting`)} || true; service podman status >/dev/null 2>&1 && : > ${quote(`${state}/podman.active`)} || true; sysrc -n linux_enable > ${quote(`${state}/linux-enable.before`)} 2>/dev/null || true; sysrc -n podman_enable > ${quote(`${state}/podman-enable.before`)} 2>/dev/null || true; fi`
}

function install (state) {
  return `set -eu; state=${quote(state)}; if ! kldstat -q -m fdescfs && [ "$(freebsd-version -k)" != "$(freebsd-version -r)" ]; then printf 'REBOOT_REQUIRED: boot the installed kernel before initializing Podman kernel facilities\\n' >&2; exit 78; fi; env ASSUME_ALWAYS_YES=yes pkg install -y ${PACKAGES.join(' ')}; pkg query '%n=%v' | LC_ALL=C sort > "$state/packages.after"; awk -F= 'FILENAME == ARGV[1] {before[$1]=1; next} !($1 in before) {print $1}' "$state/packages.before" "$state/packages.after" > "$state/packages.added"; if ! mount | grep -Eq ' on /dev/fd .*fdescfs'; then mount -t fdescfs fdesc /dev/fd; : > "$state/fdescfs.added-mount"; fi; if ! grep -Eq '^[[:space:]]*fdesc[[:space:]]+/dev/fd[[:space:]]+fdescfs' /etc/fstab; then printf '%s\n' 'fdesc /dev/fd fdescfs rw 0 0' >> /etc/fstab; : > "$state/fdescfs.added-config"; fi; if ! test -c /dev/pf; then kldload pf; : > "$state/pf.added-module"; fi; sysctl net.pf.filter_local=1 >/dev/null; if ! grep -Eq '^[[:space:]]*net[.]pf[.]filter_local=1([[:space:]]|$)' /etc/sysctl.conf; then printf '%s\n' 'net.pf.filter_local=1' >> /etc/sysctl.conf; : > "$state/pf-filter.added-config"; fi; if ! kldstat -q -n linux64.ko; then service linux onestart >/dev/null; : > "$state/linux.added-module"; fi; sysrc linux_enable=YES >/dev/null; sysrc podman_enable=YES >/dev/null; [ -e "$state/podman.preexisting" ] || service podman start >/dev/null 2>&1 || true; install -d -m 0700 /var/db/containers/tmp; sha256 -q /etc/rc.conf > "$state/rc.applied.sha256"`
}

function configureStorage (state) {
  return `set -eu; state=${quote(state)}; if [ -e "$state/_usr_local_etc_containers.existed" ] || [ -e "$state/_var_db_containers.existed" ]; then printf 'Existing container storage settings preserved\\n'; exit 0; fi; test ! -L /usr/local/etc/containers; test ! -L /usr/local/etc/containers/storage.conf; install -d -m 0755 /usr/local/etc/containers; printf '[storage]\\ndriver = "vfs"\\nrunroot = "/var/run/containers/storage"\\ngraphroot = "/var/db/containers/vfs-storage"\\n' > /usr/local/etc/containers/storage.conf; chmod 0644 /usr/local/etc/containers/storage.conf`
}

function verify () {
  return "set -eu; podman info >/dev/null; podman-compose version >/dev/null; podman run --rm --os=linux docker.io/library/alpine:3.23 /bin/sh -c 'printf podman-ready' | grep -Fxq podman-ready"
}

function configureNetwork (state) {
  return `set -eu; LC_ALL=C; export LC_ALL; state=${quote(state)}; test ! -L "$state"; install -d -m 0700 "$state"; test ! -L /etc/pf.conf; if [ -e /etc/pf.conf ]; then if pfctl -s info | grep -q '^Status: Enabled' && pfctl -sn | grep -Fq 'nat-anchor "cni-rdr/*"' && pfctl -sn | grep -Fq 'rdr-anchor "cni-rdr/*"' && pfctl -s Tables | grep -Eq '^[[:space:]]*cni-nat[[:space:]]*$'; then printf 'Existing PF policy preserved\\n'; exit 0; fi; printf 'PODMAN_NETWORK_REVIEW_REQUIRED: existing PF policy needs operator-reviewed CNI integration\\n' >&2; exit 78; fi; if pfctl -s info | grep -q '^Status: Enabled' || [ -n "$(pfctl -sr)" ] || [ -n "$(pfctl -sn)" ]; then printf 'PODMAN_NETWORK_REVIEW_REQUIRED: refusing to replace active PF policy\\n' >&2; exit 78; fi; interface=$(route -n get default | awk '$1 == "interface:" {print $2}'); printf '%s\\n' "$interface" | grep -Eq '^[A-Za-z][A-Za-z0-9_.:-]{0,31}$' || exit 78; test ! -L /etc/rc.conf; test "$(stat -f '%u' /etc/rc.conf)" = 0; cp -p /etc/rc.conf "$state/pf-rc.conf.before"; chmod 0600 "$state/pf-rc.conf.before"; stat -f '%u:%g:%Lp' /etc/rc.conf > "$state/pf-rc.metadata"; sha256 -q /etc/rc.conf > "$state/pf-rc.before.sha256"; (pfctl -sr; pfctl -sn) | sha256 -q > "$state/pf-rules.before"; temporary=$(mktemp /etc/.intentaiops-pf.XXXXXX); trap 'rm -f -- "$temporary"' EXIT; printf 'table <cni-nat>\\nnat on %s inet from <cni-nat> to any -> (%s)\\nrdr-anchor "cni-rdr/*"\\nnat-anchor "cni-rdr/*"\\n' "$interface" "$interface" > "$temporary"; pfctl -nf "$temporary"; ln "$temporary" /etc/pf.conf; : > "$state/pf-created"; sha256 -q /etc/pf.conf > "$state/pf-config.sha256"; pfctl -f /etc/pf.conf; (pfctl -sr; pfctl -sn) | sha256 -q > "$state/pf-rules.applied"; pfctl -e; printf '\\n# Intent AI Ops task-owned Podman networking\\npf_enable="YES"\\n' >> /etc/rc.conf; sha256 -q /etc/rc.conf > "$state/pf-rc.applied.sha256"`
}

function restoreNetwork (state) {
  return `set -eu; state=${quote(state)}; [ -e "$state/pf-created" ] || exit 0; test ! -L /etc/pf.conf; test ! -L /etc/rc.conf; test ! -L "$state/pf-rc.conf.before"; [ "$(sha256 -q "$state/pf-rc.conf.before")" = "$(cat "$state/pf-rc.before.sha256")" ] || { printf 'BASELINE_RESTORATION_BLOCKED: saved rc.conf changed\\n' >&2; exit 78; }; [ "$(stat -f '%u:%g:%Lp' /etc/rc.conf)" = "$(cat "$state/pf-rc.metadata")" ] || exit 78; rc=$(sha256 -q /etc/rc.conf); [ "$rc" = "$(cat "$state/pf-rc.before.sha256")" ] || [ "$rc" = "$(cat "$state/pf-rc.applied.sha256" 2>/dev/null || true)" ] || { printf 'BASELINE_RESTORATION_BLOCKED: rc.conf changed\\n' >&2; exit 78; }; [ "$(sha256 -q /etc/pf.conf)" = "$(cat "$state/pf-config.sha256")" ] || { printf 'BASELINE_RESTORATION_BLOCKED: PF configuration changed\\n' >&2; exit 78; }; [ -z "$(podman ps -q)" ] || { printf 'BASELINE_RESTORATION_BLOCKED: containers still depend on PF\\n' >&2; exit 78; }; current=$( (pfctl -sr; pfctl -sn) | sha256 -q); [ "$current" = "$(cat "$state/pf-rules.before")" ] || [ "$current" = "$(cat "$state/pf-rules.applied" 2>/dev/null || true)" ] || { printf 'BASELINE_RESTORATION_BLOCKED: active PF policy changed\\n' >&2; exit 78; }; if pfctl -s info | grep -q '^Status: Enabled'; then pfctl -d; fi; pfctl -f /dev/null; rm -f -- /etc/pf.conf; cat "$state/pf-rc.conf.before" > /etc/rc.conf`
}

function restore (state) {
  const paths = PATHS.map(path => `key=$(printf '%s' ${quote(path)} | tr '/.' '__'); [ -e "$state/$key.existed" ] || rm -rf -- ${quote(path)}`).join('; ')
  return `set -eu; [ -d ${quote(state)} ] || exit 0; state=${quote(state)}; [ -e "$state/podman.preexisting" ] || [ -e "$state/podman.active" ] || service podman stop >/dev/null 2>&1 || true; if [ -f "$state/rc.conf.before" ]; then test ! -L "$state/rc.conf.before"; test ! -L /etc/rc.conf; test "$(stat -f '%u:%Lp' "$state/rc.conf.before")" = 0:600; test "$(sha256 -q "$state/rc.conf.before")" = "$(cat "$state/rc.before.sha256")"; test "$(stat -f '%u:%g:%Lp' /etc/rc.conf)" = "$(cat "$state/rc.metadata")"; current=$(sha256 -q /etc/rc.conf); if [ "$current" != "$(cat "$state/rc.before.sha256")" ] && [ "$current" != "$(cat "$state/rc.applied.sha256" 2>/dev/null || true)" ]; then printf 'BASELINE_RESTORATION_BLOCKED: rc.conf changed\\n' >&2; exit 78; fi; cat "$state/rc.conf.before" > /etc/rc.conf; else if [ -e "$state/linux-enable.before" ]; then if [ -s "$state/linux-enable.before" ]; then sysrc linux_enable="$(cat "$state/linux-enable.before")" >/dev/null; else sysrc -x linux_enable >/dev/null 2>&1 || true; fi; fi; if [ -s "$state/podman-enable.before" ]; then sysrc podman_enable="$(cat "$state/podman-enable.before")" >/dev/null; else sysrc -x podman_enable >/dev/null 2>&1 || true; fi; fi; if [ -e "$state/fdescfs.added-mount" ]; then umount /dev/fd >/dev/null 2>&1 || true; fi; if [ -e "$state/fdescfs.added-config" ]; then sed -i '' '\\|^[[:space:]]*fdesc[[:space:]][[:space:]]*/dev/fd[[:space:]][[:space:]]*fdescfs[[:space:]]|d' /etc/fstab; fi; if [ -e "$state/pf-filter.added-config" ]; then sed -i '' '\\|^[[:space:]]*net[.]pf[.]filter_local=1[[:space:]]*$|d' /etc/sysctl.conf; fi; sysctl net.pf.filter_local="$(cat "$state/pf-filter.before")" >/dev/null 2>&1 || true; if [ -e "$state/linux.added-module" ] && [ ! -e "$state/linux-any.loaded" ]; then service linux onestop >/dev/null 2>&1 || true; fi; if [ -e "$state/pf.added-module" ]; then kldunload pf >/dev/null 2>&1 || true; fi; if [ -s "$state/packages.added" ]; then env ASSUME_ALWAYS_YES=yes xargs pkg delete -y -- < "$state/packages.added"; fi; ${paths}`
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
