[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$PackageZip,[string]$UpgradePackageZip='')
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'zbaksa/rbridge-public') {throw 'DEDICATED_WINDOWS_CI_REQUIRED'}
$Current=[Security.Principal.WindowsIdentity]::GetCurrent()
$Principal=New-Object Security.Principal.WindowsPrincipal($Current)
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {throw 'CI_FIXTURE_CONTROLLER_ADMIN_REQUIRED'}
if ((Get-FileHash -LiteralPath $PackageZip -Algorithm SHA256).Hash.ToLowerInvariant() -cne '9afb6a22737f3b2d446684240051477096924e55e4d688b5f2feef70e8ef3350') {throw 'QUALIFIED_FIXTURE_ZIP_REQUIRED'}
$Utf8=New-Object Text.UTF8Encoding($false)
$Name='cwqa'+[Guid]::NewGuid().ToString('N').Substring(0,12)
$Root=Join-Path $env:ProgramData ('cocwin-standard-user-qa-'+[Guid]::NewGuid().ToString('N'))
$Created=$false;$Child=$null;$Account=$null;$ExitCode=1
try {
  $Password=ConvertTo-SecureString ([Guid]::NewGuid().ToString('N')+'!aA9') -AsPlainText -Force
  $Account=New-LocalUser -Name $Name -Password $Password -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword
  $Created=$true
  $Users=Get-LocalGroup -SID 'S-1-5-32-545'
  Add-LocalGroupMember -Group $Users -Member $Account
  [void][IO.Directory]::CreateDirectory($Root)
  $Acl=New-Object Security.AccessControl.DirectorySecurity
  $Acl.SetOwner($Current.User);$Acl.SetAccessRuleProtection($true,$false)
  foreach ($Sid in @($Current.User,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
    $Rule=New-Object Security.AccessControl.FileSystemAccessRule($Sid,[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
    [void]$Acl.AddAccessRule($Rule)
  }
  $Rule=New-Object Security.AccessControl.FileSystemAccessRule($Account.SID,[Security.AccessControl.FileSystemRights]::ReadAndExecute,([Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  [void]$Acl.AddAccessRule($Rule);Set-Acl -LiteralPath $Root -AclObject $Acl
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'setup-native-owner-windows.ps1') -Destination (Join-Path $Root 'setup.ps1')
  Copy-Item -LiteralPath $PackageZip -Destination (Join-Path $Root 'qualified.zip')
  if ($UpgradePackageZip -ne '') {
    if ((Get-FileHash -LiteralPath $UpgradePackageZip -Algorithm SHA256).Hash.ToLowerInvariant() -cne '0e614e0f143bb49db4e2e2807a9ebde4e6796e5adcf7425ff08762bd240b4af0') {throw 'QUALIFIED_UPGRADE_ZIP_REQUIRED'}
    Copy-Item -LiteralPath $UpgradePackageZip -Destination (Join-Path $Root 'upgrade-qualified.zip')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'test-native-owner-upgrade-cases-windows.ps1') -Destination (Join-Path $Root 'upgrade-cases.ps1')
    $UpgradeSource=Join-Path $PSScriptRoot 'upgrade-native-owner-windows.ps1'
    if (Test-Path -LiteralPath $UpgradeSource) {Copy-Item -LiteralPath $UpgradeSource -Destination (Join-Path $Root 'upgrade.ps1')}
  }
  $Driver=@'
$ErrorActionPreference='Stop'
$Root=$PSScriptRoot
$Current=[Security.Principal.WindowsIdentity]::GetCurrent()
$Principal=New-Object Security.Principal.WindowsPrincipal($Current)
$Elevated=$Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$Lines=New-Object 'Collections.Generic.List[string]'
try {
  if ($Elevated) {throw 'ORDINARY_USER_TOKEN_REQUIRED'}
  $Source=[IO.File]::ReadAllText((Join-Path $Root 'setup.ps1'))
  $Install=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'COCWIN\RBridge\NativeHost'
  if (Test-Path -LiteralPath $Install) {throw 'FRESH_ORDINARY_PROFILE_REQUIRED'}
  & ([scriptblock]::Create($Source)) -PackageZip (Join-Path $Root 'qualified.zip') -SshHost fixture.invalid -ServerHostKey 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBERERERERERERERERERERERERERERERERERERERERER' | ForEach-Object {[void]$Lines.Add([string]$_)}
  $Value=($Lines -join "`n") | ConvertFrom-Json
  if ($Value.status -cne 'PASS' -or $Value.state -cne 'INSTALLED_AWAITING_SERVER_KEY_ENROLLMENT') {throw 'ORDINARY_USER_FRESH_SETUP_FAILED'}
  $Private=Join-Path $Install 'keys\owner_ed25519';$Digest=(Get-FileHash -LiteralPath $Private -Algorithm SHA256).Hash
  $Again=(& ([scriptblock]::Create($Source)) -SshHost fixture.invalid -ServerHostKey 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBERERERERERERERERERERERERERERERERERERERERER' | Out-String) | ConvertFrom-Json
  if ($Again.status -cne 'PASS' -or $Again.state -cne 'ALREADY_INSTALLED_AWAITING_SERVER_KEY_ENROLLMENT' -or (Get-FileHash -LiteralPath $Private -Algorithm SHA256).Hash -cne $Digest) {throw 'ORDINARY_USER_RERUN_CHANGED_IDENTITY'}
  # This disposable account owns the complete fixture. Retain its real key pair
  # while reconstructing only the observed pre-install partial directory shape.
  foreach ($Name in @('.owner-setup-v1.json','rbridge-native-host.exe','rbridge-native-host.config.json','com.cocwin.rbridge_chat_v1.json','keys\known_hosts.cocwin')) {[IO.File]::Delete((Join-Path $Install $Name))}
  [IO.Directory]::Delete((Join-Path $Install 'events'),$false)
  foreach ($Key in @('Software\Google\Chrome\NativeMessagingHosts\com.cocwin.rbridge_chat_v1','Software\Microsoft\Edge\NativeMessagingHosts\com.cocwin.rbridge_chat_v1')) {
    $Reg=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Key,$true)
    try {$Reg.DeleteValue('',$false)} finally {$Reg.Dispose()}
  }
  $PrivateAcl=Get-Acl -LiteralPath $Private
  $PrivateAcl.SetAccessRuleProtection($false,$true)
  $Administrators=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
  $AdminRule=New-Object Security.AccessControl.FileSystemAccessRule($Administrators,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow)
  [void]$PrivateAcl.AddAccessRule($AdminRule)
  [IO.File]::SetAccessControl($Private,$PrivateAcl)
  function Run-Partial([bool]$Resume,[string]$Destination='',[string]$RegistrationDuringDownload='') {
    $Collected=New-Object 'Collections.Generic.List[string]'
    try {
      $SetupArguments=@{PackageZip=(Join-Path $Root 'qualified.zip');SshHost='fixture.invalid';ServerHostKey='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBERERERERERERERERERERERERERERERERERERERERER'}
      if ($Resume) {$SetupArguments.ResumeKeyPreparation=$true}
      if ($Destination -ne '') {$SetupArguments.InstallDir=$Destination}
      if ($RegistrationDuringDownload -ne '') {
        [void]$SetupArguments.Remove('PackageZip')
        # Only the external download boundary is controlled. Package bytes,
        # entry hashes, extraction and registry effects remain real.
        function Invoke-WebRequest {
          param([switch]$UseBasicParsing,[string]$Uri,[string]$OutFile,[int]$TimeoutSec)
          if (-not $UseBasicParsing -or $Uri -cne 'https://github.com/zbaksa/rbridge-public/releases/download/cocwin-windows-34871a7/rbridge-windows-34871a7.zip' -or $TimeoutSec -ne 180 -or (Get-Item -LiteralPath $OutFile).Length -ne 0) {throw 'UNEXPECTED_DOWNLOAD_FIXTURE_REQUEST'}
          [IO.File]::Copy((Join-Path $Root 'qualified.zip'),$OutFile,$true)
          $Reg=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($RegistrationDuringDownload)
          try {$Reg.SetValue('','C:\cocwin-ci-foreign-native-host.json',[Microsoft.Win32.RegistryValueKind]::String)} finally {$Reg.Dispose()}
        }
      }
      & ([scriptblock]::Create($Source)) @SetupArguments | ForEach-Object {[void]$Collected.Add([string]$_)}
    } catch {if ($_.FullyQualifiedErrorId -cne 'COCWIN_RBRIDGE_OWNER_SETUP_BLOCKED') {throw}}
    return (($Collected -join "`n") | ConvertFrom-Json)
  }
  function Assert-PartialKeyPreserved {
    if ((Get-FileHash -LiteralPath $Private -Algorithm SHA256).Hash -cne $Digest) {throw 'PARTIAL_PRIVATE_KEY_CHANGED'}
  }
  $Blocked=Run-Partial $false
  if ($Blocked.reason -cne 'EXISTING_INSTALLATION_UNMANAGED' -or $Blocked.installationMutationsStarted -ne $false) {throw 'PARTIAL_REQUIRES_EXPLICIT_RESUME'}
  Assert-PartialKeyPreserved
  $Missing=Join-Path (Split-Path -Parent $Install) 'missing-partial'
  $NoPartial=Run-Partial $true $Missing
  if ($NoPartial.reason -cne 'PARTIAL_INSTALLATION_REQUIRED' -or (Test-Path -LiteralPath $Missing)) {throw 'RESUME_MUST_NOT_GENERATE_A_NEW_IDENTITY'}
  Assert-PartialKeyPreserved
  $Sentinel=Join-Path $Install 'foreign.txt';[IO.File]::WriteAllText($Sentinel,'preserve')
  try {
    $Foreign=Run-Partial $true
    if ($Foreign.reason -cne 'PARTIAL_INSTALLATION_LAYOUT_INVALID' -or (Get-Content -LiteralPath $Sentinel -Raw) -cne 'preserve') {throw 'FOREIGN_PARTIAL_RESUME_NOT_PRESERVED'}
    Assert-PartialKeyPreserved
  } finally {[IO.File]::Delete($Sentinel)}
  $Alias=Join-Path (Split-Path -Parent $Install) 'private-alias'
  [void](New-Item -ItemType HardLink -Path $Alias -Target $Private)
  try {
    $Aliased=Run-Partial $true
    if ($Aliased.reason -cne 'PARTIAL_IDENTITY_INVALID' -or $Aliased.installationMutationsStarted -ne $false) {throw 'HARDLINKED_PARTIAL_IDENTITY_ACCEPTED'}
    Assert-PartialKeyPreserved
  } finally {[IO.File]::Delete($Alias)}
  $PublicPath=$Private+'.pub';$PublicBefore=[IO.File]::ReadAllBytes($PublicPath)
  [IO.File]::WriteAllText($PublicPath,'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBERERERERERERERERERERERERERERERERERERERERER')
  try {
    $Mismatch=Run-Partial $true
    if ($Mismatch.reason -cne 'PARTIAL_IDENTITY_INVALID' -or $Mismatch.installationMutationsStarted -ne $false) {throw 'MISMATCHED_PARTIAL_IDENTITY_ACCEPTED'}
    Assert-PartialKeyPreserved
  } finally {[IO.File]::WriteAllBytes($PublicPath,$PublicBefore)}
  foreach ($AclPath in @($Private,(Join-Path $Install 'keys'))) {
  $BeforeAcl=Get-Acl -LiteralPath $AclPath
  $AccessBefore=$BeforeAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
  $Broad=Get-Acl -LiteralPath $AclPath
  $Everyone=New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
  $Rule=New-Object Security.AccessControl.FileSystemAccessRule($Everyone,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow)
  [void]$Broad.AddAccessRule($Rule)
  if ($AclPath -ceq $Private) {[IO.File]::SetAccessControl($AclPath,$Broad)} else {[IO.Directory]::SetAccessControl($AclPath,$Broad)}
  $BroaderSddl=(Get-Acl -LiteralPath $AclPath).Sddl
  try {
    $Unsafe=Run-Partial $true
    if ($Unsafe.reason -cne 'PARTIAL_IDENTITY_INVALID' -or $Unsafe.installationMutationsStarted -ne $false -or (Get-Acl -LiteralPath $AclPath).Sddl -cne $BroaderSddl) {throw 'UNSAFE_PARTIAL_ACL_CHANGED_OR_ACCEPTED'}
    Assert-PartialKeyPreserved
  } finally {
    $BeforeAcl.SetSecurityDescriptorSddlForm($AccessBefore,[Security.AccessControl.AccessControlSections]::Access)
    if ($AclPath -ceq $Private) {[IO.File]::SetAccessControl($AclPath,$BeforeAcl)} else {[IO.Directory]::SetAccessControl($AclPath,$BeforeAcl)}
    if ((Get-Acl -LiteralPath $AclPath).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -cne $AccessBefore) {throw 'FIXTURE_ACL_RESTORE_FAILED'}
  }
  }
  foreach ($RegistryPath in @('Software\Google\Chrome\NativeMessagingHosts\com.cocwin.rbridge_chat_v1','Software\Microsoft\Edge\NativeMessagingHosts\com.cocwin.rbridge_chat_v1')) {
    $AclBeforeRace=(Get-Acl -LiteralPath $Private).Sddl
    try {
      $Race=Run-Partial $true '' $RegistryPath
      $Reg=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($RegistryPath)
      try {$Binding=if($null -ne $Reg){$Reg.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}else{$null}} finally {if($null -ne $Reg){$Reg.Dispose()}}
      if ($Race.reason -cne 'NATIVE_REGISTRATION_ALREADY_PRESENT' -or $Race.installationMutationsStarted -ne $false -or $Binding -cne 'C:\cocwin-ci-foreign-native-host.json' -or (Get-Acl -LiteralPath $Private).Sddl -cne $AclBeforeRace) {throw 'NATIVE_REGISTRATION_DURING_VERIFICATION_NOT_PRESERVED'}
      Assert-PartialKeyPreserved
    } finally {
      $Reg=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($RegistryPath,$true)
      try {if($null -ne $Reg){$Reg.DeleteValue('',$false)}} finally {if($null -ne $Reg){$Reg.Dispose()}}
    }
  }
  $Resumed=Run-Partial $true
  if ($Resumed.status -cne 'PASS' -or $Resumed.state -cne 'INSTALLED_AWAITING_SERVER_KEY_ENROLLMENT' -or $Resumed.publicKey -cne $Value.publicKey) {throw 'PARTIAL_RESUME_FAILED'}
  Assert-PartialKeyPreserved
  $Repeated=Run-Partial $true
  if ($Repeated.status -cne 'PASS' -or $Repeated.state -cne 'ALREADY_INSTALLED_AWAITING_SERVER_KEY_ENROLLMENT') {throw 'PARTIAL_RESUME_NOT_IDEMPOTENT'}
  Assert-PartialKeyPreserved
  $UpgradeQA=$null
  if (Test-Path -LiteralPath (Join-Path $Root 'upgrade-cases.ps1')) {
    $UpgradeQA=& (Join-Path $Root 'upgrade-cases.ps1')
    if ($UpgradeQA.state -cne 'PASS' -or $UpgradeQA.passed -lt 10) {throw 'ORDINARY_USER_UPGRADE_QA_FAILED'}
  }
  [pscustomobject]@{schema='RBRIDGE_WINDOWS_STANDARD_USER_SETUP_QA_V1';state='PASS';passed=13;upgradeQA=$UpgradeQA;administratorToken=$Elevated;defaultDirectory=$true;partialPrivateKeyPreserved=$true;actualOwnerWindows='NOT_RUN';sshConnections=0;browserSends=0} | ConvertTo-Json -Compress
  exit 0
} catch {
  $Records=@($Error | Select-Object -First 12 | ForEach-Object {[pscustomobject]@{type=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult;id=$_.FullyQualifiedErrorId;line=$_.InvocationInfo.ScriptLineNumber;message=$_.Exception.Message}})
  $KeyFacts=$null
  try {$Candidate=Join-Path $Install 'keys\owner_ed25519';if(Test-Path -LiteralPath $Candidate){$Security=Get-Acl -LiteralPath $Candidate;$KeyFacts=@{owner=$Security.GetOwner([Security.Principal.SecurityIdentifier]).Value;current=$Current.User.Value;protected=$Security.AreAccessRulesProtected;rules=@($Security.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {@{sid=$_.IdentityReference.Value;rights=[string]$_.FileSystemRights;type=[string]$_.AccessControlType}})}}} catch {}
  [pscustomobject]@{schema='RBRIDGE_WINDOWS_STANDARD_USER_SETUP_QA_V1';state='FAIL';administratorToken=$Elevated;bootstrapOutput=@($Lines);keyFacts=$KeyFacts;errors=$Records;actualOwnerWindows='NOT_RUN';sshConnections=0;browserSends=0} | ConvertTo-Json -Depth 6 -Compress
  exit 1
}
'@
  [IO.File]::WriteAllText((Join-Path $Root 'driver.ps1'),$Driver,$Utf8)
  # Retain the actual process/handle: Start-Process -Credential may lose ExitCode.
  $Start=New-Object Diagnostics.ProcessStartInfo
  $Start.FileName=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $Start.Arguments='-NoProfile -NonInteractive -File "'+(Join-Path $Root 'driver.ps1')+'"'
  $Start.WorkingDirectory=$Root;$Start.UseShellExecute=$false;$Start.CreateNoWindow=$true
  $Start.UserName=$Name;$Start.Domain=$env:COMPUTERNAME;$Start.Password=$Password;$Start.LoadUserProfile=$true
  $Start.RedirectStandardInput=$true;$Start.RedirectStandardOutput=$true;$Start.RedirectStandardError=$true
  $Child=New-Object Diagnostics.Process;$Child.StartInfo=$Start
  [void]$Child.Start();$Child.StandardInput.Close()
  $OutTask=$Child.StandardOutput.ReadToEndAsync();$ErrTask=$Child.StandardError.ReadToEndAsync()
  if (-not $Child.WaitForExit(120000)) {$Child.Kill();throw 'ORDINARY_USER_FIXTURE_TIMEOUT'}
  if (-not $OutTask.Wait(1000) -or -not $ErrTask.Wait(1000)) {throw 'ORDINARY_USER_FIXTURE_IO_TIMEOUT'}
  $Output=$OutTask.Result;$Errors=$ErrTask.Result
  if ($Output.Length -gt 16384 -or $Errors.Length -gt 16384) {throw 'ORDINARY_USER_FIXTURE_OUTPUT_TOO_LARGE'}
  Write-Output $Output
  if (-not [string]::IsNullOrWhiteSpace($Errors)) {throw 'ORDINARY_USER_UNEXPECTED_STDERR'}
  if ($Child.ExitCode -ne 0) {throw ('ORDINARY_USER_SETUP_REGRESSION_EXIT_'+$Child.ExitCode)}
  $Value=$Output | ConvertFrom-Json
  if ($Value.state -cne 'PASS' -or $Value.administratorToken -ne $false -or $Value.passed -ne 13) {throw 'ORDINARY_USER_PROOF_INVALID'}
  if ($UpgradePackageZip -ne '' -and ($Value.upgradeQA.state -cne 'PASS' -or $Value.upgradeQA.passed -lt 10)) {throw 'ORDINARY_USER_UPGRADE_PROOF_INVALID'}
  $ExitCode=0
} finally {
  if ($null -ne $Child) {if(-not $Child.HasExited){$Child.Kill()};$Child.Dispose()}
  if ($Created) {
    try {$Profile=Get-CimInstance Win32_UserProfile | Where-Object {$_.SID -ceq $Account.SID.Value -and -not $_.Loaded};if($null -ne $Profile){$Profile | Remove-CimInstance -ErrorAction Stop}} catch {Write-Warning 'CI_OWN_PROFILE_CLEANUP_PRESERVED'}
    Remove-LocalUser -Name $Name
  }
  if (Test-Path -LiteralPath $Root) {Remove-Item -LiteralPath $Root -Recurse -Force}
}
exit $ExitCode

