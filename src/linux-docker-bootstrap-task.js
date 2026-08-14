const SUPPORTED_METHODS = new Set(['official-apt', 'official-rpm', 'distribution-packages'])
const PATHS = ['/etc/apt/keyrings', '/etc/apt/keyrings/docker.asc', '/etc/apt/sources.list.d/docker.sources', '/etc/yum.repos.d/docker-ce.repo', '/etc/docker', '/var/lib/docker', '/var/lib/containerd']

export function buildLinuxDockerBootstrapTask (taskId, linuxContext = {}, docker = {}) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  if (docker.preference === 'disabled') throw new Error('Docker is disabled by this host preference; enable Automatic or Enable Docker preference first')
  if (docker.hostIsContainer && docker.preference !== 'enabled') throw new Error(`automatic Docker installation is disabled inside ${docker.containerRuntime ?? 'a container'}; explicitly enable Docker for this host only when nested containers are configured`)
  if (!docker.ready && (!docker.installSupported || !SUPPORTED_METHODS.has(docker.installMethod))) {
    throw new Error(`no reviewed Docker installation route is available for ${linuxContext?.identity?.id ?? 'this Linux distribution'}`)
  }
  const state = `/var/lib/webminai/tasks/${taskId}/linux-docker`
  const manager = requireManager(linuxContext.management?.packageManager, docker)
  return {
    plan: {
      summary: 'Install and verify Docker Engine with Compose on Linux',
      changeOverview: 'Confirm that native Linux containers do not require hardware virtualization, capture the package/service/path baseline, install the reviewed distro-specific Docker route when needed, and verify Docker Compose.',
      modifiedFiles: [state, ...PATHS],
      assumptions: [
        `Detected Linux route: ${linuxContext?.identity?.id ?? 'unknown'} ${linuxContext?.identity?.versionId ?? ''} / ${docker.ready ? 'already-ready' : docker.installMethod}.`,
        'Docker Engine runs natively on Linux and does not require VT-x, AMD-V, or nested virtualization; a containerized host still needs explicit nesting privileges.'
      ],
      warnings: ['The Docker daemon is root-equivalent. Only enable it on a host whose administrators and Docker group membership are trusted.'],
      requiresConfirmation: true,
      commands: [
        item('validate-container-host', validateHost(docker), 'Validate the Linux host/container boundary and explain that hardware virtualization is not required'),
        item('capture-docker-baseline', baseline(state, manager), 'Capture the complete package, Docker path, and service baseline exactly once', ['validate-container-host']),
        item('install-docker-engine', install(state, manager, docker.installMethod, linuxContext?.identity?.id), 'Install Docker Engine and Compose through the reviewed repository or distribution package route', ['capture-docker-baseline'], 900000, 'job'),
        item('verify-docker-engine', verify(manager), 'Verify the daemon, Linux engine identity, Compose, and a disposable container', ['install-docker-engine'], 300000, 'job')
      ],
      revertCommands: [
        item('restore-docker-baseline', restore(state, manager), 'Remove packages and paths introduced by this task and restore the prior service state', [], 900000, 'job', 'destructive'),
        item('verify-docker-baseline', verifyBaseline(state, manager), 'Require the package and Docker path baseline to match exactly', ['restore-docker-baseline']),
        item('remove-docker-task-state', `set -eu; rm -rf -- ${quote(state)}`, 'Remove task-owned baseline state after exact comparison', ['verify-docker-baseline'], 30000, undefined, 'destructive')
      ]
    },
    verifyApplied: 'docker info --format \'{{.OSType}}\' | grep -Fxq linux && { docker compose version >/dev/null 2>&1 || docker-compose version >/dev/null 2>&1; }',
    verifyReverted: `test ! -e ${quote(state)}`,
    stateProbe: `if command -v docker >/dev/null 2>&1; then printf 'docker-cli=present\n'; if docker info >/dev/null 2>&1; then printf 'docker-daemon=ready\n'; else printf 'docker-daemon=unavailable\n'; fi; else printf 'docker-cli=absent\n'; fi; if [ -e ${quote(state)} ]; then printf 'task-state=present\n'; else printf 'task-state=absent\n'; fi`
  }
}

function requireManager (manager, docker) {
  if (docker.ready) return manager ?? 'unknown'
  if (!['apt', 'dnf', 'yum', 'apk', 'pacman', 'zypper'].includes(manager)) throw new Error(`unsupported Linux package manager for Docker: ${manager ?? 'unknown'}`)
  return manager
}

function validateHost (docker) {
  return [
    'set -eu',
    '[ "$(uname -s)" = Linux ]',
    docker.hostIsContainer
      ? `printf '%s\n' ${quote(`LINUX_CONTAINER_HOST: ${docker.containerRuntime ?? 'container'} detected; hardware virtualization is not required, but nested Docker needs an explicitly privileged container with cgroups, namespaces, storage, and networking delegated by its outer host`)}`
      : "printf '%s\n' 'LINUX_NATIVE_CONTAINERS: Docker Engine uses Linux namespaces and cgroups; VT-x, AMD-V, and nested virtualization are not required'"
  ].join('; ')
}

function baseline (state, manager) {
  const packages = packageSnapshot(manager, `${state}/packages.before`)
  const capturePaths = PATHS.map(path => `key=$(printf '%s' ${quote(path)} | tr '/.' '__'); [ ! -e ${quote(path)} ] || : > ${quote(state)}/"$key.existed"`).join('; ')
  return `set -eu; umask 077; install -d -m 0700 ${quote(state)}; if [ ! -s ${quote(`${state}/baseline.sha256`)} ]; then ${packages}; sha256sum ${quote(`${state}/packages.before`)} | awk '{print $1}' > ${quote(`${state}/baseline.sha256`)}; ${capturePaths}; if command -v systemctl >/dev/null 2>&1; then systemctl is-active --quiet docker 2>/dev/null && : > ${quote(`${state}/docker.active`)} || true; systemctl is-enabled --quiet docker 2>/dev/null && : > ${quote(`${state}/docker.enabled`)} || true; elif command -v rc-service >/dev/null 2>&1; then rc-service docker status >/dev/null 2>&1 && : > ${quote(`${state}/docker.active`)} || true; rc-update show default 2>/dev/null | grep -Eq '(^|[[:space:]])docker([[:space:]]|$)' && : > ${quote(`${state}/docker.enabled`)} || true; fi; command -v docker >/dev/null 2>&1 && : > ${quote(`${state}/docker-cli.existed`)} || true; fi`
}

function install (state, manager, method, distro) {
  const installCommand = method === 'official-apt'
    ? installApt(distro)
    : method === 'official-rpm'
      ? installRpm(distro)
      : installDistribution(manager)
  return `set -eu; state=${quote(state)}; if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && { docker compose version >/dev/null 2>&1 || docker-compose version >/dev/null 2>&1; }; then exit 0; fi; [ ! -e "$state/docker-cli.existed" ] || { printf 'PREEXISTING_DOCKER_UNHEALTHY: repair or remove the existing Docker installation before this task\n' >&2; exit 78; }; ${installCommand}; ${packageSnapshot(manager, `${state}/packages.after`)}; comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} | cut -d= -f1 > ${quote(`${state}/packages.added`)}; ${startService(manager)}`
}

function installApt (distro) {
  const vendor = distro === 'ubuntu' ? 'ubuntu' : 'debian'
  return `export DEBIAN_FRONTEND=noninteractive; apt-get update; need=; [ -r /etc/ssl/certs/ca-certificates.crt ] || need="$need ca-certificates"; command -v curl >/dev/null 2>&1 || need="$need curl"; [ -z "$need" ] || apt-get install -y --no-install-recommends $need; install -d -m 0755 /etc/apt/keyrings; curl --fail --location --silent --show-error --output /etc/apt/keyrings/docker.asc https://download.docker.com/linux/${vendor}/gpg; chmod 0644 /etc/apt/keyrings/docker.asc; . /etc/os-release; codename="\${UBUNTU_CODENAME:-\${VERSION_CODENAME:-}}"; [ -n "$codename" ]; arch=$(dpkg --print-architecture); printf '%s\n' 'Types: deb' 'URIs: https://download.docker.com/linux/${vendor}' "Suites: $codename" 'Components: stable' "Architectures: $arch" 'Signed-By: /etc/apt/keyrings/docker.asc' > /etc/apt/sources.list.d/docker.sources; apt-get update; apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`
}

function installRpm (distro) {
  const vendor = distro === 'fedora' ? 'fedora' : 'centos'
  return `if command -v dnf >/dev/null 2>&1; then pm=dnf; else pm=yum; fi; "$pm" -y install dnf-plugins-core ca-certificates curl; "$pm" config-manager --add-repo https://download.docker.com/linux/${vendor}/docker-ce.repo; "$pm" -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`
}

function installDistribution (manager) {
  if (manager === 'apk') return 'apk update; apk add docker docker-cli-compose'
  if (manager === 'pacman') return 'pacman -Sy --noconfirm --needed docker docker-compose'
  if (manager === 'zypper') return 'zypper --non-interactive refresh; zypper --non-interactive install --no-recommends docker docker-compose'
  throw new Error(`unsupported distribution Docker package manager: ${manager}`)
}

function verify (manager) {
  return `set -eu; ${startService(manager)}; docker info --format '{{.OSType}}' | grep -Fxq linux; { docker compose version >/dev/null 2>&1 || docker-compose version >/dev/null 2>&1; }; docker run --rm hello-world >/dev/null`
}

function startService (manager) {
  return manager === 'apk' ? 'rc-update add docker default >/dev/null 2>&1 || true; rc-service docker start >/dev/null' : 'systemctl enable --now docker.service'
}

function restore (state, manager) {
  const remove = removePackages(manager, `${state}/packages.added`)
  const restorePaths = PATHS.map(path => `key=$(printf '%s' ${quote(path)} | tr '/.' '__'); [ -e "$state/$key.existed" ] || rm -rf -- ${quote(path)}`).join('; ')
  const service = manager === 'apk'
    ? '[ -e "$state/docker.active" ] || rc-service docker stop >/dev/null 2>&1 || true; [ -e "$state/docker.enabled" ] || rc-update del docker default >/dev/null 2>&1 || true'
    : '[ -e "$state/docker.active" ] || systemctl stop docker.service docker.socket containerd.service >/dev/null 2>&1 || true; [ -e "$state/docker.enabled" ] || systemctl disable docker.service docker.socket containerd.service >/dev/null 2>&1 || true'
  return `set -eu; [ -d ${quote(state)} ] || exit 0; state=${quote(state)}; ${service}; ${remove}; ${restorePaths}`
}

function verifyBaseline (state, manager) {
  const snapshot = packageSnapshot(manager, `${state}/packages.final`)
  const paths = PATHS.map(path => `key=$(printf '%s' ${quote(path)} | tr '/.' '__'); if [ -e ${quote(state)}/"$key.existed" ]; then [ -e ${quote(path)} ] || exit 1; else [ ! -e ${quote(path)} ] || exit 1; fi`).join('; ')
  return `set -eu; [ -d ${quote(state)} ] || exit 0; ${snapshot}; sha256sum ${quote(`${state}/packages.final`)} | awk '{print $1}' > ${quote(`${state}/final.sha256`)}; cmp -s ${quote(`${state}/baseline.sha256`)} ${quote(`${state}/final.sha256`)} || { printf 'Docker package baseline drift\n' >&2; diff -u ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.final`)} | sed -n '1,120p' >&2; exit 1; }; ${paths}`
}

function packageSnapshot (manager, target) {
  if (manager === 'apt') return `dpkg-query -W -f='\${binary:Package}=\${Version}\n' | LC_ALL=C sort > ${quote(target)}`
  if (['dnf', 'yum', 'zypper'].includes(manager)) return `rpm -qa --qf '%{NAME}=%{VERSION}-%{RELEASE}.%{ARCH}\n' | LC_ALL=C sort > ${quote(target)}`
  if (manager === 'apk') return `apk info | LC_ALL=C sort > ${quote(target)}`
  if (manager === 'pacman') return `pacman -Q | sed 's/ /=/' | LC_ALL=C sort > ${quote(target)}`
  return `printf '%s\n' already-ready > ${quote(target)}`
}

function removePackages (manager, file) {
  if (manager === 'apt') return `if [ -s ${quote(file)} ]; then export DEBIAN_FRONTEND=noninteractive; xargs -r apt-get purge -y -- < ${quote(file)}; fi`
  if (manager === 'dnf') return `if [ -s ${quote(file)} ]; then xargs -r dnf -y remove -- < ${quote(file)}; fi`
  if (manager === 'yum') return `if [ -s ${quote(file)} ]; then xargs -r yum -y remove -- < ${quote(file)}; fi`
  if (manager === 'zypper') return `if [ -s ${quote(file)} ]; then xargs -r zypper --non-interactive remove -u -- < ${quote(file)}; fi`
  if (manager === 'apk') return `if [ -s ${quote(file)} ]; then xargs -r apk del -- < ${quote(file)}; fi`
  if (manager === 'pacman') return `if [ -s ${quote(file)} ]; then xargs -r pacman -Rns --noconfirm -- < ${quote(file)}; fi`
  return ':'
}

function item (id, command, purpose, dependsOn = [], timeoutMs = 30000, executionMode, risk = 'change') {
  return { id, command, purpose, risk, timeoutMs, requiresSudo: true, dependsOn, ...(executionMode ? { executionMode } : {}) }
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
