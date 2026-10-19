param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne 'S-1-5-18') { throw 'Recovery storage requires LocalSystem' }
if ($Request.Length -gt 20000) { throw 'Recovery request exceeds limit' }
$requestObject = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Request)) | ConvertFrom-Json
$operation = [string]$requestObject.operation
if ($operation -notin @('key','initialize','list','read','claim','append','release','rotate-key','verification-key','ownership','takeover')) { throw 'Unsupported recovery operation' }
$root = 'C:\ProgramData\IntentAIOps\Recovery'
$base = 'C:\ProgramData\IntentAIOps'
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administrators = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$utf8 = [Text.UTF8Encoding]::new($false)

function Assert-NoReparse([string]$Path) {
    $current = $Path
    while ($current) {
        if ([IO.Directory]::Exists($current) -or [IO.File]::Exists($current)) {
            if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unsafe recovery reparse point' }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

function Assert-Private([string]$Path) {
    Assert-NoReparse $Path
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin @($system.Value,$administrators.Value)) { throw 'Unsafe recovery owner' }
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -notin @($system.Value,$administrators.Value)) { throw 'Unsafe recovery ACL' }
    }
}

function Create-PrivateDirectory([string]$Path) {
    Assert-NoReparse $Path
    if (-not [IO.Directory]::Exists($Path)) {
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetOwner($system)
        $acl.SetAccessRuleProtection($true,$false)
        foreach ($identity in @($system,$administrators)) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
            $acl.AddAccessRule($rule)
        }
        [void][IO.Directory]::CreateDirectory($Path,$acl)
    }
    Assert-Private $Path
}

function Read-Bounded([string]$Path) {
    Assert-Private $Path
    if ((Get-Item -LiteralPath $Path).Length -gt 8192) { throw 'Recovery file exceeds limit' }
    return [IO.File]::ReadAllText($Path,$utf8)
}

function Write-Durable([string]$Path,[byte[]]$Bytes) {
    Assert-NoReparse $Path
    $stream = [IO.FileStream]::new($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
    try { $stream.Write($Bytes,0,$Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    Assert-Private $Path
}

function Publish-Durable([string]$Path,[byte[]]$Bytes,[bool]$Replace=$false) {
    Assert-NoReparse $Path
    $temporary = $Path+'.pending-'+[Guid]::NewGuid().ToString('N')
    try {
        Write-Durable $temporary $Bytes
        $flags = [uint32]8
        if ($Replace) { $flags = [uint32]9 }
        if (-not [IntentRecoveryFile]::MoveFileEx($temporary,$Path,$flags)) { throw 'Recovery publication failed' }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}

function Hash-Bytes([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}

function Base64Url([byte[]]$Bytes) { return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+','-').Replace('/','_') }

Assert-NoReparse $root
$writing = $operation -in @('initialize','claim','append','release','rotate-key','takeover')
if (-not $writing -and -not [IO.Directory]::Exists($root)) { Write-Output '{"available":false}'; return }
if ($writing) { Create-PrivateDirectory $base; Create-PrivateDirectory $root }
Assert-Private $base
Assert-Private $root
$lock = $null
$key = $null
$algorithm = $null
try {
    if ($writing) {
        if (-not ('IntentRecoveryFile' -as [type])) {
            Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class IntentRecoveryFile { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileEx(string source, string destination, uint flags); }'
        }
        $lockPath = Join-Path $root 'write.lock'
        if ([IO.File]::Exists($lockPath)) { Assert-Private $lockPath }
        for ($attempt=0; $attempt -lt 50; $attempt++) {
            try { $lock = [IO.FileStream]::new($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); break } catch [IO.IOException] { Start-Sleep -Milliseconds 50 }
        }
        if ($null -eq $lock) { throw 'Recovery storage is busy' }
    }
    $keyPath = Join-Path $root 'signing.blob'
    if ($operation -eq 'initialize' -and -not [IO.File]::Exists($keyPath)) {
        Assert-NoReparse $keyPath
        $creation = [Security.Cryptography.CngKeyCreationParameters]::new()
        $creation.ExportPolicy = [Security.Cryptography.CngExportPolicies]::AllowPlaintextExport
        $generated = [Security.Cryptography.CngKey]::Create([Security.Cryptography.CngAlgorithm]::ECDsaP256,$null,$creation)
        try { Publish-Durable $keyPath $generated.Export([Security.Cryptography.CngKeyBlobFormat]::EccPrivateBlob) } finally { $generated.Dispose() }
    }
    Assert-Private $keyPath
    if ((Get-Item -LiteralPath $keyPath).Length -gt 1024) { throw 'Invalid signing key size' }
    $key = [Security.Cryptography.CngKey]::Import([IO.File]::ReadAllBytes($keyPath),[Security.Cryptography.CngKeyBlobFormat]::EccPrivateBlob)
    $algorithm = [Security.Cryptography.ECDsaCng]::new($key)
    $algorithm.HashAlgorithm = [Security.Cryptography.CngAlgorithm]::Sha256
    $public = $key.Export([Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
    if ($public.Length -ne 72 -or [Text.Encoding]::ASCII.GetString($public,0,4) -ne 'ECS1') { throw 'Unexpected recovery signing algorithm' }
    [byte[]]$prefix = @(0x30,0x59,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x03,0x42,0x00,0x04)
    [byte[]]$spki = $prefix + $public[8..71]
    $fingerprint = Hash-Bytes $spki
    if ($operation -eq 'rotate-key') {
        if ([string]$requestObject.fingerprint -ne $fingerprint -or [string]$requestObject.target -cnotmatch '^SHA256:[a-f0-9]{64}$') { throw 'Stale rotation approval or invalid target' }
        foreach ($entry in (Get-ChildItem -LiteralPath $root -Directory)) {
            if ($entry.Name -cmatch '^[a-f0-9]{32}$') {
                Assert-Private $entry.FullName
                $ownerPath = Join-Path $entry.FullName 'owner'
                Assert-NoReparse $ownerPath
                if ([IO.File]::Exists($ownerPath)) { throw 'Recovery execution is still owned' }
            }
        }
        $keys = Join-Path $root 'keys'
        Create-PrivateDirectory $keys
        $creation = [Security.Cryptography.CngKeyCreationParameters]::new()
        $creation.ExportPolicy = [Security.Cryptography.CngExportPolicies]::AllowPlaintextExport
        $replacement = [Security.Cryptography.CngKey]::Create([Security.Cryptography.CngAlgorithm]::ECDsaP256,$null,$creation)
        try {
            $nextPublic = $replacement.Export([Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
            if ($nextPublic.Length -ne 72 -or [Text.Encoding]::ASCII.GetString($nextPublic,0,4) -ne 'ECS1') { throw 'Unexpected replacement signing algorithm' }
            [byte[]]$nextSpki = $prefix + $nextPublic[8..71]
            $nextFingerprint = Hash-Bytes $nextSpki
            $rotationPayload = [ordered]@{ newFingerprint=$nextFingerprint; newPublicKey=[Convert]::ToBase64String($nextSpki); observedAt=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ',[Globalization.CultureInfo]::InvariantCulture); oldFingerprint=$fingerprint; rotationId=[Guid]::NewGuid().ToString('N'); target=[string]$requestObject.target; version=1 } | ConvertTo-Json -Compress
            $rotationBytes = $utf8.GetBytes($rotationPayload)
            $signature = Base64Url ($algorithm.SignData($utf8.GetBytes("intentaiops.remote-common-task.key-rotation.v1`n"+$rotationPayload)))
            $rotation = '{"algorithm":"ECDSA-P256-SHA256-P1363","format":"intentaiops-recovery-key-rotation","keyFingerprint":"'+$fingerprint+'","payload":"'+(Base64Url $rotationBytes)+'","signature":"'+$signature+'","version":1}'
            Publish-Durable (Join-Path $keys ($fingerprint+'.der')) $spki
            Publish-Durable (Join-Path $keys ($nextFingerprint+'.rotation.json')) ($utf8.GetBytes($rotation))
            Publish-Durable $keyPath $replacement.Export([Security.Cryptography.CngKeyBlobFormat]::EccPrivateBlob) $true
            Write-Output ('{"available":true,"publicKey":"'+[Convert]::ToBase64String($nextSpki)+'","rotation":'+$rotation+'}')
            return
        } finally { $replacement.Dispose() }
    }
    if ($operation -in @('key','initialize')) {
        $response = '{"available":true,"publicKey":"'+[Convert]::ToBase64String($spki)+'"'
        $rotationPath = Join-Path $root ('keys\'+$fingerprint+'.rotation.json')
        Assert-NoReparse $rotationPath
        if ([IO.File]::Exists($rotationPath)) { $response += ',"rotation":'+(Read-Bounded $rotationPath) }
        Write-Output ($response+'}')
        return
    }
    if ($operation -eq 'verification-key') {
        $requested = [string]$requestObject.fingerprint
        if ($requested -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid historical key fingerprint' }
        $keys = Join-Path $root 'keys'
        Assert-Private $keys
        $historical = Join-Path $keys ($requested+'.der')
        Assert-Private $historical
        if ((Get-Item -LiteralPath $historical).Length -gt 1024) { throw 'Historical key exceeds limit' }
        Write-Output ('{"available":true,"publicKey":"'+[Convert]::ToBase64String([IO.File]::ReadAllBytes($historical))+'"}')
        return
    }
    if ($operation -eq 'list') {
        $after = [string]$requestObject.after
        if ($after -ne '' -and $after -cnotmatch '^[a-f0-9]{32}$') { throw 'Invalid recovery cursor' }
        $entries = @()
        foreach ($directory in (Get-ChildItem -LiteralPath $root -Directory | Sort-Object Name)) {
            if ($directory.Name -cnotmatch '^[a-f0-9]{32}$' -or [string]::CompareOrdinal($directory.Name,$after) -le 0) { continue }
            Assert-Private $directory.FullName
            $head = Read-Bounded (Join-Path $directory.FullName 'head')
            if ($head -cnotmatch '^([1-9][0-9]{0,5}) ([a-f0-9]{64})$') { throw 'Invalid recovery head' }
            $entries += [ordered]@{ executionId=$directory.Name; sequence=[int]$Matches[1]; head=$Matches[2] }
            if ($entries.Count -ge 10) { break }
        }
        [ordered]@{ executions=@($entries) } | ConvertTo-Json -Depth 5 -Compress
        return
    }
    $execution = [string]$requestObject.executionId
    $sequence = [int]$requestObject.sequence
    if ($execution -cnotmatch '^[a-f0-9]{32}$' -or $sequence -lt 0 -or $sequence -gt 100000) { throw 'Invalid recovery execution' }
    $directory = Join-Path $root $execution
    if ($operation -eq 'read') { if ($sequence -lt 1) { throw 'Invalid sequence' }; Assert-Private $directory; Write-Output (Read-Bounded (Join-Path $directory ($sequence.ToString()+'.json'))); return }
    $head = [string]$requestObject.head
    if ($operation -eq 'ownership') {
        Assert-Private $directory
        if ((Read-Bounded (Join-Path $directory 'head')) -ne ($sequence.ToString()+' '+$head)) { throw 'Stale recovery head' }
        $ownerPath = Join-Path $directory 'owner'
        Assert-NoReparse $ownerPath
        if ([IO.File]::Exists($ownerPath)) {
            $ownerBytes = $utf8.GetBytes((Read-Bounded $ownerPath))
            Write-Output ('{"owned":true,"ownerFingerprint":"'+(Hash-Bytes $ownerBytes)+'"}')
        } else { Write-Output '{"owned":false,"ownerFingerprint":null}' }
        return
    }
    $owner = [string]$requestObject.owner
    if ($owner -cnotmatch '^[a-f0-9]{32}$' -or ($sequence -eq 0 -and $head -ne '-') -or ($sequence -gt 0 -and $head -cnotmatch '^[a-f0-9]{64}$')) { throw 'Invalid recovery owner or head' }
    if ($operation -eq 'claim' -and -not [IO.Directory]::Exists($directory)) {
        $task = [int]$requestObject.taskId
        if ($task -lt 1 -or $sequence -ne 0) { throw 'Invalid original task identity' }
        $slot = Join-Path $root ('task-'+$task)
        Assert-NoReparse $slot
        if ([IO.File]::Exists($slot)) { throw 'Remote task identity is already occupied' }
        Create-PrivateDirectory $directory
        Publish-Durable $slot ($utf8.GetBytes($execution))
    }
    Assert-Private $directory
    $headPath = Join-Path $directory 'head'
    $actual = '0 -'
    if ([IO.File]::Exists($headPath)) { $actual = Read-Bounded $headPath }
    if ($actual -ne ($sequence.ToString()+' '+$head)) { throw 'Stale recovery head' }
    $ownerPath = Join-Path $directory 'owner'
    if ($operation -eq 'takeover') {
        $expectedOwner = [string]$requestObject.ownerFingerprint
        $ownerBytes = $utf8.GetBytes((Read-Bounded $ownerPath))
        if ($expectedOwner -cnotmatch '^[a-f0-9]{64}$' -or (Hash-Bytes $ownerBytes) -ne $expectedOwner) { throw 'Recovery owner changed after review' }
        Publish-Durable $ownerPath ($utf8.GetBytes($owner)) $true
        Write-Output '{"claimed":true}'; return
    }
    if ($operation -eq 'claim') {
        if ([IO.File]::Exists($ownerPath)) { if ((Read-Bounded $ownerPath) -ne $owner) { throw 'Recovery execution is already owned' } } else { Publish-Durable $ownerPath ($utf8.GetBytes($owner)) }
        Write-Output '{"claimed":true}'; return
    }
    if ((Read-Bounded $ownerPath) -ne $owner) { throw 'Recovery execution is owned elsewhere' }
    if ($operation -eq 'release') { [IO.File]::Delete($ownerPath); Write-Output '{"released":true}'; return }
    if ($operation -ne 'append' -or [string]$requestObject.fingerprint -ne $fingerprint) { throw 'Invalid recovery operation or signing pin' }
    $payload = [string]$requestObject.payload
    $signing = [string]$requestObject.signing
    if ($payload -cnotmatch '^[A-Za-z0-9_-]{1,5500}$' -or $signing -cnotmatch '^[A-Za-z0-9+/=]{1,5600}$') { throw 'Invalid signing payload' }
    $signature = Base64Url ($algorithm.SignData([Convert]::FromBase64String($signing)))
    $record = '{"algorithm":"ECDSA-P256-SHA256-P1363","format":"intentaiops-remote-recovery","keyFingerprint":"'+$fingerprint+'","payload":"'+$payload+'","signature":"'+$signature+'","version":1}'
    $next = $sequence+1
    $recordPath = Join-Path $directory ($next.ToString()+'.json')
    Publish-Durable $recordPath ($utf8.GetBytes($record))
    $nextHead = $next.ToString()+' '+(Hash-Bytes ($utf8.GetBytes($record)))
    Publish-Durable $headPath ($utf8.GetBytes($nextHead)) $true
    Write-Output $record
} finally {
    if ($null -ne $algorithm) { $algorithm.Dispose() }
    if ($null -ne $key) { $key.Dispose() }
    if ($null -ne $lock) { $lock.Dispose() }
}
