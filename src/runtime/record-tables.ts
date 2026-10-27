type Span={start:number;end:number;text:string};
type TableRow={start:number;end:number;text:string;values:string[]};
type ColumnHeader={label:string;center:number;left:number;right:number};
type LayoutHeader=ColumnHeader&{kind:"lot"|"other"};
export type ExplicitLotTable={quote:string;additionalQuotes:string[];values:string[];rows:Array<{value:string;quote:string}>};
export type ModelColumnRow={value:string;quote:string;header:string};

function linesOf(content:string):Span[]{
  const out:Span[]=[];const re=/[^\n]*(?:\n|$)/g;let match:RegExpExecArray|null;
  while((match=re.exec(content))!==null){if(!match[0])break;const text=match[0].replace(/\n$/,"" );if(text.trim())out.push({start:match.index,end:match.index+text.length,text});}
  return out;
}
function cellHeaders(line:Span,kind:"lot"|"model"):ColumnHeader[]{
  const patterns=kind==="lot"?/\b(?:lot|batch)(?:\s+(?:number|no\.?|code)s?)?(?=\s|$)/gi:/\bmodel(?:\s*\/\s*catalog(?:ue)?|\s+catalog(?:ue))?(?:\s+(?:number|no\.?|code))?\b/gi;
  const out:ColumnHeader[]=[];let match:RegExpExecArray|null;
  while((match=patterns.exec(line.text))!==null){const left=match.index,right=left+match[0].length;
    if(kind==="lot"&&!(/[ \t]{2,}$/.test(line.text.slice(0,left))||/^[ \t]{2,}/.test(line.text.slice(right))))continue;
    out.push({label:match[0],center:(left+right)/2,left,right});}
  return out;
}
function layoutHeaders(line:Span):LayoutHeader[]{
  const re=/\b(?:lot|batch)(?:\s+(?:number|no\.?|code)s?)?(?=\s|$)|\b(?:product\s+(?:name|code|number)|model(?:\s*\/\s*catalog(?:ue)?|\s+catalog(?:ue))?(?:\s+(?:number|no\.?|code))?|UDI(?:[- ]?DI)?|(?:material\s+)?description|pack(?:age)?\s+size|quantity|expiry\s+date|expiration\s+date|manufactur(?:e|ing)\s+date|US\s+Product\s+Distribution|distribution)\b/gi;
  const out:LayoutHeader[]=[];let match:RegExpExecArray|null;while((match=re.exec(line.text))!==null){const left=match.index,right=left+match[0].length;
    if(!(/[ \t]{2,}$/.test(line.text.slice(0,left))||/^[ \t]{2,}/.test(line.text.slice(right))))continue;
    out.push({label:match[0],center:(left+right)/2,left,right,kind:/^(?:lot|batch)\b/i.test(match[0])?"lot":"other"});}return out;
}
function tokenCells(line:Span):Array<{value:string;start:number;end:number}>{
  const out:Array<{value:string;start:number;end:number}>=[];const re=/[A-Za-z0-9][A-Za-z0-9._/-]*/g;let match:RegExpExecArray|null;
  while((match=re.exec(line.text))!==null)out.push({value:match[0],start:match.index,end:match.index+match[0].length});
  return out;
}
function whitespaceColumns(line:Span):Array<{start:number;end:number;center:number}>{
  const out:Array<{start:number;end:number;center:number}>=[];let start=line.text.search(/\S/);if(start<0)return out;
  const gaps=/[ \t]{2,}/g;let gap:RegExpExecArray|null;
  while((gap=gaps.exec(line.text))!==null){if(gap.index>=start){const end=gap.index;out.push({start,end,center:(start+end)/2});}start=gap.index+gap[0].length;}
  if(start<line.text.length){const end=line.text.length;out.push({start,end,center:(start+end)/2});}
  return out;
}
function boundaries(headers:ColumnHeader[],width:number):Array<{left:number;right:number;center:number}>{
  return headers.map((head,index)=>({left:index===0?0:(headers[index-1]!.center+head.center)/2,right:index===headers.length-1?width:(head.center+headers[index+1]!.center)/2,center:head.center}));
}
function rowValues(line:Span,headers:ColumnHeader[],field:"lot"|"model",layout:LayoutHeader[]=layoutHeaders({start:0,end:0,text:""})):string[]{
  const anchors=layout.length?layout:headers.map(header=>({...header,kind:"lot" as const}));if(!headers.length||!anchors.length)return[];const bounds=boundaries(anchors,line.text.length),cells=anchors.map(()=>[] as string[]),values:string[]=[];
  for(const token of tokenCells(line)){
    const center=(token.start+token.end)/2,index=bounds.findIndex(bound=>center>=bound.left&&center<bound.right);if(index<0)continue;
    cells[index]!.push(token.value);
  }
  if(field==="lot"){
    const neighboringCellData=anchors.some((anchor,index)=>anchor.kind!=="lot"&&line.text.slice(bounds[index]!.left,bounds[index]!.right).trim().length>0);
    const multipleLotColumns=anchors.filter(anchor=>anchor.kind==="lot").length>1;
    const contactLabels=new Set(["tel","telephone","phone","fax","email","e-mail","contact","customer","service","address","website","url"]);
    for(let index=0;index<anchors.length;index++)if(anchors[index]!.kind==="lot"){
      const rawCell=line.text.slice(bounds[index]!.left,bounds[index]!.right).trim();
      const nonLiteralLotPlaceholders=new Set(["all","refer","see","attachment","various","multiple","unknown","unspecified","n/a","na"]);
      if(/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(rawCell)&&!contactLabels.has(rawCell.toLowerCase())&&!nonLiteralLotPlaceholders.has(rawCell.toLowerCase())&&(/\d/.test(rawCell)||multipleLotColumns||neighboringCellData))values.push(rawCell);
    }
  }
  return values;
}
function rowHeader(content:string,line:Span,field:"lot"|"model"):ColumnHeader[]{
  const header=cellHeaders(line,field);if(header.length)return header;
  return [];
}
function lotHeader(lines:Span[],at:number):ColumnHeader[]{
  const heads=rowHeader("",lines[at]!,"lot");
  const layout=layoutHeaders(lines[at]!);
  // At least two distinct columns are required so the header defines a table layout rather than prose.
  return heads.length>=1&&layout.length>=2?heads:[];
}
function tableBoundary(line:string):boolean{
  return /^\s*(?:Page\s+\d+\s+of\s+\d+|={3,}.*PAGE\s+\d+|\*\s*Update\b)/i.test(line)||/^\s*[\p{L}\d &.,'-]{2,100}\s+(?:corporation|inc\.?|ltd\.?|limited|llc|gmbh|plc|company)\b/iu.test(line);
}
function lotTableRows(lines:Span[],headerAt:number,headers:ColumnHeader[]):TableRow[]{
  const rows:TableRow[]=[];let saw=false,layout=layoutHeaders(lines[headerAt]!),continuation=0;
  for(let i=headerAt+1;i<lines.length;i++){
    const line=lines[i]!;
    if(tableBoundary(line.text)){
      if(saw&&(/^\s*Page\s+\d+\s+of\s+\d+/i.test(line.text)||/^\s*={3,}.*\bPAGE\s+\d+/i.test(line.text))){
        const next=lines[i+1];if(next&&cellHeaders(next,"lot").length>=1){headers=cellHeaders(next,"lot");layout=layoutHeaders(next);continue;}
        continuation=6;continue;
      }
      break;
    }
    if(cellHeaders(line,"lot").length>=1){if(saw){ // repeated page header: retain the page's rows under same layout
        headers=cellHeaders(line,"lot");layout=layoutHeaders(line);continue;
      }continue;}
    if(continuation>0&&!/\d/.test(line.text)&&/^[A-Z0-9 .,:;()/'-]+$/.test(line.text.trim())&&tokenCells(line).length<layout.length){continuation--;continue;}
    const values=rowValues(line,headers,"lot",layout);
    if(values.length){saw=true;continuation=0;rows.push({start:line.start,end:line.end,text:line.text,values});continue;}
    if(continuation>0){
      continuation--;
      // Carry a page's table geometry across a page banner only while the intervening lines remain headings/furniture.
      if(/^[A-Z0-9 .,:;()/-]{3,90}$/.test(line.text.trim())||/^\s*(?:MEDICINES NOTIFICATION|ATTACHMENT|CONTINUED|CONTINUATION)\b/i.test(line.text))continue;
      break;
    }
    if(saw){
      // Page furniture and blank lines are tolerated only while a repeated table header is immediately ahead.
      const next=lines[i+1];if(next&&cellHeaders(next,"lot").length>=2)continue;
      break;
    }
    if(tableBoundary(line.text))break;
  }
  return rows;
}
function quoteGroups(content:string,header:Span,rows:TableRow[]):ExplicitLotTable[]{
  const groups:ExplicitLotTable[]=[];let current:TableRow[]=[];
  const spanCount=(input:TableRow[])=>{let count=0,start=-1,end=-1;for(const row of input){if(start<0){start=row.start;end=row.end;continue;}if(row.end-start>850){count++;start=row.start;end=row.end;}else end=row.end;}return count+(start<0?0:1);};
  const flush=()=>{
    if(!current.length)return;
    const chunks:string[]=[];let chunkStart=-1,chunkEnd=-1;
    for(const row of current){if(chunkStart<0){chunkStart=row.start;chunkEnd=row.end;continue;}if(row.end-chunkStart>850){chunks.push(content.slice(chunkStart,chunkEnd));chunkStart=row.start;chunkEnd=row.end;}else chunkEnd=row.end;}
    if(chunkStart>=0)chunks.push(content.slice(chunkStart,chunkEnd));
    // Header and observed rows are separate exact source spans; no synthetic join or truncation.
    const values=current.flatMap(row=>row.values),rowQuotes=current.flatMap(row=>row.values.map(value=>({value,quote:row.text})));
    const headerQuote=content.slice(header.start,header.end);
    groups.push({quote:headerQuote,additionalQuotes:chunks,values,rows:rowQuotes});current=[];
  };
  for(const row of rows){
    const tentative=[...current,row],start=tentative[0]!.start,end=tentative[tentative.length-1]!.end;
    const vals=tentative.reduce((sum,item)=>sum+item.values.length,0);
    if(current.length&&(vals>30||spanCount(tentative)>2)){flush();}
    current.push(row);
  }
  flush();return groups;
}

/** Extract literal values only from repeated, positioned Lot/Batch Number columns. All returned evidence is an exact source substring. */
export function explicitLotTables(content:string):ExplicitLotTable[]{
  const lines=linesOf(content),tables:ExplicitLotTable[]=[];let consumedUntil=-1;
  for(let i=0;i<lines.length;i++){
    const header=lines[i]!;if(header.start<consumedUntil)continue;const headers=lotHeader(lines,i);if(!headers.length)continue;
    const rows=lotTableRows(lines,i,headers);if(!rows.length)continue;
    tables.push(...quoteGroups(content,header,rows));consumedUntil=rows[rows.length-1]!.end;
  }
  return tables;
}

/** Read Model Number cells using the model header's character position, stopping at the table boundary. */
export function modelColumnRows(content:string):ModelColumnRow[]{
  const lines=linesOf(content),out:ModelColumnRow[]=[];
  for(let i=0;i<lines.length;i++){
    const header=lines[i]!,headers=cellHeaders(header,"model");if(!headers.length)continue;
    const model=headers[0]!,layout=layoutHeaders(header),anchors=layout.length?layout:[...headers.map(value=>({...value,kind:"other" as const}))];
    const columns=whitespaceColumns(header),modelColumn=columns.find(column=>model.left>=column.start&&model.left<=column.end),modelHeaderCell=modelColumn?header.text.slice(modelColumn.start,modelColumn.end):model.label;
    if(/\b(?:serial|lot|batch|UDI(?:[- ]?DI)?)\b/i.test(modelHeaderCell))continue;
    const modelAnchor=anchors.find(value=>value.left===model.left)??model;
    const previous=anchors.filter(value=>value.center<modelAnchor.center).at(-1),next=anchors.find(value=>value.center>modelAnchor.center&&/\b(?:material\s+description|description|lot|UDI|quantity|expiry|expiration|catalog(?:ue)?|product\s+name)\b/i.test(value.label));
    const modelColumnIndex=columns.findIndex(column=>model.left>=column.start&&model.left<=column.end),previousColumn=modelColumnIndex>0?columns[modelColumnIndex-1]:undefined,nextColumn=modelColumnIndex>=0?columns[modelColumnIndex+1]:undefined;
    const left=previous?(previous.center+modelAnchor.center)/2:previousColumn?(previousColumn.center+model.center)/2:Math.max(0,model.left-5);
    const right=next?(modelAnchor.center+next.center)/2:nextColumn?(model.center+nextColumn.center)/2:Number.POSITIVE_INFINITY;
    for(let j=i+1;j<lines.length;j++){
      const line=lines[j]!;if(tableBoundary(line.text)||/^\s*(?:Attachment\s+[A-Za-z0-9-]+|Dear|Attention|Reason|This product|Our records|URGENT)\b/i.test(line.text))break;
      const modelTokens=tokenCells(line).filter(token=>{const center=(token.start+token.end)/2;return center>=left&&center<right&&/[A-Za-z]/.test(token.value)&&/\d/.test(token.value);});
      if(!modelTokens.length)break;
      for(const token of modelTokens)out.push({value:token.value,quote:content.slice(line.start,line.end),header:content.slice(header.start,header.end)});
    }
    if(out.length)break;
  }
  return out;
}
