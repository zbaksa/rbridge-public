$ErrorActionPreference='Stop'
$Owner=[Security.Principal.WindowsIdentity]::GetCurrent()
if ((New-Object Security.Principal.WindowsPrincipal($Owner)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {throw 'ORDINARY_UPGRADE_USER_REQUIRED'}
$Install=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'COCWIN\RBridge\NativeHost'
$Root=$PSScriptRoot;$Updater=Join-Path $Root 'upgrade.ps1';$NewZip=Join-Path $Root 'upgrade-qualified.zip'
if (-not (Test-Path -LiteralPath $Updater)) {throw 'QUALIFIED_NATIVE_UPGRADER_NOT_IMPLEMENTED'}
$Source=[IO.File]::ReadAllText($Updater)
$Exe=Join-Path $Install 'rbridge-native-host.exe';$Config=Join-Path $Install 'rbridge-native-host.config.json';$Setup=Join-Path $Install '.owner-setup-v1.json'
$ConfigSha=(Get-FileHash -LiteralPath $Config -Algorithm SHA256).Hash.ToLowerInvariant()
$OldSha='630ea7b69c12283ac311cbf137adfaf8078f091071697bab355282d080997b95'
$NewSha='c4d9317d84dbd7ac2f0d73df3c939fe2452eb6a78e56a142d17c83876228e5ee'
$Registry='Software\Google\Chrome\NativeMessagingHosts\com.cocwin.rbridge_chat_v1'
$Manifest=Join-Path $Install 'com.cocwin.rbridge_chat_v1.json'
$Sentinel=Join-Path $Install 'events\existing-history.keep'
[IO.File]::WriteAllText($Sentinel,'Retained original history fixture; never replay or reset.')
$Passed=0
function Need-QA([bool]$Ok,[string]$Why) {if (-not $Ok) {throw $Why};$script:Passed++}
function Snapshot {
  $Rows=@(Get-ChildItem -LiteralPath $Install -Recurse -Force -File | Where-Object {$_.FullName -cne $Exe} | Sort-Object FullName | ForEach-Object {
    [pscustomobject]@{path=$_.FullName;sha=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash;sddl=(Get-Acl -LiteralPath $_.FullName).Sddl}
  })
  return ($Rows | ConvertTo-Json -Depth 4 -Compress)
}
function Run-Upgrade([string]$Pin=$ConfigSha,[string]$Directory=$Install,[string]$Zip=$NewZip,[bool]$Race=$false) {
  $Collected=New-Object 'Collections.Generic.List[string]'
  $Arguments=@{ExpectedConfigSha256=$Pin;InstallDir=$Directory;PackageZip=$Zip}
  if ($Race) {
    [void]$Arguments.Remove('PackageZip')
    function Invoke-WebRequest {
      param([switch]$UseBasicParsing,[string]$Uri,[string]$OutFile,[int]$TimeoutSec)
      if (-not $UseBasicParsing -or $Uri -cne 'https://github.com/zbaksa/rbridge-public/releases/download/cocwin-windows-11c6723/rbridge-windows-11c6723.zip' -or $TimeoutSec -ne 180) {throw 'UNEXPECTED_UPGRADE_DOWNLOAD'}
      [IO.File]::Copy($NewZip,$OutFile,$true)
      $Key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Registry,$true)
      try {$Key.SetValue('','C:\foreign-native-host.json',[Microsoft.Win32.RegistryValueKind]::String)} finally {$Key.Dispose()}
    }
  }
  try {& ([scriptblock]::Create($Source)) @Arguments | ForEach-Object {[void]$Collected.Add([string]$_)}}
  catch {if ($_.FullyQualifiedErrorId -cne 'COCWIN_RBRIDGE_OWNER_UPGRADE_BLOCKED') {throw}}
  return (($Collected -join "`n") | ConvertFrom-Json)
}
function Need-Old {if ((Get-FileHash -LiteralPath $Exe -Algorithm SHA256).Hash.ToLowerInvariant() -cne $OldSha) {throw 'UPGRADE_NEGATIVE_CHANGED_EXECUTABLE'}}
$Before=Snapshot
$R=Run-Upgrade ('0'*64)
Need-QA ($R.status -ceq 'BLOCKED' -and -not $R.executablePublicationStarted) 'WRONG_CONFIG_PIN_ACCEPTED';Need-Old
$Saved=Join-Path $Install '.setup-fixture-held'
[IO.File]::Move($Setup,$Saved)
try {$R=Run-Upgrade;Need-QA ($R.status -ceq 'BLOCKED' -and -not $R.executablePublicationStarted) 'UNMANAGED_INSTALLATION_ACCEPTED';Need-Old} finally {[IO.File]::Move($Saved,$Setup)}
$Stream=New-Object IO.FileStream($Exe,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {$Stream.Position=1024;$Byte=$Stream.ReadByte();$Stream.Position=1024;$Stream.WriteByte($Byte -bxor 1)} finally {$Stream.Dispose()}
try {$R=Run-Upgrade;Need-QA ($R.status -ceq 'BLOCKED' -and -not $R.executablePublicationStarted) 'UNKNOWN_EXECUTABLE_ACCEPTED'} finally {
  $Stream=New-Object IO.FileStream($Exe,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try {$Stream.Position=1024;$Stream.WriteByte($Byte)} finally {$Stream.Dispose()}
};Need-Old
$Alias=Join-Path (Split-Path -Parent $Install) 'upgrade-exe-hardlink'
[void](New-Item -ItemType HardLink -Path $Alias -Target $Exe)
try {$R=Run-Upgrade;Need-QA ($R.status -ceq 'BLOCKED' -and -not $R.executablePublicationStarted) 'HARDLINKED_EXECUTABLE_ACCEPTED'} finally {[IO.File]::Delete($Alias)};Need-Old
$Junction=Join-Path (Split-Path -Parent $Install) 'upgrade-junction'
[void](New-Item -ItemType Junction -Path $Junction -Target $Install)
try {$R=Run-Upgrade $ConfigSha $Junction;Need-QA ($R.status -ceq 'BLOCKED' -and -not $R.executablePublicationStarted) 'JUNCTION_INSTALLATION_ACCEPTED'} finally {[IO.Directory]::Delete($Junction,$false)};Need-Old
$Bad=Join-Path ([IO.Path]::GetTempPath()) ('upgrade-bad-'+[guid]::NewGuid().ToString('N')+'.zip')
[IO.File]::Copy($NewZip,$Bad,$false)
$Stream=New-Object IO.FileStream($Bad,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {$Stream.Position=0;$Stream.WriteByte(0)} finally {$Stream.Dispose()}
try {$R=Run-Upgrade $ConfigSha $Install $Bad;Need-QA ($R.status -ceq 'BLOCKED' -and -not $R.executablePublicationStarted) 'CORRUPT_UPGRADE_PACKAGE_ACCEPTED'} finally {[IO.File]::Delete($Bad)};Need-Old
$Held=New-Object IO.FileStream($Exe,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {$R=Run-Upgrade;Need-QA ($R.status -ceq 'BLOCKED' -and $R.state -ceq 'BLOCKED_PRESERVED') 'LOCKED_EXECUTABLE_NOT_PRESERVED';Need-Old} finally {$Held.Dispose()}
try {$R=Run-Upgrade $ConfigSha $Install $NewZip $true;Need-QA ($R.status -ceq 'BLOCKED' -and -not $R.executablePublicationStarted) 'CHANGED_REGISTRATION_DURING_DOWNLOAD_ACCEPTED';Need-Old} finally {
  $Key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Registry,$true)
  try {$Key.SetValue('',$Manifest,[Microsoft.Win32.RegistryValueKind]::String)} finally {$Key.Dispose()}
}
Need-QA ((Snapshot) -ceq $Before) 'NEGATIVE_UPGRADE_CHANGED_PROTECTED_FILES'
$R=Run-Upgrade
Need-QA ($R.status -ceq 'PASS' -and $R.state -ceq 'UPGRADED' -and $R.executableSha256 -ceq $NewSha -and $R.v3Configured -eq $false -and $R.browserSends -eq 0) 'QUALIFIED_UPGRADE_DID_NOT_SUCCEED'
Need-QA ((Snapshot) -ceq $Before -and (Get-FileHash -LiteralPath $Exe -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $NewSha) 'UPGRADE_CHANGED_KEY_CONFIG_HISTORY_OR_ACL'
$R=Run-Upgrade $ConfigSha $Install 'C:\qualified-upgrade-must-not-download.zip'
Need-QA ($R.status -ceq 'PASS' -and $R.state -ceq 'ALREADY_QUALIFIED' -and -not $R.executablePublicationStarted -and (Snapshot) -ceq $Before) 'UPGRADE_RERUN_NOT_IDEMPOTENT'
[pscustomobject]@{schema='RBRIDGE_WINDOWS_ORDINARY_USER_UPGRADE_QA_V1';state='PASS';passed=$Passed;administratorToken=$false;actualOwnerWindows='NOT_RUN';sshConnections=0;browserSends=0}
