import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import mongoose from "mongoose";
import { validateSharedMongoTarget, sharedMongoConfirmation } from "./fixtures/sharedMongo.js";
import { retrievalNativeOptIn, validateRetrievalNativePlan, claimRetrievalNativeDatabase, installRetrievalNativeGuard,
  inspectRetrievalNativeDatabase, cleanupRetrievalNativeDatabase } from "./fixtures/retrievalNative.js";

test("isolated native customer question binding and reference disabling", {
  skip: process.env.ASSISTANT_RETRIEVAL_NATIVE_TEST !== retrievalNativeOptIn && "Prepared only; exact setup/run/cleanup requires approval",
  timeout: 600000,
}, async t => {
  const plan = validateRetrievalNativePlan(JSON.parse(await readFile(process.env.ASSISTANT_RETRIEVAL_NATIVE_PLAN, "utf8")));
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
    await claimRetrievalNativeDatabase(mongoose.connection, plan); claimed = true;
    guard = installRetrievalNativeGuard(t, mongoose.connection, plan); const db = mongoose.connection.db;
    const { AssistantAccount, AssistantBudget, AssistantChat, AssistantMessage, AssistantRun } = await import("../../../src/domains/assistant/shared/assistant.models.js");
    const { AssistantEmbeddingBatch } = await import("../../../src/domains/assistant/references/assistant.embedding-batch.model.js");
    const { AssistantReference } = await import("../../../src/domains/assistant/references/assistant.reference.model.js");
    const { referencePassageVersion } = await import("../../../src/domains/assistant/references/assistant.reference-passages.js");
    const { referenceVectorIndex } = await import("../../../src/domains/assistant/references/assistant.reference-passage.model.js");
    const { createCustomerQueryEmbedder } = await import("../../../src/domains/assistant/customer/assistant.query-embedding.js");
    const { externalWorkScope, processAssistantRun, prepareRun, finishRun } = await import("../../../src/domains/assistant/customer/assistant.worker.service.js");
    const { initializeAssistantStore, transaction } = await import("../../../src/domains/assistant/shared/assistant.store.js");
    const { embeddingProfile } = await import("../../../src/domains/assistant/providers/openaiEmbeddings.js");
    const { testConfig, knownUsage, structuredReply } = await import("./fixtures/foundationPolicy.js");
    await db.createCollection("users"); await db.createCollection("pets");
    for (const model of [AssistantEmbeddingBatch, AssistantReference]) { await model.createCollection(); await model.createIndexes(); }
    await initializeAssistantStore();
    const config = testConfig({ timeoutMs: 30000 });
    const price = { version: "fictional-native-retrieval", model: embeddingProfile.model, dimensions: embeddingProfile.dimensions,
      inputMicroUsdPerMillion: 20000, validFrom: "2000-01-01T00:00:00Z", validUntil: "2100-01-01T00:00:00Z" };
    Object.assign(process.env, { ASSISTANT_REFERENCES_ENABLED: "true", ASSISTANT_REFERENCE_RETRIEVAL_ENABLED: "true",
      ASSISTANT_EMBEDDING_PRICE_JSON: JSON.stringify(price) });
    const oid = () => new mongoose.Types.ObjectId(), hash = value => createHash("sha256").update(plan.run + value).digest("hex");
    const usage = { inputTokens: 100, totalTokens: 100, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 };
    const vector = Array.from({ length: 1536 }, (_, index) => index ? 0 : 0.5), embed = createCustomerQueryEmbedder();
    async function fixture(label) {
      const owner = oid(), chatId = oid(), runId = oid();
      await db.collection("users").insertOne({ _id: owner, role: "user", active: true, phoneVerified: true, account_status: "confirmed" });
      await AssistantChat.create({ _id: chatId, owner, nextSequence: 1 });
      const run = await AssistantRun.create({ _id: runId, owner, chat: chatId, purpose: "customer", key: `${plan.run}/${label}`,
        hash: hash(label), status: "queued", phase: "resolve", generation: 0, contextVersion: 0, subjectId: null, subjectFingerprint: null,
        input: `Fictional general pet-care question ${label}`, userSequence: 1, deadline: new Date(Date.now() + 600000), config });
      await AssistantAccount.create({ owner, activeRun: runId });
      const message = await AssistantMessage.create({ owner, chat: chatId, run: runId, sequence: 1, role: "user", text: run.input,
        subjectId: null, expiresAt: new Date(Date.now() + 3600000) });
      const reference = await AssistantReference.create({ sha256: hash(label + "/source"), creator: owner, title: "Fictional source fixture",
        species: ["*"], filename: "fictional.txt", format: "txt", bytes: 1, status: "ready", stage: "ready", version: 2,
        sourceStored: true, passageHash: hash(label + "/manifest"), passageVersion: referencePassageVersion, passageCount: 1, storedPassageCount: 1,
        activation: { sourceHash: hash(label + "/source"), manifestHash: hash(label + "/manifest"), actor: owner, at: new Date(), reviewedVersion: 1 },
        searchVerification: { manifestHash: hash(label + "/manifest"), passageCount: 1, indexId: "fictional-not-created", indexName: referenceVectorIndex.name,
          indexVersion: 1, verifiedAt: new Date() } });
      const f = { owner, run, chatId, message, reference, embeddings: 0, chats: 0 };
      f.passages = [{ sourceId: String(reference._id), version: reference.passageHash, title: reference.title, locator: "Fictional excerpt 1",
        excerpt: "Fictional general education evidence.", reviewed: true, species: ["*"] }];
      f.adapter = { ...embeddingProfile, async embed() {
        f.embeddings++; fakeCalls++; await f.onEmbedding?.(); return { vectors: [vector], usage };
      } };
      f.query = async (scope = null) => {
        scope ??= await externalWorkScope(run.toObject(), config, "queued");
        const query = await embed({ run: run.toObject(), scope, shared: config, retrieval: { enabled: true, price, timeoutMs: 30000 }, adapter: f.adapter });
        return { scope, query };
      };
      f.batch = scope => ({ ownerId: scope.ownerId, runId: scope.runId, subjectId: scope.subjectId, contextVersion: scope.contextVersion,
        generation: scope.generation, phase: scope.phase, profileFingerprint: scope.profileFingerprint, passages: f.passages });
      f.generate = async request => {
        f.chats++; fakeCalls++; assert.match(request.instructions, /Fictional general education evidence/); await f.onChat?.();
        return { structured: structuredReply(), usage: knownUsage, serviceTier: "default", finishReason: "completed", toolCalls: [] };
      };
      f.process = () => processAssistantRun(runId, { getConfig: () => config, adapterFactory: () => ({ generate: f.generate }),
        retrieveKnowledge: async scope => {
          const result = await f.query(scope); assert.equal(result.query.accounting, "settled");
          if (f.reuse) assert.deepEqual((await f.query(scope)).query, result.query);
          return f.passages;
        } });
      f.saved = () => AssistantRun.findById(runId).lean();
      f.answers = () => AssistantMessage.countDocuments({ run: runId, role: "assistant" });
      return f;
    }
    const disable = async (f, session = undefined) => AssistantReference.updateOne({ _id: f.reference._id, status: "ready" },
      { $set: { status: "disabled", stage: "disabled", disabledBy: f.owner }, $inc: { version: 1 } }, { session });
    const passed = async name => {
      const snapshot = await inspectRetrievalNativeDatabase(mongoose.connection, plan);
      for (const name of ["pets", "assistantmemories", "assistantdietarywarnings", "notificationoutboxes"]) assert.equal(await db.collection(name).countDocuments({}), 0);
      t.diagnostic(`retrieval_native_case=${name}:passed;documents=${snapshot.documents};insertAttempts=${guard.insertAttempts()}`);
    };
    // Pause the real approval read, commit disabling in another active session, then require a native conflict retry.
    async function conflict(f, action, label) {
      let seen, release, timer, firstSession, reads = 0;
      const entered = new Promise(resolve => { seen = resolve; }), gate = new Promise(resolve => { release = resolve; });
      const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error("Native source overlap not observed")), 30000); });
      void timeout.catch(() => {});
      const exec = AssistantReference.Query.prototype.exec;
      const hook = t.mock.method(AssistantReference.Query.prototype, "exec", async function (...args) {
        const session = this.getOptions().session, filter = this.getFilter();
        const row = await exec.apply(this, args);
        if (session && String(filter._id) === String(f.reference._id)) {
          firstSession ??= session;
          if (session === firstSession) {
            reads++;
            if (reads === 1) { assert.equal(session.inTransaction(), true); seen(); await Promise.race([gate, timeout]); }
          }
        }
        return row;
      });
      const completion = action().then(value => ({ value }), error => ({ error }));
      try {
        await Promise.race([entered, timeout]);
        await transaction(async session => {
          assert.notEqual(session, firstSession); assert.equal(session.inTransaction(), true); assert.equal(firstSession.inTransaction(), true);
          assert.equal((await disable(f, session)).modifiedCount, 1);
        });
        release(); const outcome = await completion; assert.ok(reads >= 2, "Conflicting source approval must be reread on native retry");
        t.diagnostic(`retrieval_native_overlap=${label};sessions=2;sourceReads=${reads}`); return outcome;
      } finally { clearTimeout(timer); release(); hook.mock.restore(); await completion; }
    }
    await t.test("owned question receipt is reused once and the native worker publishes only approved bound evidence", async () => {
      const f = await fixture("owned"); f.reuse = true;
      assert.equal((await f.process()).status, "completed"); assert.equal(f.embeddings, 1); assert.equal(f.chats, 1); assert.equal(await f.answers(), 1);
      const receipt = await AssistantEmbeddingBatch.findOne({ run: f.run._id }).lean();
      assert.equal(String(receipt.owner), String(f.owner)); assert.equal(receipt.accounting, "settled");
      assert.doesNotMatch(JSON.stringify(receipt), /Fictional general pet-care question/);
      assert.equal((await AssistantReference.findById(f.reference._id).lean()).retrievalFence, 2);
      await passed("owned_publication");
    });
    await t.test("foreign scope, guests and revoked users cannot create a query receipt", async () => {
      const f = await fixture("authority"), scope = await externalWorkScope(f.run.toObject(), config, "queued");
      await assert.rejects(f.query({ ...scope, ownerId: String(oid()) }), { code: "context_changed" });
      await db.collection("users").updateOne({ _id: f.owner }, { $set: { role: "guest" } });
      await assert.rejects(f.query(), { code: "access_denied" });
      await db.collection("users").updateOne({ _id: f.owner }, { $set: { role: "user", active: false } });
      await assert.rejects(f.query(), { code: "access_denied" });
      await db.collection("users").updateOne({ _id: f.owner }, { $set: { active: true } });
      assert.equal(await AssistantEmbeddingBatch.countDocuments({ run: f.run._id }), 0); assert.equal(f.embeddings, 0); await passed("authority");
    });
    await t.test("cached query reuse refuses a changed native chat context without another fake call", async () => {
      const f = await fixture("context"), { scope } = await f.query();
      await AssistantChat.updateOne({ _id: f.chatId }, { $inc: { contextVersion: 1 } });
      await assert.rejects(f.query(scope), { code: "context_changed" });
      assert.equal(f.embeddings, 1); assert.equal(f.chats, 0); assert.equal(await f.answers(), 0); await passed("cached_context");
    });
    await t.test("question changed during embedding cannot reserve chat work", async () => {
      const f = await fixture("embedding-drift");
      f.onEmbedding = () => AssistantMessage.updateOne({ _id: f.message._id }, { $set: { text: "Changed fictional question" } });
      await f.process(); const run = await f.saved();
      assert.equal(run.status, "failed"); assert.equal(run.publicCode, "context_changed"); assert.equal(run.attempts.length, 0);
      assert.equal(f.embeddings, 1); assert.equal(f.chats, 0); assert.equal(await f.answers(), 0); await passed("embedding_drift");
    });
    await t.test("question changed during chat generation withholds publication but settles known charges", async () => {
      const f = await fixture("answer-drift");
      f.onChat = () => AssistantMessage.updateOne({ _id: f.message._id }, { $set: { text: "Changed fictional question during answer" } });
      await f.process(); const run = await f.saved();
      assert.equal(run.status, "failed"); assert.equal(run.publicCode, "context_changed"); assert.equal(run.accounting, "settled");
      assert.equal(f.chats, 1); assert.equal(await f.answers(), 0); await passed("answer_drift");
    });
    await t.test("reference disabled during generation cannot publish its answer", async () => {
      const f = await fixture("disabled"); f.onChat = () => disable(f);
      await f.process(); const run = await f.saved();
      assert.equal(run.status, "failed"); assert.equal(run.publicCode, "reference_knowledge_changed"); assert.equal(run.accounting, "settled");
      assert.equal(await f.answers(), 0); await passed("disabled_after_dispatch");
    });
    await t.test("native preparation conflicts with disabling and rechecks before reserving chat", async () => {
      const f = await fixture("prepare-conflict"), scope = await externalWorkScope(f.run.toObject(), config, "queued");
      const outcome = await conflict(f, () => prepareRun(f.run._id, config, f.batch(scope)), "prepare");
      assert.equal(outcome.error?.code, "reference_knowledge_changed");
      assert.equal((await f.saved()).attempts.length, 0); assert.equal(await f.answers(), 0); await passed("prepare_conflict");
    });
    await t.test("native publication conflict rolls back staged settlement and retries without double charging", async () => {
      const f = await fixture("publish-conflict"), { scope } = await f.query();
      const prepared = await prepareRun(f.run._id, config, f.batch(scope)), reply = await f.generate(prepared.request);
      const outcome = await conflict(f, () => finishRun(prepared, reply, null, { currentConfig: config }), "publish");
      assert.equal(outcome.value?.status, "failed"); assert.equal(outcome.value.publicCode, "reference_knowledge_changed");
      assert.equal(outcome.value.accounting, "settled"); assert.equal(await f.answers(), 0); await passed("publication_conflict");
    });
    const receipts = await AssistantEmbeddingBatch.find({}).lean(), runs = await AssistantRun.find({}).lean();
    assert.equal(receipts.length, 6); assert.equal(fakeCalls, 10);
    assert.ok(receipts.every(row => row.accounting === "settled"));
    const charges = [...receipts, ...runs.filter(row => row.accounting === "settled")];
    for (const budget of await AssistantBudget.find({ _id: { $ne: "control" } }).lean()) {
      const applicable = charges.filter(row => row.reservation.budgetIds.includes(budget._id));
      assert.equal(budget.reserved, 0); assert.equal(budget.spent, applicable.reduce((sum, row) => sum + row.chargedMicroUsd, 0));
    }
  } finally {
    try {
      if (claimed) {
        t.diagnostic(`retrieval_native_insert_attempts=${guard?.insertAttempts() ?? 1}`);
        t.diagnostic(`retrieval_native_fake_calls=${fakeCalls}`);
        t.diagnostic(`retrieval_native_cleanup=${JSON.stringify(await cleanupRetrievalNativeDatabase(mongoose.connection, plan))}`);
      }
    } finally { await mongoose.disconnect(); }
  }
});
