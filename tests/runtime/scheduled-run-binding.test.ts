import test from "node:test";
import assert from "node:assert/strict";
import {normalizeScheduledRunBinding} from "../../src/runtime/model.ts";

const runId="22222222-2222-4222-8222-222222222222", other="11111111-1111-4111-8111-111111111111";
const tools=(name:string,proposal=false)=>[{type:"function",function:{name,parameters:proposal?{type:"object",properties:{runId:{type:"string",enum:[runId]},proposals:{type:"array"}},required:["runId","proposals"],additionalProperties:false}:{type:"object",properties:{runId:{type:"string",enum:[runId]}},required:["runId"],additionalProperties:false}}}];
const frame=(name:string,args:unknown)=>({choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:null,tool_calls:[{id:"tool-call",type:"function",function:{name,arguments:JSON.stringify(args)}}]}}]});
const response=()=>Response.json({});

test("each backend-scheduled argument-free stage binds only to its authoritative run",async()=>{
 for(const name of ["inspect_evidence","read_evidence_sections","match_records","request_investigation_report"]){
  const raw=frame(name,{runId:other}),out=normalizeScheduledRunBinding(response(),[raw],"application/json",tools(name),name,runId);
  assert.ok(out);const result:any=await out.response.json();assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments),{runId});assert.deepEqual(JSON.parse(raw.choices[0]!.message.tool_calls[0]!.function.arguments),{runId:other},"provider evidence is not changed");assert.match(out.originalArgumentsSha256,/^[0-9a-f]{64}$/);
 }
});

test("ambiguous, wrong-tool and model-selected input payloads cannot be rebound",()=>{
 const name="match_records",run=(f:unknown,t=tools(name),ct="application/json")=>normalizeScheduledRunBinding(response(),[f],ct,t,name,runId);
 assert.equal(run(frame(name,{runId:other,proposals:[]})),null);
 assert.equal(run(frame("inspect_evidence",{runId:other})),null);
 assert.equal(run(frame(name,{runId:other}),tools(name,true)),null);
 assert.equal(run(frame(name,{runId:other}),tools(name),"text/event-stream"),null);
 assert.equal(run(frame(name,{runId:"not-a-uuid"})),null);
 assert.equal(run(frame(name,{runId:runId})),null);
 const multi=frame(name,{runId:other});multi.choices[0]!.message.tool_calls.push(multi.choices[0]!.message.tool_calls[0]!);assert.equal(run(multi),null);
 const refusal:any=frame(name,{runId:other});refusal.choices[0].message.refusal="refused";assert.equal(run(refusal),null);
 const legacy:any=frame(name,{runId:other});legacy.choices[0].message.function_call={name:"different_tool"};assert.equal(run(legacy),null);
 const mixed:any=frame(name,{runId:other});mixed.choices[0].delta={tool_calls:[{function:{name:"other_tool"}}]};assert.equal(run(mixed),null);
});
