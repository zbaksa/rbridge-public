"""Cold bootstrap entry Source boundaries; no physical Root qualification."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from _loader import ROOT


class BootstrapEntryTests(unittest.TestCase):
    def setUp(self):
        self.path=ROOT/'ops/install/rbridge_bootstrap.py'
        spec=importlib.util.spec_from_file_location('cold_bootstrap_source_fixture',self.path)
        self.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.module)

    def test_production_copy_location_is_fixed_and_never_execution_authority(self):
        predicate=getattr(self.module,'_production_bootstrap_path',None)
        self.assertIsNotNone(predicate,'The production copy location predicate is absent')
        path='/var/lib/rbridge-maintenance/bootstrap-'+'a'*64+'/payload.py'
        self.assertEqual(predicate(path),Path(path))
        for value in (path.replace('rbridge-maintenance','caller'),path.replace('payload.py','other.py'),
                path.replace('a'*64,'A'*64),path.replace('a'*64,'a'*63),
                '/root/.rbridge-bootstrap-fixture-'+'b'*32+'/bootstrap-'+'a'*64+'/payload.py',
                path.replace('/bootstrap-','/../bootstrap-'),None):
            with self.subTest(value=value):self.assertRaises(ValueError,predicate,value)

    def test_source_entry_context_refuses_before_protected_file_or_input_io(self):
        context=getattr(self.module,'_entry_context',None)
        self.assertIsNotNone(context,'The cold protected entry context is absent')
        with patch('os.open',side_effect=AssertionError('Source Root open')), \
             patch('os.read',side_effect=AssertionError('Source input read')):
            self.assertRaisesRegex(ValueError,'BOOTSTRAP_ENTRY_CONTEXT_UNQUALIFIED',context,'prepare')

    def test_unknown_operation_refuses_before_context_or_root_io(self):
        dispatch=getattr(self.module,'_run_protected_entry',None)
        self.assertIsNotNone(dispatch,'The fixed protected entry dispatcher is absent')
        with patch('os.open',side_effect=AssertionError('Unknown Root open')), \
             patch('os.read',side_effect=AssertionError('Unknown input read')):
            for operation in ('exec','--exec','--qualification-fixture','',None):
                self.assertRaisesRegex(ValueError,'BOOTSTRAP_ENTRY_OPERATION_INVALID',dispatch,operation)

    def test_synthetic_context_drift_refuses_before_kernel_input_or_root_io(self):
        # These supplied context fields are negative predicate data only. The
        # kernel observer is forbidden; no positive Root context is simulated.
        path='/var/lib/rbridge-maintenance/bootstrap-'+'a'*64+'/payload.py'
        clean={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':'/root','LC_ALL':'C'}
        cases=[({'PATH':'/tmp/caller/bin'},'/',[path,'prepare']),
               ({'HOME':'/home/caller'},'/',[path,'prepare']),
               ({'LC_ALL':'en_US.UTF-8'},'/',[path,'prepare']),
               ({'RBRIDGE_BOOTSTRAP_NONCE':'b'*64},'/',[path,'prepare']),
               ({'PYTHONPATH':'/tmp/caller'},'/',[path,'prepare']),
               ({},'/tmp',[path,'prepare']),({},'/',[path,'prepare','--exec'])]
        for drift,cwd,argv in cases:
            with self.subTest(drift=drift,cwd=cwd,argv=argv), \
                 patch.object(self.module,'__file__',path), \
                 patch.object(self.module.sys,'flags',SimpleNamespace(isolated=1,no_site=1,dont_write_bytecode=1)), \
                 patch.object(self.module.sys,'argv',argv),patch('os.getuid',return_value=0), \
                 patch('os.geteuid',return_value=0),patch('os.getcwd',return_value=cwd), \
                 patch.dict('os.environ',{**clean,**drift},clear=True), \
                 patch.object(self.module,'_fixture_namespace',side_effect=AssertionError('No positive kernel observation')), \
                 patch('os.open',side_effect=AssertionError('Drift Root open')), \
                 patch('os.read',side_effect=AssertionError('Drift input read')):
                self.assertRaisesRegex(ValueError,'BOOTSTRAP_ENTRY_CONTEXT_UNQUALIFIED',self.module._entry_context,'prepare')

    def test_each_known_source_cli_operation_refuses_its_context_without_consuming_input(self):
        for operation in ('prepare','check','apply','resume','status'):
            result=subprocess.run([sys.executable,'-I','-S','-B',str(self.path),operation],
                stdin=subprocess.DEVNULL,text=True,capture_output=True,cwd='/',timeout=5,
                env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':'/root','LC_ALL':'C'})
            with self.subTest(operation=operation):
                self.assertEqual(result.returncode,2);value=json.loads(result.stdout)
                self.assertEqual(value['status'],'BLOCKED');self.assertFalse(value['may_execute'])
                self.assertEqual(value['reason_codes'],['BOOTSTRAP_ENTRY_CONTEXT_UNQUALIFIED'])

    def source_input(self,raw):
        # The unprivileged Source reader parses DATA ONLY; it invokes no context,
        # toolkit loader, custody factory or installation dispatcher.
        code=('import importlib.util,json; s=importlib.util.spec_from_file_location("source_input",'+repr(str(self.path))+'); '
              'm=importlib.util.module_from_spec(s); s.loader.exec_module(m); '
              'print(json.dumps(m._entry_input(),sort_keys=True))')
        return subprocess.run([sys.executable,'-I','-S','-B','-c',code],input=raw,
            text=True,capture_output=True,timeout=5)

    def test_source_input_accepts_only_explicit_entry_fields_as_data(self):
        value={'profile':{},'qualification':{},'authorization':{},'transaction_id':'a'*32}
        result=self.source_input(json.dumps(value))
        self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(json.loads(result.stdout),value)

    def test_source_input_rejects_duplicates_nonfinite_missing_and_foreign_fields(self):
        for raw in ('{"profile":{},"profile":{},"qualification":{}}',
                '{"profile":{},"qualification":{"x":NaN}}','null','{}',
                '{"profile":{},"qualification":{},"exec":"/bin/sh"}'):
            with self.subTest(raw=raw):
                result=self.source_input(raw)
                self.assertNotEqual(result.returncode,0)
                self.assertNotIn('AttributeError',result.stderr,'The input reader is absent')


if __name__=='__main__':unittest.main()
