import type {RBridgeScope} from '../domain/rbridgeCoreProtocol.js';
import type {RBridgeExecutionReceiptV1} from '../domain/rbridgeExecutionContract.js';
export interface CarrierComment{id:number;author:string;body:string;url:string;}
export interface CarrierCapture{
  schema:'RBRIDGE_GITHUB_CARRIER_CAPTURE_V1';scope:'FIXTURE_AUTHORITY_ONLY'|'AUTHENTICATED_GITHUB_READ';context_sha256:string;repository:string;viewer:string;
  issue:{number:number;title:string;body:string;author:string;url:string;state:'OPEN'|'CLOSED';isPullRequest:false};comments:CarrierComment[];complete:true;capture_sha256:string;
}
export interface ReaderExpectation{
  producer_source_sha:'b5881fd8367b4249e82683f1f884f2392cb696d4';mode:'LEGACY'|'CORE';repository:string;author:string;issue_number:number;request_id:string;request_title:string;request_body_sha256:string;
  capture_context_sha256:string;capture_sha256:string;digest_branch:'ADMITTED_CANONICAL_REQUEST'|'RAW_BODY_PRECLAIM_REJECTION';expected_source_sha:string;
  scope?:RBridgeScope;runtime_uid?:number;intent_sha256?:string;policy_sha256?:string;receipt_sha256?:string;output_sha256?:string;selected_comment_id?:number;
}
export interface CarrierEvidence{capture_sha256:string;context_sha256:string;comment_ids:readonly number[];comment_body_sha256:readonly string[];selected_comment_id:number;envelope_sha256:string;raw_envelope_base64:string;}
interface ReaderBase{scope:'REFERENCE_PARSER_ONLY';status:'PASS'|'FAIL'|'BLOCKED'|'UNCERTAIN'|'UNKNOWN';reason_codes:readonly string[];}
export type ReaderResult=(ReaderBase&{kind:'LEGACY_RESULT'|'LEGACY_REJECTION'|'CORE_RESULT';envelope:Readonly<Record<string,unknown>>;evidence:CarrierEvidence;receipt?:RBridgeExecutionReceiptV1;output?:unknown})|(ReaderBase&{kind:'INVALID'|'UNAVAILABLE'});
