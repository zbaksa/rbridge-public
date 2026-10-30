# Synthetic disposable Windows filesystem/registry qualification; never owner acceptance.
$ErrorActionPreference='Stop'
$VerbosePreference='Continue'
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
 [void][IO.Directory]::CreateDirectory((Join-Path $Root 'events\v3-results'))
 [void][IO.Directory]::CreateDirectory((Join-Path $Root 'keys'))
 [IO.File]::Copy($Candidate,(Join-Path $Root 'rbridge-native-host.exe'),$false)
 $Overlay=New-Object IO.FileStream((Join-Path $Root 'rbridge-native-host.exe'),[IO.FileMode]::Append,[IO.FileAccess]::Write)
 try {$B=$Utf8.GetBytes('SYNTHETIC predecessor PE overlay');$Overlay.Write($B,0,$B.Length)} finally {$Overlay.Dispose()}
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
 try {$R=Run-P01 $C;Assert-P01 ($R.status -ceq 'BLOCKED' -and -not $R.publicationStarted) 'ACTIVE_WRITER_ACCEPTED'} finally {$Held.Dispose()}
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

 # Real CreateProcess attempts must fail while either installed image gate is held.
 $script:RealRename=(Get-Command Rename-Entry).ScriptBlock
 $script:LaunchAttempts=0;$script:LaunchEscaped=$false;$script:FaultAfter=0;$script:RenameCount=0
 function Rename-Entry($Entry,[string]$Destination) {
  foreach($Moment in @('before','after')) {
   if ($Moment -ceq 'after') {& $script:RealRename $Entry $Destination;$script:RenameCount++}
   $Installed=Join-Path $script:FaultContext.root 'rbridge-native-host.exe'
   if (Test-Path -LiteralPath $Installed) {
    $Start=New-Object Diagnostics.ProcessStartInfo;$Start.FileName=$Installed
    $Start.Arguments='--check-config "'+(Join-Path $script:FaultContext.root 'rbridge-native-host.config.json')+'"';$Start.UseShellExecute=$false;$Start.CreateNoWindow=$true
    $P=New-Object Diagnostics.Process;$P.StartInfo=$Start;$Started=$false;$script:LaunchAttempts++
    try {[void]$P.Start();$Started=$true;$script:LaunchEscaped=$true;[void]$P.WaitForExit(3000)}
    catch [ComponentModel.Win32Exception] {
     if ($_.Exception.NativeErrorCode -notin @(5,32)) {throw}
    } finally {if ($Started -and -not $P.HasExited) {$P.Kill()};$P.Dispose()}
   }
  }
  if ($script:FaultAfter -gt 0 -and $script:RenameCount -eq $script:FaultAfter) {throw 'SYNTHETIC_CRASH_AFTER_HELD_RENAME'}
 }
 $script:InstrumentedRename=(Get-Command Rename-Entry).ScriptBlock
 try {
  for($Crash=1;$Crash -le 6;$Crash++) {
   $C=New-Fixture;$script:FaultContext=$C;$script:FaultAfter=$Crash;$script:RenameCount=0
   $R=Run-P01 $C
   Assert-P01 ($R.status -ceq 'UNKNOWN' -and $R.publicationStarted) ('CRASH_NOT_RETAINED_'+$Crash)
   $Before=Snap-Fixture $C;$R=Run-P01 $C
   Assert-P01 ($R.status -ceq 'UNKNOWN' -and -not $R.publicationStarted -and (Snap-Fixture $C) -ceq $Before) ('PARTIAL_AUTOMATICALLY_RETRIED_'+$Crash)
   Set-Item -Path Function:\Rename-Entry -Value $script:RealRename
   $R=Invoke-P01NativePristineTransaction -Context $C -Reconcile
   Assert-P01 ($R.status -ceq 'COMPLETE') ('FORWARD_RECONCILIATION_FAILED_'+$Crash+' '+($R|ConvertTo-Json -Compress))
   Assert-P01 ((Get-FileHash -LiteralPath (Join-Path $C.root 'rbridge-native-host.config.json')).Hash.ToLowerInvariant() -ceq (P01-HashBytes $C.configBytes)) 'RECONCILED_CONFIG_WRONG'
   Assert-P01 ((Get-FileHash -LiteralPath (Join-Path $C.root 'events\v3-peer-owner.json')).Hash.ToLowerInvariant() -ceq (P01-HashBytes $C.ownerBytes)) 'RECONCILED_OWNER_WRONG'
   Set-Item -Path Function:\Rename-Entry -Value $script:InstrumentedRename
  }
  $C=New-Fixture;$script:FaultContext=$C;$script:FaultAfter=1;$script:RenameCount=0;$R=Run-P01 $C
  Set-Item -Path Function:\Rename-Entry -Value $script:RealRename
  Write-QA (Join-Path $C.root 'rbridge-native-host.exe') 'SYNTHETIC foreign occupied publication slot'
  $Before=Snap-Fixture $C;$R=Invoke-P01NativePristineTransaction -Context $C -Reconcile
  Assert-P01 ($R.status -ceq 'UNKNOWN' -and -not $R.publicationStarted -and (Snap-Fixture $C) -ceq $Before) 'FOREIGN_SLOT_OVERWRITTEN'
  Set-Item -Path Function:\Rename-Entry -Value $script:InstrumentedRename
  $C=New-Fixture;$script:FaultContext=$C;$script:FaultAfter=2;$script:RenameCount=0;$R=Run-P01 $C
  Set-Item -Path Function:\Rename-Entry -Value $script:RealRename
  Write-QA (Join-Path $C.root 'events\events.ndjson') ''
  $Before=Snap-Fixture $C;$R=Invoke-P01NativePristineTransaction -Context $C -Reconcile
  Assert-P01 ($R.status -cin @('UNKNOWN','BLOCKED') -and -not $R.publicationStarted -and (Snap-Fixture $C) -ceq $Before) 'RECONCILIATION_ADOPTED_HISTORY'
 } finally {Set-Item -Path Function:\Rename-Entry -Value $script:RealRename}
 Assert-P01 ($script:LaunchAttempts -gt 0 -and -not $script:LaunchEscaped) 'FRESH_CREATEPROCESS_NOT_EXCLUDED'
 $C=New-Fixture
 $Path=Join-Path $C.root 'rbridge-native-host.config.json';$SavedAcl=Get-Acl -LiteralPath $Path;$BadAcl=Get-Acl -LiteralPath $Path
 $Foreign=New-Object Security.Principal.SecurityIdentifier('S-1-5-11')
 $Rule=New-Object Security.AccessControl.FileSystemAccessRule($Foreign,[Security.AccessControl.FileSystemRights]::Write,[Security.AccessControl.AccessControlType]::Allow)
 $BadAcl.AddAccessRule($Rule);Set-Acl -LiteralPath $Path -AclObject $BadAcl
 try {Block-Unchanged $C 'FOREIGN_WRITABLE_ACL'} finally {Set-Acl -LiteralPath $Path -AclObject $SavedAcl}
 $C=New-Fixture;$R=Invoke-P01NativePristineTransaction -Context $C -StatusOnly
 Assert-P01 ($R.status -ceq 'NONE' -and -not $R.publicationStarted -and -not (Test-Path -LiteralPath (Join-Path $C.root '.p01-pristine-upgrade'))) 'NONE_STATUS_CREATED_TRANSACTION'


 # Constructor fixtures contain public predecessor pins and synthetic peer IDs.
 # Every expected rejection occurs before any original-owner file read.
 function New-ManifestFixture {
  return [ordered]@{
   schema='COCWIN_P01_PRISTINE_OWNER_KIT_V1'
   source=@{appCommit=('1'*40);canonicalCommit=('9'*40);tree=('a'*40)}
   scope=@{appId='cocwin';baseSha='2f17ffcf5d8aefbb7bd3d3e4506f8fee965fd6db';sessionId='exta-4786c8bd94d2feecc1e26a031b0693d6';generation='7e7d5e17-2c44-4094-a6c8-0cf470ed564c'}
   peer=@{peerId='SYNTHETIC-peer';releaseSha=('9'*40);browserInstanceId='SYNTHETIC-browser';browserProfileId='SYNTHETIC-profile';protocolMinor=1;maxMessageBytes=65536;capabilities=@('CHAT_TARGET_DISCOVERY_V1','CHAT_BINDING_V1','CHAT_WRITE_LEADER_V1','CHAT_CAPTURE_V1','CHAT_SEND_TX_V1','CHAT_QUOTA_OBSERVATION_V1','CHAT_ROLLOVER_V1','REPLAY_SEQUENCE_V1','CHAT_EFFECT_REQUEST_V1','CHAT_ASSISTANT_TURN_CAPTURE_V2','CHAT_SCOPE_QUIESCENCE_V1')}
   predecessor=@{
    startup=@{bytes=1095;sha256='fc4d970903a94d6c49fc6dd5a9edf6f4aec4a61ccbfaf8c149974b203d2649d5'}
    nativeConfig=@{bytes=1553;sha256='648e5d88a3eb3a98dd0c7c2508a7071eeaf642176b3587f5ecd22f4d43e0a70a'}
    nativeManifest=@{bytes=372;sha256='537717d92a24d8cf696e7b506fbdaeb745cbbc6627f16566e346e7c7056424a3'}
    nativeExecutable=@{bytes=87200256;sha256='c4d9317d84dbd7ac2f0d73df3c939fe2452eb6a78e56a142d17c83876228e5ee'}
    ownerMarker=@{bytes=696;sha256='81ab1ca55f715567c56e2efda611f12f23398b68023062db2740bb8e8103d3de'}
   }
   startup=@{path='extension/p01-startup.json';bytes=3;sha256=('f'*64)}
   native=@{path='native/rbridge-native-host.exe';bytes=1234;sha256=('e'*64);metadataPath='native/rbridge-native-host.metadata.json';metadataSha256=('d'*64);sourceCommit=('9'*40);sourceTree=('a'*40)}
   resources=@(foreach($Name in @('manifest.json','serviceWorker.js','contentScript.js','p01-startup.json','setup.html','setup.js')) {@{path=$Name;bytes=3;sha256=('f'*64)}})
  }
 }
 function Reject-Constructor($M,[string]$Reason,[bool]$WrongPin=$false) {
  $Package=Join-Path $Sandbox ('SYNTHETIC-package-'+[guid]::NewGuid().ToString('N'));[void][IO.Directory]::CreateDirectory($Package)
  $Path=Join-Path $Package 'MANIFEST.json';Write-QA $Path ($M|ConvertTo-Json -Depth 20)
  $Pin=(Pin-QA $Path).sha256;if ($WrongPin) {$Pin='0'*64}
  $Caught=''
  try {[void](New-P01PinnedContext $Package $Pin)} catch {$Caught=$_.Exception.Message}
  Assert-P01 ($Caught -ceq $Reason) ('CONSTRUCTOR_REJECTION_WRONG expected='+$Reason+' actual='+$Caught)
  Assert-P01 (@(Get-ChildItem -LiteralPath $Package -Force).Count -eq 1) 'CONSTRUCTOR_MUTATED_PACKAGE'
 }
 $M=New-ManifestFixture;$M.extra='SYNTHETIC unknown field';Reject-Constructor $M 'CLOSED_OBJECT_FIELDS_CHANGED'
 $M=New-ManifestFixture;$M.source.canonicalCommit='SYNTHETIC invalid source';Reject-Constructor $M 'SOURCE_PROOF_INVALID'
 $M=New-ManifestFixture;$M.scope.generation='SYNTHETIC different scope';Reject-Constructor $M 'ORIGINAL_SCOPE_REQUIRED'
 $M=New-ManifestFixture;$M.peer.capabilities=$M.peer.capabilities[0..9];Reject-Constructor $M 'PEER_CAPABILITIES_INVALID'
 $M=New-ManifestFixture;$M.peer.capabilities+=@('CHAT_SCOPE_QUIESCENCE_V1');Reject-Constructor $M 'PEER_CAPABILITIES_INVALID'
 $M=New-ManifestFixture;$M.peer.releaseSha='8'*40;Reject-Constructor $M 'PEER_SOURCE_PROOF_INVALID'
 $M=New-ManifestFixture;$M.native.sourceTree='b'*40;Reject-Constructor $M 'NATIVE_ARTIFACT_PROOF_INVALID'
 $M=New-ManifestFixture;$M.predecessor.nativeExecutable.sha256='630ea7b69c12283ac311cbf137adfaf8078f091071697bab355282d080997b95';Reject-Constructor $M 'ORIGINAL_PREDECESSOR_REQUIRED'
 $M=New-ManifestFixture;$M.resources[0].path='../SYNTHETIC-escape';Reject-Constructor $M 'KIT_RESOURCE_PIN_INVALID'
 $M=New-ManifestFixture;$M.startup.sha256='b'*64;Reject-Constructor $M 'STARTUP_RESOURCE_PIN_MISMATCH'
 $M=New-ManifestFixture;Reject-Constructor $M 'PACKAGE_MANIFEST_CHANGED' $true
 # This process-control fixture proves the synthetic predecessor is executable
 # before attempts to launch it are refused by the held kernel image gates.
 $Control=New-Fixture
 & (Join-Path $Control.root 'rbridge-native-host.exe') --check-config (Join-Path $Control.root 'rbridge-native-host.config.json') | Out-Null
 Assert-P01 ($LASTEXITCODE -eq 0) 'SYNTHETIC_IMAGE_CONTROL_DID_NOT_RUN'

 [pscustomobject]@{schema='COCWIN_P01_SYNTHETIC_WINDOWS_QA_V1';status='PASS';passed=$Passed;actualOwnerWindows='NOT_RUN';sshConnections=0;browserSends=0}
} finally {
 [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($Registry,$false)
 if (Test-Path -LiteralPath $Sandbox) {Remove-Item -LiteralPath $Sandbox -Recurse -Force}
}
