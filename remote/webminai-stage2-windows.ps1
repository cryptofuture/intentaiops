param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('Activate', 'Deactivate', 'Commit', 'RollbackActivation')]
    [string]$Action,

    [Parameter(Position = 1)]
    [string]$PluginSource,

    [Parameter(Position = 2)]
    [ValidateSet('install-if-needed', 'require-existing', 'keep-netdata', 'remove-managed')]
    [string]$Mode = 'keep-netdata',

    [Parameter(Position = 3)]
    [string]$PluginVersion,

    [Parameter(Position = 4)]
    [string]$CommandRunnerSource
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'

$StateDirectory = Join-Path $env:ProgramData 'WebminAI'
$KeyFile = Join-Path $StateDirectory 'action.key'
$RunnerFile = Join-Path $StateDirectory 'stage2.ps1'
$CommandRunnerFile = Join-Path $StateDirectory 'command-runner.ps1'
$OwnershipMarker = Join-Path $StateDirectory 'netdata-owned'
$BackupPlugin = Join-Path $StateDirectory 'webminai.plugin.previous.exe'
$BackupVersion = Join-Path $StateDirectory 'webminai.plugin.previous.version'
$JobsDirectory = Join-Path $StateDirectory 'jobs'
$BeginMarker = '# BEGIN WEBMINAI MANAGED BLOCK'
$EndMarker = '# END WEBMINAI MANAGED BLOCK'
$NetdataDownload = 'https://github.com/netdata/netdata/releases/latest/download/netdata-x64.msi'

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Windows Stage 2 activation requires an elevated administrator OpenSSH session'
    }
}

function Write-Result([hashtable]$Value) {
    Write-Output ('WEBMINAI_RESULT ' + ($Value | ConvertTo-Json -Compress))
}

function Get-NetdataService {
    return Get-CimInstance Win32_Service -Filter "Name='Netdata'" -ErrorAction SilentlyContinue
}

function Get-NetdataPrefix {
    $service = Get-NetdataService
    if (-not $service) { return $null }
    $path = [string]$service.PathName
    if ($path.StartsWith('"')) { $executable = $path.Split('"')[1] }
    else { $executable = $path.Split(' ')[0] }
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        $candidate = Join-Path $env:ProgramFiles 'Netdata\usr\bin\netdata.exe'
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $null }
        $executable = $candidate
    }
    return Split-Path (Split-Path (Split-Path $executable -Parent) -Parent) -Parent
}

function Get-NetdataPluginDirectory([string]$Prefix) {
    $candidates = @(
        (Join-Path $Prefix 'usr\libexec\netdata\plugins.d'),
        (Join-Path $Prefix 'usr\lib\netdata\plugins.d')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Container) { return $candidate }
    }
    $found = Get-ChildItem -LiteralPath $Prefix -Directory -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'plugins.d' } |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $found) { throw "Netdata plugins.d directory was not found below $Prefix" }
    return $found
}

function Remove-ManagedConfig([string]$ConfigFile) {
    if (-not (Test-Path -LiteralPath $ConfigFile -PathType Leaf)) { return }
    $content = [IO.File]::ReadAllText($ConfigFile)
    $pattern = '(?ms)^' + [regex]::Escape($BeginMarker) + '.*?^' + [regex]::Escape($EndMarker) + '\r?\n?'
    $updated = [regex]::Replace($content, $pattern, '')
    if ($updated -ne $content) {
        [IO.File]::WriteAllText($ConfigFile, $updated, [Text.UTF8Encoding]::new($false))
    }
}

function Set-ManagedConfig([string]$ConfigFile) {
    $parent = Split-Path $ConfigFile -Parent
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    if (-not (Test-Path -LiteralPath $ConfigFile)) {
        [IO.File]::WriteAllText($ConfigFile, '', [Text.UTF8Encoding]::new($false))
    }
    Remove-ManagedConfig $ConfigFile
    $content = [IO.File]::ReadAllText($ConfigFile)
    if ($content.Length -gt 0 -and -not $content.EndsWith("`n")) { $content += "`r`n" }
    $content += @"
$BeginMarker
[web]
    bind to = 127.0.0.1 ::1
[plugins]
    webminai = yes
$EndMarker
"@
    [IO.File]::WriteAllText($ConfigFile, $content, [Text.UTF8Encoding]::new($false))
}

function Set-RestrictedAcl([string]$Path, [switch]$Directory) {
    $inheritance = if ($Directory) {
        [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    } else {
        [Security.AccessControl.InheritanceFlags]::None
    }
    $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $administratorsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $system = [Security.AccessControl.FileSystemAccessRule]::new(
        $systemSid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance,
        [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $administrators = [Security.AccessControl.FileSystemAccessRule]::new(
        $administratorsSid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance,
        [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    if (-not $Directory) { $acl = [Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetAccessRule($system)
    $acl.SetAccessRule($administrators)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Install-Netdata {
    $msi = Join-Path $env:TEMP ('webminai-netdata-' + [guid]::NewGuid().ToString('N') + '.msi')
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $NetdataDownload -OutFile $msi
        $process = Start-Process msiexec.exe -ArgumentList @('/qn', '/i', $msi, '/norestart') -Wait -PassThru
        if ($process.ExitCode -notin @(0, 3010)) { throw "Netdata MSI failed with exit code $($process.ExitCode)" }
    } finally {
        Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
    }
}

function Restart-Netdata {
    $service = Get-Service -Name Netdata
    if ($service.Status -eq 'Running') { Restart-Service -Name Netdata -Force }
    else { Start-Service -Name Netdata }
    $service = Get-Service -Name Netdata
    $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
}

function Invoke-WithNetdataStopped([scriptblock]$Operation) {
    $service = Get-Service -Name Netdata
    if ($service.Status -ne 'Stopped') {
        Stop-Service -Name Netdata -Force
        $service = Get-Service -Name Netdata
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    try { & $Operation }
    finally { Restart-Netdata }
}

function Get-InstalledPluginVersion([string]$PluginPath) {
    if (-not (Test-Path -LiteralPath $PluginPath -PathType Leaf)) { return 'none' }
    try { return (& $PluginPath --version | Select-Object -First 1).Trim() }
    catch { return 'unknown' }
}

function Get-NetdataProductCode {
    $roots = @(
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    $entry = Get-ItemProperty $roots -ErrorAction SilentlyContinue |
        Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like 'Netdata*' } |
        Select-Object -First 1
    if ($entry -and [string]$entry.PSChildName -match '^\{[0-9A-Fa-f-]+\}$') { return [string]$entry.PSChildName }
    return $null
}

function Remove-ManagedNetdata {
    $productCode = Get-NetdataProductCode
    if (-not $productCode) { throw 'managed Netdata MSI product code was not found' }
    $process = Start-Process msiexec.exe -ArgumentList @('/qn', '/x', $productCode, '/norestart') -Wait -PassThru
    if ($process.ExitCode -notin @(0, 1605, 3010)) { throw "Netdata uninstall failed with exit code $($process.ExitCode)" }
}

function Invoke-Activate {
    Assert-Administrator
    if (-not $PluginSource -or -not (Test-Path -LiteralPath $PluginSource -PathType Leaf)) {
        throw 'Windows plugin artifact is missing'
    }
    if (-not $CommandRunnerSource -or -not (Test-Path -LiteralPath $CommandRunnerSource -PathType Leaf)) {
        throw 'Windows command runner is missing'
    }
    if ($PluginVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'invalid plugin version' }
    if ((& $PluginSource --platform | Select-Object -First 1).Trim() -ne 'windows') { throw 'plugin artifact platform mismatch' }
    if ((& $PluginSource --version | Select-Object -First 1).Trim() -ne $PluginVersion) { throw 'plugin artifact version mismatch' }

    New-Item -ItemType Directory -Force -Path $StateDirectory | Out-Null
    Set-RestrictedAcl $StateDirectory -Directory
    $hadNetdata = [bool](Get-NetdataService)
    if (-not $hadNetdata) {
        if ($Mode -eq 'require-existing') { throw 'Netdata is required for plugin-only activation' }
        Install-Netdata
        New-Item -ItemType File -Force -Path $OwnershipMarker | Out-Null
    }

    $service = Get-NetdataService
    if (-not $service) { throw 'Netdata service was not installed' }
    if ([string]$service.StartName -notin @('LocalSystem', 'Local System')) {
        throw "Netdata service must run as LocalSystem, found $($service.StartName)"
    }
    $prefix = Get-NetdataPrefix
    if (-not $prefix) { throw 'Netdata installation prefix could not be resolved' }
    $pluginDirectory = Get-NetdataPluginDirectory $prefix
    $pluginPath = Join-Path $pluginDirectory 'webminai.plugin.exe'
    $previousVersion = Get-InstalledPluginVersion $pluginPath
    $pluginAction = if ($previousVersion -eq 'none') { 'installed' } elseif ($previousVersion -eq $PluginVersion) { 'unchanged' } else { 'updated' }
    if ($pluginAction -eq 'updated') {
        Copy-Item -LiteralPath $pluginPath -Destination $BackupPlugin -Force
        [IO.File]::WriteAllText($BackupVersion, $previousVersion, [Text.Encoding]::ASCII)
    }

    Invoke-WithNetdataStopped {
        Copy-Item -LiteralPath $PluginSource -Destination $pluginPath -Force
        [IO.File]::WriteAllText($KeyFile, ([Console]::In.ReadLine() + "`n"), [Text.Encoding]::ASCII)
        $keyText = [IO.File]::ReadAllText($KeyFile).Trim()
        if ($keyText -notmatch '^[0-9A-Fa-f]{64}$') { throw 'invalid action key' }
        Copy-Item -LiteralPath $PSCommandPath -Destination $RunnerFile -Force
        Copy-Item -LiteralPath $CommandRunnerSource -Destination $CommandRunnerFile -Force
        Set-RestrictedAcl $pluginPath
        Set-RestrictedAcl $KeyFile
        Set-RestrictedAcl $RunnerFile
        Set-RestrictedAcl $CommandRunnerFile
        Set-ManagedConfig (Join-Path $prefix 'etc\netdata\netdata.conf')
    }

    Write-Result @{
        ownership = if (Test-Path -LiteralPath $OwnershipMarker) { 'managed' } else { 'preexisting' }
        status = 'active'
        platform = 'windows'
        netdataAction = if ($hadNetdata) { 'existing' } else { 'installed' }
        pluginAction = $pluginAction
        pluginVersion = $PluginVersion
        previousPluginVersion = $previousVersion
    }
}

function Invoke-Commit {
    Assert-Administrator
    Remove-Item -LiteralPath $BackupPlugin, $BackupVersion -Force -ErrorAction SilentlyContinue
    Write-Result @{ status = 'committed' }
}

function Invoke-RollbackActivation {
    Assert-Administrator
    $prefix = Get-NetdataPrefix
    if (-not $prefix) { throw 'Netdata installation prefix could not be resolved' }
    $pluginPath = Join-Path (Get-NetdataPluginDirectory $prefix) 'webminai.plugin.exe'
    if (-not (Test-Path -LiteralPath $BackupPlugin -PathType Leaf)) { throw 'previous Windows plugin backup is unavailable' }
    Invoke-WithNetdataStopped {
        Copy-Item -LiteralPath $BackupPlugin -Destination $pluginPath -Force
        Set-RestrictedAcl $pluginPath
        Remove-Item -LiteralPath $BackupPlugin, $BackupVersion -Force -ErrorAction SilentlyContinue
    }
    Write-Result @{ status = 'rolled-back' }
}

function Invoke-Deactivate {
    Assert-Administrator
    $owned = Test-Path -LiteralPath $OwnershipMarker
    $prefix = Get-NetdataPrefix
    if ($prefix) {
        $installedPlugin = Join-Path (Get-NetdataPluginDirectory $prefix) 'webminai.plugin.exe'
        if (Test-Path -LiteralPath $installedPlugin -PathType Leaf) {
            & $installedPlugin --cancel-all-jobs
            if ($LASTEXITCODE -ne 0) { throw 'failed to cancel active Intent AI Ops jobs' }
        }
        Invoke-WithNetdataStopped {
            $pluginDirectory = Get-NetdataPluginDirectory $prefix
            Remove-Item -LiteralPath (Join-Path $pluginDirectory 'webminai.plugin.exe') -Force -ErrorAction SilentlyContinue
            Remove-ManagedConfig (Join-Path $prefix 'etc\netdata\netdata.conf')
        }
    }
    Remove-Item -LiteralPath $KeyFile, $BackupPlugin, $BackupVersion -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $JobsDirectory -Recurse -Force -ErrorAction SilentlyContinue
    if ($Mode -eq 'remove-managed' -and $owned) { Remove-ManagedNetdata }
    $ownership = if ($owned) { 'managed' } elseif ($prefix) { 'preexisting' } else { 'unknown' }
    Write-Result @{ ownership = $ownership; status = 'inactive'; platform = 'windows' }
    Remove-Item -LiteralPath $OwnershipMarker, $RunnerFile, $CommandRunnerFile -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $StateDirectory) {
        Remove-Item -LiteralPath $StateDirectory -Force -ErrorAction SilentlyContinue
    }
}

switch ($Action) {
    'Activate' { Invoke-Activate }
    'Deactivate' { Invoke-Deactivate }
    'Commit' { Invoke-Commit }
    'RollbackActivation' { Invoke-RollbackActivation }
}
