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
$Phase='PREFLIGHT';$PublicationStarted=$false;$Stage=$null;$OwnedFiles=@();$KeepStage=$false;$Mutex=$null;$Held=$false;$Result=$null;$ExitCode=2;$Before=$null
function Need([bool]$Ok,[string]$Why) {if (-not $Ok) {throw $Why}}
function Hash-Stream([IO.Stream]$Stream) {
  $Hasher=[Security.Cryptography.SHA256]::Create()
  try {return -join ($Hasher.ComputeHash($Stream) | ForEach-Object {$_.ToString('x2')})} finally {$Hasher.Dispose()}
}
function Hash-Text([string]$Text) {
  $Stream=New-Object IO.MemoryStream(,$Utf8.GetBytes($Text))
  try {return Hash-Stream $Stream} finally {$Stream.Dispose()}
}
function Local-Path([string]$Path) {
  Need ($Path.Length -le 1024 -and $Path -cmatch '^[A-Za-z]:\\' -and $Path -notmatch '[\x00-\x1f"<>|?*]') 'UNTRUSTED_LOCAL_PATH'
  $Full=[IO.Path]::GetFullPath($Path)
  Need ([string]::Equals($Path,$Full,[StringComparison]::OrdinalIgnoreCase) -and -not $Full.Substring(3).Contains(':')) 'UNTRUSTED_LOCAL_PATH'
  $Drive=New-Object IO.DriveInfo($Full.Substring(0,3));Need ($Drive.DriveType -in @([IO.DriveType]::Fixed,[IO.DriveType]::Removable,[IO.DriveType]::Ram)) 'UNTRUSTED_LOCAL_PATH'
  $Current=$Full.Substring(0,3)
  foreach ($Part in $Full.Substring(3).Split('\')) {
    Need ($Part -ne '' -and -not $Part.EndsWith('.') -and -not $Part.EndsWith(' ') -and $Part -notmatch '^(CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3]|CONIN\$|CONOUT\$)(\.|$)') 'UNTRUSTED_LOCAL_PATH'
    $Current=Join-Path $Current $Part
    if (Test-Path -LiteralPath $Current) {
      $Info=Get-Item -LiteralPath $Current -Force
      Need (-not ($Info.Attributes -band [IO.FileAttributes]::ReparsePoint) -and [string]::IsNullOrEmpty([string]$Info.LinkType)) 'UNTRUSTED_LOCAL_PATH'
    }
  }
  return $Full
}
function File-Hash([string]$Path,[long]$Maximum) {
  [void](Local-Path $Path);$Info=Get-Item -LiteralPath $Path -Force
  Need (-not $Info.PSIsContainer -and $Info.Length -ge 1 -and $Info.Length -le $Maximum) 'MANAGED_FILE_INVALID'
  $Stream=New-Object IO.FileStream($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try {Need ($Stream.Length -eq $Info.Length) 'MANAGED_FILE_CHANGED';return Hash-Stream $Stream} finally {$Stream.Dispose()}
}
function Binding([string]$Key) {
  $Reg=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Key)
  try {if ($null -eq $Reg) {return $null};return $Reg.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)} finally {if ($null -ne $Reg) {$Reg.Dispose()}}
}
function Protected-Snapshot {
  $Rows=@()
  foreach ($Path in @($ConfigPath,$ManifestPath,$ReceiptPath,$Identity,($Identity+'.pub'),$KnownHosts)) {
    $Rows+=@{path=$Path;sha=(File-Hash $Path 65536);acl=(Get-Acl -LiteralPath $Path).Sddl}
  }
  foreach ($Key in $RegistryPaths) {Need ([string]::Equals((Binding $Key),$ManifestPath,[StringComparison]::OrdinalIgnoreCase)) 'NATIVE_REGISTRATION_CHANGED';$Rows+=@{registry=$Key;binding=(Binding $Key)}}
  return ($Rows | ConvertTo-Json -Depth 5 -Compress)
}
function Check-Candidate([string]$Candidate) {
  Need ((File-Hash $Candidate 134217728) -ceq $NewSha) 'CANDIDATE_EXECUTABLE_CHANGED'
  $Start=New-Object Diagnostics.ProcessStartInfo
  $Start.FileName=$Candidate;$Start.Arguments='--check-config "'+$ConfigPath+'"';$Start.UseShellExecute=$false;$Start.CreateNoWindow=$true
  $Start.RedirectStandardInput=$true;$Start.RedirectStandardOutput=$true;$Start.RedirectStandardError=$true
  $Start.StandardOutputEncoding=$Utf8;$Start.StandardErrorEncoding=$Utf8
  foreach ($Name in @('NODE_OPTIONS','NODE_PATH','SSH_ASKPASS')) {$Start.EnvironmentVariables.Remove($Name)}
  $Start.EnvironmentVariables['SSH_ASKPASS_REQUIRE']='never'
  $Process=New-Object Diagnostics.Process;$Process.StartInfo=$Start
  try {
    [void]$Process.Start();$Process.StandardInput.Close();$Out=$Process.StandardOutput.ReadToEndAsync();$Err=$Process.StandardError.ReadToEndAsync()
    Need ($Process.WaitForExit(15000)) 'CANDIDATE_CONFIG_CHECK_TIMEOUT'
    Need ($Out.Wait(1000) -and $Err.Wait(1000) -and $Process.ExitCode -eq 0 -and $Out.Result.Length -le 16384 -and $Err.Result.Length -le 16384) 'CANDIDATE_CONFIG_CHECK_FAILED'
    $Checked=$Out.Result | ConvertFrom-Json
    Need ($Checked.schema -ceq 'RBRIDGE_NATIVE_CONFIG_CHECK_V1' -and $Checked.status -ceq 'PASS' -and $Checked.sourceSha256 -ceq $ExpectedConfigSha256 -and $Checked.expectedExtensionId -ceq $ExtensionId -and $Checked.v3Configured -is [bool] -and -not $Checked.v3Configured -and $Checked.activated -is [bool] -and -not $Checked.activated) 'CANDIDATE_CONFIG_CHECK_INVALID'
  } finally {if (-not $Process.HasExited) {$Process.Kill()};$Process.Dispose()}
}
function Success([string]$State) {
  return [pscustomobject]@{schema='COCWIN_RBRIDGE_WINDOWS_OWNER_UPGRADE_V1';status='PASS';state=$State;packageSourceSha=$SourceSha;packageSha256=$PackageSha;executableSha256=$NewSha;configSha256=$ExpectedConfigSha256;directory=$InstallDir;executablePublicationStarted=$PublicationStarted;protectedFilesPreserved=$true;keyConfigHistoryWrites=0;registrationWrites=0;v3Configured=$false;sshAuthentication='NOT_RUN_BY_UPGRADE';browserAcceptance='NOT_RUN';browserSends=0}
}
try {
  Need ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) 'WINDOWS_REQUIRED'
  Need ($ExpectedConfigSha256 -cmatch '^[a-f0-9]{64}$') 'CONFIG_PIN_INVALID'
  if ([string]::IsNullOrWhiteSpace($InstallDir)) {$InstallDir=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'COCWIN\RBridge\NativeHost'}
  $InstallDir=Local-Path $InstallDir;Need (Test-Path -LiteralPath $InstallDir -PathType Container) 'MANAGED_SETUP_REQUIRED'
  $Mutex=New-Object Threading.Mutex($false,('Global\COCWIN_RBridge_Install_'+(Hash-Text $InstallDir.ToUpperInvariant())))
  try {$Held=$Mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$Held=$true};Need $Held 'NATIVE_INSTALL_IN_PROGRESS'
  $ExePath=Join-Path $InstallDir 'rbridge-native-host.exe';$ConfigPath=Join-Path $InstallDir 'rbridge-native-host.config.json'
  $ManifestPath=Join-Path $InstallDir ($NativeName+'.json');$ReceiptPath=Join-Path $InstallDir '.owner-setup-v1.json'
  $Identity=Join-Path $InstallDir 'keys\owner_ed25519';$KnownHosts=Join-Path $InstallDir 'keys\known_hosts.cocwin'
  $RegistryPaths=@(('Software\Google\Chrome\NativeMessagingHosts\'+$NativeName),('Software\Microsoft\Edge\NativeMessagingHosts\'+$NativeName))
  Need (Test-Path -LiteralPath $ReceiptPath -PathType Leaf) 'MANAGED_SETUP_REQUIRED'
  Need ((File-Hash $ConfigPath 65536) -ceq $ExpectedConfigSha256) 'CONFIG_CHANGED'
  [void](File-Hash $ReceiptPath 16384);$Saved=[IO.File]::ReadAllText($ReceiptPath,$Utf8) | ConvertFrom-Json
  Need ($Saved.schema -ceq 'COCWIN_RBRIDGE_WINDOWS_OWNER_SETUP_V1' -and $Saved.packageSourceSha -ceq '34871a7ece320f78344a4416d6ead4cbafde88c3' -and $Saved.packageSha256 -ceq '9afb6a22737f3b2d446684240051477096924e55e4d688b5f2feef70e8ef3350' -and $Saved.executableSha256 -ceq $OldSha -and $Saved.configSha256 -ceq $ExpectedConfigSha256 -and [string]::Equals($Saved.directory,$InstallDir,[StringComparison]::OrdinalIgnoreCase)) 'MANAGED_SETUP_PROVENANCE_CHANGED'
  $Config=[IO.File]::ReadAllText($ConfigPath,$Utf8) | ConvertFrom-Json
  Need ($Config.schema -ceq 'RBRIDGE_NATIVE_HOST_CONFIG_V1' -and @($Config.PSObject.Properties.Name) -notcontains 'v3' -and $Config.expectedExtensionId -ceq $ExtensionId) 'LEGACY_CONFIG_REQUIRED'
  Need ([string]::Equals($Config.ssh.identityFile,$Identity,[StringComparison]::OrdinalIgnoreCase) -and [string]::Equals($Config.ssh.knownHostsFile,$KnownHosts,[StringComparison]::OrdinalIgnoreCase) -and [string]::Equals($Config.eventStoreRoot,(Join-Path $InstallDir 'events'),[StringComparison]::OrdinalIgnoreCase)) 'MANAGED_CONFIG_PATHS_CHANGED'
  [void](Local-Path $Config.eventStoreRoot)
  [void](File-Hash $ManifestPath 16384);$Manifest=[IO.File]::ReadAllText($ManifestPath,$Utf8) | ConvertFrom-Json
  Need ($Manifest.name -ceq $NativeName -and $Manifest.type -ceq 'stdio' -and [string]::Equals($Manifest.path,$ExePath,[StringComparison]::OrdinalIgnoreCase) -and @($Manifest.allowed_origins).Count -eq 1 -and $Manifest.allowed_origins[0] -ceq ('chrome-extension://'+$ExtensionId+'/')) 'MANAGED_MANIFEST_CHANGED'
  $Before=Protected-Snapshot;$Existing=File-Hash $ExePath 134217728;$ExeAcl=(Get-Acl -LiteralPath $ExePath).Sddl
  Need ($Existing -cin @($OldSha,$NewSha)) 'UNKNOWN_NATIVE_EXECUTABLE'
  if ($Existing -ceq $NewSha) {Check-Candidate $ExePath;Need ((Protected-Snapshot) -ceq $Before) 'PROTECTED_STATE_CHANGED';$Result=Success 'ALREADY_QUALIFIED';$ExitCode=0}
  else {
    $Phase='QUALIFIED_PACKAGE_VERIFICATION';$Stage=Join-Path $InstallDir ('.native-update-'+[guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($Stage)
    if ([string]::IsNullOrWhiteSpace($PackageZip)) {
      $PackageZip=Join-Path $Stage 'qualified.zip';$OwnedFiles+=$PackageZip
      $Empty=New-Object IO.FileStream($PackageZip,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$Empty.Dispose()
      Invoke-WebRequest -UseBasicParsing -Uri $PackageUrl -OutFile $PackageZip -TimeoutSec 180
    }
    $PackageZip=Local-Path $PackageZip
    $ArchiveStream=New-Object IO.FileStream($PackageZip,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$Archive=$null
    $NewExe=Join-Path $Stage 'qualified.exe';$Backup=Join-Path $Stage 'original.exe';$Rejected=Join-Path $Stage 'rejected.exe';$OwnedFiles+=@($NewExe,$Backup,$Rejected)
    try {
      Need ($ArchiveStream.Length -eq 34357300 -and (Hash-Stream $ArchiveStream) -ceq $PackageSha) 'QUALIFIED_PACKAGE_INVALID';$ArchiveStream.Position=0
      Add-Type -AssemblyName System.IO.Compression
      $Archive=New-Object IO.Compression.ZipArchive($ArchiveStream,[IO.Compression.ZipArchiveMode]::Read,$true)
      Need ($Archive.Entries.Count -eq $Files.Count) 'QUALIFIED_PACKAGE_ENTRIES_INVALID'
      foreach ($File in $Files) {
        $Matches=@($Archive.Entries | Where-Object {$_.FullName -ceq $File.name})
        Need ($Matches.Count -eq 1 -and $Matches[0].Length -eq $File.bytes) 'QUALIFIED_PACKAGE_ENTRY_INVALID'
        $Stream=$Matches[0].Open();try {Need ((Hash-Stream $Stream) -ceq $File.sha) 'QUALIFIED_PACKAGE_ENTRY_INVALID'} finally {$Stream.Dispose()}
      }
      $Output=New-Object IO.FileStream($NewExe,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      $Stream=$Archive.GetEntry('dist-native-host/rbridge-native-host.exe').Open()
      try {$Stream.CopyTo($Output);$Output.Flush($true)} finally {$Stream.Dispose();$Output.Dispose()}
    } finally {if ($null -ne $Archive) {$Archive.Dispose()};$ArchiveStream.Dispose()}
    $Phase='READONLY_CANDIDATE_CHECK';Check-Candidate $NewExe
    Need ((Protected-Snapshot) -ceq $Before -and (File-Hash $ExePath 134217728) -ceq $OldSha -and (Get-Acl -LiteralPath $ExePath).Sddl -ceq $ExeAcl) 'MANAGED_INSTALLATION_CHANGED'
    $Phase='EXECUTABLE_PUBLICATION';$PublicationStarted=$true
    [IO.File]::Replace($NewExe,$ExePath,$Backup,$false)
    $Phase='INSTALLED_READBACK'
    Need ((File-Hash $ExePath 134217728) -ceq $NewSha -and (File-Hash $Backup 134217728) -ceq $OldSha -and (Get-Acl -LiteralPath $ExePath).Sddl -ceq $ExeAcl -and (Protected-Snapshot) -ceq $Before) 'INSTALLED_READBACK_FAILED'
    $Result=Success 'UPGRADED';$ExitCode=0
  }
} catch {
  $Message=[string]$_.Exception.Message;$Reason=if ($Message -cmatch '^[A-Z][A-Z0-9_]{1,100}$') {$Message} else {'QUALIFIED_NATIVE_UPGRADE_FAILED'}
  $State='BLOCKED_PRESERVED'
  if ($PublicationStarted) {
    $KeepStage=$true;$State='UNCERTAIN'
    try {
      $Now=if (Test-Path -LiteralPath $ExePath) {File-Hash $ExePath 134217728} else {''}
      if ($Now -ceq $OldSha) {$State='BLOCKED_PRESERVED';$KeepStage=$false}
      elseif (($Now -ceq $NewSha -or $Now -ceq '') -and (File-Hash $Backup 134217728) -ceq $OldSha -and (Protected-Snapshot) -ceq $Before) {
        if ($Now -ceq '') {[IO.File]::Move($Backup,$ExePath)} else {[IO.File]::Replace($Backup,$ExePath,$Rejected,$false)}
        Need ((File-Hash $ExePath 134217728) -ceq $OldSha -and (Get-Acl -LiteralPath $ExePath).Sddl -ceq $ExeAcl) 'ROLLBACK_READBACK_FAILED';$State='ROLLED_BACK';$KeepStage=$false
      }
    } catch {$State='UNCERTAIN';$KeepStage=$true}
  }
  $Result=[pscustomobject]@{schema='COCWIN_RBRIDGE_WINDOWS_OWNER_UPGRADE_V1';status='BLOCKED';state=$State;reason=$Reason;failedAt=$Phase;executablePublicationStarted=$PublicationStarted;browserAcceptance='NOT_RUN';browserSends=0}
  if ($KeepStage) {$Result | Add-Member -NotePropertyName evidenceStage -NotePropertyValue $Stage}
} finally {
  if ($null -ne $Stage -and -not $KeepStage) {
    try {
      [void](Local-Path $Stage)
      foreach ($Path in $OwnedFiles) {if (Test-Path -LiteralPath $Path) {[void](Local-Path $Path);[IO.File]::Delete($Path)}}
      [IO.Directory]::Delete($Stage,$false)
    } catch {if ($null -ne $Result) {$Result | Add-Member -NotePropertyName stageCleanup -NotePropertyValue 'PRESERVED' -Force}}
  }
  if ($Held) {$Mutex.ReleaseMutex()};if ($null -ne $Mutex) {$Mutex.Dispose()}
}
$Result | ConvertTo-Json -Depth 6 -Compress
if ($MyInvocation.MyCommand -is [System.Management.Automation.ExternalScriptInfo]) {exit $ExitCode}
if ($ExitCode -ne 0) {throw 'COCWIN_RBRIDGE_OWNER_UPGRADE_BLOCKED'}
