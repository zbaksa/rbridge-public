[CmdletBinding()]
param([string]$InstallDir = '')
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'WINDOWS_OWNER_FACTS_REQUIRE_WINDOWS' }
$Utf8 = New-Object Text.UTF8Encoding($false)
if ([string]::IsNullOrWhiteSpace($InstallDir)) { $InstallDir = Join-Path $env:LOCALAPPDATA 'COCWIN\RBridge\NativeHost' }
$NativeName = 'com.cocwin.rbridge_chat_v1'
# Emit P/Invoke signatures in memory: no compiler process or temporary DLL/source files.
$AssemblyName = New-Object Reflection.AssemblyName('CocwinReadOnlyFiles'+[Guid]::NewGuid().ToString('N'))
$Assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($AssemblyName,[Reflection.Emit.AssemblyBuilderAccess]::Run)
$Module = $Assembly.DefineDynamicModule($AssemblyName.Name)
$Builder = $Module.DefineType($AssemblyName.Name,[Reflection.TypeAttributes]'Public,Abstract,Sealed')
function Native-Method([string]$Name,[Type]$Return,[Type[]]$Parameters) {
  $Method = $Builder.DefineMethod($Name,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',$Return,$Parameters)
  $Attribute = [Runtime.InteropServices.DllImportAttribute]
  $Fields = [Reflection.FieldInfo[]]@($Attribute.GetField('EntryPoint'),$Attribute.GetField('SetLastError'),$Attribute.GetField('CharSet'),$Attribute.GetField('ExactSpelling'))
  $Values = [object[]]@($Name,$true,[Runtime.InteropServices.CharSet]::Unicode,$true)
  $Import = New-Object Reflection.Emit.CustomAttributeBuilder($Attribute.GetConstructor([Type[]]@([string])),[object[]]@('kernel32.dll'),$Fields,$Values)
  $Method.SetCustomAttribute($Import)
  $Method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
}
Native-Method 'CreateFileW' ([Microsoft.Win32.SafeHandles.SafeFileHandle]) ([Type[]]@([string],[uint32],[uint32],[IntPtr],[uint32],[uint32],[IntPtr]))
Native-Method 'GetFileInformationByHandle' ([bool]) ([Type[]]@([Microsoft.Win32.SafeHandles.SafeFileHandle],[IntPtr]))
Native-Method 'GetFinalPathNameByHandleW' ([uint32]) ([Type[]]@([Microsoft.Win32.SafeHandles.SafeFileHandle],[Text.StringBuilder],[uint32],[uint32]))
Native-Method 'GetVolumeNameForVolumeMountPointW' ([bool]) ([Type[]]@([string],[Text.StringBuilder],[uint32]))
Native-Method 'FindFirstFileW' ([IntPtr]) ([Type[]]@([string],[IntPtr]))
Native-Method 'FindNextFileW' ([bool]) ([Type[]]@([IntPtr],[IntPtr]))
Native-Method 'FindClose' ([bool]) ([Type[]]@([IntPtr]))
$Native = $Builder.CreateType()
function Local-Path([string]$Path) {
  if ($Path.Length -gt 1024 -or $Path -notmatch '^[A-Za-z]:[\\/]' -or $Path -match '[\r\n\x00]') { throw 'NONLOCAL_PATH_REJECTED' }
  $Full = [IO.Path]::GetFullPath($Path)
  if ($Full.Substring(3).Contains(':')) { throw 'NONLOCAL_PATH_REJECTED' }
  foreach ($Part in $Full.Substring(3).Split('\')) {
    if ($Part.EndsWith('.') -or $Part.EndsWith(' ')) { throw 'NONLOCAL_PATH_REJECTED' }
  }
  return $Full
}
function Open-LocalRead([string]$Full,[bool]$DirectoryOnly) {
  $Held = New-Object 'Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]'
  try {
    $Volume = New-Object Text.StringBuilder(64)
    if (-not $Native::GetVolumeNameForVolumeMountPointW($Full.Substring(0,3),$Volume,64) -or
        $Volume.ToString() -notmatch '^\\\\\?\\Volume\{[A-Fa-f0-9-]{36}\}\\$') { throw 'NONLOCAL_PATH_REJECTED' }
    # Open exclusively through the local volume GUID. A DOS drive remapping cannot redirect later opens.
    $Parts = @($Full.Substring(3).Split('\') | Where-Object { $_ -ne '' })
    $Current = $Volume.ToString()
    for ($Index=-1; $Index -lt $Parts.Count; $Index++) {
      if ($Index -ge 0) { $Current=$Current.TrimEnd('\')+'\'+$Parts[$Index] }
      $IsDirectory = $DirectoryOnly -or $Index -lt $Parts.Count-1
      # Attribute-only directory handles do not participate in sharing checks.
      # Enumeration pins add FILE_LIST_DIRECTORY, keeping namespace rename/delete denied.
      $Access = if ($IsDirectory) { if ($DirectoryOnly) {[uint32]129} else {[uint32]128} } else { [uint32]2147483648 }
      # Share READ only; keep every validated ancestor held until the observation completes.
      $Handle = $Native::CreateFileW($Current,$Access,[uint32]1,[IntPtr]::Zero,[uint32]3,[uint32]35651584,[IntPtr]::Zero)
      $ErrorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      if ($Handle.IsInvalid) { $Handle.Dispose(); if ($ErrorCode -in @(2,3)) { throw 'ABSENT' }; throw 'UNAVAILABLE' }
      $Held.Add($Handle)
      $Info = [Runtime.InteropServices.Marshal]::AllocHGlobal(52)
      try {
        if (-not $Native::GetFileInformationByHandle($Handle,$Info)) { throw 'UNAVAILABLE' }
        $Attributes = [Runtime.InteropServices.Marshal]::ReadInt32($Info,0)
        $Links = [Runtime.InteropServices.Marshal]::ReadInt32($Info,40)
        if (($Attributes -band 1024) -ne 0 -or (($Attributes -band 16) -ne 0) -ne $IsDirectory -or (-not $IsDirectory -and $Links -ne 1)) { throw 'UNTRUSTED_DIRECTORY' }
      } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($Info) }
      $Final = New-Object Text.StringBuilder(1100)
      $Length = $Native::GetFinalPathNameByHandleW($Handle,$Final,1100,1)
      if ($Length -eq 0 -or $Length -ge 1100 -or -not [string]::Equals($Final.ToString().TrimEnd('\'),$Current.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)) { throw 'UNTRUSTED_DIRECTORY' }
    }
    return @{handles=$Held;leaf=$Held[$Held.Count-1];path=$Current}
  } catch {
    foreach ($Handle in $Held) { $Handle.Dispose() }
    throw
  }
}
function Observe-Directory([string]$Path) {
  $Read=$null
  try { $Read=Open-LocalRead (Local-Path $Path) $true; return 'PRESENT_METADATA_ONLY' }
  catch { if ($_.Exception.Message -in @('ABSENT','UNTRUSTED_DIRECTORY','NONLOCAL_PATH_REJECTED')) { return $_.Exception.Message }; return 'UNAVAILABLE' }
  finally { if ($null -ne $Read) { foreach ($Handle in $Read.handles) { $Handle.Dispose() } } }
}
function Observe-DirectorySnapshot([string]$Path,[int]$Limit,[bool]$KeepNames=$false) {
  $Read=$null;$Find=[IntPtr]::Zero;$Data=[IntPtr]::Zero
  try {
    $Read=Open-LocalRead (Local-Path $Path) $true
    # WIN32_FIND_DATAW is metadata only. Never open a child file or parse its contents.
    # Enumerate through the validated volume GUID while every ancestor remains held.
    $Data=[Runtime.InteropServices.Marshal]::AllocHGlobal(592)
    $Find=$Native::FindFirstFileW($Read.path.TrimEnd('\')+'\*',$Data)
    $Code=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $Count=0;$Partial=$false;$Names=New-Object 'Collections.Generic.List[string]'
    if ($Find.ToInt64() -eq -1) {
      if ($Code -ne 2) {throw 'UNAVAILABLE'}
    } else {
      while ($true) {
        $Name=[Runtime.InteropServices.Marshal]::PtrToStringUni([IntPtr]::Add($Data,44))
        if ($Name -cne '.' -and $Name -cne '..') {
          $Count++
          if ($Count -gt $Limit) {$Partial=$true;break}
          if ($KeepNames) {[void]$Names.Add($Name)}
        }
        $More=$Native::FindNextFileW($Find,$Data)
        $Code=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if (-not $More) {if ($Code -ne 18) {throw 'UNAVAILABLE'};break}
      }
    }
    $State=if ($Partial) {'BOUNDED_PARTIAL'} elseif ($Count -eq 0) {'EMPTY_SNAPSHOT'} else {'RETAINED_METADATA_ONLY'}
    $Fact=@{state=$State;authority='NOT_AUTHENTICATED'}
    if ($Partial) {$Fact.entryCountAtLeast=$Count} else {$Fact.entryCount=$Count}
    if ($KeepNames) {$Fact.names=@($Names.ToArray())}
    return $Fact
  } catch {
    $State=if ($_.Exception.Message -in @('ABSENT','UNTRUSTED_DIRECTORY','NONLOCAL_PATH_REJECTED')) {$_.Exception.Message} else {'UNAVAILABLE'}
    return @{state=$State;authority='NOT_AUTHENTICATED'}
  } finally {
    if ($Find -ne [IntPtr]::Zero -and $Find.ToInt64() -ne -1) {[void]$Native::FindClose($Find)}
    if ($Data -ne [IntPtr]::Zero) {[Runtime.InteropServices.Marshal]::FreeHGlobal($Data)}
    if ($null -ne $Read) {foreach ($Handle in $Read.handles) {$Handle.Dispose()}}
  }
}
function Observe-ChromeProfiles {
  $Report=@{state='NOT_EVALUATED';extensionId='ebibbijpegoankenmggdnehpoadcophk';profileCoverage='DEFAULT_AND_NUMBERED_PROFILES_ONLY';runtimeBinding='NOT_OBSERVED';profiles=@()}
  try {
    $Root=Local-Path (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data')
    $Snapshot=Observe-DirectorySnapshot $Root 256 $true
    $Report.state=$Snapshot.state
    if ($Snapshot.state -notin @('EMPTY_SNAPSHOT','RETAINED_METADATA_ONLY','BOUNDED_PARTIAL')) {return $Report}
    $Candidates=@($Snapshot.names | Where-Object {$_ -ceq 'Default' -or $_ -cmatch '^Profile [0-9]{1,9}$'} | Sort-Object)
    $Report.state=if ($Snapshot.state -ceq 'BOUNDED_PARTIAL' -or $Candidates.Count -gt 32) {'BOUNDED_PARTIAL'} else {'PRESENT_METADATA_ONLY'}
    foreach ($Name in @($Candidates | Select-Object -First 32)) {
      $ProfileRoot=Join-Path $Root $Name
      $Profile=@{directory=$Name;state=(Observe-Directory $ProfileRoot);extensionPayload=@{state='NOT_EVALUATED'};extensionStorage=@{state='NOT_EVALUATED'}}
      if ($Profile.state -ceq 'PRESENT_METADATA_ONLY') {
        $Profile.extensionPayload=Observe-DirectorySnapshot (Join-Path $ProfileRoot ('Extensions\'+$Report.extensionId)) 256
        $Profile.extensionStorage=Observe-DirectorySnapshot (Join-Path $ProfileRoot ('Local Extension Settings\'+$Report.extensionId)) 256
      }
      $Report.profiles+=@($Profile)
    }
  } catch {$Report.state='UNAVAILABLE'}
  return $Report
}
function Observe-File([string]$Path,[long]$Limit,[bool]$KeepBytes) {
  $Read=$null;$Stream=$null;$Hasher=$null
  try {
    $Full = Local-Path $Path
    $Read = Open-LocalRead $Full $false
    $Stream = New-Object IO.FileStream($Read.leaf,[IO.FileAccess]::Read)
    $Size=$Stream.Length
    if ($Size -lt 1 -or $Size -gt $Limit) { return @{state='UNTRUSTED_FILE'} }
    $Hasher = [Security.Cryptography.SHA256]::Create()
    if ($KeepBytes) {
      $Bytes = New-Object byte[] ([int]$Size)
      $Offset=0
      while ($Offset -lt $Bytes.Length) {
        $Count=$Stream.Read($Bytes,$Offset,$Bytes.Length-$Offset)
        if ($Count -lt 1) { throw 'FILE_CHANGED' }
        $Offset+=$Count
      }
      if ($Stream.ReadByte() -ne -1) { throw 'FILE_CHANGED' }
      $Digest=$Hasher.ComputeHash($Bytes)
    } else { $Digest=$Hasher.ComputeHash($Stream) }
    $Fact=@{state='PRESENT_METADATA_ONLY';bytes=$Size;sha256=(-join ($Digest | ForEach-Object { $_.ToString('x2') }))}
    if ($KeepBytes) { $Fact.rawBytes=$Bytes }
    return $Fact
  } catch { if ($_.Exception.Message -eq 'ABSENT') { return @{state='ABSENT'} }; return @{state='UNAVAILABLE'} }
  finally {
    if ($null -ne $Hasher) { $Hasher.Dispose() }
    if ($null -ne $Stream) { $Stream.Dispose() }
    if ($null -ne $Read) { foreach ($Handle in $Read.handles) { $Handle.Dispose() } }
  }
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
$Install = @{state='ABSENT';directory=$InstallDir;nativeHistory=@{state='NOT_EVALUATED';authority='NOT_AUTHENTICATED'}}
try {
  $InstallDir=Local-Path $InstallDir
  $Install.directory=$InstallDir
  $Install.state=Observe-Directory $InstallDir
  if ($Install.state -eq 'NONLOCAL_PATH_REJECTED') { $Install.state='UNTRUSTED_DIRECTORY' }
  if ($Install.state -eq 'PRESENT_METADATA_ONLY') {
    $Install.executable=Observe-File (Join-Path $InstallDir 'rbridge-native-host.exe') 134217728 $false
    $Install.manifest=Observe-File (Join-Path $InstallDir ($NativeName+'.json')) 16384 $false
    $Document=Observe-File (Join-Path $InstallDir 'rbridge-native-host.config.json') 65536 $true
    $Install.config=@{state=$Document.state}
    if ($Document.state -eq 'PRESENT_METADATA_ONLY') {
      try {
        try { $Config=$Utf8.GetString($Document.rawBytes) | ConvertFrom-Json -ErrorAction Stop } catch { throw 'MALFORMED_CONFIG' }
        if ($Config -isnot [pscustomobject] -or $Config.schema -cne 'RBRIDGE_NATIVE_HOST_CONFIG_V1') { throw 'UNRECOGNIZED_CONFIG' }
        if ($Config.eventStoreRoot -is [string]) {$Install.nativeHistory=Observe-DirectorySnapshot $Config.eventStoreRoot 256}
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
  publicKeys=$Keys;chromeProfiles=(Observe-ChromeProfiles);peerReadiness='NOT_EVALUATED';filesystemChanges=0;sshConnections=0;browserSends=0} | ConvertTo-Json -Depth 12 -Compress
