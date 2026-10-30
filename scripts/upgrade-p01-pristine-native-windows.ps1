[CmdletBinding()]
param([string]$ExpectedManifestSha256='',[ValidateSet('APPLY','STATUS','RECONCILE')][string]$Mode='APPLY',[switch]$LibraryOnly)
$ErrorActionPreference='Stop'
function Need([bool]$Ok,[string]$Why) {if (-not $Ok) {throw $Why}}
function Initialize-Native {
  $Name=New-Object Reflection.AssemblyName('CocwinUpgradeFiles'+[guid]::NewGuid().ToString('N'))
  $Assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly($Name,[Reflection.Emit.AssemblyBuilderAccess]::Run)
  $Module=$Assembly.DefineDynamicModule($Name.Name);$Builder=$Module.DefineType($Name.Name,[Reflection.TypeAttributes]'Public,Abstract,Sealed')
  function Method([string]$Name,[Type]$Return,[Type[]]$Parameters) {
    $M=$Builder.DefineMethod($Name,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',$Return,$Parameters)
    $A=[Runtime.InteropServices.DllImportAttribute]
    $Fields=[Reflection.FieldInfo[]]@($A.GetField('EntryPoint'),$A.GetField('SetLastError'),$A.GetField('CharSet'),$A.GetField('ExactSpelling'))
    $Values=[object[]]@($Name,$true,[Runtime.InteropServices.CharSet]::Unicode,$true)
    $Import=New-Object Reflection.Emit.CustomAttributeBuilder($A.GetConstructor([Type[]]@([string])),[object[]]@('kernel32.dll'),$Fields,$Values)
    $M.SetCustomAttribute($Import);$M.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  }
  Method 'CreateFileW' ([Microsoft.Win32.SafeHandles.SafeFileHandle]) ([Type[]]@([string],[uint32],[uint32],[IntPtr],[uint32],[uint32],[IntPtr]))
  Method 'GetFileInformationByHandle' ([bool]) ([Type[]]@([Microsoft.Win32.SafeHandles.SafeFileHandle],[IntPtr]))
  Method 'GetFinalPathNameByHandleW' ([uint32]) ([Type[]]@([Microsoft.Win32.SafeHandles.SafeFileHandle],[Text.StringBuilder],[uint32],[uint32]))
  Method 'GetVolumeNameForVolumeMountPointW' ([bool]) ([Type[]]@([string],[Text.StringBuilder],[uint32]))
  Method 'SetFileInformationByHandle' ([bool]) ([Type[]]@([Microsoft.Win32.SafeHandles.SafeFileHandle],[int],[IntPtr],[uint32]))
  return $Builder.CreateType()
}
function Local-Path([string]$Path) {
  Need ($Path.Length -le 1024 -and $Path -cmatch '^[A-Za-z]:\\' -and $Path -notmatch '[\x00-\x1f"<>|?*]') 'UNTRUSTED_LOCAL_PATH'
  $Full=[IO.Path]::GetFullPath($Path)
  Need ([string]::Equals($Path,$Full,[StringComparison]::OrdinalIgnoreCase) -and -not $Full.Substring(3).Contains(':')) 'UNTRUSTED_LOCAL_PATH'
  foreach ($Part in $Full.Substring(3).Split('\')) {
    if ($Part -eq '') {continue}
    Need (-not $Part.EndsWith('.') -and -not $Part.EndsWith(' ') -and $Part -notmatch '^(CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3]|CONIN\$|CONOUT\$)(\.|$)') 'UNTRUSTED_LOCAL_PATH'
  }
  return $Full
}
function Volume-Path([string]$Full) {
  $Volume=New-Object Text.StringBuilder(64)
  Need ($Native::GetVolumeNameForVolumeMountPointW($Full.Substring(0,3),$Volume,64) -and $Volume.ToString() -match '^\\\\\?\\Volume\{[a-fA-F0-9-]{36}\}\\$') 'UNTRUSTED_LOCAL_VOLUME'
  return $Volume.ToString()+$Full.Substring(3)
}
function Handle-Info($Handle) {
  $P=[Runtime.InteropServices.Marshal]::AllocHGlobal(52)
  try {
    Need ($Native::GetFileInformationByHandle($Handle,$P)) 'FILE_IDENTITY_UNAVAILABLE'
    return @{attributes=[Runtime.InteropServices.Marshal]::ReadInt32($P,0);links=[Runtime.InteropServices.Marshal]::ReadInt32($P,40);id=([Runtime.InteropServices.Marshal]::ReadInt32($P,28).ToString('x8')+':'+[Runtime.InteropServices.Marshal]::ReadInt32($P,44).ToString('x8')+':'+[Runtime.InteropServices.Marshal]::ReadInt32($P,48).ToString('x8'))}
  } finally {[Runtime.InteropServices.Marshal]::FreeHGlobal($P)}
}
function Final-Path($Handle) {
  $Text=New-Object Text.StringBuilder(1100);$Length=$Native::GetFinalPathNameByHandleW($Handle,$Text,1100,1)
  Need ($Length -gt 0 -and $Length -lt 1100) 'FILE_FINAL_PATH_UNAVAILABLE';return $Text.ToString()
}
function Verify-Entry($Entry) {
  Need (-not $Entry.closed -and -not $Entry.handle.IsInvalid -and -not $Entry.handle.IsClosed) 'HELD_OBJECT_CLOSED'
  $Info=Handle-Info $Entry.handle
  Need ($Info.id -ceq $Entry.id -and -not ($Info.attributes -band 1024) -and (($Info.attributes -band 16) -ne 0) -eq $Entry.directory -and ($Entry.directory -or $Info.links -eq 1)) 'HELD_OBJECT_CHANGED'
  Need ([string]::Equals((Final-Path $Entry.handle).TrimEnd('\'),$Entry.guid.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)) 'HELD_OBJECT_RENAMED'
}
function Pin-Directory([string]$Full,[bool]$Delete=$false) {
  $Full=Local-Path $Full;$Key=$Full.ToUpperInvariant()
  if ($Directories.ContainsKey($Key)) {Need (-not $Delete -or $Directories[$Key].deleteAccess) 'DIRECTORY_ACCESS_MISMATCH';Verify-Entry $Directories[$Key];return $Directories[$Key]}
  $Guid=Volume-Path $Full;$Access=if ($Delete) {[uint32]65664} else {[uint32]128}
  $Handle=$Native::CreateFileW($Guid,$Access,[uint32]3,[IntPtr]::Zero,[uint32]3,[uint32]35651584,[IntPtr]::Zero)
  Need (-not $Handle.IsInvalid) 'DIRECTORY_PIN_FAILED'
  $Info=Handle-Info $Handle;$Entry=[pscustomobject]@{full=$Full;guid=$Guid;handle=$Handle;stream=$null;id=$Info.id;directory=$true;deleteAccess=$Delete;closed=$false}
  [void]$AllEntries.Add($Entry);Verify-Entry $Entry;$Directories[$Key]=$Entry;return $Entry
}
function Pin-Parents([string]$Full) {
  $Current=$Full.Substring(0,3);[void](Pin-Directory $Current)
  $Parts=@($Full.Substring(3).Split('\'))
  for ($Index=0;$Index -lt $Parts.Count-1;$Index++) {$Current=Join-Path $Current $Parts[$Index];[void](Pin-Directory $Current)}
}
function Close-Entry($Entry) {
  if ($null -ne $Entry -and -not $Entry.closed) {if ($null -ne $Entry.stream) {$Entry.stream.Dispose()};$Entry.handle.Dispose();$Entry.closed=$true}
}
function Open-Leaf([string]$Path,[long]$Maximum,[bool]$Delete=$false,[bool]$Exclusive=$false) {
  $Full=Local-Path $Path;$Key=$Full.ToUpperInvariant();Pin-Parents $Full
  if ($Leaves.ContainsKey($Key) -and -not $Leaves[$Key].closed) {Need (-not $Delete -or $Leaves[$Key].deleteAccess) 'FILE_ACCESS_MISMATCH';Need (-not $Exclusive -or $Leaves[$Key].exclusive) 'EXCLUSIVE_IMAGE_GATE_REQUIRED';Verify-Entry $Leaves[$Key];return $Leaves[$Key]}
  $Guid=Volume-Path $Full;$Access=if ($Exclusive) {[uint32]3221291008} elseif ($Delete) {[uint32]2147549184} else {[uint32]2147483648}
  $Share=if ($Exclusive) {[uint32]0} else {[uint32]1};$Handle=$Native::CreateFileW($Guid,$Access,$Share,[IntPtr]::Zero,[uint32]3,[uint32]35651584,[IntPtr]::Zero)
  Need (-not $Handle.IsInvalid) 'MANAGED_FILE_OPEN_FAILED'
  $Info=Handle-Info $Handle;$Entry=[pscustomobject]@{full=$Full;guid=$Guid;handle=$Handle;stream=$null;id=$Info.id;directory=$false;deleteAccess=($Delete -or $Exclusive);exclusive=$Exclusive;closed=$false}
  [void]$AllEntries.Add($Entry);Verify-Entry $Entry
  $Entry.stream=New-Object IO.FileStream($Handle,[IO.FileAccess]::Read)
  Need ($Entry.stream.Length -ge 1 -and $Entry.stream.Length -le $Maximum) 'MANAGED_FILE_SIZE_INVALID'
  $Leaves[$Key]=$Entry;return $Entry
}
function Hash-Stream([IO.Stream]$Stream) {
  $Hasher=[Security.Cryptography.SHA256]::Create()
  try {return -join ($Hasher.ComputeHash($Stream) | ForEach-Object {$_.ToString('x2')})} finally {$Hasher.Dispose()}
}
function Entry-Hash($Entry) {Verify-Entry $Entry;$Entry.stream.Position=0;$Digest=Hash-Stream $Entry.stream;$Entry.stream.Position=0;Verify-Entry $Entry;return $Digest}
function File-Hash([string]$Path,[long]$Maximum) {return Entry-Hash (Open-Leaf $Path $Maximum)}
function Entry-Text($Entry) {
  Verify-Entry $Entry;$Entry.stream.Position=0;$Reader=New-Object IO.StreamReader($Entry.stream,$Utf8,$true,1024,$true)
  try {return $Reader.ReadToEnd()} finally {$Reader.Dispose();$Entry.stream.Position=0}
}
function Acl-State([string]$Sddl) {
  # AUTO_INHERITED is bookkeeping; retain owner/group, protection and every ACE,
  # including its inherited flag. Do not equate duplicate explicit ACEs.
  $Raw=New-Object Security.AccessControl.RawSecurityDescriptor($Sddl)
  $Raw.SetFlags([Security.AccessControl.ControlFlags]([int]$Raw.ControlFlags -band (-bnot [int][Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited)))
  return $Raw.GetSddlForm([Security.AccessControl.AccessControlSections]::All)
}
function Binding([string]$Key) {
  $Reg=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Key)
  try {if ($null -eq $Reg) {return $null};return $Reg.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)} finally {if ($null -ne $Reg) {$Reg.Dispose()}}
}
function Protected-Snapshot {
  $Rows=@()
  foreach ($Path in @($ConfigPath,$ManifestPath,$ReceiptPath,$Identity,($Identity+'.pub'),$KnownHosts)) {$Rows+=[ordered]@{path=$Path;sha=(File-Hash $Path 65536);acl=(Get-Acl -LiteralPath $Path).Sddl}}
  foreach ($Key in $RegistryPaths) {Need ([string]::Equals((Binding $Key),$ManifestPath,[StringComparison]::OrdinalIgnoreCase)) 'NATIVE_REGISTRATION_CHANGED';$Rows+=[ordered]@{registry=$Key;binding=(Binding $Key)}}
  return ($Rows | ConvertTo-Json -Depth 5 -Compress)
}
function Rename-Entry($Entry,[string]$Destination) {
  Verify-Entry $Entry;Need $Entry.deleteAccess 'RENAME_ACCESS_REQUIRED';$Destination=Local-Path $Destination;Pin-Parents $Destination
  $Guid=Volume-Path $Destination;$Bytes=[Text.Encoding]::Unicode.GetBytes($Guid)
  $RootOffset=if ([IntPtr]::Size -eq 8) {8} else {4};$NameOffset=$RootOffset+[IntPtr]::Size+4;$Size=$NameOffset+$Bytes.Length+2
  $P=[Runtime.InteropServices.Marshal]::AllocHGlobal($Size)
  try {
    for ($Index=0;$Index -lt $Size;$Index++) {[Runtime.InteropServices.Marshal]::WriteByte($P,$Index,0)}
    [Runtime.InteropServices.Marshal]::WriteIntPtr($P,$RootOffset,[IntPtr]::Zero)
    [Runtime.InteropServices.Marshal]::WriteInt32($P,$RootOffset+[IntPtr]::Size,$Bytes.Length)
    [Runtime.InteropServices.Marshal]::Copy($Bytes,0,[IntPtr]::Add($P,$NameOffset),$Bytes.Length)
    # ReplaceIfExists remains FALSE: never overwrite a newly appeared target.
    Need ($Native::SetFileInformationByHandle($Entry.handle,3,$P,[uint32]$Size)) 'HELD_OBJECT_RENAME_FAILED'
    [void]$Leaves.Remove($Entry.full.ToUpperInvariant());$Entry.full=$Destination;$Entry.guid=$Guid;$Leaves[$Destination.ToUpperInvariant()]=$Entry;Verify-Entry $Entry
  } finally {[Runtime.InteropServices.Marshal]::FreeHGlobal($P)}
}
function Delete-Entry($Entry) {
  Verify-Entry $Entry;Need $Entry.deleteAccess 'DELETE_ACCESS_REQUIRED';$P=[Runtime.InteropServices.Marshal]::AllocHGlobal(1)
  try {[Runtime.InteropServices.Marshal]::WriteByte($P,0,1);Need ($Native::SetFileInformationByHandle($Entry.handle,4,$P,[uint32]1)) 'OWNED_OBJECT_DELETE_FAILED'} finally {[Runtime.InteropServices.Marshal]::FreeHGlobal($P)}
  Close-Entry $Entry
}

function P01-HashBytes([byte[]]$Bytes) {
 $S=New-Object IO.MemoryStream(,$Bytes);try {return Hash-Stream $S} finally {$S.Dispose()}
}
function P01-Canonical($V) {
 if ($null -eq $V) {return 'null'}
 if ($V -is [string]) {return ($V | ConvertTo-Json -Compress)}
 if ($V -is [bool]) {if ($V) {return 'true'};return 'false'}
 if ($V -is [Collections.IDictionary]) {
  return '{'+(@(foreach($K in @($V.Keys | Sort-Object -CaseSensitive)) {(P01-Canonical ([string]$K))+':'+(P01-Canonical $V[$K])}) -join ',')+'}'
 }
 if ($V -is [Management.Automation.PSCustomObject]) {$M=@{};foreach($P in $V.PSObject.Properties) {$M[$P.Name]=$P.Value};return P01-Canonical $M}
 if ($V -is [Collections.IEnumerable]) {return '['+(@(foreach($I in $V) {P01-Canonical $I}) -join ',')+']'}
 Need ($V -is [ValueType]) 'NON_JSON_VALUE'
 return [Convert]::ToString($V,[Globalization.CultureInfo]::InvariantCulture)
}
function P01-Keys($V,[string[]]$Keys) {
 Need ($null -ne $V -and ($V -is [Collections.IDictionary] -or $V -is [Management.Automation.PSCustomObject])) 'CLOSED_OBJECT_REQUIRED'
 $Actual=if ($V -is [Collections.IDictionary]) {@($V.Keys)} else {@($V.PSObject.Properties.Name)}
 Need ($Actual.Count -eq $Keys.Count -and @($Actual | Where-Object {$_ -cnotin $Keys}).Count -eq 0) 'CLOSED_OBJECT_FIELDS_CHANGED'
}
function P01-PrivateAcl([string]$Path) {
 $Acl=Get-Acl -LiteralPath $Path;$Privileged=@($CurrentSid,'S-1-5-18','S-1-5-32-544')
 Need ($Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cin $Privileged) 'FOREIGN_FILE_OWNER'
 $Raw=New-Object Security.AccessControl.RawSecurityDescriptor($Acl.Sddl);Need ($null -ne $Raw.DiscretionaryAcl) 'NULL_DACL_REJECTED'
 foreach($Rule in $Acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($Rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and -not ($Rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) {
   Need (($Rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]0x000D0156) -eq 0 -or $Rule.IdentityReference.Value -cin $Privileged) 'FOREIGN_WRITABLE_ACL'
  }
 };return Acl-State $Acl.Sddl
}
function P01-NewLeaf([string]$Path,[byte[]]$Bytes,[string]$AclPath='',[bool]$Delete=$false,[bool]$Exclusive=$false) {
 Pin-Parents $Path
 $Handle=$Native::CreateFileW((Volume-Path $Path),[uint32]3221291008,[uint32]0,[IntPtr]::Zero,[uint32]1,[uint32]35651584,[IntPtr]::Zero)
 Need (-not $Handle.IsInvalid) 'TRANSACTION_CREATE_COLLISION'
 $Id=(Handle-Info $Handle).id;$Writer=New-Object IO.FileStream($Handle,[IO.FileAccess]::ReadWrite)
 try {
  $Writer.Write($Bytes,0,$Bytes.Length);$Writer.Flush($true)
  if ($AclPath -ne '') {
   $Access=New-Object Security.AccessControl.FileSecurity
   $Access.SetSecurityDescriptorSddlForm((Get-Acl -LiteralPath $AclPath).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access),[Security.AccessControl.AccessControlSections]::Access)
   $Writer.SetAccessControl($Access)
  }
 } finally {$Writer.Dispose();$Handle.Dispose()}
 $Entry=Open-Leaf $Path ([Math]::Max(1,$Bytes.Length)) $Delete $Exclusive
 Need ($Entry.id -ceq $Id -and (Entry-Hash $Entry) -ceq (P01-HashBytes $Bytes)) 'CREATED_OBJECT_CHANGED'
 [void](P01-PrivateAcl $Path);return $Entry
}
function P01-Registration($C) {
 $Rows=@()
 foreach($Key in $C.registryPaths) {
  Need ($Key -is [string] -and $Key.StartsWith('Software\',[StringComparison]::Ordinal) -and $Key -notmatch '[\x00-\x1f]') 'REGISTRATION_KEY_INVALID'
  $Reg=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Key)
  try {
   Need ($null -ne $Reg -and $Reg.GetValueKind('') -eq [Microsoft.Win32.RegistryValueKind]::String) 'NATIVE_REGISTRATION_CHANGED'
   $Value=$Reg.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
   Need ([string]::Equals($Value,(Join-Path $C.root 'com.cocwin.rbridge_chat_v1.json'),[StringComparison]::OrdinalIgnoreCase)) 'NATIVE_REGISTRATION_CHANGED'
   $Rows+=@{key=$Key;value=$Value}
  } finally {if ($null -ne $Reg) {$Reg.Dispose()}}
 };return P01-Canonical $Rows
}
function P01-Processes {
 # Exclusive writable image handles are the kernel gate, including fresh launches.
 Need (@(Get-CimInstance -ClassName Win32_Process -Filter "Name='rbridge-native-host.exe'" -ErrorAction Stop).Count -eq 0) 'NATIVE_PROCESS_BUSY'
}
function P01-Layout($C,[bool]$Recovery) {
 $Actual=@(Get-ChildItem -LiteralPath $C.root -Force | ForEach-Object {$_.Name})
 Need (@($Actual | Where-Object {$_ -cnotin (@($C.allowedRootEntries)+@('.p01-pristine-upgrade'))}).Count -eq 0) 'UNEXPECTED_INSTALL_ENTRY'
 foreach($Name in $C.allowedRootEntries) {
  if ($Recovery -and $Name -cin @('rbridge-native-host.exe','rbridge-native-host.config.json')) {continue}
  Need ($Actual -ccontains $Name) 'MISSING_INSTALL_ENTRY'
 }
 foreach($Name in @('events','keys','events\v3-results')) {[void](Pin-Directory (Join-Path $C.root $Name));[void](P01-PrivateAcl (Join-Path $C.root $Name))}
 $Names=@(Get-ChildItem -LiteralPath (Join-Path $C.root 'events') -Force | ForEach-Object {$_.Name})
 Need (@($Names | Where-Object {$_ -cnotin @('v3-peer-owner.json','v3-results')}).Count -eq 0 -and $Names -ccontains 'v3-results') 'HISTORY_OR_PARTIAL_STATE_PRESENT'
 if (-not $Recovery) {Need ($Names -ccontains 'v3-peer-owner.json') 'OWNER_MARKER_MISSING'}
 Need (@(Get-ChildItem -LiteralPath (Join-Path $C.root 'events\v3-results') -Force).Count -eq 0) 'RESULT_HISTORY_OR_WRITER_PRESENT'
 $Names=@(Get-ChildItem -LiteralPath (Join-Path $C.root 'keys') -Force | ForEach-Object {$_.Name})
 Need ($Names.Count -eq 3 -and @($Names | Where-Object {$_ -cnotin @('owner_ed25519','owner_ed25519.pub','known_hosts.cocwin')}).Count -eq 0) 'UNEXPECTED_KEY_ENTRY'
}
function P01-Protected($C) {
 $Rows=@()
 foreach($Name in @($C.allowedRootEntries | Sort-Object -CaseSensitive)) {
  if ($Name -cin @('rbridge-native-host.exe','rbridge-native-host.config.json','events','keys')) {continue}
  $Path=Join-Path $C.root $Name;$E=Open-Leaf $Path 65536
  if ($C.preservedPins -and $C.preservedPins.ContainsKey($Name)) {
   $Pin=$C.preservedPins[$Name];Need ($E.stream.Length -eq $Pin.bytes -and (Entry-Hash $E) -ceq $Pin.sha256) 'HISTORICAL_PREIMAGE_CHANGED'
  }
  if ($Name -ceq 'com.cocwin.rbridge_chat_v1.json') {
   $Pin=$C.predecessor[$Name];Need ($E.stream.Length -eq $Pin.bytes -and (Entry-Hash $E) -ceq $Pin.sha256) 'NATIVE_MANIFEST_CHANGED'
  }
  $Rows+=@{name=$Name;id=$E.id;sha256=(Entry-Hash $E);acl=(P01-PrivateAcl $Path)}
 }
 foreach($Name in @('keys\owner_ed25519','keys\owner_ed25519.pub','keys\known_hosts.cocwin')) {
  $Path=Join-Path $C.root $Name;$E=Open-Leaf $Path 65536
  $Rows+=@{name=$Name;id=$E.id;sha256=(Entry-Hash $E);acl=(P01-PrivateAcl $Path)}
 }
 foreach($Name in @('','events','keys','events\v3-results')) {
  $Path=if ($Name -eq '') {$C.root} else {Join-Path $C.root $Name}
  $E=Pin-Directory $Path;$Rows+=@{name=$Name;id=$E.id;acl=(P01-PrivateAcl $Path)}
 }
 $Rows+=@{registration=(P01-Registration $C)};return P01-Canonical $Rows
}
function P01-CheckCandidate($Package,$Config,[string]$Hash) {
 Verify-Entry $Package;Verify-Entry $Config
 $Start=New-Object Diagnostics.ProcessStartInfo
 $Start.FileName=$Package.full;$Start.Arguments='--check-config "'+$Config.full+'"';$Start.UseShellExecute=$false;$Start.CreateNoWindow=$true
 $Start.RedirectStandardInput=$true;$Start.RedirectStandardOutput=$true;$Start.RedirectStandardError=$true
 foreach($Name in @('NODE_OPTIONS','NODE_PATH','SSH_ASKPASS','NODE_EXTRA_CA_CERTS')) {$Start.EnvironmentVariables.Remove($Name)}
 $Start.EnvironmentVariables['SSH_ASKPASS_REQUIRE']='never'
 $Process=New-Object Diagnostics.Process;$Process.StartInfo=$Start;$Started=$false
 try {
  [void]$Process.Start();$Started=$true;$Process.StandardInput.Close();$Out=$Process.StandardOutput.ReadToEndAsync();$Err=$Process.StandardError.ReadToEndAsync()
  Need ($Process.WaitForExit(15000)) 'CANDIDATE_CONFIG_CHECK_TIMEOUT'
  Need ($Out.Wait(1000) -and $Err.Wait(1000) -and $Process.ExitCode -eq 0 -and $Out.Result.Length -le 16384 -and $Err.Result.Length -le 16384 -and [string]::IsNullOrWhiteSpace($Err.Result)) 'CANDIDATE_CONFIG_CHECK_FAILED'
  $V=$Out.Result | ConvertFrom-Json
  Need ($V.schema -ceq 'RBRIDGE_NATIVE_CONFIG_CHECK_V1' -and $V.status -ceq 'PASS' -and $V.sourceSha256 -ceq $Hash -and $V.expectedExtensionId -ceq 'ebibbijpegoankenmggdnehpoadcophk' -and $V.v3Configured -is [bool] -and $V.v3Configured -and $V.activated -is [bool] -and -not $V.activated) 'CANDIDATE_CONFIG_CHECK_INVALID'
  Verify-Entry $Package;Verify-Entry $Config
 } finally {if ($Started -and -not $Process.HasExited) {$Process.Kill()};$Process.Dispose()}
}
function P01-Result([string]$Status,[string]$Reason,[bool]$Publication) {
 return [pscustomobject]@{schema='COCWIN_P01_NATIVE_PRISTINE_UPGRADE_V1';status=$Status;phase=$Status;reason=$Reason;publicationStarted=$Publication;activated=$false;sshConnections=0;browserSends=0;actualOwnerAcceptance='NOT_RUN'}
}
function P01-Slots($C,$Tuples,[string]$Stage) {
 $States=@();$Old=@{};$New=@{}
 foreach($T in $Tuples) {
  $DPath=Join-Path $C.root $T.name;$BPath=Join-Path $Stage $T.backup;$NPath=Join-Path $Stage $T.candidate
  $D=Test-Path -LiteralPath $DPath;$B=Test-Path -LiteralPath $BPath;$N=Test-Path -LiteralPath $NPath
  $Pin=$C.predecessor[$T.name];$DE=$null;$BE=$null;$NE=$null
  if ($D) {$DE=Open-Leaf $DPath 134217728 $true ($T.kind -ceq 'exe');[void](P01-PrivateAcl $DPath)}
  if ($B) {$BE=Open-Leaf $BPath 134217728 $true ($T.kind -ceq 'exe');[void](P01-PrivateAcl $BPath)}
  if ($N) {$NE=Open-Leaf $NPath 134217728 $false ($T.kind -ceq 'exe');[void](P01-PrivateAcl $NPath)}
  $State=-1
  if ($D -and -not $B -and $N -and (Entry-Hash $DE) -ceq $Pin.sha256 -and $DE.stream.Length -eq $Pin.bytes) {$State=0;$Old[$T.kind]=$DE;$New[$T.kind]=$NE}
  if (-not $D -and $B -and $N) {$State=1;$Old[$T.kind]=$BE;$New[$T.kind]=$NE}
  if ($D -and $B -and -not $N -and (Entry-Hash $DE) -ceq $T.pin.sha256 -and $DE.stream.Length -eq $T.pin.bytes) {$State=2;$Old[$T.kind]=$BE;$New[$T.kind]=$DE}
  Need ($State -ge 0) 'UNRECOGNIZED_PUBLICATION_SLOT'
  Need ($Old[$T.kind].stream.Length -eq $Pin.bytes -and (Entry-Hash $Old[$T.kind]) -ceq $Pin.sha256 -and $New[$T.kind].stream.Length -eq $T.pin.bytes -and (Entry-Hash $New[$T.kind]) -ceq $T.pin.sha256) 'PUBLICATION_SLOT_CHANGED'
  $States+=$State
 }
 $Prefix=-1
 for($I=0;$I -le 6;$I++) {
  $Expected=@([Math]::Min(2,$I),[Math]::Min(2,[Math]::Max(0,$I-2)),[Math]::Min(2,[Math]::Max(0,$I-4)))
  if (($Expected -join ',') -ceq ($States -join ',')) {$Prefix=$I}
 }
 Need ($Prefix -ge 0) 'NON_PREFIX_PUBLICATION_STATE';return @{prefix=$Prefix;old=$Old;new=$New}
}
function P01-StepText([string]$Binding,[int]$Index) {return (P01-Canonical @{schema='COCWIN_P01_NATIVE_PRISTINE_STEP_V1';binding=$Binding;step=$Index})+[char]10}
function P01-Journal([string]$Stage,[string]$Binding,[int]$Prefix,[bool]$Complete) {
 $Names=@('intent.json','candidate.exe','candidate.config.json','candidate.owner.json','original.exe','original.config.json','original.owner.json','COMPLETE.json')+@(0..5 | ForEach-Object {'step-'+$_+'.json'})
 Need (@(Get-ChildItem -LiteralPath $Stage -Force | Where-Object {$_.Name -cnotin $Names -or $_.PSIsContainer}).Count -eq 0) 'FOREIGN_TRANSACTION_ENTRY'
 $Count=0
 for($I=0;$I -lt 6;$I++) {
  $Path=Join-Path $Stage ('step-'+$I+'.json')
  if (Test-Path -LiteralPath $Path) {
   Need ($I -eq $Count -and $I -lt $Prefix -and (Entry-Text (Open-Leaf $Path 16384)) -ceq (P01-StepText $Binding $I)) 'JOURNAL_STEP_CHANGED';$Count++
  }
 }
 Need ($Count -eq $Prefix -or (-not $Complete -and $Count -eq $Prefix-1)) 'JOURNAL_SLOT_DISAGREEMENT'
}

function Invoke-P01NativePristineTransaction {
 [CmdletBinding()]param([Parameter(Mandatory=$true)]$Context,[switch]$Reconcile,[switch]$StatusOnly)
 $Directories=@{};$Leaves=@{};$AllEntries=New-Object Collections.ArrayList
 $Utf8=New-Object Text.UTF8Encoding($false);$Native=$null;$Held=$false;$Mutex=$null;$HadStage=$false;$Publication=$false
 try {
  Need ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT -and $PSVersionTable.PSVersion.Major -eq 5) 'WINDOWS_POWERSHELL_51_REQUIRED'
  $Native=Initialize-Native;$CurrentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $Context.root=Local-Path $Context.root;Pin-Parents (Join-Path $Context.root 'placeholder')
  [void](Pin-Directory $Context.root);[void](P01-PrivateAcl $Context.root)
  Need ($Context.configBytes.Length -ge 2 -and $Context.configBytes.Length -le 65536 -and $Context.ownerBytes.Length -ge 2 -and $Context.ownerBytes.Length -le 16384 -and @($Context.registryPaths).Count -ge 1) 'TRANSACTION_CONTEXT_INVALID'
  P01-Keys $Context.predecessor @('rbridge-native-host.exe','rbridge-native-host.config.json','com.cocwin.rbridge_chat_v1.json','events\v3-peer-owner.json')
  foreach($Pin in @($Context.predecessor.Values)+@($Context.targetExecutable)) {Need ($Pin.sha256 -cmatch '^[a-f0-9]{64}$' -and $Pin.bytes -ge 2 -and $Pin.bytes -le 134217728) 'TRANSACTION_PIN_INVALID'}
  $Package=Open-Leaf (Local-Path $Context.packageExecutable) 134217728
  Need ($Package.stream.Length -eq $Context.targetExecutable.bytes -and (Entry-Hash $Package) -ceq $Context.targetExecutable.sha256) 'CANDIDATE_PACKAGE_CHANGED'
  [void](P01-PrivateAcl $Package.full)
  foreach($File in @($Context.packageFiles)) {
   if ($null -eq $File) {continue}
   $E=Open-Leaf (Local-Path $File.path) 134217728
   Need ($E.stream.Length -eq $File.bytes -and (Entry-Hash $E) -ceq $File.sha256) 'PINNED_PACKAGE_RESOURCE_CHANGED';[void](P01-PrivateAcl $E.full)
  }
  $Mutex=New-Object Threading.Mutex($false,('Local\COCWIN_P01_PRISTINE_'+(P01-HashBytes ($Utf8.GetBytes($Context.root.ToUpperInvariant())))))
  try {$Held=$Mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$Held=$true};Need $Held 'OWNER_TRANSACTION_BUSY'
  $Stage=Join-Path $Context.root '.p01-pristine-upgrade';$HadStage=Test-Path -LiteralPath $Stage
  $CP=@{bytes=$Context.configBytes.Length;sha256=(P01-HashBytes $Context.configBytes)}
  $OP=@{bytes=$Context.ownerBytes.Length;sha256=(P01-HashBytes $Context.ownerBytes)}
  $Tuples=@(
   @{kind='exe';name='rbridge-native-host.exe';backup='original.exe';candidate='candidate.exe';pin=$Context.targetExecutable},
   @{kind='config';name='rbridge-native-host.config.json';backup='original.config.json';candidate='candidate.config.json';pin=$CP},
   @{kind='owner';name='events\v3-peer-owner.json';backup='original.owner.json';candidate='candidate.owner.json';pin=$OP}
  )
  $Binding=P01-HashBytes ($Utf8.GetBytes((P01-Canonical @{root=$Context.root;predecessor=$Context.predecessor;target=@{exe=$Context.targetExecutable;config=$CP;owner=$OP};packageFiles=@($Context.packageFiles)})))
  P01-Layout $Context $HadStage
  if (-not $HadStage) {
   foreach($T in $Tuples) {
    $E=Open-Leaf (Join-Path $Context.root $T.name) 134217728 $true ($T.kind -ceq 'exe');$Pin=$Context.predecessor[$T.name]
    Need ($E.stream.Length -eq $Pin.bytes -and (Entry-Hash $E) -ceq $Pin.sha256) 'PREDECESSOR_PREIMAGE_CHANGED';[void](P01-PrivateAcl $E.full)
   }
   P01-Processes;$Protected=P01-Protected $Context
   if ($StatusOnly) {return P01-Result 'NONE' 'PRISTINE_PREDECESSOR' $false}
   Need (-not $Reconcile) 'NO_TRANSACTION_TO_RECONCILE'
   [void](New-Item -ItemType Directory -Path $Stage -ErrorAction Stop);[void](Pin-Directory $Stage);[void](P01-PrivateAcl $Stage)
   $Package.stream.Position=0;$Memory=New-Object IO.MemoryStream
   try {$Package.stream.CopyTo($Memory);$ExecutableBytes=$Memory.ToArray()} finally {$Memory.Dispose();$Package.stream.Position=0}
   [void](P01-NewLeaf (Join-Path $Stage 'candidate.exe') $ExecutableBytes (Join-Path $Context.root 'rbridge-native-host.exe') $true $true)
   [void](P01-NewLeaf (Join-Path $Stage 'candidate.config.json') $Context.configBytes (Join-Path $Context.root 'rbridge-native-host.config.json'))
   [void](P01-NewLeaf (Join-Path $Stage 'candidate.owner.json') $Context.ownerBytes (Join-Path $Context.root 'events\v3-peer-owner.json') $true)
  } else {
   [void](Pin-Directory $Stage);[void](P01-PrivateAcl $Stage)
   Need (Test-Path -LiteralPath (Join-Path $Stage 'intent.json')) 'UNKNOWN_TRANSACTION_WITHOUT_INTENT'
  }
  $Slots=P01-Slots $Context $Tuples $Stage;$Protected=P01-Protected $Context;$OldAcl=@{}
  foreach($T in $Tuples) {$OldAcl[$T.kind]=P01-PrivateAcl $Slots.old[$T.kind].full}
  $IntentText=(P01-Canonical @{schema='COCWIN_P01_NATIVE_PRISTINE_INTENT_V1';binding=$Binding;rootIdentity=(Pin-Directory $Context.root).id;protected=$Protected;oldAcl=$OldAcl})+[char]10
  if ($HadStage) {Need ((Entry-Text (Open-Leaf (Join-Path $Stage 'intent.json') 65536)) -ceq $IntentText) 'TRANSACTION_INTENT_CHANGED'}
  else {[void](P01-NewLeaf (Join-Path $Stage 'intent.json') ($Utf8.GetBytes($IntentText)))}
  $CompleteText=(P01-Canonical @{schema='COCWIN_P01_NATIVE_PRISTINE_COMPLETE_V1';binding=$Binding;rootIdentity=(Pin-Directory $Context.root).id;executable=$Context.targetExecutable;config=$CP;owner=$OP;activated=$false})+[char]10
  $Complete=Test-Path -LiteralPath (Join-Path $Stage 'COMPLETE.json')
  P01-Journal $Stage $Binding $Slots.prefix $Complete
  foreach($T in $Tuples) {Need ((P01-PrivateAcl $Slots.new[$T.kind].full) -ceq $OldAcl[$T.kind]) 'TARGET_ACL_CHANGED'}
  P01-Processes
  if ($Complete) {
   Need ($Slots.prefix -eq 6 -and (Entry-Text (Open-Leaf (Join-Path $Stage 'COMPLETE.json') 16384)) -ceq $CompleteText) 'COMPLETE_READBACK_CHANGED'
   return P01-Result 'COMPLETE' 'READ_BACK_COMPLETE' $false
  }
  if ($HadStage -and -not $Reconcile) {return P01-Result 'UNKNOWN' 'EXPLICIT_FORWARD_RECONCILIATION_REQUIRED' $false}
  if ($StatusOnly) {return P01-Result 'UNKNOWN' 'INCOMPLETE_TRANSACTION' $false}
  # Run the identical pinned package image, keeping installed/staged images exclusive.
  $CE=$Slots.new['config'];$ConfigId=$CE.id
  if ($CE.deleteAccess) {$Path=$CE.full;Close-Entry $CE;$CE=Open-Leaf $Path 65536;Need ($CE.id -ceq $ConfigId) 'CANDIDATE_CONFIG_IDENTITY_CHANGED'}
  P01-CheckCandidate $Package $CE $CP.sha256
  $Path=$CE.full;Close-Entry $CE;$CE=Open-Leaf $Path 65536 $true
  Need ($CE.id -ceq $ConfigId -and (Entry-Hash $CE) -ceq $CP.sha256) 'CANDIDATE_CONFIG_IDENTITY_CHANGED'
  $Slots=P01-Slots $Context $Tuples $Stage
  # Reconcile the sole known gap: completed held rename before its step flush.
  for($I=0;$I -lt $Slots.prefix;$I++) {
   $Path=Join-Path $Stage ('step-'+$I+'.json')
   if (-not (Test-Path -LiteralPath $Path)) {[void](P01-NewLeaf $Path ($Utf8.GetBytes((P01-StepText $Binding $I))))}
  }
  for($I=$Slots.prefix;$I -lt 6;$I++) {
   P01-Layout $Context $true;Need ((P01-Protected $Context) -ceq $Protected) 'PROTECTED_SNAPSHOT_CHANGED';P01-Processes
   $Slots=P01-Slots $Context $Tuples $Stage;Need ($Slots.prefix -eq $I) 'CONCURRENT_PUBLICATION_CHANGED'
   $T=$Tuples[[int][Math]::Floor($I/2)]
   if (($I % 2) -eq 0) {$E=$Slots.old[$T.kind];$Destination=Join-Path $Stage $T.backup}
   else {
    $E=$Slots.new[$T.kind];$Destination=Join-Path $Context.root $T.name
    if (-not $E.deleteAccess) {$Id=$E.id;$Path=$E.full;Close-Entry $E;$E=Open-Leaf $Path 134217728 $true ($T.kind -ceq 'exe');Need ($E.id -ceq $Id) 'PUBLICATION_IDENTITY_CHANGED'}
   }
   $Publication=$true;Rename-Entry $E $Destination
   [void](P01-NewLeaf (Join-Path $Stage ('step-'+$I+'.json')) ($Utf8.GetBytes((P01-StepText $Binding $I))))
  }
  $Slots=P01-Slots $Context $Tuples $Stage;P01-Layout $Context $true
  Need ($Slots.prefix -eq 6 -and (P01-Protected $Context) -ceq $Protected) 'INSTALLED_PAIR_READBACK_FAILED'
  foreach($T in $Tuples) {Need ((P01-PrivateAcl $Slots.new[$T.kind].full) -ceq $OldAcl[$T.kind] -and (P01-PrivateAcl $Slots.old[$T.kind].full) -ceq $OldAcl[$T.kind]) 'INSTALLED_OR_BACKUP_ACL_CHANGED'}
  P01-Journal $Stage $Binding 6 $false;P01-Processes
  [void](P01-NewLeaf (Join-Path $Stage 'COMPLETE.json') ($Utf8.GetBytes($CompleteText)))
  Need ((Entry-Text (Open-Leaf (Join-Path $Stage 'COMPLETE.json') 16384)) -ceq $CompleteText -and (P01-Protected $Context) -ceq $Protected) 'COMPLETE_READBACK_FAILED'
  [void](P01-Slots $Context $Tuples $Stage);P01-Layout $Context $true
  return P01-Result 'COMPLETE' 'PUBLISHED_AND_READ_BACK' $Publication
 } catch {
  $Reason=[string]$_.Exception.Message
  if ($Reason -cnotmatch '^[A-Z][A-Z0-9_]{1,100}$') {$Reason='P01_NATIVE_TRANSACTION_FAILED'}
  $Status=if ($HadStage -or $Publication) {'UNKNOWN'} else {'BLOCKED'};return P01-Result $Status $Reason $Publication
 } finally {
  for($I=$AllEntries.Count-1;$I -ge 0;$I--) {Close-Entry $AllEntries[$I]}
  if ($Held) {$Mutex.ReleaseMutex()};if ($null -ne $Mutex) {$Mutex.Dispose()}
 }
}

function New-P01PinnedContext([string]$PackageRoot,[string]$ManifestPin) {
 $Utf8=New-Object Text.UTF8Encoding($false,$true)
 Need ($ManifestPin -cmatch '^[a-f0-9]{64}$') 'MANIFEST_PIN_REQUIRED'
 $PackageRoot=Local-Path $PackageRoot
 $ManifestPath=Join-Path $PackageRoot 'MANIFEST.json';$Raw=[IO.File]::ReadAllBytes($ManifestPath)
 Need ($Raw.Length -ge 2 -and $Raw.Length -le 65536 -and (P01-HashBytes $Raw) -ceq $ManifestPin) 'PACKAGE_MANIFEST_CHANGED'
 $M=$Utf8.GetString($Raw) | ConvertFrom-Json
 P01-Keys $M @('schema','source','scope','peer','predecessor','startup','native','resources')
 Need ($M.schema -ceq 'COCWIN_P01_PRISTINE_OWNER_KIT_V1') 'PACKAGE_SCHEMA_INVALID'
 P01-Keys $M.source @('appCommit','canonicalCommit','tree')
 foreach($S in @($M.source.appCommit,$M.source.canonicalCommit,$M.source.tree)) {Need ($S -cmatch '^[a-f0-9]{40}$') 'SOURCE_PROOF_INVALID'}
 $Scope=@{appId='cocwin';baseSha='2f17ffcf5d8aefbb7bd3d3e4506f8fee965fd6db';sessionId='exta-4786c8bd94d2feecc1e26a031b0693d6';generation='7e7d5e17-2c44-4094-a6c8-0cf470ed564c'}
 P01-Keys $M.scope @('appId','baseSha','sessionId','generation')
 Need ((P01-Canonical $M.scope) -ceq (P01-Canonical $Scope)) 'ORIGINAL_SCOPE_REQUIRED'
 P01-Keys $M.predecessor @('startup','nativeConfig','nativeManifest','nativeExecutable','ownerMarker')
 $Expected=@{
  startup=@{bytes=1095;sha256='fc4d970903a94d6c49fc6dd5a9edf6f4aec4a61ccbfaf8c149974b203d2649d5'}
  nativeConfig=@{bytes=1553;sha256='648e5d88a3eb3a98dd0c7c2508a7071eeaf642176b3587f5ecd22f4d43e0a70a'}
  nativeManifest=@{bytes=372;sha256='537717d92a24d8cf696e7b506fbdaeb745cbbc6627f16566e346e7c7056424a3'}
  nativeExecutable=@{bytes=87200256;sha256='c4d9317d84dbd7ac2f0d73df3c939fe2452eb6a78e56a142d17c83876228e5ee'}
  ownerMarker=@{bytes=696;sha256='81ab1ca55f715567c56e2efda611f12f23398b68023062db2740bb8e8103d3de'}
 }
 foreach($K in $Expected.Keys) {P01-Keys $M.predecessor.$K @('bytes','sha256');Need ((P01-Canonical $M.predecessor.$K) -ceq (P01-Canonical $Expected[$K])) 'ORIGINAL_PREDECESSOR_REQUIRED'}
 P01-Keys $M.native @('path','bytes','sha256','metadataPath','metadataSha256','sourceCommit','sourceTree')
 Need ($M.native.path -ceq 'native/rbridge-native-host.exe' -and $M.native.metadataPath -ceq 'native/rbridge-native-host.metadata.json' -and $M.native.sha256 -cmatch '^[a-f0-9]{64}$' -and $M.native.metadataSha256 -cmatch '^[a-f0-9]{64}$' -and $M.native.bytes -ge 2 -and $M.native.bytes -le 134217728 -and $M.native.sourceCommit -ceq $M.source.canonicalCommit -and $M.native.sourceTree -ceq $M.source.tree) 'NATIVE_ARTIFACT_PROOF_INVALID'
 P01-Keys $M.startup @('path','bytes','sha256')
 Need ($M.startup.path -ceq 'extension/p01-startup.json' -and @($M.resources).Count -eq 6) 'KIT_RESOURCE_CONTRACT_INVALID'
 $Files=@(@{path=$ManifestPath;bytes=$Raw.Length;sha256=$ManifestPin})
 $Seen=@{}
 foreach($R in @($M.startup)+@($M.resources)) {
  P01-Keys $R @('path','bytes','sha256')
  Need ($R.path -is [string] -and $R.path -cmatch '^extension/[a-zA-Z0-9._/-]+$' -and $R.path -notmatch '(^|/)\.\.?(/|$)' -and $R.path -notmatch '//' -and $R.sha256 -cmatch '^[a-f0-9]{64}$' -and $R.bytes -ge 1 -and $R.bytes -le 134217728) 'KIT_RESOURCE_PIN_INVALID'
  Need (-not $Seen.ContainsKey($R.path)) 'DUPLICATE_KIT_RESOURCE'
  $Seen[$R.path]=$true;$Files+=@{path=(Join-Path $PackageRoot ($R.path.Replace('/','\')));bytes=$R.bytes;sha256=$R.sha256}
 }
 $MetadataPath=Join-Path $PackageRoot 'native\rbridge-native-host.metadata.json'
 $MetadataRaw=[IO.File]::ReadAllBytes($MetadataPath)
 Need ($MetadataRaw.Length -ge 2 -and $MetadataRaw.Length -le 16384 -and (P01-HashBytes $MetadataRaw) -ceq $M.native.metadataSha256) 'NATIVE_METADATA_CHANGED'
 $Meta=$Utf8.GetString($MetadataRaw) | ConvertFrom-Json
 Need ($Meta.schema -ceq 'RBRIDGE_NATIVE_HOST_WINDOWS_SEA_V1' -and $Meta.status -ceq 'PASS' -and $Meta.sha256 -ceq $M.native.sha256) 'NATIVE_METADATA_INVALID'
 $Files+=@{path=$MetadataPath;bytes=$MetadataRaw.Length;sha256=$M.native.metadataSha256}
 $Install=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'COCWIN\RBridge\NativeHost'
 $ConfigRaw=$null
 foreach($Path in @((Join-Path $Install 'rbridge-native-host.config.json'),(Join-Path $Install '.p01-pristine-upgrade\original.config.json'))) {
  if (Test-Path -LiteralPath $Path) {
   $B=[IO.File]::ReadAllBytes($Path)
   if ($B.Length -eq $Expected.nativeConfig.bytes -and (P01-HashBytes $B) -ceq $Expected.nativeConfig.sha256) {$ConfigRaw=$B;break}
  }
 }
 Need ($null -ne $ConfigRaw) 'ORIGINAL_CONFIG_PREIMAGE_REQUIRED'
 $C=$Utf8.GetString($ConfigRaw) | ConvertFrom-Json
 P01-Keys $C @('schema','expectedExtensionId','eventStoreRoot','ssh','v3')
 P01-Keys $C.ssh @('sshPath','host','port','user','identityFile','knownHostsFile')
 P01-Keys $C.v3 @('scope','peerPins','initialHistory');P01-Keys $C.v3.initialHistory @('sequence','eventSha256')
 Need ($C.schema -ceq 'RBRIDGE_NATIVE_HOST_CONFIG_V1' -and $C.expectedExtensionId -ceq 'ebibbijpegoankenmggdnehpoadcophk' -and (P01-Canonical $C.v3.scope) -ceq (P01-Canonical $Scope) -and $C.v3.initialHistory.sequence -eq 0 -and $null -eq $C.v3.initialHistory.eventSha256) 'ORIGINAL_CONFIG_SEMANTICS_REQUIRED'
 Need ([string]::Equals($C.eventStoreRoot,(Join-Path $Install 'events'),[StringComparison]::OrdinalIgnoreCase) -and [string]::Equals($C.ssh.identityFile,(Join-Path $Install 'keys\owner_ed25519'),[StringComparison]::OrdinalIgnoreCase) -and [string]::Equals($C.ssh.knownHostsFile,(Join-Path $Install 'keys\known_hosts.cocwin'),[StringComparison]::OrdinalIgnoreCase)) 'ORIGINAL_PATHS_REQUIRED'
 P01-Keys $M.peer @('peerId','releaseSha','browserInstanceId','browserProfileId','protocolMinor','maxMessageBytes','capabilities')
 Need ($C.v3.peerPins.releaseSha -ceq '931e02d6b771a351e8c4e4977cf25ebf82d12a13' -and $M.peer.releaseSha -ceq $M.source.canonicalCommit) 'PEER_SOURCE_PROOF_INVALID'
 foreach($K in @('peerId','browserInstanceId','browserProfileId','protocolMinor','maxMessageBytes')) {Need ($M.peer.$K -ceq $C.v3.peerPins.$K) 'ORIGINAL_PEER_IDENTITY_REQUIRED'}
 Need (@($M.peer.capabilities).Count -ge @($C.v3.peerPins.capabilities).Count -and @($C.v3.peerPins.capabilities | Where-Object {$_ -cnotin @($M.peer.capabilities)}).Count -eq 0) 'PEER_CAPABILITIES_INVALID'
 $C.v3.peerPins=$M.peer
 $ConfigBytes=$Utf8.GetBytes((P01-Canonical $C)+[char]10)
 $Body=@{schema='RBRIDGE_NATIVE_V3_PEER_OWNER_V1';appId='cocwin';peerPins=$M.peer;initialHistory=$C.v3.initialHistory}
 $Owner=@{schema=$Body.schema;appId=$Body.appId;peerPins=$Body.peerPins;initialHistory=$Body.initialHistory;sha256=(P01-HashBytes ($Utf8.GetBytes((P01-Canonical $Body))))}
 return @{
  root=$Install;packageExecutable=(Join-Path $PackageRoot 'native\rbridge-native-host.exe');packageFiles=$Files
  predecessor=@{'rbridge-native-host.exe'=$Expected.nativeExecutable;'rbridge-native-host.config.json'=$Expected.nativeConfig;'com.cocwin.rbridge_chat_v1.json'=$Expected.nativeManifest;'events\v3-peer-owner.json'=$Expected.ownerMarker}
  targetExecutable=@{bytes=$M.native.bytes;sha256=$M.native.sha256};configBytes=$ConfigBytes;ownerBytes=$Utf8.GetBytes((P01-Canonical $Owner)+[char]10)
  preservedPins=@{
   '.owner-setup-v1.json'=@{bytes=1282;sha256='e29cd6e975dff7d9652d860898c8a839afb2763976490ce9db22e6443673daa5'}
   'rbridge-native-host.config.pre-p01.json'=@{bytes=674;sha256='1f8cab28a5a550b1f6aa166bd5b98c1c8033ed36197d949100fe3ff107085351'}
  }
  registryPaths=@('Software\Google\Chrome\NativeMessagingHosts\com.cocwin.rbridge_chat_v1','Software\Microsoft\Edge\NativeMessagingHosts\com.cocwin.rbridge_chat_v1')
  allowedRootEntries=@('rbridge-native-host.exe','rbridge-native-host.config.json','com.cocwin.rbridge_chat_v1.json','.owner-setup-v1.json','rbridge-native-host.config.pre-p01.json','keys','events')
 }
}
if ($LibraryOnly) {return}
$Result=$null
try {
 $Context=New-P01PinnedContext $PSScriptRoot $ExpectedManifestSha256
 $Result=Invoke-P01NativePristineTransaction -Context $Context -Reconcile:($Mode -ceq 'RECONCILE') -StatusOnly:($Mode -ceq 'STATUS')
} catch {
 $Reason=[string]$_.Exception.Message;if ($Reason -cnotmatch '^[A-Z][A-Z0-9_]{1,100}$') {$Reason='PINNED_PACKAGE_OR_PREDECESSOR_INVALID'}
 $Result=P01-Result 'BLOCKED' $Reason $false
}
$Result | ConvertTo-Json -Depth 8 -Compress
if ($MyInvocation.MyCommand -is [Management.Automation.ExternalScriptInfo]) {
 if ($Result.status -cin @('COMPLETE','NONE')) {exit 0};if ($Result.status -ceq 'UNKNOWN') {exit 3};exit 2
}
