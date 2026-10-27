#!/usr/bin/env bash
set -Eeuo pipefail
[ "$(id -u)" -ne 0 ]
# Reject a conflicting pre-existing tag before any release or asset write.
if gh api repos/zbaksa/rbridge-public/git/ref/tags/cocwin-windows-11c6723 > existing-tag.json 2> tag-lookup.err; then
  python3 - <<'PY'
import json
v=json.load(open('existing-tag.json'))
assert v['object']['type']=='commit' and v['object']['sha']=='11c67238e4d1998e0fab166da048c655b478a1d6'
PY
else
  if ! grep -Fq '(HTTP 404)' tag-lookup.err; then cat tag-lookup.err >&2; exit 1; fi
fi
# A valid permanent publication must not depend on an expired Actions artifact.
if gh api repos/zbaksa/rbridge-public/releases/tags/cocwin-windows-11c6723 > release.json 2> release-lookup.err; then
  python3 - <<'PY'
import json
v=json.load(open('release.json'))
assert v['tag_name']=='cocwin-windows-11c6723' and v['draft'] is False
assert v['target_commitish']=='11c67238e4d1998e0fab166da048c655b478a1d6'
assert len(v['assets'])==1 and v['assets'][0]['name']=='rbridge-windows-11c6723.zip'
assert v['assets'][0]['digest']=='sha256:0e614e0f143bb49db4e2e2807a9ebde4e6796e5adcf7425ff08762bd240b4af0'
PY
else
  if ! grep -Fq '(HTTP 404)' release-lookup.err; then cat release-lookup.err >&2; exit 1; fi
  gh api repos/zbaksa/rbridge-public/actions/runs/40517709746 > source-run.json
  python3 - <<'PY'
import json
v=json.load(open('source-run.json'))
assert v['head_sha']=='11c67238e4d1998e0fab166da048c655b478a1d6' and v['status']=='completed' and v['conclusion']=='success'
PY
  gh api repos/zbaksa/rbridge-public/actions/artifacts/12741520050 > source-artifact.json
  python3 - <<'PY'
import json
v=json.load(open('source-artifact.json'))
assert v['id']==12741520050 and v['expired'] is False and v['size_in_bytes']==34357300
assert v['workflow_run']['head_sha']=='11c67238e4d1998e0fab166da048c655b478a1d6'
assert v['digest']=='sha256:0e614e0f143bb49db4e2e2807a9ebde4e6796e5adcf7425ff08762bd240b4af0'
PY
  gh api repos/zbaksa/rbridge-public/actions/artifacts/12741520050/zip > rbridge-windows-11c6723.zip
  python3 - <<'PY'
import hashlib,zipfile
raw=open('rbridge-windows-11c6723.zip','rb').read()
assert len(raw)==34357300 and hashlib.sha256(raw).hexdigest()=='0e614e0f143bb49db4e2e2807a9ebde4e6796e5adcf7425ff08762bd240b4af0'
with zipfile.ZipFile('rbridge-windows-11c6723.zip') as z:
    assert sorted(z.namelist())==sorted(['dist-native-host/rbridge-native-host.exe','dist-native-host/rbridge-native-host.metadata.json','dist-native-host/install-native-host-windows.ps1','dist-extension/manifest.json','dist-extension/contentScript.js','dist-extension/serviceWorker.js'])
PY
  gh release create cocwin-windows-11c6723 rbridge-windows-11c6723.zip --repo zbaksa/rbridge-public --target 11c67238e4d1998e0fab166da048c655b478a1d6 --prerelease --title "COCWIN qualified Windows Native package 11c6723" --notes "Exact original qualified Actions archive12741520050/run40517709746. ZIP SHA2560e614e0f143bb49db4e2e2807a9ebde4e6796e5adcf7425ff08762bd240b4af0. Only Native executable/metadata/installer and unchanged legacy extension files; no owner configuration, identity, history or credentials. No live authentication or CHAT acceptance claimed."
fi
# Retain independent final target readback after either path.
gh api repos/zbaksa/rbridge-public/git/ref/tags/cocwin-windows-11c6723 > published-tag.json
python3 - <<'PY'
import json
v=json.load(open('published-tag.json'))
assert v['object']['type']=='commit' and v['object']['sha']=='11c67238e4d1998e0fab166da048c655b478a1d6'
print('QUALIFIED_WINDOWS_PUBLIC_PACKAGE=PASS SOURCE=11c67238e4d1998e0fab166da048c655b478a1d6')
PY
