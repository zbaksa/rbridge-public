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
