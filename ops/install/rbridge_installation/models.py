"""Strict shared contracts. Filesystem actions live in separate modules."""
from dataclasses import make_dataclass, fields, field, is_dataclass
from pathlib import Path
import hashlib
import json
import re

class InstallationError(ValueError):
    def __init__(self, reason):
        if not re.fullmatch(r'[A-Z][A-Z0-9_]{0,95}', reason):
            reason = 'INVALID_REASON_CODE'
        self.reason = reason
        super().__init__(reason)

class ProfileError(InstallationError): pass
class ArtifactError(InstallationError): pass
class CopyError(InstallationError): pass
class PauseError(InstallationError): pass
class ConfigError(InstallationError): pass
class BootstrapError(InstallationError): pass

CONTRACT = json.loads((Path(__file__).resolve().parents[3] / 'docs/contracts/P2A_INSTALLATION_TOOLKIT_V1.json').read_text())

def validate_contract(value, name):
    def check(v, rule, depth=0):
        if depth > 64: raise ValueError('CONTRACT_DEPTH')
        if '$ref' in rule: return check(v, CONTRACT['$defs'][rule['$ref'].split('/')[-1]], depth+1)
        if 'const' in rule and (type(v) != type(rule['const']) or v != rule['const']): raise ValueError('CONTRACT_CONST')
        if 'enum' in rule and v not in rule['enum']: raise ValueError('CONTRACT_ENUM')
        kind = rule.get('type')
        if kind == 'object':
            if type(v) != dict or set(v) - set(rule['properties']) or not set(rule['required']) <= set(v): raise ValueError('CONTRACT_FIELDS')
            for key, val in v.items(): check(val, rule['properties'][key], depth+1)
        elif kind == 'array':
            if type(v) not in (list, tuple) or len(v) > rule['maxItems']: raise ValueError('CONTRACT_ARRAY')
            for item in v: check(item, rule['items'], depth+1)
        elif kind == 'string':
            if type(v) != str: raise ValueError('CONTRACT_STRING')
            v.encode('utf-8', errors='strict')
            if 'pattern' in rule and not re.fullmatch(rule['pattern'], v): raise ValueError('CONTRACT_PATTERN')
            if len(v) < rule.get('minLength', 0) or len(v) > rule.get('maxLength', 4096): raise ValueError('CONTRACT_LENGTH')
        elif kind == 'integer':
            if type(v) != int or v < rule.get('minimum', 0) or v > rule.get('maximum', 9007199254740991): raise ValueError('CONTRACT_INTEGER')
    check(value, CONTRACT['$defs'][name])

def _plain(value, depth=0):
    if depth > 64: raise ValueError('REPORT_DEPTH')
    if is_dataclass(value): value = {f.name: getattr(value, f.name) for f in fields(value) if not (f.metadata.get('optional') and getattr(value, f.name) is None)}
    if type(value) == dict:
        if any(type(k) != str for k in value): raise ValueError('REPORT_KEY')
        return {k: _plain(v, depth+1) for k, v in value.items()}
    if type(value) in (tuple, list): return [_plain(v, depth+1) for v in value]
    if value is None or type(value) in (bool, str): return value
    if type(value) == int and abs(value) <= 9007199254740991: return value
    raise ValueError('REPORT_NUMBER_OR_TYPE')

def encode_report(value):
    return json.dumps(_plain(value), ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')

def report_sha256(value): return hashlib.sha256(encode_report(value)).hexdigest()

# Frozen typed records are generated from the one schema, preventing field drift.
for _name, _rule in CONTRACT['$defs'].items():
    if _rule.get('type') == 'object':
        globals()[_name] = make_dataclass(_name, [(key, object) if key in _rule['required'] else (key, object, field(default=None, metadata={'optional': True})) for key in _rule['properties']], frozen=True)

def record(name, value):
    validate_contract(value, name)
    def convert(v, rule):
        if '$ref' in rule: return record(rule['$ref'].split('/')[-1], v)
        if rule.get('type') == 'array': return tuple(convert(x, rule['items']) for x in v)
        return v
    spec = CONTRACT['$defs'][name]
    return globals()[name](**{k: convert(v, spec['properties'][k]) for k, v in value.items()})
