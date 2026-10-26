[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SourceExe,[ValidateSet('All','PreserveExisting')][string]$Case='All')
$ErrorActionPreference='Stop'
$Installer=Join-Path $PSScriptRoot 'install-native-host-windows.ps1'
$SourceExe=(Resolve-Path -LiteralPath $SourceExe).Path
$Root=Join-Path ([IO.Path]::GetTempPath()) ('rbridge-v3-install-qa-'+[Guid]::NewGuid().ToString('N'))
$HostName='com.cocwin.rbridge_chat_v1'
$Keys=@("HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName","HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName")
$Saved=@();foreach($key in $Keys){$present=Test-Path -LiteralPath $key;$Saved+=@{Path=$key;Present=$present;Value=$(if($present){(Get-Item -LiteralPath $key).GetValue('')}else{$null})}}
$Utf8=New-Object Text.UTF8Encoding($false)
function Assert-QA([bool]$condition,[string]$code){if(-not $condition){throw $code}}
function Hash-File([string]$path){return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Write-Config([string]$path,[object]$value){[IO.File]::WriteAllText($path,($value|ConvertTo-Json -Depth 16),$Utf8)}
function Config([string]$install){return [ordered]@{schema='RBRIDGE_NATIVE_HOST_CONFIG_V1';expectedExtensionId='ebibbijpegoankenmggdnehpoadcophk';eventStoreRoot=(Join-Path $install 'events');ssh=[ordered]@{sshPath=$SshPath;host='fixture.invalid';port=22;user='rbridge';identityFile=$Identity;knownHostsFile=$Known};v3=[ordered]@{scope=[ordered]@{appId='cocwin';baseSha=('a'*40);sessionId=('exta-'+('1'*32));generation='22222222-2222-4222-8222-222222222222'};peerPins=[ordered]@{peerId='fixture-peer';releaseSha=('9'*40);browserInstanceId='fixture-browser';browserProfileId='fixture-profile';protocolMinor=1;maxMessageBytes=65536;capabilities=@('CHAT_TARGET_DISCOVERY_V1','CHAT_BINDING_V1','CHAT_WRITE_LEADER_V1','CHAT_CAPTURE_V1','CHAT_SEND_TX_V1','CHAT_QUOTA_OBSERVATION_V1','CHAT_ROLLOVER_V1','REPLAY_SEQUENCE_V1','CHAT_EFFECT_REQUEST_V1','CHAT_ASSISTANT_TURN_CAPTURE_V2')};initialHistory=[ordered]@{sequence=0;eventSha256=$null}}}}
function Install([string]$dir,[string]$v3=''){$InstallArgs=@{SourceExe=$SourceExe;InstallDir=$dir;IdentityFile=$Identity;KnownHostsFile=$Known;SshHost='fixture.invalid'};if($v3){$InstallArgs.V3ConfigFile=$v3};return (& $Installer @InstallArgs|Out-String|ConvertFrom-Json)}
function Check([string]$path){$raw=(& $SourceExe --check-config $path|Out-String);Assert-QA ($LASTEXITCODE -eq 0) 'QA085_CHECKER_FAILED';return ($raw|ConvertFrom-Json)}
$Passed=0
try{
 New-Item -ItemType Directory -Path $Root|Out-Null
 $Identity=Join-Path $Root 'fixture-identity';$Known=Join-Path $Root 'fixture-known-hosts';[IO.File]::WriteAllText($Identity,'NO_REAL_KEY',$Utf8);[IO.File]::WriteAllText($Known,'NO_REAL_HOST_KEY',$Utf8);$SshPath=(Get-Command ssh.exe -ErrorAction Stop).Source
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
 }
 [pscustomobject]@{schema='RBRIDGE_WINDOWS_V3_INSTALL_QA_V1';state='PASS';case=$Case;passed=$Passed;actualSSHConnections=0;ownerWindows='NOT_RUN'}|ConvertTo-Json -Compress
}finally{
 foreach($item in $Saved){if($item.Present){New-Item -Path $item.Path -Force|Out-Null;Set-Item -Path $item.Path -Value $item.Value}else{if(Test-Path -LiteralPath $item.Path){Remove-Item -LiteralPath $item.Path -Recurse -Force}}}
 if(Test-Path -LiteralPath $Root){Remove-Item -LiteralPath $Root -Recurse -Force}
}
