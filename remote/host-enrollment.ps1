param([Parameter(Mandatory=$true)][ValidateSet('read','replace')][string]$Operation,[string]$Payload='')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$root='C:\ProgramData\IntentAIOpsEnrollment'
$file=Join-Path $root 'host-id'
$trusted=@('S-1-5-18','S-1-5-32-544')
$utf8=[Text.UTF8Encoding]::new($false)
function Assert-NoReparse([string]$Path) {
  $current=$Path
  while($current) {
    $entry=$null
    try {$entry=Get-Item -LiteralPath $current -Force -ErrorAction Stop} catch [System.Management.Automation.ItemNotFoundException] {}
    if($entry -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe enrollment reparse point'}
    $parent=[IO.Path]::GetDirectoryName($current)
    if($parent -eq $current){break};$current=$parent
  }
}
function Assert-Safe([string]$Path) {
  Assert-NoReparse $Path
  $acl=Get-Acl -LiteralPath $Path
  if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted){throw 'Unsafe enrollment owner'}
  $write=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and ($rule.FileSystemRights -band $write) -and $rule.IdentityReference.Value -notin $trusted){throw 'Unsafe enrollment write access'}
  }
}
function Valid-Id([string]$Value) {return $Value -cmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -and $Value -ne '00000000-0000-0000-0000-000000000000'}
function Read-Id {
  Assert-NoReparse $root
  if(-not (Test-Path -LiteralPath $root)){return 'MISSING'}
  Assert-Safe $root
  if(-not (Get-Item -LiteralPath $root -Force).PSIsContainer){throw 'Invalid enrollment directory'}
  Assert-NoReparse $file
  if(-not (Test-Path -LiteralPath $file)){return 'MISSING'}
  Assert-Safe $file
  $entry=Get-Item -LiteralPath $file -Force
  if($entry.PSIsContainer -or $entry.Length -gt 128){throw 'Invalid enrollment file'}
  if($entry.PSObject.Properties['LinkType'] -and $entry.LinkType){throw 'Enrollment hard links refused'}
  $value=[IO.File]::ReadAllText($file,$utf8).TrimEnd([char[]]"`r`n")
  $prefix='intentaiops-host-enrollment-v1:'
  if(-not $value.StartsWith($prefix,[StringComparison]::Ordinal)){throw 'Unsupported enrollment record'}
  $identifier=$value.Substring($prefix.Length)
  if(-not (Valid-Id $identifier)){throw 'Invalid enrollment identifier'}
  return $identifier
}
if($Operation -eq 'read'){Write-Output (Read-Id);return}
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Enrollment requires an administrator'}
if($Payload.Length -gt 2048){throw 'Invalid enrollment request size'}
$request=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))|ConvertFrom-Json
$next=[string]$request.next;$previous=[string]$request.previous;$native=[string]$request.native
if(-not (Valid-Id $next) -or ($previous -ne 'MISSING' -and -not (Valid-Id $previous)) -or $next -eq $previous){throw 'Invalid enrollment request'}
function Check-Native {
  $current=(Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid
  if(-not [string]::Equals([string]$current,$native,[StringComparison]::Ordinal)){throw 'Native identity changed'}
}
Check-Native
Assert-NoReparse $root
if(-not (Test-Path -LiteralPath $root)) {
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  $acl.SetAccessRuleProtection($true,$false)
  foreach($sid in $trusted) {$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))}
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-11'),[Security.AccessControl.FileSystemRights]::ReadAndExecute,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
  [void][IO.Directory]::CreateDirectory($root,$acl)
}
Assert-Safe $root
$lockPath=Join-Path $root '.write-lock'
Assert-NoReparse $lockPath
[void](New-Item -ItemType Directory -Path $lockPath -ErrorAction Stop)
$temporary=Join-Path $root ('.pending-'+[guid]::NewGuid().ToString('N'))
try {
  if((Read-Id) -cne $previous){throw 'Enrollment changed; review again'}
  Check-Native
  $bytes=$utf8.GetBytes('intentaiops-host-enrollment-v1:'+$next+"`n")
  $stream=[IO.FileStream]::new($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
  try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
  $fileAcl=Get-Acl -LiteralPath $temporary
  $fileAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  [IO.File]::SetAccessControl($temporary,$fileAcl)
  Assert-Safe $temporary
  if(-not ('IntentEnrollmentFile' -as [type])){Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class IntentEnrollmentFile{[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool MoveFileEx(string source,string destination,uint flags);}'}
  $flags=[uint32]8;if($previous -ne 'MISSING'){$flags=[uint32]9}
  if(-not [IntentEnrollmentFile]::MoveFileEx($temporary,$file,$flags)){throw 'Enrollment publication failed'}
  if((Read-Id) -cne $next){throw 'Enrollment verification failed'}
  Write-Output 'INTENTAI_OPS_HOST_ENROLLED'
} finally {
  if([IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)}
  [IO.Directory]::Delete($lockPath)
}
