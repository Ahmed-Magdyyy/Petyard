import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import mongoose from "mongoose";
import { createSharedMongoManifest, sharedMongoRecords, sharedMongoConnection, validateSharedMongoTarget } from "./fixtures/sharedMongo.js";
import { createIsolatedBudgetManifest, isolatedBudgetRecords, isolatedBudgetCollection, financialTestTime } from "./fixtures/isolatedBudget.js";
import { cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";
import { testConfig, knownUsage, structuredReply } from "./fixtures/foundationPolicy.js";
import { costMicroUsd } from "../../../src/domains/assistant/shared/assistant.config.js";

const optIn = process.env.ASSISTANT_SHARED_CATALOG_TEST;
test("native catalog/warning/reply publication rolls back together and concurrent completion charges/publishes once", {
  skip: !optIn && "Requires separate catalog-warning-native-owned-records-only approval",
}, async (t) => {
  assert.equal(optIn, "catalog-warning-native-owned-records-only");
  const uri = validateSharedMongoTarget(process.env.ASSISTANT_SHARED_TEST_MONGO_URI, process.env.ASSISTANT_SHARED_TEST_CONFIRM);
  mongoose.set("autoCreate", false); mongoose.set("autoIndex", false); mongoose.set("bufferCommands", false);
  const { AssistantAccount, AssistantChat, AssistantMessage, AssistantRun, AssistantDietaryWarning, AssistantEvent } = await import("../../../src/domains/assistant/shared/assistant.models.js");
  const { transaction, reserveCost } = await import("../../../src/domains/assistant/shared/assistant.store.js");
  const { finishRun, prepareProductSearch } = await import("../../../src/domains/assistant/customer/assistant.worker.service.js");
  const { subjectFingerprint } = await import("../../../src/domains/assistant/customer/assistant.context.js");
  const { getRun, getHistory } = await import("../../../src/domains/assistant/customer/assistant.service.js");
  const { beginAttempt } = await import("../../../src/domains/assistant/shared/assistant.attempts.js");
  const { mockSharedCatalogBoundaries } = await import("./fixtures/sharedCatalogBoundaries.js");
  // Native Atlas round trips need more than the one-second in-memory fixture deadline.
  const config = testConfig({ productSearchEnabled: true, timeoutMs: 30000 });
  const budgetManifest = createIsolatedBudgetManifest(config);
  const manifest = createSharedMongoManifest("catalogPublication"); manifest.records.users = [...budgetManifest.owners];
  manifest.subjectId = `chat:${randomUUID()}`; manifest.catalogProductId = String(new mongoose.Types.ObjectId());
  const ids = Object.fromEntries(Object.entries(manifest.records).map(([name, values]) => [name, values.map((value) => new mongoose.Types.ObjectId(value))]));
  const directory = new URL("../../../.scratch/assistant-shared-db/", import.meta.url); await mkdir(directory, { recursive: true });
  for (const scope of [manifest, budgetManifest]) {
    await writeFile(new URL(`${scope.marker}.json`, directory), `${JSON.stringify(scope, null, 2)}\n`, { flag: "wx" });
    t.diagnostic(`catalog_manifest=${scope.marker}.json`);
  }
  let records, budgetRecords;
  t.after(() => cleanupAssistantTestResources({ servers: [], cleanupCollections: async () => {
    const failures = [];
    for (const owned of [records, budgetRecords]) try { await owned?.cleanup(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Catalog cleanup incomplete; retain both manifests");
  }, disconnect: () => mongoose.disconnect(), restoreEnvironment() {} }));
  try { await mongoose.connect(uri.href, { autoCreate: false, autoIndex: false, bufferCommands: false, serverSelectionTimeoutMS: 5000 }); }
  catch { throw new Error("Catalog native test connection failed; details withheld"); }
  const target = sharedMongoConnection(mongoose.connection);
  records = sharedMongoRecords(mongoose.connection, manifest); await records.prepare();
  budgetRecords = isolatedBudgetRecords(mongoose.connection, budgetManifest, config); await budgetRecords.prepare();
  const owner = ids.users[0], chat = ids.assistantchats[0], runId = ids.assistantruns[0];
  const sourceId = ids.assistantmessages[0], replyId = ids.assistantmessages[1], warningId = ids.assistantdietarywarnings[0];
  const now = new Date(), expiresAt = new Date(now.getTime() + 3600000);
  const subject = { id: manifest.subjectId, name: "Synthetic cat", species: "cat", expiresAt, saved: false };
  const input = "My cat has a chicken allergy; show cat toys";
  const context = { warehouseId: manifest.warehouse, language: "en" };
  const seed = async (Model, value) => {
    const document = new Model({ ...value, createdAt: now, updatedAt: now }); assert.equal(document.validateSync(), undefined);
    await records.insert(Model.collection.name, document.toObject());
  };
  for (const _id of ids.users) await records.insert("users", { _id, email: `${_id}@assistant-test.invalid`, name: manifest.marker,
    role: "user", active: true, phoneVerified: true, account_status: "confirmed", deletedAt: null });
  await seed(AssistantAccount, { _id: ids.assistantaccounts[0], owner, activeRun: runId });
  await seed(AssistantChat, { _id: chat, owner, activeSubject: subject.id, nextSequence: 1, subjects: [{ id: subject.id, name: subject.name, species: subject.species, expiresAt }] });
  await seed(AssistantRun, { _id: runId, owner, chat, key: `${manifest.marker}/catalog`, hash: "synthetic-catalog-native-only", purpose: "customer",
    status: "queued", phase: "resolve", generation: 0, contextVersion: 0, subjectId: subject.id, subjectFingerprint: subjectFingerprint(subject),
    input, userSequence: 1, config, catalogContext: context, deadline: expiresAt });
  await seed(AssistantMessage, { _id: sourceId, owner, chat, run: runId, sequence: 1, role: "user", text: input, subjectId: subject.id, expiresAt });
  mockSharedCatalogBoundaries(t, manifest, { subjectId: subject.id, client: target.client, checkTarget: target.check });
  // Existing initializer is completed with all DDL stubbed; isolated budget DDL then becomes an explicit refusal.
  await transaction(async () => {}); budgetRecords.install(t);
  const prepared = await transaction(async (session) => {
    const run = await AssistantRun.findById(runId).session(session);
    beginAttempt(run, await reserveCost(owner, config, session, new Date(financialTestTime)));
    run.status = "dispatching"; await run.save({ session });
    return { run: run.toObject(), allowedSubjects: ["user", subject.id], subjectFingerprints: { [subject.id]: subjectFingerprint(subject) } };
  });
  const result = { structured: structuredReply({ reply: "INVENTED products must not be published", dietaryWarningAction: "report",
    dietaryWarningSubjectId: subject.id, dietaryWarningQuote: input, productSearch: { action: "pet", query: "cat toys", minimumPackageWeightGrams: null,
      maximumPriceMinor: null, sourceQuote: "", options: [] } }), usage: knownUsage, serviceTier: "default", finishReason: "completed", toolCalls: [],
    providerRequestId: "synthetic-no-provider-call", latencyMs: 1 };
  let reads = 0;
  const batch = await prepareProductSearch(prepared, result, config, { readProducts: async (request) => {
    reads++; assert.equal(request.subject.id, subject.id); assert.equal(request.warnings.length, 1); assert.equal(request.warnings[0].text, input);
    return { status: "results", effectiveWarehouseId: manifest.warehouse, rerouted: false, generatedAt: new Date().toISOString(), products: [
      { id: manifest.catalogProductId, slug: "synthetic-native-cat-toy", name: "Synthetic toy", type: "SIMPLE", image: null, price: 100,
        discountedPrice: null, inStock: true, hasVariants: false, priceDisplay: "exact" },
    ] };
  } });
  const finish = () => finishRun(prepared, result, null, { currentConfig: config, productSearchBatch: batch });
  const raw = (name) => target.db.collection(name);
  const owned = (_id) => ({ _id, assistantTestRun: manifest.marker });
  const assertReserved = async () => {
    target.check();
    const run = await raw("assistantruns").findOne(owned(runId)); assert.equal(run.status, "dispatching"); assert.equal(run.accounting, "reserved");
    assert.equal(run.responseMessage, null); assert.equal(run.attempts[0].accounting, "reserved");
    assert.equal(await raw("assistantmessages").countDocuments(owned(replyId)), 0);
    assert.equal(await raw("assistantdietarywarnings").countDocuments(owned(warningId)), 0);
    const state = await raw("assistantchats").findOne(owned(chat)); assert.equal(state.contextVersion, 0); assert.equal(state.nextSequence, 1);
    const account = await raw("assistantaccounts").findOne(owned(ids.assistantaccounts[0])); assert.equal(String(account.activeRun), String(runId));
    assert.equal(account.reviewEvidenceVersion, 0);
    for (const _id of prepared.run.reservation.budgetIds) {
      const row = await raw(isolatedBudgetCollection).findOne({ _id, assistantTestRun: budgetManifest.marker });
      assert.equal(row.reserved, prepared.run.reservation.amount); assert.equal(row.spent, 0);
    }
  };
  await assertReserved();
  const originalEvent = AssistantEvent.create;
  const interruption = new Error("Synthetic failure after warning and reply writes");
  const eventFailure = t.mock.method(AssistantEvent, "create", function (documents, options) {
    if (documents[0].type === "run_completed") throw interruption;
    return originalEvent.call(this, documents, options);
  });
  try { await assert.rejects(finish(), (error) => error === interruption); } finally { eventFailure.mock.restore(); }
  await assertReserved();
  const completions = await Promise.all([1, 2, 3, 4].map(() => finish()));
  assert.equal(completions.filter(Boolean).length, 1); assert.equal(completions.filter((value) => value === null).length, 3);
  const completed = await raw("assistantruns").findOne(owned(runId)); assert.equal(completed.status, "completed"); assert.equal(completed.accounting, "settled");
  const charge = costMicroUsd(knownUsage, config); assert.equal(completed.chargedMicroUsd, charge);
  const warning = await raw("assistantdietarywarnings").findOne(owned(warningId)); assert.equal(warning.text, input); assert.equal(warning.subjectId, subject.id);
  assert.equal(String(warning.sourceMessage), String(sourceId)); assert.equal(warning.state, "active"); assert.equal(warning.version, 1);
  const state = await raw("assistantchats").findOne(owned(chat)); assert.equal(state.nextSequence, 2); assert.equal(state.contextVersion, 1);
  const account = await raw("assistantaccounts").findOne(owned(ids.assistantaccounts[0])); assert.equal(account.activeRun, null); assert.equal(account.reviewEvidenceVersion, 1);
  const poll = await getRun(owner, String(runId), config), history = await getHistory(owner, {}, config);
  assert.deepEqual(poll.message.catalog, history.messages[0].catalog); assert.equal(poll.message.catalog.products[0].id, manifest.catalogProductId);
  assert.equal(poll.message.catalog.subjectId, subject.id); assert.doesNotMatch(JSON.stringify(poll.message), /INVENTED|catalogJson|classification|binding|sourceMessage/);
  await assert.rejects(getRun(ids.users[1], String(runId), config), { code: "run_not_found" });
  assert.equal((await getHistory(ids.users[1], {}, config)).messages.length, 0);
  assert.equal(await finish(), null); assert.equal(reads, 1);
  assert.equal(await raw("assistantmessages").countDocuments(owned(replyId)), 1); assert.equal(await raw("assistantdietarywarnings").countDocuments(owned(warningId)), 1);
  for (const _id of budgetManifest.ids) {
    const row = await raw(isolatedBudgetCollection).findOne({ _id, assistantTestRun: budgetManifest.marker });
    assert.equal(row.reserved, 0); assert.equal(row.spent, prepared.run.reservation.budgetIds.includes(_id) ? charge : 0);
  }
});
