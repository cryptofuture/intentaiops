export function buildWindowsBraveTask (taskId, windowsExecution) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  if (windowsExecution?.platform !== 'windows') throw new Error('Brave installation requires a Windows execution inventory')
  const state = `C:\\ProgramData\\WebminAI\\Tasks\\${taskId}-brave`
  const installer = `${state}\\BraveBrowserStandaloneSetup.exe`
  const downloadName = `WebminAI-Brave-${taskId}`
  const acquire = [
    "$ErrorActionPreference='Stop'",
    "$curl=Join-Path $env:SystemRoot 'System32\\curl.exe'",
    "$ProgressPreference='SilentlyContinue'",
    `$state='${state}'`,
    `$installer='${installer}'`,
    'New-Item -Path $state -ItemType Directory -Force|Out-Null',
    "$roots=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    "$before=@(Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName -like 'Brave*'})",
    "$baseline=Join-Path $state 'baseline.json'",
    "if(-not(Test-Path -LiteralPath $baseline)){[ordered]@{preExisting=[bool]$before;capturedAtUtc=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath $baseline -Encoding UTF8}",
    "if($before){Write-Output 'brave-already-installed';exit 0}",
    'Import-Module BitsTransfer -ErrorAction Stop',
    `$jobs=@(Get-BitsTransfer -Name '${downloadName}' -ErrorAction SilentlyContinue)`,
    "if($jobs.Count -gt 1){throw 'Multiple task-owned Brave transfers require inspection'};if($jobs.Count -eq 1){Write-Output 'brave-download-already-running';exit 0}",
    "$headers=@{'User-Agent'='WebminAI-BraveInstaller';Accept='application/vnd.github+json'}",
    "$release=Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/brave/brave-browser/releases/latest' -Headers $headers -TimeoutSec 60",
    "if($release.draft -or $release.prerelease){throw 'The latest Brave release endpoint returned a non-stable release.'}",
    "$asset=@($release.assets|Where-Object{$_.name -ceq 'BraveBrowserStandaloneSetup.exe'})|Select-Object -First 1",
    "$checksumAsset=@($release.assets|Where-Object{$_.name -ceq 'BraveBrowserStandaloneSetup.exe.sha256'})|Select-Object -First 1",
    "if(-not $asset -or -not $checksumAsset){throw 'Required Brave installer or checksum asset is absent.'}",
    "$checksumFile=Join-Path $state 'BraveBrowserStandaloneSetup.exe.sha256'",
    'if(Test-Path -LiteralPath $curl -PathType Leaf){$download=Start-Process -FilePath $curl -ArgumentList @(\'--fail\',\'--silent\',\'--show-error\',\'--location\',\'--connect-timeout\',\'15\',\'--max-time\',\'30\',\'--output\',(\'"\'+$checksumFile+\'"\'),(\'"\'+$checksumAsset.browser_download_url+\'"\')) -Wait -PassThru;if($download.ExitCode -ne 0){throw (\'Brave checksum download failed with curl exit code \'+$download.ExitCode)}}else{Invoke-WebRequest -UseBasicParsing -Uri $checksumAsset.browser_download_url -Headers $headers -OutFile $checksumFile -TimeoutSec 30 -ErrorAction Stop}',
    "if($asset.browser_download_url -notmatch '^https://github\\.com/brave/brave-browser/releases/download/[^/]+/BraveBrowserStandaloneSetup\\.exe$'){throw 'Unexpected Brave download source'}",
    "if(Test-Path -LiteralPath $installer){throw 'An existing installer without a transfer requires inspection'}",
    `Start-BitsTransfer -Source $asset.browser_download_url -Destination $installer -DisplayName '${downloadName}' -Description 'Intent AI Ops verified Brave installer' -Asynchronous|Out-Null`,
    "Write-Output 'brave-download-started'"
  ].join(';')
  const command = [
    "$ErrorActionPreference='Stop'",
    `$state='${state}';$installer='${installer}'`,
    "$baseline=Get-Content -LiteralPath (Join-Path $state 'baseline.json') -Raw|ConvertFrom-Json;if($baseline.preExisting){Write-Output 'brave-already-installed';exit 0}",
    "$checksumFile=Join-Path $state 'BraveBrowserStandaloneSetup.exe.sha256'",
    "$match=[regex]::Match((Get-Content -LiteralPath $checksumFile -Raw),'(?im)^\\s*([0-9a-f]{64})(?:\\s+.*)?$')",
    "if(-not $match.Success -or (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $match.Groups[1].Value){throw 'Brave installer checksum validation failed.'}",
    '$signature=Get-AuthenticodeSignature -LiteralPath $installer',
    "if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?i)Brave Software'){throw 'Brave installer signature validation failed.'}",
    "$process=Start-Process -FilePath $installer -ArgumentList @('/silent','/install') -Wait -PassThru",
    "if($process.ExitCode -ne 0){throw ('Brave installer failed with exit code '+$process.ExitCode)}",
    "[IO.File]::WriteAllText((Join-Path $state 'installed-by-task'),'yes',[Text.Encoding]::ASCII)",
    "Write-Output 'brave-installed'"
  ].join(';')
  return {
    plan: {
      summary: 'Install Brave Browser on Windows',
      changeOverview: 'Install the newest stable x64 Brave Browser from its official release assets with checksum and Authenticode verification.',
      modifiedFiles: [state, installer, 'C:\\Program Files\\BraveSoftware\\Brave-Browser'],
      assumptions: ['The host can reach the official Brave GitHub release assets.'],
      warnings: ['Rollback removes Brave only when this task recorded that it installed an initially absent product. User profiles remain untouched.'],
      requiresConfirmation: true,
      commands: [
        item('start-brave-download', acquire, 'Capture baseline and start one durable official Brave transfer', [], 300000, 'job'),
        { ...item('wait-brave-download', waitDownload(state, installer, downloadName), 'Observe the existing transfer without restarting acquisition', ['start-brave-download'], 30000), retry: { attempts: 120, intervalMs: 5000, exitCodes: [75] } },
        item('install-brave', command, 'Verify checksum and publisher, install Brave, and record ownership', ['wait-brave-download'], 300000, 'job'),
        item('verify-brave', verify(), 'Verify the machine-wide Brave executable, publisher signature and product version', ['install-brave'], 30000, undefined, 'read')
      ],
      revertCommands: [item('remove-task-owned-brave', revert(state, downloadName), 'Uninstall only task-owned Brave and remove task artifacts', [], 300000, 'job', 'destructive')]
    },
    verifyApplied: verify(),
    verifyReverted: `if(Test-Path -LiteralPath '${state}'){throw 'Brave task state remains.'};Write-Output 'revert-verified'`,
    stateProbe: `$ErrorActionPreference='Stop';$roots=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');$entries=@(Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName -like 'Brave*'}|Select-Object DisplayName,DisplayVersion|Sort-Object DisplayName,DisplayVersion);[ordered]@{entries=$entries;taskState=Test-Path -LiteralPath '${state}'}|ConvertTo-Json -Depth 3 -Compress`
  }
}

function waitDownload (state, installer, downloadName) {
  return [
    "$ErrorActionPreference='Stop'",
    `$state='${state}';$installer='${installer}'`,
    "$baseline=Get-Content -LiteralPath (Join-Path $state 'baseline.json') -Raw|ConvertFrom-Json;if($baseline.preExisting -or (Test-Path -LiteralPath (Join-Path $state 'installed-by-task'))){Write-Output 'brave-already-installed';exit 0}",
    'Import-Module BitsTransfer -ErrorAction Stop',
    `$jobs=@(Get-BitsTransfer -Name '${downloadName}' -ErrorAction SilentlyContinue)`,
    "if($jobs.Count -gt 1){throw 'Multiple task-owned Brave transfers require inspection'}",
    "if($jobs.Count -eq 0){if(Test-Path -LiteralPath $installer -PathType Leaf){Write-Output 'download-present';exit 0};throw 'Task-owned Brave transfer is unavailable'}",
    '$job=$jobs[0]',
    "if([string]$job.JobState -eq 'Transferred'){Complete-BitsTransfer -BitsJob $job;Write-Output 'download-completed';exit 0}",
    "if([string]$job.JobState -eq 'Error'){throw 'Brave BITS transfer failed; inspect the existing transfer before reviewing continuation'}",
    "Write-Output ('download-pending state='+$job.JobState+' bytes='+$job.BytesTransferred+'/'+$job.BytesTotal)",
    'exit 75'
  ].join(';')
}

function verify () {
  return [
    "$ErrorActionPreference='Stop'",
    "$roots=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    "$entry=Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName -like 'Brave*'}|Select-Object -First 1",
    "if(-not $entry){throw 'Brave is absent.'}",
    "$paths=@((Join-Path $env:ProgramFiles 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'));$x86=[Environment]::GetEnvironmentVariable('ProgramFiles(x86)');if($x86){$paths+=Join-Path $x86 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'}",
    '$file=@($paths|Where-Object{Test-Path -LiteralPath $_ -PathType Leaf})|Select-Object -First 1',
    "if(-not $file){throw 'Machine-wide Brave executable is absent.'}",
    '$signature=Get-AuthenticodeSignature -LiteralPath $file',
    "if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?i)Brave Software'){throw 'Installed Brave signature validation failed.'}",
    "if([string]::IsNullOrWhiteSpace([Diagnostics.FileVersionInfo]::GetVersionInfo($file).ProductVersion)){throw 'Installed Brave version is unavailable.'}",
    "Write-Output 'brave-verified'"
  ].join(';')
}

function revert (state, downloadName) {
  return `$state='${state}';if((Test-Path -LiteralPath (Join-Path $state 'installed-by-task'))){$roots=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');$entry=Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName -like 'Brave*'}|Select-Object -First 1;if($entry){$command=$(if($entry.QuietUninstallString){$entry.QuietUninstallString}else{$entry.UninstallString});if($command -match '^\\s*"([^"]+)"\\s*(.*)$'){$file=$matches[1];$args=$matches[2]}else{$parts=$command -split '\\s+',2;$file=$parts[0];$args=$(if($parts.Count -gt 1){$parts[1]}else{''})};if([IO.Path]::GetFileName($file) -ine 'setup.exe'){throw 'Unexpected Brave uninstaller; review cleanup'};$signature=Get-AuthenticodeSignature -LiteralPath $file;if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?i)Brave Software'){throw 'Brave uninstaller signature validation failed'};if($args -match '--delete-profile'){throw 'Brave rollback must preserve user profiles'};if($args -notmatch '(?:^|\\s)--force-uninstall(?:\\s|$)'){$args+=' --force-uninstall'};$process=Start-Process -FilePath $file -ArgumentList $args -Wait -PassThru;if($process.ExitCode -notin @(0,19)){throw ('Brave uninstall failed with exit code '+$process.ExitCode)}};if(@(Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName -like 'Brave*'}).Count -gt 0 -or (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'BraveSoftware\\\\Brave-Browser\\\\Application\\\\brave.exe'))){throw 'Brave remains installed after uninstall'}};Import-Module BitsTransfer -ErrorAction Stop;$jobs=@(Get-BitsTransfer -Name '${downloadName}' -ErrorAction SilentlyContinue);foreach($job in $jobs){Remove-BitsTransfer -BitsJob $job};if(Test-Path -LiteralPath $state){Remove-Item -LiteralPath $state -Recurse -Force};Write-Output 'task-owned-brave-removed'`
}

function item (id, command, purpose, dependsOn = [], timeoutMs = 300000, executionMode, risk = 'change') {
  return { id, command, purpose, risk, timeoutMs, requiresSudo: true, dependsOn, ...(executionMode ? { executionMode } : {}) }
}
