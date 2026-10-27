import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import test from "node:test";
import type {Workspace} from "../../src/shared/workspace.ts";
import {WorkspaceStore} from "../../src/runtime/store.ts";
import {loadSeed} from "../../src/runtime/seed.ts";

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolve => {resolvePromise = resolve;});
  return {promise, resolve: resolvePromise};
}

async function makeStore(extra: ConstructorParameters<typeof WorkspaceStore>[0] = {}) {
  const stateDir = await mkdtemp(resolve(tmpdir(), "recallops-workspace-read-"));
  return new WorkspaceStore({root: process.cwd(), stateDir, ...extra});
}

test("overlapping workspace reads share one capture, return separate clones, and later reads refresh", async () => {
  const seed = await loadSeed();
  const loaderStarted = deferred();
  const releaseLoader = deferred();
  let captures = 0;
  const store = await makeStore({liveLoader: async base => {
    captures++;
    if (captures === 1) {loaderStarted.resolve(); await releaseLoader.promise;}
    return structuredClone(seed.snapshot ?? base);
  }});

  const firstRead = store.getWorkspace();
  await loaderStarted.promise;
  const secondRead = store.getWorkspace();
  releaseLoader.resolve();
  const [first, second] = await Promise.all([firstRead, secondRead]);

  assert.equal(captures, 1);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.snapshot, second.snapshot);
  const secondQuantity = second.snapshot.inventory[0]!.quantityEa;
  first.snapshot.inventory[0]!.quantityEa++;
  assert.equal(second.snapshot.inventory[0]!.quantityEa, secondQuantity);

  await store.getWorkspace();
  assert.equal(captures, 2, "completed results are not cached");
});

test("workspace read flights are isolated by store instance", async () => {
  const seed = await loadSeed();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  let firstCaptures = 0;
  let secondCaptures = 0;
  const firstStore = await makeStore({liveLoader: async base => {
    firstCaptures++;
    if (firstCaptures === 1) {firstStarted.resolve(); await releaseFirst.promise;}
    return structuredClone(seed.snapshot ?? base);
  }});
  const secondStore = await makeStore({liveLoader: async base => {
    secondCaptures++;
    return structuredClone(seed.snapshot ?? base);
  }});

  const firstRead = firstStore.getWorkspace();
  await firstStarted.promise;
  const secondRead = await secondStore.getWorkspace();
  assert.equal(secondCaptures, 1);
  releaseFirst.resolve();
  await firstRead;
  assert.equal(firstCaptures, 1);
  assert.equal(secondRead.snapshot.inventory.length, seed.snapshot.inventory.length);
});

test("runId is part of the exact workspace read key", async () => {
  const store = await makeStore({model: "nvidia/nemotron-test", inferenceAllowed: true});
  const started = await store.startInvestigation();
  const runId = started.agentRun.runId!;
  const assemblyStarted = deferred();
  const releaseAssembly = deferred();
  let assemblies = 0;
  type WorkspaceMethod = (state: unknown, preparedSnapshot?: unknown) => Promise<Workspace>;
  const internals = store as unknown as {workspace: WorkspaceMethod};
  const originalWorkspace = internals.workspace.bind(store);
  internals.workspace = async (state, preparedSnapshot) => {
    assemblies++;
    if (assemblies === 1) {assemblyStarted.resolve(); await releaseAssembly.promise;}
    return originalWorkspace(state, preparedSnapshot);
  };

  const explicitFirst = store.getWorkspace(runId);
  await assemblyStarted.promise;
  const explicitSecond = store.getWorkspace(runId);
  const implicitRead = store.getWorkspace();
  releaseAssembly.resolve();
  const [first, second, implicit] = await Promise.all([explicitFirst, explicitSecond, implicitRead]);

  assert.equal(assemblies, 2, "same runId joins; omitted runId remains a separate key");
  assert.notStrictEqual(first, second);
  assert.equal(first.agentRun.runId, runId);
  assert.equal(implicit.agentRun.runId, runId);
  await assert.rejects(store.getWorkspace(`${runId}-wrong`), /no longer active/);
});

test("a rejected workspace capture clears its flight so a later read retries", async () => {
  const seed = await loadSeed();
  const loaderStarted = deferred();
  const releaseLoader = deferred();
  let captures = 0;
  const store = await makeStore({liveLoader: async base => {
    captures++;
    if (captures === 1) {
      loaderStarted.resolve();
      await releaseLoader.promise;
      throw new Error("temporary source read failure");
    }
    return structuredClone(seed.snapshot ?? base);
  }});

  const firstRead = store.getWorkspace();
  await loaderStarted.promise;
  const joinedRead = store.getWorkspace();
  releaseLoader.resolve();
  const failures = await Promise.allSettled([firstRead, joinedRead]);
  assert.deepEqual(failures.map(result => result.status), ["rejected", "rejected"]);
  assert.equal(captures, 1);

  const retried = await store.getWorkspace();
  assert.equal(captures, 2);
  assert.ok(retried.snapshot.inventory.length > 0);
});

test("a queued reset invalidates an older in-flight workspace capture", async () => {
  const seed = await loadSeed();
  const loaderStarted = deferred();
  const releaseLoader = deferred();
  let captures = 0;
  const store = await makeStore({liveLoader: async base => {
    captures++;
    if (captures === 1) {loaderStarted.resolve(); await releaseLoader.promise;}
    return structuredClone(seed.snapshot ?? base);
  }});

  const beforeResetRead = store.getWorkspace();
  await loaderStarted.promise;
  const reset = store.reset();
  const afterResetRead = store.getWorkspace();
  releaseLoader.resolve();
  const [before, resetWorkspace, after] = await Promise.all([beforeResetRead, reset, afterResetRead]);

  assert.notEqual(before.incidentId, resetWorkspace.incidentId);
  assert.equal(after.incidentId, resetWorkspace.incidentId, "the later read observes the queued mutation");
  assert.equal(captures, 3, "the post-reset workspace and following read each capture fresh source");
});
