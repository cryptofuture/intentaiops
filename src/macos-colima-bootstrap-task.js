const FORMULAE = ['colima', 'docker', 'docker-compose', 'docker-buildx']

export function buildMacosColimaBootstrapTask (taskId, execution = {}, docker = {}) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  const user = requireRuntimeUser(execution.runtimeUser ?? docker.runtimeUser)
  const home = requireRuntimeHome(execution.runtimeHome ?? docker.runtimeHome)
  const brew = requireBrewPath(execution.brewPath)
  const state = `/var/db/webminai/task-state/${taskId}-macos-colima`
  const socket = `${home}/.colima/default/docker.sock`
  const plugins = ['docker-compose', 'docker-buildx'].map(name => ({ name, path: `${home}/.docker/cli-plugins/${name}` }))
  const userEnvironment = `HOME=${quote(home)} PATH=${quote(`${execution.brewPrefix ?? '/usr/local'}/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin`)}`
  const asUser = command => `/usr/bin/su -l ${quote(user)} -c ${quote(`env ${userEnvironment} /bin/sh -c ${quote(command)}`)}`
  const dockerCommand = `DOCKER_HOST=${quote(`unix://${socket}`)} ${quote(`${execution.brewPrefix ?? '/usr/local'}/bin/docker`)}`

  return {
    plan: {
      summary: 'Install the reviewed macOS Colima and Docker Compose substrate',
      changeOverview: 'Validate Apple hypervisor availability before mutation, install the Homebrew Colima/Docker toolchain as its non-root owner, start an isolated Linux VM, and verify Docker Compose.',
      modifiedFiles: [
        state,
        `${home}/.colima`,
        `${home}/.docker`,
        ...plugins.map(plugin => plugin.path),
        `${execution.brewPrefix ?? '/usr/local'}/Cellar/colima`,
        `${execution.brewPrefix ?? '/usr/local'}/Cellar/docker`,
        `${execution.brewPrefix ?? '/usr/local'}/Cellar/docker-compose`,
        `${execution.brewPrefix ?? '/usr/local'}/Cellar/docker-buildx`,
        `${execution.brewPrefix ?? '/usr/local'}/Cellar/go`
      ],
      assumptions: [
        `Homebrew is owned by the non-root macOS account ${user}.`,
        'Colima is used as the reviewed headless Linux-container substrate; Docker Desktop is not installed or controlled by this task.',
        'Application deployments preserve this shared substrate and remove only their own projects, images, files, volumes, and credentials.'
      ],
      warnings: [
        'A macOS VM must expose hardware virtualization. The preflight exits without mutation when kern.hv_support is not 1.',
        'Homebrew may compile Buildx and add its Go build dependency where a native bottle is unavailable; newly added formulae are recorded for rollback.',
        'The controlled default uses two CPUs, 3 GiB RAM, and a sparse 40 GiB Colima disk; high-resource applications still perform their own compatibility checks.'
      ],
      requiresConfirmation: true,
      commands: [
        item('validate-virtualization', preflight(), 'Require macOS 13+, x86_64/arm64, Homebrew ownership, and Apple hypervisor support before changing the host'),
        item('capture-colima-baseline', captureBaseline({ state, home, socket, plugins, brew, asUser }), 'Capture the complete Homebrew formula and Colima path/runtime baseline exactly once', ['validate-virtualization']),
        item('install-colima-toolchain', installToolchain({ state, home, plugins, brew, asUser }), 'Install Colima, Docker, Compose and Buildx through the existing non-root Homebrew installation', ['capture-colima-baseline'], 3600000, 'job'),
        item('start-colima', startColima({ state, home, socket, asUser, dockerCommand }), 'Start the reviewed Colima Docker VM and verify the daemon and Compose plugin', ['install-colima-toolchain'], 1800000, 'job'),
        item('verify-colima', verifyColima({ socket, asUser, dockerCommand }), 'Verify Colima ownership, Docker Linux-engine identity, Compose, and a disposable container', ['start-colima'], 600000, 'job')
      ],
      revertCommands: [
        item('remove-task-colima', removeColima({ state, home, socket, asUser }), 'Stop and delete the Colima profile only when this task created it', [], 1800000, 'job', 'destructive'),
        item('restore-homebrew-formulae', restoreFormulae({ state, plugins, brew, asUser, user }), 'Remove only Homebrew formulae and plugin links introduced after the captured baseline', ['remove-task-colima'], 1800000, 'job', 'destructive'),
        item('remove-colima-task-state', `set -eu; rm -rf -- ${quote(state)}`, 'Remove the task-owned baseline after successful restoration', ['restore-homebrew-formulae'], 30000, undefined, 'destructive')
      ]
    },
    verifyApplied: `${asUser(`${quote(execution.brewPrefix ?? '/usr/local')}/bin/colima status >/dev/null`)} && ${dockerCommand} info --format '{{.OSType}}' | grep -Fxq linux && ${dockerCommand} compose version >/dev/null && ${dockerCommand} buildx version >/dev/null`,
    verifyReverted: `test ! -e ${quote(state)}`,
    stateProbe: `if [ -S ${quote(socket)} ]; then printf 'colima-socket=present\n'; else printf 'colima-socket=absent\n'; fi; for formula in ${FORMULAE.map(quote).join(' ')}; do if ${quote(brew)} list --formula "$formula" >/dev/null 2>&1; then printf 'formula=%s:present\n' "$formula"; else printf 'formula=%s:absent\n' "$formula"; fi; done; ${plugins.map(plugin => `if [ -e ${quote(plugin.path)} ] || [ -L ${quote(plugin.path)} ]; then printf '${plugin.name}=present\\n'; else printf '${plugin.name}=absent\\n'; fi`).join('; ')}; if [ -e ${quote(state)} ]; then printf 'task-state=present\n'; else printf 'task-state=absent\n'; fi`
  }
}

function preflight () {
  return [
    'set -eu',
    'version=$(sw_vers -productVersion)',
    'major=$' + '{version%%.*}',
    'case "$major" in ""|*[!0-9]*) printf \'%s\\n\' \'MACOS_VERSION_UNSUPPORTED: could not identify macOS\' >&2; exit 78;; esac',
    '[ "$major" -ge 13 ] || { printf \'%s\\n\' \'MACOS_VERSION_UNSUPPORTED: Colima requires macOS 13 or newer\' >&2; exit 78; }',
    'case "$(uname -m)" in x86_64|arm64) :;; *) printf \'%s\\n\' \'MACOS_ARCHITECTURE_UNSUPPORTED: Colima requires x86_64 or arm64\' >&2; exit 78;; esac',
    '[ "$(sysctl -n kern.hv_support 2>/dev/null || printf 0)" = 1 ] || { printf \'%s\\n\' \'MACOS_HYPERVISOR_UNAVAILABLE: this macOS VM does not expose hardware virtualization; stop the VM, enable nested virtualization/VMX in its QEMU-KVM configuration, start it, and verify sysctl -n kern.hv_support returns 1\' >&2; exit 78; }',
    'printf \'%s\\n\' macos-container-preflight-ready'
  ].join('; ')
}

function captureBaseline ({ state, home, socket, plugins, brew, asUser }) {
  const capture = [
    `install -d -o root -g wheel -m 0700 ${quote(state)}`,
    `${asUser(`${quote(brew)} list --formula | LC_ALL=C sort -u`)} > ${quote(`${state}/formulae.before`)}`,
    `[ -e ${quote(`${home}/.colima`)} ] && : > ${quote(`${state}/colima-home.existed`)} || true`,
    `[ -e ${quote(`${home}/.colima/default`)} ] && : > ${quote(`${state}/default-profile.existed`)} || true`,
    `[ -S ${quote(socket)} ] && : > ${quote(`${state}/socket.existed`)} || true`,
    ...plugins.map(plugin => `if [ -e ${quote(plugin.path)} ] || [ -L ${quote(plugin.path)} ]; then : > ${quote(`${state}/${plugin.name}.existed`)}; fi`)
  ].join('; ')
  return [
    'set -eu',
    'umask 077',
    `if [ ! -f ${quote(`${state}/formulae.before`)} ]; then ${capture}; fi`,
    'printf \'%s\\n\' colima-baseline-ready'
  ].join('; ')
}

function installToolchain ({ state, home, plugins, brew, asUser }) {
  const install = asUser([
    'set -eu',
    'export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_UPGRADE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ASK=1 HOMEBREW_NO_AUTOREMOVE=1 HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1',
    'missing=',
    `for formula in ${FORMULAE.map(quote).join(' ')}; do if ! ${quote(brew)} list --formula "$formula" >/dev/null 2>&1; then missing="$missing $formula"; fi; done`,
    `if [ -n "$missing" ]; then case "$(uname -m)" in x86_64) if ! ${quote(brew)} list --formula go >/dev/null 2>&1; then ${quote(brew)} install --build-from-source go; fi; for formula in $missing; do ${quote(brew)} install --build-from-source "$formula"; done;; arm64) for formula in $missing; do ${quote(brew)} install "$formula"; done;; *) printf '%s\\n' 'MACOS_ARCHITECTURE_UNSUPPORTED' >&2; exit 78;; esac; fi`
  ].join('; '))
  const list = asUser(`${quote(brew)} list --formula | LC_ALL=C sort -u`)
  const snapshot = `${list} > ${quote(`${state}/formulae.after`)}; LC_ALL=C comm -13 ${quote(`${state}/formulae.before`)} ${quote(`${state}/formulae.after`)} > ${quote(`${state}/formulae.added`)}`
  return [
    'set -eu',
    'umask 077',
    `trap ${quote(`status=$?; trap - EXIT; ${snapshot}; exit "$status"`)} EXIT`,
    install,
    snapshot,
    'trap - EXIT',
    ...[`${home}/.docker`, `${home}/.docker/cli-plugins`].map(directory => `test ! -L ${quote(directory)}; if [ ! -d ${quote(directory)} ]; then install -d -o ${quote(requireRuntimeUserFromHome(home))} -g staff -m 0700 ${quote(directory)}; fi`),
    ...plugins.flatMap(plugin => [
      `plugin_prefix=$(${asUser(`${quote(brew)} --prefix ${plugin.name}`)})`,
      `[ -x "$plugin_prefix/bin/${plugin.name}" ]`,
      `if [ ! -e ${quote(plugin.path)} ] && [ ! -L ${quote(plugin.path)} ]; then printf '%s\\n' "$plugin_prefix/bin/${plugin.name}" > ${quote(`${state}/${plugin.name}.target`)}; ln -s "$plugin_prefix/bin/${plugin.name}" ${quote(plugin.path)}; : > ${quote(`${state}/${plugin.name}.created`)}; fi`
    ]),
    'printf \'%s\\n\' colima-toolchain-ready'
  ].join('; ')
}

function startColima ({ state, home, socket, asUser, dockerCommand }) {
  return [
    'set -eu',
    'umask 077',
    `if [ -S ${quote(socket)} ] && ${dockerCommand} info >/dev/null 2>&1; then : > ${quote(`${state}/runtime.ready-before`)}; elif [ -e ${quote(`${state}/default-profile.existed`)} ]; then ${asUser('colima start')}; else test ! -e ${quote(`${home}/.colima/default`)}; test ! -L ${quote(`${home}/.colima/default`)}; : > ${quote(`${state}/default-profile.created`)}; ${asUser('colima start --runtime docker --cpu 2 --memory 3 --disk 40')}; fi`,
    `i=0; until [ -S ${quote(socket)} ] && ${dockerCommand} info >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -le 120 ] || { printf '%s\\n' 'COLIMA_SERVICE_NOT_READY: Docker daemon did not become ready' >&2; exit 1; }; sleep 2; done`,
    `${dockerCommand} compose version >/dev/null`,
    `${dockerCommand} buildx version >/dev/null`,
    "printf '%s\\n' colima-runtime-ready"
  ].join('; ')
}

function verifyColima ({ socket, asUser, dockerCommand }) {
  return [
    'set -eu',
    asUser('colima status >/dev/null'),
    `[ -S ${quote(socket)} ]`,
    `[ "$(${dockerCommand} info --format '{{.OSType}}')" = linux ]`,
    `${dockerCommand} compose version >/dev/null`,
    `${dockerCommand} buildx version >/dev/null`,
    `${dockerCommand} run --rm --pull=missing alpine:3.23 /bin/sh -c 'printf WEBMINAI_MACOS_DOCKER_OK' | grep -Fxq WEBMINAI_MACOS_DOCKER_OK`,
    "printf '%s\\n' colima-verified"
  ].join('; ')
}

function removeColima ({ state, home, socket, asUser }) {
  return [
    'set -eu',
    `[ -d ${quote(state)} ] || exit 0`,
    `if [ -e ${quote(`${state}/default-profile.created`)} ]; then test ! -L ${quote(`${home}/.colima/default`)}; if [ -e ${quote(`${home}/.colima/default`)} ]; then ${asUser('colima stop >/dev/null 2>&1 || true; colima delete --force')}; fi; elif [ ! -e ${quote(`${state}/runtime.ready-before`)} ] && [ -S ${quote(socket)} ]; then ${asUser('colima stop')}; fi`,
    `if [ ! -e ${quote(`${state}/colima-home.existed`)} ]; then rmdir ${quote(`${home}/.colima`)} 2>/dev/null || true; fi`,
    "printf '%s\\n' colima-profile-restored"
  ].join('; ')
}

function restoreFormulae ({ state, plugins, brew, asUser, user }) {
  const uninstallPrefix = `/usr/bin/su -l ${quote(user)} -c`
  return [
    'set -eu',
    'umask 077',
    `[ -d ${quote(state)} ] || exit 0`,
    ...plugins.map(plugin => `if [ -e ${quote(`${state}/${plugin.name}.created`)} ] && { [ -e ${quote(plugin.path)} ] || [ -L ${quote(plugin.path)} ]; }; then test -L ${quote(plugin.path)}; expected=$(cat ${quote(`${state}/${plugin.name}.target`)}); test "$(readlink ${quote(plugin.path)})" = "$expected"; rm -f -- ${quote(plugin.path)}; fi`),
    `if [ -s ${quote(`${state}/formulae.added`)} ]; then sed -n '1!G;h;$p' ${quote(`${state}/formulae.added`)} | while IFS= read -r formula; do case "$formula" in ''|*[!A-Za-z0-9@+._/-]*) printf '%s\\n' 'Unsafe Homebrew formula name in task state' >&2; exit 1;; esac; ${uninstallPrefix} "env PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_AUTOREMOVE=1 HOMEBREW_NO_ASK=1 ${brew} uninstall --ignore-dependencies $formula"; done; fi`,
    `${asUser(`${quote(brew)} list --formula | LC_ALL=C sort -u`)} > ${quote(`${state}/formulae.restored`)}`,
    `cmp -s ${quote(`${state}/formulae.before`)} ${quote(`${state}/formulae.restored`)} || { printf '%s\\n' 'HOMEBREW_BASELINE_MISMATCH: formula inventory differs after rollback' >&2; exit 1; }`,
    "printf '%s\\n' homebrew-baseline-restored"
  ].join('; ')
}

function item (id, command, purpose, dependsOn = [], timeoutMs = 30000, executionMode, risk = 'change') {
  return { id, command, purpose, phase: id.startsWith('verify') ? 'verify' : id.includes('baseline') || id.startsWith('validate') ? 'baseline' : id.startsWith('remove') || id.startsWith('restore') ? 'cleanup' : 'packages', risk, timeoutMs, requiresSudo: true, dependsOn, ...(executionMode ? { executionMode } : {}) }
}

function requireRuntimeUser (value) {
  if (typeof value !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/u.test(value) || value === 'root') throw new Error('macOS Colima setup requires a detected non-root Homebrew owner')
  return value
}

function requireRuntimeUserFromHome (home) {
  return requireRuntimeUser(home.slice('/Users/'.length))
}

function requireRuntimeHome (value) {
  if (typeof value !== 'string' || !/^\/Users\/[a-z_][a-z0-9_-]{0,31}$/u.test(value)) throw new Error('macOS Colima setup requires the Homebrew owner home under /Users')
  return value
}

function requireBrewPath (value) {
  if (!['/usr/local/bin/brew', '/opt/homebrew/bin/brew'].includes(value)) throw new Error('macOS Colima setup requires Homebrew in a reviewed prefix')
  return value
}

function quote (value) {
  const escaped = String(value).split('\'').join('\'"\'"\'')
  return `'${escaped}'`
}
