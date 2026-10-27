[CmdletBinding()]
param(
  [string]$PackageZip='',
  [string]$InstallDir='',
  [string]$SshHost='aether-engine',
  [int]$SshPort=22,
  [switch]$ResumeKeyPreparation,
  [Parameter(Mandatory=$true)][string]$ServerHostKey
)
$ErrorActionPreference='Stop'
$Utf8=New-Object Text.UTF8Encoding($false)
$PackageSha='9afb6a22737f3b2d446684240051477096924e55e4d688b5f2feef70e8ef3350'
$PackageBytes=34356996
$PackageSource='34871a7ece320f78344a4416d6ead4cbafde88c3'
$ExeSha='630ea7b69c12283ac311cbf137adfaf8078f091071697bab355282d080997b95'
$PackageUrl='https://github.com/zbaksa/rbridge-public/releases/download/cocwin-windows-34871a7/rbridge-windows-34871a7.zip'
$NativeName='com.cocwin.rbridge_chat_v1'
$ExtensionId='ebibbijpegoankenmggdnehpoadcophk'
$RegistryPaths=@(('Software\Google\Chrome\NativeMessagingHosts\'+$NativeName),('Software\Microsoft\Edge\NativeMessagingHosts\'+$NativeName))
$Files=@(
  @{name='dist-native-host/rbridge-native-host.metadata.json';bytes=241;sha='7f42f164c2efdf4bb6e2ca7ae61ce27fc4124dc976f9be9882f1939339252f3f';output='rbridge-native-host.metadata.json'},
  @{name='dist-native-host/install-native-host-windows.ps1';bytes=12007;sha='e15737025b0a7fdbf6cc41fce9f190853d418d4389d5cbeb2c3c9212b62e995b';output='install-native-host-windows.ps1'},
  @{name='dist-native-host/rbridge-native-host.exe';bytes=87199232;sha=$ExeSha;output='rbridge-native-host.exe'},
  @{name='dist-extension/manifest.json';bytes=917;sha='d665f154a32f7069fd7f3c4a7966e97cdb4f192c6afc49b76cdda854c38a4aa7';output=$null},
  @{name='dist-extension/contentScript.js';bytes=22461;sha='18e6fa923fabf879b07785266b56a4ad9599f97ea2ca8c4137d9788f21f7b8a3';output=$null},
  @{name='dist-extension/serviceWorker.js';bytes=108693;sha='d78e0c9b36df3d93a4e2b176dd18eaad3875d706a5de9f82fa82306b2f7e26b7';output=$null}
)
$ResumeIdentity=$null;$Resuming=$false
$Phase='PREFLIGHT';$Mutations=$false;$Stage=$null;$OwnStage=$false;$StageFiles=@();$SetupMutex=$null;$MutexHeld=$false;$Result=$null;$ExitCode=2
function Need([bool]$Condition,[string]$Reason) { if (-not $Condition) { throw $Reason } }
function Hash-Bytes([byte[]]$Bytes) {
  $Hasher=[Security.Cryptography.SHA256]::Create()
  try {return -join ($Hasher.ComputeHash($Bytes) | ForEach-Object {$_.ToString('x2')})} finally {$Hasher.Dispose()}
}
function Hash-Stream([IO.Stream]$Stream) {
  $Hasher=[Security.Cryptography.SHA256]::Create()
  try {return -join ($Hasher.ComputeHash($Stream) | ForEach-Object {$_.ToString('x2')})} finally {$Hasher.Dispose()}
}
function Local-Path([string]$Path) {
  Need ($Path.Length -le 1024 -and $Path -match '^[A-Za-z]:[\\/]' -and $Path -notmatch '[\r\n\x00"]') 'UNTRUSTED_LOCAL_PATH'
  $Full=[IO.Path]::GetFullPath($Path)
  Need (-not $Full.Substring(3).Contains(':')) 'UNTRUSTED_LOCAL_PATH'
  $Drive=New-Object IO.DriveInfo($Full.Substring(0,3))
  Need ($Drive.DriveType -in @([IO.DriveType]::Fixed,[IO.DriveType]::Removable,[IO.DriveType]::Ram)) 'UNTRUSTED_LOCAL_PATH'
  $Current=$Full.Substring(0,3)
  foreach ($Part in $Full.Substring(3).Split('\')) {
    if ($Part -eq '') {continue}
    Need (-not $Part.EndsWith('.') -and -not $Part.EndsWith(' ')) 'UNTRUSTED_LOCAL_PATH'
    $Current=Join-Path $Current $Part
    if (Test-Path -LiteralPath $Current) { $Info=Get-Item -LiteralPath $Current -Force;Need (-not ($Info.Attributes -band [IO.FileAttributes]::ReparsePoint)) 'UNTRUSTED_LOCAL_PATH' }
  }
  return $Full
}
function Read-Small([string]$Path,[int]$Limit) {
  [void](Local-Path $Path)
  $Info=Get-Item -LiteralPath $Path -Force
  Need (-not $Info.PSIsContainer -and $Info.Length -ge 1 -and $Info.Length -le $Limit) 'EXISTING_INSTALLATION_CHANGED'
  [byte[]]$Bytes=[IO.File]::ReadAllBytes($Path)
  Need ($Bytes.Length -eq $Info.Length) 'EXISTING_INSTALLATION_CHANGED'
  return ,$Bytes
}
function New-Bytes([string]$Path,[byte[]]$Bytes) {
  $Stream=New-Object IO.FileStream($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try {$Stream.Write($Bytes,0,$Bytes.Length);$Stream.Flush($true)} finally {$Stream.Dispose()}
}
function Public-Key([string]$Text,[string]$Reason) {
  $Parts=$Text.Trim() -split '\s+'
  Need ($Parts.Count -ge 2 -and $Parts[0] -ceq 'ssh-ed25519') $Reason
  try {[byte[]]$Blob=[Convert]::FromBase64String($Parts[1])} catch {throw $Reason}
  Need ($Blob.Length -eq 51 -and [Convert]::ToBase64String($Blob) -ceq $Parts[1] -and
    $Blob[0] -eq 0 -and $Blob[1] -eq 0 -and $Blob[2] -eq 0 -and $Blob[3] -eq 11 -and
    $Utf8.GetString($Blob,4,11) -ceq 'ssh-ed25519' -and $Blob[15] -eq 0 -and $Blob[16] -eq 0 -and $Blob[17] -eq 0 -and $Blob[18] -eq 32) $Reason
  $Hasher=[Security.Cryptography.SHA256]::Create()
  try {$Fingerprint='SHA256:'+([Convert]::ToBase64String($Hasher.ComputeHash($Blob))).TrimEnd('=')} finally {$Hasher.Dispose()}
  return @{publicKey=('ssh-ed25519 '+$Parts[1]);fingerprint=$Fingerprint}
}
function Binding([string]$Key) {
  $Reg=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Key)
  try {
    if ($null -eq $Reg -or @($Reg.GetValueNames()) -notcontains '') {return $null}
    return $Reg.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  } finally {if ($null -ne $Reg) {$Reg.Dispose()}}
}
function Check-Installed([string]$ExpectedConfigSha) {
  [void](Local-Path $InstallDir)
  [void](Local-Path $ExePath)
  Need ((Get-FileHash -LiteralPath $ExePath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $ExeSha) 'EXISTING_INSTALLATION_CHANGED'
  [byte[]]$Raw=Read-Small $ConfigPath 65536
  if ($ExpectedConfigSha -ne '') {Need ((Hash-Bytes $Raw) -ceq $ExpectedConfigSha) 'EXISTING_INSTALLATION_CHANGED'}
  $Config=$Utf8.GetString($Raw) | ConvertFrom-Json
  Need ($Config -is [pscustomobject] -and $Config.ssh -is [pscustomobject]) 'EXISTING_INSTALLATION_CHANGED'
  Need (@($Config.PSObject.Properties).Count -eq 4 -and @($Config.ssh.PSObject.Properties).Count -eq 6) 'EXISTING_INSTALLATION_CHANGED'
  foreach ($Pair in @(@($Config.schema,'RBRIDGE_NATIVE_HOST_CONFIG_V1'),@($Config.expectedExtensionId,$ExtensionId),@($Config.eventStoreRoot,$EventRoot),@($Config.ssh.sshPath,$SshPath),@($Config.ssh.host,$SshHost),@($Config.ssh.user,'rbridge'),@($Config.ssh.identityFile,$Identity),@($Config.ssh.knownHostsFile,$KnownHosts))) {
    Need ($Pair[0] -is [string] -and [string]::Equals($Pair[0],$Pair[1],[StringComparison]::OrdinalIgnoreCase)) 'EXISTING_INSTALLATION_CHANGED'
  }
  Need ($Config.ssh.port -is [int] -and $Config.ssh.port -eq $SshPort) 'EXISTING_INSTALLATION_CHANGED'
  Need ($Utf8.GetString((Read-Small $KnownHosts 4096)) -ceq $KnownLine) 'EXISTING_INSTALLATION_CHANGED'
  [void](Read-Small ($Identity+'.pub') 4096)
  Need (Test-Path -LiteralPath $Identity -PathType Leaf) 'EXISTING_INSTALLATION_CHANGED'
  $Manifest=$Utf8.GetString((Read-Small $ManifestPath 16384)) | ConvertFrom-Json
  Need ($Manifest -is [pscustomobject] -and @($Manifest.PSObject.Properties).Count -eq 5 -and $Manifest.name -is [string] -and $Manifest.name -ceq $NativeName -and $Manifest.type -is [string] -and $Manifest.type -ceq 'stdio' -and $Manifest.path -is [string] -and [string]::Equals($Manifest.path,$ExePath,[StringComparison]::OrdinalIgnoreCase)) 'EXISTING_INSTALLATION_CHANGED'
  Need ($Manifest.allowed_origins -is [array] -and $Manifest.allowed_origins.Count -eq 1 -and $Manifest.allowed_origins[0] -is [string] -and $Manifest.allowed_origins[0] -ceq ('chrome-extension://'+$ExtensionId+'/')) 'EXISTING_INSTALLATION_CHANGED'
  foreach ($Key in $RegistryPaths) {Need ([string]::Equals((Binding $Key),$ManifestPath,[StringComparison]::OrdinalIgnoreCase)) 'EXISTING_INSTALLATION_CHANGED'}
  return Hash-Bytes $Raw
}
function Set-FreshPrivatePermissions {
  # Normalize only a new key or an explicitly validated partial owner key.
  # Completed installations and foreign/changed keys are never reset.
  $OwnerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $Security=New-Object Security.AccessControl.FileSecurity
  [void](Local-Path $Identity)
  $ExistingSecurity=Get-Acl -LiteralPath $Identity
  Need ($ExistingSecurity.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $OwnerSid.Value) 'GENERATED_IDENTITY_OWNER_INVALID'
  # The owner may update its DACL without requesting an owner or audit change.
  $Security.SetAccessRuleProtection($true,$false)
  foreach ($AllowedSid in @($OwnerSid,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
    $Access=New-Object Security.AccessControl.FileSystemAccessRule($AllowedSid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow)
    [void]$Security.AddAccessRule($Access)
  }
  # Persist only the modified DACL; keep the verified existing owner unchanged.
  [IO.File]::SetAccessControl($Identity,$Security)
}
function Check-PrivateIdentity([string]$ExpectedPublic,[string]$Reason) {
  try {
    [void](Local-Path $Identity)
    $Info=Get-Item -LiteralPath $Identity -Force
    Need (-not $Info.PSIsContainer -and $Info.Length -ge 1 -and $Info.Length -le 16384) $Reason
    $OwnerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($ProtectedPath in @($KeyDir,$Identity)) {
      [void](Local-Path $ProtectedPath)
      $Security=Get-Acl -LiteralPath $ProtectedPath
      Need ($Security.AreAccessRulesProtected -and $Security.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $OwnerSid) $Reason
      foreach ($Rule in $Security.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        Need ($Rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $Rule.IdentityReference.Value -in @($OwnerSid,'S-1-5-18')) $Reason
      }
    }
    $DerivedText=Run-Bounded $Keygen ('-y -P "" -f "'+$Identity+'"') 15000
    $Derived=Public-Key $DerivedText $Reason
    Need ($Derived.publicKey -ceq $ExpectedPublic) $Reason
  } catch {throw $Reason}
}
function Check-PartialIdentity {
  try {
    [void](Local-Path $InstallDir);[void](Local-Path $KeyDir)
    $RootInfo=Get-Item -LiteralPath $InstallDir -Force
    $Items=@(Get-ChildItem -LiteralPath $InstallDir -Force)
    Need ($RootInfo.PSIsContainer -and $Items.Count -eq 1 -and $Items[0].Name -ceq 'keys' -and $Items[0].PSIsContainer) 'PARTIAL_INSTALLATION_LAYOUT_INVALID'
    $KeyItems=@(Get-ChildItem -LiteralPath $KeyDir -Force)
    Need ($KeyItems.Count -eq 2 -and @($KeyItems | Where-Object {$_.Name -cnotin @('owner_ed25519','owner_ed25519.pub') -or $_.PSIsContainer}).Count -eq 0) 'PARTIAL_INSTALLATION_LAYOUT_INVALID'
    foreach ($Path in @($Identity,($Identity+'.pub'))) {
      [void](Local-Path $Path)
      $Info=Get-Item -LiteralPath $Path -Force
      Need (-not $Info.PSIsContainer -and [string]::IsNullOrEmpty([string]$Info.LinkType)) 'PARTIAL_IDENTITY_INVALID'
    }
    $PrivateInfo=Get-Item -LiteralPath $Identity -Force
    Need ($PrivateInfo.Length -ge 1 -and $PrivateInfo.Length -le 16384) 'PARTIAL_IDENTITY_INVALID'
    $Sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Need ((Get-Acl -LiteralPath $InstallDir).GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $Sid) 'PARTIAL_IDENTITY_INVALID'
    foreach ($Path in @($KeyDir,$Identity)) {
      $Security=Get-Acl -LiteralPath $Path
      Need ($Security.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $Sid) 'PARTIAL_IDENTITY_INVALID'
      if ($Path -ceq $KeyDir) {Need $Security.AreAccessRulesProtected 'PARTIAL_IDENTITY_INVALID'}
      $Allowed=@($Sid,'S-1-5-18')
      # Windows OpenSSH may retain the trusted local Administrators group on a
      # just-generated file. Recovery narrows this to the normal owner/SYSTEM ACL.
      if ($Path -ceq $Identity) {$Allowed+='S-1-5-32-544'}
      $Rules=@($Security.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
      Need (@($Rules | Where-Object {$_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $_.IdentityReference.Value -ceq $Sid -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadData)}).Count -ge 1) 'PARTIAL_IDENTITY_INVALID'
      foreach ($Rule in $Rules) {Need ($Rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $Rule.IdentityReference.Value -in $Allowed) 'PARTIAL_IDENTITY_INVALID'}
    }
    $Public=Public-Key ($Utf8.GetString((Read-Small ($Identity+'.pub') 4096))) 'PARTIAL_IDENTITY_INVALID'
    $Digest=(Get-FileHash -LiteralPath $Identity -Algorithm SHA256).Hash.ToLowerInvariant()
    $Derived=Public-Key (Run-Bounded $Keygen ('-y -P "" -f "'+$Identity+'"') 15000) 'PARTIAL_IDENTITY_INVALID'
    Need ($Derived.publicKey -ceq $Public.publicKey -and (Get-FileHash -LiteralPath $Identity -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $Digest) 'PARTIAL_IDENTITY_INVALID'
    return @{publicKey=$Public.publicKey;privateSha256=$Digest}
  } catch {
    $Code=[string]$_.Exception.Message
    if ($Code -cin @('PARTIAL_INSTALLATION_LAYOUT_INVALID','UNTRUSTED_LOCAL_PATH')) {throw $Code}
    throw 'PARTIAL_IDENTITY_INVALID'
  }
}
function Public-Result([string]$State,[string]$ConfigDigest,$PublicIdentity) {
  # Construct a fixed public projection; never return an owner-editable receipt document.
  return [pscustomobject]@{schema='COCWIN_RBRIDGE_WINDOWS_OWNER_SETUP_V1';status='PASS';state=$State;packageSourceSha=$PackageSource;packageSha256=$PackageSha;executableSha256=$ExeSha;configSha256=$ConfigDigest;directory=$InstallDir;sshHost=$SshHost;sshPort=$SshPort;serverHostKey=$ServerHostKey;serverFingerprint=$Server.fingerprint;publicKey=$PublicIdentity.publicKey;fingerprint=$PublicIdentity.fingerprint;identityFile=$Identity;knownHostsFile=$KnownHosts;extensionId=$ExtensionId;browserExtension='NOT_INSTALLED_BY_THIS_STEP';v3Configured=$false;sshAuthentication='NOT_RUN';browserAcceptance='NOT_RUN';browserSends=0}
}
function Run-Bounded([string]$Exe,[string]$Arguments,[int]$Timeout) {
  $Start=New-Object Diagnostics.ProcessStartInfo
  $Start.FileName=$Exe;$Start.Arguments=$Arguments;$Start.UseShellExecute=$false;$Start.CreateNoWindow=$true
  $Start.RedirectStandardInput=$true;$Start.RedirectStandardOutput=$true;$Start.RedirectStandardError=$true
  $Start.StandardOutputEncoding=$Utf8;$Start.StandardErrorEncoding=$Utf8
  # Windows OpenSSH needs the owner's normal Windows logon environment.
  # Remove interpreter/askpass overrides while retaining those OS fields.
  foreach ($Name in @('NODE_OPTIONS','NODE_PATH','SSH_ASKPASS')) {$Start.EnvironmentVariables.Remove($Name)}
  $Start.EnvironmentVariables['SystemRoot']=$Windows
  $Start.EnvironmentVariables['WINDIR']=$Windows
  $Start.EnvironmentVariables['PATH']=(Join-Path $Windows 'System32\OpenSSH')+';'+(Join-Path $Windows 'System32')
  $Start.EnvironmentVariables['USERPROFILE']=[Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  $Start.EnvironmentVariables['LOCALAPPDATA']=$LocalData
  $Start.EnvironmentVariables['TEMP']=Join-Path $LocalData 'Temp'
  $Start.EnvironmentVariables['TMP']=Join-Path $LocalData 'Temp'
  $Start.EnvironmentVariables['SSH_ASKPASS_REQUIRE']='never'
  $Process=New-Object Diagnostics.Process;$Process.StartInfo=$Start
  try {
    [void]$Process.Start();$Process.StandardInput.Close();$Out=$Process.StandardOutput.ReadToEndAsync();$Err=$Process.StandardError.ReadToEndAsync()
    Need ($Process.WaitForExit($Timeout)) 'LOCAL_PROCESS_TIMEOUT'
    Need ($Out.Wait(1000) -and $Err.Wait(1000) -and $Process.ExitCode -eq 0) 'LOCAL_PROCESS_FAILED'
    Need ($Out.Result.Length -le 16384 -and $Err.Result.Length -le 16384) 'LOCAL_PROCESS_OUTPUT_INVALID'
    return $Out.Result
  } finally {
    if ($null -ne $Process -and -not $Process.HasExited) {$Process.Kill()}
    $Process.Dispose()
  }
}
try {
  Need ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) 'WINDOWS_REQUIRED'
  Need ($SshHost -cmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' -and $SshPort -ge 1 -and $SshPort -le 65535) 'SSH_ENDPOINT_INVALID'
  $Server=Public-Key $ServerHostKey 'SERVER_HOST_KEY_INVALID';$ServerHostKey=$Server.publicKey
  $HostField=if ($SshPort -eq 22) {$SshHost} else {'['+$SshHost+']:'+$SshPort}
  $KnownLine=$HostField+' '+$ServerHostKey+"`n"
  $LocalData=[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  if ([string]::IsNullOrWhiteSpace($InstallDir)) {$InstallDir=Join-Path $LocalData 'COCWIN\RBridge\NativeHost'}
  $InstallDir=Local-Path $InstallDir
  $Windows=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
  $SshPath=Join-Path $Windows 'System32\OpenSSH\ssh.exe';$Keygen=Join-Path $Windows 'System32\OpenSSH\ssh-keygen.exe'
  Need ((Test-Path -LiteralPath $SshPath -PathType Leaf) -and (Test-Path -LiteralPath $Keygen -PathType Leaf)) 'WINDOWS_OPENSSH_CLIENT_REQUIRED'
  $ExePath=Join-Path $InstallDir 'rbridge-native-host.exe';$ConfigPath=Join-Path $InstallDir 'rbridge-native-host.config.json'
  $ManifestPath=Join-Path $InstallDir ($NativeName+'.json');$EventRoot=Join-Path $InstallDir 'events';$ReceiptPath=Join-Path $InstallDir '.owner-setup-v1.json'
  $KeyDir=Join-Path $InstallDir 'keys';$Identity=Join-Path $KeyDir 'owner_ed25519';$KnownHosts=Join-Path $KeyDir 'known_hosts.cocwin'
  $MutexName='Global\COCWIN_RBridge_Install_'+(Hash-Bytes $Utf8.GetBytes($InstallDir.ToUpperInvariant()))
  $SetupMutex=New-Object Threading.Mutex($false,$MutexName)
  try {$MutexHeld=$SetupMutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$MutexHeld=$true}
  Need $MutexHeld 'RBRIDGE_NATIVE_INSTALL_IN_PROGRESS'
  if (Test-Path -LiteralPath $InstallDir) {
    if (-not (Test-Path -LiteralPath $ReceiptPath -PathType Leaf)) {
      Need ([bool]$ResumeKeyPreparation) 'EXISTING_INSTALLATION_UNMANAGED'
      foreach ($Key in $RegistryPaths) {Need ($null -eq (Binding $Key)) 'NATIVE_REGISTRATION_ALREADY_PRESENT'}
      $ResumeIdentity=Check-PartialIdentity;$Resuming=$true
    } else {
    try {
      $Saved=$Utf8.GetString((Read-Small $ReceiptPath 16384)) | ConvertFrom-Json
      Need ($Saved -is [pscustomobject]) 'EXISTING_INSTALLATION_CHANGED'
      foreach ($Name in @('schema','packageSourceSha','packageSha256','executableSha256','configSha256','sshHost','serverHostKey','publicKey','fingerprint','directory')) {Need ($Saved.$Name -is [string]) 'EXISTING_INSTALLATION_CHANGED'}
      Need ($Saved.schema -ceq 'COCWIN_RBRIDGE_WINDOWS_OWNER_SETUP_V1' -and $Saved.packageSourceSha -ceq $PackageSource -and $Saved.packageSha256 -ceq $PackageSha -and $Saved.executableSha256 -ceq $ExeSha -and $Saved.directory -ceq $InstallDir -and $Saved.sshHost -ceq $SshHost -and $Saved.serverHostKey -ceq $ServerHostKey -and $Saved.sshPort -is [int] -and $Saved.sshPort -eq $SshPort) 'EXISTING_INSTALLATION_CHANGED'
      $ConfigSha=Check-Installed $Saved.configSha256
      $Public=Public-Key ($Utf8.GetString((Read-Small ($Identity+'.pub') 4096))) 'EXISTING_INSTALLATION_CHANGED'
      Need ($Public.publicKey -ceq $Saved.publicKey -and $Public.fingerprint -ceq $Saved.fingerprint) 'EXISTING_INSTALLATION_CHANGED'
      Check-PrivateIdentity $Public.publicKey 'EXISTING_INSTALLATION_CHANGED'
      $Result=Public-Result 'ALREADY_INSTALLED_AWAITING_SERVER_KEY_ENROLLMENT' $ConfigSha $Public;$ExitCode=0
    } catch {throw 'EXISTING_INSTALLATION_CHANGED'}
    }
  } else {Need (-not $ResumeKeyPreparation) 'PARTIAL_INSTALLATION_REQUIRED'}
  if ($null -eq $Result) {
    foreach ($Key in $RegistryPaths) {Need ($null -eq (Binding $Key)) 'NATIVE_REGISTRATION_ALREADY_PRESENT'}
    $Phase='PACKAGE_VERIFICATION'
    $Stage=Join-Path $LocalData ('cocwin-native-owner-stage-'+[Guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Path $Stage);$OwnStage=$true
    if ([string]::IsNullOrWhiteSpace($PackageZip)) {
      $PackageZip=Join-Path $Stage 'qualified-package.zip'
      New-Bytes $PackageZip ([byte[]]@());$StageFiles+=$PackageZip
      Invoke-WebRequest -UseBasicParsing -Uri $PackageUrl -OutFile $PackageZip -TimeoutSec 180
    }
    $PackageZip=Local-Path $PackageZip
    $ArchiveStream=New-Object IO.FileStream($PackageZip,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $Archive=$null
    try {
      Need ($ArchiveStream.Length -eq $PackageBytes -and (Hash-Stream $ArchiveStream) -ceq $PackageSha) 'PACKAGE_ARCHIVE_INVALID'
      $ArchiveStream.Position=0
      Add-Type -AssemblyName System.IO.Compression
      $Archive=New-Object IO.Compression.ZipArchive($ArchiveStream,[IO.Compression.ZipArchiveMode]::Read,$true)
      Need ($Archive.Entries.Count -eq $Files.Count) 'PACKAGE_ARCHIVE_INVALID'
      foreach ($File in $Files) {
        $EntryMatches=@($Archive.Entries | Where-Object {$_.FullName -ceq $File.name})
        Need ($EntryMatches.Count -eq 1 -and $EntryMatches[0].Length -eq $File.bytes) 'PACKAGE_ENTRY_INVALID'
        $Stream=$EntryMatches[0].Open()
        try {Need ((Hash-Stream $Stream) -ceq $File.sha) 'PACKAGE_ENTRY_INVALID'} finally {$Stream.Dispose()}
      }
      foreach ($File in $Files | Where-Object {$null -ne $_.output}) {
        $Destination=Join-Path $Stage $File.output
        $Output=New-Object IO.FileStream($Destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        $StageFiles+=$Destination
        $Stream=$Archive.GetEntry($File.name).Open()
        try {$Stream.CopyTo($Output);$Output.Flush($true)} finally {$Stream.Dispose();$Output.Dispose()}
      }
    } finally {if ($null -ne $Archive) {$Archive.Dispose()};$ArchiveStream.Dispose()}
    $Phase='DEDICATED_KEY_PREPARATION'
    if ($Resuming) {
      $CurrentPartial=Check-PartialIdentity
      Need ($CurrentPartial.privateSha256 -ceq $ResumeIdentity.privateSha256 -and $CurrentPartial.publicKey -ceq $ResumeIdentity.publicKey) 'PARTIAL_IDENTITY_INVALID'
      $Mutations=$true
    } else {
    $Mutations=$true;[void](New-Item -ItemType Directory -Path $InstallDir)
    [void](New-Item -ItemType Directory -Path $KeyDir)
    $Sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $Acl=New-Object Security.AccessControl.DirectorySecurity
    $Acl.SetOwner($Sid);$Acl.SetAccessRuleProtection($true,$false)
    foreach ($IdentitySid in @($Sid,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
      $Rule=New-Object Security.AccessControl.FileSystemAccessRule($IdentitySid,[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
      [void]$Acl.AddAccessRule($Rule)
    }
    Set-Acl -LiteralPath $KeyDir -AclObject $Acl
    [void](Run-Bounded $Keygen ('-q -t ed25519 -N "" -C "cocwin-native-owner" -f "'+$Identity+'"') 15000)
    }
    Set-FreshPrivatePermissions
    $Public=Public-Key ($Utf8.GetString((Read-Small ($Identity+'.pub') 4096))) 'GENERATED_PUBLIC_KEY_INVALID'
    Check-PrivateIdentity $Public.publicKey 'GENERATED_IDENTITY_INVALID'
    if ($Resuming) {Need ((Get-FileHash -LiteralPath $Identity -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $ResumeIdentity.privateSha256 -and $Public.publicKey -ceq $ResumeIdentity.publicKey) 'PARTIAL_IDENTITY_INVALID'}
    New-Bytes $KnownHosts ($Utf8.GetBytes($KnownLine))
    $Phase='NATIVE_INSTALLATION'
    $Installer=Join-Path $Stage 'install-native-host-windows.ps1';$SourceExe=Join-Path $Stage 'rbridge-native-host.exe'
    Need ((Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant() -ceq 'e15737025b0a7fdbf6cc41fce9f190853d418d4389d5cbeb2c3c9212b62e995b' -and (Get-FileHash -LiteralPath $SourceExe -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $ExeSha) 'STAGED_PACKAGE_CHANGED'
    $InstallerText=[IO.File]::ReadAllText($Installer,$Utf8)
    $PreviousPath=$env:PATH
    try {
      $env:PATH=(Split-Path -Parent $SshPath)+';'+(Join-Path $Windows 'System32')
      $Installed=(& ([scriptblock]::Create($InstallerText)) -SourceExe $SourceExe -InstallDir $InstallDir -SshHost $SshHost -SshPort $SshPort -IdentityFile $Identity -KnownHostsFile $KnownHosts | Out-String) | ConvertFrom-Json
    } finally {$env:PATH=$PreviousPath}
    Need ($Installed -is [pscustomobject] -and $Installed.schema -is [string] -and $Installed.schema -ceq 'RBRIDGE_NATIVE_HOST_WINDOWS_INSTALL_V1' -and $Installed.status -ceq 'PASS' -and $Installed.v3Configured -is [bool] -and -not $Installed.v3Configured) 'NATIVE_INSTALL_RECEIPT_INVALID'
    $Phase='INSTALLED_READBACK'
    $ConfigSha=Check-Installed ''
    $Checked=(Run-Bounded $ExePath ('--check-config "'+$ConfigPath+'"') 15000) | ConvertFrom-Json
    Need ($Checked -is [pscustomobject] -and $Checked.schema -is [string] -and $Checked.schema -ceq 'RBRIDGE_NATIVE_CONFIG_CHECK_V1' -and $Checked.status -ceq 'PASS' -and $Checked.activated -is [bool] -and -not $Checked.activated -and $Checked.v3Configured -is [bool] -and -not $Checked.v3Configured -and $Checked.sourceSha256 -is [string] -and $Checked.sourceSha256 -ceq $ConfigSha) 'NATIVE_CONFIG_READBACK_INVALID'
    $Result=Public-Result 'INSTALLED_AWAITING_SERVER_KEY_ENROLLMENT' $ConfigSha $Public
    New-Bytes $ReceiptPath ($Utf8.GetBytes(($Result | ConvertTo-Json -Depth 6 -Compress)))
    $ExitCode=0
  }
} catch {
  $Message=[string]$_.Exception.Message
  $Reason=if ($Message -cmatch '^[A-Z][A-Z0-9_]{1,100}$') {$Message} else {'WINDOWS_OWNER_SETUP_FAILED'}
  $Result=[pscustomobject]@{schema='COCWIN_RBRIDGE_WINDOWS_OWNER_SETUP_V1';status='BLOCKED';state='SETUP_BLOCKED_OR_PARTIAL_PRESERVED';reason=$Reason;failedAt=$Phase;failureType=$_.Exception.GetType().FullName;failureHResult=$_.Exception.HResult;failureLine=$_.InvocationInfo.ScriptLineNumber;installationMutationsStarted=$Mutations;sshAuthentication='NOT_RUN';browserAcceptance='NOT_RUN';browserSends=0}
} finally {
  if ($MutexHeld) {$SetupMutex.ReleaseMutex()}
  if ($null -ne $SetupMutex) {$SetupMutex.Dispose()}
  if ($OwnStage) {
    try {
      [void](Local-Path $Stage)
      foreach ($File in $StageFiles) {if (Test-Path -LiteralPath $File) {[void](Local-Path $File);Remove-Item -LiteralPath $File -Force}}
      [IO.Directory]::Delete($Stage,$false)
    } catch {if ($null -ne $Result) {$Result | Add-Member -NotePropertyName stageCleanup -NotePropertyValue 'PRESERVED' -Force}}
  }
}
$Result | ConvertTo-Json -Depth 6 -Compress
# A downloaded scriptblock runs inside the owner's current PowerShell caller.
# Only a real -File invocation may exit its process with the CLI status.
if ($MyInvocation.MyCommand -is [System.Management.Automation.ExternalScriptInfo]) { exit $ExitCode }
if ($ExitCode -ne 0) { throw 'COCWIN_RBRIDGE_OWNER_SETUP_BLOCKED' }
