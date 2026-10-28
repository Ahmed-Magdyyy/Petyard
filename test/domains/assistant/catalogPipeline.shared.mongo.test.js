import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import mongoose from "mongoose";
import { createSharedMongoManifest, sharedMongoRecords, sharedMongoConnection, validateSharedMongoTarget } from "./fixtures/sharedMongo.js";
import { cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";

const optIn = process.env.ASSISTANT_SHARED_CATALOG_PIPELINE_TEST;
test("native fresh catalog HTTP admission, competing workers and native audits complete once inside the exact fixture scope", {
  skip: !optIn && "Requires separate native-catalog-pipeline-owned-records-only approval",
}, async (t) => {
  assert.equal(optIn, "native-catalog-pipeline-owned-records-only");
  const uri = validateSharedMongoTarget(process.env.ASSISTANT_SHARED_TEST_MONGO_URI, process.env.ASSISTANT_SHARED_TEST_CONFIRM);
  const proof = JSON.parse(await readFile(new URL("../../../.scratch/assistant-product-search/catalog-native-pipeline-cleanup-lifecycle-verification.json", import.meta.url), "utf8"));
  assert.equal(proof.status, "local_cleanup_lifecycle_preparation_verified");
  const sources = proof.executableSourceHashes; assert.ok(Object.keys(sources).length >= 8);
  for (const [file, hash] of Object.entries(sources)) {
    assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), hash, `Prepared source changed: ${file}`);
  }
  mongoose.set("autoCreate", false); mongoose.set("autoIndex", false); mongoose.set("bufferCommands", false);
  const { createIsolatedBudgetManifest, isolatedBudgetRecords, isolatedBudgetCollection, financialTestTime } = await import("./fixtures/isolatedBudget.js");
  t.mock.timers.enable({ apis: ["Date"], now: new Date(financialTestTime) });
  const { testConfig } = await import("./fixtures/foundationPolicy.js");
  const { catalogPipelineSeed, pipelineInput, pipelineQuote, pipelineAuditTypes } = await import("./fixtures/catalogPipelineSeed.js");
  const { mockSharedCatalogPipelineBoundaries } = await import("./fixtures/sharedCatalogPipelineBoundaries.js");
  const { transaction } = await import("../../../src/domains/assistant/shared/assistant.store.js");
  const { processAssistantRun } = await import("../../../src/domains/assistant/customer/assistant.worker.service.js");
  const { readAssistantCatalog } = await import("../../../src/domains/assistant/products/assistant.catalog-read.js");
  const { assertCatalogPipelineCardinality } = await import("./fixtures/catalogPipelineVerification.js");
  const { createAssistantRouter } = await import("../../../src/domains/assistant/assistant.routes.js");
  const { default: express } = await import("express");
  const baseConfig = testConfig({ productSearchEnabled: true, timeoutMs: 30000 });
  const budgetManifest = createIsolatedBudgetManifest(baseConfig), manifest = createSharedMongoManifest("catalogPipeline");
  manifest.records.users = [...budgetManifest.owners];
  const fixture = await catalogPipelineSeed(manifest, budgetManifest, baseConfig);
  const { ids, seed, context } = fixture, config = testConfig({ productSearchEnabled: true, timeoutMs: 30000, catalogClassification: fixture.classification });
  for (const scope of [manifest, budgetManifest]) scope.sourceHashes = sources;
  const directory = new URL("../../../.scratch/assistant-shared-db/", import.meta.url); await mkdir(directory, { recursive: true });
  for (const scope of [manifest, budgetManifest]) {
    await writeFile(new URL(`${scope.marker}.json`, directory), `${JSON.stringify(scope, null, 2)}\n`, { flag: "wx" });
    t.diagnostic(`catalog_pipeline_manifest=${scope.marker}.json`);
  }
  let records, budgets; const servers = [];
  t.after(() => cleanupAssistantTestResources({ servers, cleanupCollections: async () => {
    const failures = [];
    for (const scope of [records, budgets]) try { await scope?.cleanup(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Pipeline cleanup incomplete; retain both manifests");
  }, disconnect: () => mongoose.disconnect(), restoreEnvironment: () => t.mock.timers.reset() }));
  try { await mongoose.connect(uri.href, { autoCreate: false, autoIndex: false, bufferCommands: false, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 }); }
  catch { throw new Error("Native catalog pipeline connection failed; details withheld"); }
  const target = sharedMongoConnection(mongoose.connection);
  records = sharedMongoRecords(mongoose.connection, manifest); await records.prepare();
  // Complete every store/index prerequisite before the ledger helper can make its first write.
  for (const scope of [manifest, budgetManifest]) {
    scope.indexes = {};
    for (const name of scope === manifest ? Object.keys(manifest.records) : [isolatedBudgetCollection]) {
      target.check(); const existing = await target.db.listCollections({ name }, { nameOnly: true }).toArray();
      assert.ok(existing.some((entry) => entry.name === name), "All pipeline stores must already exist");
      target.check(); scope.indexes[name] = await target.db.collection(name).listIndexes().toArray();
      assert.ok(scope.indexes[name].some((index) => JSON.stringify(index.key) === JSON.stringify({ _id: 1 })), "Native _id index required");
      if (name === isolatedBudgetCollection) assert.equal(scope.indexes[name].length, 1, "Only the existing ledger _id index is supported");
    }
    await writeFile(new URL(`${scope.marker}.json`, directory), `${JSON.stringify(scope, null, 2)}\n`);
  }
  budgets = isolatedBudgetRecords(mongoose.connection, budgetManifest, config); await budgets.prepare();
  const unusedBudgetRows = [];
  for (const _id of budgetManifest.ids.slice(3)) {
    target.check(); unusedBudgetRows.push(await target.db.collection(isolatedBudgetCollection).findOne({ _id, assistantTestRun: budgetManifest.marker }));
  }
  for (const row of seed) await records.insert(row.collection, row.document);
  const operations = mockSharedCatalogPipelineBoundaries(t, manifest, { db: target.db, client: target.client, checkTarget: target.check });
  // Run hello/session initialization with model DDL suppressed, then install the unchanged ledger redirect last.
  await transaction(async () => {}); budgets.install(t);
  const app = express(); app.use(express.json());
  app.use("/api/v1/assistant", createAssistantRouter({ getConfig: () => config, authenticate(req, _res, next) {
    assert.ok([undefined, "foreign"].includes(req.get("X-Fixture-Principal")));
    req.user = { _id: req.get("X-Fixture-Principal") === "foreign" ? ids.users[1] : ids.users[0] }; next();
  } }));
  const server = app.listen(0, "127.0.0.1"); servers.push(server);
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const origin = `http://127.0.0.1:${server.address().port}`, url = `${origin}/api/v1/assistant`, realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (value, options) => {
    assert.equal(new URL(value).origin, origin, "Only this fixture HTTP server may be contacted"); return realFetch(value, options);
  });
  const headers = { "Content-Type": "application/json", "Idempotency-Key": manifest.marker };
  const body = JSON.stringify({ text: pipelineInput, catalogContext: context });
  const acceptedResponse = await fetch(`${url}/messages`, { method: "POST", headers, body });
  assert.equal(acceptedResponse.status, 202); const accepted = (await acceptedResponse.json()).data;
  assert.equal(accepted.duplicate, false); assert.equal(accepted.run.status, "queued");
  const runId = accepted.run.id; assert.equal(runId, String(ids.assistantruns[0]));
  const queued = await (await fetch(`${url}/runs/${runId}`)).json();
  assert.equal(queued.data.run.status, "queued"); assert.equal(queued.data.message, null);
  let adapterCalls = 0, readerCalls = 0;
  const worker = () => processAssistantRun(runId, { getConfig: () => config, adapterFactory: () => ({ async generate(request) {
    adapterCalls++; assert.match(request.instructions, /"productSearchAvailable":true/); return fixture.result;
  } }), readProducts: async (request, policy) => {
    readerCalls++; assert.equal(request.warnings.length, 1); assert.equal(request.warnings[0].text, pipelineQuote);
    return readAssistantCatalog(request, policy);
  } });
  const completions = await Promise.all([worker(), worker()]);
  assert.equal(completions.filter((result) => result.status === "completed").length, 1);
  assert.equal(adapterCalls, 1); assert.equal(readerCalls, 1);
  const pollResponse = await fetch(`${url}/runs/${runId}`), historyResponse = await fetch(`${url}/messages`);
  assert.equal(pollResponse.status, 200); assert.equal(historyResponse.status, 200);
  const poll = (await pollResponse.json()).data, history = (await historyResponse.json()).data;
  const reply = history.messages.find((message) => message.role === "assistant");
  assert.equal(history.messages.length, 2); assert.equal(reply.id, String(ids.assistantmessages[1]));
  assert.equal(history.messages.find((message) => message.role === "user").id, String(ids.assistantmessages[0]));
  assert.equal(poll.run.status, "completed"); assert.equal(poll.run.responseMessageId, reply.id); assert.equal(reply.runId, runId);
  assert.deepEqual(poll.message.catalog, reply.catalog); assert.equal(reply.catalog.products.length, 1);
  const card = reply.catalog.products[0];
  assert.equal(card.id, String(ids.products[0])); assert.equal(card.price, 100); assert.equal(card.inStock, true);
  assert.equal(reply.catalog.subjectId, manifest.subjectId); assert.equal(reply.catalog.requestedWarehouseId, context.warehouseId);
  assert.match(JSON.stringify(reply.catalog), /not_verified/);
  assert.doesNotMatch(JSON.stringify({ poll, history }), /catalogJson|providerRequestId|chargedMicroUsd|classification|binding/);
  const foreignHeaders = { "X-Fixture-Principal": "foreign" };
  assert.equal((await fetch(`${url}/runs/${runId}`, { headers: foreignHeaders })).status, 404);
  assert.deepEqual((await (await fetch(`${url}/messages`, { headers: foreignHeaders })).json()).data.messages, []);
  const before = operations.filter((operation) => !["find", "findOne"].includes(operation.method)).length;
  const duplicate = await fetch(`${url}/messages`, { method: "POST", headers, body }); assert.equal(duplicate.status, 200);
  const duplicateData = (await duplicate.json()).data; assert.equal(duplicateData.duplicate, true); assert.equal(duplicateData.run.id, runId);
  const conflict = await fetch(`${url}/messages`, { method: "POST", headers,
    body: JSON.stringify({ text: pipelineInput, catalogContext: { ...context, language: "ar" } }) });
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.code, "idempotency_conflict");
  assert.deepEqual(await processAssistantRun(runId, { getConfig: () => config }), { skipped: true });
  assert.equal(operations.filter((operation) => !["find", "findOne"].includes(operation.method)).length, before);
  assert.equal(adapterCalls, 1); assert.equal(readerCalls, 1);
  const read = async (name, id) => { target.check(); return target.db.collection(name).findOne({ _id: id, assistantTestRun: manifest.marker }); };
  const run = await read("assistantruns", ids.assistantruns[0]), account = await read("assistantaccounts", ids.assistantaccounts[0]);
  assert.equal(run.accounting, "settled"); assert.equal(run.chargedMicroUsd, 198); assert.equal(run.attempts.length, 1);
  assert.deepEqual(run.reservation.budgetIds, [budgetManifest.ids[1], budgetManifest.ids[2]]);
  assert.deepEqual(run.catalogContext, context); assert.equal(account.activeRun, null); assert.equal(account.dayMessages, 1); assert.equal(account.reviewEvidenceVersion, 1);
  const warning = await read("assistantdietarywarnings", ids.assistantdietarywarnings[0]);
  assert.equal(warning.text, pipelineQuote); assert.equal(warning.version, 1); assert.equal(warning.subjectId, manifest.subjectId);
  assert.equal(String(warning.sourceMessage), String(ids.assistantmessages[0]));
  const chat = await read("assistantchats", ids.assistantchats[0]); assert.equal(chat.nextSequence, 2); assert.equal(chat.contextVersion, 1);
  for (const [index, id] of ids.assistantevents.entries()) assert.equal((await read("assistantevents", id)).type, pipelineAuditTypes[index]);
  await assertCatalogPipelineCardinality(target, manifest);
  for (const _id of budgetManifest.ids) {
    target.check(); const row = await target.db.collection(isolatedBudgetCollection).findOne({ _id, assistantTestRun: budgetManifest.marker });
    assert.equal(row.reserved, 0); assert.equal(row.spent, run.reservation.budgetIds.includes(_id) ? 198 : 0);
    if (budgetManifest.ids.indexOf(_id) >= 3) assert.deepEqual(row, unusedBudgetRows[budgetManifest.ids.indexOf(_id) - 3]);
  }
});
