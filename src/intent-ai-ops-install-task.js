const POSIX_INSTALLER = 'https://raw.githubusercontent.com/cryptofuture/intentaiops/main/scripts/install.sh'
const WINDOWS_INSTALLER = 'https://raw.githubusercontent.com/cryptofuture/intentaiops/main/scripts/install.ps1'
const PACKAGE_URL = 'https://raw.githubusercontent.com/cryptofuture/intentaiops/main/dist/intent-ai-ops.tgz'

export function buildIntentAiOpsInstallTask (taskId, platform, source = {}) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  if (!['linux', 'freebsd', 'macos', 'windows'].includes(platform)) throw new Error(`Intent AI Ops installation does not support ${platform}`)
  const resolvedSource = installSource(platform, source)
  return platform === 'windows' ? windowsTask(taskId, resolvedSource) : posixTask(taskId, platform, resolvedSource)
}

function posixTask (taskId, platform, source) {
  const state = platform === 'linux'
    ? `/var/lib/webminai/tasks/${taskId}/intent-ai-ops-install`
    : `/var/db/webminai/task-state/${taskId}-intent-ai-ops-install`
  const root = platform === 'linux' ? '/opt/intent-ai-ops' : '/usr/local/share/intent-ai-ops'
  const bin = '/usr/local/bin'
  const home = platform === 'macos' ? '/var/root' : '/root'
  const packages = platform === 'freebsd' ? ['node24', 'npm-node24', 'python312', 'gmake'] : []
  const packageBaseline = packages.map(name => `pkg info -e ${quote(name)} >/dev/null 2>&1 && : > ${quote(`${state}/pkg-${name}.existed`)} || true`).join('; ')
  const removePackages = packages.slice().reverse().map(name => `[ -e ${quote(`${state}/pkg-${name}.existed`)} ] || pkg delete -y ${quote(name)} >/dev/null 2>&1 || true`).join('; ')
  const baseline = `set -eu; umask 077; install -d -m 0700 ${quote(state)}; if [ ! -e ${quote(`${state}/baseline`)} ]; then : > ${quote(`${state}/baseline`)}; command -v intentaiops > ${quote(`${state}/command.before`)} 2>/dev/null && : > ${quote(`${state}/preexisting`)} || true; [ ! -e ${quote(root)} ] || : > ${quote(`${state}/root.existed`)}; ${packageBaseline || ':'}; fi`
  const acquireInstaller = source.installerPath
    ? `cp -- ${quote(source.installerPath)} "$state/install.sh"`
    : `curl --fail --location --silent --show-error ${quote(source.installerUrl)} --output "$state/install.sh"`
  const install = `set -eu; state=${quote(state)}; root=${quote(root)}; bin=${quote(bin)}; [ ! -e "$state/preexisting" ] || { printf '%s\n' 'Intent AI Ops is already installed; leaving it unchanged'; exit 0; }; [ ! -e "$state/root.existed" ] || { printf '%s\n' 'INSTALL_ROOT_ALREADY_EXISTS: refusing to overwrite an unowned Intent AI Ops directory' >&2; exit 78; }; : > "$state/owns-root"; ${acquireInstaller}; chmod 0700 "$state/install.sh"; grep -Fq 'INTENTAI_OPS_PACKAGE_URL' "$state/install.sh"; HOME=${quote(home)} INTENTAI_OPS_PACKAGE_URL=${quote(source.packageUrl)} INTENTAI_OPS_INSTALL_ROOT="$root" INTENTAI_OPS_BIN_DIR="$bin" sh "$state/install.sh"; "$bin/intentaiops" --help >/dev/null; : > "$state/installed"`
  const revert = `set -eu; state=${quote(state)}; root=${quote(root)}; bin=${quote(bin)}; [ -d "$state" ] || exit 0; if [ -e "$state/owns-root" ]; then rm -f -- "$bin/intentaiops" "$bin/intentops"; rm -rf -- "$root"; ${removePackages || ':'}; fi; rm -rf -- "$state"`
  return {
    plan: {
      summary: `Install Intent AI Ops on ${platform}`,
      changeOverview: 'Install the reviewed GitHub package and Node.js 24 only when Node is absent, while preserving any existing installation.',
      modifiedFiles: [state, root, `${bin}/intentaiops`, `${bin}/intentops`],
      assumptions: ['The host can reach raw.githubusercontent.com, nodejs.org, and the npm registry.'],
      warnings: ['This installs the administration CLI on the selected host. Codex and working OpenSSH are still required before that host can administer other machines.'],
      requiresConfirmation: true,
      commands: [
        item('capture-intent-ai-ops-baseline', baseline, 'Capture the existing CLI, install root, and package baseline'),
        item('install-intent-ai-ops', install, 'Install Node.js only when absent, install Intent AI Ops, and verify its CLI', ['capture-intent-ai-ops-baseline'], 900000, 'job')
      ],
      revertCommands: [item('remove-task-owned-intent-ai-ops', revert, 'Remove only the CLI, runtime, links, and FreeBSD packages introduced by this task', [], 300000, 'job', 'destructive')]
    },
    verifyApplied: `[ -e ${quote(`${state}/preexisting`)} ] || ${quote(`${bin}/intentaiops`)} --help >/dev/null`,
    verifyReverted: `[ ! -e ${quote(state)} ]`,
    stateProbe: `if [ -e ${quote(`${state}/installed`)} ]; then printf 'intent-ai-ops=task-owned\n'; elif command -v intentaiops >/dev/null 2>&1; then printf 'intent-ai-ops=preexisting\n'; else printf 'intent-ai-ops=absent\n'; fi`
  }
}

function windowsTask (taskId, source) {
  const state = `C:\\ProgramData\\WebminAI\\Tasks\\${taskId}-intent-ai-ops-install`
  const root = 'C:\\ProgramData\\IntentAIOps'
  const bin = `${root}\\bin`
  const launcher = `${bin}\\intentaiops.cmd`
  const cli = `${root}\\npm\\node_modules\\intent-ai-ops\\bin\\intentaiops.js`
  const nodePath = `${root}\\node-path.txt`
  const baseline = `$ErrorActionPreference='Stop';$state='${state}';$root='${root}';New-Item -ItemType Directory -Path $state -Force|Out-Null;$baseline=Join-Path $state 'baseline';if(-not(Test-Path -LiteralPath $baseline)){New-Item -ItemType File -Path $baseline|Out-Null;if(Get-Command intentaiops.cmd -ErrorAction SilentlyContinue){New-Item -ItemType File -Path (Join-Path $state 'preexisting')|Out-Null};if(Test-Path -LiteralPath $root){New-Item -ItemType File -Path (Join-Path $state 'root.existed')|Out-Null}}`
  const acquireInstaller = source.installerPath
    ? `Copy-Item -LiteralPath '${powerShellString(source.installerPath)}' -Destination $installer`
    : `Invoke-WebRequest -UseBasicParsing -Uri '${powerShellString(source.installerUrl)}' -OutFile $installer`
  const install = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$state='${state}';$root='${root}';$bin='${bin}';if(Test-Path -LiteralPath (Join-Path $state 'preexisting')){Write-Output 'Intent AI Ops is already installed; leaving it unchanged';exit 0};if(Test-Path -LiteralPath (Join-Path $state 'root.existed')){throw 'INSTALL_ROOT_ALREADY_EXISTS: refusing to overwrite an unowned Intent AI Ops directory'};New-Item -ItemType File -Path (Join-Path $state 'owns-root') -Force|Out-Null;$installer=Join-Path $state 'install.ps1';${acquireInstaller};$text=Get-Content -LiteralPath $installer -Raw;if($text -notmatch 'INTENTAI_OPS_PACKAGE_URL'){throw 'Downloaded installer validation failed'};$env:INTENTAI_OPS_PACKAGE_URL='${powerShellString(source.packageUrl)}';$env:INTENTAI_OPS_INSTALL_ROOT=$root;$env:INTENTAI_OPS_BIN_DIR=$bin; & $installer;$node=(Get-Content -LiteralPath '${nodePath}' -Raw).Trim();$helpPath=Join-Path $state 'cli-help.txt';$errorPath=Join-Path $state 'cli-help.stderr.txt';$verification=Start-Process -FilePath $node -ArgumentList @('${cli}','--help') -Wait -PassThru -NoNewWindow -RedirectStandardOutput $helpPath -RedirectStandardError $errorPath;$helpText=Get-Content -LiteralPath $helpPath -Raw;if($verification.ExitCode -ne 0 -or $helpText -notmatch 'Usage: intentaiops'){throw ('Intent AI Ops verification failed with exit code '+$verification.ExitCode+'. '+(Get-Content -LiteralPath $errorPath -Raw))};$machinePath=[Environment]::GetEnvironmentVariable('Path','Machine');if(-not(($machinePath -split ';') -contains $bin)){[Environment]::SetEnvironmentVariable('Path',(($machinePath.TrimEnd(';')+';'+$bin).TrimStart(';')),'Machine');New-Item -ItemType File -Path (Join-Path $state 'machine-path-added')|Out-Null};New-Item -ItemType File -Path (Join-Path $state 'installed')|Out-Null`
  const revert = `$ErrorActionPreference='Stop';$state='${state}';$root='${root}';$bin='${bin}';if(-not(Test-Path -LiteralPath $state)){exit 0};if(Test-Path -LiteralPath (Join-Path $state 'owns-root')){if(Test-Path -LiteralPath (Join-Path $state 'machine-path-added')){$machinePath=[Environment]::GetEnvironmentVariable('Path','Machine');$next=(($machinePath -split ';'|Where-Object{$_ -and $_ -ne $bin}) -join ';');[Environment]::SetEnvironmentVariable('Path',$next,'Machine')};Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue};Remove-Item -LiteralPath $state -Recurse -Force`
  return {
    plan: {
      summary: 'Install Intent AI Ops on Windows',
      changeOverview: 'Install the reviewed GitHub package and a private Node.js 24 runtime only when Node is absent.',
      modifiedFiles: [state, root, launcher, nodePath],
      assumptions: ['The host can reach raw.githubusercontent.com, nodejs.org, and the npm registry.'],
      warnings: ['This installs the administration CLI and adds its task-owned launcher directory to the machine PATH. Codex must be installed and authenticated separately.'],
      requiresConfirmation: true,
      commands: [
        item('capture-intent-ai-ops-baseline', baseline, 'Capture the existing CLI, install root, and machine PATH baseline'),
        item('install-intent-ai-ops', install, 'Install Node.js only when absent, install Intent AI Ops, and verify its CLI', ['capture-intent-ai-ops-baseline'], 900000, 'job')
      ],
      revertCommands: [item('remove-task-owned-intent-ai-ops', revert, 'Remove only the task-owned CLI, runtime, and machine PATH entry', [], 300000, 'job', 'destructive')]
    },
    verifyApplied: `if(Test-Path -LiteralPath '${state}\\preexisting'){Write-Output 'intent-ai-ops=preexisting'}elseif((Test-Path -LiteralPath '${launcher}') -and (Test-Path -LiteralPath '${nodePath}')){$node=(Get-Content -LiteralPath '${nodePath}' -Raw).Trim();$helpPath=Join-Path '${state}' 'verify-help.txt';$errorPath=Join-Path '${state}' 'verify-help.stderr.txt';$verification=Start-Process -FilePath $node -ArgumentList @('${cli}','--help') -Wait -PassThru -NoNewWindow -RedirectStandardOutput $helpPath -RedirectStandardError $errorPath;$helpText=Get-Content -LiteralPath $helpPath -Raw;if($verification.ExitCode -ne 0 -or $helpText -notmatch 'Usage: intentaiops'){throw ('Intent AI Ops CLI verification failed with exit code '+$verification.ExitCode+'. '+(Get-Content -LiteralPath $errorPath -Raw))};Write-Output 'intent-ai-ops=installed'}else{throw 'Intent AI Ops is absent.'}`,
    verifyReverted: `if(Test-Path -LiteralPath '${state}'){throw 'Intent AI Ops task state remains.'};Write-Output 'revert-verified'`,
    stateProbe: `if(Test-Path -LiteralPath '${state}\\installed'){Write-Output 'intent-ai-ops=task-owned'}elseif(Get-Command intentaiops.cmd -ErrorAction SilentlyContinue){Write-Output 'intent-ai-ops=preexisting'}else{Write-Output 'intent-ai-ops=absent'}`
  }
}

function item (id, command, purpose, dependsOn = [], timeoutMs = 300000, executionMode, risk = 'change') {
  return { id, command, purpose, risk, timeoutMs, requiresSudo: true, dependsOn, ...(executionMode ? { executionMode } : {}) }
}

function quote (value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function powerShellString (value) {
  return String(value).replaceAll("'", "''")
}

function installSource (platform, source) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) throw new TypeError('Intent AI Ops install source must be an object')
  const installerUrl = source.installerUrl ?? (platform === 'windows' ? WINDOWS_INSTALLER : POSIX_INSTALLER)
  const installerPath = source.installerPath ?? null
  const packageUrl = source.packageUrl ?? PACKAGE_URL
  for (const [name, value] of Object.entries({ installerUrl, packageUrl })) {
    if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`)
  }
  if (installerPath !== null && (typeof installerPath !== 'string' || installerPath.trim() === '')) throw new TypeError('installerPath must be a non-empty string')
  return { installerUrl, installerPath, packageUrl }
}
