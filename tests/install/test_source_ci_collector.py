"""Source CI comparisons never substitute for Root/artifact/runtime qualification."""
import copy
import hashlib
import json
import unittest
from unittest.mock import patch
from _loader import toolkit
from _fixtures import valid_profile


def raw(value):return json.dumps(value,separators=(',',':')).encode()


class SourceCICollectorTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.source_ci_collector import compare_source_ci,collect_root_source_ci,verify_root_source_ci_observation
        except ImportError:self.fail('Concrete authenticated Source CI collector is not implemented')
        from rbridge_installation.profile import parse_profile
        self.compare,self.collect,self.verify=compare_source_ci,collect_root_source_ci,verify_root_source_ci_observation
        self.profile=parse_profile(valid_profile());self.repo='zbaksa/rbridge-public';self.run_id=41;self.job_id=42
        self.run={'id':41,'head_sha':self.profile.toolkit.source_sha,'status':'completed','conclusion':'success',
            'event':'push','name':'RBridge Local-First CI','path':'.github/workflows/local-first-ci.yml',
            'repository':{'full_name':self.repo},'head_repository':{'full_name':self.repo},
            'actor':{'login':self.profile.binding.author},'head_branch':'review/p2a-installation-native'}
        names=['Verify dedicated runner identity','Installation tests','Test','Typecheck','Lint','Build server',
            'Public-source scrub','Verify tracked source stayed clean']
        self.job={'id':42,'run_id':41,'head_sha':self.profile.toolkit.source_sha,'name':'rbridge-local-first',
            'status':'completed','conclusion':'success','runner_name':'rbridge-debian-ci',
            'steps':[{'name':name,'status':'completed','conclusion':'success','number':i+1} for i,name in enumerate(names)]}
        self.commit={'sha':self.profile.toolkit.source_sha,'tree':{'sha':self.profile.toolkit.tree_sha}}
        self.log=b'2026-10-06T00:00:00.0000000Z node: v22.23.3\n2026-10-06T00:00:01Z Ran 177 tests in 1.0s\n2026-10-06T00:00:01Z OK\n2026-10-06T00:00:02Z Tests 621 passed (621)\n'

    def value(self,**changes):
        values={'profile':self.profile,'run_id':41,'job_id':42,'run_json':raw(self.run),'job_json':raw(self.job),
            'commit_json':raw(self.commit),'log_bytes':self.log};values.update(changes);return self.compare(**values)

    def test_exact_completed_commit_tree_required_steps_and_full_log_are_source_data_only(self):
        value=self.value();self.assertEqual(value['scope'],'SOURCE_QUALIFICATION_ONLY')
        self.assertEqual(value['commit'],self.profile.toolkit.source_sha)
        self.assertEqual(value['log_sha256'],hashlib.sha256(self.log).hexdigest())
        self.assertEqual(value['node_version'],'22.23.3')
        self.assertTrue(all(v=='success' for v in value['steps'].values()))

    def test_fork_other_branch_workflow_actor_pending_or_changed_commit_never_qualify(self):
        mutations=[{'repository':{'full_name':'other/repo'}},{'head_repository':{'full_name':'other/repo'}},
            {'head_sha':'f'*40},{'head_branch':'main'},{'path':'.github/workflows/other.yml'},
            {'actor':{'login':'other'}},{'status':'in_progress'},{'conclusion':'failure'},{'id':True}]
        for change in mutations:self.assertRaises(ValueError,self.value,run_json=raw({**self.run,**change}))
        self.assertRaises(ValueError,self.value,commit_json=raw({**self.commit,'tree':{'sha':'f'*40}}))
        self.assertRaises(ValueError,self.value,run_id=True)

    def test_failed_missing_duplicate_steps_wrong_runner_and_foreign_job_are_refused(self):
        for change in ('failed','missing','duplicate','runner','job'):
            job=copy.deepcopy(self.job)
            if change=='failed':job['steps'][0]['conclusion']='failure'
            elif change=='missing':job['steps'].pop()
            elif change=='duplicate':job['steps'].append(copy.deepcopy(job['steps'][0]))
            elif change=='runner':job['runner_name']='other-runner'
            else:job['run_id']=99
            with self.subTest(change=change):self.assertRaises(ValueError,self.value,job_json=raw(job))

    def test_github_post_steps_have_reserved_number_gaps_but_all_steps_still_must_settle(self):
        job=copy.deepcopy(self.job)
        job['steps'].append({'name':'Post Use Node 22','number':30,'status':'completed','conclusion':'success'})
        self.assertEqual(self.value(job_json=raw(job))['conclusion'],'success')
        for number in (True,0,1,job['steps'][-2]['number']):
            bad=copy.deepcopy(job);bad['steps'][-1]['number']=number
            self.assertRaises(ValueError,self.value,job_json=raw(bad))

    def test_log_labels_without_complete_utf8_node22_and_test_verdicts_are_not_proof(self):
        for log in (b'PASS',b'\xff',self.log.replace(b'v22.23.3',b'v24.0.0'),self.log.replace(b' OK\n',b' FAILED\n'),
                self.log.replace(b'Tests 621 passed (621)',b'Tests 620 passed (621)'),
                self.log+self.log,self.log.replace(b'Ran 177 tests',b'Ran 0 tests')):
            self.assertRaises(ValueError,self.value,log_bytes=log)
        self.assertRaises(ValueError,self.value,run_json=b'{"id":41,"id":41}')

    def test_source_context_and_caller_tokens_never_open_root_files_or_authenticate(self):
        with patch('rbridge_installation.source_ci_collector.os.open',side_effect=AssertionError('Source Root open')), \
             patch('rbridge_installation.source_ci_collector.QualifiedGitHubReadBackend',side_effect=AssertionError('Source auth')):
            self.assertRaisesRegex(ValueError,'SOURCE_CI_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.collect,
                self.profile,None,None,41,42,{'python_closure_sha256':'d'*64})
        from rbridge_installation.source_ci_collector import _RootSourceCIObservation
        token=_RootSourceCIObservation('a'*64,41,42,'{}','{}')
        for value in (token,{'status':'PASS','scope':'ROOT_AUTHENTICATED_SOURCE_CI'}):
            with patch('rbridge_installation.source_ci_collector.os.open',side_effect=AssertionError('Caller Root open')):
                self.assertRaisesRegex(ValueError,'SOURCE_CI_COLLECTOR_ORIGIN_UNQUALIFIED',self.verify,self.profile,value,{})


if __name__=='__main__':unittest.main()
