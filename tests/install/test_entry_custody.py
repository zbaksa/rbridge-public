"""The entry accepts a custody locator only through the actual protected factory."""
import importlib.util
import unittest
from unittest.mock import patch
from _loader import toolkit,ROOT
from _fixtures import valid_profile

toolkit()


class EntryCustodyTests(unittest.TestCase):
    def setUp(self):
        spec=importlib.util.spec_from_file_location('entry_custody_source_fixture',ROOT/'ops/install/rbridge_install.py')
        self.entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.entry)
        self.value={'profile':valid_profile(),'qualification':{'python_closure_sha256':'a'*64,
            'custody':{'scope':'SOURCE_SIGNED_DATA_ONLY','status':'PASS'}}}

    def test_serialized_old_pass_or_qualification_scope_is_refused_before_root_factory(self):
        from rbridge_installation import qualification_custody as c
        with patch.object(c,'open_root_qualification_custody',side_effect=AssertionError('Old data must not reach Root factory')), \
             patch('os.open',side_effect=AssertionError('Old data Root open')):
            for data in ({'scope':'QUALIFIED_ROOT_BUNDLE','status':'PASS'},
                    {'python_closure_sha256':'a'*64},{'python_closure_sha256':'a'*64,'custody':{},'may_execute':True}):
                self.assertRaisesRegex(self.entry.EntryError,'QUALIFICATION_CUSTODY_INPUT_REQUIRED',
                    self.entry.dispatch,'prepare',{**self.value,'qualification':data})

    def test_source_custody_input_reaches_actual_context_refusal_before_root_io(self):
        with patch('os.open',side_effect=AssertionError('Source entry Root open')):
            for operation in ('prepare','check','status','resume'):
                value={**self.value,'transaction_id':'b'*32} if operation in ('status','resume') else self.value
                self.assertRaisesRegex(ValueError,'QUALIFICATION_CUSTODY_ROOT_CONTEXT_UNQUALIFIED',
                    self.entry.dispatch,operation,value)

    def test_direct_unknown_operation_never_reaches_factory_or_transaction(self):
        from rbridge_installation import qualification_custody as c
        with patch.object(c,'open_root_qualification_custody',side_effect=AssertionError('Unknown Root operation')), \
             patch('os.open',side_effect=AssertionError('Unknown Root open')):
            self.assertRaisesRegex(self.entry.EntryError,'OPERATION_NOT_APPROVED',self.entry.dispatch,'exec',self.value)

    def test_missing_switch_authorization_or_resume_id_refuses_before_custody_io(self):
        from rbridge_installation import qualification_custody as c
        with patch.object(c,'open_root_qualification_custody',side_effect=AssertionError('Invalid Root action factory')), \
             patch('os.open',side_effect=AssertionError('Invalid Root action open')):
            self.assertRaisesRegex(self.entry.EntryError,'SWITCH_AUTHORIZATION_MISSING',self.entry.dispatch,'apply',self.value)
            for operation in ('resume','status'):
                self.assertRaisesRegex(self.entry.EntryError,'TRANSACTION_ID_INVALID',self.entry.dispatch,operation,self.value)


if __name__=='__main__':unittest.main()
