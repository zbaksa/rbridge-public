import importlib.util
import sys
from pathlib import Path

def load_toolkit(package_root: Path):
    spec = importlib.util.spec_from_file_location('rbridge_installation', package_root / '__init__.py', submodule_search_locations=[str(package_root)])
    if spec is None or spec.loader is None:
        raise ImportError('Toolkit package unavailable')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module

ROOT = Path(__file__).resolve().parents[2]

def toolkit():
    return load_toolkit(ROOT / 'ops/install/rbridge_installation')
