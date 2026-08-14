const DOCKER_DESKTOP_VERSION = '4.86.0'
const DOCKER_DESKTOP_BUILD = '236216'
const DOCKER_INSTALLER_URL = `https://desktop.docker.com/win/main/amd64/${DOCKER_DESKTOP_BUILD}/DockerDesktop.msi`
const DOCKER_INSTALLER_SHA256 = 'b80a2e8d0b33b752b74f31c82019f62bb0335e6960722af934a7186a0e921682'
const WSL_VERSION = '2.7.11'
const WSL_INSTALLER_URL = `https://github.com/microsoft/WSL/releases/download/${WSL_VERSION}/wsl.${WSL_VERSION}.0.x64.msi`
const WSL_INSTALLER_SHA256 = 'a611ddacee689d2fb1fb5319e58af7f3998864d86cdce632eadd8e61614a0f9d'

export function buildWindowsDockerBootstrapTask (taskId, windowsExecution, docker, { continuation = null } = {}) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  if (windowsExecution?.platform !== 'windows') throw new Error('Windows Docker bootstrap requires a Windows execution inventory')
  if (docker?.preference === 'disabled') throw new Error('Docker is disabled for this host')

  const state = `C:\\ProgramData\\WebminAI\\Tasks\\${taskId}-windows-docker`
  const installer = `${state}\\DockerDesktop.msi`
  const wslInstaller = `${state}\\wsl.${WSL_VERSION}.0.x64.msi`
  const wslDownloadName = `WebminAI-WSL-${taskId}`
  const dockerDownloadName = `WebminAI-Docker-${taskId}`
  const dockerStartTaskName = `WebminAI-Docker-Start-${taskId}`
  const commands = [
    item('validate-virtualization', virtualizationCommand(), 'Verify that hardware virtualization is exposed to Windows before any other Docker or WSL check'),
    item('preflight', preflightCommand(state), 'Validate the supported Windows, memory, and SLAT baseline before mutation', ['validate-virtualization']),
    item('enable-wsl', enableWslCommand(state), 'Enable WSL and VirtualMachinePlatform only when absent and record whether Windows requires a reboot', ['preflight']),
    item('start-wsl-download', startWslDownloadCommand(state, wslInstaller, wslDownloadName), `Start the durable BITS download for Microsoft WSL ${WSL_VERSION}`, ['enable-wsl']),
    pollItem('wait-wsl-download', waitDownloadCommand(wslInstaller, wslDownloadName, 'C:\\Program Files\\WSL\\wsl.exe'), 'Poll and complete the Microsoft WSL BITS transfer through short Stage 2 requests', ['start-wsl-download']),
    item('verify-wsl-installer', verifyWslCommand(state, wslInstaller), `Verify the SHA-256 and Authenticode signature for Microsoft WSL ${WSL_VERSION}`, ['wait-wsl-download']),
    item('install-wsl-runtime', installWslCommand(state, wslInstaller), `Install Microsoft WSL ${WSL_VERSION} unattended through Windows Installer`, ['verify-wsl-installer']),
    item('start-docker-download', startDockerDownloadCommand(state, installer, dockerDownloadName), `Start the durable BITS download for Docker Desktop ${DOCKER_DESKTOP_VERSION}`, ['install-wsl-runtime']),
    pollItem('wait-docker-download', waitDownloadCommand(installer, dockerDownloadName, 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'), 'Poll and complete the Docker Desktop BITS transfer through short Stage 2 requests', ['start-docker-download']),
    item('verify-docker-installer', verifyDockerCommand(state, installer), `Verify the published checksum and Authenticode signature for Docker Desktop ${DOCKER_DESKTOP_VERSION}`, ['wait-docker-download']),
    item('install-docker-desktop', installDockerCommand(state, installer), `Install Docker Desktop ${DOCKER_DESKTOP_VERSION} for all users with the WSL 2 backend`, ['verify-docker-installer']),
    item('start-docker-desktop', startDockerCommand(state, dockerStartTaskName), 'Start Docker Desktop with the active Windows console user token outside the bounded Stage 2 process job', ['install-docker-desktop']),
    pollItem('wait-docker-ready', waitDockerCommand(state, dockerStartTaskName), 'Poll for the Docker Linux engine and Compose with short bounded CLI probes', ['start-docker-desktop']),
    item('schedule-required-reboot', rebootCommand(state, taskId), 'Schedule a self-removing LocalSystem reboot job with a 30-second delay only when an approved prerequisite phase recorded that Windows requires one', ['wait-docker-ready'])
  ]
  const continuationText = continuation
    ? ` After the host reconnects, rerun the ${continuation} request; Intent AI Ops will continue the prerequisite or deploy the application when Docker is ready.`
    : ' After a prerequisite reboot, rerun this task to continue from the observed host state.'

  return {
    plan: {
      summary: 'Install and enable WSL 2 and Docker Desktop on Windows',
      changeOverview: `Prepare a supported Windows 11 host for Linux-container Docker Compose through an ownership-aware, reboot-resumable WSL 2 and Docker Desktop ${DOCKER_DESKTOP_VERSION} installation.${continuationText}`,
      modifiedFiles: [state, wslInstaller, installer, 'C:\\Program Files\\WSL', 'C:\\Program Files\\Docker\\Docker', 'C:\\ProgramData\\DockerDesktop'],
      assumptions: [
        'The host is a supported x64 Windows 11 client with SLAT, at least 8 GiB RAM, and firmware virtualization enabled.',
        'Docker Desktop licensing is acceptable to the administrator approving the install command.',
        'A reboot is a separate visible command and occurs only when an earlier phase records it as required.'
      ],
      warnings: [
        'Enabling virtualization features and installing Docker Desktop are machine-wide changes.',
        `Docker Desktop ${DOCKER_DESKTOP_VERSION} is pinned to Docker's official Windows MSI build, locally pinned SHA-256, and Authenticode publisher.`,
        continuationText.trim()
      ],
      requiresConfirmation: true,
      commands,
      revertCommands: [
        item('uninstall-task-owned-docker', uninstallDockerCommand(state), 'Uninstall Docker Desktop only when this task proved it introduced the installation', [], 300000, undefined, 'destructive'),
        item('uninstall-task-owned-wsl', uninstallWslCommand(state, wslInstaller), 'Uninstall the WSL runtime only when this task proved it introduced the MSI', ['uninstall-task-owned-docker'], 300000, undefined, 'destructive'),
        item('restore-task-owned-features', restoreFeaturesCommand(state), 'Disable only Windows features that this task changed from the disabled baseline', ['uninstall-task-owned-wsl'], 300000, undefined, 'destructive'),
        item('remove-bootstrap-state', cleanupCommand(state, [wslDownloadName, dockerDownloadName], [dockerStartTaskName]), 'Cancel task-owned transfers/startup jobs and remove the task-owned installers and bootstrap metadata after rollback', ['restore-task-owned-features'], 30000, undefined, 'destructive')
      ]
    },
    verifyApplied: verifyCommand(),
    verifyReverted: `if(Test-Path -LiteralPath '${quote(state)}'){throw 'Windows Docker bootstrap state remains.'};Write-Output 'revert-verified'`,
    stateProbe: stateProbeCommand(state)
  }
}

function preflightCommand (state) {
  return ps([
    "$ErrorActionPreference='Stop'",
    '$os=Get-CimInstance Win32_OperatingSystem',
    '$computer=Get-CimInstance Win32_ComputerSystem',
    '$cpu=Get-CimInstance Win32_Processor|Select-Object -First 1',
    "if($os.ProductType -ne 1 -or [int]$os.BuildNumber -lt 22631){throw 'UNSUPPORTED_WINDOWS_VERSION: Docker Desktop requires a supported Windows 11 client build.'}",
    "if(-not [Environment]::Is64BitOperatingSystem){throw 'UNSUPPORTED_ARCHITECTURE: x64 Windows is required.'}",
    "if($computer.TotalPhysicalMemory -lt 8GB){throw 'INSUFFICIENT_MEMORY: Docker Desktop requires at least 8 GiB RAM.'}",
    "if(-not $computer.HypervisorPresent -and -not $cpu.SecondLevelAddressTranslationExtensions){throw 'SLAT_UNAVAILABLE: the processor does not expose second-level address translation and no running Windows hypervisor proves that capability.'}",
    `$statePath='${quote(state)}'`,
    '$baseline=Join-Path $statePath \'baseline.json\'',
    "if(-not(Test-Path -LiteralPath $baseline)){if(Test-Path -LiteralPath $statePath){throw 'Bootstrap state exists without a valid baseline.'};New-Item -Path $statePath -ItemType Directory -Force|Out-Null;$features=@{};foreach($name in @('Microsoft-Windows-Subsystem-Linux','VirtualMachinePlatform')){$feature=Get-WindowsOptionalFeature -Online -FeatureName $name -ErrorAction Stop;$features[$name]=[string]$feature.State};$docker=Test-Path -LiteralPath 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe' -PathType Leaf;$wsl=Test-Path -LiteralPath 'C:\\Program Files\\WSL\\wsl.exe' -PathType Leaf;[ordered]@{features=$features;dockerExisted=[bool]$docker;wslRuntimeExisted=[bool]$wsl;capturedAtUtc=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $baseline -Encoding UTF8}",
    "Write-Output 'windows-docker-preflight-passed'"
  ])
}

function virtualizationCommand () {
  return ps([
    "$ErrorActionPreference='Stop'",
    '$computer=Get-CimInstance Win32_ComputerSystem',
    '$cpu=Get-CimInstance Win32_Processor|Select-Object -First 1',
    "if(-not $computer.HypervisorPresent -and -not $cpu.VirtualizationFirmwareEnabled){throw 'FIRMWARE_VIRTUALIZATION_DISABLED: Windows cannot see hardware virtualization. On a physical AMD host, enable SVM Mode or AMD-V in BIOS/UEFI; on Intel, enable Intel Virtualization Technology (VT-x). Save the firmware settings, fully restart Windows, and rerun this task. If Windows is itself a VM, enable nested virtualization in the outer hypervisor instead.'}",
    "[pscustomobject]@{firmwareVirtualization=[bool]$cpu.VirtualizationFirmwareEnabled;hypervisorPresent=[bool]$computer.HypervisorPresent;status='virtualization-ready'}|ConvertTo-Json -Compress"
  ])
}

function enableWslCommand (state) {
  return ps([
    "$ErrorActionPreference='Stop'",
    `$statePath='${quote(state)}'`,
    '$progress=Join-Path $statePath \'progress.json\'',
    "$pendingReboot=Test-Path -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending'",
    '$values=[ordered]@{rebootRequired=$false;pendingRebootBefore=[bool]$pendingReboot;featuresChanged=@()}',
    "foreach($name in @('Microsoft-Windows-Subsystem-Linux','VirtualMachinePlatform')){$feature=Get-WindowsOptionalFeature -Online -FeatureName $name -ErrorAction Stop;if([string]$feature.State -ne 'Enabled'){$result=Enable-WindowsOptionalFeature -Online -FeatureName $name -All -NoRestart -ErrorAction Stop;$values.featuresChanged+=@($name);if($result.RestartNeeded){$values.rebootRequired=$true}}}",
    "foreach($name in @('Microsoft-Windows-Subsystem-Linux','VirtualMachinePlatform')){if([string](Get-WindowsOptionalFeature -Online -FeatureName $name).State -ne 'Enabled'){$values.rebootRequired=$true}}",
    '$values|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $progress -Encoding UTF8',
    "Write-Output $(if($values.rebootRequired){'WEBMINAI_REBOOT_REQUIRED'}else{'wsl-features-ready'})"
  ])
}

function startWslDownloadCommand (state, installer, downloadName) {
  return guarded(state, [
    "$installed='C:\\Program Files\\WSL\\wsl.exe'",
    "if(Test-Path -LiteralPath $installed -PathType Leaf){Write-Output 'wsl-runtime-already-installed';exit 0}",
    `$installer='${quote(installer)}'`,
    'Import-Module BitsTransfer -ErrorAction Stop',
    `$existing=Get-BitsTransfer -Name '${quote(downloadName)}' -ErrorAction SilentlyContinue|Select-Object -First 1`,
    "if($existing){Write-Output 'wsl-download-already-running';exit 0}",
    'if(Test-Path -LiteralPath $installer){Remove-Item -LiteralPath $installer -Force}',
    `Start-BitsTransfer -Source '${WSL_INSTALLER_URL}' -Destination $installer -DisplayName '${quote(downloadName)}' -Description 'Intent AI Ops verified WSL runtime' -Asynchronous|Out-Null`,
    "Write-Output 'wsl-download-started'"
  ])
}

function verifyWslCommand (state, installer) {
  return guarded(state, [
    "$installed='C:\\Program Files\\WSL\\wsl.exe'",
    "if(Test-Path -LiteralPath $installed -PathType Leaf){Write-Output 'wsl-runtime-already-installed';exit 0}",
    `$installer='${quote(installer)}'`,
    "if(-not(Test-Path -LiteralPath $installer -PathType Leaf)){throw 'Downloaded WSL installer is missing.'}",
    `$expected='${WSL_INSTALLER_SHA256}'`,
    "$actual=(Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant();if($actual -ne $expected){Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue;throw 'WSL installer SHA-256 validation failed.'}",
    "$signature=Get-AuthenticodeSignature -LiteralPath $installer;if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?i)Microsoft'){Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue;throw 'WSL installer Authenticode validation failed.'}",
    "Write-Output 'wsl-installer-verified'"
  ])
}

function installWslCommand (state, installer) {
  return guarded(state, [
    "$installed='C:\\Program Files\\WSL\\wsl.exe'",
    "if(Test-Path -LiteralPath $installed -PathType Leaf){Write-Output 'wsl-runtime-already-installed';exit 0}",
    `$installer='${quote(installer)}'`,
    "if(-not(Test-Path -LiteralPath $installer -PathType Leaf)){throw 'Verified WSL installer is missing.'}",
    "$signature=Get-AuthenticodeSignature -LiteralPath $installer;if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?i)Microsoft'){throw 'WSL installer Authenticode validation failed immediately before execution.'}",
    "$process=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\msiexec.exe') -ArgumentList @('/i',$installer,'/qn','/norestart') -Wait -PassThru",
    "if($process.ExitCode -notin @(0,3010)){throw ('WSL MSI installation failed with exit code '+$process.ExitCode)}",
    '$progress|Add-Member -NotePropertyName wslInstalledByTask -NotePropertyValue $true -Force;if($process.ExitCode -eq 3010){$progress.rebootRequired=$true};$progress|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $progressPath -Encoding UTF8',
    "if(-not $progress.rebootRequired -and -not(Test-Path -LiteralPath $installed -PathType Leaf)){throw 'WSL_RUNTIME_UNAVAILABLE: the WSL MSI completed without installing its runtime.'}",
    "Write-Output $(if($progress.rebootRequired){'WEBMINAI_REBOOT_REQUIRED'}else{'wsl-runtime-ready'})"
  ])
}

function startDockerDownloadCommand (state, installer, downloadName) {
  return guarded(state, [
    "$dockerPath='C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'",
    "if(Test-Path -LiteralPath $dockerPath -PathType Leaf){Write-Output 'docker-desktop-already-installed';exit 0}",
    `$installer='${quote(installer)}'`,
    'Import-Module BitsTransfer -ErrorAction Stop',
    `$existing=Get-BitsTransfer -Name '${quote(downloadName)}' -ErrorAction SilentlyContinue|Select-Object -First 1`,
    "if($existing){Write-Output 'docker-download-already-running';exit 0}",
    'if(Test-Path -LiteralPath $installer){Remove-Item -LiteralPath $installer -Force}',
    `Start-BitsTransfer -Source '${DOCKER_INSTALLER_URL}' -Destination $installer -DisplayName '${quote(downloadName)}' -Description 'Intent AI Ops verified Docker Desktop MSI' -Asynchronous|Out-Null`,
    "Write-Output 'docker-download-started'"
  ])
}

function verifyDockerCommand (state, installer) {
  return guarded(state, [
    "$dockerPath='C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'",
    "if(Test-Path -LiteralPath $dockerPath -PathType Leaf){Write-Output 'docker-desktop-already-installed';exit 0}",
    `$installer='${quote(installer)}'`,
    "if(-not(Test-Path -LiteralPath $installer -PathType Leaf)){throw 'Downloaded Docker Desktop installer is missing.'}",
    `$expected='${DOCKER_INSTALLER_SHA256}'`,
    '$actual=(Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash',
    "if($actual.ToLowerInvariant() -ne $expected){throw 'Docker Desktop installer SHA-256 validation failed.'}",
    '$signature=Get-AuthenticodeSignature -LiteralPath $installer',
    "if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?i)Docker'){throw 'Docker Desktop installer Authenticode validation failed.'}",
    "Write-Output 'docker-desktop-installer-verified'"
  ])
}

function waitDownloadCommand (installer, downloadName, installedPath) {
  return ps([
    "$ErrorActionPreference='Stop'",
    `if(Test-Path -LiteralPath '${quote(installedPath)}' -PathType Leaf){Write-Output 'runtime-already-installed';exit 0}`,
    `if(Test-Path -LiteralPath '${quote(installer)}' -PathType Leaf){Write-Output 'download-present';exit 0}`,
    'Import-Module BitsTransfer -ErrorAction Stop',
    `$job=Get-BitsTransfer -Name '${quote(downloadName)}' -ErrorAction SilentlyContinue|Select-Object -First 1`,
    "if(-not $job){throw 'Task-owned BITS download was not found.'}",
    "if([string]$job.JobState -eq 'Transferred'){Complete-BitsTransfer -BitsJob $job;Write-Output 'download-completed';exit 0}",
    "if([string]$job.JobState -eq 'Error'){throw ('BITS download failed: '+$job.ErrorDescription)}",
    "Write-Output ('download-pending state='+$job.JobState+' bytes='+$job.BytesTransferred+'/'+$job.BytesTotal)",
    'exit 75'
  ])
}

function installDockerCommand (state, installer) {
  return guarded(state, [
    "$dockerPath='C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'",
    "if(Test-Path -LiteralPath $dockerPath -PathType Leaf){Write-Output 'docker-desktop-already-installed';exit 0}",
    `$installer='${quote(installer)}'`,
    "if(-not(Test-Path -LiteralPath $installer -PathType Leaf)){throw 'Verified Docker Desktop installer is missing.'}",
    '$signature=Get-AuthenticodeSignature -LiteralPath $installer',
    "if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?i)Docker'){throw 'Docker Desktop installer Authenticode validation failed immediately before execution.'}",
    '$log=Join-Path $statePath \'docker-msi-install.log\'',
    "$process=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\msiexec.exe') -ArgumentList @('/i',$installer,'/L*V',$log,'/qn','/norestart','ENGINE=wsl','ALWAYSRUNSERVICE=1','DISABLEWINDOWSCONTAINERS=1','DISABLEANALYTICS=1') -Wait -PassThru",
    "if($process.ExitCode -notin @(0,3010)){throw ('Docker Desktop MSI installation failed with exit code '+$process.ExitCode+'; verbose log: '+$log)}",
    '$progress|Add-Member -NotePropertyName dockerInstalledByTask -NotePropertyValue $true -Force;if($process.ExitCode -eq 3010){$progress.rebootRequired=$true};$progress|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $progressPath -Encoding UTF8',
    "Write-Output $(if($progress.rebootRequired){'WEBMINAI_REBOOT_REQUIRED'}else{'docker-desktop-installed'})"
  ])
}

function startDockerCommand (state, taskName) {
  return guarded(state, [
    "$docker='C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'",
    "if(-not(Test-Path -LiteralPath $docker -PathType Leaf)){throw 'Docker CLI is missing after installation.'}",
    "if(Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue|Where-Object{$_.SessionId -ne 0}|Select-Object -First 1){Write-Output 'docker-desktop-already-running';exit 0}",
    `$taskName='${quote(taskName)}'`,
    "$existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue;if($existing){Write-Output 'docker-start-already-scheduled';exit 0}",
    "$action=New-ScheduledTaskAction -Execute $docker -Argument 'desktop start'",
    "$consoleUser=[string](Get-CimInstance Win32_ComputerSystem).UserName;if([string]::IsNullOrWhiteSpace($consoleUser)){throw 'WINDOWS_INTERACTIVE_USER_REQUIRED: Docker Desktop WSL cannot run as LocalSystem; sign in to Windows once and rerun this task.'}",
    '$principal=New-ScheduledTaskPrincipal -UserId $consoleUser -LogonType Interactive -RunLevel Highest',
    "$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(2);$trigger.EndBoundary=(Get-Date).AddMinutes(12).ToString('s')",
    '$taskSettings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -DeleteExpiredTaskAfter (New-TimeSpan -Minutes 1)',
    'Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Trigger $trigger -Settings $taskSettings -Force|Out-Null',
    "Write-Output 'docker-start-scheduled'"
  ])
}

function waitDockerCommand (state, taskName) {
  return ps([
    "$ErrorActionPreference='Stop'",
    "$docker='C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'",
    `if(-not(Test-Path -LiteralPath $docker -PathType Leaf)){throw 'Docker CLI is missing after installation.'};$taskName='${quote(taskName)}'`,
    `$out='${quote(state)}\\docker-readiness.out';$err='${quote(state)}\\docker-readiness.err'`,
    "Remove-Item -LiteralPath $out,$err -Force -ErrorAction SilentlyContinue;$process=Start-Process -FilePath $docker -ArgumentList @('version','--format','{{.Server.Os}}') -PassThru -RedirectStandardOutput $out -RedirectStandardError $err;if(-not $process.WaitForExit(10000)){$process.Kill();exit 75}",
    "$serverOs=$(if(Test-Path -LiteralPath $out){(Get-Content -LiteralPath $out -Raw).Trim()}else{''})",
    "if($serverOs -ne 'linux'){$info=Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue;if($info -and $info.LastRunTime -gt [datetime]::MinValue -and $info.LastTaskResult -notin @(0,267009,267011)){throw ('DOCKER_SERVICE_NOT_READY: Docker Desktop startup task failed with result '+$info.LastTaskResult)};exit 75}",
    "Remove-Item -LiteralPath $out,$err -Force -ErrorAction SilentlyContinue;$compose=Start-Process -FilePath $docker -ArgumentList @('compose','version') -PassThru -RedirectStandardOutput $out -RedirectStandardError $err;if(-not $compose.WaitForExit(10000)){$compose.Kill();exit 75};$composeOutput=$(if(Test-Path -LiteralPath $out){(Get-Content -LiteralPath $out -Raw).Trim()}else{''});if($composeOutput -notmatch '^Docker Compose version '){exit 75}",
    'Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue',
    "Write-Output 'windows-docker-ready'"
  ])
}

function rebootCommand (state, taskId) {
  return ps([
    "$ErrorActionPreference='Stop'",
    `$progressPath='${quote(state)}\\progress.json'`,
    `if(Test-Path -LiteralPath $progressPath){$progress=Get-Content -LiteralPath $progressPath -Raw|ConvertFrom-Json;if($progress.rebootRequired){$taskName='WebminAI-Reboot-${taskId}';$recoveryName='WebminAI-SSH-Recovery-${taskId}';$powerShell=(Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe');Set-Service -Name 'sshd' -StartupType Automatic;$recoveryPayload="Start-Sleep -Seconds 10; Set-Service -Name 'sshd' -StartupType Automatic; Start-Service -Name 'sshd'; if(Get-Service -Name 'Netdata' -ErrorAction SilentlyContinue){Set-Service -Name 'Netdata' -StartupType Automatic; Start-Service -Name 'Netdata' -ErrorAction SilentlyContinue}; Unregister-ScheduledTask -TaskName '$recoveryName' -Confirm:\`$false -ErrorAction SilentlyContinue";$recoveryEncoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($recoveryPayload));$recoveryAction=New-ScheduledTaskAction -Execute $powerShell -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '+$recoveryEncoded);$principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest;$recoveryTrigger=New-ScheduledTaskTrigger -AtStartup;Register-ScheduledTask -TaskName $recoveryName -Action $recoveryAction -Principal $principal -Trigger $recoveryTrigger -Force|Out-Null;$payload='Restart-Computer -Force';$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($payload));$action=New-ScheduledTaskAction -Execute $powerShell -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand '+$encoded);$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(30);$trigger.EndBoundary=(Get-Date).AddMinutes(2).ToString('s');$taskSettings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -DeleteExpiredTaskAfter (New-TimeSpan -Minutes 1);Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Trigger $trigger -Settings $taskSettings -Force|Out-Null;if(-not(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)-or-not(Get-ScheduledTask -TaskName $recoveryName -ErrorAction SilentlyContinue)){throw 'Could not verify the scheduled Windows reboot and SSH recovery jobs.'};Write-Output 'WEBMINAI_REBOOT_SCHEDULED_30_SECONDS';exit 0}}`,
    "Write-Output 'no-reboot-required'"
  ])
}

function uninstallDockerCommand (state) {
  return ps([
    "$ErrorActionPreference='Stop'",
    `$progressPath='${quote(state)}\\progress.json'`,
    `if(Test-Path -LiteralPath $progressPath){$progress=Get-Content -LiteralPath $progressPath -Raw|ConvertFrom-Json;if($progress.dockerInstalledByTask){$installer='${quote(state)}\\DockerDesktop.msi';if(-not(Test-Path -LiteralPath $installer -PathType Leaf)){throw 'Task-owned Docker Desktop MSI is unavailable for rollback.'};$log='${quote(state)}\\docker-msi-uninstall.log';$process=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\msiexec.exe') -ArgumentList @('/x',$installer,'/L*V',$log,'/qn','/norestart') -Wait -PassThru;if($process.ExitCode -notin @(0,1605,3010)){throw ('Docker Desktop MSI uninstall failed with exit code '+$process.ExitCode)}}}`,
    "Write-Output 'task-owned-docker-removed'"
  ])
}

function uninstallWslCommand (state, installer) {
  return ps([
    "$ErrorActionPreference='Stop'",
    `$progressPath='${quote(state)}\\progress.json'`,
    `if(Test-Path -LiteralPath $progressPath){$progress=Get-Content -LiteralPath $progressPath -Raw|ConvertFrom-Json;if($progress.wslInstalledByTask){$installer='${quote(installer)}';if(-not(Test-Path -LiteralPath $installer -PathType Leaf)){throw 'Task-owned WSL MSI is unavailable for rollback.'};$process=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\msiexec.exe') -ArgumentList @('/x',$installer,'/qn','/norestart') -Wait -PassThru;if($process.ExitCode -notin @(0,1605,3010)){throw ('WSL MSI uninstall failed with exit code '+$process.ExitCode)}}}`,
    "Write-Output 'task-owned-wsl-removed'"
  ])
}

function restoreFeaturesCommand (state) {
  return ps([
    "$ErrorActionPreference='Stop'",
    `$baselinePath='${quote(state)}\\baseline.json'`,
    `$progressPath='${quote(state)}\\progress.json'`,
    "if((Test-Path -LiteralPath $baselinePath)-and(Test-Path -LiteralPath $progressPath)){$baseline=Get-Content -LiteralPath $baselinePath -Raw|ConvertFrom-Json;$progress=Get-Content -LiteralPath $progressPath -Raw|ConvertFrom-Json;foreach($name in @($progress.featuresChanged)){if([string]$baseline.features.$name -ne 'Enabled'){Disable-WindowsOptionalFeature -Online -FeatureName $name -NoRestart -ErrorAction Stop|Out-Null}}}",
    "Write-Output 'task-owned-features-restored; a reboot may be required'"
  ])
}

function cleanupCommand (state, downloadNames, scheduledTaskNames) {
  const names = downloadNames.map(name => `'${quote(name)}'`).join(',')
  const tasks = scheduledTaskNames.map(name => `'${quote(name)}'`).join(',')
  return `Import-Module BitsTransfer -ErrorAction SilentlyContinue;foreach($name in @(${names})){$job=Get-BitsTransfer -Name $name -ErrorAction SilentlyContinue;if($job){Remove-BitsTransfer -BitsJob $job}};foreach($taskName in @(${tasks})){Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue};if(Test-Path -LiteralPath '${quote(state)}'){Remove-Item -LiteralPath '${quote(state)}' -Recurse -Force};Write-Output 'bootstrap-state-removed'`
}

function verifyCommand () {
  return ps([
    "$docker='C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'",
    "if(-not(Test-Path -LiteralPath $docker)){throw 'Docker CLI is absent.'}",
    "$out=Join-Path $env:TEMP ('webminai-docker-verify-'+$PID+'.out')",
    "$err=Join-Path $env:TEMP ('webminai-docker-verify-'+$PID+'.err')",
    'Remove-Item -LiteralPath $out,$err -Force -ErrorAction SilentlyContinue',
    "$process=Start-Process -FilePath $docker -ArgumentList @('info','--format','{{.OSType}}') -PassThru -RedirectStandardOutput $out -RedirectStandardError $err",
    "if(-not $process.WaitForExit(10000)){$process.Kill();throw 'Docker Linux engine verification timed out.'};$process.WaitForExit()",
    "$os=$(if(Test-Path -LiteralPath $out){(Get-Content -LiteralPath $out -Raw).Trim()}else{''})",
    "if($os -ne 'linux'){throw ('Docker Linux engine is not ready (server OS '+$(if($os){$os}else{'empty'})+').')}",
    'Remove-Item -LiteralPath $out,$err -Force -ErrorAction SilentlyContinue',
    "$compose=Start-Process -FilePath $docker -ArgumentList @('compose','version') -PassThru -RedirectStandardOutput $out -RedirectStandardError $err",
    "if(-not $compose.WaitForExit(10000)){$compose.Kill();throw 'Docker Compose verification timed out.'};$compose.WaitForExit()",
    "$composeOutput=$(if(Test-Path -LiteralPath $out){(Get-Content -LiteralPath $out -Raw).Trim()}else{''})",
    "if($composeOutput -notmatch '^Docker Compose version '){throw 'Docker Compose is not ready.'}",
    'Remove-Item -LiteralPath $out,$err -Force -ErrorAction SilentlyContinue',
    "Write-Output 'windows-docker-ready'"
  ])
}

function stateProbeCommand (state) {
  return ps([`$state='${quote(state)}'`, "$features=@{};foreach($name in @('Microsoft-Windows-Subsystem-Linux','VirtualMachinePlatform')){$features[$name]=[string](Get-WindowsOptionalFeature -Online -FeatureName $name -ErrorAction SilentlyContinue).State}", "$docker='C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'", "[pscustomobject]@{state=Test-Path -LiteralPath $state;features=$features;dockerCli=Test-Path -LiteralPath $docker;pendingReboot=(Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending')}|ConvertTo-Json -Depth 4 -Compress"])
}

function guarded (state, statements) {
  return ps(["$ErrorActionPreference='Stop'", `$statePath='${quote(state)}'`, '$progressPath=Join-Path $statePath \'progress.json\'', '$progress=Get-Content -LiteralPath $progressPath -Raw|ConvertFrom-Json', "if($progress.rebootRequired){Write-Output 'WEBMINAI_REBOOT_REQUIRED';exit 0}", ...statements])
}

function item (id, command, purpose, dependsOn = [], timeoutMs = 300000, executionMode, risk = 'change') {
  return { id, command, purpose, risk, timeoutMs, requiresSudo: true, dependsOn, ...(executionMode ? { executionMode } : {}) }
}

function pollItem (id, command, purpose, dependsOn) {
  return { ...item(id, command, purpose, dependsOn, 30000), retry: { attempts: 120, intervalMs: 5000, exitCodes: [75] } }
}

function ps (statements) { return statements.join(';') }
function quote (value) { return String(value).replaceAll("'", "''") }

export const WINDOWS_DOCKER_DESKTOP_RELEASE = Object.freeze({ version: DOCKER_DESKTOP_VERSION, build: DOCKER_DESKTOP_BUILD, installerUrl: DOCKER_INSTALLER_URL, sha256: DOCKER_INSTALLER_SHA256 })
export const WINDOWS_WSL_RELEASE = Object.freeze({ version: WSL_VERSION, installerUrl: WSL_INSTALLER_URL, sha256: WSL_INSTALLER_SHA256 })
