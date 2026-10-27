[CmdletBinding()]
param([string]$CollectorPath = '')
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($CollectorPath)) { $CollectorPath = Join-Path $PSScriptRoot 'collect-native-owner-facts-windows.ps1' }
if (-not (Test-Path -LiteralPath $CollectorPath -PathType Leaf)) { throw 'COLLECTOR_IMPLEMENTATION_ABSENT' }
$Root = Join-Path ([IO.Path]::GetTempPath()) ('rbridge-owner-facts-test-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($Root)
$Utf8 = New-Object Text.UTF8Encoding($false)
$Passed = 0
function Assert-True([bool]$Value,[string]$Name) { if (-not $Value) { throw ('OWNER_FACTS_TEST_FAILED:'+ $Name) } }
function Save([string]$Path,[string]$Text) {
  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))
  [IO.File]::WriteAllText($Path,$Text,$Utf8)
}
function Collect([string]$Install,[string]$Profile,[string]$RunCollector=$CollectorPath) {
  $Start = New-Object Diagnostics.ProcessStartInfo
  $Start.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $Start.Arguments = '-NoProfile -NonInteractive -File "'+$RunCollector+'" -InstallDir "'+$Install+'"'
  $Start.UseShellExecute = $false
  $Start.RedirectStandardOutput = $true
  $Start.RedirectStandardError = $true
  $Start.EnvironmentVariables['USERPROFILE'] = $Profile
  $Process = New-Object Diagnostics.Process
  $Process.StartInfo = $Start
  try {
    [void]$Process.Start()
    $Out = $Process.StandardOutput.ReadToEndAsync()
    $Err = $Process.StandardError.ReadToEndAsync()
    if (-not $Process.WaitForExit(10000)) { $Process.Kill(); throw 'FACTS_TEST_TIMEOUT' }
    if (-not $Out.Wait(1000) -or -not $Err.Wait(1000)) { throw 'FACTS_TEST_IO_TIMEOUT' }
    Assert-True ($Process.ExitCode -eq 0) ('collector exit '+$Err.Result)
    Assert-True ([string]::IsNullOrWhiteSpace($Err.Result)) 'stderr empty'
    $Raw = $Out.Result
    Assert-True ($Raw.Length -lt 16384) 'bounded stdout'
    $Value = $Raw | ConvertFrom-Json
    Assert-True ($Value.schema -eq 'COCWIN_RBRIDGE_WINDOWS_OWNER_FACTS_V1') 'schema'
    Assert-True ($Value.status -eq 'COLLECTED_READONLY') 'observational state'
    Assert-True ($Value.filesystemChanges -eq 0 -and $Value.sshConnections -eq 0 -and $Value.browserSends -eq 0) 'no activation'
    return @{value=$Value;raw=$Raw}
  } finally { $Process.Dispose() }
}
try {
  $OwnerProfileFixture = Join-Path $Root 'profile'
  [void][IO.Directory]::CreateDirectory($OwnerProfileFixture)
  $Install = Join-Path $Root 'absent'
  $R = Collect $Install $OwnerProfileFixture
  Assert-True ($R.value.installation.state -eq 'ABSENT') 'absent install'
  Assert-True (@($R.value.publicKeys).Count -eq 1 -and $R.value.publicKeys[0].state -eq 'ABSENT') 'absent public key'
  Assert-True (-not (Test-Path -LiteralPath $Install)) 'absent directory not created'
  $Passed++

  [void][IO.Directory]::CreateDirectory($Install)
  $Config = Join-Path $Install 'rbridge-native-host.config.json'
  $Exe = Join-Path $Install 'rbridge-native-host.exe'
  Save $Exe 'NOT_AN_EXECUTABLE_SHOULD_NEVER_RUN'
  $Private = Join-Path $OwnerProfileFixture '.ssh\rbridge_ed25519'
  Save $Private 'PRIVATE_KEY_SENTINEL_MUST_NEVER_BE_READ_OR_ECHOED'
  Save ($Private+'.pub') 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBERERERERERERERERERERERERERERERERERERERERER COMMENT_SENTINEL_MUST_NOT_BE_ECHOED'
  $RawConfig = '{"schema":"RBRIDGE_NATIVE_HOST_CONFIG_V1","expectedExtensionId":"ebibbijpegoankenmggdnehpoadcophk","eventStoreRoot":"C:\\facts-events","ssh":{"sshPath":"C:\\Windows\\System32\\OpenSSH\\ssh.exe","host":"aether-engine","port":22,"user":"rbridge","identityFile":"'+$Private.Replace('\','\\')+'","knownHostsFile":"C:\\known_hosts"},"unexpectedSecret":"CONFIG_SECRET_SENTINEL_MUST_NEVER_BE_ECHOED"}'
  Save $Config $RawConfig
  $Before = (Get-FileHash -LiteralPath $Config -Algorithm SHA256).Hash
  $Lock = New-Object IO.FileStream($Private,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
  try { $R = Collect $Install $OwnerProfileFixture } finally { $Lock.Dispose() }
  Assert-True ($R.value.installation.state -eq 'PRESENT_METADATA_ONLY') 'present install'
  Assert-True ($R.value.installation.config.state -eq 'PRESENT_METADATA_ONLY') 'present config'
  Assert-True ($R.value.publicKeys[0].state -eq 'PUBLIC_KEY_OBSERVED') 'public key'
  Assert-True ($R.value.publicKeys[0].publicKey -eq 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBERERERERERERERERERERERERERERERERERERERERER') 'public blob unchanged'
  Assert-True ($R.value.publicKeys[0].fingerprint -eq 'SHA256:SQfC+vTbLURn9cTkVxIS8fGQ3FKNAJWeB0o139+gV4M') 'independent fingerprint'
  foreach ($Secret in @('PRIVATE_KEY_SENTINEL','COMMENT_SENTINEL','CONFIG_SECRET_SENTINEL')) { Assert-True (-not $R.raw.Contains($Secret)) 'no sensitive data' }
  Assert-True ((Get-FileHash -LiteralPath $Config -Algorithm SHA256).Hash -eq $Before) 'config preserved'
  $Passed++

  $RemoteConfig = @{schema='RBRIDGE_NATIVE_HOST_CONFIG_V1';ssh=@{host='aether-engine';port=22;user='rbridge';identityFile='\\facts.invalid\share\key'}} | ConvertTo-Json -Depth 4
  Save $Config $RemoteConfig
  $R = Collect $Install $OwnerProfileFixture
  Assert-True ($R.value.installation.config.keyPathState -eq 'NONLOCAL_PATH_REJECTED') 'UNC path rejected before probing'
  Assert-True (@($R.value.publicKeys).Count -eq 1) 'remote key not added'
  Assert-True (-not $R.raw.Contains('facts.invalid')) 'untrusted path not echoed'
  Save $Config $RawConfig
  $Passed++

  Save ($Private+'.pub') '-----BEGIN OPENSSH PRIVATE KEY----- PRIVATE_SENTINEL'
  $R = Collect $Install $OwnerProfileFixture
  Assert-True ($R.value.publicKeys[0].state -eq 'UNRECOGNIZED_PUBLIC_KEY') 'private bytes rejected'
  Assert-True (-not $R.raw.Contains('PRIVATE_SENTINEL')) 'private bytes not echoed'
  $Passed++

  Save $Config '{"schema":"bad","unexpectedSecret":"BAD_JSON_SECRET"}'
  $R = Collect $Install $OwnerProfileFixture
  Assert-True ($R.value.installation.config.state -eq 'UNRECOGNIZED_CONFIG') 'unknown schema'
  Assert-True (-not $R.raw.Contains('BAD_JSON_SECRET')) 'unknown fields not echoed'
  $Passed++

  Save $Config '{"broken":"MALFORMED_SECRET'
  $R = Collect $Install $OwnerProfileFixture
  Assert-True ($R.value.installation.config.state -eq 'MALFORMED_CONFIG') 'malformed config'
  Assert-True (-not $R.raw.Contains('MALFORMED_SECRET')) 'parse error sanitized'
  $Passed++

  Save $Config ('x'*65537)
  $R = Collect $Install $OwnerProfileFixture
  Assert-True ($R.value.installation.config.state -eq 'UNTRUSTED_FILE') 'oversize config'
  $Passed++

  $Target = Join-Path $Root 'junction-target'
  [void][IO.Directory]::CreateDirectory($Target)
  $Alias = Join-Path $Root 'junction-install'
  [void](New-Item -ItemType Junction -Path $Alias -Target $Target)
  $R = Collect $Alias $OwnerProfileFixture
  Assert-True ($R.value.installation.state -eq 'UNTRUSTED_DIRECTORY') 'reparse install rejected'
  [void][IO.Directory]::CreateDirectory((Join-Path $Target 'nested'))
  $R = Collect (Join-Path $Alias 'nested') $OwnerProfileFixture
  Assert-True ($R.value.installation.state -eq 'UNTRUSTED_DIRECTORY') 'ancestor reparse rejected'
  [IO.Directory]::Delete($Alias)
  $Passed++

  # Swap an ancestor deterministically after the old pathname inspection and
  # before file open. The redirected same-length target must never be read.
  $RaceInstall = Join-Path $Root 'race-install'
  $RaceMoved = Join-Path $Root 'race-original'
  $RaceTarget = Join-Path $Root 'race-target'
  [void][IO.Directory]::CreateDirectory($RaceInstall)
  [void][IO.Directory]::CreateDirectory($RaceTarget)
  $RaceConfig = Join-Path $RaceInstall 'rbridge-native-host.config.json'
  Save $RaceConfig $RawConfig
  Save (Join-Path $RaceTarget 'rbridge-native-host.config.json') $RawConfig
  $RaceCollector = Join-Path $Root 'race-collector.ps1'
  $Hook = '$Full = Local-Path $Path'+[Environment]::NewLine+
    ('    if ($Path -eq ''{0}'') {{ [IO.Directory]::Move(''{1}'',''{2}''); [void](New-Item -ItemType Junction -Path ''{1}'' -Target ''{3}'') }}' -f $RaceConfig,$RaceInstall,$RaceMoved,$RaceTarget)
  $CollectorText = [IO.File]::ReadAllText($CollectorPath)
  Assert-True ($CollectorText.Contains('$Full = Local-Path $Path')) 'race hook boundary'
  Save $RaceCollector ($CollectorText.Replace('$Full = Local-Path $Path',$Hook))
  try {
    $R = Collect $RaceInstall $OwnerProfileFixture $RaceCollector
    Assert-True ($R.value.installation.config.state -ne 'PRESENT_METADATA_ONLY') 'ancestor replacement not followed'
  } finally {
    if ((Get-Item -LiteralPath $RaceInstall -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($RaceInstall) }
  }
  $Passed++

  [pscustomobject]@{schema='RBRIDGE_WINDOWS_OWNER_FACTS_QA_V1';state='PASS';passed=$Passed;powerShellMajor=$PSVersionTable.PSVersion.Major;actualOwnerWindows='NOT_RUN';sshConnections=0;browserSends=0} | ConvertTo-Json -Compress
} finally {
  if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
}
