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
function Acl-QA([string]$Sddl) {
  $Raw=New-Object Security.AccessControl.RawSecurityDescriptor($Sddl)
  $Raw.SetFlags([Security.AccessControl.ControlFlags]([int]$Raw.ControlFlags -band (-bnot [int][Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited)))
  return $Raw.GetSddlForm([Security.AccessControl.AccessControlSections]::All)
}
function Run-Upgrade([string]$Pin=$ConfigSha,[string]$Directory=$Install,[string]$Zip=$NewZip,[bool]$Race=$false,[bool]$DownloadAlias=$false,[string]$Fault='') {
  $Collected=New-Object 'Collections.Generic.List[string]'
  $Arguments=@{ExpectedConfigSha256=$Pin;InstallDir=$Directory;PackageZip=$Zip}
  $script:FaultTriggered=$false;$script:CandidateSwapBlocked=$false;$script:TargetSwapBlocked=$false;$script:ParentSwapBlocked=$false
  if ($Fault -ne '') {
    function Get-Acl {
      param([string]$LiteralPath)
      if ($Fault -eq 'LOCKS' -and $Phase -eq 'READONLY_CANDIDATE_CHECK' -and $LiteralPath -ceq $NewExe) {
        try {[IO.File]::Move($LiteralPath,($LiteralPath+'.foreign-move'))} catch [IO.IOException] {$script:CandidateSwapBlocked=$true}
        try {[IO.Directory]::Move($Stage,($Stage+'.foreign-move'))} catch [IO.IOException] {$script:ParentSwapBlocked=$true}
      }
      if ($Fault -eq 'LOCKS' -and $Phase -eq 'EXECUTABLE_PUBLICATION' -and $LiteralPath -ceq $Exe) {
        try {[IO.File]::Move($LiteralPath,($LiteralPath+'.foreign-move'))} catch [IO.IOException] {$script:TargetSwapBlocked=$true}
      }
      if (-not $script:FaultTriggered -and $Fault -eq 'SLOT_COLLISION' -and $Phase -eq 'ORIGINAL_BACKED_UP') {
        $script:FaultTriggered=$true;[IO.File]::WriteAllText($Exe,'foreign target appeared between no-overwrite renames')
      }
      if (-not $script:FaultTriggered -and $Fault -in @('ROLLBACK','ROLLBACK_COLLISION') -and $Phase -eq 'INSTALLED_READBACK' -and $LiteralPath -ceq $Exe) {
        $script:FaultTriggered=$true
        if ($Fault -eq 'ROLLBACK_COLLISION') {[IO.File]::WriteAllText((Join-Path $Stage 'rejected.exe'),'foreign recovery destination')}
        throw 'INJECTED_READBACK_FAILURE'
      }
      return Microsoft.PowerShell.Security\Get-Acl -LiteralPath $LiteralPath
    }
  }
  if ($Race -or $DownloadAlias -or $Fault -eq 'FOREIGN_STAGE') {
    [void]$Arguments.Remove('PackageZip')
    function Invoke-WebRequest {
      param([switch]$UseBasicParsing,[string]$Uri,[string]$OutFile,[int]$TimeoutSec)
      if (-not $UseBasicParsing -or $Uri -cne 'https://github.com/zbaksa/rbridge-public/releases/download/cocwin-windows-11c6723/rbridge-windows-11c6723.zip' -or $TimeoutSec -ne 180) {throw 'UNEXPECTED_UPGRADE_DOWNLOAD'}
      if ($DownloadAlias) {
        if ($OutFile -ne '') {
          $script:AliasStage=Split-Path -Parent $OutFile
          [IO.File]::Delete($OutFile)
          [void](New-Item -ItemType HardLink -Path $OutFile -Target (Join-Path $Install 'keys\owner_ed25519'))
          $Input=New-Object IO.FileStream($NewZip,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
          $Output=New-Object IO.FileStream($OutFile,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
          try {$Input.CopyTo($Output)} finally {$Input.Dispose();$Output.Dispose()}
          return
        }
        return [pscustomobject]@{RawContentStream=(New-Object IO.MemoryStream(,[IO.File]::ReadAllBytes($NewZip)))}
      }
      if ($Fault -eq 'FOREIGN_STAGE') {
        [IO.File]::WriteAllText((Join-Path $Stage 'rejected.exe'),'foreign stage file must survive cleanup')
        return [pscustomobject]@{RawContentStream=(New-Object IO.MemoryStream(,[IO.File]::ReadAllBytes($NewZip)))}
      }
      if ($OutFile -ne '') {[IO.File]::Copy($NewZip,$OutFile,$true)}
      $Key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Registry,$true)
      try {$Key.SetValue('','C:\foreign-native-host.json',[Microsoft.Win32.RegistryValueKind]::String)} finally {$Key.Dispose()}
      if ($OutFile -eq '') {return [pscustomobject]@{RawContentStream=(New-Object IO.MemoryStream(,[IO.File]::ReadAllBytes($NewZip)))}}
    }
  }
  try {& ([scriptblock]::Create($Source)) @Arguments | ForEach-Object {[void]$Collected.Add([string]$_)}}
  catch {if ($_.FullyQualifiedErrorId -cne 'COCWIN_RBRIDGE_OWNER_UPGRADE_BLOCKED') {throw}}
  return (($Collected -join "`n") | ConvertFrom-Json)
}
function Need-Old {if ((Get-FileHash -LiteralPath $Exe -Algorithm SHA256).Hash.ToLowerInvariant() -cne $OldSha) {throw 'UPGRADE_NEGATIVE_CHANGED_EXECUTABLE'}}
function Restore-OldFixture {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $OldZip=[IO.Compression.ZipFile]::OpenRead((Join-Path $Root 'qualified.zip'))
  try {$In=$OldZip.GetEntry('dist-native-host/rbridge-native-host.exe').Open();$Out=[IO.File]::Open($Exe,[IO.FileMode]::Create,[IO.FileAccess]::Write);try {$In.CopyTo($Out)} finally {$In.Dispose();$Out.Dispose()}} finally {$OldZip.Dispose()}
}
function Restore-RetainedFixture([string]$Evidence) {
  $Backup=Join-Path $Evidence 'original.exe'
  Need-QA ((Get-FileHash -LiteralPath $Backup -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $OldSha) 'ORIGINAL_BACKUP_NOT_RETAINED'
  [IO.File]::Delete($Exe);[IO.File]::Move($Backup,$Exe)
  foreach ($Name in @('qualified.exe','rejected.exe')) {if (Test-Path -LiteralPath (Join-Path $Evidence $Name)) {[IO.File]::Delete((Join-Path $Evidence $Name))}}
  [IO.Directory]::Delete($Evidence,$false)
}
$Before=Snapshot;$ExeAcl=Acl-QA (Get-Acl -LiteralPath $Exe).Sddl
$Private=Join-Path $Install 'keys\owner_ed25519';$PrivateBytes=[IO.File]::ReadAllBytes($Private);$AliasChanged=$false
try {
  $R=Run-Upgrade $ConfigSha $Install $NewZip $false $true
  $AliasChanged=(Get-FileHash -LiteralPath $Private -Algorithm SHA256).Hash -cne (Get-FileHash -InputStream (New-Object IO.MemoryStream(,$PrivateBytes)) -Algorithm SHA256).Hash
  if ($AliasChanged) {Write-Host 'DOWNLOAD_OUTPUT_SUBSTITUTION_PRIVATE_KEY_CHANGED=TRUE'}
} finally {
  [IO.File]::WriteAllBytes($Private,$PrivateBytes)
  if ($script:AliasStage -and (Test-Path -LiteralPath $script:AliasStage)) {
    [IO.File]::Delete((Join-Path $script:AliasStage 'qualified.zip'))
    [IO.Directory]::Delete($script:AliasStage,$false)
  }
}
# A safe in-memory download also performs the legitimate upgrade; reconstruct
# only this disposable fixture's old executable before the remaining cases.
if ((Get-FileHash -LiteralPath $Exe -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $NewSha) {
  Restore-OldFixture
}
$R=Run-Upgrade ('0'*64)
Need-QA ($R.status -ceq 'BLOCKED' -and -not $R.executablePublicationStarted) 'WRONG_CONFIG_PIN_ACCEPTED';Need-Old
$ConfigBytes=[IO.File]::ReadAllBytes($Config);$ReceiptBytes=[IO.File]::ReadAllBytes($Setup)
try {
  $V3Config=[IO.File]::ReadAllText($Config) | ConvertFrom-Json
  $V3Config | Add-Member -NotePropertyName v3 -NotePropertyValue @{}
  [IO.File]::WriteAllText($Config,($V3Config | ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
  $V3Sha=(Get-FileHash -LiteralPath $Config -Algorithm SHA256).Hash.ToLowerInvariant()
  $V3Receipt=[IO.File]::ReadAllText($Setup) | ConvertFrom-Json;$V3Receipt.configSha256=$V3Sha
  [IO.File]::WriteAllText($Setup,($V3Receipt | ConvertTo-Json -Depth 8 -Compress),(New-Object Text.UTF8Encoding($false)))
  $R=Run-Upgrade $V3Sha
  Need-QA ($R.status -ceq 'BLOCKED' -and $R.reason -ceq 'LEGACY_CONFIG_REQUIRED' -and -not $R.executablePublicationStarted) 'EXISTING_V3_CONFIG_ACCEPTED';Need-Old
} finally {[IO.File]::WriteAllBytes($Config,$ConfigBytes);[IO.File]::WriteAllBytes($Setup,$ReceiptBytes)}
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
$R=Run-Upgrade $ConfigSha $Install $NewZip $false $false 'ROLLBACK'
Need-QA ($script:FaultTriggered -and $R.status -ceq 'BLOCKED' -and $R.state -ceq 'ROLLED_BACK' -and (Snapshot) -ceq $Before) 'SUCCESSFUL_PUBLICATION_ROLLBACK_NOT_PROVEN';Need-Old
$R=Run-Upgrade $ConfigSha $Install $NewZip $false $false 'ROLLBACK_COLLISION'
Need-QA ($script:FaultTriggered -and $R.status -ceq 'BLOCKED' -and $R.state -ceq 'UNCERTAIN' -and (Get-FileHash -LiteralPath $Exe -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $NewSha -and (Get-Content -LiteralPath (Join-Path $R.evidenceStage 'rejected.exe') -Raw) -ceq 'foreign recovery destination') 'UNSAFE_ROLLBACK_DID_NOT_RETAIN_EVIDENCE'
Restore-RetainedFixture $R.evidenceStage;Need-Old
$R=Run-Upgrade $ConfigSha $Install $NewZip $false $false 'SLOT_COLLISION'
Need-QA ($script:FaultTriggered -and $R.status -ceq 'BLOCKED' -and $R.state -ceq 'UNCERTAIN' -and (Get-Content -LiteralPath $Exe -Raw) -ceq 'foreign target appeared between no-overwrite renames') 'FOREIGN_TARGET_WAS_OVERWRITTEN'
Restore-RetainedFixture $R.evidenceStage;Need-Old
$R=Run-Upgrade $ConfigSha $Install $NewZip $false $false 'FOREIGN_STAGE'
Need-QA ($R.status -ceq 'PASS' -and $R.state -ceq 'UPGRADED' -and $R.stageCleanup -ceq 'PRESERVED' -and (Get-Content -LiteralPath (Join-Path $R.evidenceStage 'rejected.exe') -Raw) -ceq 'foreign stage file must survive cleanup') 'FOREIGN_STAGE_CONTENT_WAS_DELETED'
[IO.File]::Delete((Join-Path $R.evidenceStage 'rejected.exe'));[IO.Directory]::Delete($R.evidenceStage,$false);Restore-OldFixture;Need-Old
$R=Run-Upgrade $ConfigSha $Install $NewZip $false $false 'LOCKS'
if ($R.status -cne 'PASS') {throw ('QUALIFIED_UPGRADE_DID_NOT_SUCCEED receipt='+($R | ConvertTo-Json -Compress)+' expectedAcl='+$ExeAcl+' actualAcl='+(Get-Acl -LiteralPath $Exe).Sddl+' downloadAliasChanged='+$AliasChanged)}
Need-QA ($R.status -ceq 'PASS' -and $R.state -ceq 'UPGRADED' -and $R.executableSha256 -ceq $NewSha -and $R.v3Configured -eq $false -and $R.browserSends -eq 0) 'QUALIFIED_UPGRADE_DID_NOT_SUCCEED'
Need-QA ($script:CandidateSwapBlocked -and $script:TargetSwapBlocked -and $script:ParentSwapBlocked) 'CANDIDATE_TARGET_OR_PARENT_SUBSTITUTION_NOT_BLOCKED'
Need-QA ((Snapshot) -ceq $Before -and (Get-FileHash -LiteralPath $Exe -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $NewSha -and (Acl-QA (Get-Acl -LiteralPath $Exe).Sddl) -ceq $ExeAcl) 'UPGRADE_CHANGED_KEY_CONFIG_HISTORY_OR_ACL'
$R=Run-Upgrade $ConfigSha $Install 'C:\qualified-upgrade-must-not-download.zip'
Need-QA ($R.status -ceq 'PASS' -and $R.state -ceq 'ALREADY_QUALIFIED' -and -not $R.executablePublicationStarted -and (Snapshot) -ceq $Before) 'UPGRADE_RERUN_NOT_IDEMPOTENT'
Need-QA (-not $AliasChanged) 'DOWNLOAD_OUTPUT_SUBSTITUTION_CHANGED_PRIVATE_KEY'
foreach ($Case in @(@{pin=$ConfigSha;code=0;status='PASS'},@{pin=('0'*64);code=2;status='BLOCKED'})) {
  $Start=New-Object Diagnostics.ProcessStartInfo
  $Start.FileName=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $Start.Arguments='-NoProfile -NonInteractive -File "'+$Updater+'" -ExpectedConfigSha256 '+$Case.pin
  $Start.UseShellExecute=$false;$Start.CreateNoWindow=$true;$Start.RedirectStandardInput=$true;$Start.RedirectStandardOutput=$true;$Start.RedirectStandardError=$true
  $Child=New-Object Diagnostics.Process;$Child.StartInfo=$Start
  try {
    [void]$Child.Start();$Child.StandardInput.Close();$Out=$Child.StandardOutput.ReadToEndAsync();$Err=$Child.StandardError.ReadToEndAsync()
    Need-QA ($Child.WaitForExit(30000) -and $Out.Wait(1000) -and $Err.Wait(1000)) 'UPGRADER_FILE_MODE_TIMEOUT'
    $Value=$Out.Result | ConvertFrom-Json
    Need-QA ($Child.ExitCode -eq $Case.code -and $Value.status -ceq $Case.status -and [string]::IsNullOrWhiteSpace($Err.Result) -and (Snapshot) -ceq $Before) 'UPGRADER_FILE_MODE_EXIT_OR_PRESERVATION_FAILED'
  } finally {if (-not $Child.HasExited) {$Child.Kill()};$Child.Dispose()}
}
[pscustomobject]@{schema='RBRIDGE_WINDOWS_ORDINARY_USER_UPGRADE_QA_V1';state='PASS';passed=$Passed;administratorToken=$false;actualOwnerWindows='NOT_RUN';sshConnections=0;browserSends=0}
