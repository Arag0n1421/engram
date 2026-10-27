import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {WorkspaceStore} from '../../src/runtime/store.ts';
import {boundMeterlessModel} from '../../src/runtime/model.ts';
import {NATIVE_TOOL_ISOLATION_SCOPE,type NativeToolIsolationVerifier} from '../../src/runtime/native-tool-isolation.ts';

const actualModel = 'openrouter/nvidia/nemotron-3.5-lightning:free';
const config = {token: 'sdk-test-secret', model: 'meterless/auto', baseUrl: 'http://127.0.0.1:1/v1'};
const route = {provider_model: 'meterless/auto', routed_model: actualModel, winning_route: {model: actualModel, provider: 'openrouter', kind: 'api', tier: 'free'}};
const verifiedIsolation:NativeToolIsolationVerifier=async({baseUrl})=>({contract:'nightshift-m1m4-web-v1',scope:NATIVE_TOOL_ISOLATION_SCOPE,checkedAt:'2026-10-23T00:00:00.000Z',origin:new URL(baseUrl).origin,health:{httpStatus:200,status:'ok',engine:'meterless',build:'m1-m4',served:'app',engineReady:true},toolsEndpoint:{httpStatus:501,errorCode:'not_available_in_web'},universalRuntimeToolCountClaim:false});
let toolCall = {id: 'call-inspect-evidence-7', type: 'function', function: {name: 'inspect_evidence', arguments: '{}'}};
const toolSchema = {
  type: 'function' as const,
  name: 'inspect_evidence',
  description: 'Inspect bounded content from selected current evidence sources.',
  inputSchema: {type: 'object', properties: {runId: {type: 'string'}}, required: ['runId'], additionalProperties: false},
};
const reportRequestSchema = {
  type: 'function' as const,
  name: 'request_investigation_report',
  description: 'Request the documentary-stage report after source inspection.',
  inputSchema: {type: 'object', properties: {runId: {type: 'string'}, reason: {type: 'string', minLength: 1, maxLength: 300}}, required: ['runId', 'reason'], additionalProperties: false},
};

async function setup(fetchImpl: typeof fetch, question = 'Inspect current recall evidence.') {
  const stateDir = await mkdtemp(resolve(tmpdir(), 'recallops-model-streaming-'));
  const store = new WorkspaceStore({stateDir, model: config.model, inferenceAllowed: true});
  const runId = (await store.startInvestigation(question)).agentRun.runId!;
  const previous = process.env.RECALLOPS_ALLOW_INFERENCE;
  process.env.RECALLOPS_ALLOW_INFERENCE = 'true';
  return {
    model: boundMeterlessModel(runId, config, store, fetchImpl, verifiedIsolation), store, runId,
    restore() {if (previous === undefined) delete process.env.RECALLOPS_ALLOW_INFERENCE; else process.env.RECALLOPS_ALLOW_INFERENCE = previous;},
  };
}

function completion(message: Record<string, unknown>) {
  return {
    id: 'completion-verified-fixture', object: 'chat.completion', created: 1, model: 'meterless/auto', meterless: route,
    choices: [{index: 0, message: {role: 'assistant', ...message}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop'}],
    usage: {prompt_tokens: 19, completion_tokens: 8, total_tokens: 27},
  };
}

const common = {
  temperature: 0,
  tools: [toolSchema, reportRequestSchema],
  prompt: [{role: 'user' as const, content: [{type: 'text' as const, text: 'Inspect current recall evidence.'}]}],
};

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader(); const parts: T[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return parts;
      parts.push(part.value);
    }
  } finally {reader.releaseLock();}
}

test('bound model simulates streaming over verified nonstreaming tool and continuation responses', async () => {
  const requests: Array<{body: Record<string, any>; headers: Headers}> = [];
  const replies: Array<ReturnType<typeof completion>> = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    requests.push({body, headers: new Headers(init?.headers)});
    const reply = replies.shift();
    assert.ok(reply, 'expected exactly two provider requests');
    return Response.json(reply);
  }) as typeof fetch;
  const question = 'What exact action does the current recall notice require?';
  const {model, store, runId, restore} = await setup(fetchImpl, question);
  try {
    const inspectionArgs = {runId};
    toolCall = {id: 'call-inspect-evidence-7', type: 'function', function: {name: 'inspect_evidence', arguments: JSON.stringify(inspectionArgs)}};
    const reportRequestArgs = {runId};
    const continuationToolCall = {id: 'call-report-request-8', type: 'function', function: {name: 'request_investigation_report', arguments: JSON.stringify(reportRequestArgs)}};
    replies.push(
      completion({content: 'I will inspect the notice.', tool_calls: [toolCall]}),
      completion({content: null, tool_calls: [continuationToolCall]}),
    );
    assert.equal(model.modelId, config.model);
    assert.match(model.provider, /meterless/);
    const first = await model.doStream(common);
    const firstParts = await collect(first.stream);
    assert.deepEqual(firstParts.filter(part => part.type === 'text-delta').map(part => part.delta), ['I will inspect the notice.']);
    assert.deepEqual(firstParts.filter(part => part.type === 'tool-call').map(part => part.type === 'tool-call' ? {
      id: part.toolCallId, name: part.toolName, input: part.input,
    } : null), [{id: toolCall.id, name: 'inspect_evidence', input: JSON.stringify(inspectionArgs)}]);
    const firstFinish = firstParts.find(part => part.type === 'finish');
    assert.equal(firstFinish?.type, 'finish');
    if (firstFinish?.type === 'finish') {
      assert.equal(firstFinish.finishReason.unified, 'tool-calls');
      assert.equal(firstFinish.usage.inputTokens.total, 19);
      assert.equal(firstFinish.usage.outputTokens.total, 8);
    }

    const inspected = await store.inspectSources(runId);
    const selectedSource = inspected.entries.find((entry:any)=>entry.id==='FDA-REQUIRED-ACTIONS')!;
    assert.ok('sourceHash' in selectedSource);

    const continuation = {
      ...common,
      prompt: [
        common.prompt[0]!,
        {role: 'assistant' as const, content: [
          {type: 'text' as const, text: 'I will inspect the notice.'},
          {type: 'tool-call' as const, toolCallId: toolCall.id, toolName: 'inspect_evidence', input: inspectionArgs},
        ]},
        {role: 'tool' as const, content: [
          {type: 'tool-result' as const, toolCallId: toolCall.id, toolName: 'inspect_evidence', output: {type: 'text' as const, value: 'UNBOUND_SDK_CONTINUATION_DO_NOT_RETAIN'}},
        ]},
        {role: 'user' as const, content: [{type: 'text' as const, text: 'UNBOUND_SDK_CONTINUATION_DO_NOT_RETAIN'}]},
      ],
    };
    const second = await model.doStream(continuation);
    const secondParts = await collect(second.stream);
    assert.deepEqual(secondParts.filter(part => part.type === 'text-delta').map(part => part.delta), []);
    assert.deepEqual(secondParts.filter(part => part.type === 'tool-call').map(part => part.type === 'tool-call' ? {
      id: part.toolCallId, name: part.toolName, input: part.input,
    } : null), [{id: continuationToolCall.id, name: 'request_investigation_report', input: continuationToolCall.function.arguments}]);
    const secondFinish = secondParts.find(part => part.type === 'finish');
    assert.equal(secondFinish?.type, 'finish');
    if (secondFinish?.type === 'finish') assert.equal(secondFinish.finishReason.unified, 'tool-calls');

    assert.equal(requests.length, 2, 'the middleware must not add another provider call');
    assert.deepEqual(requests.map(request => request.body.max_tokens), [4096, 4096], "Inspection and the following exploration request both remain within the preliminary cap");
    for (const {body, headers} of requests) {
      assert.notEqual(body.stream, true, 'simulated streaming must use the provider JSON generation endpoint, not SSE');
      assert.match(headers.get('content-type') ?? '', /application\/json/i);

      assert.equal(headers.get('meterless-tier-split'), 'off');
      assert.equal(headers.get('meterless-deliberation'), 'off');
      if(body.tools[0].function.name==='inspect_evidence')assert.deepEqual(body.tools[0].function.parameters,{type:'object',properties:{runId:{type:'string',enum:[runId]}},required:['runId'],additionalProperties:false});
    }
    assert.deepEqual(requests[0]!.body.tool_choice,{type:'function',function:{name:'inspect_evidence'}});
    assert.equal(requests[1]!.body.tool_choice,'required');
    assert.ok(requests[1]!.body.tools.some((tool:any)=>tool.function.name==='request_investigation_report'));
    const serializedContinuation = requests[1]!.body.messages;
    assert.equal(serializedContinuation.length, 2);
    assert.equal(serializedContinuation[0].role, 'system');
    const projected = JSON.parse(serializedContinuation[1].content);
    const boundContext = (await store.getInvestigationContext(runId)).projection!;
    assert.equal(projected.runId, runId);
    assert.equal(projected.question, question);
    assert.equal(projected.snapshotHash, boundContext.context.snapshotHash);
    assert.ok(projected.sourceIndex.some((entry: Record<string, unknown>) => entry.id === 'FDA-REQUIRED-ACTIONS'));
    assert.equal(Object.hasOwn(projected.work,"retrievedSections"),false);
    const selectedSection=boundContext.work!.sections.find(section=>section.sourceId===selectedSource.id)!;
    assert.ok(boundContext.work!.sections.length>=1);
    assert.equal(selectedSection.sourceHash, selectedSource.sourceHash);
    assert.equal(selectedSection.text, selectedSource.content);
    assert.equal(JSON.stringify(serializedContinuation).includes('UNBOUND_SDK_CONTINUATION_DO_NOT_RETAIN'), false);
    assert.equal(JSON.stringify(serializedContinuation).includes(toolCall.id), false);
    const trace = (await store.activeInvestigation()).agentRun.events.filter(event => event.tool === 'model.response.nemotron');
    assert.equal(trace.length, 2);
    assert.ok(trace.every(event => JSON.parse(event.message).requestStream === false));
  } finally {restore();}
});

test('wrong route metadata and empty JSON still reject before a stream is exposed', async () => {
  for (const fixture of [
    {body: {...completion({content: 'not exposed'}), meterless: {routed_model: 'openai/gpt-4.1'}}, code: 'NEMOTRON_NOT_ESTABLISHED'},
    {body: {...completion({content: ''}), choices: []}, code: 'EMPTY_MODEL_COMPLETION'},
  ]) {
    const fetchImpl = (async () => Response.json(fixture.body)) as typeof fetch;
    const {model, store, restore} = await setup(fetchImpl);
    try {
      await store.inspectSources((await store.activeInvestigation()).agentRun.runId!, ['FDA-REQUIRED-ACTIONS'], 'Bind the protocol rejection fixture to a real stored source before checking response validation.');
      await assert.rejects(async () => model.doStream(common), {code: fixture.code});
      const events = (await store.activeInvestigation()).agentRun.events;
      assert.equal(events.filter(event => event.tool === 'model.response.nemotron').length, 0);
      assert.equal(events.filter(event => event.tool === 'model.attribution.rejected').length, fixture.code === 'NEMOTRON_NOT_ESTABLISHED' ? 1 : 0);
      assert.equal(events.filter(event => event.tool === 'model.response.empty').length, fixture.code === 'EMPTY_MODEL_COMPLETION' ? 1 : 0);
    } finally {restore();}
  }
});
