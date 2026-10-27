#!/usr/bin/env bash
set -Eeuo pipefail
[ "$(id -u)" -ne 0 ]
# Reject a conflicting pre-existing tag before any release or asset write.
if gh api repos/zbaksa/rbridge-public/git/ref/tags/cocwin-windows-34871a7 > existing-tag.json 2> tag-lookup.err; then
  python3 - <<'PY'
import json
v=json.load(open('existing-tag.json'))
assert v['object']['type']=='commit' and v['object']['sha']=='34871a7ece320f78344a4416d6ead4cbafde88c3'
PY
else
  if ! grep -Fq '(HTTP 404)' tag-lookup.err; then cat tag-lookup.err >&2; exit 1; fi
fi
# A valid permanent publication must not depend on an expired Actions artifact.
if gh api repos/zbaksa/rbridge-public/releases/tags/cocwin-windows-34871a7 > release.json 2> release-lookup.err; then
  python3 - <<'PY'
import json
v=json.load(open('release.json'))
assert v['tag_name']=='cocwin-windows-34871a7' and v['draft'] is False
assert v['target_commitish']=='34871a7ece320f78344a4416d6ead4cbafde88c3'
assert len(v['assets'])==1 and v['assets'][0]['name']=='rbridge-windows-34871a7.zip'
assert v['assets'][0]['digest']=='sha256:9afb6a22737f3b2d446684240051477096924e55e4d688b5f2feef70e8ef3350'
PY
else
  if ! grep -Fq '(HTTP 404)' release-lookup.err; then cat release-lookup.err >&2; exit 1; fi
  gh api repos/zbaksa/rbridge-public/actions/runs/40471720486 > source-run.json
  python3 - <<'PY'
import json
v=json.load(open('source-run.json'))
assert v['head_sha']=='34871a7ece320f78344a4416d6ead4cbafde88c3' and v['status']=='completed' and v['conclusion']=='success'
PY
  gh api repos/zbaksa/rbridge-public/actions/artifacts/12718921370 > source-artifact.json
  python3 - <<'PY'
import json
v=json.load(open('source-artifact.json'))
assert v['id']==12718921370 and v['expired'] is False and v['size_in_bytes']==34356996
assert v['workflow_run']['head_sha']=='34871a7ece320f78344a4416d6ead4cbafde88c3'
assert v['digest']=='sha256:9afb6a22737f3b2d446684240051477096924e55e4d688b5f2feef70e8ef3350'
PY
  gh api repos/zbaksa/rbridge-public/actions/artifacts/12718921370/zip > rbridge-windows-34871a7.zip
  python3 - <<'PY'
import hashlib,zipfile
raw=open('rbridge-windows-34871a7.zip','rb').read()
assert len(raw)==34356996 and hashlib.sha256(raw).hexdigest()=='9afb6a22737f3b2d446684240051477096924e55e4d688b5f2feef70e8ef3350'
with zipfile.ZipFile('rbridge-windows-34871a7.zip') as z:
    assert sorted(z.namelist())==sorted(['dist-native-host/rbridge-native-host.exe','dist-native-host/rbridge-native-host.metadata.json','dist-native-host/install-native-host-windows.ps1','dist-extension/manifest.json','dist-extension/contentScript.js','dist-extension/serviceWorker.js'])
PY
  gh release create cocwin-windows-34871a7 rbridge-windows-34871a7.zip --repo zbaksa/rbridge-public --target 34871a7ece320f78344a4416d6ead4cbafde88c3 --prerelease --title "COCWIN qualified Windows Native package 34871a7" --notes "Exact original qualified Actions archive12718921370/run40471720486. ZIP SHA2569afb6a22737f3b2d446684240051477096924e55e4d688b5f2feef70e8ef3350. Only Native executable/metadata/installer and unchanged legacy extension files; no owner configuration, identity, history or credentials. No live authentication or CHAT acceptance claimed."
fi
# Retain independent final target readback after either path.
gh api repos/zbaksa/rbridge-public/git/ref/tags/cocwin-windows-34871a7 > published-tag.json
python3 - <<'PY'
import json
v=json.load(open('published-tag.json'))
assert v['object']['type']=='commit' and v['object']['sha']=='34871a7ece320f78344a4416d6ead4cbafde88c3'
print('QUALIFIED_WINDOWS_PUBLIC_PACKAGE=PASS SOURCE=34871a7ece320f78344a4416d6ead4cbafde88c3')
PY
