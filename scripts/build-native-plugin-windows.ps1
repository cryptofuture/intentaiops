$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Source = Join-Path $ProjectRoot 'plugin\webminai.plugin.windows.c'
$Version = (Get-Content (Join-Path $ProjectRoot 'plugin\VERSION') -Raw).Trim()
$OutputDirectory = Join-Path $ProjectRoot 'dist'
$Output = Join-Path $OutputDirectory 'webminai.plugin-windows-amd64.exe'

if ($env:PROCESSOR_ARCHITECTURE -notin @('AMD64', 'x86')) {
    throw "The Windows plugin currently supports only x64; detected $env:PROCESSOR_ARCHITECTURE"
}
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    throw 'cl.exe is required. Run this script from an x64 Visual Studio Developer PowerShell.'
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$Arguments = @(
    '/nologo',
    '/O2',
    '/W4',
    '/WX',
    '/std:c17',
    '/MT',
    '/DUNICODE',
    '/D_UNICODE',
    "/DWEBMINAI_PLUGIN_VERSION=`"$Version`"",
    $Source,
    '/link',
    '/SUBSYSTEM:CONSOLE',
    '/MACHINE:X64',
    'bcrypt.lib',
    'advapi32.lib',
    "/OUT:$Output"
)

& cl.exe @Arguments
if ($LASTEXITCODE -ne 0) {
    throw "Windows plugin compilation failed with exit code $LASTEXITCODE"
}

$Headers = & dumpbin.exe /headers $Output
if ($LASTEXITCODE -ne 0 -or $Headers -notmatch 'machine \(x64\)') {
    throw 'The Windows plugin artifact is not an x64 PE executable.'
}

$Manifest = Join-Path $OutputDirectory 'SHA256SUMS'
$TemporaryManifest = "$Manifest.$([Guid]::NewGuid().ToString('N')).tmp"
$Artifacts = @(Get-ChildItem -LiteralPath $OutputDirectory -File | Where-Object {
    $_.Name -eq 'webminai.plugin' -or $_.Name -like 'webminai.plugin-*'
} | Sort-Object -Property Name)
if ($Artifacts.Count -eq 0) {
    throw 'No Intent AI Ops plugin artifacts were found for the checksum manifest.'
}
$ChecksumLines = @($Artifacts | ForEach-Object {
    $Digest = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$Digest  $($_.Name)"
})
try {
    [IO.File]::WriteAllLines($TemporaryManifest, $ChecksumLines, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $TemporaryManifest -Destination $Manifest -Force
} finally {
    if (Test-Path -LiteralPath $TemporaryManifest) {
        Remove-Item -LiteralPath $TemporaryManifest -Force
    }
}

Write-Host "Built $Output"
Write-Host "Wrote $($Artifacts.Count) checksums to $Manifest"
