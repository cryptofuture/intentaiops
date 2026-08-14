const DPKG_FORMAT = '$' + '{binary:Package}=$' + '{Version}\\n'

export function buildDockerComposeProfilePlan ({ taskId, linuxContext, docker }) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('Docker profile task id must be positive')
  if (!['ubuntu', 'debian'].includes(linuxContext?.identity?.id) || linuxContext.management?.packageManager !== 'apt') throw new Error('reviewed Docker profile setup currently requires Debian or Ubuntu with apt')
  if (docker?.preferred !== true || (!docker.ready && docker.installMethod !== 'official-apt')) throw new Error('Docker profile requires the effective official apt route')
  const state = `/var/lib/webminai/tasks/${taskId}/docker-compose-profile`
  const commands = [
    item('capture-docker-baseline', 'baseline', baseline(state), 'Capture Docker packages, files, data directories, and service state once.'),
    item('install-docker-profile', 'packages', install(state), 'Install the reviewed official Docker Engine and Compose packages when not already ready.', ['capture-docker-baseline'], 300000, { kind: 'service', target: 'docker.service' }),
    item('verify-docker-profile', 'verify', verify(), 'Verify Docker Engine and Compose through bounded local commands.', ['install-docker-profile'], 30000, { kind: 'service', target: 'docker.service' })
  ]
  const revertCommands = [
    item('restore-docker-profile', 'cleanup', restore(state), 'Remove only Docker packages and paths created by this task and restore service state.', [], 300000),
    item('verify-docker-baseline', 'baseline', verifyBaseline(state), 'Require the complete dpkg version baseline and Docker path state to match exactly.', ['restore-docker-profile'], 30000, { kind: 'filesystem', target: state }),
    item('remove-docker-profile-state', 'cleanup', `if [ -d ${quote(state)} ]; then rm -rf -- ${quote(state)}; fi`, 'Remove Docker profile state after exact comparison.', ['verify-docker-baseline'])
  ]
  return {
    summary: 'Validate the reviewed Docker Compose profile',
    changeOverview: 'Install Docker Engine and Compose from the official apt repository when required, with exact package/path/service rollback.',
    modifiedFiles: [state, '/etc/apt/keyrings/docker.asc', '/etc/apt/sources.list.d/docker.sources', '/var/lib/docker', '/var/lib/containerd'],
    assumptions: [`Host route: ${linuxContext.identity.id} ${linuxContext.identity.versionId} / ${docker.installMethod ?? 'already-ready'}`],
    warnings: ['This profile intentionally grants the host a root-equivalent Docker daemon while active.'],
    requiresConfirmation: true,
    commands,
    revertCommands
  }
}

function baseline (state) {
  const capture = [
    `dpkg-query -W -f=${quote(DPKG_FORMAT)} | LC_ALL=C sort > ${quote(`${state}/packages.before`)}`,
    `sha256sum ${quote(`${state}/packages.before`)} | awk '{print $1}' > ${quote(`${state}/baseline.sha256`)}`,
    `for path in /etc/apt/keyrings/docker.asc /etc/apt/sources.list.d/docker.sources /etc/docker /var/lib/docker /var/lib/containerd; do key=$(printf '%s' "$path" | tr '/.' '__'); [ ! -e "$path" ] || : > ${quote(state)}/"$key.existed"; done`,
    `if systemctl is-active --quiet docker 2>/dev/null; then : > ${quote(`${state}/docker.active`)}; fi`,
    `if command -v docker >/dev/null 2>&1; then : > ${quote(`${state}/docker-cli.existed`)}; fi`
  ].join('; ')
  return `set -eu; umask 077; install -d -m 0700 ${quote(state)}; if [ ! -s ${quote(`${state}/baseline.sha256`)} ]; then ${capture}; fi`
}

function install (state) {
  return [
    'set -eu',
    `state=${quote(state)}`,
    'if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then exit 0; fi',
    '[ ! -e "$state/docker-cli.existed" ] || { printf \'pre-existing Docker CLI is not healthy\\n\' >&2; exit 1; }',
    '. /etc/os-release',
    'case "$ID" in ubuntu|debian) vendor="$ID";; *) exit 1;; esac',
    'arch="$(dpkg --print-architecture)"',
    'case "$arch" in amd64|arm64|armhf|s390x|ppc64el) :;; *) exit 1;; esac',
    'set +u; codename="$UBUNTU_CODENAME"; [ -n "$codename" ] || codename="$VERSION_CODENAME"; set -u; test -n "$codename"',
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update',
    'apt-get install -y --no-install-recommends ca-certificates curl',
    'install -d -m 0755 /etc/apt/keyrings',
    'curl --fail --location --silent --show-error --output /etc/apt/keyrings/docker.asc "https://download.docker.com/linux/$vendor/gpg"',
    'chmod 0644 /etc/apt/keyrings/docker.asc',
    'printf \'%s\\n\' \'Types: deb\' "URIs: https://download.docker.com/linux/$vendor" "Suites: $codename" \'Components: stable\' "Architectures: $arch" \'Signed-By: /etc/apt/keyrings/docker.asc\' > /etc/apt/sources.list.d/docker.sources',
    'chmod 0644 /etc/apt/sources.list.d/docker.sources',
    'apt-get update',
    'apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
    'systemctl enable --now docker',
    `dpkg-query -W -f=${quote(DPKG_FORMAT)} | LC_ALL=C sort > ${quote(`${state}/packages.after`)}`,
    `comm -13 ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.after`)} | cut -d= -f1 | grep -Ev '^(curl|netdata($|-)|openssh($|-)|openssh-server$)' > ${quote(`${state}/packages.added`)} || true`
  ].join('; ')
}

function verify () {
  return 'docker info >/dev/null; docker compose version >/dev/null; systemctl is-active --quiet docker'
}

function restore (state) {
  return [
    `if [ ! -d ${quote(state)} ]; then exit 0; fi`,
    `state=${quote(state)}`,
    'if [ ! -e "$state/docker.active" ]; then systemctl disable --now docker.service docker.socket containerd.service >/dev/null 2>&1 || true; fi',
    'if [ -s "$state/packages.added" ]; then export DEBIAN_FRONTEND=noninteractive; xargs -r apt-get purge -y -- < "$state/packages.added"; fi',
    'for path in /etc/apt/keyrings/docker.asc /etc/apt/sources.list.d/docker.sources /etc/docker /var/lib/docker /var/lib/containerd; do key=$(printf \'%s\' "$path" | tr \'/.\' \'__\'); [ -e "$state/$key.existed" ] || rm -rf -- "$path"; done',
    'systemctl daemon-reload'
  ].join('; ')
}

function verifyBaseline (state) {
  return `if [ -s ${quote(`${state}/baseline.sha256`)} ]; then dpkg-query -W -f=${quote(DPKG_FORMAT)} | LC_ALL=C sort > ${quote(`${state}/packages.final`)}; sha256sum ${quote(`${state}/packages.final`)} | awk '{print $1}' > ${quote(`${state}/final.sha256`)}; cmp -s ${quote(`${state}/baseline.sha256`)} ${quote(`${state}/final.sha256`)} || { printf 'Docker package baseline drift\\n' >&2; diff -u ${quote(`${state}/packages.before`)} ${quote(`${state}/packages.final`)} | sed -n '1,120p' >&2; exit 1; }; for path in /etc/apt/keyrings/docker.asc /etc/apt/sources.list.d/docker.sources /etc/docker /var/lib/docker /var/lib/containerd; do key=$(printf '%s' "$path" | tr '/.' '__'); if [ -e ${quote(state)}/"$key.existed" ]; then [ -e "$path" ] || exit 1; else [ ! -e "$path" ] || exit 1; fi; done; fi`
}

function item (id, phase, command, purpose, dependsOn = [], timeoutMs = 30000, diagnostic) {
  return { id, phase, command, purpose, risk: phase === 'verify' ? 'read' : phase === 'cleanup' ? 'destructive' : 'change', timeoutMs, requiresSudo: true, dependsOn, ...(diagnostic ? { diagnostic } : {}) }
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
