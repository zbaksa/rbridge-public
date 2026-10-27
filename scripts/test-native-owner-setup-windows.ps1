[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$PackageZip,[string]$BootstrapPath='')
$ErrorActionPreference='Stop'
if ([string]::IsNullOrWhiteSpace($BootstrapPath)) { $BootstrapPath=Join-Path $PSScriptRoot 'setup-native-owner-windows.ps1' }
if (-not (Test-Path -LiteralPath $BootstrapPath -PathType Leaf)) { throw 'OWNER_SETUP_IMPLEMENTATION_ABSENT' }
$Root=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) ('cocwin-owner-setup-test-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($Root)
$Keys=@('Software\Google\Chrome\NativeMessagingHosts\com.cocwin.rbridge_chat_v1','Software\Microsoft\Edge\NativeMessagingHosts\com.cocwin.rbridge_chat_v1')
$Saved=@()
foreach ($Key in $Keys) {
  $Reg=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Key)
  try {
    $Item=@{path=$Key;present=($null -ne $Reg);hasDefault=$false;value=$null;kind=[Microsoft.Win32.RegistryValueKind]::String}
    if ($null -ne $Reg -and @($Reg.GetValueNames()) -contains '') { $Item.hasDefault=$true;$Item.value=$Reg.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);$Item.kind=$Reg.GetValueKind('') }
    $Saved+=$Item
  } finally { if ($null -ne $Reg) { $Reg.Dispose() } }
}
$ServerKey='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBERERERERERERERERERERERERERERERERERERERERER'
$Utf8=New-Object Text.UTF8Encoding($false)
$Passed=0
function Assert-QA([bool]$Condition,[string]$Code) { if (-not $Condition) { throw ('OWNER_SETUP_TEST_FAILED:'+ $Code) } }
function Clear-Bindings {
  foreach ($Key in $Keys) {
    $Reg=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Key,$true)
    if ($null -ne $Reg) { try { $Reg.DeleteValue('',$false) } finally { $Reg.Dispose() } }
  }
}
function Run-Setup([string]$Install,[string]$Zip=$PackageZip,[string]$HostKey=$ServerKey) {
  $Start=New-Object Diagnostics.ProcessStartInfo
  $Start.FileName=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)) 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $ZipArgument=if([string]::IsNullOrWhiteSpace($Zip)){''}else{' -PackageZip "'+$Zip+'"'}
  $Start.Arguments='-NoProfile -NonInteractive -File "'+$BootstrapPath+'"'+$ZipArgument+' -InstallDir "'+$Install+'" -SshHost "fixture.invalid" -ServerHostKey "'+$HostKey+'"'
  $Start.UseShellExecute=$false;$Start.RedirectStandardOutput=$true;$Start.RedirectStandardError=$true
  $Process=New-Object Diagnostics.Process
  $Process.StartInfo=$Start
  try {
    [void]$Process.Start();$Out=$Process.StandardOutput.ReadToEndAsync();$Err=$Process.StandardError.ReadToEndAsync()
    if (-not $Process.WaitForExit($(if([string]::IsNullOrWhiteSpace($Zip)){210000}else{45000}))) { $Process.Kill();throw 'OWNER_SETUP_TEST_TIMEOUT' }
    if (-not $Out.Wait(1000) -or -not $Err.Wait(1000)) { throw 'OWNER_SETUP_TEST_IO_TIMEOUT' }
    Assert-QA ([string]::IsNullOrWhiteSpace($Err.Result)) ('stderr '+$Err.Result)
    Assert-QA ($Out.Result.Length -lt 16384) 'bounded stdout'
    $Value=$Out.Result | ConvertFrom-Json
    Assert-QA ($Value.schema -ceq 'COCWIN_RBRIDGE_WINDOWS_OWNER_SETUP_V1') 'receipt schema'
    Assert-QA ($Value.sshAuthentication -ceq 'NOT_RUN' -and $Value.browserAcceptance -ceq 'NOT_RUN' -and $Value.browserSends -eq 0) 'live gates'
    return @{value=$Value;raw=$Out.Result;exitCode=$Process.ExitCode}
  } finally { $Process.Dispose() }
}
function Blocked($Result,[string]$Reason) {
  Assert-QA ($Result.exitCode -eq 2 -and $Result.value.status -ceq 'BLOCKED' -and $Result.value.reason -ceq $Reason) ('expected blocked '+$Reason+'; actual exit='+$Result.exitCode+' status='+$Result.value.status+' state='+$Result.value.state+' reason='+$Result.value.reason)
}
try {
  Clear-Bindings
  $Bad=Join-Path $Root 'tampered.zip';[IO.File]::WriteAllBytes($Bad,[byte[]]@(1,2,3))
  $Install=Join-Path $Root 'bad-package';$R=Run-Setup $Install $Bad
  Blocked $R 'PACKAGE_ARCHIVE_INVALID'
  Assert-QA (-not (Test-Path -LiteralPath $Install)) 'bad package changed destination'
  $Passed++

  $Install=Join-Path $Root 'fresh'
  $R=Run-Setup $Install
  Assert-QA ($R.exitCode -eq 0 -and $R.value.status -ceq 'PASS' -and $R.value.state -ceq 'INSTALLED_AWAITING_SERVER_KEY_ENROLLMENT') 'fresh install'
  Assert-QA ($R.value.v3Configured -eq $false -and $R.value.executableSha256 -ceq '630ea7b69c12283ac311cbf137adfaf8078f091071697bab355282d080997b95') 'qualified binary no invented v3'
  $Private=Join-Path $Install 'keys\owner_ed25519';$Public=$Private+'.pub';$Known=Join-Path $Install 'keys\known_hosts.cocwin'
  Assert-QA ((Get-Content -LiteralPath $Known -Raw).Trim() -ceq ('fixture.invalid '+$ServerKey)) 'known-host out-of-band pin'
  Assert-QA ($R.value.publicKey -ceq (((Get-Content -LiteralPath $Public -Raw).Trim() -split '\s+')[0..1] -join ' ')) 'real generated public key'
  Assert-QA ($R.value.fingerprint -cmatch '^SHA256:[A-Za-z0-9+/]{43}$') 'public fingerprint'
  $PrivateText=[IO.File]::ReadAllText($Private)
  Assert-QA (-not $R.raw.Contains('BEGIN OPENSSH PRIVATE KEY') -and -not $R.raw.Contains($PrivateText.Trim())) 'no private material in receipt'
  $Acl=Get-Acl -LiteralPath (Join-Path $Install 'keys')
  Assert-QA ($Acl.AreAccessRulesProtected) 'key-directory inheritance protected'
  $Sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $Rules=$Acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
  Assert-QA (@($Rules | Where-Object {$_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $_.IdentityReference.Value -notin @($Sid,'S-1-5-18')}).Count -eq 0) 'key directory restricted to current owner and SYSTEM'
  foreach ($Key in $Keys) { $Reg=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Key);try { Assert-QA ($Reg.GetValue('') -ceq (Join-Path $Install 'com.cocwin.rbridge_chat_v1.json')) 'registry readback' } finally {$Reg.Dispose()} }
  Assert-QA ($R.value.browserExtension -ceq 'NOT_INSTALLED_BY_THIS_STEP') 'no legacy extension deployment'
  $Config=Join-Path $Install 'rbridge-native-host.config.json'
  $ConfigHash=(Get-FileHash -LiteralPath $Config).Hash;$PrivateHash=(Get-FileHash -LiteralPath $Private).Hash;$ConfigTime=(Get-Item -LiteralPath $Config).LastWriteTimeUtc.Ticks
  $Passed++

  $Again=Run-Setup $Install
  Assert-QA ($Again.exitCode -eq 0 -and $Again.value.state -ceq 'ALREADY_INSTALLED_AWAITING_SERVER_KEY_ENROLLMENT') 'idempotent state'
  Assert-QA ($Again.value.publicKey -ceq $R.value.publicKey -and (Get-FileHash -LiteralPath $Private).Hash -ceq $PrivateHash) 'no rekey'
  Assert-QA ((Get-FileHash -LiteralPath $Config).Hash -ceq $ConfigHash -and (Get-Item -LiteralPath $Config).LastWriteTimeUtc.Ticks -eq $ConfigTime) 'no config rewrite'
  $Passed++

  # Neither a corrupt nor a different private identity may reuse an old public receipt.
  [byte[]]$PrivateBefore=[IO.File]::ReadAllBytes($Private)
  $PrivateAclBefore=Get-Acl -LiteralPath $Private
  [IO.File]::WriteAllBytes($Private,[byte[]]@())
  try {
    $R=Run-Setup $Install
    Blocked $R 'EXISTING_INSTALLATION_CHANGED'
    Assert-QA ((Get-Item -LiteralPath $Private).Length -eq 0) 'corrupt private preimage preserved'
  } finally {[IO.File]::WriteAllBytes($Private,$PrivateBefore);Set-Acl -LiteralPath $Private -AclObject $PrivateAclBefore}
  $Passed++

  $Other=Join-Path $Root 'other_ed25519'
  $Start=New-Object Diagnostics.ProcessStartInfo
  $Start.FileName=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)) 'System32\OpenSSH\ssh-keygen.exe'
  $Start.Arguments='-q -t ed25519 -N "" -f "'+$Other+'"';$Start.UseShellExecute=$false;$Start.CreateNoWindow=$true;$Start.RedirectStandardInput=$true;$Start.RedirectStandardOutput=$true;$Start.RedirectStandardError=$true
  $Gen=New-Object Diagnostics.Process;$Gen.StartInfo=$Start
  try {[void]$Gen.Start();$Gen.StandardInput.Close();if(-not $Gen.WaitForExit(15000)){$Gen.Kill();throw 'ALTERNATE_KEY_FIXTURE_TIMEOUT'};Assert-QA ($Gen.ExitCode -eq 0) 'alternate real private key fixture'} finally {$Gen.Dispose()}
  [byte[]]$OtherBytes=[IO.File]::ReadAllBytes($Other)
  [IO.File]::WriteAllBytes($Private,$OtherBytes)
  try {
    $DifferentHash=(Get-FileHash -LiteralPath $Private).Hash
    $R=Run-Setup $Install
    Blocked $R 'EXISTING_INSTALLATION_CHANGED'
    Assert-QA ((Get-FileHash -LiteralPath $Private).Hash -ceq $DifferentHash) 'different private preimage preserved'
  } finally {[IO.File]::WriteAllBytes($Private,$PrivateBefore);Set-Acl -LiteralPath $Private -AclObject $PrivateAclBefore}
  $Passed++

  Remove-Item -LiteralPath $Private
  [void](New-Item -ItemType SymbolicLink -Path $Private -Target $Other)
  try {
    $R=Run-Setup $Install
    Blocked $R 'EXISTING_INSTALLATION_CHANGED'
    Assert-QA ((Get-Item -LiteralPath $Private -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) 'private reparse preserved'
  } finally {[IO.File]::Delete($Private);[IO.File]::WriteAllBytes($Private,$PrivateBefore);Set-Acl -LiteralPath $Private -AclObject $PrivateAclBefore}
  $Passed++

  foreach ($AclPath in @($Private,(Join-Path $Install 'keys'))) {
    $BeforeAcl=Get-Acl -LiteralPath $AclPath
    $BroaderAcl=Get-Acl -LiteralPath $AclPath
    $Everyone=New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
    $Rule=New-Object Security.AccessControl.FileSystemAccessRule($Everyone,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow)
    [void]$BroaderAcl.AddAccessRule($Rule);Set-Acl -LiteralPath $AclPath -AclObject $BroaderAcl
    try {
      $R=Run-Setup $Install
      Blocked $R 'EXISTING_INSTALLATION_CHANGED'
      $Now=Get-Acl -LiteralPath $AclPath
      Assert-QA (@($Now.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.IdentityReference.Value -ceq 'S-1-1-0'}).Count -gt 0) 'broader ACL preserved rather than reset'
    } finally {Set-Acl -LiteralPath $AclPath -AclObject $BeforeAcl}
    $Passed++
  }

  # The owner invokes downloaded code in memory; it must return to its caller.
  $DriverData=Join-Path $Root 'memory-driver.json'
  [IO.File]::WriteAllText($DriverData,(@{bootstrap=$BootstrapPath;package=$PackageZip;install=$Install;serverKey=$ServerKey}|ConvertTo-Json),$Utf8)
  $Driver=Join-Path $Root 'memory-driver.ps1'
  $DriverText='$d=Get-Content -LiteralPath '''+$DriverData.Replace("'","''")+''' -Raw | ConvertFrom-Json'+[Environment]::NewLine+
    '& ([scriptblock]::Create([IO.File]::ReadAllText($d.bootstrap))) -PackageZip $d.package -InstallDir $d.install -SshHost fixture.invalid -ServerHostKey $d.serverKey'+[Environment]::NewLine+
    '[Console]::WriteLine("OWNER_SETUP_CALLER_STILL_ALIVE")'
  [IO.File]::WriteAllText($Driver,$DriverText,$Utf8)
  $Start=New-Object Diagnostics.ProcessStartInfo
  $Start.FileName=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)) 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $Start.Arguments='-NoProfile -NonInteractive -File "'+$Driver+'"';$Start.UseShellExecute=$false;$Start.RedirectStandardOutput=$true;$Start.RedirectStandardError=$true
  $Child=New-Object Diagnostics.Process;$Child.StartInfo=$Start
  try {
    [void]$Child.Start();$Out=$Child.StandardOutput.ReadToEndAsync();$Err=$Child.StandardError.ReadToEndAsync()
    if(-not $Child.WaitForExit(45000)){$Child.Kill();throw 'MEMORY_SETUP_TEST_TIMEOUT'}
    Assert-QA ($Out.Wait(1000) -and $Err.Wait(1000) -and $Child.ExitCode -eq 0 -and [string]::IsNullOrWhiteSpace($Err.Result)) 'memory execution'
    Assert-QA ($Out.Result.Contains('OWNER_SETUP_CALLER_STILL_ALIVE')) 'memory invocation returns to caller'
  } finally {$Child.Dispose()}
  $Passed++

  # Unknown local receipt fields must never be echoed by a successful rerun.
  $SetupReceipt=Join-Path $Install '.owner-setup-v1.json'
  $ReceiptBefore=[IO.File]::ReadAllText($SetupReceipt)
  $LocalReceipt=$ReceiptBefore | ConvertFrom-Json
  $LocalReceipt | Add-Member -NotePropertyName unexpectedSecret -NotePropertyValue 'DO_NOT_ECHO_LOCAL_RECEIPT_SECRET'
  [IO.File]::WriteAllText($SetupReceipt,($LocalReceipt | ConvertTo-Json -Depth 8),$Utf8)
  $R=Run-Setup $Install
  Assert-QA ($R.exitCode -eq 0 -and $R.value.status -ceq 'PASS') 'consistent installation still accepted'
  Assert-QA (-not $R.raw.Contains('DO_NOT_ECHO_LOCAL_RECEIPT_SECRET') -and @($R.value.PSObject.Properties.Name) -notcontains 'unexpectedSecret') 'untrusted receipt fields not echoed'
  [IO.File]::WriteAllText($SetupReceipt,$ReceiptBefore,$Utf8)
  $Passed++

  $ManifestFile=Join-Path $Install 'com.cocwin.rbridge_chat_v1.json'
  $ManifestBefore=[IO.File]::ReadAllText($ManifestFile)
  $ManifestChanged=($ManifestBefore | ConvertFrom-Json)
  $ManifestChanged.path='C:\untrusted\other.exe'
  [IO.File]::WriteAllText($ManifestFile,($ManifestChanged | ConvertTo-Json),$Utf8)
  $ChangedManifestHash=(Get-FileHash -LiteralPath $ManifestFile).Hash
  $R=Run-Setup $Install
  Blocked $R 'EXISTING_INSTALLATION_CHANGED'
  Assert-QA ((Get-FileHash -LiteralPath $ManifestFile).Hash -ceq $ChangedManifestHash) 'changed manifest preserved'
  [IO.File]::WriteAllText($ManifestFile,$ManifestBefore,$Utf8)
  $Passed++

  $Changed=[IO.File]::ReadAllText($Config)+[Environment]::NewLine
  [IO.File]::WriteAllText($Config,$Changed,$Utf8)
  $ChangedHash=(Get-FileHash -LiteralPath $Config).Hash
  $R=Run-Setup $Install
  Blocked $R 'EXISTING_INSTALLATION_CHANGED'
  Assert-QA ((Get-FileHash -LiteralPath $Config).Hash -ceq $ChangedHash -and (Get-FileHash -LiteralPath $Private).Hash -ceq $PrivateHash) 'changed preimage preserved'
  $Passed++

  Clear-Bindings
  $Foreign=Join-Path $Root 'foreign';[void][IO.Directory]::CreateDirectory($Foreign)
  $Sentinel=Join-Path $Foreign 'owner.txt';[IO.File]::WriteAllText($Sentinel,'preserve',$Utf8)
  $R=Run-Setup $Foreign
  Blocked $R 'EXISTING_INSTALLATION_UNMANAGED'
  Assert-QA ((Get-Content -LiteralPath $Sentinel -Raw) -ceq 'preserve' -and @(Get-ChildItem -LiteralPath $Foreign -Force).Count -eq 1) 'foreign directory preserved'
  $Passed++

  $Target=Join-Path $Root 'junction-target';[void][IO.Directory]::CreateDirectory($Target)
  $Alias=Join-Path $Root 'junction-alias';[void](New-Item -ItemType Junction -Path $Alias -Target $Target)
  try {
    $R=Run-Setup (Join-Path $Alias 'native')
    Blocked $R 'UNTRUSTED_LOCAL_PATH'
    Assert-QA (@(Get-ChildItem -LiteralPath $Target -Force).Count -eq 0) 'reparse destination untouched'
  } finally { [IO.Directory]::Delete($Alias) }
  $Passed++

  $Busy=Join-Path $Root 'busy'
  $Hasher=[Security.Cryptography.SHA256]::Create()
  try { $Digest=-join ($Hasher.ComputeHash($Utf8.GetBytes([IO.Path]::GetFullPath($Busy).ToUpperInvariant())) | ForEach-Object {$_.ToString('x2')}) } finally {$Hasher.Dispose()}
  $Mutex=New-Object Threading.Mutex($false,('Global\COCWIN_RBridge_Install_'+$Digest));$Held=$false
  try {
    $Held=$Mutex.WaitOne(0);Assert-QA $Held 'fixture owns mutex'
    $R=Run-Setup $Busy
    Blocked $R 'RBRIDGE_NATIVE_INSTALL_IN_PROGRESS'
    Assert-QA (-not (Test-Path -LiteralPath $Busy)) 'busy destination untouched'
  } finally {if($Held){$Mutex.ReleaseMutex()};$Mutex.Dispose()}
  $Passed++

  $Invalid=Join-Path $Root 'invalid-host-key';$R=Run-Setup $Invalid $PackageZip 'ssh-ed25519 NOT_A_VALID_PUBLIC_KEY'
  Blocked $R 'SERVER_HOST_KEY_INVALID'
  Assert-QA (-not (Test-Path -LiteralPath $Invalid)) 'invalid pin before destination changes'
  $Passed++

  Clear-Bindings
  $DownloadInstall=Join-Path $Root 'anonymous-default-download'
  $R=Run-Setup $DownloadInstall ''
  Assert-QA ($R.exitCode -eq 0 -and $R.value.state -ceq 'INSTALLED_AWAITING_SERVER_KEY_ENROLLMENT' -and $R.value.packageSha256 -ceq '9afb6a22737f3b2d446684240051477096924e55e4d688b5f2feef70e8ef3350') 'actual default anonymous Windows download'
  $Passed++

  [pscustomobject]@{schema='RBRIDGE_WINDOWS_OWNER_SETUP_QA_V1';state='PASS';passed=$Passed;powerShellMajor=$PSVersionTable.PSVersion.Major;actualOwnerWindows='NOT_RUN';sshAuthenticatedSessions=0;browserSends=0} | ConvertTo-Json -Compress
} finally {
  foreach ($Item in $Saved) {
    if ($Item.hasDefault) {
      $Reg=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($Item.path)
      try {$Reg.SetValue('',$Item.value,$Item.kind)} finally {$Reg.Dispose()}
    } else {
      $Reg=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Item.path,$true)
      $Empty=$false
      if ($null -ne $Reg) {try {$Reg.DeleteValue('',$false);$Empty=(@($Reg.GetValueNames()).Count -eq 0 -and @($Reg.GetSubKeyNames()).Count -eq 0)}finally{$Reg.Dispose()}}
      if (-not $Item.present -and $Empty) {[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($Item.path,$false)}
    }
  }
  if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
}
