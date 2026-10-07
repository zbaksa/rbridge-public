"""Fixed Root acceptance transport; no source fixture can construct this backend."""
import base64
import hashlib
import os
from pathlib import Path
import re
import secrets
import stat
import time
import weakref
from .acceptance import AcceptanceError, AcceptanceNotReady, _check
from .artifact import _identity
from .models import encode_report, report_sha256
from .protected_copy import ProtectedParent, FilesystemAuthority, FILE_FLAGS
from .readonly_helper import _json, parse_helper_ready


def _fail(reason): raise AcceptanceError(reason)


class _OwnedCanary:
    def __init__(self,path,data,production):
        if type(data) is not bytes or not 0<len(data)<=4096: _fail('ACCEPTANCE_CANARY_INVALID')
        try: data.decode('utf-8',errors='strict')
        except UnicodeError: _fail('ACCEPTANCE_CANARY_INVALID')
        self.path=Path(path);self.fd=None;self.guard=None;self.owner=os.getuid();self.sha256=hashlib.sha256(data).hexdigest();self.mode=0o444
        try:
            self.guard=ProtectedParent(FilesystemAuthority(self.owner,1027,self.path.parent,'RUNTIME',production))
            if production:
                # The existing read policy is sufficient; do not chmod a parent.
                for _parent,_name,_child,row in self.guard.links:
                    if not (row.st_mode&0o001 or row.st_gid==1027 and row.st_mode&0o010):
                        _fail('ACCEPTANCE_CANARY_PARENT_UNREADABLE')
            write_fd=os.open(self.path.name,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=self.guard.fd)
            try:
                view=memoryview(data)
                while view:
                    count=os.write(write_fd,view)
                    if count<=0: _fail('ACCEPTANCE_CANARY_WRITE_UNCERTAIN')
                    view=view[count:]
                os.fchmod(write_fd,0o444);os.fsync(write_fd);self.identity=_identity(os.fstat(write_fd))
            finally: os.close(write_fd)
            os.fsync(self.guard.fd);self.guard.check()
            self.fd=os.open(self.path.name,FILE_FLAGS,dir_fd=self.guard.fd)
            self.readback()
        except (OSError,ValueError):
            self.close()
            # Preserve a partial object too; it was never qualified for overwrite.
            _fail('ACCEPTANCE_CANARY_CREATION_UNCERTAIN')
    def readback(self):
        self.guard.check();before=os.fstat(self.fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid!=self.owner or before.st_nlink!=1
                or before.st_mode&0o7777!=self.mode or _identity(before)!=self.identity
                or _identity(os.stat(self.path.name,dir_fd=self.guard.fd,follow_symlinks=False))!=self.identity):
            _fail('ACCEPTANCE_CANARY_CHANGED')
        os.lseek(self.fd,0,os.SEEK_SET);data=bytearray()
        while len(data)<=4096:
            chunk=os.read(self.fd,4097-len(data))
            if not chunk:break
            data.extend(chunk)
        if hashlib.sha256(data).hexdigest()!=self.sha256 or _identity(os.fstat(self.fd))!=self.identity:
            _fail('ACCEPTANCE_CANARY_CHANGED')
        self.guard.check()
        return {'path':str(self.path),'sha256':self.sha256,'identity':list(map(str,self.identity)),
            'bytes':len(data),'mode':self.mode,'owner':self.owner}
    def close(self):
        if self.fd is not None:os.close(self.fd);self.fd=None
        if self.guard is not None:self.guard.close();self.guard=None


def _create_fixture_canary(path,data):
    """Source descriptor fixture, not a production-path or identity authority."""
    return _OwnedCanary(path,data,False)


class _ObservedCanary(_OwnedCanary):
    """Retain existing protected bytes; never create, overwrite or chmod."""
    def __init__(self,path,data,production):
        if type(data) is not bytes or not 0<len(data)<=4096:_fail('ACCEPTANCE_CANARY_INVALID')
        try:data.decode('utf-8',errors='strict')
        except UnicodeError:_fail('ACCEPTANCE_CANARY_INVALID')
        self.path=Path(path);self.fd=None;self.guard=None;self.owner=os.getuid();self.sha256=hashlib.sha256(data).hexdigest()
        try:
            self.guard=ProtectedParent(FilesystemAuthority(self.owner,1027,self.path.parent,'RUNTIME',production))
            if production:
                for _parent,_name,_child,row in self.guard.links:
                    if not (row.st_mode&0o001 or row.st_gid==1027 and row.st_mode&0o010):
                        _fail('ACCEPTANCE_CANARY_PARENT_UNREADABLE')
            self.fd=os.open(self.path.name,FILE_FLAGS,dir_fd=self.guard.fd);row=os.fstat(self.fd)
            self.mode=stat.S_IMODE(row.st_mode);self.identity=_identity(row)
            if (not stat.S_ISREG(row.st_mode) or row.st_uid!=self.owner or row.st_nlink!=1
                    or row.st_mode&0o6022 or not 0<row.st_size<=4096
                    or production and not (row.st_mode&0o004 or row.st_gid==1027 and row.st_mode&0o040)):
                _fail('ACCEPTANCE_CANARY_UNPROTECTED')
            self.readback()
        except (OSError,ValueError):self.close();_fail('ACCEPTANCE_CANARY_OBSERVATION_UNCERTAIN')


def _observe_fixture_canary(path,data):
    """Current-user Source descriptor mechanics, no physical Root origin."""
    return _ObservedCanary(path,data,False)


def retain_acceptance_restart_snapshot(lease,evidence):
    """Full fresh paused inventory; the original pre-start backup is untouched."""
    from .pause_backup import capture_snapshot,_snapshot_report
    snapshot=capture_snapshot(lease)
    if snapshot.reason_codes:_fail('ACCEPTANCE_RESTART_SNAPSHOT_UNKNOWN')
    report={'schema':'RBRIDGE_ACCEPTANCE_RESTART_SNAPSHOT_V1','scope':snapshot.scope,
        'transaction_id':lease.ledger.transaction_id,'pause_sha256':snapshot.pause_sha256,
        'snapshot_sha256':snapshot.tree_sha256,'snapshot':_snapshot_report(snapshot),
        'pre_start_backup_republished':False}
    evidence.write('accept-restart-paused',report)
    after=capture_snapshot(lease)
    if (after.reason_codes or after.tree_sha256!=snapshot.tree_sha256 or after.pause_sha256!=snapshot.pause_sha256):
        _fail('ACCEPTANCE_RESTART_SNAPSHOT_CHANGED')
    return report


def build_carrier_capture(profile,request,number,before,comments,after,viewer,context_sha256,authenticated=False):
    """Strict data comparison. Only the concrete backend supplies authentic origin."""
    p=profile;url=f'https://github.com/{p.binding.repository}/issues/{number}'
    def issue(row):
        if (type(row) is not dict or type(row.get('number')) is not int or row['number']!=number
                or 'pull_request' in row or row.get('html_url')!=url
                or row.get('title')!='[COCWIN BRIDGE REQUEST] '+request['requestId']
                or row.get('body')!=encode_report(request).decode('utf-8')
                or row.get('user',{}).get('login')!=p.binding.author
                or row.get('state') not in ('open','closed') or type(row.get('comments')) is not int
                or not 0<=row['comments']<=p.budget.carrier_comments
                or type(row.get('updated_at')) is not str):_fail('ACCEPTANCE_CARRIER_IDENTITY_INVALID')
        return {k:row[k] for k in ('number','title','body','user','html_url','state','comments','updated_at')}
    first=issue(before);last=issue(after)
    if (first!=last or viewer!=p.binding.author or type(comments) is not list
            or len(comments)!=last['comments'] or not re.fullmatch('[0-9a-f]{64}',str(context_sha256))):
        _fail('ACCEPTANCE_CARRIER_CAPTURE_INCOMPLETE')
    ids=set();rows=[]
    for c in comments:
        if (type(c) is not dict or type(c.get('id')) is not int or not 1<=c['id']<=9007199254740991
                or c['id'] in ids or c.get('user',{}).get('login')!=p.binding.author
                or c.get('html_url')!=url+'#issuecomment-'+str(c['id']) or type(c.get('body')) is not str
                or len(c['body'].encode('utf-8',errors='strict'))>p.budget.comment_bytes):
            _fail('ACCEPTANCE_CARRIER_COMMENT_INVALID')
        ids.add(c['id']);rows.append({'id':c['id'],'author':p.binding.author,'body':c['body'],'url':c['html_url']})
    base={'schema':'RBRIDGE_GITHUB_CARRIER_CAPTURE_V1',
        'scope':'AUTHENTICATED_GITHUB_READ' if authenticated else 'FIXTURE_AUTHORITY_ONLY',
        'context_sha256':context_sha256,'repository':p.binding.repository,'viewer':viewer,
        'issue':{'number':number,'title':first['title'],'body':first['body'],'author':p.binding.author,
            'url':url,'state':first['state'].upper(),'isPullRequest':False},'comments':rows,'complete':True}
    if len(encode_report(base))>p.budget.carrier_bytes:_fail('ACCEPTANCE_CARRIER_BYTE_LIMIT')
    return {**base,'capture_sha256':report_sha256(base)}


_backends=weakref.WeakSet()


def validate_delivery_publication(profile,request,number,record,expected,require_published):
    """Data predicate only; the concrete backend separately pins descriptor origin."""
    keys={'schema','revision','identity','state','lastReason','attempts'}
    if (type(record) is not dict or set(record)-keys-{'publication'} or not keys<=set(record)
            or record['schema']!='RBRIDGE_GITHUB_DELIVERY_V1' or type(record['revision']) is not int or not 1<=record['revision']<=9007199254740991
            or type(record['attempts']) is not int or not 0<=record['attempts']<=9007199254740991
            or type(record['lastReason']) is not str or '\0' in record['lastReason'] or len(record['lastReason'].encode())>512
            or record['state'] not in ('PENDING','PUBLISHED')):_fail('ACCEPTANCE_LOCAL_PUBLICATION_INVALID')
    identity={'repository':profile.binding.repository,'issueNumber':number,'authorLogin':profile.binding.author,
        'title':'[COCWIN BRIDGE REQUEST] '+request['requestId'],'bodySha256':report_sha256(request),
        'requestSha256':report_sha256(request),'operationId':request['requestId'],'intentSha256':expected['intent_sha256']}
    if record['identity']!=identity:_fail('ACCEPTANCE_LOCAL_PUBLICATION_IDENTITY_CHANGED')
    publication=record.get('publication')
    if 'publication' in record:
        required={'envelopeSha256','totalBytes','chunkCount','nextIndex'}
        if (type(publication) is not dict or set(publication)-required-{'manifestCommentId','receiptCommentId'}
                or not required<=set(publication) or publication['envelopeSha256']!=expected['envelope_sha256']
                or type(publication['totalBytes']) is not int or publication['totalBytes']!=expected['envelope_bytes']
                or type(publication['chunkCount']) is not int or not 0<=publication['chunkCount']<=256
                or type(publication['nextIndex']) is not int or not 0<=publication['nextIndex']<=publication['chunkCount']
                or (publication['chunkCount']==0 and 'manifestCommentId' in publication)
                or (publication['chunkCount']>0 and publication['chunkCount']!=(publication['totalBytes']+39999)//40000)
                or ('receiptCommentId' in publication and publication['receiptCommentId']!=expected['comment_id'])
                or ('manifestCommentId' in publication and publication['manifestCommentId']!=expected['comment_id'])):
            _fail('ACCEPTANCE_LOCAL_PUBLICATION_TRUTH_CHANGED')
    if record['state']=='PUBLISHED':
        if (publication is None or publication.get('receiptCommentId')!=expected['comment_id']
                or publication['chunkCount']>0 and publication.get('manifestCommentId')!=expected['comment_id']
                or publication['nextIndex']!=publication['chunkCount']):_fail('ACCEPTANCE_LOCAL_PUBLICATION_INVALID')
    elif require_published:raise AcceptanceNotReady('ACCEPTANCE_LOCAL_PUBLICATION_PENDING')
    return record


class QualifiedAcceptanceBackend:
    scope='QUALIFIED_INSTALLED_ACCEPTANCE'
    def __init__(self,context,host):
        _check(context)
        from .host_backend import QualifiedHostBackend
        from .qualification import verify_qualification_bundle
        if context.scope!=self.scope or type(host) is not QualifiedHostBackend or context.prepared.lease.backend is not host:
            _fail('ACCEPTANCE_BACKEND_UNQUALIFIED')
        bundle=verify_qualification_bundle(context.prepared.profile,context.prepared.bundle)
        self.context=context;self.host=host;self.bundle=bundle;self.profile=context.prepared.profile
        self.canary=None;self.requests=None;self.attempted=set();self.helper_sessions=[];self.query_evidence=[]
        self.root=Path(self.profile.paths.release_parent)/('toolkit-'+self.profile.toolkit.source_sha)
        self.entrypoint=self.root/'dist/server/cli/rbridgeReadResult.js'
        from .github_lookup import QualifiedGitHubReadBackend
        self.github=QualifiedGitHubReadBackend(self.profile)
        _backends.add(self);self.verify_installed(context)
        viewer=self._api('user')
        if viewer.get('login')!=self.profile.binding.author:_fail('ACCEPTANCE_GITHUB_VIEWER_CHANGED')
        self._flush_queries('viewer')
    def _flush_queries(self,label):
        if self.query_evidence:
            self.context.prepared.evidence.write('accept-github-'+label,self.query_evidence)
            self.query_evidence=[]
    def _validate(self,context):
        if self not in _backends or context is not self.context:_fail('ACCEPTANCE_BACKEND_UNQUALIFIED')
        _check(context)
        from .transaction import _validate,_authorization
        _validate(context.prepared,self.host);_authorization(context.prepared,context.prepared.authorization)
        if self.canary:self.canary.readback()
    def now_ms(self):return time.time_ns()//1000000
    def wait_ms(self,delay):
        self._validate(self.context)
        if type(delay) is not int or not 0<delay<=1000:_fail('ACCEPTANCE_POLL_INVALID')
        time.sleep(min(delay/1000,max(0,self.context.deadline-time.monotonic())))
    def verify_installed(self,context):
        self._validate(context)
        return self.host.observe_candidate(context.prepared)
    def _api(self,endpoint,payload=None):
        self._validate(self.context);repo=self.profile.binding.repository
        allowed=endpoint=='user' or re.fullmatch(re.escape('repos/'+repo+'/issues/')+r'[1-9][0-9]*(?:/comments\?per_page=100&page=[1-9][0-9]*)?',endpoint)
        if payload is None:
            if not allowed:_fail('ACCEPTANCE_FIXED_GITHUB_QUERY_REQUIRED')
            args=('api','--hostname','github.com','--method','GET',endpoint);body=b''
        else:
            if endpoint!='repos/'+repo+'/issues' or type(payload) is not dict or set(payload)!={'title','body'}:
                _fail('ACCEPTANCE_FIXED_GITHUB_SUBMISSION_REQUIRED')
            args=('api','--hostname','github.com','--method','POST',endpoint,'--input','-');body=encode_report(payload)
        raw=self.github._run(args,body,min(self.profile.budget.lookup_ms,max(1,int((self.context.deadline-time.monotonic())*1000))),self.profile.budget.carrier_bytes)
        value=_json(raw,self.profile.budget.carrier_bytes)
        entry={'endpoint':endpoint,
            'method':'POST' if payload is not None else 'GET','input_sha256':hashlib.sha256(body).hexdigest(),
            'input_json':body.decode('utf-8'),'response':value,'response_sha256':hashlib.sha256(raw).hexdigest(),
            'response_json':raw.decode('utf-8'),'session':self.github.helper_sessions[-1]}
        if len(encode_report([*self.query_evidence,entry]))>33554432:_fail('ACCEPTANCE_CARRIER_BYTE_LIMIT')
        self.query_evidence.append(entry)
        return value
    def _reader(self,value):
        self._validate(self.context)
        from .owned_process import run_owned_process
        p=self.profile;runuser=next(t for t in p.tools if t.role=='runuser')
        node_args=[p.runtime.node_path,str(self.entrypoint)]
        parent_args=[runuser.path,'--user',p.binding.account,'--',*node_args]
        mcp_args=[p.runtime.node_path,str(Path(p.paths.release_parent)/p.runtime.source_sha/'dist/server/server/rbridgeMcpMain.js')]
        specs=[{'exe':p.runtime.node_path,'argv':node_args,'uid':p.binding.uid,'gid':p.binding.gid,
            'groups':list(p.binding.supplementary_gids),'parent_argv':parent_args,'max_count':1},
            {'exe':p.runtime.node_path,'argv':mcp_args,'uid':p.binding.uid,'gid':p.binding.gid,
             'groups':list(p.binding.supplementary_gids),'parent_argv':node_args,'max_count':2}]
        nonce=secrets.token_hex(32)
        def ready(raw,observed):
            pid=parse_helper_ready(raw,nonce);row=observed.get(pid)
            if row is None or row['argv']!=node_args or row['uid']!=[p.binding.uid]*4:
                _fail('ACCEPTANCE_READER_PROCESS_UNQUALIFIED')
        self.context.prepared.evidence.write('accept-reader-intent',{'entrypoint':str(self.entrypoint),
            'toolkit_manifest_sha256':self.context.prepared.toolkit_manifest_sha256,'input':value,
            'input_sha256':hashlib.sha256(encode_report(value)).hexdigest(),'nonce_sha256':hashlib.sha256(nonce.encode()).hexdigest()})
        raw,errors,proof=run_owned_process(runuser,parent_args[1:],
            min(180000,max(1,int((self.context.deadline-time.monotonic())*1000))),p.budget.carrier_bytes,
            input_bytes=encode_report(value),child_specs=specs,guard=lambda:self._validate(self.context),ready=ready,
            env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':p.binding.home,'USER':p.binding.account,
                 'LOGNAME':p.binding.account,'LC_ALL':'C','RBRIDGE_INSTALL_HELPER_NONCE':nonce})
        if proof['exit_code'] not in (0,2,5):_fail('ACCEPTANCE_READER_PROCESS_UNQUALIFIED')
        parse_helper_ready(errors,nonce)
        result=_json(raw,p.budget.carrier_bytes);self.helper_sessions.append(proof)
        self.context.prepared.evidence.write('accept-reader-output',{'input_sha256':proof['input_sha256'],
            'output':result,'output_sha256':proof['output_sha256'],'session':proof})
        return result
    def reserve(self,context,requests):
        self._validate(context);self.requests=requests
        if tuple(r['requestId'] for r in requests)!=context.operation_ids:_fail('ACCEPTANCE_IDENTITY_INVALID')
        from .artifact import open_artifact_root
        from .protected_copy import DIR_FLAGS
        fd=open_artifact_root(self.profile.paths.state_root)
        local=[]
        try:
            root=os.fstat(fd)
            if root.st_uid!=self.profile.binding.uid or root.st_mode&0o7777!=0o700:_fail('ACCEPTANCE_STATE_ROOT_CHANGED')
            for request in requests:
                operation_id=request['requestId'];paths=[operation_id+'.json','flowpilot/'+operation_id+'.json','flowpilot/'+operation_id+'.done','execution-v2/operations/'+operation_id+'.json']
                for path in paths:
                    handles=[];parent=fd;parts=path.split('/')
                    try:
                        for part in parts[:-1]:
                            child=os.open(part,DIR_FLAGS,dir_fd=parent);handles.append(child);row=os.fstat(child)
                            if row.st_uid!=self.profile.binding.uid or row.st_mode&0o7777!=0o700:_fail('ACCEPTANCE_RESERVATION_UNQUALIFIED')
                            parent=child
                        try:os.stat(parts[-1],dir_fd=parent,follow_symlinks=False)
                        except FileNotFoundError:local.append(path)
                        else:_fail('ACCEPTANCE_IDENTITY_ALREADY_RESERVED')
                    finally:
                        for handle in reversed(handles):os.close(handle)
            if _identity(root)!=_identity(os.fstat(fd)):_fail('ACCEPTANCE_STATE_ROOT_CHANGED')
        finally:os.close(fd)
        reads=[]
        for index,request in enumerate(requests):
            expected=self._mcp_expectation(request)
            result=self._reader({'schema':'RBRIDGE_READER_INPUT_V1','operation':'MCP_READ_INSTALLED',
                'profile':self.profile,'toolkit_manifest':context.prepared.toolkit_manifest,
                'runtime_manifest':context.prepared.runtime_manifest,'era':'legacy' if index==0 else 'modern','expected':expected})
            if result.get('status')!='NOT_FOUND' or not result.get('query_evidence'):_fail('ACCEPTANCE_IDENTITY_ALREADY_RESERVED')
            reads.append(result)
        return {'status':'PASS','ids':list(context.operation_ids),'legacy_absent_paths':local,'mcp':reads}
    def _mcp_expectation(self,request):
        # Core's intent digest deliberately excludes the distinct operation ID.
        b=self.profile.binding;submission={'schema':'RBRIDGE_OPERATION_SUBMISSION_V1',
            'principalId':b.principal_id,'targetInstanceId':b.target_instance_id,'operation':request['operation']}
        return {'operationId':request['requestId'],'principalId':b.principal_id,'targetInstanceId':b.target_instance_id,
            'runtime_uid':b.uid,'intent_sha256':report_sha256(submission),'policy_sha256':b.policy_sha256,
            'deadline_ms':min(self.profile.budget.lookup_ms,180000)}
    def prepare_canary(self,context):
        self._validate(context)
        if self.canary is not None:_fail('ACCEPTANCE_CANARY_ALREADY_CREATED')
        context.prepared.evidence.write('accept-canary-observe-intent',{'path':self.profile.paths.canary_path,
            'sha256':self.profile.service.canary_sha256,'bytes':len(context.canary_bytes)})
        self.canary=_ObservedCanary(self.profile.paths.canary_path,context.canary_bytes,True)
        return self.canary.readback()
    def submit_once(self,context,request):
        self._validate(context)
        if not self.requests or request not in self.requests or request['requestId'] in self.attempted:
            _fail('ACCEPTANCE_SUBMISSION_ALREADY_ATTEMPTED')
        self.attempted.add(request['requestId'])
        payload={'title':'[COCWIN BRIDGE REQUEST] '+request['requestId'],'body':encode_report(request).decode()}
        created=self._api('repos/'+self.profile.binding.repository+'/issues',payload)
        number=created.get('number');viewer=self._api('user').get('login')
        if type(number) is not int:_fail('ACCEPTANCE_SUBMISSION_UNCERTAIN')
        reread=self._api('repos/'+self.profile.binding.repository+'/issues/'+str(number))
        # Creation can already have raced publication; validate the live readback,
        # not a stale state value from the POST acknowledgement.
        build_carrier_capture(self.profile,request,number,reread,[],reread,viewer,
            self.bundle.reader_context_sha256,True) if reread.get('comments')==0 else self._validate_issue(request,number,reread,viewer)
        self._flush_queries('submitted')
        return {'number':number,'request_id':request['requestId'],'request_sha256':report_sha256(request)}
    def _validate_issue(self,request,number,row,viewer):
        snapshot={**row,'comments':0}
        return build_carrier_capture(self.profile,request,number,snapshot,[],snapshot,viewer,self.bundle.reader_context_sha256,True)
    def read_results(self,context,requests,carriers,stage,original=None):
        self._validate(context);viewer=self._api('user').get('login');cases=[]
        for index,(request,carrier) in enumerate(zip(requests,carriers)):
            number=carrier['number'];base='repos/'+self.profile.binding.repository+'/issues/'+str(number)
            before=self._api(base);comments=[]
            for page in range(1,self.profile.budget.carrier_comments//100+2):
                rows=self._api(base+'/comments?per_page=100&page='+str(page))
                if type(rows) is not list or len(rows)>100:_fail('ACCEPTANCE_CARRIER_CAPTURE_INCOMPLETE')
                comments.extend(rows)
                if len(comments)>self.profile.budget.carrier_comments:_fail('ACCEPTANCE_CARRIER_BYTE_LIMIT')
                if len(rows)<100:break
            else:_fail('ACCEPTANCE_CARRIER_CAPTURE_INCOMPLETE')
            after=self._api(base)
            capture=build_carrier_capture(self.profile,request,number,before,comments,after,viewer,self.bundle.reader_context_sha256,True)
            if capture['issue']['state']!='CLOSED' or not capture['comments']:
                self._flush_queries('pending')
                raise AcceptanceNotReady('ACCEPTANCE_CARRIER_NOT_READY')
            mcp=self._mcp_expectation(request)
            expected={'producer_source_sha':self.profile.runtime.source_sha,'mode':'CORE','repository':self.profile.binding.repository,
                'author':self.profile.binding.author,'issue_number':number,'request_id':request['requestId'],
                'request_title':capture['issue']['title'],'request_body_sha256':hashlib.sha256(capture['issue']['body'].encode()).hexdigest(),
                'capture_context_sha256':capture['context_sha256'],'capture_sha256':capture['capture_sha256'],
                'digest_branch':'ADMITTED_CANONICAL_REQUEST','expected_source_sha':self.profile.runtime.source_sha,
                'scope':{k:mcp[k] for k in ('operationId','principalId','targetInstanceId')},
                'runtime_uid':mcp['runtime_uid'],'intent_sha256':mcp['intent_sha256'],'policy_sha256':mcp['policy_sha256']}
            cases.append({'kind':request['operation']['kind'],'capture':capture,'expected':expected,
                'era':('modern' if index==0 else 'legacy') if stage=='REPLAY' else ('legacy' if index==0 else 'modern')})
        self._flush_queries('capture')
        value={'schema':'RBRIDGE_READER_INPUT_V1','operation':'ACCEPT_READ_INSTALLED','profile':self.profile,
            'toolkit_manifest':context.prepared.toolkit_manifest,'runtime_manifest':context.prepared.runtime_manifest,
            'stage':stage,'captured_at':_utc_stamp(self.now_ms()),'canary_base64':base64.b64encode(context.canary_bytes).decode(),'cases':cases}
        if original is not None:value['original']=original
        result=self._reader(value)
        self._validate_named_readers(result,context.operation_ids)
        for index,(request,carrier) in enumerate(zip(requests,carriers)):
            operation=result['report']['operations'][index]
            github=_json(operation['github_verdict_json'].encode())
            receipt=github['receipt'];claimed=receipt['transitions'][0]['at'];terminal=receipt['transitions'][-1]['at']
            if not request['createdAt']<=claimed<=terminal<=result['report']['captured_at']:
                _fail('ACCEPTANCE_ADMISSION_TIME_CHANGED')
            expected={'intent_sha256':self._mcp_expectation(request)['intent_sha256'],
                'comment_id':operation['comment_id'],'envelope_sha256':github['evidence']['envelope_sha256'],
                'envelope_bytes':len(base64.b64decode(github['evidence']['raw_envelope_base64'],validate=True))}
            live=self._read_delivery(carrier['number'])
            validate_delivery_publication(self.profile,request,carrier['number'],live['record'],expected,stage=='REPLAY')
            context.prepared.evidence.write('accept-local-publication',{'stage':stage,'delivery':live,
                'created_at':request['createdAt'],'claimed_at':claimed,'terminal_at':terminal,
                'captured_at':result['report']['captured_at'],'health_metadata':github.get('output') if index==0 else None})
        return result['report']
    def _read_delivery(self,number):
        from .protected_copy import DIR_FLAGS
        # Walk and retain every ancestor. Runtime-owned state is data, never code.
        path=Path(self.profile.paths.state_root)/'execution-v2/deliveries/github'/str(number)
        directory=path.parent;handles=[];links=[];fd=None
        try:
            parent=os.open('/',DIR_FLAGS);handles.append(parent);current=''
            for part in directory.parts[1:]:
                current+='/'+part;before=os.stat(part,dir_fd=parent,follow_symlinks=False)
                runtime=current==self.profile.binding.home or current.startswith(self.profile.binding.home+'/')
                owner=self.profile.binding.uid if runtime else 0
                if (not stat.S_ISDIR(before.st_mode) or before.st_uid!=owner or before.st_mode&0o6022
                        or current.startswith(self.profile.binding.home+'/.local') and before.st_mode&0o7777!=0o700):
                    _fail('ACCEPTANCE_STATE_ANCESTOR_UNQUALIFIED')
                child=os.open(part,DIR_FLAGS,dir_fd=parent);handles.append(child)
                links.append((parent,part,child,before));parent=child
            def stable(s):return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid)
            def check():
                for parent,name,child,before in links:
                    if stable(before)!=stable(os.fstat(child)) or stable(before)!=stable(os.stat(name,dir_fd=parent,follow_symlinks=False)):
                        _fail('ACCEPTANCE_STATE_ANCESTOR_CHANGED')
            check();name=str(number)+'.json';fd=os.open(name,FILE_FLAGS,dir_fd=handles[-1]);before=os.fstat(fd)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid!=self.profile.binding.uid or before.st_nlink!=1
                    or before.st_mode&0o7777!=0o600 or not 0<before.st_size<=self.profile.budget.record_bytes):
                _fail('ACCEPTANCE_LOCAL_PUBLICATION_UNQUALIFIED')
            raw=bytearray()
            while len(raw)<=before.st_size:
                chunk=os.read(fd,min(65536,before.st_size+1-len(raw)))
                if not chunk:break
                raw.extend(chunk)
            if (len(raw)!=before.st_size or _identity(before)!=_identity(os.fstat(fd))
                    or _identity(before)!=_identity(os.stat(name,dir_fd=handles[-1],follow_symlinks=False))):
                raise AcceptanceNotReady('ACCEPTANCE_LOCAL_PUBLICATION_CHANGED')
            check();record=_json(bytes(raw),self.profile.budget.record_bytes)
            if encode_report(record)!=raw:_fail('ACCEPTANCE_LOCAL_PUBLICATION_NOT_CANONICAL')
            return {'record':record,'file_sha256':hashlib.sha256(raw).hexdigest(),'identity':list(map(str,_identity(before)))}
        finally:
            if fd is not None:os.close(fd)
            for handle in reversed(handles):os.close(handle)
    def _validate_named_readers(self,result,ids):
        if result.get('schema')!='RBRIDGE_INSTALL_NAMED_READERS_V1' or result.get('report',{}).get('status')!='PASS':
            _fail('ACCEPTANCE_NAMED_READERS_NOT_PASS')
        expected={(r.reader_id,operation_id,r.transport) for r in self.profile.readers for operation_id in ids}
        seen=set()
        for row in result.get('invocations',[]):
            key=(row.get('reader_id'),row.get('operation_id'),row.get('transport'))
            registration=next((r for r in self.profile.readers if r.reader_id==row.get('reader_id')),None)
            invocation=row.get('invocation',{});verdict=invocation.get('verdict',{})
            if (key not in expected or key in seen or registration is None
                    or invocation.get('scope')!='QUALIFIED_INSTALLED_READER'
                    or invocation.get('source_sha256')!=registration.source_sha256
                    or invocation.get('version')!=registration.version
                    or invocation.get('trusted_context_sha256')!=registration.trusted_context_sha256
                    or hashlib.sha256(row.get('input_json','').encode()).hexdigest()!=invocation.get('input_sha256')
                    or hashlib.sha256(row.get('verdict_json','').encode()).hexdigest()!=invocation.get('output_sha256')
                    or _json(row.get('verdict_json','').encode())!=verdict
                    or verdict.get('status')!=('PASS' if registration.transport=='GITHUB' else 'RESULT')):
                _fail('ACCEPTANCE_NAMED_READER_IDENTITY_CHANGED')
            operation=next((o for o in result['report']['operations'] if o['operation_id']==row['operation_id']),None)
            if (operation is None or report_sha256(verdict.get('receipt'))!=operation['receipt_sha256']
                    or report_sha256(verdict.get('output'))!=operation['output_sha256']):
                _fail('ACCEPTANCE_NAMED_READER_TRUTH_CHANGED')
            seen.add(key)
        if not expected or seen!=expected:_fail('ACCEPTANCE_NAMED_READERS_INCOMPLETE')
    def settle_helpers(self,context):
        self._validate(context)
        from .owned_process import assert_owned_helpers_settled
        assert_owned_helpers_settled()
        return {'scope':self.scope,'status':'PASS','live_helpers':[],
            'reader_sessions':self.helper_sessions,'github_sessions':self.github.helper_sessions}
    def restart_candidate(self,context):
        self._validate(context);prepared=context.prepared
        if prepared.ledger.read().entries[-1].marker!='ACCEPTING':_fail('ACCEPTANCE_RESTART_UNQUALIFIED')
        self.settle_helpers(context);self.host.stop_unit(self.profile.service.unit)
        prepared.lease.observe_stopped()
        retain_acceptance_restart_snapshot(prepared.lease,prepared.evidence)
        self._validate(context);prepared.pointer.session.check()
        if prepared.config.session.observed()!=prepared.config.after_sha256:_fail('ACCEPTANCE_RESTART_CONFIG_CHANGED')
        # START_ATTEMPTED is already durable. Same immutable candidate only.
        self.host._run(('start','rbridge.service'),self.profile.budget.stop_ms,65536)
        return self.verify_installed(context)
    def close(self):
        self._flush_queries('final')
        if self.canary:self.canary.close();self.canary=None


def _utc_stamp(milliseconds):
    from .acceptance import _stamp
    return _stamp(milliseconds)
