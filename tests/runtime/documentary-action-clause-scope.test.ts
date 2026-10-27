import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {matchSourceBoundRecords} from '../../src/runtime/record-matching.ts';
import {validateInvestigationReport} from '../../src/runtime/evidence.ts';
import type {EvidenceEntry,InvestigationReportInput} from '../../src/shared/investigation.ts';
const runId='4a0d8d25-5caf-4fa3-8ecb-a2646209320d',snapshotHash='b'.repeat(64),sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const make=(id:string,kind:'notice'|'record',content:string):EvidenceEntry=>({id,kind,content,title:id,sourceURL:`https://example.test/${id}`,version:1,retrievedAt:'2026-01-01T00:00:00.000Z',sourceHash:sha(content),snapshotHash,refs:[],authority:kind==='notice'?'public-source-excerpt':'fictional-record',support:'Synthetic action attribution witness.'});
const notice=make('NOTICE','notice','Product: MDL-110\nReturn affected products to the supplier.'),row=make('ROWS','record',JSON.stringify({recordId:'ROW-1',model:'MDL-110',priorDecision:'No return or downstream notification record.'})),entries=[notice,row];
const results=matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:{criterion:{sourceId:notice.id,quote:notice.content,field:'product',operator:'one_of',values:['MDL-110']},records:[{sourceId:row.id,quote:row.content,recordId:'ROW-1',value:'MDL-110'}]}});
assert.equal(results[0]!.status,'match');
const proof=(source:EvidenceEntry)=>({sourceId:source.id,sourceHash:source.sourceHash,quote:source.content});
const validate=(summary:string,withNotice=false)=>{
 const input:InvestigationReportInput={disposition:'answered',recordCitationMode:'atomic_receipts_v1',recordReceiptIds:results.map(x=>x.resultId),summary:'Source facts and missing local records are under review.',findings:[{id:'finding',kind:'missing_evidence',summary,evidence:[proof(row),...(withNotice?[proof(notice)]:[])],recordChecks:results.map(({resultId,field,status})=>({resultId,field,status}))}]};
 return validateInvestigationReport({snapshotHash,entries},entries.map(x=>x.id),input,{runId,recordMatches:results});
};
const code='documentary_action_requires_notice_quote';
test('a documentary mention before a contrast does not turn later missing workflow history into an instruction',()=>{
 for(const boundary of [', but ', '; however ', '; yet ', '. ']){
  assert.deepEqual(validate(`The notice identifies the affected product${boundary}ROW-1 has no return or downstream notification record.`),{valid:true,codes:[]});
 }
});
test('affirmative documentary actions after a contrast still require an actual notice citation',()=>{
 for(const text of ['ROW-1 has no return record, but the manufacturer requires return.','The notice identifies the affected product; however ROW-1 must be returned.','The supplier requires ROW-1 to be returned.']){
  assert.ok(validate(text).codes.includes(code),text);
  assert.equal(validate(text,true).codes.includes(code),false,text);
 }
});
test('requests to verify unknown workflow history are not manufacturer physical-action instructions',()=>{
 for(const text of ['ROW-1 requires follow-up because return completion remains unknown.','ROW-1 needs review because the prior decision says "quarantined under the notice; return completion unknown".','ROW-1 requires verification and return completion remains unknown.','ROW-1 must verify whether return completion is recorded.','ROW-1 requires review and quarantine status is unknown.','ROW-1 requires return verification.']){
  assert.deepEqual(validate(text),{valid:true,codes:[]},text);
 }
});
test('direct, passive, attributed and unattributed physical-action requirements retain documentary proof',()=>{
 for(const text of ['The notice requires return of ROW-1.','The manufacturer requires quarantine.','The manufacturer instructs customers to return the device.','The supplier instructs operators to return affected products.','Affected devices must be replaced.','Return completion is required.','The notice retains quarantine of affected products.','The instructions say to return the devices.','The manufacturer requests return of affected devices.','The supplier asks to return the devices.','The notice contains return instructions.','The notice contains instructions for returning affected devices.','Quarantine affected devices immediately.']){
  assert.ok(validate(text).codes.includes(code),text);
  assert.equal(validate(text,true).codes.includes(code),false,text);
 }
});
test('unknown history or a verification request cannot mask a positive action in the same clause',()=>{
 for(const text of ['ROW-1 requires review and return of affected devices.','ROW-1 requires verification and quarantine all affected units.','ROW-1 requires follow-up because return completion is unknown, and affected devices must be replaced.','No return completion record exists and the notice requires quarantine.','ROW-1 must verify the record and return the devices.','ROW-1 requires return verification and return of affected devices.','ROW-1 prior decision "quarantined under the notice" needs verification, but the manufacturer requires replacement.']){
  assert.ok(validate(text).codes.includes(code),text);
  assert.equal(validate(text,true).codes.includes(code),false,text);
 }
});
test('quoted prior physical decisions may be reviewed but cannot be adopted without documentary proof',()=>{
 for(const text of ['ROW-1 prior decision "Return affected devices" must be followed.','ROW-1 prior decision "Return affected devices" must be reviewed and followed.','ROW-1 prior decision "Return affected devices" must be reviewed + followed.','ROW-1 prior decision "Return affected devices" must be reviewed then followed.','ROW-1 prior decision "Return affected devices" requires review; it must be followed.']){
  assert.ok(validate(text).codes.includes(code),text);
  assert.equal(validate(text,true).codes.includes(code),false,text);
 }
 for(const text of ['ROW-1 prior decision "Return affected devices" must be reviewed.','ROW-1 prior decision "Return affected devices" must be reviewed and confirmed.','ROW-1 prior decision "Return affected devices" requires follow-up.','ROW-1 prior decision "Return affected devices" needs to be verified.','ROW-1 prior decision "Return affected devices" is recorded history.']){
  assert.equal(validate(text).codes.includes(code),false,text);
 }
});
test('local completion follow-up is an artifact request while coordinated physical duties stay visible',()=>{
 for(const text of [
  'Local record ROW-1 needs return-completion follow-up.',
  'Local record ROW-1 prior decision “quarantined under the notice; return completion unknown” needs return-completion follow-up.',
  'The supplied record ROW-1 requires quarantine-status follow-up.',
 ])assert.deepEqual(validate(text),{valid:true,codes:[]},text);
 for(const text of [
  'The notice requires return of affected devices.',
  'Local record ROW-1 needs return-completion follow-up and must return affected devices.',
  'Local record ROW-1 requires return-completion follow-up and the notice requires quarantine.',
  'Local record ROW-1 prior decision “Return affected devices” needs return-completion follow-up and must be followed.',
  'Local record ROW-1 requires return of affected devices.',
 ]){
  assert.ok(validate(text).codes.includes(code),text);
  assert.equal(validate(text,true).codes.includes(code),false,text);
 }
});
