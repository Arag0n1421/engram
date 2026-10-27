import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {matchSourceBoundRecords} from '../../src/runtime/record-matching.ts';
import {validateInvestigationReport} from '../../src/runtime/evidence.ts';
import type {EvidenceEntry,InvestigationReportInput} from '../../src/shared/investigation.ts';
const runId='4a0d8d25-5caf-4fa3-8ecb-a2646209320d',snapshotHash='b'.repeat(64),sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const entry=(id:string,kind:'notice'|'record',content:string):EvidenceEntry=>({id,kind,content,title:id,sourceURL:`https://example.test/${id}`,version:1,retrievedAt:'2026-01-01T00:00:00.000Z',sourceHash:sha(content),snapshotHash,refs:[],support:'Independent clause-status test.',authority:kind==='notice'?'public-source-excerpt':'fictional-record'} as EvidenceEntry);
function setup(){
 const notice=entry('NOTICE','notice','Product: MDL-110\nAffected lots: LOT-110, LOT-111.');
 const values=[{recordId:'ROW-1',model:'MDL-110',lot:'LOT-110'},{recordId:'ROW-2',model:'MDL-110',lot:null},{recordId:'ROW-3',model:null,lot:null}],quotes=values.map(v=>JSON.stringify(v)),record=entry('ROWS','record',quotes.join('\n')),entries=[notice,record];
 const results=['product','lot'].flatMap(field=>matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:{criterion:{sourceId:'NOTICE',quote:notice.content,field:field as 'product'|'lot',operator:'one_of',values:[field==='product'?'MDL-110':'LOT-110'],product:'MDL-110',productQuote:notice.content},records:values.map((row,i)=>({sourceId:'ROWS',quote:quotes[i]!,recordId:row.recordId,value:field==='product'?row.model:row.lot,product:row.model}))}}));
 assert.deepEqual(results.map(r=>r.status),['match','match','unknown','match','unknown','unknown']);
 const report:InvestigationReportInput={recordCitationMode:'atomic_receipts_v1',recordReceiptIds:results.map(r=>r.resultId),disposition:'answered',summary:'The recorded scalar statuses are available for review.',findings:[{id:'status',kind:'observation',summary:'ROW-1 lot matches; ROW-2 lot match status unknown; ROW-3 product match status unknown.',evidence:quotes.map(quote=>({sourceId:'ROWS',sourceHash:record.sourceHash,quote})),recordChecks:results.map(({resultId,field,status})=>({resultId,field,status}))}]};
 const validate=()=>validateInvestigationReport({snapshotHash,entries},entries.map(e=>e.id),report,{runId,recordMatches:results});
 return {report,results,validate};
}
test('separate named clauses do not spread positive lot claims onto unknown other records',()=>{
 const x=setup();assert.deepEqual(x.validate(),{valid:true,codes:[]});
 x.report.findings[0]!.summary='ROW-1 lot matches. ROW-2 lot match status unknown. ROW-3 product match status unknown.';assert.deepEqual(x.validate(),{valid:true,codes:[]});
});
test('grouped positive claims still reject a named unknown or wrong-field result',()=>{
 const x=setup();x.report.findings[0]!.summary='ROW-1 and ROW-2 lot matches.';assert.ok(x.validate().codes.includes('unknown_record_check_cannot_prove_classification'));
 x.report.findings[0]!.summary='ROW-1 lot matches.';x.report.findings[0]!.recordChecks=x.report.findings[0]!.recordChecks!.filter(c=>c.field==='product');assert.ok(x.validate().codes.includes('record_match_field_claim_mismatch'));
});
test('pronoun carry cannot turn a previously named unknown product into a positive match',()=>{
 const x=setup();x.report.findings[0]!.summary='ROW-3 product match status unknown; it matches the product.';assert.ok(x.validate().codes.includes('unknown_record_check_cannot_prove_classification'));
 x.report.findings[0]!.summary='ROW-3 product match status unknown. The model matches.';assert.ok(x.validate().codes.includes('unknown_record_check_cannot_prove_classification'));
});
test('one named record may correctly describe its separate product and lot typed results',()=>{
 const x=setup();x.report.findings[0]!.summary='ROW-1 product matches; its lot matches.';assert.deepEqual(x.validate(),{valid:true,codes:[]});
});
test('one named record may correctly describe product and manufacture-date results across clauses',()=>{
 const notice=entry('NOTICE','notice','Product: MDL-110\nManufacture date range from 2025-01-01 to 2025-01-31.'),quote=JSON.stringify({recordId:'ROW-1',model:'MDL-110',manufacture_date:'2025-01-15'}),record=entry('ROWS','record',quote),entries=[notice,record];
 const results=[...matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:{criterion:{sourceId:'NOTICE',quote:notice.content,field:'product',operator:'one_of',values:['MDL-110']},records:[{sourceId:'ROWS',quote,recordId:'ROW-1',value:'MDL-110'}]}}),...matchSourceBoundRecords({runId,snapshotHash,selected:entries,request:{criterion:{sourceId:'NOTICE',quote:notice.content,field:'manufacture_date',operator:'between_inclusive',values:['2025-01-01','2025-01-31'],product:'MDL-110',productQuote:notice.content},records:[{sourceId:'ROWS',quote,recordId:'ROW-1',value:'2025-01-15',product:'MDL-110'}]}})];
 assert.deepEqual(results.map(r=>r.status),['match','match']);
 const input:InvestigationReportInput={recordCitationMode:'atomic_receipts_v1',recordReceiptIds:results.map(r=>r.resultId),disposition:'answered',summary:'The two exact scalar results are available.',findings:[{id:'fields',kind:'observation',summary:'ROW-1 product matches; its manufacture date is within the range.',evidence:[{sourceId:'ROWS',sourceHash:record.sourceHash,quote}],recordChecks:results.map(({resultId,field,status})=>({resultId,field,status}))}]};
 assert.deepEqual(validateInvestigationReport({snapshotHash,entries},entries.map(e=>e.id),input,{runId,recordMatches:results}),{valid:true,codes:[]});
});
