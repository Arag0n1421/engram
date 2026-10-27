import test from "node:test";
import assert from "node:assert/strict";
import {verifyNativeToolIsolation, NATIVE_TOOL_ISOLATION_SCOPE} from "../../src/runtime/native-tool-isolation.ts";
const config={baseUrl:"http://127.0.0.1:8088/v1",token:"test-runtime-token"};
const health=()=>Response.json({status:"ok",engine:"meterless",build:"m1-m4",served:"app",engine_ready:true,message:"not retained"});
const absentTools=()=>Response.json({error:{code:"not_available_in_web",message:"not retained"}},{status:501});

test("native tool isolation establishes only the narrow current installation contract and always rereads metadata",async()=>{
  const calls:Array<{url:string;init?:RequestInit}>=[];
  const fetchImpl=(async(input,init)=>{calls.push({url:String(input),init});return String(input).endsWith("/healthz")?health():absentTools();}) as typeof fetch;
  const first=await verifyNativeToolIsolation(config,fetchImpl),second=await verifyNativeToolIsolation(config,fetchImpl);
  assert.equal(first.contract,"nightshift-m1m4-web-v1");assert.equal(first.scope,NATIVE_TOOL_ISOLATION_SCOPE);
  assert.equal(first.universalRuntimeToolCountClaim,false);assert.equal(first.toolsEndpoint.httpStatus,501);
  assert.equal(first.origin,"http://127.0.0.1:8088");assert.equal(calls.length,4);
  assert.equal(second.contract,first.contract);assert.equal(JSON.stringify(first).includes(config.token),false);
  assert.equal(JSON.stringify(first).includes("not retained"),false);
  for(const call of calls){assert.equal(call.init?.method,"GET");assert.equal(call.init?.redirect,"error");assert.equal(new Headers(call.init?.headers).get("authorization"),`Bearer ${config.token}`);assert.equal(call.init?.body,undefined);}
});

test("full or unknown builds reject before a tools request",async()=>{
  for(const patch of [{build:"full"},{served:"daemon"},{engine_ready:false},{engine:"other"},{status:"starting"}]){
    let calls=0;
    await assert.rejects(verifyNativeToolIsolation(config,(async()=>{calls++;return Response.json({status:"ok",engine:"meterless",build:"m1-m4",served:"app",engine_ready:true,...patch});}) as typeof fetch),{code:"NATIVE_TOOL_ISOLATION_UNVERIFIED"});
    assert.equal(calls,1);
  }
});

test("accessible tools never get parsed and unavailable tools require the exact build error",async()=>{
  let sensitiveBodyRead=false;
  const accessible=Response.json({servers:[{config:"must not be read"}]});
  const accessibleBody=accessible.body!;
  accessibleBody.getReader=(()=>{sensitiveBodyRead=true;throw new Error("Unexpected tool registry read");}) as typeof accessibleBody.getReader;
  await assert.rejects(verifyNativeToolIsolation(config,(async(input)=>String(input).endsWith("/healthz")?health():accessible) as typeof fetch),{code:"NATIVE_TOOL_ISOLATION_UNVERIFIED"});
  assert.equal(sensitiveBodyRead,false);
  for(const response of [Response.json({error:{code:"other"}},{status:501}),Response.json({servers:[]},{status:501}),new Response("not json",{status:501})]){
    await assert.rejects(verifyNativeToolIsolation(config,(async(input)=>String(input).endsWith("/healthz")?health():response) as typeof fetch),{code:"NATIVE_TOOL_ISOLATION_UNVERIFIED"});
  }
});

test("metadata boundaries reject unsupported origin, oversize content, malformed JSON and transport failure",async()=>{
  let calls=0;const never=(async()=>{calls++;throw new Error("must not fetch");}) as typeof fetch;
  for(const baseUrl of ["https://remote.example/v1","http://127.0.0.1:8088/other","http://user:pass@127.0.0.1:8088/v1"]){await assert.rejects(verifyNativeToolIsolation({...config,baseUrl},never),{code:"NATIVE_TOOL_ISOLATION_UNVERIFIED"});}
  assert.equal(calls,0);
  for(const response of [new Response("{broken",{headers:{"content-type":"application/json"}}),Response.json({padding:"x".repeat(8_200)}),new Response("{}",{status:503,headers:{"content-type":"application/json"}})]){
    await assert.rejects(verifyNativeToolIsolation(config,(async()=>response) as typeof fetch),{code:"NATIVE_TOOL_ISOLATION_UNVERIFIED"});
  }
  await assert.rejects(verifyNativeToolIsolation(config,(async()=>{throw new Error("safe diagnostic only");}) as typeof fetch),{code:"NATIVE_TOOL_ISOLATION_UNVERIFIED"});
});
