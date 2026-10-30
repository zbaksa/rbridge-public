# Synthetic disposable Windows filesystem/registry qualification; never owner acceptance.
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {throw 'ACTUAL_WINDOWS_REQUIRED'}
$Executor=Join-Path $PSScriptRoot 'upgrade-p01-pristine-native-windows.ps1'
if (-not (Test-Path -LiteralPath $Executor)) {throw 'P01_PRISTINE_NATIVE_EXECUTOR_NOT_IMPLEMENTED'}
. $Executor -LibraryOnly
$Utf8=New-Object Text.UTF8Encoding($false)
$Passed=0
function Assert-P01([bool]$Ok,[string]$Why) {if (-not $Ok) {throw $Why};$script:Passed++}
function Pin-QA([string]$Path) {return @{bytes=(Get-Item -LiteralPath $Path).Length;sha256=(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}}
function Write-QA([string]$Path,[string]$Text) {[IO.File]::WriteAllText($Path,$Text,$Utf8)}
$Sandbox=Join-Path ([IO.Path]::GetTempPath()) ('cocwin-p01-SYNTHETIC-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($Sandbox)
$Registry='Software\COCWIN\P01SyntheticTests\'+[guid]::NewGuid().ToString('N')
$Candidate=Join-Path $Sandbox 'synthetic-check-only.exe'
$Code=@'
using System;
using System.IO;
using System.Security.Cryptography;
public static class SyntheticCheckOnly {
 public static int Main(string[] args) {
  if(args.Length!=2 || args[0]!="--check-config") return 41;
  var raw=File.ReadAllBytes(args[1]); string hash;
  using(var sha=SHA256.Create()) hash=BitConverter.ToString(sha.ComputeHash(raw)).Replace("-","").ToLowerInvariant();
  Console.WriteLine("{\"schema\":\"RBRIDGE_NATIVE_CONFIG_CHECK_V1\",\"status\":\"PASS\",\"sourceSha256\":\""+hash+"\",\"expectedExtensionId\":\"ebibbijpegoankenmggdnehpoadcophk\",\"v3Configured\":true,\"activated\":false}");
  return 0;
 }
}
'@
$Provider=New-Object Microsoft.CSharp.CSharpCodeProvider
$Compiler=New-Object CodeDom.Compiler.CompilerParameters
$Compiler.GenerateExecutable=$true;$Compiler.OutputAssembly=$Candidate
$Compiled=$Provider.CompileAssemblyFromSource($Compiler,$Code)
if ($Compiled.Errors.HasErrors) {throw 'SYNTHETIC_CHECKER_COMPILATION_FAILED'}
$Provider.Dispose()
function New-Fixture {
 $Root=Join-Path $Sandbox ([guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($Root)
 [void][IO.Directory]::CreateDirectory((Join-Path $Root 'events'))
 [void][IO.Directory]::CreateDirectory((Join-Path $Root 'keys'))
 Write-QA (Join-Path $Root 'rbridge-native-host.exe') 'SYNTHETIC old executable; never executable owner bytes'
 Write-QA (Join-Path $Root 'rbridge-native-host.config.json') '{"schema":"SYNTHETIC_P01_CONFIG","old":true}'
 Write-QA (Join-Path $Root 'com.cocwin.rbridge_chat_v1.json') '{"schema":"SYNTHETIC_P01_MANIFEST"}'
 Write-QA (Join-Path $Root 'events\v3-peer-owner.json') '{"schema":"SYNTHETIC_P01_OWNER","originalScope":true}'
 Write-QA (Join-Path $Root '.owner-setup-v1.json') 'SYNTHETIC predecessor provenance; immutable'
 Write-QA (Join-Path $Root 'keys\owner_ed25519') 'SYNTHETIC non-key'
 Write-QA (Join-Path $Root 'keys\owner_ed25519.pub') 'SYNTHETIC non-public-key'
 Write-QA (Join-Path $Root 'keys\known_hosts.cocwin') 'SYNTHETIC non-host'
 Write-QA (Join-Path $Root 'rbridge-native-host.config.json.pre-p01-backup') 'SYNTHETIC older backup must survive exactbytes'
 $Key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($Registry)
 try {$Key.SetValue('',(Join-Path $Root 'com.cocwin.rbridge_chat_v1.json'),[Microsoft.Win32.RegistryValueKind]::String)} finally {$Key.Dispose()}
 $Pins=@{}
 foreach($Name in @('rbridge-native-host.exe','rbridge-native-host.config.json','com.cocwin.rbridge_chat_v1.json','events\v3-peer-owner.json')) {$Pins[$Name]=Pin-QA (Join-Path $Root $Name)}
 return @{
  root=$Root;packageExecutable=$Candidate;predecessor=$Pins;targetExecutable=(Pin-QA $Candidate)
  configBytes=$Utf8.GetBytes('{"schema":"SYNTHETIC_P01_CONFIG","target":true}'+[char]10)
  ownerBytes=$Utf8.GetBytes('{"schema":"SYNTHETIC_P01_OWNER","originalScope":true,"target":true}'+[char]10)
  registryPaths=@($Registry)
  allowedRootEntries=@('rbridge-native-host.exe','rbridge-native-host.config.json','com.cocwin.rbridge_chat_v1.json','.owner-setup-v1.json','keys','events','rbridge-native-host.config.json.pre-p01-backup')
 }
}
function Snap-Fixture($C) {
 return (@(Get-ChildItem -LiteralPath $C.root -Recurse -Force -File | Where-Object {$_.FullName -notlike '*\.p01-pristine-upgrade\*'} | Sort-Object FullName | ForEach-Object {
 [ordered]@{name=$_.FullName.Substring($C.root.Length);sha=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash;sddl=(Get-Acl -LiteralPath $_.FullName).Sddl}
 }) | ConvertTo-Json -Depth 5 -Compress)
}
function Run-P01($C) {return Invoke-P01NativePristineTransaction -Context $C}
function Block-Unchanged($C,[string]$Name) {$Before=Snap-Fixture $C;$R=Run-P01 $C;Assert-P01 ($R.status -ceq 'BLOCKED' -and -not $R.publicationStarted) ($Name+'_ACCEPTED');Assert-P01 ((Snap-Fixture $C) -ceq $Before) ($Name+'_MUTATED')}
try {
 # Every predecessor is independently required, including the qualified c4d executable.
 foreach($Name in @('rbridge-native-host.exe','rbridge-native-host.config.json','com.cocwin.rbridge_chat_v1.json','events\v3-peer-owner.json')) {
  $C=New-Fixture;Write-QA (Join-Path $C.root $Name) 'SYNTHETIC wrong predecessor';Block-Unchanged $C 'WRONG_PREIMAGE'
 }
 foreach($Name in @('events\events.ndjson','events\results','events\peer-journal','events\pending-upload','events\partial','events\query','events\stop','events\unexpected')) {
  $C=New-Fixture;Write-QA (Join-Path $C.root $Name) '';Block-Unchanged $C 'HISTORY_OR_PARTIAL'
 }
 $C=New-Fixture;$Alias=Join-Path $Sandbox 'hardlink'
 [void](New-Item -ItemType HardLink -Path $Alias -Target (Join-Path $C.root 'rbridge-native-host.config.json'))
 try {Block-Unchanged $C 'HARDLINK'} finally {[IO.File]::Delete($Alias)}
 $C=New-Fixture;$Junction=Join-Path $C.root 'events\foreign'
 [void](New-Item -ItemType Junction -Path $Junction -Target $Sandbox)
 try {$R=Run-P01 $C;Assert-P01 ($R.status -ceq 'BLOCKED' -and -not $R.publicationStarted) 'REPARSE_ACCEPTED'} finally {[IO.Directory]::Delete($Junction,$false)}
 $C=New-Fixture
 $Held=New-Object IO.FileStream((Join-Path $C.root 'rbridge-native-host.exe'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
 try {Block-Unchanged $C 'ACTIVE_WRITER'} finally {$Held.Dispose()}
 $C=New-Fixture
 $Key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Registry,$true)
 try {$Key.SetValue('','C:\synthetic-wrong-binding.json')} finally {$Key.Dispose()}
 Block-Unchanged $C 'WRONG_REGISTRATION'
 $C=New-Fixture;$Before=Snap-Fixture $C
 [void][IO.Directory]::CreateDirectory((Join-Path $C.root '.p01-pristine-upgrade'))
 Write-QA (Join-Path $C.root '.p01-pristine-upgrade\intent.json') '{"schema":"FOREIGN_OR_PARTIAL"}'
 $R=Run-P01 $C;Assert-P01 ($R.status -ceq 'UNKNOWN' -and -not $R.publicationStarted) 'UNRECOGNIZED_PARTIAL_RETRIED'
 Assert-P01 ((Snap-Fixture $C) -ceq $Before) 'UNRECOGNIZED_PARTIAL_MUTATED'
 $C=New-Fixture
 $OriginalConfig=[IO.File]::ReadAllBytes((Join-Path $C.root 'rbridge-native-host.config.json'))
 $OriginalOwner=[IO.File]::ReadAllBytes((Join-Path $C.root 'events\v3-peer-owner.json'))
 $OlderBackup=Get-FileHash -LiteralPath (Join-Path $C.root 'rbridge-native-host.config.json.pre-p01-backup')
 $R=Run-P01 $C
 Assert-P01 ($R.status -ceq 'COMPLETE' -and $R.phase -ceq 'COMPLETE' -and $R.publicationStarted -and $R.activated -eq $false) ('PRISTINE_PUBLICATION_FAILED '+($R|ConvertTo-Json -Compress))
 $Tx=Join-Path $C.root '.p01-pristine-upgrade'
 Assert-P01 ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $Tx 'original.config.json'))) -ceq [Convert]::ToBase64String($OriginalConfig)) 'CONFIG_BACKUP_CHANGED'
 Assert-P01 ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $Tx 'original.owner.json'))) -ceq [Convert]::ToBase64String($OriginalOwner)) 'OWNER_BACKUP_CHANGED'
 Assert-P01 ((Get-FileHash -LiteralPath (Join-Path $C.root 'rbridge-native-host.config.json.pre-p01-backup')).Hash -ceq $OlderBackup.Hash) 'OLDER_BACKUP_CHANGED'
 Assert-P01 ((Get-FileHash -LiteralPath (Join-Path $C.root 'rbridge-native-host.exe')).Hash.ToLowerInvariant() -ceq $C.targetExecutable.sha256) 'EXECUTABLE_NOT_INSTALLED'
 $Before=Snap-Fixture $C;$R=Run-P01 $C
 Assert-P01 ($R.status -ceq 'COMPLETE' -and -not $R.publicationStarted -and (Snap-Fixture $C) -ceq $Before) 'COMPLETE_REPLAY_MUTATED'
 Write-QA (Join-Path $C.root 'rbridge-native-host.config.json') 'SYNTHETIC post-complete tamper'
 $R=Run-P01 $C;Assert-P01 ($R.status -ceq 'UNKNOWN') 'TAMPERED_COMPLETE_ACCEPTED'
 [pscustomobject]@{schema='COCWIN_P01_SYNTHETIC_WINDOWS_QA_V1';status='PASS';passed=$Passed;actualOwnerWindows='NOT_RUN';sshConnections=0;browserSends=0}
} finally {
 [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($Registry,$false)
 if (Test-Path -LiteralPath $Sandbox) {Remove-Item -LiteralPath $Sandbox -Recurse -Force}
}
