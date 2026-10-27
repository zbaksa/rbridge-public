[CmdletBinding()]
param([string]$InstallDir = '')
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'WINDOWS_OWNER_FACTS_REQUIRE_WINDOWS' }
$Utf8 = New-Object Text.UTF8Encoding($false)
if ([string]::IsNullOrWhiteSpace($InstallDir)) { $InstallDir = Join-Path $env:LOCALAPPDATA 'COCWIN\RBridge\NativeHost' }
$NativeName = 'com.cocwin.rbridge_chat_v1'
function Local-Path([string]$Path) {
  if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path -match '[\r\n\x00]') { throw 'NONLOCAL_PATH_REJECTED' }
  $Full = [IO.Path]::GetFullPath($Path)
  $DriveRoot = [IO.Path]::GetPathRoot($Full)
  $Drive = New-Object IO.DriveInfo($DriveRoot)
  if ($Drive.DriveType -notin @([IO.DriveType]::Fixed,[IO.DriveType]::Removable,[IO.DriveType]::Ram,[IO.DriveType]::CDRom)) { throw 'NONLOCAL_PATH_REJECTED' }
  $Current = $DriveRoot
  foreach ($Part in $Full.Substring($DriveRoot.Length).Split('\')) {
    if ([string]::IsNullOrEmpty($Part)) { continue }
    $Current = Join-Path $Current $Part
    try { $Info = Get-Item -LiteralPath $Current -Force }
    catch { if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { break }; throw 'UNAVAILABLE_PATH' }
    if ($Info.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'UNTRUSTED_DIRECTORY' }
  }
  return $Full
}
function Observe-File([string]$Path,[long]$Limit,[bool]$KeepBytes) {
  try {
    $Full = Local-Path $Path
    if (-not (Test-Path -LiteralPath $Full)) { return @{state='ABSENT'} }
    $Info = Get-Item -LiteralPath $Full -Force
    if ($Info.PSIsContainer -or $Info.Length -lt 1 -or $Info.Length -gt $Limit) { return @{state='UNTRUSTED_FILE'} }
    $Stream = New-Object IO.FileStream($Full,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $Hasher = [Security.Cryptography.SHA256]::Create()
    try {
      if ($Stream.Length -ne $Info.Length) { return @{state='CHANGED_FILE'} }
      if ($KeepBytes) {
        $Bytes = New-Object byte[] ([int]$Info.Length)
        $Offset = 0
        while ($Offset -lt $Bytes.Length) {
          $Read = $Stream.Read($Bytes,$Offset,$Bytes.Length-$Offset)
          if ($Read -lt 1) { throw 'FILE_CHANGED' }
          $Offset += $Read
        }
        if ($Stream.ReadByte() -ne -1) { throw 'FILE_CHANGED' }
        $Digest = $Hasher.ComputeHash($Bytes)
      } else { $Digest = $Hasher.ComputeHash($Stream) }
      $Fact = @{state='PRESENT_METADATA_ONLY';bytes=$Info.Length;sha256=(-join ($Digest | ForEach-Object { $_.ToString('x2') }))}
      if ($KeepBytes) { $Fact.rawBytes=$Bytes }
      return $Fact
    } finally { $Hasher.Dispose();$Stream.Dispose() }
  } catch { return @{state='UNAVAILABLE'} }
}
function Public-Key([string]$Path) {
  $F = Observe-File $Path 4096 $true
  if ($F.state -ne 'PRESENT_METADATA_ONLY') { return @{state=$F.state;path=$Path} }
  try {
    $Text = $Utf8.GetString($F.rawBytes).Trim()
    if ($Text -cnotmatch '^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?:[ \t][^\r\n]*)?$') { throw 'INVALID_PUBLIC_KEY' }
    $Base64 = $Matches[1]
    [byte[]]$Blob = [Convert]::FromBase64String($Base64)
    if ($Blob.Length -ne 51 -or [Convert]::ToBase64String($Blob) -cne $Base64 -or
        $Blob[0] -ne 0 -or $Blob[1] -ne 0 -or $Blob[2] -ne 0 -or $Blob[3] -ne 11 -or
        $Utf8.GetString($Blob,4,11) -cne 'ssh-ed25519' -or
        $Blob[15] -ne 0 -or $Blob[16] -ne 0 -or $Blob[17] -ne 0 -or $Blob[18] -ne 32) { throw 'INVALID_PUBLIC_KEY' }
    $Hasher = [Security.Cryptography.SHA256]::Create()
    try { $Fingerprint='SHA256:'+([Convert]::ToBase64String($Hasher.ComputeHash($Blob))).TrimEnd('=') }
    finally { $Hasher.Dispose() }
    return @{state='PUBLIC_KEY_OBSERVED';path=$Path;keyType='ssh-ed25519';publicKey=('ssh-ed25519 '+$Base64);fingerprint=$Fingerprint}
  } catch { return @{state='UNRECOGNIZED_PUBLIC_KEY';path=$Path} }
}
function V3-Metadata($Value) {
  try {
    if ($Value -isnot [pscustomobject] -or $Value.scope -isnot [pscustomobject] -or $Value.peerPins -isnot [pscustomobject] -or $Value.initialHistory -isnot [pscustomobject]) { throw 'UNRECOGNIZED' }
    $S=$Value.scope;$P=$Value.peerPins;$H=$Value.initialHistory
    foreach ($Text in @($S.appId,$S.baseSha,$S.sessionId,$P.peerId,$P.releaseSha,$P.browserInstanceId,$P.browserProfileId,$H.eventSha256)) {
      if ($Text -isnot [string] -or $Text -cnotmatch '^[A-Za-z0-9._:-]{1,160}$') { throw 'UNRECOGNIZED' }
    }
    if ($S.baseSha -cnotmatch '^[a-f0-9]{40}$' -or $P.releaseSha -cnotmatch '^[a-f0-9]{40}$' -or $H.eventSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'UNRECOGNIZED' }
    foreach ($Number in @($S.generation,$P.protocolMinor,$P.maxMessageBytes,$H.sequence)) {
      if (($Number -isnot [int] -and $Number -isnot [long]) -or $Number -lt 0) { throw 'UNRECOGNIZED' }
    }
    $Caps=@($P.capabilities)
    if ($Caps.Count -gt 32) { throw 'UNRECOGNIZED' }
    foreach ($Cap in $Caps) { if ($Cap -isnot [string] -or $Cap -cnotmatch '^[A-Za-z0-9._:-]{1,128}$') { throw 'UNRECOGNIZED' } }
    return @{state='OBSERVED_NOT_AUTHENTICATED';scope=@{appId=$S.appId;baseSha=$S.baseSha;sessionId=$S.sessionId;generation=$S.generation};
      peerPins=@{peerId=$P.peerId;releaseSha=$P.releaseSha;browserInstanceId=$P.browserInstanceId;browserProfileId=$P.browserProfileId;protocolMinor=$P.protocolMinor;maxMessageBytes=$P.maxMessageBytes;capabilities=$Caps};
      initialHistory=@{sequence=$H.sequence;eventSha256=$H.eventSha256}}
  } catch { return @{state='UNRECOGNIZED_V3_METADATA'} }
}
$KeyPaths = New-Object 'Collections.Generic.List[string]'
$KeyPaths.Add((Join-Path $env:USERPROFILE '.ssh\rbridge_ed25519.pub'))
$Install = @{state='ABSENT';directory=$InstallDir}
try {
  $InstallDir=Local-Path $InstallDir
  $Install.directory=$InstallDir
  if (Test-Path -LiteralPath $InstallDir) {
    $Directory=Get-Item -LiteralPath $InstallDir -Force
    if (-not $Directory.PSIsContainer) { throw 'UNTRUSTED_DIRECTORY' }
    $Install.state='PRESENT_METADATA_ONLY'
    $Install.executable=Observe-File (Join-Path $InstallDir 'rbridge-native-host.exe') 134217728 $false
    $Install.manifest=Observe-File (Join-Path $InstallDir ($NativeName+'.json')) 16384 $false
    $Document=Observe-File (Join-Path $InstallDir 'rbridge-native-host.config.json') 65536 $true
    $Install.config=@{state=$Document.state}
    if ($Document.state -eq 'PRESENT_METADATA_ONLY') {
      try {
        try { $Config=$Utf8.GetString($Document.rawBytes) | ConvertFrom-Json -ErrorAction Stop } catch { throw 'MALFORMED_CONFIG' }
        if ($Config -isnot [pscustomobject] -or $Config.schema -cne 'RBRIDGE_NATIVE_HOST_CONFIG_V1') { throw 'UNRECOGNIZED_CONFIG' }
        $Install.config=@{state='PRESENT_METADATA_ONLY';sha256=$Document.sha256;bytes=$Document.bytes;v3Configured=(@($Config.PSObject.Properties.Name) -contains 'v3')}
        if ($Config.expectedExtensionId -is [string] -and $Config.expectedExtensionId -cmatch '^[a-p]{32}$') { $Install.config.extensionId=$Config.expectedExtensionId }
        if ($Install.config.v3Configured) { $Install.config.v3=V3-Metadata $Config.v3 }
        if ($Config.ssh -is [pscustomobject]) {
          if ($Config.ssh.identityFile -is [string]) {
            try {
              $PublicPath=Local-Path ($Config.ssh.identityFile+'.pub')
              if (@($KeyPaths | Where-Object { [string]::Equals($_,$PublicPath,[StringComparison]::OrdinalIgnoreCase) }).Count -eq 0) { $KeyPaths.Add($PublicPath) }
              $Install.config.keyPathState='LOCAL_PUBLIC_PATH'
            } catch { $Install.config.keyPathState='NONLOCAL_PATH_REJECTED' }
          }
          if ($Config.ssh.host -is [string] -and $Config.ssh.host -cmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' -and $Config.ssh.user -ceq 'rbridge' -and $Config.ssh.port -is [int] -and $Config.ssh.port -ge 1 -and $Config.ssh.port -le 65535) { $Install.config.ssh=@{host=$Config.ssh.host;port=$Config.ssh.port;user='rbridge'} }
        }
      } catch {
        $Reason=if ($_.Exception.Message -in @('MALFORMED_CONFIG','UNRECOGNIZED_CONFIG')) { $_.Exception.Message } else { 'UNAVAILABLE' }
        $Install.config=@{state=$Reason}
      }
    }
  }
} catch { $Install.state=if ($_.Exception.Message -in @('UNTRUSTED_DIRECTORY','NONLOCAL_PATH_REJECTED')) {'UNTRUSTED_DIRECTORY'} else {'UNAVAILABLE'} }
$Registrations=@()
foreach ($Browser in @('Google\Chrome','Microsoft\Edge')) {
  $State='ABSENT'
  try {
    $Key='HKCU:\Software\'+$Browser+'\NativeMessagingHosts\'+$NativeName
    if (Test-Path -LiteralPath $Key) {
      $Binding=(Get-Item -LiteralPath $Key).GetValue('')
      $Expected=Join-Path $InstallDir ($NativeName+'.json')
      $State=if ($Binding -is [string] -and [string]::Equals($Binding,$Expected,[StringComparison]::OrdinalIgnoreCase)) {'POINTS_TO_EXPECTED_MANIFEST'} else {'DIFFERENT_BINDING'}
    }
  } catch { $State='UNAVAILABLE' }
  $Registrations+=@{browser=$Browser;state=$State}
}
$Keys=@()
foreach ($PublicPath in $KeyPaths) { $Keys+=(Public-Key $PublicPath) }
[pscustomobject]@{schema='COCWIN_RBRIDGE_WINDOWS_OWNER_FACTS_V1';status='COLLECTED_READONLY';
  owner=@{userName=$env:USERNAME;computerName=$env:COMPUTERNAME};installation=$Install;nativeRegistrations=$Registrations;
  publicKeys=$Keys;peerReadiness='NOT_EVALUATED';filesystemChanges=0;sshConnections=0;browserSends=0} | ConvertTo-Json -Depth 12 -Compress
