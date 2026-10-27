# Windows SSH path compatibility

The owner Native Host is installed and the actual public key is enrolled with a restricted fixed command. The Windows installer records native drive-absolute paths, while buildSshStdioLaunch currently accepts only slash-rooted POSIX paths. Validate that suspected launch failure on real Windows before changing production.

Owner already opted out of renewed design/approval questions. Chosen: repair only the existing SSH launch path boundary using the actual operating system. Keep the same Native/SSH/fixed command route; no generic shell, alternate executable selector, new daemon or invented V3 scope/history. Alternatives of rewriting installed paths into fake POSIX paths or bypassing Native were rejected because Windows spawn needs the real executable and private identity locations.

On Windows accept canonical local drive-absolute paths in sshPath, identityFile and knownHostsFile; preserve each exact string in the shell:false argv launch. Reject drive-relative, rooted-current-drive, UNC/device, ADS, noncanonical traversal, NUL and newline paths. Preserve existing Linux behavior and fixed remote command/user/host/port/host-key/authentication options. Native config validation, file ownership, profile/history and production activation are unchanged.

Prove Windows-format input through the real builder, negative path matrices and the actual installed Windows OpenSSH executable. Keep owner installation/authentication, synthetic CI, packaged executable publication, source integration and live CHAT separate. Existing owner executable remains pinned to the old hash until an independently qualified update; no silent replacement or receipt rewriting.
