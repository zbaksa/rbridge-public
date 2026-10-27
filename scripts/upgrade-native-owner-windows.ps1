[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$ExpectedConfigSha256,
  [string]$InstallDir='',
  [string]$PackageZip=''
)
$ErrorActionPreference='Stop'
$Utf8=New-Object Text.UTF8Encoding($false)
$OldSha='630ea7b69c12283ac311cbf137adfaf8078f091071697bab355282d080997b95'
$NewSha='c4d9317d84dbd7ac2f0d73df3c939fe2452eb6a78e56a142d17c83876228e5ee'
$PackageSha='0e614e0f143bb49db4e2e2807a9ebde4e6796e5adcf7425ff08762bd240b4af0'
$PackageUrl='https://github.com/zbaksa/rbridge-public/releases/download/cocwin-windows-11c6723/rbridge-windows-11c6723.zip'
$SourceSha='11c67238e4d1998e0fab166da048c655b478a1d6'
$NativeName='com.cocwin.rbridge_chat_v1';$ExtensionId='ebibbijpegoankenmggdnehpoadcophk'
$Files=@(
  @{name='dist-native-host/rbridge-native-host.exe';bytes=87200256;sha=$NewSha},
  @{name='dist-native-host/rbridge-native-host.metadata.json';bytes=241;sha='edf48d1c8ea88cb36ec7d666f3babe528af0c7f56e3a21413656c0179f245ed4'},
  @{name='dist-native-host/install-native-host-windows.ps1';bytes=12007;sha='e15737025b0a7fdbf6cc41fce9f190853d418d4389d5cbeb2c3c9212b62e995b'},
  @{name='dist-extension/manifest.json';bytes=917;sha='d665f154a32f7069fd7f3c4a7966e97cdb4f192c6afc49b76cdda854c38a4aa7'},
  @{name='dist-extension/contentScript.js';bytes=22461;sha='18e6fa923fabf879b07785266b56a4ad9599f97ea2ca8c4137d9788f21f7b8a3'},
  @{name='dist-extension/serviceWorker.js';bytes=108693;sha='482a02ce631b40dc10e42629ec8842a832b52be0bc0980b78447e7fd1f55ecc1'}
)
$Phase='PREFLIGHT';$PublicationStarted=$false;$Stage=$null;$StageEntry=$null;$KeepStage=$false;$Mutex=$null;$Held=$false;$Result=$null;$ExitCode=2;$Before=$null;$OldEntry=$null;$Candidate=$null
$Directories=@{};$Leaves=@{};$AllEntries=New-Object Collections.ArrayList
function Need([bool]$Ok,[string]$Why) {if (-not $Ok) {throw $Why}}
function Initialize-Native {
  $Name=New-Object Reflection.AssemblyName('CocwinUpgradeFiles'+[guid]::NewGuid().ToString('N'))
  $Assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly($Name,[Reflection.Emit.AssemblyBuilderAccess]::Run)
  $Module=$Assembly.DefineDynamicModule($Name.Name);$Builder=$Module.DefineType($Name.Name,[Reflection.TypeAttributes]'Public,Abstract,Sealed')
  function Method([string]$Name,[Type]$Return,[Type[]]$Parameters) {
    $M=$Builder.DefineMethod($Name,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',$Return,$Parameters)
    $A=[Runtime.InteropServices.DllImportAttribute]
    $Fields=[Reflection.FieldInfo[]]@($A.GetField('EntryPoint'),$A.GetField('SetLastError'),$A.GetField('CharSet'),$A.GetField('ExactSpelling'))
    $Values=[object[]]@($Name,$true,[Runtime.InteropServices.CharSet]::Unicode,$true)
    $Import=New-Object Reflection.Emit.CustomAttributeBuilder($A.GetConstructor([Type[]]@([string])),[object[]]@('kernel32.dll'),$Fields,$Values)
    $M.SetCustomAttribute($Import);$M.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  }
  Method 'CreateFileW' ([Microsoft.Win32.SafeHandles.SafeFileHandle]) ([Type[]]@([string],[uint32],[uint32],[IntPtr],[uint32],[uint32],[IntPtr]))
  Method 'GetFileInformationByHandle' ([bool]) ([Type[]]@([Microsoft.Win32.SafeHandles.SafeFileHandle],[IntPtr]))
  Method 'GetFinalPathNameByHandleW' ([uint32]) ([Type[]]@([Microsoft.Win32.SafeHandles.SafeFileHandle],[Text.StringBuilder],[uint32],[uint32]))
  Method 'GetVolumeNameForVolumeMountPointW' ([bool]) ([Type[]]@([string],[Text.StringBuilder],[uint32]))
  Method 'SetFileInformationByHandle' ([bool]) ([Type[]]@([Microsoft.Win32.SafeHandles.SafeFileHandle],[int],[IntPtr],[uint32]))
  return $Builder.CreateType()
}
function Local-Path([string]$Path) {
  Need ($Path.Length -le 1024 -and $Path -cmatch '^[A-Za-z]:\\' -and $Path -notmatch '[\x00-\x1f"<>|?*]') 'UNTRUSTED_LOCAL_PATH'
  $Full=[IO.Path]::GetFullPath($Path)
  Need ([string]::Equals($Path,$Full,[StringComparison]::OrdinalIgnoreCase) -and -not $Full.Substring(3).Contains(':')) 'UNTRUSTED_LOCAL_PATH'
  foreach ($Part in $Full.Substring(3).Split('\')) {
    if ($Part -eq '') {continue}
    Need (-not $Part.EndsWith('.') -and -not $Part.EndsWith(' ') -and $Part -notmatch '^(CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3]|CONIN\$|CONOUT\$)(\.|$)') 'UNTRUSTED_LOCAL_PATH'
  }
  return $Full
}
function Volume-Path([string]$Full) {
  $Volume=New-Object Text.StringBuilder(64)
  Need ($Native::GetVolumeNameForVolumeMountPointW($Full.Substring(0,3),$Volume,64) -and $Volume.ToString() -match '^\\\\\?\\Volume\{[a-fA-F0-9-]{36}\}\\$') 'UNTRUSTED_LOCAL_VOLUME'
  return $Volume.ToString()+$Full.Substring(3)
}
function Handle-Info($Handle) {
  $P=[Runtime.InteropServices.Marshal]::AllocHGlobal(52)
  try {
    Need ($Native::GetFileInformationByHandle($Handle,$P)) 'FILE_IDENTITY_UNAVAILABLE'
    return @{attributes=[Runtime.InteropServices.Marshal]::ReadInt32($P,0);links=[Runtime.InteropServices.Marshal]::ReadInt32($P,40);id=([Runtime.InteropServices.Marshal]::ReadInt32($P,28).ToString('x8')+':'+[Runtime.InteropServices.Marshal]::ReadInt32($P,44).ToString('x8')+':'+[Runtime.InteropServices.Marshal]::ReadInt32($P,48).ToString('x8'))}
  } finally {[Runtime.InteropServices.Marshal]::FreeHGlobal($P)}
}
function Final-Path($Handle) {
  $Text=New-Object Text.StringBuilder(1100);$Length=$Native::GetFinalPathNameByHandleW($Handle,$Text,1100,1)
  Need ($Length -gt 0 -and $Length -lt 1100) 'FILE_FINAL_PATH_UNAVAILABLE';return $Text.ToString()
}
function Verify-Entry($Entry) {
  Need (-not $Entry.closed -and -not $Entry.handle.IsInvalid -and -not $Entry.handle.IsClosed) 'HELD_OBJECT_CLOSED'
  $Info=Handle-Info $Entry.handle
  Need ($Info.id -ceq $Entry.id -and -not ($Info.attributes -band 1024) -and (($Info.attributes -band 16) -ne 0) -eq $Entry.directory -and ($Entry.directory -or $Info.links -eq 1)) 'HELD_OBJECT_CHANGED'
  Need ([string]::Equals((Final-Path $Entry.handle).TrimEnd('\'),$Entry.guid.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)) 'HELD_OBJECT_RENAMED'
}
function Pin-Directory([string]$Full,[bool]$Delete=$false) {
  $Full=Local-Path $Full;$Key=$Full.ToUpperInvariant()
  if ($Directories.ContainsKey($Key)) {Need (-not $Delete -or $Directories[$Key].deleteAccess) 'DIRECTORY_ACCESS_MISMATCH';Verify-Entry $Directories[$Key];return $Directories[$Key]}
  $Guid=Volume-Path $Full;$Access=if ($Delete) {[uint32]65664} else {[uint32]128}
  $Handle=$Native::CreateFileW($Guid,$Access,[uint32]3,[IntPtr]::Zero,[uint32]3,[uint32]35651584,[IntPtr]::Zero)
  Need (-not $Handle.IsInvalid) 'DIRECTORY_PIN_FAILED'
  $Info=Handle-Info $Handle;$Entry=[pscustomobject]@{full=$Full;guid=$Guid;handle=$Handle;stream=$null;id=$Info.id;directory=$true;deleteAccess=$Delete;closed=$false}
  [void]$AllEntries.Add($Entry);Verify-Entry $Entry;$Directories[$Key]=$Entry;return $Entry
}
function Pin-Parents([string]$Full) {
  $Current=$Full.Substring(0,3);[void](Pin-Directory $Current)
  $Parts=@($Full.Substring(3).Split('\'))
  for ($Index=0;$Index -lt $Parts.Count-1;$Index++) {$Current=Join-Path $Current $Parts[$Index];[void](Pin-Directory $Current)}
}
function Close-Entry($Entry) {
  if ($null -ne $Entry -and -not $Entry.closed) {if ($null -ne $Entry.stream) {$Entry.stream.Dispose()};$Entry.handle.Dispose();$Entry.closed=$true}
}
function Open-Leaf([string]$Path,[long]$Maximum,[bool]$Delete=$false) {
  $Full=Local-Path $Path;$Key=$Full.ToUpperInvariant();Pin-Parents $Full
  if ($Leaves.ContainsKey($Key) -and -not $Leaves[$Key].closed) {Need (-not $Delete -or $Leaves[$Key].deleteAccess) 'FILE_ACCESS_MISMATCH';Verify-Entry $Leaves[$Key];return $Leaves[$Key]}
  $Guid=Volume-Path $Full;$Access=if ($Delete) {[uint32]2147549184} else {[uint32]2147483648}
  $Handle=$Native::CreateFileW($Guid,$Access,[uint32]1,[IntPtr]::Zero,[uint32]3,[uint32]35651584,[IntPtr]::Zero)
  Need (-not $Handle.IsInvalid) 'MANAGED_FILE_OPEN_FAILED'
  $Info=Handle-Info $Handle;$Entry=[pscustomobject]@{full=$Full;guid=$Guid;handle=$Handle;stream=$null;id=$Info.id;directory=$false;deleteAccess=$Delete;closed=$false}
  [void]$AllEntries.Add($Entry);Verify-Entry $Entry
  $Entry.stream=New-Object IO.FileStream($Handle,[IO.FileAccess]::Read)
  Need ($Entry.stream.Length -ge 1 -and $Entry.stream.Length -le $Maximum) 'MANAGED_FILE_SIZE_INVALID'
  $Leaves[$Key]=$Entry;return $Entry
}
function Hash-Stream([IO.Stream]$Stream) {
  $Hasher=[Security.Cryptography.SHA256]::Create()
  try {return -join ($Hasher.ComputeHash($Stream) | ForEach-Object {$_.ToString('x2')})} finally {$Hasher.Dispose()}
}
function Entry-Hash($Entry) {Verify-Entry $Entry;$Entry.stream.Position=0;$Digest=Hash-Stream $Entry.stream;$Entry.stream.Position=0;Verify-Entry $Entry;return $Digest}
function File-Hash([string]$Path,[long]$Maximum) {return Entry-Hash (Open-Leaf $Path $Maximum)}
function Entry-Text($Entry) {
  Verify-Entry $Entry;$Entry.stream.Position=0;$Reader=New-Object IO.StreamReader($Entry.stream,$Utf8,$true,1024,$true)
  try {return $Reader.ReadToEnd()} finally {$Reader.Dispose();$Entry.stream.Position=0}
}
function Acl-State([string]$Sddl) {
  # AUTO_INHERITED is bookkeeping; retain owner/group, protection and every ACE,
  # including its inherited flag. Do not equate duplicate explicit ACEs.
  $Raw=New-Object Security.AccessControl.RawSecurityDescriptor($Sddl)
  $Raw.SetFlags([Security.AccessControl.ControlFlags]([int]$Raw.ControlFlags -band (-bnot [int][Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited)))
  return $Raw.GetSddlForm([Security.AccessControl.AccessControlSections]::All)
}
function Binding([string]$Key) {
  $Reg=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Key)
  try {if ($null -eq $Reg) {return $null};return $Reg.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)} finally {if ($null -ne $Reg) {$Reg.Dispose()}}
}
function Protected-Snapshot {
  $Rows=@()
  foreach ($Path in @($ConfigPath,$ManifestPath,$ReceiptPath,$Identity,($Identity+'.pub'),$KnownHosts)) {$Rows+=[ordered]@{path=$Path;sha=(File-Hash $Path 65536);acl=(Get-Acl -LiteralPath $Path).Sddl}}
  foreach ($Key in $RegistryPaths) {Need ([string]::Equals((Binding $Key),$ManifestPath,[StringComparison]::OrdinalIgnoreCase)) 'NATIVE_REGISTRATION_CHANGED';$Rows+=[ordered]@{registry=$Key;binding=(Binding $Key)}}
  return ($Rows | ConvertTo-Json -Depth 5 -Compress)
}
function Rename-Entry($Entry,[string]$Destination) {
  Verify-Entry $Entry;Need $Entry.deleteAccess 'RENAME_ACCESS_REQUIRED';$Destination=Local-Path $Destination;Pin-Parents $Destination
  $Guid=Volume-Path $Destination;$Bytes=[Text.Encoding]::Unicode.GetBytes($Guid)
  $RootOffset=if ([IntPtr]::Size -eq 8) {8} else {4};$NameOffset=$RootOffset+[IntPtr]::Size+4;$Size=$NameOffset+$Bytes.Length+2
  $P=[Runtime.InteropServices.Marshal]::AllocHGlobal($Size)
  try {
    for ($Index=0;$Index -lt $Size;$Index++) {[Runtime.InteropServices.Marshal]::WriteByte($P,$Index,0)}
    [Runtime.InteropServices.Marshal]::WriteIntPtr($P,$RootOffset,[IntPtr]::Zero)
    [Runtime.InteropServices.Marshal]::WriteInt32($P,$RootOffset+[IntPtr]::Size,$Bytes.Length)
    [Runtime.InteropServices.Marshal]::Copy($Bytes,0,[IntPtr]::Add($P,$NameOffset),$Bytes.Length)
    # ReplaceIfExists remains FALSE: never overwrite a newly appeared target.
    Need ($Native::SetFileInformationByHandle($Entry.handle,3,$P,[uint32]$Size)) 'HELD_OBJECT_RENAME_FAILED'
    [void]$Leaves.Remove($Entry.full.ToUpperInvariant());$Entry.full=$Destination;$Entry.guid=$Guid;$Leaves[$Destination.ToUpperInvariant()]=$Entry;Verify-Entry $Entry
  } finally {[Runtime.InteropServices.Marshal]::FreeHGlobal($P)}
}
function Delete-Entry($Entry) {
  Verify-Entry $Entry;Need $Entry.deleteAccess 'DELETE_ACCESS_REQUIRED';$P=[Runtime.InteropServices.Marshal]::AllocHGlobal(1)
  try {[Runtime.InteropServices.Marshal]::WriteByte($P,0,1);Need ($Native::SetFileInformationByHandle($Entry.handle,4,$P,[uint32]1)) 'OWNED_OBJECT_DELETE_FAILED'} finally {[Runtime.InteropServices.Marshal]::FreeHGlobal($P)}
  Close-Entry $Entry
}
function Check-Candidate($Entry) {
  Need ((Entry-Hash $Entry) -ceq $NewSha) 'CANDIDATE_EXECUTABLE_CHANGED'
  Need ((Acl-State (Get-Acl -LiteralPath $Entry.full).Sddl) -ceq $ExeAcl) 'CANDIDATE_ACL_CHANGED'
  $Start=New-Object Diagnostics.ProcessStartInfo
  $Start.FileName=$Entry.full;$Start.Arguments='--check-config "'+$ConfigPath+'"';$Start.UseShellExecute=$false;$Start.CreateNoWindow=$true
  $Start.RedirectStandardInput=$true;$Start.RedirectStandardOutput=$true;$Start.RedirectStandardError=$true;$Start.StandardOutputEncoding=$Utf8;$Start.StandardErrorEncoding=$Utf8
  foreach ($Name in @('NODE_OPTIONS','NODE_PATH','SSH_ASKPASS')) {$Start.EnvironmentVariables.Remove($Name)};$Start.EnvironmentVariables['SSH_ASKPASS_REQUIRE']='never'
  $Process=New-Object Diagnostics.Process;$Process.StartInfo=$Start;$Started=$false
  try {
    Verify-Entry $Entry;[void]$Process.Start();$Started=$true;$Process.StandardInput.Close();$Out=$Process.StandardOutput.ReadToEndAsync();$Err=$Process.StandardError.ReadToEndAsync()
    Need ($Process.WaitForExit(15000)) 'CANDIDATE_CONFIG_CHECK_TIMEOUT'
    Need ($Out.Wait(1000) -and $Err.Wait(1000) -and $Process.ExitCode -eq 0 -and $Out.Result.Length -le 16384 -and $Err.Result.Length -le 16384) 'CANDIDATE_CONFIG_CHECK_FAILED'
    $Checked=$Out.Result | ConvertFrom-Json
    Need ($Checked.schema -ceq 'RBRIDGE_NATIVE_CONFIG_CHECK_V1' -and $Checked.status -ceq 'PASS' -and $Checked.sourceSha256 -ceq $ExpectedConfigSha256 -and $Checked.expectedExtensionId -ceq $ExtensionId -and $Checked.v3Configured -is [bool] -and -not $Checked.v3Configured -and $Checked.activated -is [bool] -and -not $Checked.activated) 'CANDIDATE_CONFIG_CHECK_INVALID'
    Verify-Entry $Entry
  } finally {if ($Started -and -not $Process.HasExited) {$Process.Kill()};$Process.Dispose()}
}
function Success([string]$State) {
  return [pscustomobject]@{schema='COCWIN_RBRIDGE_WINDOWS_OWNER_UPGRADE_V1';status='PASS';state=$State;packageSourceSha=$SourceSha;packageSha256=$PackageSha;executableSha256=$NewSha;configSha256=$ExpectedConfigSha256;directory=$InstallDir;executablePublicationStarted=$PublicationStarted;protectedFilesPreserved=$true;keyConfigHistoryWrites=0;registrationWrites=0;v3Configured=$false;sshAuthentication='NOT_RUN_BY_UPGRADE';browserAcceptance='NOT_RUN';browserSends=0}
}
try {
  Need ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT -and $PSVersionTable.PSVersion.Major -eq 5) 'WINDOWS_POWERSHELL_51_REQUIRED'
  Need ($ExpectedConfigSha256 -cmatch '^[a-f0-9]{64}$') 'CONFIG_PIN_INVALID';$Native=Initialize-Native
  if ([string]::IsNullOrWhiteSpace($InstallDir)) {$InstallDir=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'COCWIN\RBridge\NativeHost'}
  $InstallDir=Local-Path $InstallDir;Pin-Parents (Join-Path $InstallDir 'placeholder');[void](Pin-Directory $InstallDir)
  $Bytes=$Utf8.GetBytes($InstallDir.ToUpperInvariant());$HashInput=New-Object IO.MemoryStream(,$Bytes)
  try {$MutexName='Global\COCWIN_RBridge_Install_'+(Hash-Stream $HashInput)} finally {$HashInput.Dispose()}
  $Mutex=New-Object Threading.Mutex($false,$MutexName);try {$Held=$Mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$Held=$true};Need $Held 'NATIVE_INSTALL_IN_PROGRESS'
  $ExePath=Join-Path $InstallDir 'rbridge-native-host.exe';$ConfigPath=Join-Path $InstallDir 'rbridge-native-host.config.json';$ManifestPath=Join-Path $InstallDir ($NativeName+'.json');$ReceiptPath=Join-Path $InstallDir '.owner-setup-v1.json'
  $Identity=Join-Path $InstallDir 'keys\owner_ed25519';$KnownHosts=Join-Path $InstallDir 'keys\known_hosts.cocwin'
  $RegistryPaths=@(('Software\Google\Chrome\NativeMessagingHosts\'+$NativeName),('Software\Microsoft\Edge\NativeMessagingHosts\'+$NativeName))
  Need ((File-Hash $ConfigPath 65536) -ceq $ExpectedConfigSha256) 'CONFIG_CHANGED'
  $Saved=(Entry-Text (Open-Leaf $ReceiptPath 16384)) | ConvertFrom-Json
  Need ($Saved.schema -ceq 'COCWIN_RBRIDGE_WINDOWS_OWNER_SETUP_V1' -and $Saved.packageSourceSha -ceq '34871a7ece320f78344a4416d6ead4cbafde88c3' -and $Saved.packageSha256 -ceq '9afb6a22737f3b2d446684240051477096924e55e4d688b5f2feef70e8ef3350' -and $Saved.executableSha256 -ceq $OldSha -and $Saved.configSha256 -ceq $ExpectedConfigSha256 -and [string]::Equals($Saved.directory,$InstallDir,[StringComparison]::OrdinalIgnoreCase)) 'MANAGED_SETUP_PROVENANCE_CHANGED'
  $Config=(Entry-Text (Open-Leaf $ConfigPath 65536)) | ConvertFrom-Json
  Need ($Config.schema -ceq 'RBRIDGE_NATIVE_HOST_CONFIG_V1' -and @($Config.PSObject.Properties.Name) -notcontains 'v3' -and $Config.expectedExtensionId -ceq $ExtensionId) 'LEGACY_CONFIG_REQUIRED'
  Need ([string]::Equals($Config.ssh.identityFile,$Identity,[StringComparison]::OrdinalIgnoreCase) -and [string]::Equals($Config.ssh.knownHostsFile,$KnownHosts,[StringComparison]::OrdinalIgnoreCase) -and [string]::Equals($Config.eventStoreRoot,(Join-Path $InstallDir 'events'),[StringComparison]::OrdinalIgnoreCase)) 'MANAGED_CONFIG_PATHS_CHANGED'
  [void](Pin-Directory (Local-Path $Config.eventStoreRoot))
  $Manifest=(Entry-Text (Open-Leaf $ManifestPath 16384)) | ConvertFrom-Json
  Need ($Manifest.name -ceq $NativeName -and $Manifest.type -ceq 'stdio' -and [string]::Equals($Manifest.path,$ExePath,[StringComparison]::OrdinalIgnoreCase) -and @($Manifest.allowed_origins).Count -eq 1 -and $Manifest.allowed_origins[0] -ceq ('chrome-extension://'+$ExtensionId+'/')) 'MANAGED_MANIFEST_CHANGED'
  $Before=Protected-Snapshot
  $OldEntry=Open-Leaf $ExePath 134217728 $true;$Existing=Entry-Hash $OldEntry;$ExeAcl=Acl-State (Get-Acl -LiteralPath $ExePath).Sddl
  Need ($Existing -cin @($OldSha,$NewSha)) 'UNKNOWN_NATIVE_EXECUTABLE'
  if ($Existing -ceq $NewSha) {Check-Candidate $OldEntry;Need ((Protected-Snapshot) -ceq $Before) 'PROTECTED_STATE_CHANGED';$Result=Success 'ALREADY_QUALIFIED';$ExitCode=0}
  else {
    $Phase='QUALIFIED_PACKAGE_VERIFICATION';$Stage=Join-Path $InstallDir ('.native-update-'+[guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Path $Stage -ErrorAction Stop);$StageEntry=Pin-Directory $Stage $true
    $Archive=$null;$ArchiveStream=$null
    try {
      if ([string]::IsNullOrWhiteSpace($PackageZip)) {
        # No download pathname is exposed: untrusted bytes remain in memory.
        $Response=Invoke-WebRequest -UseBasicParsing -Uri $PackageUrl -TimeoutSec 180
        $ArchiveStream=$Response.RawContentStream
        Need ($ArchiveStream -is [IO.Stream] -and $ArchiveStream.CanSeek) 'QUALIFIED_DOWNLOAD_INVALID'
      } else {$ArchiveStream=(Open-Leaf $PackageZip 34357300).stream}
      $ArchiveStream.Position=0
      Need ($ArchiveStream.Length -eq 34357300 -and (Hash-Stream $ArchiveStream) -ceq $PackageSha) 'QUALIFIED_PACKAGE_INVALID';$ArchiveStream.Position=0
      Add-Type -AssemblyName System.IO.Compression
      $Archive=New-Object IO.Compression.ZipArchive($ArchiveStream,[IO.Compression.ZipArchiveMode]::Read,$true)
      Need ($Archive.Entries.Count -eq $Files.Count) 'QUALIFIED_PACKAGE_ENTRIES_INVALID'
      foreach ($File in $Files) {
        $Matches=@($Archive.Entries | Where-Object {$_.FullName -ceq $File.name});Need ($Matches.Count -eq 1 -and $Matches[0].Length -eq $File.bytes) 'QUALIFIED_PACKAGE_ENTRY_INVALID'
        $Stream=$Matches[0].Open();try {Need ((Hash-Stream $Stream) -ceq $File.sha) 'QUALIFIED_PACKAGE_ENTRY_INVALID'} finally {$Stream.Dispose()}
      }
      $NewExe=Join-Path $Stage 'qualified.exe';$Guid=Volume-Path $NewExe
      $NewHandle=$Native::CreateFileW($Guid,[uint32]3221553152,[uint32]1,[IntPtr]::Zero,[uint32]1,[uint32]35651584,[IntPtr]::Zero)
      Need (-not $NewHandle.IsInvalid) 'CANDIDATE_CREATE_FAILED';$Info=Handle-Info $NewHandle;$CreatedId=$Info.id
      $Writer=New-Object IO.FileStream($NewHandle,[IO.FileAccess]::ReadWrite);$Input=$Archive.GetEntry('dist-native-host/rbridge-native-host.exe').Open()
      try {
        $Input.CopyTo($Writer);$Writer.Flush($true)
        if ((Acl-State (Get-Acl -LiteralPath $NewExe).Sddl) -cne $ExeAcl) {
          $Access=New-Object Security.AccessControl.FileSecurity
          $Access.SetSecurityDescriptorSddlForm((Get-Acl -LiteralPath $ExePath).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access),[Security.AccessControl.AccessControlSections]::Access)
          $Writer.SetAccessControl($Access)
        }
      } finally {$Input.Dispose();$Writer.Dispose();$NewHandle.Dispose()}
      $Candidate=Open-Leaf $NewExe 134217728
      Need ($Candidate.id -ceq $CreatedId) 'CANDIDATE_IDENTITY_CHANGED'
    } finally {if ($null -ne $Archive) {$Archive.Dispose()};if ([string]::IsNullOrWhiteSpace($PackageZip) -and $null -ne $ArchiveStream) {$ArchiveStream.Dispose()}}
    $Phase='READONLY_CANDIDATE_CHECK';Check-Candidate $Candidate
    $CandidateId=$Candidate.id;Close-Entry $Candidate;$Candidate=Open-Leaf $NewExe 134217728 $true
    Need ($Candidate.id -ceq $CandidateId -and (Entry-Hash $Candidate) -ceq $NewSha) 'CANDIDATE_IDENTITY_CHANGED'
    Need ((Protected-Snapshot) -ceq $Before -and (Entry-Hash $OldEntry) -ceq $OldSha) 'MANAGED_INSTALLATION_CHANGED'
    $Backup=Join-Path $Stage 'original.exe';$Rejected=Join-Path $Stage 'rejected.exe'
    $Phase='EXECUTABLE_PUBLICATION';Need ((Acl-State (Get-Acl -LiteralPath $OldEntry.full).Sddl) -ceq $ExeAcl) 'ORIGINAL_ACL_CHANGED';$PublicationStarted=$true
    Rename-Entry $OldEntry $Backup
    $Phase='ORIGINAL_BACKED_UP';Need ((Entry-Hash $OldEntry) -ceq $OldSha -and (Acl-State (Get-Acl -LiteralPath $OldEntry.full).Sddl) -ceq $ExeAcl) 'BACKUP_READBACK_FAILED'
    Rename-Entry $Candidate $ExePath
    $Phase='INSTALLED_READBACK'
    Need ((Entry-Hash $Candidate) -ceq $NewSha -and (Entry-Hash $OldEntry) -ceq $OldSha -and (Acl-State (Get-Acl -LiteralPath $Candidate.full).Sddl) -ceq $ExeAcl -and (Protected-Snapshot) -ceq $Before) 'INSTALLED_READBACK_FAILED'
    $Result=Success 'UPGRADED';$ExitCode=0
  }
} catch {
  $Message=[string]$_.Exception.Message;$Reason=if ($Message -cmatch '^[A-Z][A-Z0-9_]{1,100}$') {$Message} else {'QUALIFIED_NATIVE_UPGRADE_FAILED'};$State='BLOCKED_PRESERVED'
  if ($PublicationStarted) {
    $KeepStage=$true;$State='UNCERTAIN'
    try {
      Need ((Entry-Hash $OldEntry) -ceq $OldSha -and (Protected-Snapshot) -ceq $Before) 'ROLLBACK_ORIGINAL_CHANGED'
      if ([string]::Equals($OldEntry.full,$ExePath,[StringComparison]::OrdinalIgnoreCase)) {$State='BLOCKED_PRESERVED';$KeepStage=$false}
      else {
        if ([string]::Equals($Candidate.full,$ExePath,[StringComparison]::OrdinalIgnoreCase)) {Need ((Entry-Hash $Candidate) -ceq $NewSha) 'ROLLBACK_CANDIDATE_CHANGED';Rename-Entry $Candidate $Rejected}
        Rename-Entry $OldEntry $ExePath
        Need ((Entry-Hash $OldEntry) -ceq $OldSha -and (Acl-State (Get-Acl -LiteralPath $OldEntry.full).Sddl) -ceq $ExeAcl) 'ROLLBACK_READBACK_FAILED';$State='ROLLED_BACK';$KeepStage=$false
      }
    } catch {$State='UNCERTAIN';$KeepStage=$true}
  }
  $Result=[pscustomobject]@{schema='COCWIN_RBRIDGE_WINDOWS_OWNER_UPGRADE_V1';status='BLOCKED';state=$State;reason=$Reason;failedAt=$Phase;failureLine=$_.InvocationInfo.ScriptLineNumber;executablePublicationStarted=$PublicationStarted;browserAcceptance='NOT_RUN';browserSends=0}
} finally {
  if ($null -ne $StageEntry -and -not $KeepStage) {
    try {
      if ($null -ne $Candidate -and -not $Candidate.closed -and -not [string]::Equals($Candidate.full,$ExePath,[StringComparison]::OrdinalIgnoreCase)) {
        if (-not $Candidate.deleteAccess) {$Id=$Candidate.id;$Path=$Candidate.full;Close-Entry $Candidate;$Candidate=Open-Leaf $Path 134217728 $true;Need ($Candidate.id -ceq $Id) 'CLEANUP_IDENTITY_CHANGED'}
        Need ((Entry-Hash $Candidate) -ceq $NewSha) 'CLEANUP_CANDIDATE_CHANGED';Delete-Entry $Candidate
      }
      if ($ExitCode -eq 0 -and $PublicationStarted -and $null -ne $OldEntry) {Need ((Entry-Hash $OldEntry) -ceq $OldSha) 'CLEANUP_BACKUP_CHANGED';Delete-Entry $OldEntry}
      Delete-Entry $StageEntry
    } catch {$KeepStage=$true;if ($null -ne $Result) {$Result | Add-Member -NotePropertyName stageCleanup -NotePropertyValue 'PRESERVED' -Force}}
  }
  if ($KeepStage -and $null -ne $Result) {$Result | Add-Member -NotePropertyName evidenceStage -NotePropertyValue $Stage -Force}
  for ($Index=$AllEntries.Count-1;$Index -ge 0;$Index--) {Close-Entry $AllEntries[$Index]}
  if ($Held) {$Mutex.ReleaseMutex()};if ($null -ne $Mutex) {$Mutex.Dispose()}
}
$Result | ConvertTo-Json -Depth 6 -Compress
if ($MyInvocation.MyCommand -is [System.Management.Automation.ExternalScriptInfo]) {exit $ExitCode}
if ($ExitCode -ne 0) {throw 'COCWIN_RBRIDGE_OWNER_UPGRADE_BLOCKED'}
