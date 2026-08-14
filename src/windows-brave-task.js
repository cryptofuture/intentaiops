export function buildWindowsBraveTask (taskId, windowsExecution) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  if (windowsExecution?.platform !== 'windows') throw new Error('Brave installation requires a Windows execution inventory')
  const state = `C:\\ProgramData\\WebminAI\\Tasks\\${taskId}-brave`
  const installer = `${state}\\BraveBrowserStandaloneSetup.exe`
  const command = [
    "$ErrorActionPreference='Stop'",
    `$state='${state}'`,
    `$installer='${installer}'`,
    'New-Item -Path $state -ItemType Directory -Force|Out-Null',
    "$roots=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    "$before=@(Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName -like 'Brave*'})",
    "$baseline=Join-Path $state 'baseline.json'",
    "if(-not(Test-Path -LiteralPath $baseline)){[ordered]@{preExisting=[bool]$before;capturedAtUtc=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath $baseline -Encoding UTF8}",
    "if($before){Write-Output 'brave-already-installed';exit 0}",
    "$headers=@{'User-Agent'='WebminAI-BraveInstaller';Accept='application/vnd.github+json'}",
    "$release=Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/brave/brave-browser/releases/latest' -Headers $headers -TimeoutSec 60",
    "if($release.draft -or $release.prerelease){throw 'The latest Brave release endpoint returned a non-stable release.'}",
    "$asset=@($release.assets|Where-Object{$_.name -ceq 'BraveBrowserStandaloneSetup.exe'})|Select-Object -First 1",
    "$checksumAsset=@($release.assets|Where-Object{$_.name -ceq 'BraveBrowserStandaloneSetup.exe.sha256'})|Select-Object -First 1",
    "if(-not $asset -or -not $checksumAsset){throw 'Required Brave installer or checksum asset is absent.'}",
    "$checksumFile=Join-Path $state 'BraveBrowserStandaloneSetup.exe.sha256'",
    'Invoke-WebRequest -UseBasicParsing -Uri $checksumAsset.browser_download_url -Headers $headers -OutFile $checksumFile -TimeoutSec 300',
    'Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -Headers $headers -OutFile $installer -TimeoutSec 300',
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
      commands: [item('install-brave', command, 'Capture baseline, verify the official installer, install Brave, and verify ownership')],
      revertCommands: [item('remove-task-owned-brave', revert(state), 'Uninstall only task-owned Brave and remove task artifacts', [], 300000, undefined, 'destructive')]
    },
    verifyApplied: verify(),
    verifyReverted: `if(Test-Path -LiteralPath '${state}'){throw 'Brave task state remains.'};Write-Output 'revert-verified'`,
    stateProbe: verify()
  }
}

function verify () {
  return "$roots=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');$entry=Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName -like 'Brave*'}|Select-Object -First 1;if(-not $entry){throw 'Brave is absent.'};Write-Output 'brave-verified'"
}

function revert (state) {
  return `$state='${state}';if((Test-Path -LiteralPath (Join-Path $state 'installed-by-task'))){$roots=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');$entry=Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName -like 'Brave*'}|Select-Object -First 1;if($entry){$command=$(if($entry.QuietUninstallString){$entry.QuietUninstallString}else{$entry.UninstallString});if($command -match '^\\s*"([^"]+)"\\s*(.*)$'){$file=$matches[1];$args=$matches[2]}else{$parts=$command -split '\\s+',2;$file=$parts[0];$args=$(if($parts.Count -gt 1){$parts[1]}else{''})};$process=Start-Process -FilePath $file -ArgumentList $args -Wait -PassThru;if($process.ExitCode -ne 0){throw ('Brave uninstall failed with exit code '+$process.ExitCode)}}};if(Test-Path -LiteralPath $state){Remove-Item -LiteralPath $state -Recurse -Force};Write-Output 'task-owned-brave-removed'`
}

function item (id, command, purpose, dependsOn = [], timeoutMs = 300000, executionMode, risk = 'change') {
  return { id, command, purpose, risk, timeoutMs, requiresSudo: true, dependsOn, ...(executionMode ? { executionMode } : {}) }
}
