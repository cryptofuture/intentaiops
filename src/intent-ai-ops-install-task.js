const POSIX_INSTALLER = 'https://raw.githubusercontent.com/cryptofuture/intentaiops/main/scripts/install.sh'
const WINDOWS_INSTALLER = 'https://raw.githubusercontent.com/cryptofuture/intentaiops/main/scripts/install.ps1'
const PACKAGE_URL = 'https://raw.githubusercontent.com/cryptofuture/intentaiops/main/dist/intent-ai-ops.tgz'
const NODE_VERSION = '24.16.0'

export function buildIntentAiOpsInstallTask (taskId, platform, source = {}, linuxContext) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  if (!['linux', 'freebsd', 'macos', 'windows'].includes(platform)) throw new Error(`Intent AI Ops installation does not support ${platform}`)
  const resolvedSource = installSource(platform, source)
  return platform === 'windows' ? windowsTask(taskId, resolvedSource) : posixTask(taskId, platform, resolvedSource, linuxContext)
}

function posixTask (taskId, platform, source, linuxContext) {
  const state = platform === 'linux'
    ? `/var/lib/webminai/tasks/${taskId}/intent-ai-ops-install`
    : `/var/db/webminai/task-state/${taskId}-intent-ai-ops-install`
  const root = platform === 'linux' ? '/opt/intent-ai-ops' : '/usr/local/share/intent-ai-ops'
  const bin = '/usr/local/bin'
  const home = platform === 'macos' ? '/var/root' : '/root'
  const alpine = platform === 'linux' && linuxContext?.identity?.id === 'alpine'
  const packages = platform === 'freebsd' ? ['node24', 'npm-node24', 'python312', 'gmake'] : alpine ? ['nodejs', 'npm'] : []
  const packageBaseline = packages.map(name => `${alpine ? 'apk' : 'pkg'} info -e ${quote(name)} >/dev/null 2>&1 && : > ${quote(`${state}/pkg-${name}.existed`)} || true`).join('; ')
  const removePackages = platform === 'freebsd'
    ? 'test -s "$state/packages.before"; test -s "$state/packages.after"; LC_ALL=C comm -13 "$state/packages.before" "$state/packages.after" > "$state/packages.added"; if LC_ALL=C grep -Ev \'^[A-Za-z0-9][A-Za-z0-9_+.-]*$\' "$state/packages.added"; then exit 78; fi; added=$(tr \'\\n\' \' \' < "$state/packages.added"); [ -z "$added" ] || env ASSUME_ALWAYS_YES=yes pkg delete -y $added'
    : packages.slice().reverse().map(name => `[ -e ${quote(`${state}/pkg-${name}.existed`)} ] || ${alpine ? 'apk del' : 'pkg delete -y'} ${quote(name)}${alpine ? '' : ' >/dev/null 2>&1 || true'}`).join('; ')
  const baseline = `set -eu; test ! -L ${quote(state)}; umask 077; install -d -m 0700 ${quote(state)}; if [ ! -e ${quote(`${state}/baseline`)} ]; then : > ${quote(`${state}/baseline`)}; command -v intentaiops > ${quote(`${state}/command.before`)} 2>/dev/null && : > ${quote(`${state}/preexisting`)} || true; [ ! -e ${quote(root)} ] && [ ! -L ${quote(root)} ] || : > ${quote(`${state}/root.existed`)}; ${packageBaseline || ':'}; fi`
  const acquireInstaller = source.installerPath
    ? `cp -- ${quote(source.installerPath)} "$state/install.sh"`
    : `curl --fail --location --silent --show-error ${quote(source.installerUrl)} --output "$state/install.sh"`
  const checksum = platform === 'freebsd' ? 'sha256 -q' : platform === 'macos' ? 'shasum -a 256' : 'sha256sum'
  const acquirePackage = source.packageUrl === PACKAGE_URL
    ? [
        `curl --fail --location --retry 3 --retry-all-errors --retry-delay 2 --connect-timeout 15 --max-time 30 --max-filesize 4096 --silent --show-error ${quote(`${PACKAGE_URL}.sha256`)} --output "$state/package.sha256"`,
        `expected=$(awk 'NR == 1 {print $1}' "$state/package.sha256"); case "$expected" in ''|*[!0-9a-fA-F]*) printf '%s\\n' 'PACKAGE_CHECKSUM_INVALID' >&2; exit 1;; esac; [ "${'$'}{#expected}" -eq 64 ] || { printf '%s\\n' 'PACKAGE_CHECKSUM_INVALID' >&2; exit 1; }`,
        `curl --fail --location --retry 3 --retry-all-errors --retry-delay 2 --connect-timeout 15 --max-time 900 --max-filesize 134217728 --silent --show-error ${quote(PACKAGE_URL)} --output "$state/package.tgz"`,
        `actual=$(${checksum} "$state/package.tgz" | awk '{print $1}'); [ "$actual" = "$expected" ] || { printf '%s\\n' 'PACKAGE_CHECKSUM_MISMATCH' >&2; exit 1; }`
      ].join('; ') + '; '
    : ''
  const packageLocation = acquirePackage ? '"$state/package.tgz"' : quote(source.packageUrl)
  const runtime = platform === 'linux' ? 'umask 022; ' + (alpine ? '' : privateLinuxRuntime() + '; ') : platform === 'freebsd' ? 'if [ ! -e "$state/packages.before" ]; then pkg query -a \'%n\' | LC_ALL=C sort -u > "$state/packages.before"; fi; trap \'status=$?; pkg query -a \'\\\'\'%n\'\\\'\' | LC_ALL=C sort -u > "$state/packages.after"; exit "$status"\' EXIT; ' : ''
  const install = `set -eu; state=${quote(state)}; root=${quote(root)}; bin=${quote(bin)}; test ! -L "$state"; test -f "$state/baseline"; [ ! -e "$state/preexisting" ] || { printf '%s\n' 'Intent AI Ops is already installed; leaving it unchanged'; exit 0; }; if [ -e "$state/installed" ]; then test ! -L "$root"; "$bin/intentaiops" --help >/dev/null; exit 0; fi; [ ! -e "$state/root.existed" ] || { printf '%s\n' 'INSTALL_ROOT_ALREADY_EXISTS: refusing to overwrite an unowned Intent AI Ops directory' >&2; exit 78; }; for target in "$root" "$bin/intentaiops" "$bin/intentops"; do [ ! -e "$target" ] && [ ! -L "$target" ] || { printf '%s\\n' 'task target already exists: protected CLI installation path' >&2; exit 78; }; done; : > "$state/owns-root"; chmod 0600 "$state/owns-root"; ${runtime}${alpine ? 'apk add --no-cache nodejs npm; ' : ''}${acquireInstaller}; chmod 0700 "$state/install.sh"; grep -Fq 'INTENTAI_OPS_PACKAGE_URL' "$state/install.sh"; ${acquirePackage}HOME=${quote(home)} npm_config_cache="$state/npm-cache" NODE_OPTIONS="\${NODE_OPTIONS:-} --network-family-autoselection-attempt-timeout=5000" INTENTAI_OPS_PACKAGE_URL=${packageLocation} INTENTAI_OPS_INSTALL_ROOT="$root" INTENTAI_OPS_BIN_DIR="$bin" sh "$state/install.sh"; "$bin/intentaiops" --help >/dev/null; : > "$state/installed"; chmod 0600 "$state/installed"`
  const revert = `set -eu; state=${quote(state)}; root=${quote(root)}; bin=${quote(bin)}; [ -d "$state" ] || exit 0; test ! -L "$state"; if [ -e "$state/owns-root" ]; then rm -f -- "$bin/intentaiops" "$bin/intentops"; rm -rf -- "$root"; ${removePackages || ':'}; fi; rm -rf -- "$state"`
  return {
    plan: {
      summary: `Install Intent AI Ops on ${platform}`,
      changeOverview: platform === 'linux' && !alpine ? 'Install the reviewed GitHub package, reusing compatible Node.js or adding task-private Node.js 24 without changing an incompatible system runtime.' : 'Install the reviewed GitHub package and Node.js 24 only when Node is absent, while preserving any existing installation.',
      modifiedFiles: [state, root, `${bin}/intentaiops`, `${bin}/intentops`],
      assumptions: ['The host can reach raw.githubusercontent.com, nodejs.org, and the npm registry.'],
      warnings: ['This installs the administration CLI on the selected host. Codex and working OpenSSH are still required before that host can administer other machines.'],
      requiresConfirmation: true,
      commands: [
        item('capture-intent-ai-ops-baseline', baseline, 'Capture the existing CLI, install root, and package baseline'),
        item('install-intent-ai-ops', install, platform === 'linux' && !alpine ? 'Preserve system Node.js, add a compatible private runtime when needed, install Intent AI Ops and verify its CLI' : 'Install Node.js only when absent, install Intent AI Ops, and verify its CLI', ['capture-intent-ai-ops-baseline'], platform === 'linux' ? 1800000 : 900000, 'job')
      ],
      revertCommands: [item('remove-task-owned-intent-ai-ops', revert, 'Remove only the CLI, runtime, links, and FreeBSD packages introduced by this task', [], 300000, 'job', 'destructive')]
    },
    verifyApplied: `[ -e ${quote(`${state}/preexisting`)} ] || ${quote(`${bin}/intentaiops`)} --help >/dev/null`,
    verifyReverted: `[ ! -e ${quote(state)} ]`,
    stateProbe: `if [ -e ${quote(`${state}/installed`)} ]; then printf 'intent-ai-ops=task-owned\n'; elif command -v intentaiops >/dev/null 2>&1; then printf 'intent-ai-ops=preexisting\n'; else printf 'intent-ai-ops=absent\n'; fi`
  }
}

function privateLinuxRuntime () {
  const compatible = "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major>24||(major===24&&minor>=7)?0:1)"
  return [
    `if command -v node >/dev/null 2>&1 && ! node -e ${quote(compatible)} >/dev/null 2>&1; then`,
    "case $(uname -m) in x86_64|amd64) node_arch=x64;; aarch64|arm64) node_arch=arm64;; *) printf '%s\\n' 'UNSUPPORTED_PRIVATE_NODE_ARCHITECTURE' >&2; exit 1;; esac",
    `archive="node-v${NODE_VERSION}-linux-$node_arch.tar.gz"`,
    `curl --fail --location --retry 3 --retry-all-errors --retry-delay 2 --connect-timeout 15 --max-time 900 --max-filesize 134217728 --silent --show-error "https://nodejs.org/dist/v${NODE_VERSION}/$archive" --output "$state/node-runtime.tar.gz"`,
    `curl --fail --location --retry 3 --retry-all-errors --retry-delay 2 --connect-timeout 15 --max-time 30 --max-filesize 65536 --silent --show-error 'https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt' --output "$state/node-runtime.sha256"`,
    "expected=$(awk -v name=\"$archive\" '$2 == name {print $1}' \"$state/node-runtime.sha256\"); case \"$expected\" in ''|*[!0-9a-fA-F]*) printf '%s\\n' 'NODE_CHECKSUM_INVALID' >&2; exit 1;; esac",
    `[ "${'$'}{#expected}" -eq 64 ] || exit 1`,
    'actual=$(sha256sum "$state/node-runtime.tar.gz" | awk \'{print $1}\'); [ "$actual" = "$expected" ] || { printf \'%s\\n\' NODE_CHECKSUM_MISMATCH >&2; exit 1; }',
    'install -d -m 0755 "$root" "$root/runtime"',
    'tar -xzf "$state/node-runtime.tar.gz" --no-same-owner -C "$root/runtime" --strip-components=1',
    `"$root/runtime/bin/node" -e ${quote(compatible)}`,
    'test -x "$root/runtime/bin/npm"',
    'PATH="$root/runtime/bin:$PATH"; export PATH',
    'rm -f -- "$state/node-runtime.tar.gz" "$state/node-runtime.sha256"', 'fi'
  ].join('\n')
}

function windowsTask (taskId, source) {
  const state = `C:\\ProgramData\\WebminAI\\Tasks\\${taskId}-intent-ai-ops-install`
  const root = 'C:\\ProgramData\\IntentAIOps\\Cli'
  const bin = `${root}\\bin`
  const launcher = `${bin}\\intentaiops.cmd`
  const cli = `${root}\\npm\\node_modules\\intent-ai-ops\\bin\\intentaiops.js`
  const nodePath = `${root}\\node-path.txt`
  const registryPaths = "$registryPaths=@{Machine='Registry::HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';User='Registry::HKEY_CURRENT_USER\\Environment'}"
  const baseline = [
    "$ErrorActionPreference='Stop'",
    `$state='${state}';$root='${root}'`,
    'New-Item -ItemType Directory -Path $state -Force|Out-Null',
    "$baseline=Join-Path $state 'baseline'",
    registryPaths,
    "if(-not(Test-Path -LiteralPath $baseline)){$paths=[ordered]@{version=2};foreach($scope in @('Machine','User')){$key=Get-Item -LiteralPath $registryPaths[$scope];try{$raw=$key.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);$kind=if($null -eq $raw){$null}else{[string]$key.GetValueKind('Path')};if($null -ne $raw -and ($raw -isnot [string] -or $kind -notin @('String','ExpandString'))){throw 'Unsupported PATH registry type'};$paths[$scope]=@{raw=$raw;kind=$kind;value=[Environment]::GetEnvironmentVariable('Path',$scope)}}finally{$key.Close()}};$paths|ConvertTo-Json -Depth 4 -Compress|Set-Content -LiteralPath (Join-Path $state 'paths-before.json') -Encoding UTF8;if((Get-Command intentaiops.cmd -ErrorAction SilentlyContinue) -or ((Test-Path -LiteralPath '" + launcher + "' -PathType Leaf) -and (Test-Path -LiteralPath '" + nodePath + "' -PathType Leaf))){New-Item -ItemType File -Path (Join-Path $state 'preexisting')|Out-Null};if(Test-Path -LiteralPath $root){New-Item -ItemType File -Path (Join-Path $state 'root.existed')|Out-Null};if(-not(([Environment]::GetEnvironmentVariable('Path','User') -split ';') -contains '" + bin + "')){New-Item -ItemType File -Path (Join-Path $state 'user-path-was-absent')|Out-Null};New-Item -ItemType File -Path $baseline|Out-Null}"
  ].join(';')
  const acquireInstaller = source.installerPath
    ? `Copy-Item -LiteralPath '${powerShellString(source.installerPath)}' -Destination $installer`
    : `Invoke-WebRequest -UseBasicParsing -Uri '${powerShellString(source.installerUrl)}' -OutFile $installer`
  const install = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$state='${state}';$root='${root}';$bin='${bin}';if(Test-Path -LiteralPath (Join-Path $state 'preexisting')){Write-Output 'Intent AI Ops is already installed; leaving it unchanged';exit 0};if(Test-Path -LiteralPath (Join-Path $state 'root.existed')){throw 'INSTALL_ROOT_ALREADY_EXISTS: refusing to overwrite an unowned Intent AI Ops directory'};if(-not(Test-Path -LiteralPath (Join-Path $state 'paths-before.json') -PathType Leaf)){throw 'PATH baseline is missing; inspect task state before installation'};New-Item -ItemType File -Path (Join-Path $state 'owns-root') -Force|Out-Null;$installer=Join-Path $state 'install.ps1';${acquireInstaller};$text=Get-Content -LiteralPath $installer -Raw;if($text -notmatch 'INTENTAI_OPS_PACKAGE_URL'){throw 'Downloaded installer validation failed'};$env:INTENTAI_OPS_PACKAGE_URL='${powerShellString(source.packageUrl)}';$env:INTENTAI_OPS_INSTALL_ROOT=$root;$env:INTENTAI_OPS_BIN_DIR=$bin; & $installer;$node=(Get-Content -LiteralPath '${nodePath}' -Raw).Trim();$helpPath=Join-Path $state 'cli-help.txt';$errorPath=Join-Path $state 'cli-help.stderr.txt';$verification=Start-Process -FilePath $node -ArgumentList @('${cli}','--help') -Wait -PassThru -NoNewWindow -RedirectStandardOutput $helpPath -RedirectStandardError $errorPath;$helpText=Get-Content -LiteralPath $helpPath -Raw;if($verification.ExitCode -ne 0 -or $helpText -notmatch 'Usage: intentaiops'){throw ('Intent AI Ops verification failed with exit code '+$verification.ExitCode+'. '+(Get-Content -LiteralPath $errorPath -Raw))};$machinePath=[Environment]::GetEnvironmentVariable('Path','Machine');if(-not(($machinePath -split ';') -contains $bin)){New-Item -ItemType File -Path (Join-Path $state 'machine-path-added')|Out-Null;[Environment]::SetEnvironmentVariable('Path',(($machinePath.TrimEnd(';')+';'+$bin).TrimStart(';')),'Machine')};New-Item -ItemType File -Path (Join-Path $state 'installed')|Out-Null`
  const revert = [
    "$ErrorActionPreference='Stop'",
    `$state='${state}';$root='${root}';$bin='${bin}'`,
    registryPaths,
    'if(-not(Test-Path -LiteralPath $state)){exit 0}',
    "if(Test-Path -LiteralPath (Join-Path $state 'owns-root')){$pathFile=Get-Item -LiteralPath (Join-Path $state 'paths-before.json');if($pathFile.Length -gt 262144){throw 'PATH baseline exceeds limit'};$paths=Get-Content -LiteralPath $pathFile.FullName -Raw|ConvertFrom-Json;if($paths.version -ne 2){throw 'PATH baseline lacks registry metadata; review cleanup'};$restore=@{};foreach($scope in @('Machine','User')){$marker=if($scope -eq 'Machine'){'machine-path-added'}else{'user-path-was-absent'};if(Test-Path -LiteralPath (Join-Path $state $marker)){$saved=$paths.$scope;if($null -eq $saved -or @($saved.PSObject.Properties.Name).Count -ne 3 -or @('raw','kind','value'|Where-Object {$_ -notin $saved.PSObject.Properties.Name}).Count){throw 'Invalid PATH baseline'};$original=$saved.value;if(($null -ne $original -and $original -isnot [string]) -or ($null -ne $saved.raw -and ($saved.raw -isnot [string] -or $saved.kind -notin @('String','ExpandString'))) -or ($null -eq $saved.raw -and $null -ne $saved.kind)){throw 'Invalid PATH baseline'};$current=[Environment]::GetEnvironmentVariable('Path',$scope);$expected=(([string]$original).TrimEnd(';')+';'+$bin).TrimStart(';');$key=Get-Item -LiteralPath $registryPaths[$scope];try{$raw=$key.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);$kind=if($null -eq $raw){$null}else{[string]$key.GetValueKind('Path')};$unchanged=$raw -ceq $saved.raw -and $kind -ceq $saved.kind;$taskChanged=$raw -ceq $expected -and $kind -in @('String','ExpandString');if(($current -cne $expected -and $current -cne $original) -or (-not $unchanged -and -not $taskChanged)){throw ('PATH_CHANGED: preserve unrelated '+$scope+' PATH changes and review cleanup')};$restore[$scope]=$saved}finally{$key.Close()}}};foreach($scope in $restore.Keys){$saved=$restore[$scope];$parent=Get-Item -LiteralPath $registryPaths[$scope];$key=$parent.OpenSubKey('',$true);$parent.Close();try{if($null -eq $saved.raw){$key.DeleteValue('Path',$false)}else{$key.SetValue('Path',$saved.raw,[Microsoft.Win32.RegistryValueKind]$saved.kind)};$key.Flush()}finally{$key.Close()}};if(Test-Path -LiteralPath $root){Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop}}",
    'Remove-Item -LiteralPath $state -Recurse -Force -ErrorAction Stop'
  ].join(';')
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
    verifyApplied: `if((Test-Path -LiteralPath '${launcher}') -and (Test-Path -LiteralPath '${nodePath}')){$node=(Get-Content -LiteralPath '${nodePath}' -Raw).Trim();$helpPath=Join-Path '${state}' 'verify-help.txt';$errorPath=Join-Path '${state}' 'verify-help.stderr.txt';$verification=Start-Process -FilePath $node -ArgumentList @('${cli}','--help') -Wait -PassThru -NoNewWindow -RedirectStandardOutput $helpPath -RedirectStandardError $errorPath;$helpText=Get-Content -LiteralPath $helpPath -Raw;if($verification.ExitCode -ne 0 -or $helpText -notmatch 'Usage: intentaiops'){throw ('Intent AI Ops CLI verification failed with exit code '+$verification.ExitCode+'. '+(Get-Content -LiteralPath $errorPath -Raw))};Write-Output 'intent-ai-ops=installed'}elseif(Test-Path -LiteralPath '${state}\\preexisting'){Write-Output 'intent-ai-ops=preexisting'}else{throw 'Intent AI Ops is absent.'}`,
    verifyReverted: `if(Test-Path -LiteralPath '${state}'){throw 'Intent AI Ops task state remains.'};Write-Output 'revert-verified'`,
    stateProbe: `${registryPaths};function PathDigest($scope){$key=Get-Item -LiteralPath $registryPaths[$scope];$sha=[Security.Cryptography.SHA256]::Create();try{$raw=$key.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);$kind=if($null -eq $raw){$null}else{[string]$key.GetValueKind('Path')};$encoded=[ordered]@{raw=$raw;kind=$kind}|ConvertTo-Json -Compress;return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($encoded)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose();$key.Close()}};$cliState=if(Test-Path -LiteralPath '${state}\\installed'){'task-owned'}elseif((Get-Command intentaiops.cmd -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath '${launcher}' -PathType Leaf)){'preexisting'}else{'absent'};[ordered]@{cliState=$cliState;rootExists=Test-Path -LiteralPath '${root}';taskState=Test-Path -LiteralPath '${state}';machinePathDigest=(PathDigest 'Machine');userPathDigest=(PathDigest 'User')}|ConvertTo-Json -Compress`
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
