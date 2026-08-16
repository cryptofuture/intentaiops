export const DEPLOYMENT_PHASES = Object.freeze([
  'preflight',
  'baseline',
  'acquire',
  'packages',
  'secrets',
  'database',
  'configure',
  'initialize',
  'services',
  'health',
  'verify',
  'cleanup'
])

const PHASE_SET = new Set(DEPLOYMENT_PHASES)
const DIAGNOSTICS = new Set(['package', 'service', 'http', 'database', 'compose', 'filesystem'])

export function isDeploymentPhase (value) {
  return PHASE_SET.has(value)
}

export function validateDiagnostic (diagnostic) {
  if (diagnostic === undefined || diagnostic === null) return
  if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic) || !DIAGNOSTICS.has(diagnostic.kind)) throw new TypeError('invalid safe diagnostic')
  const target = diagnostic.target
  if (diagnostic.kind === 'http') {
    if (typeof target !== 'string' || !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/u.test(target)) throw new TypeError('HTTP diagnostics are restricted to loopback URLs')
  } else if (diagnostic.kind === 'filesystem' || diagnostic.kind === 'compose') {
    if (typeof target !== 'string' || !/^\/[A-Za-z0-9_./@+-]+$/u.test(target) || target.includes('..')) throw new TypeError('diagnostic path must be an absolute safe path')
  } else if (typeof target !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9+_.:@/%=-]{0,191}$/u.test(target)) {
    throw new TypeError(`${diagnostic.kind} diagnostic target must be one identifier without spaces or shell syntax; split the command or use a null diagnostic when no single target applies`)
  }
}

export function buildSafeDiagnosticCommand (diagnostic) {
  validateDiagnostic(diagnostic)
  const target = shellQuote(diagnostic.target)
  if (diagnostic.kind === 'package') return `if command -v apt-cache >/dev/null 2>&1; then apt-cache policy ${target}; elif command -v dnf >/dev/null 2>&1; then dnf -q info ${target}; elif command -v apk >/dev/null 2>&1; then apk policy ${target}; elif command -v pacman >/dev/null 2>&1; then pacman -Si ${target}; elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive info ${target}; else exit 127; fi`
  if (diagnostic.kind === 'service') return `if command -v systemctl >/dev/null 2>&1; then systemctl status ${target} --no-pager -n 30; elif command -v rc-service >/dev/null 2>&1; then rc-service ${target} status; else service ${target} status; fi`
  if (diagnostic.kind === 'http') return `curl --fail --silent --show-error --max-time 10 --output /dev/null --write-out 'http_status=%{http_code}\\n' ${target}`
  if (diagnostic.kind === 'database') return 'if command -v mariadb-admin >/dev/null 2>&1; then mariadb-admin ping --silent; elif command -v pg_isready >/dev/null 2>&1; then pg_isready --timeout=5; else exit 127; fi'
  if (diagnostic.kind === 'compose') return `docker compose --project-directory ${target} ps --all`
  return `stat -- ${target}`
}

export function composeDeploymentPlan ({ foundation, applicationCommands, verification = [], revertCommands, summary, changeOverview, modifiedFiles = [], assumptions = [], warnings = [] }) {
  if (!Array.isArray(foundation) || !Array.isArray(applicationCommands) || !Array.isArray(verification) || !Array.isArray(revertCommands)) throw new TypeError('deployment plan phases must be arrays')
  const commands = [...foundation, ...applicationCommands, ...verification]
  for (const command of commands) {
    if (!isDeploymentPhase(command.phase)) throw new TypeError(`command ${command.id} requires a deployment phase`)
  }
  for (const command of applicationCommands) {
    if (!['configure', 'initialize', 'verify'].includes(command.phase)) throw new Error(`application-specific command ${command.id} cannot replace a reviewed foundation phase`)
  }
  for (const command of verification) {
    if (!['services', 'health', 'verify'].includes(command.phase)) throw new Error(`reviewed post-initialization command ${command.id} has an invalid phase`)
  }
  return {
    summary,
    changeOverview,
    modifiedFiles,
    assumptions,
    warnings,
    requiresConfirmation: true,
    commands,
    revertCommands: revertCommands.map(command => ({ ...command, phase: command.phase ?? 'cleanup' }))
  }
}

export function buildBaselineCommands ({ taskId, applicationId, packageManager }) {
  if (!Number.isInteger(taskId) || taskId < 1 || !safeId(applicationId)) throw new TypeError('baseline requires a task id and application id')
  const directory = `/var/lib/webminai/tasks/${taskId}/${applicationId}`
  const packageCommand = packageSnapshotCommand(packageManager)
  return [{
    id: 'capture-baseline',
    phase: 'baseline',
    command: `umask 077; install -d -m 0700 ${shellQuote(directory)}; if [ ! -s ${shellQuote(`${directory}/baseline.sha256`)} ]; then ${packageCommand} > ${shellQuote(`${directory}/versions.before`)}; ${packageNameSnapshotCommand(packageManager)} > ${shellQuote(`${directory}/packages.before`)}; sha256sum ${shellQuote(`${directory}/versions.before`)} | awk '{print $1}' > ${shellQuote(`${directory}/baseline.sha256`)}; fi`,
    purpose: 'Capture a deterministic pre-change host and package baseline without secrets.',
    risk: 'change',
    timeoutMs: 30000,
    requiresSudo: true,
    dependsOn: []
  }]
}

export function buildPackagePhase ({ taskId, applicationId, packageManager, packages, dependsOn = ['capture-baseline'] }) {
  const directory = stateDirectory(taskId, applicationId)
  if (!Array.isArray(packages) || packages.length === 0 || packages.some(value => !safePackage(value))) throw new TypeError('package phase requires safe package names')
  const names = packages.map(shellQuote).join(' ')
  const command = {
    apt: `export DEBIAN_FRONTEND=noninteractive; apt-get update; apt-get install -y --no-install-recommends ${names}`,
    dnf: `dnf install -y ${names}`,
    yum: `yum install -y ${names}`,
    apk: `apk add --no-cache ${names}`,
    pacman: `pacman -Sy --needed --noconfirm ${names}`,
    zypper: `zypper --non-interactive refresh; zypper --non-interactive install --no-recommends ${names}`
  }[packageManager]
  if (!command) throw new Error(`unsupported reviewed package manager: ${packageManager}`)
  return [{
    id: 'install-reviewed-packages',
    phase: 'packages',
    command,
    purpose: 'Install the exact packages selected by typed stack profiles.',
    risk: 'change',
    timeoutMs: 300000,
    requiresSudo: true,
    dependsOn,
    diagnostic: { kind: 'package', target: packages[0] }
  }, {
    id: 'record-package-delta',
    phase: 'packages',
    command: `${packageNameSnapshotCommand(packageManager)} > ${shellQuote(`${directory}/packages.after`)}; comm -13 ${shellQuote(`${directory}/packages.before`)} ${shellQuote(`${directory}/packages.after`)} | grep -Ev '^(curl|netdata($|-)|openssh($|-)|openssh-server$)' > ${shellQuote(`${directory}/packages.added`)} || true`,
    purpose: 'Record the exact newly added package names while excluding Stage 2 prerequisites.',
    risk: 'change',
    timeoutMs: 30000,
    requiresSudo: true,
    dependsOn: ['install-reviewed-packages']
  }]
}

export function buildSecretPhase ({ taskId, applicationId, dependsOn = ['record-package-delta'] }) {
  const taskDirectory = stateDirectory(taskId, applicationId)
  if (!safeId(applicationId)) throw new TypeError('secret phase requires a safe application id')
  const directory = `/root/${applicationId}_credentials`
  const file = `${directory}/database_password`
  return [{
    id: 'generate-host-credentials',
    phase: 'secrets',
    command: `umask 077; install -d -m 0700 ${shellQuote(directory)}; if [ ! -s ${shellQuote(file)} ]; then openssl rand -base64 36 | tr -d '\\n' > ${shellQuote(file)}; chmod 0600 ${shellQuote(file)}; : > ${shellQuote(`${taskDirectory}/credential.created`)}; fi; test -s ${shellQuote(file)}`,
    purpose: `Generate task credentials on the host; only ${file} is exposed to planning and logs.`,
    risk: 'change',
    timeoutMs: 30000,
    requiresSudo: true,
    dependsOn
  }]
}

export function buildDatabasePhase ({ engine, applicationId, databaseName, databaseUser, service, serviceManager, dependsOn = ['generate-host-credentials'] }) {
  if (!['mariadb', 'postgresql'].includes(engine) || !safeSqlIdentifier(databaseName) || !safeSqlIdentifier(databaseUser) || !safeService(service)) throw new TypeError('database phase requires reviewed engine and safe identifiers')
  if (!safeId(applicationId)) throw new TypeError('database phase requires a safe application id')
  const passwordFile = `/root/${applicationId}_credentials/database_password`
  const start = serviceStartCommand(serviceManager, service)
  const readiness = engine === 'mariadb'
    ? 'attempt=0; until mariadb --protocol=socket -uroot -e "SELECT 1" >/dev/null 2>&1; do attempt=$((attempt + 1)); [ "$attempt" -lt 30 ] || { printf \'MariaDB did not become ready\\n\' >&2; exit 1; }; sleep 1; done'
    : 'attempt=0; until runuser -u postgres -- pg_isready --timeout=2 >/dev/null 2>&1; do attempt=$((attempt + 1)); [ "$attempt" -lt 30 ] || { printf \'PostgreSQL did not become ready\\n\' >&2; exit 1; }; sleep 1; done'
  const create = engine === 'mariadb'
    ? `password="$(sed -n '1p' ${shellQuote(passwordFile)})"; test -n "$password"; printf "CREATE DATABASE IF NOT EXISTS ${databaseName}; CREATE USER IF NOT EXISTS '${databaseUser}'@'localhost' IDENTIFIED BY '%s'; ALTER USER '${databaseUser}'@'localhost' IDENTIFIED BY '%s'; GRANT ALL PRIVILEGES ON ${databaseName}.* TO '${databaseUser}'@'localhost'; FLUSH PRIVILEGES;\\n" "$password" "$password" | mariadb --protocol=socket -uroot`
    : `password="$(sed -n '1p' ${shellQuote(passwordFile)})"; test -n "$password"; if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${databaseUser}'" | grep -qx 1; then printf "CREATE ROLE ${databaseUser} LOGIN PASSWORD '%s';\\n" "$password" | runuser -u postgres -- psql --set ON_ERROR_STOP=1; fi; if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='${databaseName}'" | grep -qx 1; then runuser -u postgres -- createdb --owner=${databaseUser} ${databaseName}; fi`
  return [{
    id: 'start-database',
    phase: 'database',
    command: `${start}; ${readiness}`,
    purpose: `Start ${engine} and wait for bounded local administrative readiness.`,
    risk: 'change',
    timeoutMs: 60000,
    requiresSudo: true,
    dependsOn,
    diagnostic: { kind: 'database', target: service }
  }, {
    id: 'initialize-application-database',
    phase: 'database',
    command: create,
    purpose: 'Create only the task-owned database and user while reading the password from its protected host path.',
    risk: 'change',
    timeoutMs: 30000,
    requiresSudo: true,
    dependsOn: ['start-database'],
    diagnostic: { kind: 'database', target: service }
  }]
}

export function buildServicePhase ({ services, serviceManager, dependsOn }) {
  if (!Array.isArray(services) || services.length === 0 || services.some(value => !safeService(value))) throw new TypeError('service phase requires safe service names')
  if (!Array.isArray(dependsOn) || dependsOn.length === 0) throw new TypeError('service phase requires dependencies')
  return services.map((service, index) => ({
    id: `start-service-${index + 1}`,
    phase: 'services',
    command: `${serviceStartCommand(serviceManager, service)}; ${serviceStatusCommand(serviceManager, service)}`,
    purpose: `Start and verify the reviewed service ${service}.`,
    risk: 'change',
    timeoutMs: 60000,
    requiresSudo: true,
    dependsOn: index === 0 ? dependsOn : [`start-service-${index}`],
    diagnostic: { kind: 'service', target: service }
  }))
}

export function buildHttpHealthPhase ({ url, dependsOn }) {
  validateDiagnostic({ kind: 'http', target: url })
  if (!Array.isArray(dependsOn) || dependsOn.length === 0) throw new TypeError('health phase requires dependencies')
  return [{
    id: 'verify-application-http',
    phase: 'health',
    command: `attempt=0; until status="$(curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' ${shellQuote(url)})" && [ "$status" -ge 200 ] && [ "$status" -lt 400 ]; do attempt=$((attempt + 1)); [ "$attempt" -lt 30 ] || { display="$status"; [ -n "$display" ] || display=unreachable; printf 'application HTTP status=%s\\n' "$display" >&2; exit 1; }; sleep 1; done; printf 'application HTTP status=%s\\n' "$status"`,
    purpose: 'Wait for a bounded successful loopback HTTP response without exposing application content.',
    risk: 'read',
    timeoutMs: 60000,
    requiresSudo: false,
    dependsOn,
    diagnostic: { kind: 'http', target: url }
  }]
}

export function buildFoundationRevertCommands ({ taskId, applicationId, packageManager, dependsOn = [] }) {
  const directory = stateDirectory(taskId, applicationId)
  const remove = packageRemoveCommand(packageManager, `${directory}/packages.added`)
  return [{
    id: 'remove-added-packages',
    phase: 'cleanup',
    command: `if [ -d ${shellQuote(directory)} ] && [ -s ${shellQuote(`${directory}/packages.added`)} ]; then ${remove}; fi`,
    purpose: 'Remove only packages proven absent from the captured baseline.',
    risk: 'destructive',
    timeoutMs: 300000,
    requiresSudo: true,
    dependsOn
  }, {
    id: 'remove-task-created-credentials',
    phase: 'cleanup',
    command: `if [ -f ${shellQuote(`${directory}/credential.created`)} ]; then rm -f -- ${shellQuote(`/root/${applicationId}_credentials/database_password`)}; rmdir -- ${shellQuote(`/root/${applicationId}_credentials`)} 2>/dev/null || true; fi`,
    purpose: 'Remove credentials only when this task recorded creating them.',
    risk: 'destructive',
    timeoutMs: 30000,
    requiresSudo: true,
    dependsOn: ['remove-added-packages']
  }, {
    id: 'verify-exact-package-baseline',
    phase: 'baseline',
    command: `if [ -s ${shellQuote(`${directory}/baseline.sha256`)} ]; then ${packageSnapshotCommand(packageManager)} > ${shellQuote(`${directory}/versions.final`)}; sha256sum ${shellQuote(`${directory}/versions.final`)} | awk '{print $1}' > ${shellQuote(`${directory}/final.sha256`)}; cmp -s ${shellQuote(`${directory}/baseline.sha256`)} ${shellQuote(`${directory}/final.sha256`)} || { printf 'package baseline drift detected\\n' >&2; diff -u ${shellQuote(`${directory}/versions.before`)} ${shellQuote(`${directory}/versions.final`)} | sed -n '1,120p' >&2; exit 1; }; fi`,
    purpose: 'Require the complete installed-package/version fingerprint to match the pre-task baseline exactly.',
    risk: 'read',
    timeoutMs: 30000,
    requiresSudo: true,
    dependsOn: ['remove-task-created-credentials'],
    diagnostic: { kind: 'filesystem', target: `${directory}/versions.final` }
  }, {
    id: 'remove-foundation-state',
    phase: 'cleanup',
    command: `rm -rf -- ${shellQuote(directory)}`,
    purpose: 'Remove task baseline state only after exact comparison succeeds.',
    risk: 'destructive',
    timeoutMs: 30000,
    requiresSudo: true,
    dependsOn: ['verify-exact-package-baseline']
  }]
}

function packageSnapshotCommand (manager) {
  if (manager === 'apt') return 'dpkg-query -W -f=\'package=$' + '{binary:Package} version=$' + '{Version}\\n\' | LC_ALL=C sort'
  if (manager === 'dnf' || manager === 'yum' || manager === 'zypper') return 'rpm -qa --qf=\'package=%{NAME} version=%{VERSION}-%{RELEASE}.%{ARCH}\\n\' | LC_ALL=C sort'
  if (manager === 'apk') return 'apk info -vv | sed \'s/^/package=/\' | LC_ALL=C sort'
  if (manager === 'pacman') return 'pacman -Q | sed \'s/^/package=/\' | LC_ALL=C sort'
  throw new Error(`unsupported reviewed package manager: ${manager}`)
}

function packageNameSnapshotCommand (manager) {
  if (manager === 'apt') return 'dpkg-query -W -f=\'$' + '{binary:Package}\\n\' | LC_ALL=C sort -u'
  if (manager === 'dnf' || manager === 'yum' || manager === 'zypper') return 'rpm -qa --qf=\'%{NAME}\\n\' | LC_ALL=C sort -u'
  if (manager === 'apk') return 'apk info | LC_ALL=C sort -u'
  if (manager === 'pacman') return 'pacman -Qq | LC_ALL=C sort -u'
  throw new Error(`unsupported reviewed package manager: ${manager}`)
}

function packageRemoveCommand (manager, listPath) {
  const list = shellQuote(listPath)
  if (manager === 'apt') return `xargs -r apt-get purge -y -- < ${list}`
  if (manager === 'dnf') return `xargs -r dnf remove -y -- < ${list}`
  if (manager === 'yum') return `xargs -r yum remove -y -- < ${list}`
  if (manager === 'apk') return `xargs -r apk del -- < ${list}`
  if (manager === 'pacman') return `xargs -r pacman -Rns --noconfirm -- < ${list}`
  if (manager === 'zypper') return `xargs -r zypper --non-interactive remove -- < ${list}`
  throw new Error(`unsupported reviewed package manager: ${manager}`)
}

function serviceStartCommand (manager, service) {
  const target = shellQuote(service)
  if (manager === 'systemd') return `systemctl enable --now ${target}`
  if (manager === 'openrc') return `rc-update add ${target} default >/dev/null 2>&1 || true; rc-service ${target} restart`
  throw new Error(`unsupported reviewed service manager: ${manager}`)
}

function serviceStatusCommand (manager, service) {
  const target = shellQuote(service)
  if (manager === 'systemd') return `systemctl is-active --quiet ${target}`
  if (manager === 'openrc') return `rc-service ${target} status`
  throw new Error(`unsupported reviewed service manager: ${manager}`)
}

function stateDirectory (taskId, applicationId) {
  if (!Number.isInteger(taskId) || taskId < 1 || !safeId(applicationId)) throw new TypeError('deployment phase requires a task id and application id')
  return `/var/lib/webminai/tasks/${taskId}/${applicationId}`
}

function safeSqlIdentifier (value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,62}$/u.test(value)
}

function safeService (value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/u.test(value)
}

function safeId (value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,62}$/u.test(value)
}

function safePackage (value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9+_.:-]*$/u.test(value)
}

function shellQuote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
