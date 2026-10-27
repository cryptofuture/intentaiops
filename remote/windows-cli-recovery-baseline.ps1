param([Parameter(Mandatory=$true)][int]$TaskId)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($TaskId -lt 1 -or [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne 'S-1-5-18') { throw 'Windows CLI recovery requires LocalSystem and a valid task identity' }
$state="C:\ProgramData\WebminAI\Tasks\$TaskId-intent-ai-ops-install"
$root='C:\ProgramData\IntentAIOps\Cli'
$trusted=@('S-1-5-18','S-1-5-32-544')
$installer='S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$clock=[Diagnostics.Stopwatch]::StartNew()
$records=[Collections.Generic.List[string]]::new()
$budget=@{count=0;bytes=[long]0}
if (-not ('IntentCliRecoveryFile' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class IntentCliRecoveryFile {
    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    public static string Identity(string path, bool directory) {
        using (var handle=CreateFile(path,128,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero)) {
            Info info;
            if (handle.IsInvalid || !GetFileInformationByHandle(handle,out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (!directory && info.Links!=1) throw new IOException("Recovery refuses hard-linked files");
            return info.Volume+":"+info.IndexHigh+":"+info.IndexLow+":"+info.Creation.dwHighDateTime+":"+info.Creation.dwLowDateTime;
        }
    }
}
'@
}
function Assert-Safe([string]$Path,[bool]$Ancestor=$false) {
    $item=Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Recovery refuses reparse points' }
    $acl=Get-Acl -LiteralPath $Path
    $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin $trusted -and -not ($Ancestor -and $owner -eq $installer)) { throw 'Unsafe CLI recovery owner' }
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0 -or $rule.IdentityReference.Value -in $trusted -or ($Ancestor -and $rule.IdentityReference.Value -eq $installer)) { continue }
        $dangerous=[long]([Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership) -bor 268435456
        if (-not $Ancestor) { $dangerous=$dangerous -bor [long][Security.AccessControl.FileSystemRights]::Write -bor 1073741824 }
        if (([long]$rule.FileSystemRights -band $dangerous) -ne 0) { throw 'Unsafe writable CLI recovery path' }
    }
    return $item
}
function Assert-Parents([string]$Path) {
    $parent=[IO.Path]::GetDirectoryName($Path)
    while ($parent) {
        $null=Assert-Safe $parent $true
        $next=[IO.Path]::GetDirectoryName($parent)
        if ($parent -eq $next) { break }
        $parent=$next
    }
}
function Record-Entry([string]$Path,[bool]$Contents=$true) {
    if (++$budget.count -gt 60000 -or $clock.Elapsed.TotalSeconds -gt 45) { throw 'CLI recovery inspection exceeds bounds' }
    $item=Assert-Safe $Path
    $identity=[IntentCliRecoveryFile]::Identity($Path,$item.PSIsContainer)
    $acl=(Get-Acl -LiteralPath $Path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Group,Access')
    $record=[ordered]@{path=$Path;identity=$identity;acl=$acl;attributes=[int]$item.Attributes}
    if (-not $item.PSIsContainer) {
        $budget.bytes+=$item.Length
        if ($budget.bytes -gt 1073741824 -or $item.Length -gt 536870912) { throw 'CLI recovery content exceeds bounds' }
        $record.length=$item.Length
        $record.modified=$item.LastWriteTimeUtc.Ticks
        if ($Contents) { $record.digest=(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
        if ([IntentCliRecoveryFile]::Identity($Path,$false) -cne $identity -or (Get-Item -LiteralPath $Path -Force).LastWriteTimeUtc.Ticks -ne $record.modified) { throw 'CLI recovery content changed during inspection' }
    }
    $records.Add(($record|ConvertTo-Json -Compress))
}
Assert-Parents $state
Assert-Parents $root
$null=Assert-Safe $state
foreach ($name in @('baseline','owns-root','installed','paths-before.json')) {
    $file=Join-Path $state $name
    if (-not [IO.File]::Exists($file)) { throw 'CLI ownership baseline is incomplete' }
}
if ([IO.File]::Exists((Join-Path $state 'preexisting')) -or [IO.File]::Exists((Join-Path $state 'root.existed'))) { throw 'Recovery cannot remove a preexisting CLI installation' }
$critical=@('baseline','owns-root','installed','paths-before.json','user-path-was-absent','machine-path-added')
$allowed=$critical+@('install.ps1','cli-help.txt','cli-help.stderr.txt','verify-help.txt','verify-help.stderr.txt')
foreach ($entry in [IO.DirectoryInfo]::new($state).EnumerateFileSystemInfos()) {
    if ($entry.Name -notin $allowed -or $entry -is [IO.DirectoryInfo]) { throw 'Unexpected CLI task state' }
    $null=Assert-Safe $entry.FullName
    if ($entry.Name -in $critical) {
        if ($entry.Length -gt 262144 -or ($entry.Name -ne 'paths-before.json' -and $entry.Length -ne 0)) { throw 'Invalid CLI ownership marker' }
        Record-Entry $entry.FullName
    }
}
Record-Entry $state
$paths=[IO.File]::ReadAllText((Join-Path $state 'paths-before.json'))|ConvertFrom-Json
if ($paths.version -ne 2 -or @($paths.PSObject.Properties.Name).Count -ne 3) { throw 'Invalid CLI PATH baseline' }
foreach ($scope in @('Machine','User')) {
    $saved=$paths.$scope
    if (@($saved.PSObject.Properties.Name).Count -ne 3 -or @('raw','kind','value'|Where-Object {$_ -notin $saved.PSObject.Properties.Name}).Count -ne 0 -or ($null -ne $saved.value -and $saved.value -isnot [string]) -or ($null -ne $saved.raw -and ($saved.raw -isnot [string] -or $saved.kind -notin @('String','ExpandString'))) -or ($null -eq $saved.raw -and $null -ne $saved.kind)) { throw 'Invalid CLI PATH baseline' }
}
$pending=[Collections.Generic.Stack[string]]::new()
$pending.Push($root)
while ($pending.Count) {
    $directory=$pending.Pop()
    Record-Entry $directory
    foreach ($entry in [IO.DirectoryInfo]::new($directory).EnumerateFileSystemInfos()) {
        $null=Assert-Safe $entry.FullName
        if ($entry -is [IO.DirectoryInfo]) { $pending.Push($entry.FullName) } else { Record-Entry $entry.FullName }
    }
}
foreach ($required in @('bin\intentaiops.cmd','node-path.txt','npm\node_modules\intent-ai-ops\bin\intentaiops.js')) {
    if (-not [IO.File]::Exists((Join-Path $root $required))) { throw 'Owned CLI tree is incomplete' }
}
$records.Sort([StringComparer]::Ordinal)
$sha=[Security.Cryptography.SHA256]::Create()
try { ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($records -join "`n"))))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
