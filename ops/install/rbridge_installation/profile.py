import re
from .models import ProfileError, record

def parse_profile(value):
    try:
        profile = record('Profile', value)
        b = profile.binding
        if b.mcp_subject != f'uid:{b.uid}' or b.github_subject != f'{b.repository}:{b.author}': raise ValueError()
        if b.account != 'rbridge' or b.home != '/home/rbridge': raise ValueError()
        if tuple(sorted(set(b.supplementary_gids))) != b.supplementary_gids or 0 in b.supplementary_gids: raise ValueError()
        if not re.fullmatch(r'3\.(1[1-9]|[2-9][0-9])\.[0-9]+', profile.toolkit.python_version): raise ValueError()
        if profile.toolkit.source_sha == profile.runtime.source_sha: raise ValueError()
        paths = [b.home, profile.runtime.node_path, profile.runtime.npm_cli_path, profile.toolkit.python_path]
        paths += [getattr(profile.paths, k) for k in value['paths']]
        paths += [t.path for t in profile.tools] + [e.path for e in profile.service.environment_files] + [r.entrypoint for r in profile.readers]
        for path in paths:
            if not path.startswith('/') or path == '/' or any(part in ('', '.', '..') for part in path.split('/')[1:]) or any(c in path for c in '\x00\r\n'): raise ValueError()
        roles = [t.role for t in profile.tools]
        if len(roles) != 3 or set(roles) != {'systemctl', 'gh', 'runuser'}: raise ValueError()
        env = [e.path for e in profile.service.environment_files]
        if len(set(env)) != len(env) or profile.paths.binding_env in env: raise ValueError()
        if profile.paths.state_root != b.home + '/.local/state/rbridge': raise ValueError()
        if not profile.paths.canary_path.startswith(b.home + '/'): raise ValueError()
        if len(set(r.reader_id for r in profile.readers)) != len(profile.readers): raise ValueError()
        return profile
    except (ValueError, TypeError, KeyError, AttributeError, UnicodeError):
        raise ProfileError('PROFILE_INVALID') from None
