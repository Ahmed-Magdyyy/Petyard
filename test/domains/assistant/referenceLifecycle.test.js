import test from "node:test";
import assert from "node:assert/strict";
import { loadReferenceConfig } from "../../../src/domains/assistant/references/assistant.reference-config.js";
import { createReferenceWorker } from "../../../src/domains/assistant/references/assistant.reference-worker.js";
import { AssistantReference, assertReferenceStore } from "../../../src/domains/assistant/references/assistant.reference.model.js";
import { referenceMemory, referenceTestConfig, referenceActor, referenceBody, referenceFile } from "./fixtures/referenceMemory.js";
import { sourceHash } from "../../../src/domains/assistant/references/assistant.reference-service.js";

test("references are disabled without explicit flags and require bounded policy plus separate private storage", () => {
  assert.deepEqual(loadReferenceConfig({}), { enabled: false });
  assert.deepEqual(loadReferenceConfig({ ASSISTANT_ENABLED: "true" }), { enabled: false });
  const env = { ASSISTANT_ENABLED: "true", ASSISTANT_REFERENCES_ENABLED: "true", ASSISTANT_REFERENCE_LIMITS_JSON: JSON.stringify(referenceTestConfig().limits),
    PRIVATE_MEDIA_STORAGE_PROVIDER: "bunny", BUNNY_PRIVATE_STORAGE_ZONE: "private-zone", BUNNY_PRIVATE_STORAGE_ACCESS_KEY: "test-only",
    BUNNY_PRIVATE_STORAGE_ENDPOINT: "https://storage.bunnycdn.com", BUNNY_PRIVATE_CDN_BASE_URL: "https://private.invalid" };
  assert.equal(loadReferenceConfig(env).enabled, true);
  for (const patch of [{ ASSISTANT_REFERENCE_LIMITS_JSON: "{}" }, { PRIVATE_MEDIA_STORAGE_PROVIDER: "cloudinary" },
    { ASSISTANT_REFERENCE_LIMITS_JSON: JSON.stringify({ ...referenceTestConfig().limits, maxFileBytes: 0 }) },
    { BUNNY_PRIVATE_STORAGE_ZONE: "same", BUNNY_PUBLIC_STORAGE_ZONE: "same", BUNNY_PUBLIC_STORAGE_ACCESS_KEY: "fake",
      BUNNY_PUBLIC_STORAGE_ENDPOINT: "https://storage.bunnycdn.com", BUNNY_PUBLIC_CDN_BASE_URL: "https://public.invalid" }]) {
    assert.throws(() => loadReferenceConfig({ ...env, ...patch }));
  }
});

test("store admission verifies existing uniqueness and never creates indexes or collections", async t => {
  let indexes = [{ key: { sha256: 1 }, unique: true }];
  t.mock.method(AssistantReference.collection, "indexes", async () => indexes);
  await assertReferenceStore();
  for (const bad of [[], [{ key: { sha256: 1 }, unique: true, sparse: true }],
    [{ key: { sha256: 1 }, unique: true }, { key: { updatedAt: 1 }, expireAfterSeconds: 30 }]]) {
    indexes = bad;
    await assert.rejects(assertReferenceStore(), { code: "reference_store_unavailable" });
  }
});

test("upload persists original once; duplicate bytes return the same unchanged library record", async () => {
  const { application, state } = referenceMemory(), actor = referenceActor(), config = referenceTestConfig();
  const first = await application.upload(actor, referenceBody(), referenceFile(), config);
  const second = await application.upload(actor, { ...referenceBody(), title: "Another title" }, referenceFile(), config);
  assert.equal(first.reference.stage, "queued"); assert.equal(second.duplicate, true);
  assert.equal(first.reference.id, second.reference.id); assert.equal(state.puts, 1); assert.equal(state.rows.length, 1);
  assert.equal(second.reference.title, referenceBody().title);
  assert.doesNotMatch(JSON.stringify(first), /accessKey|extractionKey|lease|synthetic-key|sha256/);
});

test("real text extraction stores a private manifest and preview, but never marks the reference ready", async () => {
  const { application, worker, state } = referenceMemory(), actor = referenceActor(), config = referenceTestConfig();
  const uploaded = await application.upload(actor, referenceBody(), referenceFile(), config);
  const queue = worker(); queue.start(config); await queue.idle();
  const result = await application.get(actor, uploaded.reference.id, config);
  assert.equal(result.status, "processing"); assert.equal(result.stage, "awaiting_index");
  assert.equal(result.actions.canActivate, false); assert.match(result.preview, /القطط/u);
  assert.equal(result.unitCount, 1); assert.equal(result.passageCount, 1); assert.equal(state.objects.size, 3);
  const manifest = JSON.parse(state.objects.get(state.rows[0].extractionKey));
  assert.match(manifest.units[0].text, /1\.25/); assert.equal(state.rows[0].extractionHash.length, 64);
  const prepared = JSON.parse(state.objects.get(state.rows[0].passageKey));
  assert.equal(prepared.extractionHash, state.rows[0].extractionHash);
  assert.equal(prepared.passages.length, 1); assert.equal(state.rows[0].passageHash.length, 64);
});

test("failed source upload gives an actionable durable status and re-upload recovers the same record", async () => {
  const { application, state } = referenceMemory(), actor = referenceActor(), config = referenceTestConfig();
  state.failPut = true;
  const failed = await application.upload(actor, referenceBody(), referenceFile(), config);
  assert.equal(failed.reference.status, "failed"); assert.equal(failed.reference.actions.canReupload, true);
  assert.equal(failed.reference.error.code, "reference_storage_failed");
  await assert.rejects(application.retry(actor, failed.reference.id, { expectedVersion: failed.reference.version }, config), { code: "reference_reupload_required" });
  state.failPut = false;
  const recovered = await application.upload(actor, referenceBody(), referenceFile(), config);
  assert.equal(recovered.reference.id, failed.reference.id); assert.equal(recovered.reference.stage, "queued");
});

test("source-read failure allows explicit retry; stale retry versions cannot mutate the record", async () => {
  const { application, worker, state } = referenceMemory(), actor = referenceActor(), config = referenceTestConfig();
  const uploaded = await application.upload(actor, referenceBody(), referenceFile(), config);
  state.failGet = true; const queue = worker(); queue.start(config); await queue.idle();
  const failed = await application.get(actor, uploaded.reference.id, config);
  assert.equal(failed.actions.canRetry, true);
  await assert.rejects(application.retry(actor, failed.id, { expectedVersion: 1 }, config), { code: "reference_changed" });
  state.failGet = false;
  assert.equal((await application.retry(actor, failed.id, { expectedVersion: failed.version }, config)).stage, "queued");
  queue.start(config); await queue.idle(); assert.equal(state.rows[0].stage, "awaiting_index");
});

test("disable during work wins over late extraction and does not delete original files", async () => {
  const { application, dependencies, state } = referenceMemory(), actor = referenceActor(), config = referenceTestConfig();
  const uploaded = await application.upload(actor, referenceBody(), referenceFile(), config);
  const queue = createReferenceWorker({ ...dependencies, extract: async file => {
    const current = await application.get(actor, uploaded.reference.id, config);
    await application.disable(actor, current.id, { expectedVersion: current.version }, config);
    return { sha256: sourceHash(file.buffer), units: [{ locator: "Document text", text: "Late result" }], warnings: [] };
  } });
  queue.start(config); await queue.idle();
  assert.equal(state.rows[0].status, "disabled"); assert.equal(state.rows[0].extractionKey, undefined);
  assert.ok(state.objects.size >= 1);
});

test("expired upload/extraction leases become explicit recoverable failures", async () => {
  const { application, worker, state } = referenceMemory(), actor = referenceActor(), config = referenceTestConfig();
  await application.upload(actor, referenceBody(), referenceFile(), config);
  state.rows[0].stage = "extracting"; state.rows[0].leaseUntil = new Date(state.time.getTime() - 1);
  const queue = worker(); queue.start(config); await queue.idle();
  assert.equal(state.rows[0].failureCode, "reference_processing_interrupted");
  assert.equal(state.rows[0].status, "failed");
});

test("worker single-flight and shutdown prevent duplicate concurrent work", async () => {
  const { application, dependencies, state } = referenceMemory(), config = referenceTestConfig();
  await application.upload(referenceActor(), referenceBody(), referenceFile(), config);
  const queue = createReferenceWorker({ ...dependencies, extract: async (_file, _limits, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error(), { code: "reference_processing_cancelled" })), { once: true });
    if (signal.aborted) reject(Object.assign(new Error(), { code: "reference_processing_cancelled" }));
  }) });
  assert.equal(queue.start(config).scheduled, true); assert.equal(queue.start(config).scheduled, false);
  await new Promise(resolve => setImmediate(resolve)); await queue.stop();
  assert.equal(state.rows[0].failureCode, "reference_processing_interrupted"); assert.equal(queue.start(config).enabled, false);
});

test("direct service calls preserve SuperAdmin authority and reject unrecognized metadata", async () => {
  const { application, state } = referenceMemory(), config = referenceTestConfig();
  for (const role of ["guest", "user", "moderator", "admin"]) await assert.rejects(
    application.upload({ ...referenceActor(), role }, referenceBody(), referenceFile(), config), { code: "access_denied" });
  await assert.rejects(application.upload(referenceActor(), { ...referenceBody(), status: "ready" }, referenceFile(), config), { code: "invalid_request" });
  for (const metadata of [{ title: "\ud800" }, { authors: "\ud800" }, { species: '["\\ud800"]' }]) {
    await assert.rejects(application.upload(referenceActor(), { ...referenceBody(), ...metadata }, referenceFile(), config), { code: "invalid_request" });
  }
  assert.equal(state.rows.length, 0); assert.equal(state.puts, 0);
});

test("source checksum mismatch is withheld and repaired only by re-uploading the exact original", async () => {
  const { application, worker, state } = referenceMemory(), actor = referenceActor(), config = referenceTestConfig();
  const first = await application.upload(actor, referenceBody(), referenceFile(), config);
  state.objects.set([...state.objects.keys()][0], Buffer.from("Different private file"));
  const queue = worker(); queue.start(config); await queue.idle();
  const failed = await application.get(actor, first.reference.id, config);
  assert.equal(failed.error.code, "reference_source_changed"); assert.equal(failed.actions.canReupload, true);
  assert.equal(state.rows[0].extractionKey, undefined);
  const repaired = await application.upload(actor, referenceBody(), referenceFile(), config);
  assert.equal(repaired.reference.id, first.reference.id); assert.equal(repaired.reference.stage, "queued");
});

test("an expired extraction cannot publish even when no other worker has reclaimed it", async () => {
  const { application, dependencies, state } = referenceMemory(), config = referenceTestConfig();
  await application.upload(referenceActor(), referenceBody(), referenceFile(), config);
  const queue = createReferenceWorker({ ...dependencies, extract: async file => {
    state.time = new Date(state.time.getTime() + 500_000);
    return { sha256: sourceHash(file.buffer), units: [{ text: "Late extraction", locator: "Document text" }], warnings: [] };
  } });
  queue.start(config); await queue.idle();
  assert.equal(state.rows[0].stage, "extracting"); assert.equal(state.rows[0].extractionKey, undefined);
  queue.start(config); await queue.idle();
  assert.equal(state.rows[0].failureCode, "reference_processing_interrupted");
});

test("a failed passage-object write publishes no prepared count or manifest pointers", async () => {
  const { application, worker, state } = referenceMemory(), actor = referenceActor(), config = referenceTestConfig();
  await application.upload(actor, referenceBody(), referenceFile(), config);
  state.afterPut = async key => { if (key.includes("/passages-")) throw new Error("Synthetic uncertain private write"); };
  const queue = worker(); queue.start(config); await queue.idle();
  assert.equal(state.rows[0].status, "failed"); assert.equal(state.rows[0].failureCode, "reference_processing_failed");
  assert.equal(state.rows[0].passageKey, undefined); assert.equal(state.rows[0].passageCount, undefined);
  state.afterPut = undefined;
  const failed = await application.get(actor, String(state.rows[0]._id), config);
  await application.retry(actor, failed.id, { expectedVersion: failed.version }, config);
  queue.start(config); await queue.idle();
  assert.equal(state.rows[0].stage, "awaiting_index"); assert.equal(state.rows[0].passageCount, 1);
});
