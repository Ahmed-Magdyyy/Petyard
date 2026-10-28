import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import mongoose from "mongoose";
import { validateSharedMongoTarget, sharedMongoConfirmation } from "./fixtures/sharedMongo.js";
import { focusedReferenceNativeOptIn, validateFocusedReferenceNativePlan, claimFocusedReferenceNativeDatabase,
  installFocusedReferenceNativeGuard, inspectFocusedReferenceNativeDatabase, cleanupFocusedReferenceNativeDatabase } from "./fixtures/focusedReferenceNative.js";

test("isolated native focused reference stages and accounting", {
  skip: process.env.ASSISTANT_RETRIEVAL_NATIVE_TEST !== focusedReferenceNativeOptIn && "Prepared only; native setup/run/cleanup requires approval",
  timeout: 600000,
}, async t => {
  const plan = validateFocusedReferenceNativePlan(JSON.parse(await readFile(process.env.ASSISTANT_RETRIEVAL_NATIVE_PLAN, "utf8")));
  const uri = validateSharedMongoTarget(process.env.ASSISTANT_RETRIEVAL_NATIVE_URI, sharedMongoConfirmation);
  mongoose.set("autoCreate", false); mongoose.set("autoIndex", false); mongoose.set("bufferCommands", false);
  for (const key of ["OPENAI_API_KEY", "MONGO_URI", "REDIS_URL"]) assert.equal(process.env[key], undefined);
  const refuse = () => { throw Error("Provider/storage/push HTTP is outside this native test"); };
  t.mock.method(globalThis, "fetch", refuse);
  for (const module of [http, https]) for (const method of ["request", "get"]) t.mock.method(module, method, refuse);
  let claimed = false, guard, fakeCalls = 0;
  try {
    await mongoose.connect(uri.href, { dbName: plan.database, autoCreate: false, autoIndex: false, bufferCommands: false,
      retryWrites: false, serverSelectionTimeoutMS: 20000, connectTimeoutMS: 20000 });
    await claimFocusedReferenceNativeDatabase(mongoose.connection, plan); claimed = true;
    guard = installFocusedReferenceNativeGuard(t, mongoose.connection, plan); const db = mongoose.connection.db;
    const { AssistantAccount, AssistantBudget, AssistantChat, AssistantMessage, AssistantRun } = await import("../../../src/domains/assistant/shared/assistant.models.js");
    const { AssistantEmbeddingBatch } = await import("../../../src/domains/assistant/references/assistant.embedding-batch.model.js");
    const { AssistantReference } = await import("../../../src/domains/assistant/references/assistant.reference.model.js");
    const { referencePassageVersion } = await import("../../../src/domains/assistant/references/assistant.reference-passages.js");
    const { referenceVectorIndex } = await import("../../../src/domains/assistant/references/assistant.reference-passage.model.js");
    const { approvedReference } = await import("../../../src/domains/assistant/references/assistant.reference-search.js");
    const { createCustomerReferenceRetrieval } = await import("../../../src/domains/assistant/customer/assistant.reference-retrieval.js");
    const { processAssistantRun, prepareRun, finishRun, knowledgeForRun, recoverAssistantRuns } = await import("../../../src/domains/assistant/customer/assistant.worker.service.js");
    const { submitMessage, getRun, reconcileRun } = await import("../../../src/domains/assistant/customer/assistant.service.js");
    const { initializeAssistantStore } = await import("../../../src/domains/assistant/shared/assistant.store.js");
    const { embeddingProfile } = await import("../../../src/domains/assistant/providers/openaiEmbeddings.js");
    const { subjectFromPet, subjectFingerprint } = await import("../../../src/domains/assistant/customer/assistant.context.js");
    const { unwrapReferenceResult, meaningClarificationReply } = await import("../../../src/domains/assistant/customer/assistant.reference-query.js");
    const { testConfig, knownUsage, structuredReply } = await import("./fixtures/foundationPolicy.js");
    await db.createCollection("users"); await db.createCollection("pets");
    for (const model of [AssistantEmbeddingBatch, AssistantReference]) { await model.createCollection(); await model.createIndexes(); }
    await initializeAssistantStore();
    const config = testConfig({ timeoutMs: 30000, queueTimeoutMs: 600000 });
    const price = { version: "fictional-focused-native", model: embeddingProfile.model, dimensions: embeddingProfile.dimensions,
      inputMicroUsdPerMillion: 130000, validFrom: "2000-01-01T00:00:00Z", validUntil: "2100-01-01T00:00:00Z" };
    Object.assign(process.env, { ASSISTANT_REFERENCES_ENABLED: "true", ASSISTANT_REFERENCE_RETRIEVAL_ENABLED: "true",
      ASSISTANT_EMBEDDING_PRICE_JSON: JSON.stringify(price) });
    const hash = value => createHash("sha256").update(plan.run + value).digest("hex"), fixtures = [];
    const oid = () => new mongoose.Types.ObjectId();
    const vector = Array.from({ length: 1536 }, (_, index) => index ? 0 : 0.5);
    async function fixture(label, unclear = false) {
      const owner = oid(), pet = { _id: oid(), petOwner: owner, name: `Fictional pet ${label}`, type: "dog" };
      await db.collection("users").insertOne({ _id: owner, role: "user", active: true, phoneVerified: true, account_status: "confirmed" });
      await db.collection("pets").insertOne(pet);
      const reference = await AssistantReference.create({ sha256: hash(label + "/source"), creator: owner, title: "Fictional focused source",
        species: ["dog"], filename: "fictional.txt", format: "txt", bytes: 1, status: "ready", stage: "ready", version: 2,
        sourceStored: true, passageHash: hash(label + "/manifest"), passageVersion: referencePassageVersion, passageCount: 1, storedPassageCount: 1,
        activation: { sourceHash: hash(label + "/source"), manifestHash: hash(label + "/manifest"), actor: owner, at: new Date(), reviewedVersion: 1 },
        searchVerification: { model: embeddingProfile.model, dimensions: embeddingProfile.dimensions, manifestHash: hash(label + "/manifest"),
          passageCount: 1, indexId: "fictional-not-created", indexName: referenceVectorIndex.name, indexVersion: 1, verifiedAt: new Date() } });
      const input = { text: unclear ? "anaddaf farshet el kalb ezay?" : `How should I clean my dog's bedding? Fictional ${label}`,
        subjectId: `pet:${pet._id}` }, key = `${plan.run}:${label}`;
      const admission = await submitMessage(owner, input, key, config), runId = new mongoose.Types.ObjectId(admission.run.id);
      const f = { owner, pet, reference, input, key, runId, label, unclear, chats: 0, embeddings: 0, preparedFinal: null };
      f.saved = () => AssistantRun.findById(runId).lean();
      f.answers = () => AssistantMessage.countDocuments({ run: runId, role: "assistant" });
      f.passages = [{ sourceId: String(reference._id), version: reference.passageHash, title: reference.title,
        locator: "Fictional excerpt 1", excerpt: "Fictional general education evidence.", reviewed: true, species: ["dog"] }];
      f.retrieve = createCustomerReferenceRetrieval({ getConfig: () => ({ enabled: true, price, timeoutMs: 30000 }),
        search: { async hasEligibleSources() { return approvedReference(await AssistantReference.findById(reference._id).lean()); },
          async search() { return f.passages; } },
        adapterFactory: () => ({ ...embeddingProfile, async embed() {
          f.embeddings++; fakeCalls++;
          return { vectors: [vector], usage: { inputTokens: 100, totalTokens: 100, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
            providerRequestId: `fake-${label}-embedding` };
        } }) });
      f.result = phase => ({ structured: phase === "resolve" ? { answer: structuredReply({ reply: "", replyLanguage: unclear ? "ar" : "en" }), referenceAction: "prepare" }
        : phase === "normalize" ? { status: unclear ? "unclear" : "ready", query: unclear ? null : "How should I clean my dog's bedding?" }
        : structuredReply({ reply: unclear ? "لو قصدك فرشة النوم اغسلها دلوقتي." : "Fictional general care response.", replyLanguage: unclear ? "ar" : "en" }),
        usage: f.unknownPhase === phase ? null : knownUsage, providerRequestId: `fake-${label}-${phase}`,
        finishReason: "completed", serviceTier: "default", toolCalls: [] });
      f.generate = async request => {
        const run = await f.saved(); assert.equal(run.status, "dispatching");
        const phase = request.outputSchema.properties.answer ? "resolve" : request.outputSchema.properties.status ? "normalize" : "answer";
        assert.equal(phase, run.phase); f.chats++; fakeCalls++;
        if (phase === "answer") f.preparedFinal = { run, allowedSubjects: ["user", input.subjectId],
          subjectFingerprints: { [input.subjectId]: subjectFingerprint(subjectFromPet(pet)) } };
        await f.onStage?.(phase); return f.result(phase);
      };
      f.process = () => processAssistantRun(runId, { getConfig: () => config, retrieveKnowledge: f.retrieve, adapterFactory: () => ({ generate: f.generate }) });
      fixtures.push(f); return f;
    }
    const disable = f => AssistantReference.updateOne({ _id: f.reference._id, status: "ready" },
      { $set: { status: "disabled", stage: "disabled", disabledBy: f.owner }, $inc: { version: 1 } });
    const passed = async name => {
      const snapshot = await inspectFocusedReferenceNativeDatabase(mongoose.connection, plan);
      for (const name of ["assistantmemories", "assistantdietarywarnings", "notificationoutboxes"]) assert.equal(await db.collection(name).countDocuments({}), 0);
      t.diagnostic(`focused_native_case=${name}:passed;documents=${snapshot.documents};insertAttempts=${guard.insertAttempts()}`);
    };
    await t.test("one native normalizer claim wins and admission retries retain one allowance and publication", async () => {
      const f = await fixture("concurrent");
      assert.equal((await submitMessage(f.owner, f.input, f.key, config)).duplicate, true);
      const initial = await prepareRun(f.runId, config, await knowledgeForRun(f.runId, config, f.retrieve));
      await finishRun(initial, unwrapReferenceResult(await f.generate(initial.request), true), null, { currentConfig: config });
      const batch = await knowledgeForRun(f.runId, config, f.retrieve);
      const claims = await Promise.all([prepareRun(f.runId, config, batch), prepareRun(f.runId, config, batch)]);
      assert.equal(claims.filter(Boolean).length, 1); const normalizer = claims.find(Boolean);
      await finishRun(normalizer, await f.generate(normalizer.request), null, { currentConfig: config });
      assert.equal((await f.process()).status, "completed");
      const saved = await f.saved(); assert.deepEqual(saved.attempts.map(a => a.phase), ["resolve", "normalize", "answer"]);
      assert.ok(saved.attempts.every(a => a.accounting === "settled")); assert.equal(f.chats, 3); assert.equal(f.embeddings, 1);
      assert.equal(await f.answers(), 1); assert.equal((await AssistantAccount.findOne({ owner: f.owner }).lean()).dayMessages, 1);
      assert.equal((await submitMessage(f.owner, f.input, f.key, config)).duplicate, true);
      const dto = await getRun(f.owner, String(f.runId), config);
      assert.doesNotMatch(JSON.stringify(dto), /referenceQuery|referenceFlowVersion|referenceContextExpiresAt/);
      assert.equal((await AssistantReference.findById(f.reference._id).lean()).retrievalFence, 2);
      await passed("normalizer_claim");
    });
    await t.test("native unclear publication stores a safe question without embeddings or memory", async () => {
      const f = await fixture("unclear", true); assert.equal((await f.process()).status, "completed");
      const dto = await getRun(f.owner, String(f.runId), config);
      assert.equal(dto.run.code, "meaning_clarification_required"); assert.equal(dto.message.text, meaningClarificationReply("ar"));
      assert.equal(f.chats, 3); assert.equal(f.embeddings, 0); assert.equal(await f.answers(), 1); await passed("unclear_publication");
    });
    await t.test("changed native context during normalization settles but withholds its result", async () => {
      const f = await fixture("context");
      f.onStage = async phase => { if (phase === "normalize") {
        const run = await f.saved(); await AssistantChat.updateOne({ _id: run.chat }, { $inc: { contextVersion: 1 } });
      } };
      assert.equal((await f.process()).status, "failed"); const saved = await f.saved();
      assert.equal(saved.publicCode, "context_changed"); assert.equal(f.chats, 2); assert.equal(f.embeddings, 0);
      assert.ok(saved.attempts.every(a => a.accounting === "settled")); assert.equal(await f.answers(), 0); await passed("context_changed");
    });
    await t.test("unknown normalizer usage is retained until existing reconciliation closes it once", async () => {
      const f = await fixture("unknown_normalizer"); f.unknownPhase = "normalize";
      assert.equal((await f.process()).status, "uncertain"); const before = await f.saved();
      assert.deepEqual(before.attempts.map(a => a.accounting), ["settled", "reserved"]);
      assert.equal((await f.process()).skipped, true); assert.equal(f.chats, 2); assert.equal(f.embeddings, 0);
      const body = { resolution: "charge_reserved", reason: "Fictional native normalizer review" };
      assert.equal((await reconcileRun(f.owner, String(f.runId), body, config)).duplicate, false);
      assert.equal((await reconcileRun(f.owner, String(f.runId), body, config)).duplicate, true);
      const saved = await f.saved(); assert.equal(saved.attempts[1].accounting, "charged_reservation");
      assert.deepEqual(saved.attempts[0], before.attempts[0]); assert.equal(await f.answers(), 0); await passed("unknown_normalizer");
    });
    await t.test("native final reconciliation and late known completion have one financial winner", async () => {
      const f = await fixture("final_race"); f.unknownPhase = "answer";
      assert.equal((await f.process()).status, "uncertain"); const before = await f.saved(); f.unknownPhase = null;
      const close = () => reconcileRun(f.owner, String(f.runId), { resolution: "charge_reserved", reason: "Fictional native final race" }, config);
      const finish = () => finishRun(f.preparedFinal, f.result("answer"), null, { currentConfig: config });
      const outcomes = await Promise.allSettled([close(), finish(), close(), finish()]); const saved = await f.saved();
      assert.ok(["completed", "failed"].includes(saved.status)); assert.ok(["settled", "charged_reservation"].includes(saved.accounting));
      assert.deepEqual(saved.attempts.slice(0, 2), before.attempts.slice(0, 2));
      if (saved.accounting === "charged_reservation") {
        assert.equal(await f.answers(), 0); assert.equal(await finish(), null);
        assert.ok([outcomes[0], outcomes[2]].every(r => r.status === "fulfilled"));
        assert.ok([outcomes[1], outcomes[3]].every(r => r.status === "fulfilled" && r.value === null));
      } else {
        assert.equal(await f.answers(), 1);
        assert.equal([outcomes[1], outcomes[3]].filter(r => r.status === "fulfilled" && r.value?.status === "completed").length, 1);
        assert.ok([outcomes[0], outcomes[2]].every(r => r.status === "rejected" && r.reason.code === "run_not_reconcilable"));
      }
      assert.equal(f.chats, 3); assert.equal(f.embeddings, 1); await passed("final_reconciliation_race");
    });
    await t.test("interrupted third attempt is recovered without replay and may settle its same late response", async () => {
      const f = await fixture("recovery");
      f.onStage = async phase => { if (phase === "answer") {
        const current = await f.saved();
        await AssistantRun.updateOne({ _id: f.runId, attempt: current.attempt }, { $set: { dispatchDeadline: new Date(Date.now() - 1) } });
        assert.equal(await recoverAssistantRuns(config), 1); assert.equal(await recoverAssistantRuns(config), 0);
        const recovered = await f.saved(); assert.equal(recovered.status, "uncertain"); assert.equal(recovered.attempts[2].accounting, "reserved");
        assert.equal((await f.process()).skipped, true); assert.equal(f.chats, 3);
      } };
      assert.equal((await f.process()).status, "completed");
      const saved = await f.saved(); assert.ok(saved.attempts.every(a => a.accounting === "settled"));
      assert.equal(f.chats, 3); assert.equal(f.embeddings, 1); assert.equal(await f.answers(), 1); await passed("third_attempt_recovery");
    });
    await t.test("disappearing library skips the unpaid normalizer without phantom history", async () => {
      const f = await fixture("library_removed"); f.onStage = async phase => { if (phase === "resolve") await disable(f); };
      assert.equal((await f.process()).status, "completed");
      assert.deepEqual((await f.saved()).attempts.map(a => a.phase), ["resolve", "answer"]);
      assert.equal(f.chats, 2); assert.equal(f.embeddings, 0); assert.equal(await f.answers(), 1); await passed("skip_normalizer");
    });
    await t.test("disabling supplied evidence during final generation prevents native publication", async () => {
      const f = await fixture("source_removed"); f.onStage = async phase => { if (phase === "answer") await disable(f); };
      assert.equal((await f.process()).status, "failed"); const saved = await f.saved();
      assert.equal(saved.publicCode, "reference_knowledge_changed"); assert.ok(saved.attempts.every(a => a.accounting === "settled"));
      assert.equal(f.chats, 3); assert.equal(f.embeddings, 1); assert.equal(await f.answers(), 0); await passed("withheld_reference");
    });
    const receipts = await AssistantEmbeddingBatch.find({}).lean(), runs = await AssistantRun.find({}).lean();
    assert.equal(receipts.length, 4); assert.equal(fakeCalls, 25); assert.ok(receipts.every(r => r.accounting === "settled"));
    const charges = [...receipts, ...runs.flatMap(run => run.attempts)];
    assert.ok(charges.every(row => ["settled", "charged_reservation"].includes(row.accounting)));
    for (const budget of await AssistantBudget.find({ _id: { $ne: "control" } }).lean()) {
      assert.equal(budget.reserved, 0);
      assert.equal(budget.spent, charges.filter(row => row.reservation.budgetIds.includes(budget._id)).reduce((sum, row) => sum + row.chargedMicroUsd, 0));
    }
    for (const f of fixtures) assert.equal((await AssistantAccount.findOne({ owner: f.owner }).lean()).activeRun, null);
  } finally {
    try { if (claimed) {
      t.diagnostic(`focused_native_insert_attempts=${guard?.insertAttempts() ?? 1}`);
      t.diagnostic(`focused_native_fake_calls=${fakeCalls}`);
      t.diagnostic(`focused_native_cleanup=${JSON.stringify(await cleanupFocusedReferenceNativeDatabase(mongoose.connection, plan))}`);
    } } finally { await mongoose.disconnect(); }
  }
});
