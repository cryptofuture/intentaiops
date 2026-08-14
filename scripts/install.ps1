$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$packageUrl = if ($env:INTENTAI_OPS_PACKAGE_URL) { $env:INTENTAI_OPS_PACKAGE_URL } else { 'https://raw.githubusercontent.com/cryptofuture/intentaiops/main/dist/intent-ai-ops.tgz' }
$installRoot = if ($env:INTENTAI_OPS_INSTALL_ROOT) { $env:INTENTAI_OPS_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'IntentAIOps' }
$binDirectory = if ($env:INTENTAI_OPS_BIN_DIR) { $env:INTENTAI_OPS_BIN_DIR } else { Join-Path $installRoot 'bin' }
$nodeVersion = '24.16.0'

if ($args -contains '--help' -or $args -contains '-h') {
  Write-Output 'Usage: irm https://raw.githubusercontent.com/cryptofuture/intentaiops/main/scripts/install.ps1 | iex'
  Write-Output 'Installs a private Node.js 24 runtime only when node is absent, then installs Intent AI Ops.'
  Write-Output 'Override the package for testing with INTENTAI_OPS_PACKAGE_URL.'
  exit 0
}

New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
New-Item -ItemType Directory -Path $binDirectory -Force | Out-Null
$node = Get-Command node.exe -ErrorAction SilentlyContinue
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue

if ($node) {
  $installedVersion = [version](& $node.Source -p 'process.versions.node')
  if ($installedVersion -lt [version]'24.7.0') {
    throw "Node.js $installedVersion is installed, but Intent AI Ops requires 24.7 or newer. Upgrade it explicitly and rerun this installer."
  }
  if (-not $npm) { throw 'npm is missing from the installed Node.js runtime.' }
  $nodeCommand = $node.Source
  $npmCommand = $npm.Source
} else {
  $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  if ($architecture -eq 'x64') { $nodeArchitecture = 'x64' }
  elseif ($architecture -eq 'arm64') { $nodeArchitecture = 'arm64' }
  else { throw "Unsupported Node.js architecture: $architecture" }
  $archive = "node-v$nodeVersion-win-$nodeArchitecture.zip"
  $temporary = Join-Path ([IO.Path]::GetTempPath()) ("intentaiops-install-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temporary | Out-Null
  try {
    $archivePath = Join-Path $temporary $archive
    Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$nodeVersion/$archive" -OutFile $archivePath
    $checksums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt").Content
    $match = [regex]::Match($checksums, "(?m)^([a-f0-9]{64})\s+$([regex]::Escape($archive))$")
    if (-not $match.Success) { throw 'Node.js checksum is unavailable.' }
    $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $match.Groups[1].Value) { throw 'Node.js checksum verification failed.' }
    $runtime = Join-Path $installRoot 'runtime'
    Remove-Item -LiteralPath $runtime -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -LiteralPath $archivePath -DestinationPath $temporary
    Move-Item -LiteralPath (Join-Path $temporary "node-v$nodeVersion-win-$nodeArchitecture") -Destination $runtime
    $nodeCommand = Join-Path $runtime 'node.exe'
    $npmCommand = Join-Path $runtime 'npm.cmd'
  } finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$prefix = Join-Path $installRoot 'npm'
$nodeDirectory = Split-Path -Parent $nodeCommand
$systemDirectory = [Environment]::SystemDirectory
$windowsDirectory = Split-Path -Parent $systemDirectory
$childPath = "$nodeDirectory;$systemDirectory;$windowsDirectory"
$env:Path = "$childPath;$env:Path"
$npmStdoutPath = Join-Path $installRoot 'npm-install.stdout.log'
$npmStderrPath = Join-Path $installRoot 'npm-install.stderr.log'
$npmCli = Join-Path (Split-Path -Parent $npmCommand) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path -LiteralPath $npmCli)) { throw "npm-cli.js was not found beside $npmCommand." }
$npmWrapper = Join-Path $installRoot 'npm-install.cmd'
$npmWrapperText = "@echo off`r`nset `"PATH=$childPath`"`r`n`"$nodeCommand`" `"$npmCli`" install --global --prefix `"$prefix`" `"$packageUrl`"`r`nexit /b %ERRORLEVEL%`r`n"
Set-Content -LiteralPath $npmWrapper -Encoding ASCII -Value $npmWrapperText
$npmProcess = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', "`"$npmWrapper`"") -Wait -PassThru -NoNewWindow -RedirectStandardOutput $npmStdoutPath -RedirectStandardError $npmStderrPath
$npmOutput = if (Test-Path -LiteralPath $npmStdoutPath) { Get-Content -LiteralPath $npmStdoutPath -Raw } else { '' }
$npmError = if (Test-Path -LiteralPath $npmStderrPath) { Get-Content -LiteralPath $npmStderrPath -Raw } else { '' }
if ($npmProcess.ExitCode -ne 0) { throw "Intent AI Ops package installation failed with exit code $($npmProcess.ExitCode).`n$npmOutput`n$npmError" }
if ($npmOutput) { $npmOutput | Write-Output }
if ($npmError) { $npmError | Write-Warning }
Remove-Item -LiteralPath $npmStdoutPath, $npmStderrPath, $npmWrapper -Force -ErrorAction SilentlyContinue
$launcher = Join-Path $prefix 'intentaiops.cmd'
Set-Content -LiteralPath (Join-Path $binDirectory 'intentaiops.cmd') -Encoding ASCII -Value "@echo off`r`nset `"PATH=$nodeDirectory;%PATH%`"`r`ncall `"$launcher`" %*`r`n"
Set-Content -LiteralPath (Join-Path $installRoot 'node-path.txt') -Encoding ASCII -Value $nodeCommand
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $binDirectory)) {
  [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $binDirectory).TrimStart(';')), 'User')
}
$env:Path = "$binDirectory;$env:Path"
Write-Output 'OK: Intent AI Ops is installed.'
Write-Output 'Run: intentaiops'
