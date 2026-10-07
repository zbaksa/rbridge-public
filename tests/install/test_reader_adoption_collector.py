"""Owner adoption data does not authenticate itself or register Root origin."""
import copy
import hashlib
import unittest
from unittest.mock import patch
from _loader import toolkit
from _fixtures import valid_profile

toolkit()
from rbridge_installation.models import encode_report,report_sha256
from rbridge_installation.profile import parse_profile


def adoption_data():
    fixtures={'cases':[{'fixture_id':'source-'+str(n),'case_id':'C0'+str(n)} for n in range(1,10)]}
    registrations=[];adoptions=[];invocations=[]
    base=valid_profile();root=base['paths']['release_parent']+'/toolkit-'+base['toolkit']['source_sha']
    for transport,cases in (('GITHUB',['C0'+str(n) for n in range(1,9)]),('MCP',['C09'])):
        ident='source-'+transport.lower();entry=root+'/dist/server/cli/rbridgeReadResult.js'
        rows=[{'reader_id':ident,'fixture_id':'source-'+case,'case_id':case,'input_json':'{}','verdict_json':'{}',
            'input_sha256':hashlib.sha256(b'{}').hexdigest(),'output_sha256':hashlib.sha256(b'{}').hexdigest(),
            'scope':'QUALIFIED_INSTALLED_READER'} for case in cases]
        adoption={'schema':'RBRIDGE_READER_ADOPTION_V1','reader_id':ident,'owner':'source-workflow-owner',
            'workflow':'source-readonly-'+transport.lower(),'entrypoint':entry,'source_sha256':'a'*64,'version':'1',
            'trusted_context_sha256':'b'*64,'fixture_set_sha256':report_sha256(fixtures),'adopted_at':'2026-10-06T00:00:00.000Z'}
        registrations.append({'reader_id':ident,'source_sha256':'a'*64,'entrypoint':entry,'version':'1','transport':transport,
            'trusted_context_sha256':'b'*64,'qualification_sha256':report_sha256(rows),'adoption_sha256':report_sha256(adoption)})
        adoptions.append(adoption);invocations.extend(rows)
    base['readers']=registrations;p=parse_profile(base)
    registry={'readers':registrations,'adoptions':adoptions}
    report={'schema':'RBRIDGE_READER_QUALIFICATION_V1','referenceAcceptance':'PASS','actualAcceptance':'PASS',
        'reason_codes':[],'acceptedCases':['C0'+str(n) for n in range(1,10)],'invocations':invocations}
    receipt={'schema':'RBRIDGE_OWNER_READER_ADOPTION_RECEIPT_V1','decision':'ADOPTED_FOR_P2A_ACCEPTANCE',
        'profile_sha256':report_sha256(p),'registry':registry,'report_sha256':report_sha256(report),
        'fixture_set_sha256':report_sha256(fixtures),'consumer_inventory':'OWNER_DECLARED_COMPLETE_FOR_THIS_DEPLOYMENT'}
    capture={'schema':'RBRIDGE_READER_ADOPTION_CAPTURE_V1','repository':p.binding.repository,'viewer':p.binding.author,
        'author':p.binding.author,'issue_number':17,'is_pull_request':False,
        'url':'https://github.com/'+p.binding.repository+'/issues/17','body':encode_report(receipt).decode()}
    return p,registry,report,fixtures,capture


class ReaderAdoptionDataTests(unittest.TestCase):
    def setUp(self):
        try:
            from rbridge_installation.reader_adoption_collector import compare_reader_adoption
        except ImportError:self.fail('Full reader adoption comparison is absent')
        self.compare=compare_reader_adoption;self.p,self.registry,self.report,self.fixtures,self.capture=adoption_data()

    def test_complete_owner_receipt_is_only_data_and_preserves_original_bytes(self):
        result=self.compare(self.p,self.registry,self.report,self.fixtures,self.capture)
        self.assertEqual(result['scope'],'READER_ADOPTION_DATA_ONLY');self.assertEqual(result['status'],'PASS')
        self.assertEqual(result['capture'],self.capture);self.assertEqual(result['receipt']['registry'],self.registry)
        self.assertFalse(result['may_execute']);self.assertEqual(result['physical_origin'],'UNQUALIFIED')
        from rbridge_installation.qualification import build_qualification,QualificationProofs
        assessment=build_qualification(self.p,QualificationProofs(readers=result))
        self.assertEqual(assessment.status,'BLOCKED');self.assertFalse(assessment.command_ready)

    def test_wrong_authenticated_identity_number_or_repository_refuses_data_comparison(self):
        for key,value in [('author','foreign'),('viewer','foreign'),('repository','foreign/repo'),
                          ('issue_number',True),('is_pull_request',True),('url','https://github.com/foreign/repo/issues/17')]:
            capture={**self.capture,key:value}
            with self.subTest(key=key):self.assertRaises(ValueError,self.compare,self.p,self.registry,self.report,self.fixtures,capture)

    def test_changed_profile_registry_report_fixture_or_owner_decision_refuses_after_rehash(self):
        from rbridge_installation.readonly_helper import _json
        for field in ('profile_sha256','registry','report_sha256','fixture_set_sha256','decision','consumer_inventory'):
            capture=copy.deepcopy(self.capture);body=_json(capture['body'].encode())
            if field=='registry':body[field]['adoptions'][0]['workflow']='different-actual-workflow'
            else:body[field]={'profile_sha256':'c'*64,'report_sha256':'d'*64,'fixture_set_sha256':'e'*64,
                'decision':'SOURCE_TESTS_PASS','consumer_inventory':'UNKNOWN'}[field]
            capture['body']=encode_report(body).decode()
            with self.subTest(field=field):self.assertRaises(ValueError,self.compare,self.p,self.registry,self.report,self.fixtures,capture)

    def test_every_adopted_fixture_set_is_the_original_qualified_set(self):
        registry=copy.deepcopy(self.registry);registry['adoptions'][0]['fixture_set_sha256']='c'*64
        profile=valid_profile();profile['readers']=copy.deepcopy(self.registry['readers'])
        profile['readers'][0]['adoption_sha256']=report_sha256(registry['adoptions'][0]);p=parse_profile(profile)
        registry['readers']=copy.deepcopy(profile['readers'])
        from rbridge_installation.readonly_helper import _json
        capture=copy.deepcopy(self.capture);body=_json(capture['body'].encode());body['profile_sha256']=report_sha256(p);body['registry']=registry
        capture['body']=encode_report(body).decode()
        self.assertRaisesRegex(ValueError,'READER_ADOPTION_FIXTURE_SET_CHANGED',self.compare,p,registry,self.report,self.fixtures,capture)

    def test_actual_backend_roster_is_one_version_probe_and_two_original_issue_queries(self):
        import base64
        from rbridge_installation.reader_adoption_collector import _queries
        from rbridge_installation.github_lookup import _query
        gh=next(t for t in self.p.tools if t.role=='gh');owner,name=self.p.binding.repository.split('/')
        input_json=encode_report({'query':_query(1),'variables':{'owner':owner,'name':name,'n0':17}})
        rows=[]
        for args,raw,output in [(('--version',),b'',(gh.version+'\n').encode()),
                (('api','--hostname','github.com','graphql','--input','-'),input_json,b'{}'),
                (('api','--hostname','github.com','graphql','--input','-'),input_json,b'{}')]:
            argv=[gh.path,*args];session={'scope':'ROOT_FIXED_PROCESS_OBSERVATION','status':'PASS','exit_code':0,
                'live_helpers':[],'argv':argv,'input_sha256':hashlib.sha256(raw).hexdigest(),'output_sha256':hashlib.sha256(output).hexdigest()}
            rows.append({'argv':argv,'session':session,'input_base64':base64.b64encode(raw).decode(),'output_base64':base64.b64encode(output).decode()})
        _queries(self.p,rows,17)
        self.assertRaises(ValueError,_queries,self.p,[*rows,copy.deepcopy(rows[-1])],17)
        for mutation in ('argv','number','version','exit'):
            changed=copy.deepcopy(rows)
            if mutation=='exit':changed[-1]['session']['exit_code']=False
            elif mutation=='argv':
                changed[-1]['argv']=[gh.path,'api','repos/foreign/repo/issues/17'];changed[-1]['session']['argv']=changed[-1]['argv']
            elif mutation=='version':
                output=b'foreign tool version\n';changed[0]['output_base64']=base64.b64encode(output).decode();changed[0]['session']['output_sha256']=hashlib.sha256(output).hexdigest()
            else:
                raw=encode_report({'query':_query(1),'variables':{'owner':owner,'name':name,'n0':18}})
                changed[-1]['input_base64']=base64.b64encode(raw).decode();changed[-1]['session']['input_sha256']=hashlib.sha256(raw).hexdigest()
            with self.subTest(mutation=mutation):self.assertRaises(ValueError,_queries,self.p,changed,17)


class ReaderAdoptionCollectorTests(unittest.TestCase):
    def setUp(self):
        try:
            from rbridge_installation.reader_adoption_collector import collect_root_reader_adoption,verify_root_reader_adoption_observation,_RootReaderAdoptionObservation
        except ImportError:self.fail('Authenticated Root reader adoption collector is absent')
        self.collect,self.verify,self.Token=collect_root_reader_adoption,verify_root_reader_adoption_observation,_RootReaderAdoptionObservation
        self.p=parse_profile(valid_profile())

    def test_source_context_refuses_github_root_open_or_reader_origin(self):
        from rbridge_installation import reader_adoption_collector as c
        with patch('os.open',side_effect=AssertionError('Source Root open')), \
             patch.object(c,'verify_root_reader_observation',side_effect=AssertionError('Source reader origin')), \
             patch.object(c,'QualifiedGitHubReadBackend',side_effect=AssertionError('Source GitHub query')):
            self.assertRaisesRegex(ValueError,'READER_ADOPTION_ROOT_CONTEXT_UNQUALIFIED',self.collect,self.p,None,None,None,17,{})

    def test_constructed_token_and_authenticated_scope_string_have_no_origin(self):
        token=self.Token(report_sha256(self.p),'a'*64,'{}','{}')
        for value in (token,{'scope':'ROOT_AUTHENTICATED_OWNER_READER_ADOPTION','status':'PASS'}):
            with patch('os.open',side_effect=AssertionError('Caller Root open')):
                self.assertRaisesRegex(ValueError,'READER_ADOPTION_ORIGIN_UNQUALIFIED',self.verify,self.p,value,{})

    def test_equal_reader_metadata_cannot_replace_original_invocation_object(self):
        from rbridge_installation import reader_adoption_collector as c
        from rbridge_installation.reader_collector import _RootReaderObservation
        original=_RootReaderObservation(report_sha256(self.p),'{}','{}','{}')
        substitute=_RootReaderObservation(report_sha256(self.p),'{}','{}','{}')
        token=self.Token(report_sha256(self.p),report_sha256(original),'{}','{}')
        c._observations[token]=(report_sha256(token),original,None,None,self.p)
        try:
            with patch('os.open',side_effect=AssertionError('Substituted reader Root open')):
                self.assertRaisesRegex(ValueError,'READER_ADOPTION_READER_ORIGIN_CHANGED',self.verify,self.p,token,{},reader_observation=substitute)
                self.assertRaisesRegex(ValueError,'READER_ADOPTION_ROOT_CONTEXT_UNQUALIFIED',self.verify,self.p,token,{},reader_observation=original)
        finally:del c._observations[token]

    def test_mutated_root_token_refuses_before_io(self):
        from rbridge_installation import reader_adoption_collector as c
        from rbridge_installation.reader_collector import _RootReaderObservation
        original=_RootReaderObservation(report_sha256(self.p),'{}','{}','{}')
        token=self.Token(report_sha256(self.p),report_sha256(original),'{}','{}')
        c._observations[token]=(report_sha256(token),original,None,None,self.p)
        try:
            object.__setattr__(token,'queries_json','{"status":"PASS"}')
            with patch('os.open',side_effect=AssertionError('Mutated adoption Root open')):
                self.assertRaisesRegex(ValueError,'READER_ADOPTION_OBSERVATION_CHANGED',self.verify,self.p,token,{})
        finally:del c._observations[token]


if __name__=='__main__':unittest.main()
