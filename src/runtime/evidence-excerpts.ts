import { createHash } from "node:crypto";
import type { EvidenceEntry,EvidenceQuote } from "../shared/investigation.ts";

export const MAX_EVIDENCE_EXCERPT_CHARS = 1_000;
export const MAX_EVIDENCE_EXCERPT_CATALOG_BYTES = 80_000;
export const MAX_EVIDENCE_CONTEXT_BYTES = 80_000;
export const MAX_EVIDENCE_REQUEST_BYTES = 96_000;

export interface EvidenceExcerpt {
  quoteId: string;
  runId: string;
  snapshotHash: string;
  sourceId: string;
  sourceHash: string;
  start: number;
  end: number;
  text: string;
}

export interface EvidenceExcerptOmission {
  sourceId: string;
  sourceHash: string;
  totalSegments: number;
  presentedSegments: number;
  omittedSegments: number;
  omittedRanges: Array<{ start: number; end: number }>;
}

export interface EvidenceExcerptCatalog {
  runId: string;
  snapshotHash: string;
  entries: EvidenceExcerpt[];
  omissions: EvidenceExcerptOmission[];
  bytes: number;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Literal identifiers only: no inferred lot numbers or dates are manufactured. */
export function evidenceFocusTerms(text: string): string[] {
  return [...new Set((text.match(/[\p{L}\p{N}][\p{L}\p{N}._:/-]{2,}/gu) ?? []).map(token=>token.replace(/[.,:;]+$/g,"" )).filter(token => /\d/.test(token)))].slice(0, 80);
}

/** Exact identifier/date tokens, not prefixes of longer identifiers. A terminal sentence period is punctuation. */
export function exactEvidenceTokenIndex(text:string,value:string):number {
  let from=0;
  for(;;){
    const index=text.indexOf(value,from);if(index<0)return -1;
    const left=text[index-1]??"",right=text[index+value.length]??"",after=text[index+value.length+1]??"";
    const identifier=/[\p{L}\p{N}_/:-]/u;
    const badLeft=identifier.test(left)||left==="."&&identifier.test(text[index-2]??"");
    const badRight=identifier.test(right)||right==="."&&identifier.test(after);
    if(!badLeft&&!badRight)return index;
    from=index+1;
  }
}

interface SourceUnit { start: number; end: number; tableHeader?: {start:number;end:number} }
function joinedUnits(content:string,units:SourceUnit[]):SourceUnit[]{
 const joined:SourceUnit[]=[];for(const unit of units){const prior=joined.at(-1),headerIsSeparate=unit.tableHeader&&(prior?.start===unit.tableHeader.start||prior?.tableHeader?.start!==unit.tableHeader.start);if(prior&&!headerIsSeparate&&unit.end-prior.start<=MAX_EVIDENCE_EXCERPT_CHARS&&content.slice(prior.end,unit.start).trim()==="")prior.end=unit.end;else joined.push({...unit});}return joined;
}
/** Only syntactically valid arrays of explicit record objects are treated as embedded records. */
function embeddedRecordArrays(content:string):Array<{start:number;end:number;records:Array<{start:number;end:number}>}>{
 const arrays:Array<{start:number;end:number;records:Array<{start:number;end:number}>}>=[];
 for(let start=content.indexOf("[");start>=0;start=content.indexOf("[",start+1)){
  let depth=0,quoted=false,escaped=false,end=-1;
  for(let index=start;index<content.length;index++){const char=content[index]!;if(quoted){if(escaped)escaped=false;else if(char==="\\")escaped=true;else if(char==='"')quoted=false;continue;}if(char==='"'){quoted=true;continue;}if(char==="[")depth++;if(char==="]"&&--depth===0){end=index+1;break;}}
  if(end<0)continue;let values:unknown;try{values=JSON.parse(content.slice(start,end));}catch{continue;}
  if(!Array.isArray(values)||!values.length||values.some(value=>!value||typeof value!=="object"||Array.isArray(value)||typeof(value.recordId??value.record_id??value.id)!=="string"))continue;
  const records:Array<{start:number;end:number}>=[];let objectDepth=0,objectStart=-1;quoted=false;escaped=false;
  for(let index=start+1;index<end-1;index++){const char=content[index]!;if(quoted){if(escaped)escaped=false;else if(char==="\\")escaped=true;else if(char==='"')quoted=false;continue;}if(char==='"'){quoted=true;continue;}if(char==="{"){if(objectDepth===0)objectStart=index;objectDepth++;}if(char==="}"&&--objectDepth===0)records.push({start:objectStart,end:index+1});}
  if(records.length!==values.length)continue;arrays.push({start,end,records});start=end-1;
 }
 return arrays;
}
/** Complete paragraphs, sentences or table rows. An overlong indivisible unit is omitted, never chopped. */
export function evidenceUnits(content: string, coalesce = false): SourceUnit[] {
  const units: SourceUnit[] = [];
  const add = (start:number,end:number,tableHeader?:SourceUnit["tableHeader"]) => {
    while(start<end && /\s/.test(content[start]!))start++;
    while(end>start && /\s/.test(content[end-1]!))end--;
    if(end>start)units.push({start,end,...(tableHeader?{tableHeader}:{})});
  };
  const arrays=embeddedRecordArrays(content);
  if(arrays.length){let cursor=0;for(const array of arrays){for(const unit of evidenceUnits(content.slice(cursor,array.start)))add(cursor+unit.start,cursor+unit.end);if(array.end-array.start<=MAX_EVIDENCE_EXCERPT_CHARS)add(array.start,array.end);else for(const record of array.records)add(record.start,record.end);cursor=array.end;}for(const unit of evidenceUnits(content.slice(cursor)))add(cursor+unit.start,cursor+unit.end);return coalesce?joinedUnits(content,units):units;}
  // JSON records preserve the original contiguous object bytes, not JSON.stringify output.
  let validJson=false;try{JSON.parse(content);validJson=true;}catch{}
  if(validJson){
    let quoted=false,escaped=false;const stack:number[]=[];
    for(let index=0;index<content.length;index++){
      const char=content[index]!;
      if(quoted){if(escaped)escaped=false;else if(char==="\\")escaped=true;else if(char==='"')quoted=false;continue;}
      if(char==='"'){quoted=true;continue;}if(char==="{")stack.push(index);
      if(char==="}"){const start=stack.pop();if(start===undefined)continue;try{const value=JSON.parse(content.slice(start,index+1));if(typeof (value.recordId??value.record_id??value.id)==="string")add(start,index+1);}catch{}}
    }
    if(units.length){units.sort((a,b)=>a.start-b.start);return coalesce?joinedUnits(content,units):units;}
  }
  const paragraphs:Array<{start:number;end:number}>=[];
  let start=0;
  for(const match of content.matchAll(/\n[ \t]*\n+/g)){paragraphs.push({start,end:match.index!});start=match.index!+match[0].length;}
  paragraphs.push({start,end:content.length});
  const segmenter=new Intl.Segmenter("en",{granularity:"sentence"});
  for(const paragraph of paragraphs){
    const text=content.slice(paragraph.start,paragraph.end);
    const lines=[...text.matchAll(/[^\n]+/g)];
    const tabular=lines.length>1 && lines.filter(line=>/[|\t]|\S {2,}\S/.test(line[0])).length>=2;
    if(tabular){
      const first=lines.find(line=>/[|\t]|\S {2,}\S/.test(line[0]))!;
      const header={start:paragraph.start+first.index!,end:paragraph.start+first.index!+first[0].length};
      for(const line of lines)add(paragraph.start+line.index!,paragraph.start+line.index!+line[0].length,header);
    } else if(text.length<=MAX_EVIDENCE_EXCERPT_CHARS)add(paragraph.start,paragraph.end);
    else {
      let groupStart:number|null=null,groupEnd=0;
      for(const sentence of segmenter.segment(text)){
        const start=paragraph.start+sentence.index,end=start+sentence.segment.length;
        if(groupStart!==null&&end-groupStart>MAX_EVIDENCE_EXCERPT_CHARS){add(groupStart,groupEnd);groupStart=null;}
        if(groupStart===null)groupStart=start;
        groupEnd=end;
        if(end-groupStart>MAX_EVIDENCE_EXCERPT_CHARS){add(groupStart,end);groupStart=null;}
      }
      if(groupStart!==null)add(groupStart,groupEnd);
    }
  }
  return coalesce?joinedUnits(content,units):units;
}

function splitsSurrogatePair(content: string, offset: number): boolean {
  return offset > 0 && offset < content.length &&
    /[\uD800-\uDBFF]/.test(content[offset - 1]!) && /[\uDC00-\uDFFF]/.test(content[offset]!);
}

function makeQuoteId(runId: string, snapshotHash: string, sourceId: string, sourceHash: string, start: number, end: number): string {
  return sha256(JSON.stringify([runId, snapshotHash, sourceId, sourceHash, start, end]));
}

interface Candidate {
  source: EvidenceEntry;
  start: number;
  end: number;
  text: string;
  quoteId: string;
}

function candidatesFor(runId: string, snapshotHash: string, selected: EvidenceEntry[], focusTerms: string[], coalesce = false): Candidate[][] {
  const seen = new Set<string>();
  const terms=[...new Set(focusTerms.filter(term=>typeof term==="string"&&term.length>=3&&term.length<=200).map(term=>term.toLocaleLowerCase("en")))].slice(0,80);
  return selected.map(source => {
    if (!source || typeof source.id !== "string" || !source.id || seen.has(source.id) || source.snapshotHash !== snapshotHash || !validHash(source.sourceHash) || typeof source.content !== "string" || sha256(source.content) !== source.sourceHash) {
      throw new TypeError("Selected evidence is duplicated or not bound to the requested snapshot.");
    }
    seen.add(source.id);
    const units=evidenceUnits(source.content,coalesce);
    const score=(unit:SourceUnit)=>terms.filter(term=>exactEvidenceTokenIndex(source.content.slice(unit.start,unit.end).toLocaleLowerCase("en"),term)>=0).length;
    // Matching late rows come first; neighbouring table headers remain independently citable units.
    const ordered=[...units].sort((a,b)=>score(b)-score(a)||a.start-b.start);
    const candidates:Candidate[]=[];
    const added=new Set<number>();
    const append=(unit:SourceUnit)=>{
      if(added.has(unit.start))return;added.add(unit.start);
      const {start,end}=unit;
      if(splitsSurrogatePair(source.content,start)||splitsSurrogatePair(source.content,end))throw new TypeError("Evidence boundary splits a Unicode surrogate pair.");
      candidates.push({source,start,end,text:source.content.slice(start,end),quoteId:makeQuoteId(runId,snapshotHash,source.id,source.sourceHash,start,end)});
    };
    for(const unit of ordered){
      if(unit.tableHeader&&score(unit)>0){const header=units.find(item=>item.start===unit.tableHeader!.start);if(header)append(header);}
      append(unit);
    }
    return candidates;
  });
}

function coalesceOmittedRanges(candidates: Candidate[], included: Set<string>): Array<{ start: number; end: number }> {
  const presented=candidates.filter(candidate=>included.has(candidate.quoteId));
  const omitted = candidates.filter(candidate => !presented.some(span=>span.start<=candidate.start&&span.end>=candidate.end)).sort((a,b)=>a.start-b.start);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const candidate of omitted) {
    const last = ranges.at(-1);
    if (last && candidate.source.content.slice(last.end,candidate.start).trim()==="") last.end = candidate.end;
    else ranges.push({ start: candidate.start, end: candidate.end });
  }
  return ranges;
}

/**
 * Build an order-preserving, round-robin catalog of exact contiguous source spans.
 * The caller chooses the byte budget; omitted ranges are explicit and no relevance
 * ranking or quote content is inferred by this helper.
 */
export function buildEvidenceExcerptCatalog(input: {
  runId: string;
  snapshotHash: string;
  selected: EvidenceEntry[];
  maxBytes: number;
  focusTerms?: string[];
  coalesce?: boolean;
  /** Already checked scalar proof text; add a complete-unit covering option, never an automatic citation. */
  supportQuotes?: EvidenceQuote[];
}): EvidenceExcerptCatalog {
  const { runId, snapshotHash, selected, maxBytes } = input;
  if (!/^[0-9a-f-]{36}$/i.test(runId) || !validHash(snapshotHash) || !Array.isArray(selected) || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_EVIDENCE_EXCERPT_CATALOG_BYTES) {
    throw new TypeError("Evidence excerpt catalog binding or byte limit is invalid.");
  }
  const bySource = candidatesFor(runId, snapshotHash, selected, input.focusTerms ?? [],input.coalesce===true);
  const requiredIds=new Set<string>();
  for(const proof of input.supportQuotes??[]){
    const source=selected.find(entry=>entry.id===proof.sourceId&&entry.sourceHash===proof.sourceHash);
    if(!source||!proof.quote||proof.quote.length>1000)throw new TypeError("Matching proof source is stale or unsupported.");
    const offset=source.content.indexOf(proof.quote);if(offset<0)throw new TypeError("Matching proof is not exact source text.");
    const units=evidenceUnits(source.content),cover=units.filter(unit=>unit.end>offset&&unit.start<offset+proof.quote.length);
    const start=cover[0]===undefined?undefined:Math.min(cover[0].start,offset),end=cover.at(-1)===undefined?undefined:Math.max(cover.at(-1)!.end,offset+proof.quote.length);
    if(start===undefined||end===undefined||end-start>1000)throw new RangeError("A complete matching-proof covering span exceeds the excerpt limit.");
    const quoteId=makeQuoteId(runId,snapshotHash,source.id,source.sourceHash,start,end);
    requiredIds.add(quoteId);
    const candidates=bySource[selected.indexOf(source)]!;
    if(!candidates.some(candidate=>candidate.quoteId===quoteId))candidates.unshift({source,start,end,text:source.content.slice(start,end),quoteId});
  }
  const included: EvidenceExcerpt[] = [];
  const includedIds = new Set<string>();
  const serialize = (): { entries: EvidenceExcerpt[]; omissions: EvidenceExcerptOmission[] } => ({
    entries: included,
    omissions: bySource.flatMap((candidates, index) => {
      const source = selected[index]!;
      const omittedRanges = coalesceOmittedRanges(candidates, includedIds);
      if (!omittedRanges.length) return [];
      const presentedSegments = candidates.length - omittedRanges.reduce((sum, range) => sum + candidates.filter(candidate => candidate.start >= range.start && candidate.end <= range.end).length, 0);
      return [{ sourceId: source.id, sourceHash: source.sourceHash, totalSegments: candidates.length, presentedSegments, omittedSegments: candidates.length - presentedSegments, omittedRanges }];
    }),
  });
  const candidates: Candidate[] = [];
  const maxSegments = Math.max(0, ...bySource.map(items => items.length));
  for (let index = 0; index < maxSegments; index++) for (const items of bySource) if (items[index]) candidates.push(items[index]!);
  candidates.sort((a,b)=>Number(requiredIds.has(b.quoteId))-Number(requiredIds.has(a.quoteId)));
  for (const candidate of candidates) {
    if(candidate.end-candidate.start>MAX_EVIDENCE_EXCERPT_CHARS)continue;
    const source = candidate.source;
    const row: EvidenceExcerpt = { quoteId: candidate.quoteId, runId, snapshotHash, sourceId: source.id, sourceHash: source.sourceHash, start: candidate.start, end: candidate.end, text: candidate.text };
    included.push(row);
    includedIds.add(row.quoteId);
    const encoded = serialize();
    if (Buffer.byteLength(JSON.stringify(encoded), "utf8") > maxBytes) {
      included.pop();
      includedIds.delete(row.quoteId);
      continue;
    }
  }
  if([...requiredIds].some(id=>!includedIds.has(id)))throw new RangeError("Required matching proof coverage exceeds the catalog byte limit.");
  const result = serialize();
  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (bytes > maxBytes) throw new RangeError("Evidence excerpt omission metadata exceeds the catalog byte limit.");
  return { runId, snapshotHash, ...result, bytes };
}

/** Re-check every quote binding against the trusted full source body before use. */
export function validateEvidenceExcerptCatalog(input: {
  runId: string;
  snapshotHash: string;
  selected: EvidenceEntry[];
  catalog: EvidenceExcerptCatalog;
}): Map<string, EvidenceExcerpt> {
  const { runId, snapshotHash, selected, catalog } = input;
  if (catalog.runId !== runId || catalog.snapshotHash !== snapshotHash || !Array.isArray(catalog.entries)) throw new TypeError("Evidence excerpt catalog is stale or belongs to another run.");
  const selectedById = new Map<string, EvidenceEntry>();
  const boundaries = new Map<string, Set<string>>();
  for (const entry of selected) {
    if (selectedById.has(entry.id)) throw new TypeError("Selected evidence IDs must be unique.");
    selectedById.set(entry.id, entry);
    const units=evidenceUnits(entry.content),ranges=new Set([...units,...evidenceUnits(entry.content,true)].map(unit=>`${unit.start}:${unit.end}`));
    for(let first=0;first<units.length;first++)for(let last=first+1;last<units.length&&units[last]!.end-units[first]!.start<=1000;last++)ranges.add(`${units[first]!.start}:${units[last]!.end}`);
    boundaries.set(entry.id,ranges);
  }
  const seen = new Set<string>();
  const validated = new Map<string, EvidenceExcerpt>();
  for (const excerpt of catalog.entries) {
    if (!excerpt || seen.has(excerpt.quoteId) || excerpt.runId !== runId || excerpt.snapshotHash !== snapshotHash ||
        !Number.isSafeInteger(excerpt.start) || !Number.isSafeInteger(excerpt.end) || excerpt.start < 0 || excerpt.end <= excerpt.start ||
        excerpt.end - excerpt.start > MAX_EVIDENCE_EXCERPT_CHARS || typeof excerpt.text !== "string") throw new TypeError("Evidence excerpt catalog entry is invalid.");
    const source = selectedById.get(excerpt.sourceId);
    let boundaryStart=excerpt.start,boundaryEnd=excerpt.end;
    if(source){while(boundaryStart<boundaryEnd&&/\s/.test(source.content[boundaryStart]!))boundaryStart++;while(boundaryEnd>boundaryStart&&/\s/.test(source.content[boundaryEnd-1]!))boundaryEnd--;}
    if (!source || source.sourceHash !== excerpt.sourceHash || source.snapshotHash !== snapshotHash ||
        sha256(source.content) !== source.sourceHash ||
        excerpt.end > source.content.length || splitsSurrogatePair(source.content, excerpt.start) || splitsSurrogatePair(source.content, excerpt.end) ||
        source.content.slice(excerpt.start, excerpt.end) !== excerpt.text || !boundaries.get(excerpt.sourceId)?.has(`${boundaryStart}:${boundaryEnd}`) ||
        makeQuoteId(runId, snapshotHash, excerpt.sourceId, excerpt.sourceHash, excerpt.start, excerpt.end) !== excerpt.quoteId) {
      throw new TypeError("Evidence excerpt is unselected, stale, or does not match its exact source range.");
    }
    seen.add(excerpt.quoteId);
    validated.set(excerpt.quoteId, excerpt);
  }
  if (catalog.bytes > MAX_EVIDENCE_EXCERPT_CATALOG_BYTES || Buffer.byteLength(JSON.stringify({ entries: catalog.entries, omissions: catalog.omissions }), "utf8") !== catalog.bytes) throw new TypeError("Evidence excerpt catalog byte count is invalid.");
  return validated;
}
