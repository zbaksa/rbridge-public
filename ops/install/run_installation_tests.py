#!/usr/bin/env python3
"""Explicit test loader only; not an installation or host-action entrypoint."""
from pathlib import Path
import sys
import unittest

if sys.version_info < (3, 11):
    raise SystemExit('INSTALLATION_TEST_PYTHON_UNSUPPORTED')
root = Path(__file__).resolve().parents[2]
suite = unittest.TestLoader().discover(str(root / 'tests/install'), pattern='test_*.py')
result = unittest.TextTestRunner(verbosity=2).run(suite)
raise SystemExit(0 if result.wasSuccessful() else 1)
