import {explicitLotTables,modelColumnRows} from "./record-tables.ts";
import {createHash} from "node:crypto";
import {z} from "zod";
import {exactEvidenceTokenIndex as tokenIndex,evidenceUnits} from "./evidence-excerpts.ts";
import type {EvidenceEntry, EvidenceQuote} from "../shared/investigation.ts";

export type RecordMatchStatus = "match" | "no_match" | "unknown";
export interface RecordMatchInput {
  criterion:{sourceId:string;quote:string;additionalQuotes?:string[];field:"lot"|"manufacture_date"|"product";operator:"one_of"|"between_inclusive";values:string[];product?:string|null;productQuote?:string};
  records:Array<{sourceId:string;quote:string;recordId:string;value:string|null;product?:string|null;productQuote?:string}>;
}
const boundValueSchema={sourceId:z.string().min(1).max(200),quote:z.string().min(1).max(1000),product:z.string().min(1).max(200).nullable().optional(),productQuote:z.string().min(1).max(1000).optional()};
export const recordMatchInputSchema=z.object({
  criterion:z.object({...boundValueSchema,additionalQuotes:z.array(z.string().min(1).max(1000)).max(5).optional(),field:z.enum(["lot","manufacture_date","product"]),operator:z.enum(["one_of","between_inclusive"]),values:z.array(z.string().min(1).max(100)).min(1).max(30)}).strict(),
  records:z.array(z.object({...boundValueSchema,recordId:z.string().min(1).max(200),value:z.string().min(1).max(100).nullable()}).strict()).min(1).max(12),
}).strict();
export const recordMatchInputJsonSchema=z.toJSONSchema(recordMatchInputSchema);
export interface BoundRecordMatch {
  resultId:string;runId:string;snapshotHash:string;recordId:string;field:RecordMatchInput["criterion"]["field"];
  status:RecordMatchStatus;reason:"exact_product_comparison"|"exact_lot_comparison"|"inclusive_date_comparison"|"record_value_unknown"|"unparseable_date"|"field_not_explicit"|"criterion_field_not_explicit"|"product_identity_unknown"|"different_product"|"incomplete_lot_set";
  criterionCompleteness:"complete_explicit_list"|"inclusive_date_range"|"not_established";
  productIdentity:"exact_quoted_identifier"|"different_quoted_identifier"|"unknown";
  scopeStatus:"not_a_recall_scope_determination";
  normalizedCriterion:string[];normalizedRecordValue:string|null;evidence:EvidenceQuote[];
  verificationScope:"explicit_source_bound_field_comparison_only";
}
const sha=(value:string)=>createHash("sha256").update(value,"utf8").digest("hex");
const months=["january","february","march","april","may","june","july","august","september","october","november","december"];
/** Only complete ISO dates or unambiguous named-month dates; no locale guessing or expiry substitution. */
export function explicitDate(value:string):string|null {
  let parts=value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let year:number,month:number,day:number;
  if(parts){year=+parts[1]!;month=+parts[2]!;day=+parts[3]!;}
  else {
    const named=value.trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/)??value.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
    if(!named)return null;
    const dayFirst=/^\d/.test(named[1]!);day=+(dayFirst?named[1]!:named[2]!);year=+named[3]!;
    month=months.indexOf((dayFirst?named[2]!:named[1]!).toLowerCase())+1;
  }
  if(year<1000||month<1||month>12||day<1||day>31)return null;
  const date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return null;
  return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}
function labelled(quote:string,field:"lot"|"manufacture_date"|"product",value:string|null):boolean {
  if(field==="product")return value!==null&&explicitProduct(quote,value);
  if(field==="lot"){const tables=explicitLotTables(quote);if(tables.length)return value!==null&&tables.some(table=>table.values.includes(value));}
  const label=field==="lot"?/\b(?:lot(?:s| number| code)?|batch(?: number| code)?)\b/gi:/\b(?:manufactur(?:e|ed|ing)(?:[ _-]?date)?|manufactureDate)\b/gi;
  for(const match of quote.matchAll(label)){
    const tail=quote.slice(match.index!+match[0].length,match.index!+match[0].length+120);
    const target=value===null?tail.search(/\b(?:null|unknown|missing|not (?:recorded|available|specified))\b/i):tokenIndex(tail,value);
    if(target<0)continue;
    const between=tail.slice(0,target);
    if(!/[;|]/.test(between)&&!/(?:expir\w*|received\w*|receipt\w*|shipped\w*|issued\w*|delivery\w*)\s*["']?\s*[:=]/i.test(between))return true;
  }
  return false;
}
function entityBlock(quote:string,recordId:string):string|null {
  const entities=[...quote.matchAll(/(?:\bRecord\s+|["']?(?:recordId|record_id|id)["']?\s*[:=]\s*["']?)([A-Za-z0-9_.:/-]+)/gi)];
  const found=entities.findIndex(match=>match[1]===recordId);
  if(found>=0)return quote.slice(entities[found]!.index!,entities[found+1]?.index??quote.length);
  const escaped=recordId.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  return quote.split(/\n/).find(line=>new RegExp(`^\\s*\\|?\\s*${escaped}(?:\\s*[|,\\t;:])`).test(line))??null;
}
function explicitProduct(quote:string,value:string|undefined|null):boolean {
  if(typeof value!=="string"||!value.trim()||value.length>200)return false;
  for(const match of quote.matchAll(/\b(?:product(?:[ _-]?(?:code|id|reference|name))?|model(?:[ _-]?(?:number|code|id))?|UDI(?:[ _-]?DI)?|catalog(?:ue)?(?:[ _-]?(?:code|number|reference))?|manufacturerRef|manufacturer[ _-]?reference|item[ _-]?code|GTIN|SMN)\b/gi)){
    const tail=quote.slice(match.index!+match[0].length,match.index!+match[0].length+230),index=tokenIndex(tail,value);
    if(index>=0&&!/[;|\n]/.test(tail.slice(0,index)))return true;
  }
  return false;
}
/** Product headings delimit notice entities. Repeated/ambiguous headings are not silently joined. */
function noticeProductRegion(content:string,product:string):string|null {
  const headings=[...content.matchAll(/\b(?:product(?:[ _-]?(?:code|id|reference|name))?|model(?:[ _-]?(?:number|code|id))?|UDI(?:[ _-]?DI)?|catalog(?:ue)?(?:[ _-]?(?:code|number|reference))?|manufacturerRef|manufacturer[ _-]?reference|item[ _-]?code|GTIN|SMN)\b["']?\s*[:=#]\s*["']?/gi)];
  const matches=headings.flatMap((heading,index)=>{
    const region=content.slice(heading.index!,headings[index+1]?.index??content.length);
    return explicitProduct(region,product)?[region]:[];
  });
  return matches.length===1?matches[0]!:null;
}
/**
 * A columnar model/UDI row can identify the sole product covered by a notice,
 * but only when the same source explicitly labels its one lot attachment as
 * the affected-lot list. This is an exact source-local bridge, not a product
 * guess: multi-product rows, multiple attachments, or unlabelled lot tables
 * deliberately return null.
 */
function attachedSingleModelForLots(content:string,criterionQuotes:string[]):{value:string;udi:string;quote:string;linkQuote:string;headingQuote:string}|null {
  const headings=[...content.matchAll(/^\s*Attachment\s+([A-Za-z0-9-]+)\s*[:—-]\s*([^\n]*)/gim)];
  const models=modelColumnRows(content).filter(row=>headings.length===0||content.indexOf(row.quote)<headings[0]!.index!);
  if(models.length!==1||! /\bmodel(?:\s*\/\s*catalog(?:ue)?|\s+catalog(?:ue))?(?:\s+(?:number|no\.?|code))?\b/i.test(models[0]!.header)||! /\bUDI(?:[- ]?DI)?\b/i.test(models[0]!.header))return null;
  const model=models[0]!;
  const modelAt=model.quote.indexOf(model.value);
  const udi=modelAt<0?null:model.quote.slice(modelAt+model.value.length).match(/^\s{2,}([A-Za-z0-9][A-Za-z0-9._/-]*)\b/)?.[1]??null;
  if(!udi)return null;
  const lots=explicitLotTables(content).filter(table=>/\b(?:lot|batch)(?:\s+(?:number|no\.?|code))?\b/i.test(table.quote)&&!/\b(?:model|UDI|product\s+name|catalog(?:ue)?)\b/i.test(table.quote));
  const physicalHeaders=[...new Set(lots.map(table=>table.quote))];
  if(!headings.length||!lots.length||physicalHeaders.length!==1)return null;
  const headerQuote=physicalHeaders[0]!;
  const allTableEvidence=new Set(lots.flatMap(table=>[table.quote,...table.additionalQuotes]));
  if(!criterionQuotes.length||criterionQuotes.some(quote=>!allTableEvidence.has(quote)))return null;
  const tableStart=content.indexOf(headerQuote);
  const heading=headings.filter(item=>item.index!<tableStart).at(-1);
  if(!heading||! /\b(?:affected|recalled|included|listed)\b[\s\S]{0,40}\b(?:lots?|batches?)\b|\b(?:lots?|batches?)\b[\s\S]{0,40}\b(?:affected|recalled|included|listed)\b/i.test(heading[2]!))return null;
  const attachmentId=heading[1]!.toLowerCase();
  if(headings.some(item=>item.index!>tableStart&&item[1]!.toLowerCase()===attachmentId))return null;
  if(lots.some(table=>{
    const rowQuote=table.additionalQuotes[0]??table.quote,at=content.indexOf(rowQuote),owner=headings.filter(item=>item.index!<at).at(-1);
    return !owner||owner[1]!.toLowerCase()!==attachmentId;
  }))return null;
  // The unique model row must be outside the attachment, with an explicit
  // source-local cross-reference to that exact attachment and its lot table.
  const rowAt=content.indexOf(models[0]!.quote);
  if(rowAt<0||rowAt>tableStart)return null;
  const notice=content.slice(0,headings[0]!.index!);
  const linkPatterns=[
    new RegExp(`\\b(?:see|refer to|listed in|provided in|enclosed in)\\s+(?:the\\s+)?Attachment\\s+${attachmentId}\\b[^\\n.]{0,100}\\b(?:affected\\s+)?(?:lots?|batches?)\\b`,`i`),
    new RegExp(`\\b(?:affected|recalled|included)\\s+(?:lots?|batches?)\\b[^\\n.]{0,100}\\b(?:listed|provided|shown|contained)\\s+in\\s+(?:the\\s+)?Attachment\\s+${attachmentId}\\b`,`i`),
    new RegExp(`\\bAttachment\\s+${attachmentId}\\b[^\\n.]{0,80}\\b(?:contains|lists|provides)\\b[^\\n.]{0,60}\\b(?:affected|recalled|included)\\s+(?:lots?|batches?)\\b`,`i`),
    new RegExp(`\\b(?:lot|batch)(?:\\s+number)?\\b[^\\n.]{0,100}\\b(?:listed|identified|included|provided)\\b[^\\n.]{0,80}\\bAttachment\\s+${attachmentId}\\b`,`i`),
    new RegExp(`\\b(?:devices?|products?|units?)\\b[^\\n.]{0,120}\\b(?:listed|identified|included)\\b[^\\n.]{0,80}\\bAttachment\\s+${attachmentId}\\b`,`i`),
  ];
  const linkedLines=notice.split("\n").filter(line=>linkPatterns.some(pattern=>pattern.test(line)));
  if(!linkedLines.length||linkedLines.some(line=>line.length>1000))return null;
  const linkQuote=linkedLines.find(line=>/\b(?:lot|batch)\b/i.test(line))??linkedLines[0]!;
  const identityRegion=content.slice(0,headings[0]!.index!);
  const explicitIds=[...identityRegion.matchAll(/\b(?:product|model(?:\s+(?:number|code|id))?|catalog(?:ue)?(?:\s+(?:number|code|id))?|UDI(?:[- ]?DI)?)\s*(?:is|number|code|:|=)?\s*([A-Za-z0-9][A-Za-z0-9._/-]*)/gi)].map(match=>match[1]!);
  if(explicitIds.some(value=>/[A-Za-z]/.test(value)&&/\d/.test(value)&&value!==model.value&&value!==udi&&!(value.endsWith("-")&&model.value.startsWith(value))))return null;
  const headingQuote=heading[0]!;
  if(headingQuote.length>1000)return null;
  return {value:model.value,udi,quote:model.quote,linkQuote,headingQuote};
}
function recordModelAndUdi(quote:string,recordId:string):{model:string|null;udi:string|null}|null {
  if(!quote.includes(recordId))return null;
  try{
    const value=JSON.parse(quote.trim());
    if(!value||typeof value!=="object"||Array.isArray(value)||value.recordId!==recordId&&value.record_id!==recordId&&value.id!==recordId)return null;
    const entries=Object.entries(value) as Array<[string,unknown]>;
    const modelValues=[...new Set(entries.filter(([key,item])=>/^(?:model|modelnumber|model_number|catalog(?:ue)?number|catalog(?:ue)?_number)$/i.test(key)&&typeof item==="string"&&item.trim()).map(([,item])=>(item as string).trim()))];
    const udiValues=[...new Set(entries.filter(([key,item])=>/^udi(?:di|_di|-di)?$/i.test(key)&&typeof item==="string"&&item.trim()).map(([,item])=>(item as string).trim()))];
    if(modelValues.length>1||udiValues.length>1)return null;
    return {model:modelValues[0]??null,udi:udiValues[0]??null};
  }catch{return null;}
}
function bridgedRecordIdentity(quote:string,recordId:string,model:string,udi:string):BoundRecordMatch["productIdentity"] {
  const ids=recordModelAndUdi(quote,recordId);if(!ids||(!ids.model&&!ids.udi))return "unknown";
  const comparisons=[...(ids.model?[ids.model===model]:[]),...(ids.udi?[ids.udi===udi]:[])];
  if(comparisons.every(Boolean))return "exact_quoted_identifier";
  if(comparisons.every(value=>!value))return "different_quoted_identifier";
  return "unknown";
}
function completeLotSet(content:string,quote:string,values:string[]):boolean {
  const lists=[...content.matchAll(/\b(?:affected |recalled |complete )?lots?(?: numbers?)?\s*[:=]\s*([^\n.;]+)/gi)];
  if(lists.length!==1)return false; // A table can continue on another page; a captured subset cannot prove exclusion.
  const list=lists[0]!;
  if(!quote.includes(list[0]))return false;
  const tokens=list[1]!.split(/[,\s]+/).filter(token=>token&&!/^(?:and|or)$/i.test(token));
  if(!tokens.length||tokens.some(token=>!/^[A-Za-z0-9][A-Za-z0-9_/-]*$/.test(token)))return false;
  return [...new Set(tokens.map(token=>token))].sort().join("\0")===[...new Set(values.map(value=>value.trim()))].sort().join("\0");
}
/** The caller supplies which criterion applies. This verifies literal field binding and arithmetic, not that policy interpretation. */
export function matchSourceBoundRecords(input:{runId:string;snapshotHash:string;selected:EvidenceEntry[];request:RecordMatchInput}):BoundRecordMatch[] {
  const {runId,snapshotHash,selected}=input;
  const request=recordMatchInputSchema.parse(input.request);
  if(!/^[0-9a-f-]{36}$/i.test(runId)||!/^[a-f0-9]{64}$/.test(snapshotHash))throw new TypeError("Invalid record match binding.");
  if(!request||!["lot","manufacture_date","product"].includes(request.criterion?.field)||!["one_of","between_inclusive"].includes(request.criterion?.operator)||!Array.isArray(request.criterion.values)||!request.criterion.values.length||request.criterion.values.length>30||!Array.isArray(request.records)||!request.records.length||request.records.length>12)throw new TypeError("Invalid bounded record match request.");
  const entries=new Map(selected.map(entry=>[entry.id,entry]));
  if(entries.size!==selected.length)throw new TypeError("Ambiguous selected sources.");
  const bind=(sourceId:string,quote:string,kind:"notice"|"record"):EvidenceQuote=>{
    const entry=entries.get(sourceId);
    if(!entry||entry.kind!==kind||entry.snapshotHash!==snapshotHash||sha(entry.content)!==entry.sourceHash||typeof quote!=="string"||!quote.trim()||quote.length>1000||!entry.content.includes(quote))throw new TypeError("Matching requires an exact quote from a selected canonical source of the requested kind.");
    return {sourceId:entry.id,sourceHash:entry.sourceHash,quote};
  };
  const criterion=bind(request.criterion.sourceId,request.criterion.quote,"notice");
  const criterionParts=[criterion,...(request.criterion.additionalQuotes??[]).map(quote=>bind(request.criterion.sourceId,quote,"notice"))];
  const {field,operator,values}=request.criterion;
  if(field!=="lot"&&criterionParts.length>1)throw new TypeError("Only explicit lot tables support multiple criterion spans.");
  const validLotValue=(value:string)=>explicitLotTables(entries.get(criterion.sourceId)!.content).some(table=>table.rows.some(row=>row.value===value&&criterionParts.some(part=>part.quote.includes(row.quote)))&&/\b(?:lot|lots|batch)\b/i.test(criterion.quote))||criterionParts.some(part=>[...part.quote.matchAll(/\b(?:affected |recalled |complete )?lots?(?: numbers?)?\s*[:=]\s*([^\n.;]+)/gi)].some(list=>list[1]!.split(/[,\s]+/).includes(value)));
  if(values.some(value=>typeof value!=="string"||!value.trim()||value.length>100||!criterionParts.some(part=>tokenIndex(part.quote,value)>=0)))throw new TypeError("Criterion values must be literal quoted and labelled notice values.");
  const criterionFieldExplicit=values.every(value=>field==="lot"?validLotValue(value):field==="product"?modelColumnRows(entries.get(criterion.sourceId)!.content).some(row=>row.value===value&&criterion.quote.includes(row.quote))||labelled(criterion.quote,field,value):labelled(criterion.quote,field,value));
  if(!criterionFieldExplicit&&field!=="product")throw new TypeError("Criterion values must be explicitly labelled and quoted from the notice.");
  if((field==="lot"||field==="product")&&operator!=="one_of"||field==="manufacture_date"&&(operator!=="between_inclusive"||values.length!==2))throw new TypeError("Lot sets and inclusive manufacture-date ranges are the supported criteria.");
  if(operator==="between_inclusive"&&!/\b(?:between|from|range)\b/i.test(criterion.quote))throw new TypeError("A date range must be explicit in the notice.");
  const normalizedCriterion=field!=="manufacture_date"?values.map(value=>value.trim()):values.map(value=>explicitDate(value));
  if(normalizedCriterion.some(value=>value===null)||operator==="between_inclusive"&&normalizedCriterion[0]!>normalizedCriterion[1]!)throw new TypeError("Criterion dates are invalid, ambiguous, or reversed.");
  const criterionProductQuote=request.criterion.productQuote??criterion.quote;
  const criterionProductProof=bind(request.criterion.sourceId,criterionProductQuote,"notice");
  const proposedProduct=explicitProduct(criterionProductQuote,request.criterion.product)?request.criterion.product!.trim():null;
  const productRegion=proposedProduct?noticeProductRegion(entries.get(request.criterion.sourceId)!.content,proposedProduct):null;
  const attachmentBridge=field==="lot"&&!proposedProduct?attachedSingleModelForLots(entries.get(request.criterion.sourceId)!.content,criterionParts.map(part=>part.quote)):null;
  const criterionProduct=productRegion&&values.every(value=>tokenIndex(productRegion,value)>=0&&labelled(productRegion,field,value))?proposedProduct:attachmentBridge?.value??null;
  const criterionCompleteness:BoundRecordMatch["criterionCompleteness"]=field==="manufacture_date"?"inclusive_date_range":completeLotSet(productRegion??"",criterion.quote,values)?"complete_explicit_list":"not_established";
  const seen=new Set<string>();
  return request.records.map(record=>{
    if(typeof record.recordId!=="string"||!record.recordId.trim()||record.recordId.length>200||seen.has(record.recordId)||tokenIndex(record.quote,record.recordId)<0||record.value!==null&&(typeof record.value!=="string"||!record.value.trim()||record.value.length>100||tokenIndex(record.quote,record.value)<0))throw new TypeError("Record IDs and values must be unique, literal quoted data.");
    seen.add(record.recordId);
    const recordProof=bind(record.sourceId,record.quote,"record");
    const block=entityBlock(record.quote,record.recordId);
    const productQuote=record.productQuote??record.quote;
    const productProof=bind(record.sourceId,productQuote,"record");
    const productBlock=entityBlock(productQuote,record.recordId);
    const recordProduct=productBlock&&explicitProduct(productBlock,record.product)?record.product!.trim():null;
    const productIdentity:BoundRecordMatch["productIdentity"]=field==="product"?"exact_quoted_identifier":attachmentBridge?bridgedRecordIdentity(productQuote,record.recordId,attachmentBridge.value,attachmentBridge.udi):criterionProduct&&recordProduct?(criterionProduct===recordProduct?"exact_quoted_identifier":"different_quoted_identifier"):"unknown";
    const bridgeProof=attachmentBridge?bind(request.criterion.sourceId,attachmentBridge.quote,"notice"):null;
    const linkProof=attachmentBridge?bind(request.criterion.sourceId,attachmentBridge.linkQuote,"notice"):null;
    const headingProof=attachmentBridge?bind(request.criterion.sourceId,attachmentBridge.headingQuote,"notice"):null;
    const evidence=[...new Map([...criterionParts,recordProof,criterionProductProof,productProof,...(bridgeProof?[bridgeProof]:[]),...(linkProof?[linkProof]:[]),...(headingProof?[headingProof]:[])].map(item=>[`${item.sourceId}\0${item.quote}`,item])).values()];
    const explicit=!!block&&labelled(block,field,record.value);
    const normalizedRecordValue=record.value===null?null:field!=="manufacture_date"?record.value.trim():explicitDate(record.value);
    let status:RecordMatchStatus="unknown",reason:BoundRecordMatch["reason"]=!explicit?"field_not_explicit":record.value===null?"record_value_unknown":"unparseable_date";
    if(!criterionFieldExplicit)reason="criterion_field_not_explicit";
    else if(productIdentity==="unknown")reason="product_identity_unknown";
    else if(productIdentity==="different_quoted_identifier"){status="no_match";reason="different_product";}
    else if(explicit&&normalizedRecordValue!==null){status=operator==="one_of"?(normalizedCriterion.includes(normalizedRecordValue)?"match":"no_match"):(normalizedRecordValue>=normalizedCriterion[0]!&&normalizedRecordValue<=normalizedCriterion[1]! ?"match":"no_match");reason=field==="lot"?"exact_lot_comparison":field==="product"?"exact_product_comparison":"inclusive_date_comparison";if(status==="no_match"&&field!=="manufacture_date"&&criterionCompleteness!=="complete_explicit_list"){status="unknown";reason="incomplete_lot_set";}}
    const bound={runId,snapshotHash,recordId:record.recordId,field,status,reason,criterionCompleteness,productIdentity,scopeStatus:"not_a_recall_scope_determination" as const,normalizedCriterion:normalizedCriterion as string[],normalizedRecordValue:explicit?normalizedRecordValue:null,evidence,verificationScope:"explicit_source_bound_field_comparison_only" as const};
    return {resultId:sha(JSON.stringify(bound)),...bound};
  });
}


export interface RecordCriterionReference {criterionRef:string;sourceId:string;sourceHash:string;field:RecordMatchInput["criterion"]["field"];operator:RecordMatchInput["criterion"]["operator"];values:string[];quote:string;additionalQuotes?:string[];product:string|null;productQuote:string}
export interface LocalRecordReference {recordRef:string;sourceId:string;sourceHash:string;recordIndex:number;recordId:string;quote:string;product:string|null;values:{lot:string|null;manufacture_date:string|null;product:string|null};identities:string[]}
export interface RecordReferenceCatalog {runId:string;snapshotHash:string;criteria:RecordCriterionReference[];criterionSections:Array<{criterionRef:string;sourceId:string;sourceHash:string;start:number;end:number;quote:string}>;records:LocalRecordReference[];unsupported:Array<{sourceId:string;reason:"no_explicit_supported_criterion"|"no_explicit_record_entities"|"entity_exceeds_quote_limit"}>}
export const recordReferenceInputSchema=z.object({criterionRef:z.string().regex(/^[a-f0-9]{64}$/),recordRefs:z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(12).optional(),criterion:z.object({field:z.enum(["lot","manufacture_date","product"]),operator:z.enum(["one_of","between_inclusive"]),values:z.array(z.string().min(1).max(100)).min(1).max(30),product:z.string().min(1).max(200).optional(),productSectionRef:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict().optional()}).strict();
export const recordReferenceInputJsonSchema=z.toJSONSchema(recordReferenceInputSchema);
export const recordReferenceBatchInputSchema=z.object({proposals:z.array(recordReferenceInputSchema).min(1).max(6)}).strict();
export const recordReferenceBatchInputJsonSchema=z.toJSONSchema(recordReferenceBatchInputSchema);
export type RecordReferenceInput=z.infer<typeof recordReferenceInputSchema>;

export class RecordReferenceError extends TypeError {constructor(public code:string){super(code);this.name="RecordReferenceError";}}
export const RECORD_REFERENCE_FEEDBACK:Record<string,string>={
 parsed_criterion_override_forbidden:"This is a parsed criterionRef. Send criterionRef and optional recordRefs; remove criterion entirely. Select a criterionSections reference if an explicit field proposal is needed.",
 unknown_criterion_reference:"Choose an exact criterionRef from the current parsed criteria or criterionSections catalog.",
 section_criterion_required:"A criterionSections reference requires the explicit criterion field, operator and literal values. A parsed criterionRef forbids this object.",
 unknown_record_reference:"Choose exact local recordRefs from this run's catalog.",
 duplicate_record_reference:"Include each recordRef at most once within a proposal.",
 cross_source_product_reference:"productSectionRef must be a presented section from the same source as the criterion section.",
 record_reference_not_pending:"Choose a still-pending criterion and its pending rows, or omit recordRefs to let the backend check all current pending rows for that criterion.",
 invalid_source_bound_values:"The proposal did not pass exact source/column/product binding. Use literal labelled values, keep the product and criterion in the same source entity, and never use expiry, pack size or distribution cells as lot values.",
};
export interface PendingRecordCheck {recordRef:string;noticeSourceId:string;field:RecordMatchInput["criterion"]["field"];applicableCriterionRefs:string[];checkedCriterionRefs:string[]}
/** Preserve the existing conservative field fallback, but do not advertise completed parsed pairs or section overrides. */
export function pendingRecordReferenceCatalog(catalog:RecordReferenceCatalog,checks:PendingRecordCheck[]):RecordReferenceCatalog {
 const refs=new Set(checks.map(check=>check.recordRef));
 const criteria=catalog.criteria.filter(criterion=>checks.some(check=>check.noticeSourceId===criterion.sourceId&&check.field===criterion.field&&check.applicableCriterionRefs.includes(criterion.criterionRef)&&!check.checkedCriterionRefs.includes(criterion.criterionRef)));
 const sectionSources=new Set(checks.filter(check=>check.applicableCriterionRefs.length===0).map(check=>check.noticeSourceId));
 return {...catalog,criteria,records:catalog.records.filter(record=>refs.has(record.recordRef)),criterionSections:catalog.criterionSections.filter(section=>sectionSources.has(section.sourceId))};
}
export function pendingRecordRefsForCriterion(catalog:RecordReferenceCatalog,criterionRef:string,field:RecordMatchInput["criterion"]["field"],checks:PendingRecordCheck[]):string[] {
 const parsed=catalog.criteria.find(criterion=>criterion.criterionRef===criterionRef),section=catalog.criterionSections.find(section=>section.criterionRef===criterionRef);
 const source=parsed?.sourceId??section?.sourceId;if(!source)throw new RecordReferenceError("unknown_criterion_reference");
 return [...new Set(checks.filter(check=>check.noticeSourceId===source&&check.field===field&&(parsed?check.applicableCriterionRefs.includes(criterionRef)&&!check.checkedCriterionRefs.includes(criterionRef):check.applicableCriterionRefs.length===0)).map(check=>check.recordRef))];
}
/** Exact shared advertised contract: parsed references cannot carry overrides; section references require them. */
export function recordReferenceProposalJsonSchemaForCatalog(catalog:RecordReferenceCatalog,recordRefs=catalog.records.map(record=>record.recordRef)):Record<string,unknown> {
 const schema=structuredClone(recordReferenceInputJsonSchema) as Record<string,any>;
 const ids=[...new Set(recordRefs)];if(!ids.length||ids.some(id=>!catalog.records.some(record=>record.recordRef===id)))throw new TypeError("Unknown advertised record references.");
 schema.properties.recordRefs.items.enum=ids;
 const branches:Record<string,unknown>[]=[];
 if(catalog.criteria.length){const parsed=structuredClone(schema);parsed.properties.criterionRef.enum=catalog.criteria.map(criterion=>criterion.criterionRef);delete parsed.properties.criterion;parsed.description="Parsed criterion: send criterionRef; omit recordRefs for all pending rows or provide a pending subset. criterion is forbidden; do not recopy or override parsed values.";branches.push(parsed);}
 if(catalog.criterionSections.length){const section=structuredClone(schema);section.properties.criterionRef.enum=catalog.criterionSections.map(value=>value.criterionRef);section.required=[...new Set([...section.required,"criterion"])];section.description="Section criterion: choose an exact source section and supply explicit criterion fields and literal values. Product section must belong to this same source.";branches.push(section);}
 if(!branches.length)throw new TypeError("No advertised criterion references.");
 return {anyOf:branches};
}


function quotedIdentities(text:string):string[] {
  const values:string[]=[];
  for(const match of text.matchAll(/"(?:product|model(?:Number|_number)?|UDI(?:DI|_DI|-DI)?|manufacturerRef|GTIN|SMN|catalog(?:ue)?(?:Number|Reference)?)"\s*:\s*("(?:\\.|[^"\\])*"|null)/gi)){
    try{const value=JSON.parse(match[1]!);if(typeof value==="string"&&value.trim())values.push(value.trim());}catch{}
  }
  for(const match of text.matchAll(/(?:^|[\n;])\s*(?:Product(?:[ _-]?(?:code|id|reference|name))?|Model(?:[ _-]?(?:number|code|id))?|UDI(?:[ _-]?DI)?|Catalog(?:ue)?(?:[ _-]?(?:code|number|reference))?|manufacturerRef)\s*[:=]\s*([^;\n]+)/gi))values.push(match[1]!.trim().replace(/[.]$/,""));
  for(const match of text.matchAll(/\b(?:GTIN|SMN)\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9_/-]*)/gi))values.push(match[1]!);
  return [...new Set(values)];
}
function quotedProduct(text:string):string|null {const values=quotedIdentities(text);return values.length===1?values[0]!:null;}
function labelledValue(text:string,field:"lot"|"manufacture_date"|"product"):string|null {
  const pattern=field==="lot"?/["']?(?:lot(?:Number|_number|[ _]number)?|batch(?:Number|[ _]number)?)["']?\s*[:=]\s*["']?([^;|,"'\n}]+)/i:/["']?(?:manufactureDate|manufacture_date|manufacturedOn|manufactur(?:e|ed|ing)(?:[ _-]?date)?)["']?\s*[:=]\s*["']?([^;|,"'\n}]+)/i;
  const value=text.match(pattern)?.[1]?.trim().replace(/[.]$/,"");
  return !value||/^(?:null|unknown|missing|not (?:recorded|available|specified))$/i.test(value)?null:value;
}
/** Exact JSON entity ranges, or explicit Record-labelled blocks. Never stringify a parsed entity into a quote. */
function localEntities(content:string):Array<{start:number;end:number;id:string}> {
  const json:Array<{start:number;end:number;id:string}>=[];let quoted=false,escaped=false;const stack:number[]=[];
  for(let index=0;index<content.length;index++){
    const char=content[index]!;
    if(quoted){if(escaped)escaped=false;else if(char==="\\")escaped=true;else if(char==='"')quoted=false;continue;}
    if(char==='"'){quoted=true;continue;}if(char==="{")stack.push(index);
    if(char==="}"){const start=stack.pop();if(start===undefined)continue;try{const value=JSON.parse(content.slice(start,index+1));const id=value.recordId??value.record_id??value.id;if(typeof id==="string"&&id.trim())json.push({start,end:index+1,id});}catch{/* Non-JSON text is handled only by explicit Record labels below. */}}
  }
  if(json.length)return json.sort((a,b)=>a.start-b.start);
  const labels=[...content.matchAll(/\bRecord\s+([A-Za-z0-9_.:/-]+)\b/gi)];
  return labels.map((match,index)=>({start:match.index!,end:labels[index+1]?.index??content.length,id:match[1]!}));
}
/** Explicit candidates only. References are bound to exact full source text and this run/snapshot. No criterion is selected here. */
export function buildRecordReferenceCatalog(input:{runId:string;snapshotHash:string;selected:EvidenceEntry[]}):RecordReferenceCatalog {
  const result:RecordReferenceCatalog={runId:input.runId,snapshotHash:input.snapshotHash,criteria:[],criterionSections:[],records:[],unsupported:[]};
  for(const entry of input.selected){
    if(entry.snapshotHash!==input.snapshotHash||sha(entry.content)!==entry.sourceHash)throw new TypeError("Record reference source binding is stale.");
    if(entry.kind==="record"){
      const entities=localEntities(entry.content);if(!entities.length){result.unsupported.push({sourceId:entry.id,reason:"no_explicit_record_entities"});continue;}
      for(const [recordIndex,entity] of entities.entries()){
        const quote=entry.content.slice(entity.start,entity.end).trim();if(quote.length>1000){result.unsupported.push({sourceId:entry.id,reason:"entity_exceeds_quote_limit"});continue;}
        const bound={sourceId:entry.id,sourceHash:entry.sourceHash,recordIndex,recordId:entity.id,quote,product:quotedProduct(quote),values:{lot:labelledValue(quote,"lot"),manufacture_date:labelledValue(quote,"manufacture_date"),product:(()=>{try{const value=JSON.parse(quote).product;return typeof value==="string"?value:quotedIdentities(quote)[0]??null;}catch{return quotedIdentities(quote)[0]??null;}})()},identities:quotedIdentities(quote)};
        result.records.push({recordRef:sha(JSON.stringify([input.runId,input.snapshotHash,bound])),...bound});
      }
      continue;
    }
    for(const unit of evidenceUnits(entry.content,true))if(unit.end-unit.start<=1000)result.criterionSections.push({criterionRef:sha(JSON.stringify([input.runId,input.snapshotHash,entry.id,entry.sourceHash,unit.start,unit.end])),sourceId:entry.id,sourceHash:entry.sourceHash,start:unit.start,end:unit.end,quote:entry.content.slice(unit.start,unit.end)});
    // An explicit product region is needed for matching. Multiple products are never joined.
    const productLabels=[...entry.content.matchAll(/\b(?:Product(?:[ _-]?(?:code|id|reference))?|Model(?:[ _-]?(?:number|code|id))?|UDI(?:[ _-]?DI)?|Catalog(?:ue)?(?:[ _-]?(?:code|number|reference))?|manufacturerRef|manufacturer[ _-]?reference|item[ _-]?code|GTIN|SMN)\b["']?\s*[:=]/gi)];
    const regions=productLabels.length?productLabels.map((label,index)=>({start:label.index!,end:productLabels[index+1]?.index??entry.content.length})):[{start:0,end:entry.content.length}];
    const before=result.criteria.length;
    for(const table of explicitLotTables(entry.content)){
      const identities=quotedIdentities(entry.content),product=identities.length===1?identities[0]!:null;
      const productQuote=entry.content.split(/\n/).find(line=>product!==null&&quotedIdentities(line).includes(product))??table.quote;
      if(table.quote.length<=1000){const bound={sourceId:entry.id,sourceHash:entry.sourceHash,field:"lot" as const,operator:"one_of" as const,values:table.values,quote:table.quote,additionalQuotes:table.additionalQuotes,product,productQuote};result.criteria.push({criterionRef:sha(JSON.stringify([input.runId,input.snapshotHash,bound])),...bound});}
    }
    for(const row of modelColumnRows(entry.content)){
      const bound={sourceId:entry.id,sourceHash:entry.sourceHash,field:"product" as const,operator:"one_of" as const,values:[row.value],quote:row.quote,product:null,productQuote:row.header};result.criteria.push({criterionRef:sha(JSON.stringify([input.runId,input.snapshotHash,bound])),...bound});
    }
    for(const region of regions){
      const text=entry.content.slice(region.start,region.end),product=quotedProduct(text);
      const productLine=text.split(/\n/).find(line=>quotedProduct(line)===product)??text;
      const add=(quote:string,field:RecordMatchInput["criterion"]["field"],operator:RecordMatchInput["criterion"]["operator"],values:string[])=>{
        if(!quote.trim()||quote.length>1000||productLine.length>1000)return;
        const bound={sourceId:entry.id,sourceHash:entry.sourceHash,field,operator,values,quote,product,productQuote:productLine.trim()};
        result.criteria.push({criterionRef:sha(JSON.stringify([input.runId,input.snapshotHash,bound])),...bound});
      };
      for(const match of text.matchAll(/\b(?:affected |recalled |complete )?lots?(?: numbers?)?\s*[:=]\s*([^\n.;]+)/gi)){
        const values=match[1]!.split(/[,\s]+/).filter(value=>value&&!/^(?:and|or)$/i.test(value));
        if(values.length&&values.length<=30&&values.every(value=>/^[A-Za-z0-9][A-Za-z0-9_/-]*$/.test(value)))add(match[0],"lot","one_of",values);
      }
      for(const match of text.matchAll(/\bmanufactur(?:e|ed|ing)(?:[ _-]?date)?[\s\S]{0,80}?\b(?:between|from|range)\b[\s\S]{0,40}?(\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]+\s+\d{4})\s*(?:through|to|and|[-–])\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]+\s+\d{4})/gi)){
        if(explicitDate(match[1]!)&&explicitDate(match[2]!))add(match[0],"manufacture_date","between_inclusive",[match[1]!,match[2]!]);
      }
    }
    if(result.criteria.length===before)result.unsupported.push({sourceId:entry.id,reason:"no_explicit_supported_criterion"});
  }
  // Literal entity joins are candidates, not source-field assertions. An unlabelled
  // mention is retained as an unknown comparison; it can never become a match or clearance.
  for(const entry of input.selected.filter(entry=>entry.kind==="notice")){
    if(result.criteria.some(criterion=>criterion.sourceId===entry.id&&criterion.field!=="product")&&!result.records.some(record=>!/\b(?:lot(?:[ _-]?Number)?|batch(?:[ _-]?Number)?|manufactur(?:e|ed|ing)(?:[ _-]?date)?|manufactureDate|manufacturedOn)["\']?\s*[:=]/i.test(record.quote)))continue;
    const identities=[...new Set(result.records.flatMap(record=>record.identities))];
    for(const identity of identities){
      if(identity.length>100||result.criteria.some(criterion=>criterion.sourceId===entry.id&&criterion.field==="product"&&criterion.values.includes(identity)))continue;
      const at=tokenIndex(entry.content,identity);if(at<0)continue;
      const unit=evidenceUnits(entry.content,true).find(unit=>unit.start<=at&&unit.end>=at+identity.length&&unit.end-unit.start<=1000);if(!unit)continue;
      const quote=entry.content.slice(unit.start,unit.end),bound={sourceId:entry.id,sourceHash:entry.sourceHash,field:"product" as const,operator:"one_of" as const,values:[identity],quote,product:null,productQuote:quote};
      result.criteria.push({criterionRef:sha(JSON.stringify([input.runId,input.snapshotHash,bound])),...bound});
    }
  }
  return result;
}
export function resolveRecordReferenceInput(catalog:RecordReferenceCatalog,request:RecordReferenceInput,pendingChecks?:PendingRecordCheck[]):RecordMatchInput {
  const parsed=recordReferenceInputSchema.parse(request);
  if(parsed.recordRefs&&new Set(parsed.recordRefs).size!==parsed.recordRefs.length)throw new RecordReferenceError("duplicate_record_reference");
  let criterion=catalog.criteria.find(value=>value.criterionRef===parsed.criterionRef);
  if(criterion&&parsed.criterion)throw new RecordReferenceError("parsed_criterion_override_forbidden");
  if(!criterion){
    const section=catalog.criterionSections.find(value=>value.criterionRef===parsed.criterionRef);
    if(!section)throw new RecordReferenceError("unknown_criterion_reference");
    if(!parsed.criterion)throw new RecordReferenceError("section_criterion_required");
    const productSection=parsed.criterion.productSectionRef?catalog.criterionSections.find(value=>value.criterionRef===parsed.criterion!.productSectionRef&&value.sourceId===section.sourceId):section;
    if(!productSection)throw new RecordReferenceError("cross_source_product_reference");
    criterion={criterionRef:section.criterionRef,sourceId:section.sourceId,sourceHash:section.sourceHash,quote:section.quote,field:parsed.criterion.field,operator:parsed.criterion.operator,values:parsed.criterion.values,product:parsed.criterion.product??null,productQuote:productSection.quote};
  }
  const {sourceId,quote,additionalQuotes,field,operator,values,product,productQuote}=criterion;
  const allowed=pendingChecks?pendingRecordRefsForCriterion(catalog,parsed.criterionRef,field,pendingChecks):catalog.records.map(record=>record.recordRef);
  const recordRefs=parsed.recordRefs??allowed;
  if(!recordRefs.length||pendingChecks&&recordRefs.some(ref=>!allowed.includes(ref)))throw new RecordReferenceError("record_reference_not_pending");
  return {criterion:{sourceId,quote,...(additionalQuotes?.length?{additionalQuotes}:{}),field,operator,values,product,productQuote},records:recordRefs.map(ref=>{
    const record=catalog.records.find(value=>value.recordRef===ref);if(!record)throw new RecordReferenceError("unknown_record_reference");
    const value=field==="product"?record.identities.find(identity=>values.includes(identity))??record.values.product:record.values[field];
    return {sourceId:record.sourceId,quote:record.quote,recordId:record.recordId,value,product:criterion.product&&record.identities.includes(criterion.product)?criterion.product:record.product};
  })};
}

/** Mechanical scheduling over the complete observed catalog; no policy interpretation. */
export function automaticRecordReferenceProposals(catalog:RecordReferenceCatalog,checks:PendingRecordCheck[],maxResults=12):RecordReferenceInput[]{
  if(!Number.isInteger(maxResults)||maxResults<0||maxResults>24)throw new RangeError("Invalid automatic matching capacity.");
  let scheduled=0;
  const groups=new Map<string,RecordReferenceInput>();
  for(const check of checks){
    if(scheduled>=maxResults)break;
    const record=catalog.records.find(record=>record.recordRef===check.recordRef);if(!record)throw new RecordReferenceError("unknown_record_reference");
    const candidates=catalog.criteria.filter(criterion=>check.applicableCriterionRefs.includes(criterion.criterionRef)&&!check.checkedCriterionRefs.includes(criterion.criterionRef));
    if(!candidates.length)continue;
    const values=check.field==="product"?record.identities:[record.values[check.field]];
    const criterion=candidates.find(criterion=>criterion.values.some(value=>values.includes(value)))??candidates[0]!;
    if(!groups.has(criterion.criterionRef)&&groups.size>=6)continue;
    const proposal=groups.get(criterion.criterionRef)??{criterionRef:criterion.criterionRef,recordRefs:[]};
    if(proposal.recordRefs!.some(ref=>catalog.records.find(candidate=>candidate.recordRef===ref)?.recordId===record.recordId))continue;
    if(proposal.recordRefs!.length<12){proposal.recordRefs!.push(record.recordRef);scheduled++;}
    groups.set(criterion.criterionRef,proposal);
  }
  return [...groups.values()];
}
