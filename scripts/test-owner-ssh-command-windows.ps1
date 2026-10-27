$ErrorActionPreference='Continue'
$Ssh=Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
if (-not (Test-Path -LiteralPath $Ssh -PathType Leaf)) {throw 'WINDOWS_OPENSSH_MISSING'}
$Version=(@(& $Ssh -V 2>&1) | ForEach-Object {$_.ToString()}) -join "`n"
$Source='& $Ssh -G -F NUL -n -T -v -oBatchMode=yes -oPreferredAuthentications=publickey -oIdentitiesOnly=yes -oIdentityAgent=none -oStrictHostKeyChecking=yes -oUpdateHostKeys=no -oPasswordAuthentication=no -oKbdInteractiveAuthentication=no -oConnectTimeout=10 -oConnectionAttempts=1 -oServerAliveInterval=5 -oServerAliveCountMax=2 -oGlobalKnownHostsFile=NUL ''-oUserKnownHostsFile=known_hosts.cocwin'' -i owner_ed25519 -p 22 rbridge@192.168.100.14 cocwin-owner-auth-probe-v1'
$Tokens=$null;$Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseInput($Source,[ref]$Tokens,[ref]$Errors)
if ($Errors.Count -ne 0) {throw 'PROBE_PARSE_ERROR'}
$Command=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.CommandAst]},$true)
$Elements=@($Command.CommandElements | ForEach-Object {[pscustomobject]@{type=$_.GetType().Name;text=$_.Extent.Text}})
[pscustomobject]@{schema='COCWIN_OWNER_SSH_PROBE_ARGUMENTS_V1';powerShell=$PSVersionTable.PSVersion.ToString();ssh=$Version;elements=$Elements;sshConnections=0;browserSends=0} | ConvertTo-Json -Depth 5 -Compress
# -G only parses and prints configuration; it never opens a network connection.
# OpenSSH stats -i before -G; an absent fixture is discarded and selects defaults.
# Use a public dummy file, never any CI or owner private key.
$Work=Join-Path $env:RUNNER_TEMP ('cocwin097-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($Work)
[IO.File]::WriteAllText((Join-Path $Work 'owner_ed25519'),"Public configuration fixture, not a private key.`n")
[IO.File]::WriteAllText((Join-Path $Work 'known_hosts.cocwin'),'')
Push-Location -LiteralPath $Work -ErrorAction Stop
try {
  $Lines=@(& $Ssh -G -F NUL -n -T -v -oBatchMode=yes -oPreferredAuthentications=publickey -oIdentitiesOnly=yes -oIdentityAgent=none -oStrictHostKeyChecking=yes -oUpdateHostKeys=no -oPasswordAuthentication=no -oKbdInteractiveAuthentication=no -oConnectTimeout=10 -oConnectionAttempts=1 -oServerAliveInterval=5 -oServerAliveCountMax=2 -oGlobalKnownHostsFile=NUL '-oUserKnownHostsFile=known_hosts.cocwin' -i owner_ed25519 -p 22 rbridge@192.168.100.14 cocwin-owner-auth-probe-v1 2>&1)
  $Code=$LASTEXITCODE
} finally {
  Pop-Location
  [IO.File]::Delete((Join-Path $Work 'owner_ed25519'))
  [IO.File]::Delete((Join-Path $Work 'known_hosts.cocwin'))
  [IO.Directory]::Delete($Work,$false)
}
$Text=($Lines | ForEach-Object {$_.ToString()}) -join "`n"
$Selected=@($Text -split '\r?\n' | Where-Object {$_ -match '^(host|hostname|user|port|userknownhostsfile|identityfile|batchmode|stricthostkeychecking|preferredauthentications|passwordauthentication|kbdinteractiveauthentication|identitiesonly|identityagent|globalknownhostsfile|updatehostkeys|connecttimeout|connectionattempts|serveraliveinterval|serveralivecountmax) '})
[pscustomobject]@{schema='COCWIN_OWNER_SSH_PROBE_EFFECTIVE_CONFIG_V1';exitCode=$Code;configuration=$Selected;sshConnections=0;browserSends=0} | ConvertTo-Json -Depth 4 -Compress
if ($Code -ne 0) {throw 'OPENSSH_CONFIG_PARSE_FAILED'}
if ($Text -cnotmatch '(?m)^hostname 192\.168\.100\.14\r?$') {throw 'WRONG_EFFECTIVE_HOSTNAME'}
if ($Text -cnotmatch '(?m)^user rbridge\r?$') {throw 'WRONG_EFFECTIVE_USER'}
if ($Text -cnotmatch '(?m)^userknownhostsfile known_hosts\.cocwin\r?$') {throw 'WRONG_EFFECTIVE_KNOWN_HOSTS_FILE'}
foreach ($Expected in @('host 192.168.100.14','port 22','identityfile owner_ed25519','batchmode yes','identitiesonly yes','identityagent none','stricthostkeychecking true','updatehostkeys false','preferredauthentications publickey','passwordauthentication no','kbdinteractiveauthentication no','globalknownhostsfile NUL','connecttimeout 10','connectionattempts 1','serveraliveinterval 5','serveralivecountmax 2')) {
  if ($Text -cnotmatch ('(?m)^'+[regex]::Escape($Expected)+'\r?$')) {throw ('WRONG_EFFECTIVE_SETTING: '+$Expected)}
}
if (@($Text -split '\r?\n' | Where-Object {$_ -cmatch '^identityfile '}).Count -ne 1) {throw 'UNEXPECTED_IDENTITY_FALLBACK'}
[pscustomobject]@{schema='COCWIN_OWNER_SSH_PROBE_COMMAND_QA_V1';status='PASS';powerShell=$PSVersionTable.PSVersion.ToString();sshConnections=0;browserSends=0;ownerAuthentication='NOT_RUN'} | ConvertTo-Json -Compress
