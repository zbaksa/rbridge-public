"""Complete archive byte predicates are Source data, never authenticated origin."""
import copy
import base64
import hashlib
import json
import unittest
from unittest.mock import patch
from _loader import toolkit
from _fixtures import valid_profile


def raw(value):return json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()


class ArchiveCollectorTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.archive_collector import compare_archive_responses,collect_root_archive,verify_root_archive_observation
        except ImportError:self.fail('Concrete complete GitHub archive collector is not implemented')
        from rbridge_installation.profile import parse_profile
        self.compare,self.collect,self.verify=compare_archive_responses,collect_root_archive,verify_root_archive_observation
        self.profile=parse_profile(valid_profile());self.body=' { "legacy": "original ☃ bytes" }\n'
        self.pins={'schema':'RBRIDGE_GITHUB_ARCHIVE_PINS_V1','issue_number':17,
            'request_title':'[COCWIN BRIDGE REQUEST] archive-source-fixture',
            'request_body_sha256':hashlib.sha256(self.body.encode()).hexdigest(),'context_sha256':'c'*64}
        self.url='https://github.com/'+self.profile.binding.repository+'/issues/17'
        self.issue={'number':17,'title':self.pins['request_title'],'body':self.body,'user':{'login':self.profile.binding.author},
            'html_url':self.url,'state':'closed','comments':101,'updated_at':'2026-10-06T01:02:03Z'}
        self.comments=[{'id':1000+i,'user':{'login':self.profile.binding.author},'body':'source archive comment '+str(i),
            'html_url':self.url+'#issuecomment-'+str(1000+i),'created_at':'2026-10-05T01:02:03Z',
            'updated_at':'2026-10-06T01:02:03Z'} for i in range(101)]
        self.viewer=raw({'login':self.profile.binding.author})

    def pages(self,comments=None):
        rows=self.comments if comments is None else comments
        return [raw(rows[i:i+100]) for i in range(0,len(rows),100)]+[b'[]']

    def compare_fixture(self,**changes):
        values={'profile':self.profile,'pins':self.pins,'viewer_json':self.viewer,'before_json':raw(self.issue),
            'first_pages':self.pages(),'second_pages':self.pages(),'after_json':raw(self.issue)}
        values.update(changes);return self.compare(**values)

    def test_complete_two_sweeps_preserve_raw_request_and_every_comment_without_authentication(self):
        from rbridge_installation.models import report_sha256
        capture=self.compare_fixture()
        self.assertEqual(capture['issue']['body'],self.body)
        self.assertEqual([row['id'] for row in capture['comments']],list(range(1000,1101)))
        self.assertEqual(capture['scope'],'FIXTURE_AUTHORITY_ONLY')
        self.assertTrue(capture['complete'])
        self.assertEqual(capture['capture_sha256'],report_sha256({k:v for k,v in capture.items() if k!='capture_sha256'}))
        # Capture authenticates neither result semantics nor trusted publication.
        foreign=copy.deepcopy(self.comments);foreign[0]['user']['login']='other'
        capture=self.compare_fixture(first_pages=self.pages(foreign),second_pages=self.pages(foreign))
        self.assertEqual(capture['comments'][0]['author'],'other')

    def test_short_missing_extra_duplicate_and_nonempty_eof_pages_are_incomplete(self):
        valid=self.pages()
        variants=[valid[:-1],valid+[b'[]'],[raw(self.comments[:99]),raw(self.comments[99:]),b'[]'],
            [valid[0],valid[1],raw([self.comments[-1]])]]
        duplicate=copy.deepcopy(self.comments);duplicate[-1]=copy.deepcopy(duplicate[0]);variants.append(self.pages(duplicate))
        reverse=copy.deepcopy(self.comments);reverse[0],reverse[1]=reverse[1],reverse[0];variants.append(self.pages(reverse))
        for pages in variants:
            with self.subTest(pages=len(pages)):self.assertRaises(ValueError,self.compare_fixture,first_pages=pages)
        empty={**self.issue,'comments':0}
        self.assertEqual(self.compare_fixture(before_json=raw(empty),after_json=raw(empty),first_pages=[b'[]'],second_pages=[b'[]'])['comments'],[])

    def test_comment_edit_timestamp_body_or_identity_drift_blocks_even_when_issue_count_is_stable(self):
        for field,value in (('body','edited'),('updated_at','2026-10-06T01:02:04Z'),
                ('created_at','2026-10-05T01:02:04Z'),('html_url',self.url+'#issuecomment-999')):
            changed=copy.deepcopy(self.comments);changed[0][field]=value
            with self.subTest(field=field):self.assertRaises(ValueError,self.compare_fixture,second_pages=self.pages(changed))
        changed={**self.issue,'updated_at':'2026-10-06T01:02:04Z'}
        self.assertRaises(ValueError,self.compare_fixture,after_json=raw(changed))

    def test_request_viewer_repository_pr_url_and_numeric_aliases_cannot_be_rehashed_into_pass(self):
        for field,value in (('number',True),('number',17.0),('body',self.body+' '),('title','other'),
                ('user',{'login':'other'}),('html_url','https://github.com/other/repo/issues/17'),
                ('pull_request',{}),('comments',True),('updated_at','2026-02-30T00:00:00Z')):
            changed={**self.issue,field:value}
            with self.subTest(field=field,value=value):self.assertRaises(ValueError,self.compare_fixture,before_json=raw(changed),after_json=raw(changed))
        self.assertRaises(ValueError,self.compare_fixture,viewer_json=raw({'login':'other'}))
        for pins in ({**self.pins,'issue_number':True},{**self.pins,'context_sha256':'not-a-hash'},{**self.pins,'extra':1}):
            self.assertRaises(ValueError,self.compare_fixture,pins=pins)

    def test_duplicate_json_invalid_utf8_unbounded_body_and_comment_are_rejected_without_partial_output(self):
        for value in (b'{"login":"other","login":"zbaksa"}',b'\xff',raw({'login':float('nan')})):
            self.assertRaises(ValueError,self.compare_fixture,viewer_json=value)
        for field,value in (('body','x'*65537),('body','bad\0text'),('id',True),('updated_at','not-a-date')):
            changed=copy.deepcopy(self.comments);changed[0][field]=value
            self.assertRaises(ValueError,self.compare_fixture,first_pages=self.pages(changed),second_pages=self.pages(changed))
        self.assertRaises(ValueError,self.compare_fixture,first_pages=[b' '*8519681])

    def test_source_context_and_caller_serialized_tokens_never_open_root_paths_or_authenticate(self):
        with patch('rbridge_installation.archive_collector.os.open',side_effect=AssertionError('Source Root open')), \
             patch('rbridge_installation.archive_collector.QualifiedGitHubReadBackend',side_effect=AssertionError('Source GitHub auth')):
            self.assertRaisesRegex(ValueError,'ARCHIVE_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.collect,
                self.profile,None,None,self.pins,{'python_closure_sha256':'d'*64})
        from rbridge_installation.archive_collector import _RootArchiveObservation
        token=_RootArchiveObservation('a'*64,'{}','{}','{}','{}')
        for value in (token,{'scope':'ROOT_AUTHENTICATED_ARCHIVE_BYTES','status':'PASS'}):
            with patch('rbridge_installation.archive_collector.os.open',side_effect=AssertionError('Caller Root open')):
                self.assertRaisesRegex(ValueError,'ARCHIVE_COLLECTOR_ORIGIN_UNQUALIFIED',self.verify,
                    self.profile,value,None,None,{'python_closure_sha256':'d'*64})

    def test_full_query_preimages_use_existing_session_contract_without_invented_stderr_digest(self):
        from rbridge_installation.archive_collector import _query_bytes
        argv=['/usr/bin/gh','--version'];input_bytes=b'';output=b'fixture-version\n';errors=b'warning bytes\n'
        # Pure Source metadata: neither this fabricated proof nor its labels mint origin.
        session={'status':'PASS','scope':'ROOT_FIXED_PROCESS_OBSERVATION','exit_code':0,'live_helpers':[],
            'argv':argv,'input_sha256':hashlib.sha256(input_bytes).hexdigest(),'output_sha256':hashlib.sha256(output).hexdigest()}
        query={'argv':argv,'input_base64':base64.b64encode(input_bytes).decode(),
            'output_base64':base64.b64encode(output).decode(),'stderr_base64':base64.b64encode(errors).decode(),'session':session}
        self.assertEqual(_query_bytes(query),(input_bytes,output))
        for field,value in (('output_base64',base64.b64encode(output+b'x').decode()),
                ('stderr_base64',query['stderr_base64']+'\n'),('argv',argv+['extra'])):
            self.assertRaises(ValueError,_query_bytes,{**query,field:value})


if __name__=='__main__':unittest.main()
