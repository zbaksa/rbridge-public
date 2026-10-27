[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$PackageZip)
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
  [pscustomobject]@{schema='RBRIDGE_WINDOWS_STANDARD_USER_SETUP_QA_V1';state='PASS';passed=2;administratorToken=$Elevated;defaultDirectory=$true;actualOwnerWindows='NOT_RUN';sshConnections=0;browserSends=0} | ConvertTo-Json -Compress
  exit 0
} catch {
  $Records=@($Error | Select-Object -First 12 | ForEach-Object {[pscustomobject]@{type=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult;id=$_.FullyQualifiedErrorId;line=$_.InvocationInfo.ScriptLineNumber;message=$_.Exception.Message}})
  [pscustomobject]@{schema='RBRIDGE_WINDOWS_STANDARD_USER_SETUP_QA_V1';state='FAIL';administratorToken=$Elevated;bootstrapOutput=@($Lines);errors=$Records;actualOwnerWindows='NOT_RUN';sshConnections=0;browserSends=0} | ConvertTo-Json -Depth 6 -Compress
  exit 1
}
'@
  [IO.File]::WriteAllText((Join-Path $Root 'driver.ps1'),$Driver,$Utf8)
  $Credential=New-Object Management.Automation.PSCredential(($env:COMPUTERNAME+'\'+$Name),$Password)
  $PowerShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $Child=Start-Process -FilePath $PowerShell -Credential $Credential -LoadUserProfile -WorkingDirectory $Root -ArgumentList ('-NoProfile -NonInteractive -File "'+(Join-Path $Root 'driver.ps1')+'"') -RedirectStandardOutput (Join-Path $Root 'stdout.json') -RedirectStandardError (Join-Path $Root 'stderr.txt') -PassThru
  if (-not $Child.WaitForExit(120000)) {$Child.Kill();throw 'ORDINARY_USER_FIXTURE_TIMEOUT'}
  $Output=[IO.File]::ReadAllText((Join-Path $Root 'stdout.json'))
  $Errors=[IO.File]::ReadAllText((Join-Path $Root 'stderr.txt'))
  Write-Output $Output
  if (-not [string]::IsNullOrWhiteSpace($Errors)) {throw 'ORDINARY_USER_UNEXPECTED_STDERR'}
  if ($Child.ExitCode -ne 0) {throw 'ORDINARY_USER_SETUP_REGRESSION'}
  $Value=$Output | ConvertFrom-Json
  if ($Value.state -cne 'PASS' -or $Value.administratorToken -ne $false -or $Value.passed -ne 2) {throw 'ORDINARY_USER_PROOF_INVALID'}
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
