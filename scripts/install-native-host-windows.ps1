[CmdletBinding()]
param(
  [string]$SourceExe = "",
  [string]$InstallDir = "",
  [string]$SshHost = "aether-engine",
  [int]$SshPort = 22,
  [string]$IdentityFile = "",
  [string]$KnownHostsFile = "",
  [string]$V3ConfigFile = "",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$HostName = "com.cocwin.rbridge_chat_v1"
$ExtensionId = "ebibbijpegoankenmggdnehpoadcophk"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
if ([string]::IsNullOrWhiteSpace($InstallDir)) { $InstallDir = Join-Path $env:LOCALAPPDATA "COCWIN\RBridge\NativeHost" }
$ChromeKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$EdgeKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"


function Hash-ConfigBytes([byte[]]$Bytes) {
  $Hasher = [Security.Cryptography.SHA256]::Create()
  try { return -join ($Hasher.ComputeHash($Bytes) | ForEach-Object { $_.ToString("x2") }) }
  finally { $Hasher.Dispose() }
}
function Read-ConfigBytes([string]$Path) {
  $Info = Get-Item -LiteralPath $Path -Force
  if ($Info.PSIsContainer -or ($Info.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $Info.Length -lt 2 -or $Info.Length -gt 65536) { throw "RBRIDGE_INSTALL_CONFIG_FILE_INVALID" }
  [byte[]]$Bytes = [IO.File]::ReadAllBytes($Info.FullName)
  if ($Bytes.Length -ne $Info.Length) { throw "RBRIDGE_INSTALL_CONFIG_CHANGED" }
  return ,$Bytes
}
function Check-V3ConfigBytes([byte[]]$Bytes) {
  $Stage = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) ("rbridge-config-check-"+[Guid]::NewGuid().ToString("N")+".json")
  $Process = $null
  try {
    $Stream = New-Object IO.FileStream($Stage,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $Stream.Write($Bytes,0,$Bytes.Length) } finally { $Stream.Dispose() }
    $Start = New-Object Diagnostics.ProcessStartInfo
    $Start.FileName = $SourceExe
    $Start.Arguments = '--check-config "'+$Stage+'"'
    $Start.UseShellExecute = $false
    $Start.CreateNoWindow = $true
    $Start.RedirectStandardOutput = $true
    $Start.RedirectStandardError = $true
    $Start.StandardOutputEncoding = $Utf8NoBom
    $Start.StandardErrorEncoding = $Utf8NoBom
    $Process = New-Object Diagnostics.Process
    $Process.StartInfo = $Start
    [void]$Process.Start()
    $OutputTask = $Process.StandardOutput.ReadToEndAsync()
    $ErrorTask = $Process.StandardError.ReadToEndAsync()
    if (-not $Process.WaitForExit(10000)) { $Process.Kill(); throw "RBRIDGE_INSTALL_CONFIG_CHECK_TIMEOUT" }
    if (-not $OutputTask.Wait(1000) -or -not $ErrorTask.Wait(1000)) { throw "RBRIDGE_INSTALL_CONFIG_CHECK_IO_TIMEOUT" }
    if ($Process.ExitCode -ne 0) { throw "RBRIDGE_INSTALL_CONFIG_REJECTED" }
    $OutputText = $OutputTask.Result
    if ($OutputText.Length -gt 16384) { throw "RBRIDGE_INSTALL_CONFIG_CHECK_RECEIPT_INVALID" }
    if (-not $OutputText.Trim().StartsWith('{') -or -not $OutputText.Trim().EndsWith('}')) { throw "RBRIDGE_INSTALL_CONFIG_CHECK_RECEIPT_INVALID" }
    $Receipt = $OutputText | ConvertFrom-Json
    if ($Receipt -isnot [pscustomobject]) { throw "RBRIDGE_INSTALL_CONFIG_CHECK_RECEIPT_INVALID" }
    $ReceiptKeys = @('schema','status','sourceSha256','expectedExtensionId','eventStoreRoot','v3Configured','activated')
    if (@($Receipt.PSObject.Properties).Count -ne $ReceiptKeys.Count -or @($Receipt.PSObject.Properties.Name | Where-Object { $_ -notin $ReceiptKeys }).Count -gt 0) { throw "RBRIDGE_INSTALL_CONFIG_CHECK_RECEIPT_INVALID" }
    foreach ($Field in @('schema','status','sourceSha256','expectedExtensionId','eventStoreRoot')) { if ($Receipt.$Field -isnot [string]) { throw "RBRIDGE_INSTALL_CONFIG_CHECK_RECEIPT_INVALID" } }
    if ($Receipt.v3Configured -isnot [bool] -or $Receipt.activated -isnot [bool] -or $Receipt.sourceSha256 -cnotmatch '^[a-f0-9]{64}$') { throw "RBRIDGE_INSTALL_CONFIG_CHECK_RECEIPT_INVALID" }
    if ($Receipt.schema -ne "RBRIDGE_NATIVE_CONFIG_CHECK_V1" -or $Receipt.status -ne "PASS" -or $Receipt.activated -ne $false -or $Receipt.v3Configured -ne $true -or $Receipt.expectedExtensionId -ne $ExtensionId -or $Receipt.sourceSha256 -ne (Hash-ConfigBytes $Bytes)) { throw "RBRIDGE_INSTALL_CONFIG_CHECK_RECEIPT_INVALID" }
    return $Receipt
  } finally {
    if ($null -ne $Process) { $Process.Dispose() }
    if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Force }
  }
}

$MutexName = "Global\COCWIN_RBridge_Install_"+(Hash-ConfigBytes ($Utf8NoBom.GetBytes([IO.Path]::GetFullPath($InstallDir).ToUpperInvariant())))
$InstallMutex = New-Object Threading.Mutex($false,$MutexName)
$MutexHeld = $false
$ConfigLock = $null
try {
  try { $MutexHeld = $InstallMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $MutexHeld = $true }
  if (-not $MutexHeld) { throw "RBRIDGE_NATIVE_INSTALL_IN_PROGRESS" }
if ($Uninstall) {
  foreach ($key in @($ChromeKey,$EdgeKey)) { if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force } }
  if (Test-Path $InstallDir) { Remove-Item -Path $InstallDir -Recurse -Force }
  [pscustomobject]@{schema="RBRIDGE_NATIVE_HOST_WINDOWS_UNINSTALL_V1";status="PASS";installDir=$InstallDir} | ConvertTo-Json -Compress
  exit 0
}

if ([string]::IsNullOrWhiteSpace($SourceExe)) { $SourceExe = Join-Path $PSScriptRoot "rbridge-native-host.exe" }
if (-not (Test-Path -LiteralPath $SourceExe -PathType Leaf)) { throw "RBRIDGE_NATIVE_HOST_EXE_NOT_FOUND" }
$SourceExe = (Resolve-Path -LiteralPath $SourceExe).Path
$ExePath = Join-Path $InstallDir "rbridge-native-host.exe"
$ConfigPath = Join-Path $InstallDir "rbridge-native-host.config.json"
$ManifestPath = Join-Path $InstallDir "$HostName.json"
$EventStoreRoot = Join-Path $InstallDir "events"
$ExistingBytes = $null
$ExistingHash = $null
$ExistingV3 = $false
if (Test-Path -LiteralPath $ConfigPath) {
  $ExistingBytes = Read-ConfigBytes $ConfigPath
  $ExistingHash = Hash-ConfigBytes $ExistingBytes
  $Existing = $Utf8NoBom.GetString($ExistingBytes) | ConvertFrom-Json
  if ($Existing.schema -ne "RBRIDGE_NATIVE_HOST_CONFIG_V1") { throw "RBRIDGE_EXISTING_CONFIG_INVALID" }
  $ExistingV3 = @($Existing.PSObject.Properties.Name) -contains "v3"
}
$SuppliedBytes = $null
if (-not [string]::IsNullOrWhiteSpace($V3ConfigFile)) { $SuppliedBytes = Read-ConfigBytes $V3ConfigFile }
$UseV3 = $ExistingV3 -or $null -ne $SuppliedBytes
$PreserveV3 = $ExistingV3
if ($ExistingV3 -and $null -ne $SuppliedBytes -and (Hash-ConfigBytes $SuppliedBytes) -ne $ExistingHash) { throw "RBRIDGE_V3_CONFIG_MIGRATION_REQUIRED" }

if ($UseV3) {
  $ConfigBytes = if ($ExistingV3) { $ExistingBytes } else { $SuppliedBytes }
  $Checked = Check-V3ConfigBytes $ConfigBytes
  $Config = $Utf8NoBom.GetString($ConfigBytes) | ConvertFrom-Json
  if (-not $PreserveV3 -and -not [string]::Equals([IO.Path]::GetFullPath($Checked.eventStoreRoot),[IO.Path]::GetFullPath($EventStoreRoot),[StringComparison]::OrdinalIgnoreCase)) { throw "RBRIDGE_V3_EVENT_ROOT_MISMATCH" }
  $EventStoreRoot = [string]$Checked.eventStoreRoot
  if ($PreserveV3 -and (-not (Test-Path -LiteralPath $EventStoreRoot -PathType Container) -or ((Get-Item -LiteralPath $EventStoreRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint))) { throw "RBRIDGE_V3_EXISTING_EVENT_ROOT_INVALID" }
  $SshPath = [string]$Config.ssh.sshPath
  $IdentityFile = [string]$Config.ssh.identityFile
  $KnownHostsFile = [string]$Config.ssh.knownHostsFile
  if (-not (Test-Path -LiteralPath $SshPath -PathType Leaf)) { throw "RBRIDGE_SSH_EXECUTABLE_NOT_FOUND" }
} else {
  if ([string]::IsNullOrWhiteSpace($IdentityFile)) { $IdentityFile = Join-Path $env:USERPROFILE ".ssh\rbridge_ed25519" }
  if ([string]::IsNullOrWhiteSpace($KnownHostsFile)) { $KnownHostsFile = Join-Path $env:USERPROFILE ".ssh\known_hosts" }
  if ($SshHost -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' -or $SshHost.StartsWith("-")) { throw "RBRIDGE_SSH_HOST_INVALID" }
  if ($SshPort -lt 1 -or $SshPort -gt 65535) { throw "RBRIDGE_SSH_PORT_INVALID" }
  $SshPath = (Get-Command ssh.exe -ErrorAction Stop).Source
}
if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) { throw "RBRIDGE_SSH_IDENTITY_NOT_FOUND" }
if (-not (Test-Path -LiteralPath $KnownHostsFile -PathType Leaf)) { throw "RBRIDGE_SSH_KNOWN_HOSTS_NOT_FOUND" }
if (-not $UseV3) {
  $Config = [ordered]@{
    schema = "RBRIDGE_NATIVE_HOST_CONFIG_V1"
    expectedExtensionId = $ExtensionId
    eventStoreRoot = $EventStoreRoot
    ssh = [ordered]@{
      sshPath = $SshPath
      host = $SshHost
      port = $SshPort
      user = "rbridge"
      identityFile = (Resolve-Path -LiteralPath $IdentityFile).Path
      knownHostsFile = (Resolve-Path -LiteralPath $KnownHostsFile).Path
    }
  }
  $ConfigBytes = $Utf8NoBom.GetBytes(($Config | ConvertTo-Json -Depth 8))
}
# Refuse a concurrent replacement before changing the installation or registry.
if ($null -ne $ExistingHash) {
  if ((Hash-ConfigBytes (Read-ConfigBytes $ConfigPath)) -ne $ExistingHash) { throw "RBRIDGE_INSTALL_CONFIG_CHANGED" }
} elseif (Test-Path -LiteralPath $ConfigPath) { throw "RBRIDGE_INSTALL_CONFIG_APPEARED" }

# Hold the checked existing file through publication; ordinary writers cannot replace it.
if ($null -ne $ExistingHash) {
  $Access = if ($PreserveV3) { [IO.FileAccess]::Read } else { [IO.FileAccess]::ReadWrite }
  $ConfigLock = New-Object IO.FileStream($ConfigPath,[IO.FileMode]::Open,$Access,[IO.FileShare]::None)
  if ($ConfigLock.Length -lt 2 -or $ConfigLock.Length -gt 65536) { throw "RBRIDGE_INSTALL_CONFIG_CHANGED" }
  $Locked = New-Object IO.MemoryStream
  try { $ConfigLock.CopyTo($Locked); $LockedBytes = $Locked.ToArray() } finally { $Locked.Dispose() }
  if ((Hash-ConfigBytes $LockedBytes) -ne $ExistingHash) { throw "RBRIDGE_INSTALL_CONFIG_CHANGED" }
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
if (-not $PreserveV3) { New-Item -ItemType Directory -Path $EventStoreRoot -Force | Out-Null }
Copy-Item -LiteralPath $SourceExe -Destination $ExePath -Force
if (-not $PreserveV3) {
  if ($null -eq $ConfigLock) { $ConfigLock = New-Object IO.FileStream($ConfigPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
  $ConfigLock.Position = 0
  $ConfigLock.SetLength(0)
  $ConfigLock.Write($ConfigBytes,0,$ConfigBytes.Length)
  $ConfigLock.Flush($true)
}
$ConfigLock.Position = 0
$Readback = New-Object IO.MemoryStream
try { $ConfigLock.CopyTo($Readback); $ReadbackBytes = $Readback.ToArray() } finally { $Readback.Dispose() }
if ((Hash-ConfigBytes $ReadbackBytes) -ne (Hash-ConfigBytes $ConfigBytes)) { throw "RBRIDGE_INSTALL_CONFIG_READBACK_FAILED" }
$Manifest = [ordered]@{
  name = $HostName
  description = "COCWIN RBridge Chat Native Host V1"
  path = $ExePath
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
[IO.File]::WriteAllText($ManifestPath,($Manifest | ConvertTo-Json -Depth 8),$Utf8NoBom)
foreach ($key in @($ChromeKey,$EdgeKey)) {
  $NativeKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($key.Substring(6))
  try { $NativeKey.SetValue('',$ManifestPath,[Microsoft.Win32.RegistryValueKind]::String) } finally { $NativeKey.Dispose() }
}
foreach ($key in @($ChromeKey,$EdgeKey)) { if ((Get-Item -Path $key).GetValue("") -ne $ManifestPath) { throw "RBRIDGE_NATIVE_HOST_REGISTRY_VERIFY_FAILED" } }

[pscustomobject]@{
  schema = "RBRIDGE_NATIVE_HOST_WINDOWS_INSTALL_V1"
  status = "PASS"
  extensionId = $ExtensionId
  executable = $ExePath
  config = $ConfigPath
  manifest = $ManifestPath
  chromeRegistry = $ChromeKey
  edgeRegistry = $EdgeKey
  v3Configured = [bool]$UseV3
  v3Preserved = [bool]$PreserveV3
  configSha256 = (Hash-ConfigBytes $ConfigBytes)
  nativeConnectivity = "NOT_RUN"
} | ConvertTo-Json -Compress
} finally {
  if ($null -ne $ConfigLock) { $ConfigLock.Dispose() }
  if ($MutexHeld) { $InstallMutex.ReleaseMutex() }
  $InstallMutex.Dispose()
}
