import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {matchSourceBoundRecords} from '../../src/runtime/record-matching.ts';
import {validateInvestigationReport} from '../../src/runtime/evidence.ts';
import type {EvidenceEntry,InvestigationReportInput} from '../../src/shared/investigation.ts';
const runId='4a0d8d25-5caf-4fa3-8ecb-a2646209320d',snapshotHash='b'.repeat(64),sha=(v:string)=>createHash('sha256').update(v).digest('hex');
function setup(blanketBefore=false){
 const make=(id:string,kind:'notice'|'record',content:string):EvidenceEntry=>({id,kind,content,title:id,sourceURL:`https://example.test/${id}`,version:1,retrievedAt:'2026-01-01T00:00:00.000Z',sourceHash:sha(content),snapshotHash,refs:[],authority:kind==='notice'?'public-source-excerpt':'fictional-record',support:'Independent bounded clearance witness.'} as EvidenceEntry);
 const before=make('A','notice','Product: MDL-110\nDevices manufactured after 2025-05-12 are not affected.\n'+(blanketBefore?'Immediately cease all use of the affected devices.':'If resistance occurs, stop use immediately.'));
 const after=make('B','notice','Product: MDL-110\nThe August notice stated that devices made after 2025-05-12 are not affected.\nImmediately cease all use of the affected devices.');
 const rowQuotes=[1,2].map(n=>JSON.stringify({recordId:`ROW-${n}`,model:'MDL-110'})),record=make('ROWS','record',rowQuotes.join('\n')),entries=[before,after,record];
 const results=matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:{criterion:{sourceId:'A',quote:before.content,field:'product',operator:'one_of',values:['MDL-110']},records:rowQuotes.map((quote,i)=>({sourceId:'ROWS',quote,recordId:`ROW-${i+1}`,value:'MDL-110'}))}});
 assert.deepEqual(results.map(x=>x.status),['match','match']);
 const proof=(source:EvidenceEntry,quote=source.content)=>({sourceId:source.id,sourceHash:source.sourceHash,quote});
 const report:InvestigationReportInput={disposition:'answered',recordCitationMode:'atomic_receipts_v1',recordReceiptIds:results.map(x=>x.resultId),summary:'The selected facts are under review.',findings:[{id:'local',kind:'observation',summary:'The local records have checked product matches.',evidence:rowQuotes.map(quote=>proof(record,quote)),recordChecks:results.map(({resultId,field,status})=>({resultId,field,status}))}]};
 const validate=()=>validateInvestigationReport({snapshotHash,entries},entries.map(x=>x.id),report,{runId,recordMatches:results});
 return {before,after,record,results,report,validate,proof};
}
const clearance='field_match_does_not_establish_clearance',shared='shared_immediate_stop_use_requires_both_notice_quotes';
test('conservative clearance denials and no-clearance subjects are not positive certifications',()=>{
 for(const text of ['ROW-1 cannot be cleared without verification.','None can be cleared without verification.','No local record can be cleared without verification.','ROW-1 must not be considered safe to use.','ROW-1 is not safe or cleared.','ROW-1 cannot be classed as affected (clear) or unaffected (black).','Neither row can be classified as affected or unaffected without identity verification.','ROW-1 cannot be classified as affected or unaffected without identity verification.','Neither row can be classified as affected (clear) or unaffected (black) without identity verification.']){
  const x=setup();x.report.summary=text;x.report.findings[0]!.summary=text;assert.equal(x.validate().codes.includes(clearance),false,text);
 }
});
test('positive named, collective and generic row-cited clearance remains rejected',()=>{
 for(const text of ['ROW-1 is safe to use.','ROW-1 is not affected.','The local records are cleared.','This device is safe to use.','The notice says this device is safe to use.']){
  const x=setup();x.report.summary=text;x.report.findings[0]!.summary=text;assert.ok(x.validate().codes.includes(clearance),text);
 }
});
test('a conservative denial cannot mask a positive clearance in the same contrast or sentence',()=>{
 for(const text of ['ROW-1 cannot be cleared, but ROW-2 is cleared.','None can be cleared; however ROW-2 is safe to use.','ROW-1 cannot be cleared, and ROW-2 is unaffected.','ROW-1 cannot be classed as affected (clear) or unaffected (black), and ROW-2 is unaffected.','ROW-1 cannot be classed as affected (ROW-2 is safe) or unaffected.','Neither row can be classified as affected or unaffected, and ROW-2 is unaffected.','Neither row can be classified as affected or unaffected; ROW-2 is safe.','Neither row can be classified as affected (ROW-2 is safe) or unaffected.','Neither row (ROW-1 is safe) can be classified as affected.','Neither row, although ROW-1 is safe, can be classified as affected.']){
  const x=setup();x.report.summary=text;x.report.findings[0]!.summary=text;assert.ok(x.validate().codes.includes(clearance),text);
 }
});
test('source-only documentary nonaffected scope is not a local device certification',()=>{
 const x=setup();x.report.summary='The earlier notice states devices manufactured after 2025-05-12 are not affected.';x.report.findings[0]!.summary=x.report.summary;x.report.findings[0]!.evidence=[x.proof(x.before)];x.report.findings[0]!.recordChecks=[];
 assert.deepEqual(x.validate(),{valid:true,codes:[]});
});
test('notice-only qualified scope attribution carries across sentences despite irrelevant checked refs',()=>{
 const x=setup();x.report.findings[0]!.summary='The earlier notice describes its manufacturing scope. Devices manufactured after 2025-05-12 are not affected.';x.report.findings[0]!.evidence=[x.proof(x.before)];
 assert.deepEqual(x.validate(),{valid:true,codes:[]});
 x.report.summary=x.report.findings[0]!.summary;
 assert.deepEqual(x.validate(),{valid:true,codes:[]});
});
test('R04-style notice wording treats that as a singular demonstrative and accepts made-after/before scope',()=>{
 for(const summary of [
  'The August notice stated that devices made after 2025-05-12 are not affected.',
  'The August notice states devices made before 2025-05-12 are not affected.'
 ]){
  const x=setup();x.report.summary=summary;x.report.findings[0]!.summary=summary;x.report.findings[0]!.evidence=[x.proof(x.after)];
  // The global matched receipts are deliberately present, while the finding is supported only by a notice.
  assert.deepEqual(x.validate(),{valid:true,codes:[]},summary);
 }
});
test('source attribution carry never exempts row evidence, named/local claims or generic device certification',()=>{
 for(const text of ['The earlier notice describes its scope. ROW-1 is unaffected.','The earlier notice describes its scope. Local devices manufactured after 2025-05-12 are not affected.','The earlier notice describes its scope. This device is safe to use.','The earlier notice describes its scope. That device is unaffected.','The earlier notice describes its scope. These devices made after 2025-05-12 are not affected.','The earlier notice describes its scope. Those devices made before 2025-05-12 are not affected.','The earlier notice describes its scope. The device is unaffected.','The earlier notice describes its scope. Devices manufactured after 2025-05-12 are safe to use.','The earlier notice describes its scope. Devices with matching products are unaffected.']){
  const x=setup();x.report.findings[0]!.summary=text;x.report.findings[0]!.evidence=[x.proof(x.before)];assert.ok(x.validate().codes.includes(clearance),text);
 }
 const rowOnly=setup();rowOnly.report.findings[0]!.summary='The earlier notice describes its manufacturing scope. Devices manufactured after 2025-05-12 are not affected.';assert.ok(rowOnly.validate().codes.includes(clearance));
 const mixed=setup();mixed.report.findings[0]!.summary=rowOnly.report.findings[0]!.summary;mixed.report.findings[0]!.evidence.push(mixed.proof(mixed.before));assert.ok(mixed.validate().codes.includes(clearance));
});
test('both local records under one later notice is not a claim about both notices',()=>{
 const x=setup();x.report.findings[0]!.summary='Local records ROW-1 and ROW-2 both require immediate cessation of use under the later notice.';x.report.findings[0]!.evidence.push(x.proof(x.after));
 assert.equal(x.validate().codes.includes(shared),false);
});
test('explicit both-notice immediate-stop claims retain distinct unconditional notice proof requirements',()=>{
 const x=setup();x.report.summary='Both notices require immediate cessation of use.';x.report.findings[0]!.summary=x.report.summary;x.report.findings[0]!.evidence=[x.proof(x.before),x.proof(x.after)];x.report.findings[0]!.recordChecks=[];
 assert.ok(x.validate().codes.includes(shared));
 const positive=setup(true);positive.report.summary=x.report.summary;positive.report.findings[0]!.summary=x.report.summary;positive.report.findings[0]!.evidence=[positive.proof(positive.before),positive.proof(positive.after)];positive.report.findings[0]!.recordChecks=[];
 assert.deepEqual(positive.validate(),{valid:true,codes:[]});
});

function sourceScopedLots(){
 const make=(id:string,kind:'notice'|'record',title:string,content:string):EvidenceEntry=>({id,kind,title,content,sourceURL:`https://example.test/${id}`,version:1,retrievedAt:'2026-01-01T00:00:00.000Z',sourceHash:sha(content),snapshotHash,refs:[],authority:kind==='notice'?'public-source-excerpt':'fictional-record',support:'Independent bounded clearance witness.'} as EvidenceEntry);
 const may=make('N01-A','notice','Document 1','Product: MDL-110\nLots: MAY-LOT');
 const july=make('N01-B','notice','Document 2','Product: MDL-110\nLots: JULY-LOT');
 const row1=JSON.stringify({recordId:'ROW-1',product:'MDL-110',lot:'JULY-LOT'}),row2=JSON.stringify({recordId:'ROW-2',product:'MDL-110',lot:'MAY-LOT'});
 const record=make('ROWS','record','Local records',[row1,row2].join('\n')),entries=[may,july,record];
 const check=(source:EvidenceEntry,quote:string,recordId:string,value:string|null)=>matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:{criterion:{sourceId:source.id,quote:source.content,field:'lot',operator:'one_of',values:[source.content.includes('MAY-LOT')?'MAY-LOT':'JULY-LOT'],product:'MDL-110',productQuote:source.content},records:[{sourceId:'ROWS',quote,recordId,value,product:'MDL-110',productQuote:quote}]}})[0]!;
 const results=[check(may,row1,'ROW-1',null),check(july,row1,'ROW-1','JULY-LOT'),check(may,row2,'ROW-2','MAY-LOT'),check(july,row2,'ROW-2',null)];
 assert.deepEqual(results.map(result=>result.status),['unknown','match','match','unknown']);
 const proof=(source:EvidenceEntry,quote=source.content)=>({sourceId:source.id,sourceHash:source.sourceHash,quote});
 const report:InvestigationReportInput={disposition:'answered',recordCitationMode:'atomic_receipts_v1',recordReceiptIds:results.map(result=>result.resultId),summary:'The rows are reviewed.',findings:[{id:'local',kind:'observation',summary:'Local record ROW-1 lot check against Document 1 is unknown, while Document 2 is a match. Local record ROW-2 lot check against Document 1 is a match, while Document 2 is unknown.',evidence:[proof(may),proof(july),proof(record,row1),proof(record,row2)],recordChecks:results.map(({resultId,field,status})=>({resultId,field,status}))}]};
 const validate=()=>validateInvestigationReport({snapshotHash,entries},entries.map(entry=>entry.id),report,{runId,recordMatches:results});
 return {may,july,report,validate};
}
test('notice-specific lot checks ignore an unknown result only for the other explicitly named notice',()=>{
 const x=sourceScopedLots();assert.deepEqual(x.validate(),{valid:true,codes:[]});
});
test('reversing the source labels still rejects a match claim against the unknown notice',()=>{
 const x=sourceScopedLots();x.report.findings[0]!.summary='Local record ROW-1 lot check against Document 1 is a match, while Document 2 is unknown.';
 assert.ok(x.validate().codes.includes('record_check_status_does_not_support_classification'));
});
test('unbound or ambiguous notice wording keeps the conservative cross-check rejection',()=>{
 for(const summary of [
  'Local record ROW-1 lot check is a match.',
  'Local record ROW-1 lot check against Document 1 is a match against Document 2.'
 ]){const x=sourceScopedLots();x.report.findings[0]!.summary=summary;const result=x.validate();assert.ok(result.codes.includes('record_check_status_does_not_support_classification'),`${summary}: ${JSON.stringify(result)}`);}
});
test('source predicates bind to every coordinated notice and reject wrong or negated statuses',()=>{
 for(const summary of [
  'The lot check for ROW-1 matches Document 2 and Document 1.',
  'The lot check for ROW-1 matches Document 2 and 1.',
  'ROW-1 lot check against Document 2 is a match, but Document 1 is a match.',
  'ROW-1 lot check against Document 2 is unknown.',
  'ROW-1 lot check against Document 2 is not a match.',
  'ROW-1 lot check against Document 2 is no_match.'
 ]){const x=sourceScopedLots();x.report.findings[0]!.summary=summary;assert.ok(x.validate().codes.includes('record_check_status_does_not_support_classification'),summary);}
});
test('generic titles cannot bind a status and punctuation in a trusted source title remains matchable',()=>{
 for(const summary of ['Local record ROW-1 lot check is a match.','Local record ROW-1 lot check is not a match.','Local record ROW-1 lot check is unknown.']){const generic=sourceScopedLots();generic.july.title='match';generic.report.findings[0]!.summary=summary;assert.ok(generic.validate().codes.includes('record_check_status_does_not_support_classification'),summary);}
 const punctuated=sourceScopedLots();punctuated.july.title='Document (2)+';punctuated.report.findings[0]!.summary='ROW-1 lot check against Document (2)+ is a match.';assert.equal(punctuated.validate().codes.includes('record_check_status_does_not_support_classification'),false);
});
