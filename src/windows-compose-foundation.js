export function buildWindowsComposeFoundation ({
  taskId,
  windowsExecution,
  docker,
  application,
  port,
  images,
  credentials = ['db_password', 'db_root_password', 'admin_password']
}) {
  if (!Number.isInteger(taskId) || taskId < 1) throw new TypeError('task id must be a positive integer')
  if (windowsExecution?.platform !== 'windows') throw new Error(`Windows ${application} Compose requires a Windows execution inventory`)
  if (docker?.preference === 'disabled') throw new Error(`Docker is disabled for this host; no reviewed native Windows ${application} route is promoted`)
  if (!docker?.ready) throw new Error(`Windows ${application} Compose requires an already running Docker engine and Compose: ${docker?.reason ?? 'Docker readiness was not detected'}`)
  if (windowsExecution?.docker?.serverOs !== 'linux') throw new Error(`Windows ${application} images require Docker Desktop or Docker Engine in Linux-container mode`)
  if (!Array.isArray(images) || images.length === 0 || images.some(image => typeof image !== 'string' || image.length === 0)) throw new TypeError('Compose foundation requires image names')

  const project = `webminai-${application}-${port}`
  const root = `C:\\ProgramData\\WebminAI\\Services\\${application}`
  const credentialRoot = `C:\\ProgramData\\WebminAI\\credentials\\${application}`
  const state = `C:\\ProgramData\\WebminAI\\Tasks\\${taskId}-${application}-compose`
  return {
    paths: { project, root, credentials: credentialRoot, state, port },
    commands: [
      command('capture-baseline', 'baseline', baselineCommand({ root, credentials: credentialRoot, state, project, port, images }), 'Require Linux-container Docker and capture task-owned paths, images, ports, and firewall state'),
      command('generate-credentials', 'secrets', credentialsCommand(credentialRoot, credentials), `Generate protected ${application} credentials on the Windows host`, ['capture-baseline'])
    ],
    revertCommands: [
      command('remove-compose-project', 'cleanup', removeProjectCommand({ root, project }), 'Remove only task-owned containers, networks, and volumes', [], 900000, 'job', 'destructive'),
      command('remove-new-images', 'cleanup', removeImagesCommand(state), 'Remove only pinned images absent from the captured baseline', ['remove-compose-project'], 3600000, 'job', 'destructive'),
      command('remove-task-files', 'cleanup', removeFilesCommand({ root, credentials: credentialRoot, state, project }), 'Remove task-owned service, credential, state, and firewall objects', ['remove-new-images'], 300000, undefined, 'destructive')
    ],
    verifyReverted: revertedCommand({ root, credentials: credentialRoot, state, project, port }),
    stateProbe: stateProbeCommand({ root, credentials: credentialRoot, state, project, port })
  }
}

export function buildWindowsComposeApplicationTask ({
  taskId,
  windowsExecution,
  docker,
  application,
  port,
  images,
  credentials = ['db_password', 'db_root_password', 'admin_password'],
  summary,
  changeOverview,
  modifiedFiles = [],
  assumptions = [],
  warnings = [],
  commands,
  verifyApplied
}) {
  if (!Array.isArray(commands) || commands.length === 0) throw new TypeError('Windows Compose application requires explicit application commands')
  const foundation = buildWindowsComposeFoundation({ taskId, windowsExecution, docker, application, port, images, credentials })
  const applicationCommands = applyWindowsComposeOperationDefaults(commands)
  return {
    plan: {
      summary,
      changeOverview,
      modifiedFiles: [foundation.paths.state, foundation.paths.root, `${foundation.paths.root}\\compose.yaml`, foundation.paths.credentials, ...modifiedFiles].filter((value, index, values) => values.indexOf(value) === index),
      assumptions,
      warnings,
      requiresConfirmation: true,
      commands: foundation.commands.concat(applicationCommands),
      revertCommands: foundation.revertCommands
    },
    verifyApplied,
    verifyReverted: foundation.verifyReverted,
    stateProbe: foundation.stateProbe
  }
}

export function applyWindowsComposeOperationDefaults (commands) {
  if (!Array.isArray(commands)) throw new TypeError('Windows Compose operation defaults require a command array')
  return commands.map(item => {
    const operation = windowsOperationDefaults(item)
    const inheritedDefaultTimeout = item.executionMode === undefined && item.timeoutMs === 300000 && operation.executionMode === 'job'
    return windowsComposeCommand(item.id, item.phase, item.command, item.purpose, item.dependsOn, inheritedDefaultTimeout ? operation.timeoutMs : item.timeoutMs ?? operation.timeoutMs, item.executionMode ?? operation.executionMode, item.risk)
  })
}

export function windowsComposeCommand (id, phase, commandText, purpose, dependsOn = [], timeoutMs = 300000, executionMode, risk = 'change') {
  return command(id, phase, commandText, purpose, dependsOn, timeoutMs, executionMode, risk)
}

export function windowsComposePowerShell (root, body, timeoutMs = 300000) {
  return powershell(["$ErrorActionPreference='Stop'", windowsDockerPowerShellAdapter(timeoutMs), `Set-Location -LiteralPath '${powerShellQuote(root)}'`, body])
}

export function windowsComposePullCommand (root, project, profile = null, timeoutMs = 300000) {
  const profileArgs = profile ? ` --profile '${powerShellQuote(profile)}'` : ''
  return windowsComposePowerShell(root, `& $docker compose -p '${powerShellQuote(project)}'${profileArgs} pull;if($LASTEXITCODE-ne 0){throw 'Docker Compose image pull failed.'};Write-Output 'images-pulled'`, timeoutMs)
}

export function windowsDockerPowerShellAdapter (timeoutMs = 60 * 60 * 1000) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60 * 60 * 1000) throw new TypeError('Docker adapter timeout must be between 1 second and 1 hour')
  return dockerDiscovery('$docker', timeoutMs)
}

function windowsOperationDefaults (item) {
  if (item.id === 'pull-images' || item.phase === 'acquire') return { timeoutMs: 3600000, executionMode: 'job' }
  if (item.phase === 'services' || item.phase === 'verify') return { timeoutMs: 900000, executionMode: 'job' }
  if (item.phase === 'initialize') return { timeoutMs: 1800000, executionMode: 'job' }
  return { timeoutMs: 300000, executionMode: undefined }
}

export function windowsTextFileCommand (filePath, value) {
  return `[IO.File]::WriteAllText('${powerShellQuote(filePath)}',@'\n${value}\n'@,[Text.UTF8Encoding]::new($false))`
}

export function windowsPathForCompose (value) {
  return String(value).replaceAll('\\', '/')
}

export function powerShellQuote (value) {
  return String(value).replaceAll("'", "''")
}

export function powershell (statements) {
  return statements.join(';')
}

function baselineCommand ({ root, credentials, state, project, port, images }) {
  const baseline = `${state}\\baseline.json`
  return powershell([
    "$ErrorActionPreference='Stop'",
    windowsDockerPowerShellAdapter(),
    "$serverOs=(& $docker info --format '{{.OSType}}' 2>$null).Trim()",
    "if($LASTEXITCODE -ne 0 -or $serverOs -ne 'linux'){throw 'Docker must be reachable in Linux-container mode.'}",
    '& $docker compose version *> $null',
    "if($LASTEXITCODE -ne 0){throw 'Docker Compose is unavailable to LocalSystem.'}",
    `$baselinePath='${powerShellQuote(baseline)}'`,
    `if(Test-Path -LiteralPath $baselinePath){$saved=Get-Content -LiteralPath $baselinePath -Raw|ConvertFrom-Json;if($saved.project -ne '${project}' -or [int]$saved.port -ne ${port}){throw 'Saved baseline identity is invalid.'}}else{if(Test-Path -LiteralPath '${powerShellQuote(state)}'){throw 'Task state exists without a valid baseline.'};if(Test-Path -LiteralPath '${powerShellQuote(root)}'){throw 'Task service path already exists.'};if(Test-Path -LiteralPath '${powerShellQuote(credentials)}'){throw 'Task credential path already exists.'};if(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue){throw 'Required TCP port ${port} is already listening.'};if(Get-NetFirewallRule -Name '${project}' -ErrorAction SilentlyContinue){throw 'Task firewall rule already exists.'};New-Item -Path '${powerShellQuote(state)}' -ItemType Directory -Force|Out-Null;$images=@(${images.map(value => `'${powerShellQuote(value)}'`).join(',')});$present=@{};foreach($image in $images){& $docker image inspect $image *> $null;$present[$image]=($LASTEXITCODE -eq 0)};$captured=[ordered]@{project='${project}';port=${port};images=$present;capturedAtUtc=[DateTime]::UtcNow.ToString('o')};$captured|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $baselinePath -Encoding UTF8}`,
    "$global:LASTEXITCODE=0;Write-Output 'baseline-captured'"
  ])
}

function credentialsCommand (root, names) {
  return powershell([
    "$ErrorActionPreference='Stop'",
    `New-Item -Path '${powerShellQuote(root)}' -ItemType Directory -Force|Out-Null`,
    `$acl=Get-Acl -LiteralPath '${powerShellQuote(root)}'`,
    '$acl.SetAccessRuleProtection($true,$false)',
    "$systemSid=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')",
    "$administratorsSid=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')",
    "$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($systemSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))",
    "$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($administratorsSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))",
    `Set-Acl -LiteralPath '${powerShellQuote(root)}' -AclObject $acl`,
    "function New-Secret { $bytes=New-Object byte[] 32;[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes);[Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_') }",
    `foreach($name in @(${names.map(name => `'${powerShellQuote(name)}'`).join(',')})){$path=Join-Path '${powerShellQuote(root)}' $name;if(-not(Test-Path -LiteralPath $path)){[IO.File]::WriteAllText($path,(New-Secret),[Text.UTF8Encoding]::new($false))}}`,
    "Write-Output 'credentials-generated'"
  ])
}

function removeProjectCommand ({ root, project }) {
  return powershell(["$ErrorActionPreference='Stop'", `if(Test-Path -LiteralPath '${powerShellQuote(root)}\\compose.yaml'){${windowsDockerPowerShellAdapter()};Set-Location -LiteralPath '${powerShellQuote(root)}';& $docker compose -p '${project}' down --volumes --remove-orphans;if($LASTEXITCODE -ne 0){throw 'Compose teardown failed.'}}`, "Write-Output 'compose-removed'"])
}

function removeImagesCommand (state) {
  return powershell(["$ErrorActionPreference='Stop'", `$baselinePath='${powerShellQuote(state)}\\baseline.json'`, `if(Test-Path -LiteralPath $baselinePath){$baseline=Get-Content -LiteralPath $baselinePath -Raw|ConvertFrom-Json;${windowsDockerPowerShellAdapter()};foreach($property in $baseline.images.PSObject.Properties){if(-not [bool]$property.Value){& $docker image rm $property.Name *> $null}}}`, "Write-Output 'new-images-removed'"])
}

function removeFilesCommand ({ root, credentials, state, project }) {
  return powershell(["$ErrorActionPreference='Stop'", `Get-NetFirewallRule -Name '${project}' -ErrorAction SilentlyContinue|Remove-NetFirewallRule`, `foreach($path in @('${powerShellQuote(root)}','${powerShellQuote(credentials)}','${powerShellQuote(state)}')){if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path -Recurse -Force}}`, "Write-Output 'task-files-removed'"])
}

function revertedCommand ({ root, credentials, state, project, port }) {
  return powershell([`if((Test-Path -LiteralPath '${powerShellQuote(root)}') -or (Test-Path -LiteralPath '${powerShellQuote(credentials)}') -or (Test-Path -LiteralPath '${powerShellQuote(state)}')){throw 'Task paths remain.'}`, `if(Get-NetFirewallRule -Name '${project}' -ErrorAction SilentlyContinue){throw 'Task firewall rule remains.'}`, `if(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue){throw 'Task port remains open.'}`, "Write-Output 'revert-verified'"])
}

function stateProbeCommand ({ root, credentials, state, project, port }) {
  return powershell([`[pscustomobject]@{root=Test-Path -LiteralPath '${powerShellQuote(root)}';credentials=Test-Path -LiteralPath '${powerShellQuote(credentials)}';state=Test-Path -LiteralPath '${powerShellQuote(state)}';firewall=[bool](Get-NetFirewallRule -Name '${project}' -ErrorAction SilentlyContinue);listening=[bool](Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue)}|ConvertTo-Json -Compress`])
}

function command (id, phase, commandText, purpose, dependsOn = [], timeoutMs = 300000, executionMode, risk = 'change') {
  return { id, phase, command: commandText, purpose, risk, timeoutMs, requiresSudo: true, dependsOn, ...(executionMode ? { executionMode } : {}) }
}

function dockerDiscovery (variable, timeoutMs = 300000) {
  return `$dockerExe=(Get-Command docker.exe -ErrorAction SilentlyContinue).Source;if(-not $dockerExe){$dockerExe=Join-Path $env:ProgramFiles 'Docker\\Docker\\resources\\bin\\docker.exe'};if(-not (Test-Path -LiteralPath $dockerExe -PathType Leaf)){throw 'docker.exe is unavailable to LocalSystem.'};${variable}={$dockerArguments=@($args|ForEach-Object{$value=[string]$_;if($value -match '[\\s"]'){'"'+$value.Replace('"','\\"')+'"'}else{$value}});$stdout=[IO.Path]::GetTempFileName();$stderr=[IO.Path]::GetTempFileName();try{$process=Start-Process -FilePath $dockerExe -ArgumentList $dockerArguments -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr;if(-not $process.WaitForExit(${timeoutMs})){$process.Kill();throw 'Docker command timed out.'};$stdoutText=[string](Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue);$stderrText=[string](Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue);$global:LASTEXITCODE=if($null -ne $process.ExitCode){[int]$process.ExitCode}elseif($stderrText -match '(?im)^(error|failed|unknown command|docker:)'){1}else{0};if($stdoutText){Write-Output $stdoutText};if($stderrText){Write-Error -Message $stderrText -ErrorAction Continue}}finally{Remove-Item -LiteralPath $stdout,$stderr -Force -ErrorAction SilentlyContinue}}`
}
