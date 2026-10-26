[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SourceExe,[ValidateSet('All','PreserveExisting','ReviewRegressions')][string]$Case='All')
$ErrorActionPreference='Stop'
$Installer=Join-Path $PSScriptRoot 'install-native-host-windows.ps1'
$SourceExe=(Resolve-Path -LiteralPath $SourceExe).Path
$Root=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) ('rbridge-v3-install-qa-'+[Guid]::NewGuid().ToString('N'))
$HostName='com.cocwin.rbridge_chat_v1'
$Keys=@("HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName","HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName")
$Saved=@();foreach($key in $Keys){
 $present=Test-Path -LiteralPath $key;$entry=@{Path=$key;Present=$present;HasDefault=$false;Value=$null;Kind=[Microsoft.Win32.RegistryValueKind]::String}
 if($present){$reg=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($key.Substring(6));try{if(@($reg.GetValueNames()) -contains ''){$entry.HasDefault=$true;$entry.Kind=$reg.GetValueKind('');$entry.Value=$reg.GetValue('', $null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}}finally{$reg.Dispose()}}
 $Saved+=$entry
}
$Utf8=New-Object Text.UTF8Encoding($false)
function Assert-QA([bool]$condition,[string]$code){if(-not $condition){throw $code}}
function Hash-File([string]$path){return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Write-Config([string]$path,[object]$value){[IO.File]::WriteAllText($path,($value|ConvertTo-Json -Depth 16),$Utf8)}
function Config([string]$install){return [ordered]@{schema='RBRIDGE_NATIVE_HOST_CONFIG_V1';expectedExtensionId='ebibbijpegoankenmggdnehpoadcophk';eventStoreRoot=(Join-Path $install 'events');ssh=[ordered]@{sshPath=$SshPath;host='fixture.invalid';port=22;user='rbridge';identityFile=$Identity;knownHostsFile=$Known};v3=[ordered]@{scope=[ordered]@{appId='cocwin';baseSha=('a'*40);sessionId=('exta-'+('1'*32));generation='22222222-2222-4222-8222-222222222222'};peerPins=[ordered]@{peerId='fixture-peer';releaseSha=('9'*40);browserInstanceId='fixture-browser';browserProfileId='fixture-profile';protocolMinor=1;maxMessageBytes=65536;capabilities=@('CHAT_TARGET_DISCOVERY_V1','CHAT_BINDING_V1','CHAT_WRITE_LEADER_V1','CHAT_CAPTURE_V1','CHAT_SEND_TX_V1','CHAT_QUOTA_OBSERVATION_V1','CHAT_ROLLOVER_V1','REPLAY_SEQUENCE_V1','CHAT_EFFECT_REQUEST_V1','CHAT_ASSISTANT_TURN_CAPTURE_V2')};initialHistory=[ordered]@{sequence=0;eventSha256=$null}}}}
function Install([string]$dir,[string]$v3='',[string]$exe=$SourceExe){$InstallArgs=@{SourceExe=$exe;InstallDir=$dir;IdentityFile=$Identity;KnownHostsFile=$Known;SshHost='fixture.invalid'};if($v3){$InstallArgs.V3ConfigFile=$v3};return (& $Installer @InstallArgs|Out-String|ConvertFrom-Json)}
function Check([string]$path){$raw=(& $SourceExe --check-config $path|Out-String);Assert-QA ($LASTEXITCODE -eq 0) 'QA085_CHECKER_FAILED';return ($raw|ConvertFrom-Json)}
function Review-Regressions {
 $Errors=New-Object 'Collections.Generic.List[string]'
 $Stub=Join-Path $Root 'checker-stub.exe';$StubSource=Join-Path $Root 'checker-stub.cs'
 $Code=@'
using System;
using System.IO;
using System.Text;
using System.Security.Cryptography;
using System.Collections.Generic;
using System.Web.Script.Serialization;
class CheckerStub {
 static void Main(string[] args) {
  Console.OutputEncoding=new UTF8Encoding(false);
  var bytes=File.ReadAllBytes(args[1]);
  var json=new JavaScriptSerializer();
  var cfg=json.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(bytes));
  var hash=BitConverter.ToString(SHA256.Create().ComputeHash(bytes)).Replace("-","").ToLowerInvariant();
  var result=new Dictionary<string,object>{{"schema","RBRIDGE_NATIVE_CONFIG_CHECK_V1"},{"status","PASS"},{"sourceSha256",hash},{"expectedExtensionId","ebibbijpegoankenmggdnehpoadcophk"},{"eventStoreRoot",cfg["eventStoreRoot"]},{"v3Configured",true},{"activated",false}};
  var mode=Environment.GetEnvironmentVariable("RBRIDGE_QA_STUB_MODE");
  if(mode=="digest-array")result["sourceSha256"]=new object[0];
  if(mode=="boolean-array"){result["v3Configured"]=new object[0];result["activated"]=new object[0];}
  if(mode=="boolean-string"){result["v3Configured"]="true";result["activated"]="false";}
  Console.WriteLine(json.Serialize(result));
 }
}
'@
 [IO.File]::WriteAllText($StubSource,$Code,$Utf8)
 $Compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
 & $Compiler /nologo /target:exe /reference:System.Web.Extensions.dll ('/out:'+$Stub) $StubSource|Out-Null
 Assert-QA ($LASTEXITCODE -eq 0) 'QA085_STUB_BUILD_FAILED'
 function Review-Case([string]$name,[scriptblock]$body){try{& $body;Write-Output ('REVIEW_GREEN '+$name)}catch{$Errors.Add($_.Exception.Message);Write-Output ('REVIEW_RED '+$name+': '+$_.Exception.Message)}}
 foreach($Mode in @('digest-array','boolean-array','boolean-string')){
  Review-Case $Mode {
   $Dir=Join-Path $Root ('bad-'+$Mode);$InputPath=Join-Path $Root ($Mode+'.json');Write-Config $InputPath (Config $Dir);$env:RBRIDGE_QA_STUB_MODE=$Mode;$Rejected=$false
   $BeforeRegistry=@($Keys|ForEach-Object{if(Test-Path -LiteralPath $_){(Get-Item -LiteralPath $_).GetValue('')}else{$null}})
   try{$null=Install $Dir $InputPath $Stub}catch{$Rejected=$true}
   Assert-QA ($Rejected -and -not (Test-Path -LiteralPath $Dir)) ('QA085_BAD_RECEIPT_ACCEPTED_'+$Mode)
   for($i=0;$i -lt $Keys.Count;$i++){$now=if(Test-Path -LiteralPath $Keys[$i]){(Get-Item -LiteralPath $Keys[$i]).GetValue('')}else{$null};Assert-QA ($now -eq $BeforeRegistry[$i]) 'QA085_BAD_RECEIPT_CHANGED_REGISTRY'}
  }
 }
 $env:RBRIDGE_QA_STUB_MODE='valid'
 Review-Case 'concurrent-config' {
  $RaceDir=Join-Path $Root 'race';$RaceConfig=Join-Path $RaceDir 'rbridge-native-host.config.json';$RaceExe=Join-Path $RaceDir 'rbridge-native-host.exe';$RaceBytes=$Utf8.GetBytes(((Config $RaceDir)|ConvertTo-Json -Depth 16));$Injected=$false
  function Copy-Item { [CmdletBinding()]param([string]$LiteralPath,[string]$Destination,[switch]$Force)
   Microsoft.PowerShell.Management\Copy-Item @PSBoundParameters
   if($Destination -eq $RaceExe -and -not $Injected){[IO.File]::WriteAllBytes($RaceConfig,$RaceBytes);$script:Injected=$true}
  }
  try{$Rejected=$false;try{$null=Install $RaceDir}catch{$Rejected=$true};Assert-QA ($Rejected -and (Get-Content -LiteralPath $RaceConfig -Raw|ConvertFrom-Json).v3 -ne $null) 'QA085_CONCURRENT_V3_WAS_OVERWRITTEN'}finally{Remove-Item Function:Copy-Item -ErrorAction SilentlyContinue}
 }
 Review-Case 'registry-restore' {
  $Sentinel='qa085-sentinel-'+[Guid]::NewGuid().ToString('N')
  try{
   foreach($key in $Keys){$sub=$key.Substring(6);$reg=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($sub);try{$reg.SetValue($Sentinel,583,[Microsoft.Win32.RegistryValueKind]::DWord);$reg.SetValue('','%TEMP%\qa085',[Microsoft.Win32.RegistryValueKind]::ExpandString)}finally{$reg.Dispose()}}
   $NestedOutput=& $PSCommandPath -SourceExe $Stub -Case PreserveExisting
   foreach($key in $Keys){$reg=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($key.Substring(6));try{Assert-QA ($reg.GetValue($Sentinel) -eq 583 -and $reg.GetValueKind('') -eq [Microsoft.Win32.RegistryValueKind]::ExpandString -and $reg.GetValue('', $null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -eq '%TEMP%\qa085') 'QA085_REGISTRY_STATE_WAS_NOT_RESTORED'}finally{$reg.Dispose()}}
  }finally{foreach($key in $Keys){$reg=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($key.Substring(6),$true);if($reg){try{$reg.DeleteValue($Sentinel,$false)}finally{$reg.Dispose()}}}}
 }
 Remove-Item Env:RBRIDGE_QA_STUB_MODE -ErrorAction SilentlyContinue
 if($Errors.Count -gt 0){throw ('QA085_REVIEW_REGRESSIONS_FAILED:'+($Errors -join ','))}
 return 5
}
$Passed=0
try{
 New-Item -ItemType Directory -Path $Root|Out-Null
 $Identity=Join-Path $Root 'fixture-identity';$Known=Join-Path $Root 'fixture-known-hosts';[IO.File]::WriteAllText($Identity,'NO_REAL_KEY',$Utf8);[IO.File]::WriteAllText($Known,'NO_REAL_HOST_KEY',$Utf8);$SshPath=(Get-Command ssh.exe -ErrorAction Stop).Source
 if($Case -eq 'ReviewRegressions'){$null=Review-Regressions;return}
 # The regression is silent V3 removal during a normal reinstall.
 $Existing=Join-Path $Root 'existing';New-Item -ItemType Directory -Path (Join-Path $Existing 'events') -Force|Out-Null
 $ConfigPath=Join-Path $Existing 'rbridge-native-host.config.json';Write-Config $ConfigPath (Config $Existing);$Before=Hash-File $ConfigPath
 $History=Join-Path $Existing 'events\v3-peer-owner.json';[IO.File]::WriteAllText($History,'fixture-history-must-remain-unchanged',$Utf8);$HistoryBefore=Hash-File $History
 $null=Install $Existing
 $Current=Get-Content -LiteralPath $ConfigPath -Raw|ConvertFrom-Json
 Assert-QA ($null -ne $Current.v3) 'QA085_EXISTING_V3_WAS_REMOVED'
 Assert-QA ((Hash-File $ConfigPath) -eq $Before) 'QA085_EXISTING_V3_BYTES_CHANGED'
 Assert-QA ((Hash-File $History) -eq $HistoryBefore) 'QA085_EXISTING_HISTORY_CHANGED';$Passed++
 if($Case -eq 'All'){
  $checked=Check $ConfigPath;Assert-QA ($checked.v3Configured -and -not $checked.activated -and $checked.sourceSha256 -eq $Before) 'QA085_READONLY_CHECK_RECEIPT_INVALID';$Passed++
  $Fresh=Join-Path $Root 'fresh';$Input=Join-Path $Root 'supplied-v3.json';Write-Config $Input (Config $Fresh);$InputHash=Hash-File $Input;$null=Install $Fresh $Input
  Assert-QA ((Hash-File (Join-Path $Fresh 'rbridge-native-host.config.json')) -eq $InputHash) 'QA085_SUPPLIED_CONFIG_BYTES_CHANGED'
  Assert-QA (@(Get-ChildItem -LiteralPath (Join-Path $Fresh 'events') -Force).Count -eq 0) 'QA085_INSTALL_STARTED_NATIVE_RUNTIME';$Passed++
  $Different=Join-Path $Root 'different.json';$candidate=Config $Existing;$candidate.v3.scope.baseSha='b'*40;Write-Config $Different $candidate;$ExeHash=Hash-File (Join-Path $Existing 'rbridge-native-host.exe');$RegistryBefore=@($Keys|ForEach-Object{(Get-Item -LiteralPath $_).GetValue('')});$Rejected=$false
  try{$null=Install $Existing $Different}catch{$Rejected=$true};Assert-QA $Rejected 'QA085_CHANGED_V3_ACCEPTED'
  Assert-QA ((Hash-File $ConfigPath) -eq $Before -and (Hash-File $History) -eq $HistoryBefore -and (Hash-File (Join-Path $Existing 'rbridge-native-host.exe')) -eq $ExeHash) 'QA085_REJECTION_CHANGED_INSTALLED_FILES'
  for($i=0;$i -lt $Keys.Count;$i++){Assert-QA ((Get-Item -LiteralPath $Keys[$i]).GetValue('') -eq $RegistryBefore[$i]) 'QA085_REJECTION_CHANGED_REGISTRY'};$Passed++
  $InvalidDir=Join-Path $Root 'invalid-install';$Invalid=Join-Path $Root 'invalid.json';$candidate=Config $InvalidDir;$candidate.v3.scope.generation='bad';Write-Config $Invalid $candidate;$Rejected=$false
  try{$null=Install $InvalidDir $Invalid}catch{$Rejected=$true};Assert-QA ($Rejected -and -not (Test-Path -LiteralPath $InvalidDir)) 'QA085_INVALID_V3_WROTE_INSTALLATION';$Passed++
  $V1=Join-Path $Root 'legacy-v1';$null=Install $V1;$checked=Check (Join-Path $V1 'rbridge-native-host.config.json');Assert-QA (-not $checked.v3Configured) 'QA085_V1_COMPATIBILITY_CHANGED';$Passed++
  $null=Review-Regressions;$Passed+=5
 }
 [pscustomobject]@{schema='RBRIDGE_WINDOWS_V3_INSTALL_QA_V1';state='PASS';case=$Case;passed=$Passed;actualSSHConnections=0;ownerWindows='NOT_RUN'}|ConvertTo-Json -Compress
}finally{
 foreach($item in $Saved){if($item.Present){
  $reg=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($item.Path.Substring(6))
  try{if($item.HasDefault){$reg.SetValue('',$item.Value,$item.Kind)}else{$reg.DeleteValue('',$false)}}finally{$reg.Dispose()}
 }elseif(Test-Path -LiteralPath $item.Path){Remove-Item -LiteralPath $item.Path -Recurse -Force}}
 if(Test-Path -LiteralPath $Root){Remove-Item -LiteralPath $Root -Recurse -Force}
}
