import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {matchSourceBoundRecords} from "../../src/runtime/record-matching.ts";
import {explicitLotTables} from "../../src/runtime/record-tables.ts";
import type {EvidenceEntry} from "../../src/shared/investigation.ts";

const runId="4a0d8d25-5caf-4fa3-8ecb-a2646209320d",snapshotHash="b".repeat(64);
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
function notice(options:{model?:string;udi?:string;secondModel?:string;attachmentId?:string;secondAttachment?:boolean;link?:boolean;linkText?:string;lot?:string;positional?:boolean}={}) {
 const model=options.model??"MX-410",udi=options.udi??"00812345678901",attachment=options.attachmentId??"1",lot=options.lot??"LOT-410";
 return [
  "Recall notice",
  ...(options.positional?[" Product Name                      Model/Catalog Number              UDI-DI                   Lot Numbers",` ViziShot 2 FLEX (19G)             ${model}                    ${udi}           All`,...(options.secondModel?[` ViziShot 2 FLEX (19G)             ${options.secondModel}                    00812345678902           All`]:[])]:[" Model Number          UDI-DI",` ${model}                ${udi}`,...(options.secondModel?[` ${options.secondModel}                00812345678902`]:[])]),
  options.linkText??(options.link===false?"The attached table contains the lot numbers.":`See Attachment ${attachment} for affected lot numbers.`),
  `Attachment ${attachment} — Affected Lot List`,
  " Lot Number        Expiry Date",
  ` ${lot}             2028-04-01`,
  ...(options.secondAttachment?["Attachment 2: Affected Lot List"," Lot Number        Expiry Date"," LOT-OTHER         2028-05-01"]:[]),
 ].join("\n");
}
function source(id:string,kind:"notice"|"record",content:string):EvidenceEntry {
 return {id,kind,content,sourceHash:hash(content),snapshotHash,support:"Synthetic source-bound linkage fixture."} as EvidenceEntry;
}
function compare(noticeContent:string,recordProduct="MX-410",recordLot="LOT-410") {
 const selected=[source("NOTICE","notice",noticeContent),source("RECORD","record",JSON.stringify({recordId:"R-1",modelNumber:recordProduct,lot:recordLot}))];
 const tables=explicitLotTables(noticeContent).filter(table=>/\b(?:lot|batch)(?:\s+(?:number|no\.?|code))?\b/i.test(table.quote)&&!/\b(?:model|UDI|product\s+name|catalog(?:ue)?)\b/i.test(table.quote));
 const table=tables[0]!;assert.ok(table,"fixture has an explicit lot table");
 const request={criterion:{sourceId:"NOTICE",quote:table.quote,additionalQuotes:table.additionalQuotes,field:"lot" as const,operator:"one_of" as const,values:["LOT-410"],product:null,productQuote:table.quote},records:[{sourceId:"RECORD",quote:selected[1]!.content,recordId:"R-1",value:recordLot,product:recordProduct,productQuote:selected[1]!.content}]};
 return {selected,result:matchSourceBoundRecords({runId,snapshotHash,selected,request})[0]!};
}
test("one exact model/UDI row and its explicitly linked single attachment permit only literal product comparison",()=>{
 const content=notice(),{selected,result}=compare(content);
 assert.equal(result.status,"match");assert.equal(result.productIdentity,"exact_quoted_identifier");
 assert.ok(result.evidence.some(item=>item.sourceId==="NOTICE"&&item.quote===" MX-410                00812345678901"));
 assert.ok(result.evidence.every(item=>item.quote.length<=1000&&selected.find(entry=>entry.id===item.sourceId)!.content.includes(item.quote)));
 assert.equal(compare(content,"MX-999").result.reason,"different_product");
 assert.equal(compare(content,"MX-410","LOT-OTHER").result.status,"unknown");
 const variant=notice({attachmentId:"A",linkText:"Affected lots for this model are listed in Attachment A."});
 assert.equal(compare(variant).result.status,"match");
 const positional=notice({attachmentId:"A",linkText:"Affected lots for this model are listed in Attachment A.",positional:true});
 assert.equal(compare(positional).result.status,"match");
 const conflicting=notice({linkText:"Affected lots for product MX-999 are listed in Attachment 1."});
 assert.equal(compare(conflicting).result.reason,"product_identity_unknown");
});

test("attachment bridge stays unknown for missing linkage, unmatched UDI, ambiguous product rows, and ambiguous attachments",()=>{
 const base=notice();
 for(const content of [
  notice({link:false}),
  notice({udi:""}),
  notice({secondModel:"MX-411"}),
  notice({secondAttachment:true}),
 ]){
  const result=compare(content).result;
  assert.equal(result.status,"unknown",content);assert.equal(result.reason,"product_identity_unknown",content);
 }
 assert.equal(compare(base,"MX-410").result.status,"match");
});
