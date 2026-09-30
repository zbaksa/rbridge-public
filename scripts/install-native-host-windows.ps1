[CmdletBinding()]
param(
  [string]$SourceExe = "",
  [string]$InstallDir = "",
  [string]$SshHost = "aether-engine",
  [int]$SshPort = 22,
  [string]$IdentityFile = "",
  [string]$KnownHostsFile = "",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$HostName = "com.cocwin.rbridge_chat_v1"
$ExtensionId = "ebibbijpegoankenmggdnehpoadcophk"

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  $InstallDir = Join-Path $env:LOCALAPPDATA "COCWIN\RBridge\NativeHost"
}
$ChromeKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
$EdgeKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"

if ($Uninstall) {
  foreach ($key in @($ChromeKey,$EdgeKey)) {
    if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force }
  }
  if (Test-Path $InstallDir) { Remove-Item -Path $InstallDir -Recurse -Force }
  [pscustomobject]@{schema="RBRIDGE_NATIVE_HOST_WINDOWS_UNINSTALL_V1";status="PASS";installDir=$InstallDir} | ConvertTo-Json -Compress
  exit 0
}

if ([string]::IsNullOrWhiteSpace($SourceExe)) { $SourceExe = Join-Path $PSScriptRoot "rbridge-native-host.exe" }
if ([string]::IsNullOrWhiteSpace($IdentityFile)) { $IdentityFile = Join-Path $env:USERPROFILE ".ssh\rbridge_ed25519" }
if ([string]::IsNullOrWhiteSpace($KnownHostsFile)) { $KnownHostsFile = Join-Path $env:USERPROFILE ".ssh\known_hosts" }
if ($SshHost -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' -or $SshHost.StartsWith("-")) { throw "RBRIDGE_SSH_HOST_INVALID" }
if ($SshPort -lt 1 -or $SshPort -gt 65535) { throw "RBRIDGE_SSH_PORT_INVALID" }
if (-not (Test-Path -LiteralPath $SourceExe -PathType Leaf)) { throw "RBRIDGE_NATIVE_HOST_EXE_NOT_FOUND" }
if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) { throw "RBRIDGE_SSH_IDENTITY_NOT_FOUND" }
if (-not (Test-Path -LiteralPath $KnownHostsFile -PathType Leaf)) { throw "RBRIDGE_SSH_KNOWN_HOSTS_NOT_FOUND" }

$Ssh = Get-Command ssh.exe -ErrorAction Stop
$SshPath = $Ssh.Source
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$EventStoreRoot = Join-Path $InstallDir "events"
New-Item -ItemType Directory -Path $EventStoreRoot -Force | Out-Null

$ExePath = Join-Path $InstallDir "rbridge-native-host.exe"
Copy-Item -LiteralPath $SourceExe -Destination $ExePath -Force
$ConfigPath = Join-Path $InstallDir "rbridge-native-host.config.json"
$ManifestPath = Join-Path $InstallDir "$HostName.json"

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
$Manifest = [ordered]@{
  name = $HostName
  description = "COCWIN RBridge Chat Native Host V1"
  path = $ExePath
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ConfigPath,($Config | ConvertTo-Json -Depth 8),$Utf8NoBom)
[System.IO.File]::WriteAllText($ManifestPath,($Manifest | ConvertTo-Json -Depth 8),$Utf8NoBom)

foreach ($key in @($ChromeKey,$EdgeKey)) {
  New-Item -Path $key -Force | Out-Null
  Set-Item -Path $key -Value $ManifestPath
}
foreach ($key in @($ChromeKey,$EdgeKey)) {
  if ((Get-Item -Path $key).GetValue("") -ne $ManifestPath) { throw "RBRIDGE_NATIVE_HOST_REGISTRY_VERIFY_FAILED" }
}

[pscustomobject]@{
  schema = "RBRIDGE_NATIVE_HOST_WINDOWS_INSTALL_V1"
  status = "PASS"
  extensionId = $ExtensionId
  executable = $ExePath
  config = $ConfigPath
  manifest = $ManifestPath
  chromeRegistry = $ChromeKey
  edgeRegistry = $EdgeKey
} | ConvertTo-Json -Compress
