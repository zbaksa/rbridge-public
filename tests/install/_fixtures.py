import json
from _loader import ROOT

def valid_profile():
    return json.loads((ROOT / 'tests/fixtures/rbridge-install-profile.json').read_text())

def profile_with(**changes):
    value = valid_profile()
    for key, change in changes.items():
        section = 'binding' if key in value['binding'] else 'runtime'
        value[section][key] = change
    return value

def runtime_stage(root):
    files={
        'package.json':json.dumps({'type':'module','dependencies':{'fixture-dependency':'1.0.0'}}),
        'package-lock.json':'{}',
        'dist/server/server/remoteBridgeMain.js':"import 'fixture-dependency';\n",
        'dist/server/server/rbridgeMcpMain.js':"import 'fixture-dependency';\n",
        'node_modules/fixture-dependency/package.json':'{"name":"fixture-dependency","version":"1.0.0"}',
        'node_modules/fixture-dependency/index.js':'export default 1;\n'}
    for name,content in files.items():
        p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(content)
