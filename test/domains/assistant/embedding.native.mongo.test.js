import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import mongoose from "mongoose";
import { validateSharedMongoTarget, sharedMongoConfirmation } from "./fixtures/sharedMongo.js";
import { embeddingNativeOptIn, validateEmbeddingNativePlan, claimEmbeddingNativeDatabase, installEmbeddingNativeGuard,
  inspectEmbeddingNativeDatabase, cleanupEmbeddingNativeDatabase } from "./fixtures/embeddingNative.js";

test("isolated native embedding accounting, charge review and vector retention", {
  skip: process.env.ASSISTANT_EMBEDDING_NATIVE_TEST !== embeddingNativeOptIn && "Prepared only; exact setup/run/cleanup requires approval",
  timeout: 600000,
}, async t => {
  const plan = validateEmbeddingNativePlan(JSON.parse(await readFile(process.env.ASSISTANT_EMBEDDING_NATIVE_PLAN, "utf8")));
  const uri = validateSharedMongoTarget(process.env.ASSISTANT_EMBEDDING_NATIVE_URI, sharedMongoConfirmation);
  mongoose.set("autoCreate", false); mongoose.set("autoIndex", false); mongoose.set("bufferCommands", false);
  for (const key of ["OPENAI_API_KEY", "MONGO_URI", "REDIS_URL"]) assert.equal(process.env[key], undefined);
  const refuse = () => { throw Error("Provider/storage/push HTTP is outside this native test"); };
  t.mock.method(globalThis, "fetch", refuse);
  for (const module of [http, https]) for (const method of ["request", "get"]) t.mock.method(module, method, refuse);
  let claimed = false, guard, fakeCalls = 0;
  try {
    await mongoose.connect(uri.href, { dbName: plan.database, autoCreate: false, autoIndex: false, bufferCommands: false,
      retryWrites: false, serverSelectionTimeoutMS: 20000, connectTimeoutMS: 20000 });
    await claimEmbeddingNativeDatabase(mongoose.connection, plan); claimed = true;
    guard = installEmbeddingNativeGuard(t, mongoose.connection, plan); const db = mongoose.connection.db;
    const { AssistantAccount, AssistantBudget, AssistantChat, AssistantRun } = await import("../../../src/domains/assistant/shared/assistant.models.js");
    const { AssistantEmbeddingBatch } = await import("../../../src/domains/assistant/references/assistant.embedding-batch.model.js");
    const { createEmbeddingExecutor } = await import("../../../src/domains/assistant/references/assistant.embedding-executor.js");
    const { createEmbeddingReviewService } = await import("../../../src/domains/assistant/admin/assistant.embedding-review.js");
    const { initializeAssistantStore } = await import("../../../src/domains/assistant/shared/assistant.store.js");
    const { scrubExpiredQueryVectors } = await import("../../../src/domains/assistant/customer/assistant.query-embedding.js");
    const { AssistantProviderError } = await import("../../../src/domains/assistant/providers/providerContract.js");
    const { embeddingProfile } = await import("../../../src/domains/assistant/providers/openaiEmbeddings.js");
    const { testConfig } = await import("./fixtures/foundationPolicy.js");
    await db.createCollection("users"); await AssistantEmbeddingBatch.createCollection(); await AssistantEmbeddingBatch.createIndexes();
    await initializeAssistantStore();
    const oid = () => new mongoose.Types.ObjectId(), owner = oid(), runId = oid(), chatId = oid();
    const config = testConfig(), base = new Date("2026-10-25T12:00:00.000Z"); let clock = new Date(base);
    const actor = { _id: owner, role: "superAdmin", active: true, phoneVerified: true, account_status: "confirmed", deletedAt: null };
    await db.collection("users").insertOne({ ...actor, name: "Fictional embedding reviewer" });
    await AssistantChat.create({ _id: chatId, owner });
    await AssistantRun.create({ _id: runId, owner, chat: chatId, purpose: "customer", key: `${plan.run}/untouched-chat`, hash: "fictional-chat",
      status: "queued", phase: "resolve", contextVersion: 0, input: "Fictional chat; never dispatch this run", userSequence: 1, config });
    await AssistantAccount.create({ owner, blocked: true, activeRun: runId });
    const originalChat = await AssistantChat.findById(chatId).lean(), originalRun = await AssistantRun.findById(runId).lean();
    const originalAccount = await AssistantAccount.findOne({ owner }).lean();
    const usage = { inputTokens: 100, totalTokens: 100, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 };
    const vector = () => Array.from({ length: 1536 }, (_, index) => index ? 0 : 0.5);
    const price = { version: "fictional-native-price", model: embeddingProfile.model, dimensions: 1536, inputMicroUsdPerMillion: 20000,
      validFrom: "2000-01-01T00:00:00Z", validUntil: "2100-01-01T00:00:00Z" };
    const hash = label => createHash("sha256").update(plan.run + label).digest("hex");
    const executor = createEmbeddingExecutor({ now: () => new Date(clock) });
    const review = createEmbeddingReviewService({ now: () => new Date(clock) });
    const close = (id, reason = "Fictional native review of unconfirmed usage") => review.reconcile(owner, String(id), { resolution: "charge_reserved", reason });
    const args = (label, { kind = "customer_query", unknown = false, pending } = {}) => ({ key: hash(label),
      identity: kind === "customer_query" ? { kind, owner, run: runId, queryContextHash: hash(label + "/context"),
        vectorsExpireAt: new Date(base.getTime() + (label === "single" ? 1 : 86400000)) }
        : { kind, owner, reference: oid(), sourceHash: hash(label + "/source"), manifestHash: hash(label + "/manifest"), start: 0, passageIds: [hash(label + "/passage")] },
      input: ["Fictional native excerpt or question"], shared: config, price, timeoutMs: 1000, authorize: async () => {},
      adapter: { ...embeddingProfile, async embed() {
        fakeCalls++; if (pending) { pending.started(); await pending.promise; }
        if (unknown) throw new AssistantProviderError("timeout", { chargeExposure: "unknown" });
        return { vectors: [vector()], usage, providerRequestId: "fictional-native-provider-id" } } } });
    const passed = async name => {
      const snapshot = await inspectEmbeddingNativeDatabase(mongoose.connection, plan);
      for (const name of ["assistantmessages", "assistantmemories", "assistantdietarywarnings", "assistantevents", "notificationoutboxes"])
        assert.equal(await db.collection(name).countDocuments({}), 0);
      assert.deepEqual(await AssistantChat.findById(chatId).lean(), originalChat);
      assert.deepEqual(await AssistantAccount.findOne({ owner }).lean(), originalAccount);
      assert.deepEqual(await AssistantRun.findById(runId).lean(), originalRun);
      t.diagnostic(`embedding_native_case=${name}:passed;documents=${snapshot.documents};insertAttempts=${guard.insertAttempts()}`);
    };
    const pendingRequest = async label => {
      let started, release; const began = new Promise(resolve => { started = resolve; }), promise = new Promise(resolve => { release = resolve; });
      const input = args(label, { pending: { started, promise } });
      const completion = executor(input).then(value => ({ value }), error => ({ error })); await began;
      const row = await AssistantEmbeddingBatch.findOne({ key: input.key }).lean();
      clock = new Date(row.dispatchDeadline.getTime() + 1);
      return { row, release, completion, input };
    };
    await t.test("concurrent admissions use the actual unique key and reserve/settle exactly once", async () => {
      const input = args("single"), before = fakeCalls, results = await Promise.all([executor(input), executor(input)]);
      const stored = await AssistantEmbeddingBatch.findOne({ key: input.key }).lean();
      assert.equal(fakeCalls, before + 1); assert.equal(stored.accounting, "settled"); assert.equal(stored.status, "completed");
      assert.equal(await AssistantEmbeddingBatch.countDocuments({ key: input.key }), 1);
      assert.equal(String(results[0]._id), String(results[1]._id));
      const budgets = await AssistantBudget.find({ _id: { $ne: "control" } }).lean(); assert.equal(budgets.length, 2);
      for (const row of budgets) { assert.equal(row.reserved, 0); assert.equal(row.spent, stored.chargedMicroUsd); }
      await passed("one_admission");
    });
    await t.test("unknown reference usage stays held, cannot replay and requires current SuperAdmin authority", async () => {
      const input = args("unknown", { kind: "reference", unknown: true }), row = await executor(input), before = fakeCalls;
      assert.equal(row.status, "uncertain"); assert.equal(row.accounting, "reserved"); await executor(input); assert.equal(fakeCalls, before);
      assert.equal((await review.get(owner, String(row._id))).canReconcile, true);
      await db.collection("users").updateOne({ _id: owner }, { $set: { role: "admin" } });
      await assert.rejects(close(row._id), { code: "access_denied" });
      assert.equal((await AssistantEmbeddingBatch.findById(row._id).lean()).accounting, "reserved");
      await db.collection("users").updateOne({ _id: owner }, { $set: { role: "superAdmin" } });
      const closed = await close(row._id); assert.equal(closed.batch.accounting, "charged_reservation");
      assert.equal(closed.batch.kind, "reference"); assert.equal(closed.batch.reconciliation.actorId, String(owner)); await passed("unknown_authority");
    });
    await t.test("concurrent manual reviews charge once and retain the first audit", async () => {
      const row = await executor(args("manual-retries", { unknown: true }));
      const replies = await Promise.all(["Contender A", "Contender B", "Contender C"].map(reason => close(row._id, reason)));
      assert.equal(replies.filter(reply => reply.duplicate === false).length, 1);
      const winner = replies.find(reply => reply.duplicate === false).batch.reconciliation;
      for (const reply of replies) assert.deepEqual(reply.batch.reconciliation, winner);
      const retry = await close(row._id, "A later retry must never replace the first decision");
      assert.equal(retry.duplicate, true); assert.deepEqual(retry.batch.reconciliation, winner);
      assert.deepEqual((await review.get(owner, String(row._id))).reconciliation, winner); await passed("manual_retries");
    });
    await t.test("a staged receipt-save failure rolls back both real ledger updates and the audit", async () => {
      const row = await executor(args("rollback", { kind: "reference", unknown: true }));
      const before = await AssistantBudget.find({}).sort({ _id: 1 }).lean(), save = AssistantEmbeddingBatch.prototype.save;
      const failure = t.mock.method(AssistantEmbeddingBatch.prototype, "save", async function (...arguments_) {
        const result = await save.apply(this, arguments_);
        if (String(this._id) === String(row._id) && this.reconciliation) throw Error("Fictional staged-receipt interruption"); return result;
      });
      try { await assert.rejects(close(row._id), /Fictional staged-receipt interruption/); } finally { failure.mock.restore(); }
      assert.deepEqual(await AssistantBudget.find({}).sort({ _id: 1 }).lean(), before);
      const retained = await AssistantEmbeddingBatch.findById(row._id).lean(); assert.equal(retained.accounting, "reserved"); assert.equal(retained.reconciliation, undefined);
      assert.equal((await close(row._id)).duplicate, false); await passed("real_rollback");
    });
    await t.test("manual closure wins over late completion and the original request never redispatches", async () => {
      const pending = await pendingRequest("manual-first");
      try { assert.equal((await close(pending.row._id)).duplicate, false); } finally { pending.release(); }
      assert.equal((await pending.completion).error.code, "embedding_batch_changed");
      const before = fakeCalls, replay = await executor(pending.input); assert.equal(replay.accounting, "charged_reservation");
      assert.equal(replay.vectors, undefined); assert.equal(fakeCalls, before); await passed("manual_first");
    });
    await t.test("normal completion wins first and review cannot charge again", async () => {
      const row = await executor(args("worker-first", { kind: "reference" })), before = await AssistantBudget.find({}).sort({ _id: 1 }).lean();
      assert.equal(row.accounting, "settled"); await assert.rejects(close(row._id), { code: "embedding_not_reconcilable" });
      assert.deepEqual(await AssistantBudget.find({}).sort({ _id: 1 }).lean(), before); await passed("worker_first");
    });
    await t.test("a real completion/review race has one accounting winner", async () => {
      const pending = await pendingRequest("native-race");
      const sessions = new Map(), reads = new Map(), originalExec = AssistantEmbeddingBatch.Query.prototype.exec;
      let release; const overlap = new Promise(resolve => { release = resolve; });
      let timer; const bound = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error("Native transaction overlap was not observed")), 30000); });
      void bound.catch(() => {}); // Observe expiry even if an earlier database read has not reached the barrier.
      const hook = t.mock.method(AssistantEmbeddingBatch.Query.prototype, "exec", async function (...arguments_) {
        const filter = this.getFilter(), session = this.getOptions().session;
        const side = filter.key === pending.input.key && filter.status === "dispatching" ? "worker"
          : String(filter._id) === String(pending.row._id) ? "manual" : null;
        if (side && session) reads.set(side, (reads.get(side) ?? 0) + 1);
        const row = await originalExec.apply(this, arguments_);
        if (side && session && row?.accounting === "reserved" && !sessions.has(side)) {
          assert.equal(session.inTransaction(), true); sessions.set(side, session);
          if (sessions.size === 2) { assert.notEqual(sessions.get("worker"), sessions.get("manual")); release(); }
          await Promise.race([overlap, bound]);
        }
        return row;
      });
      let closed, completed;
      try {
        const manual = close(pending.row._id).then(value => ({ value }), error => ({ error })); pending.release();
        [closed, completed] = await Promise.all([manual, pending.completion]);
        assert.equal(sessions.size, 2); assert.ok([...reads.values()].reduce((sum, count) => sum + count, 0) >= 3, "A conflicting transaction must reread on retry");
      } finally { clearTimeout(timer); release(); pending.release(); hook.mock.restore(); }
      const row = await AssistantEmbeddingBatch.findById(pending.row._id).lean();
      if (row.accounting === "charged_reservation") { assert.equal(closed.value.duplicate, false); assert.equal(completed.error.code, "embedding_batch_changed"); }
      else { assert.equal(row.accounting, "settled"); assert.equal(closed.error.code, "embedding_not_reconcilable"); assert.equal(completed.value.status, "completed"); }
      t.diagnostic(`embedding_native_race_winner=${row.accounting};overlapSessions=${sessions.size};receiptReads=${JSON.stringify(Object.fromEntries(reads))}`);
      await passed("native_race");
    });
    await t.test("expiry strips only due query vectors while preserving native financial evidence", async () => {
      const before = await AssistantEmbeddingBatch.find({}).sort({ _id: 1 }).lean();
      const due = before.filter(row => row.kind === "customer_query" && row.vectors && row.vectorsExpireAt <= clock);
      assert.equal(due.length, 1); assert.equal((await scrubExpiredQueryVectors(clock)).modifiedCount, 1);
      const after = await AssistantEmbeddingBatch.find({}).sort({ _id: 1 }).lean();
      for (let index = 0; index < before.length; index++) {
        const expected = { ...before[index] }; delete expected.updatedAt; const actual = { ...after[index] }; delete actual.updatedAt;
        if (due.some(row => String(row._id) === String(expected._id))) delete expected.vectors;
        assert.deepEqual(actual, expected);
      }
      assert.equal((await scrubExpiredQueryVectors(clock)).modifiedCount, 0);
      const rows = await AssistantEmbeddingBatch.find({}).lean(), budgets = await AssistantBudget.find({ _id: { $ne: "control" } }).lean();
      const expectedSpent = rows.reduce((sum, row) => sum + row.chargedMicroUsd, 0);
      assert.equal(rows.length, 7); assert.equal(fakeCalls, 7);
      for (const row of budgets) { assert.equal(row.reserved, 0); assert.equal(row.spent, expectedSpent); }
      assert.equal((await review.list(owner, {})).batches.length, 0); await passed("vector_retention");
    });
  } finally {
    try {
      if (claimed) {
        t.diagnostic(`embedding_native_insert_attempts=${guard?.insertAttempts() ?? 1}`);
        t.diagnostic(`embedding_native_fake_calls=${fakeCalls}`);
        t.diagnostic(`embedding_native_cleanup=${JSON.stringify(await cleanupEmbeddingNativeDatabase(mongoose.connection, plan))}`);
      }
    } finally { await mongoose.disconnect(); }
  }
});
