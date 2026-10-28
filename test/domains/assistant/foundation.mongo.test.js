import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { testConfig, knownUsage, structuredReply } from "./fixtures/foundationPolicy.js";
import { assistantTestDbPattern, createAssistantTestDbName, validateAssistantMongoTarget } from "./fixtures/mongoTarget.js";
import { cleanupAssistantTestCollections, cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";
import { createAssistantRouter } from "../../../src/domains/assistant/assistant.routes.js";
import { createOpenAIResponsesAdapter } from "../../../src/domains/assistant/providers/openaiResponses.js";
import { initializeAssistantStore, reserveCost, settleCost, transaction } from "../../../src/domains/assistant/shared/assistant.store.js";
import { AssistantAccount, AssistantBudget, AssistantChat, AssistantMemory, AssistantMessage, AssistantRun } from "../../../src/domains/assistant/shared/assistant.models.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { PetModel } from "../../../src/domains/pet/pet.model.js";
import * as service from "../../../src/domains/assistant/customer/assistant.service.js";
import { failPreparation, finishRun, knowledgeForRun, prepareRun, processAssistantRun, recoverAssistantRuns } from "../../../src/domains/assistant/customer/assistant.worker.service.js";

const baseUri = process.env.ASSISTANT_TEST_MONGO_URI;
const outcome = (data = structuredReply()) => ({ finishReason: "completed", serviceTier: "default", toolCalls: [], structured: data, usage: knownUsage,
  providerRequestId: "local-mock-request", latencyMs: 1 });

test("isolated real Mongo transactions, HTTP, worker recovery and privacy", { skip: !baseUri && "Set an explicitly authorized ASSISTANT_TEST_MONGO_URI; never MONGO_URI" }, async (t) => {
  // This explicit safety gate never loads .env or the application's database URI.
  const uri = validateAssistantMongoTarget(baseUri, process.env.ASSISTANT_TEST_ATLAS_HOST);
  const dbName = createAssistantTestDbName();
  assert.ok(Buffer.byteLength(dbName) <= 38, "Generated assistant test database name exceeds the Atlas limit");
  assert.match(dbName, assistantTestDbPattern);
  uri.pathname = `/${dbName}`;
  let connected = false;
  const ownedServers = new Set();
  let restoreEnvironment = () => {};
  t.after(() => cleanupAssistantTestResources({ servers: ownedServers,
    cleanupCollections: () => connected ? cleanupAssistantTestCollections(mongoose.connection, dbName) : undefined,
    disconnect: () => mongoose.disconnect(), restoreEnvironment: () => restoreEnvironment(),
  }));
  await mongoose.connect(uri.href, { serverSelectionTimeoutMS: 3000 });
  connected = true;
  t.diagnostic(`assistant_test_database=${mongoose.connection.name}`);
  await initializeAssistantStore();
  const config = testConfig({ rateMax: 100 });
  const makeUser = async (role = "user") => {
    const _id = new mongoose.Types.ObjectId();
    await UserModel.collection.insertOne({ _id, name: "local test", active: true, phoneVerified: true, role, account_status: "confirmed", deletedAt: null });
    return _id;
  };
  const owner = await makeUser(); const other = await makeUser(); const admin = await makeUser("superAdmin");
  const [milo, roy] = await PetModel.create([{ petOwner: owner, name: "Milo", type: "cat" }, { petOwner: owner, name: "Roy", type: "dog" }]);
  const foreign = await PetModel.create({ petOwner: other, name: "Private pet", type: "cat" });
  const priorSecret = process.env.JWT_ACCESS_SECRET; process.env.JWT_ACCESS_SECRET = "isolated-assistant-test-only";
  restoreEnvironment = () => { if (priorSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = priorSecret; };
  const app = express(); app.use(express.json()); app.use("/api/v1/assistant", createAssistantRouter({ getConfig: () => config }));
  const server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  ownedServers.add(server);
  const url = `http://127.0.0.1:${server.address().port}/api/v1/assistant`;
  const headers = (user, key) => ({ Authorization: `Bearer ${jwt.sign({ userId: String(user) }, process.env.JWT_ACCESS_SECRET)}`,
    "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) });
  let firstRun;
  await t.test("HTTP ownership, concurrent duplicate admission and one account lock", async () => {
    const denied = await fetch(`${url}/messages`, { method: "POST", headers: headers(owner, "foreign-pet-1"),
      body: JSON.stringify({ text: "help", subjectId: `pet:${foreign._id}` }) });
    assert.equal(denied.status, 404);
    const responses = await Promise.all(Array.from({ length: 6 }, () => fetch(`${url}/messages`, { method: "POST", headers: headers(owner, "same-message-1"),
      body: JSON.stringify({ text: "What about Milo?", subjectId: `pet:${milo._id}` }) })));
    assert.ok(responses.every((res) => [200, 202].includes(res.status)), responses.map((res) => res.status).join(","));
    const bodies = await Promise.all(responses.map((res) => res.json()));
    assert.equal(new Set(bodies.map((body) => body.data.run.id)).size, 1);
    firstRun = bodies[0].data.run.id;
    assert.equal((await AssistantAccount.findOne({ owner })).dayMessages, 1);
    assert.equal(await AssistantMessage.countDocuments({ owner, role: "user" }), 1);
    assert.equal((await fetch(`${url}/runs/${firstRun}`, { headers: headers(other) })).status, 404);
    assert.equal((await fetch(`${url}/messages`, { method: "POST", headers: headers(owner, "same-message-1"), body: JSON.stringify({ text: "changed" }) })).status, 409);
    await assert.rejects(service.submitMessage(owner, { text: "new" }, "other-message-1", config), { code: "active_request" });
  });

  await t.test("two workers dispatch exactly once through real local provider HTTP and settle once", async () => {
    const received = [];
    const mock = http.createServer(async (req, res) => {
      let body = ""; for await (const chunk of req) body += chunk;
      received.push(JSON.parse(body));
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model: "gpt-6-luna", status: "completed", service_tier: "default",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(structuredReply()) }] }],
        usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 5 } } }));
    });
    ownedServers.add(mock);
    await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
    try {
      const options = { getConfig: () => config, retrieveKnowledge: async (scope) => {
        assert.equal(scope.ownerId, String(owner)); assert.equal(scope.subjectId, `pet:${milo._id}`); assert.equal(scope.species, "cat");
        return [{ sourceId: "test-reviewed-care", version: "v1", title: "Test care", locator: "page 1", excerpt: "General care education.", reviewed: true, species: ["cat"] }];
      }, adapterFactory: () => createOpenAIResponsesAdapter({ endpoint: `http://127.0.0.1:${mock.address().port}/v1/responses` }) };
      await Promise.all([processAssistantRun(firstRun, options), processAssistantRun(firstRun, options)]);
      assert.equal(received.length, 1);
      assert.equal(received[0].store, false);
      assert.match(received[0].instructions, /"sourceId":"test-reviewed-care"/);
      assert.doesNotMatch(received[0].instructions, /Private pet/);
      assert.equal((await AssistantRun.findById(firstRun)).status, "completed");
      assert.equal((await AssistantAccount.findOne({ owner })).activeRun, null);
      assert.equal(await AssistantMessage.countDocuments({ run: firstRun, role: "assistant" }), 1);
      const global = await AssistantBudget.findOne({ _id: /^global:/ });
      assert.equal(global.reserved, 0); assert.ok(global.spent > 0);
      await processAssistantRun(firstRun, options);
      assert.equal(received.length, 1);
    } finally { mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve)); }
  });

  await t.test("account/global reservation is atomic under contention and settles original periods after rollover", async () => {
    const when = new Date("2040-01-31T20:00:00Z");
    const small = { ...config, monthlyBudgetMicroUsd: 3_000_000, dailyBudgetMicroUsd: 3_000_000 };
    const first = await makeUser(); const second = await makeUser();
    const attempts = await Promise.allSettled([first, second].map((id) => transaction((session) => reserveCost(id, small, session, when))));
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
    const reservation = attempts.find((item) => item.status === "fulfilled").value;
    const ledger = await AssistantBudget.findById(reservation.budgetIds[0]);
    assert.equal(ledger.reserved, reservation.amount);
    assert.equal(await AssistantBudget.countDocuments({ _id: /^user:.*:2040-01/ }), 1, "losing transaction left no user reservation");
    await transaction((session) => settleCost({ reservation, accounting: "reserved", config: small }, knownUsage, session));
    const settled = await AssistantBudget.findById(reservation.budgetIds[0]);
    assert.equal(settled.reserved, 0); assert.ok(settled.spent > 0);
    assert.equal(await AssistantBudget.countDocuments({ _id: /^global:2040-02/ }), 0);
  });

  await t.test("memory correction/forgetting fences active output, prevents resurrection and separates pet contexts", async () => {
    const subject = `pet:${milo._id}`;
    const memory = await service.saveMemory(owner, { subjectId: subject, key: "food_preference", value: "Only duck" }, config);
    const submitted = await service.submitMessage(owner, { text: "I prefer fish", subjectId: subject }, "forget-in-flight-1", config);
    const prepared = await prepareRun(submitted.run.id, config);
    await service.forgetMemory(owner, memory.id, config);
    const completed = await finishRun(prepared, outcome(structuredReply({ memoryKey: "food_preference", memoryValue: "I prefer fish", sourceQuote: "I prefer fish", memorySubjectId: subject })), null, { currentConfig: config });
    assert.equal(completed.status, "failed"); assert.equal(completed.publicCode, "context_changed");
    const forgotten = await AssistantMemory.findById(memory.id).lean();
    assert.equal(forgotten.state, "forgotten"); assert.equal(forgotten.value, undefined); assert.equal(forgotten.expiresAt, undefined);
    assert.equal(await AssistantMessage.countDocuments({ run: prepared.run._id, role: "assistant" }), 0);
    const switched = await service.changeSubject(owner, { subjectId: `pet:${roy._id}` }, config);
    const next = await service.submitMessage(owner, { text: "Hello Roy" }, "other-pet-context-1", config);
    const second = await prepareRun(next.run.id, config);
    assert.doesNotMatch(JSON.stringify(second.request), /Only duck|I prefer fish/);
    await finishRun(second, outcome(), null, { currentConfig: config });
    assert.equal(switched.id, (await service.getChat(owner, config)).id, "pet switch retained continuous chat");
    const unsaved = await service.changeSubject(owner, { name: "Visitor", species: "cat" }, config, true);
    assert.match(unsaved.activeSubjectId, /^chat:/);
  });

  await t.test("crash/timeout exposure survives restart with no retry and manual review charges reservation exactly once", async () => {
    const submitted = await service.submitMessage(other, { text: "Hello" }, "crash-recovery-1", config);
    const prepared = await prepareRun(submitted.run.id, config);
    await recoverAssistantRuns(config, new Date(prepared.run.dispatchDeadline.getTime() + 1));
    assert.equal((await AssistantRun.findById(submitted.run.id)).status, "uncertain");
    assert.ok((await AssistantAccount.findOne({ owner: other })).activeRun);
    let calls = 0;
    await processAssistantRun(submitted.run.id, { getConfig: () => config, adapterFactory: () => ({ generate() { calls += 1; } }) });
    assert.equal(calls, 0);
    const before = await AssistantBudget.findById(prepared.run.reservation.budgetIds[0]);
    await Promise.all([1, 2].map(() => service.reconcileRun(admin, submitted.run.id, { resolution: "charge_reserved", reason: "Conservatively close unknown charge" }, config)));
    const after = await AssistantBudget.findById(prepared.run.reservation.budgetIds[0]);
    assert.equal(after.spent - before.spent, prepared.run.reservation.amount);
    assert.equal((await AssistantAccount.findOne({ owner: other })).activeRun, null);
    await finishRun(prepared, outcome(), null, { currentConfig: config });
    assert.equal((await AssistantBudget.findById(after._id)).spent, after.spent, "late result did not settle again");
  });

  await t.test("normal Pet edits fence prepared output and retrieved evidence without a chat version update", async () => {
    const subjectId = `pet:${milo._id}`;
    const submitted = await service.submitMessage(owner, { text: "Care tips", subjectId }, "profile-edit-output-1", config);
    const prepared = await prepareRun(submitted.run.id, config);
    const beforeVersion = (await AssistantChat.findOne({ owner })).contextVersion;
    await PetModel.updateOne({ _id: milo._id }, { $set: { breed: "Updated breed" } });
    assert.equal((await AssistantChat.findOne({ owner })).contextVersion, beforeVersion);
    const finished = await finishRun(prepared, outcome(), null, { currentConfig: config });
    assert.equal(finished.status, "failed"); assert.equal(finished.publicCode, "context_changed");
    assert.equal(await AssistantMessage.countDocuments({ run: prepared.run._id, role: "assistant" }), 0);
    const next = await service.submitMessage(owner, { text: "General care", subjectId }, "profile-edit-retrieval-1", config);
    const batch = await knowledgeForRun(next.run.id, config, async () => [{ sourceId: "reviewed-general", version: "v1", title: "General guide",
      locator: "section 1", excerpt: "General education.", reviewed: true, species: ["*"] }]);
    await PetModel.updateOne({ _id: milo._id }, { $set: { chronic_conditions: ["updated-condition"] } });
    await assert.rejects(prepareRun(next.run.id, config, batch), { code: "context_changed" });
    assert.equal((await AssistantRun.findById(next.run.id)).accounting, "none", "stale retrieval never reserved paid work");
    const fresh = await prepareRun(next.run.id, config);
    await finishRun(fresh, outcome(), null, { currentConfig: config });
  });

  await t.test("block/revocation/config changes stop queued work before adapter creation; logical retention hides expired history", async () => {
    const third = await makeUser();
    const submitted = await service.submitMessage(third, { text: "Hello" }, "block-before-dispatch", config);
    await service.restrictAccount(admin, String(third), { blocked: true, reason: "Manual test" }, config);
    await assert.rejects(service.submitMessage(third, { text: "Hello" }, "block-before-dispatch", config), { code: "ai_restricted" });
    const duplicateVisible = await service.submitMessage(third, { text: "Hello" }, "block-before-dispatch", { ...config, blockedHistoryAllowed: true });
    assert.equal(duplicateVisible.duplicate, true, "visible existing run remains a read, never new paid work");
    let calls = 0;
    await processAssistantRun(submitted.run.id, { getConfig: () => config, adapterFactory: () => { calls += 1; throw new Error("must not dispatch"); } });
    assert.equal(calls, 0);
    assert.equal((await AssistantRun.findById(submitted.run.id)).accounting, "none");
    await assert.rejects(service.getHistory(third, {}, config), { code: "ai_restricted" });
    await service.restrictAccount(admin, String(third), { blocked: false, reason: "Restore test" }, config);
    await AssistantMessage.updateMany({ owner: third }, { $set: { expiresAt: new Date(0) } });
    assert.equal((await service.getHistory(third, {}, config)).messages.length, 0);
    const again = await service.submitMessage(third, { text: "Hello again" }, "config-before-dispatch", config);
    await processAssistantRun(again.run.id, { getConfig: () => ({ ...config, signature: "changed" }), adapterFactory: () => { calls += 1; } });
    assert.equal(calls, 0);
    assert.equal((await AssistantRun.findById(again.run.id)).status, "failed");
  });

  await t.test("natural switch keeps one run/allowance, discards old draft/memory, fences stale workers and resumes only the answer attempt", async () => {
    await service.changeSubject(owner, { subjectId: `pet:${milo._id}` }, config);
    await PetModel.updateOne({ _id: roy._id }, { $set: { breed: "Roy-only-answer-context" } });
    const beforeMessages = (await AssistantAccount.findOne({ owner })).dayMessages;
    const input = "طب روي؟";
    const submitted = await service.submitMessage(owner, { text: input }, "natural-switch-two-attempts", config);
    const stale = await AssistantRun.findById(submitted.run.id).lean();
    const staleBatch = await knowledgeForRun(submitted.run.id, config);
    const first = await prepareRun(submitted.run.id, config);
    const resolved = await finishRun(first, outcome(structuredReply({ reply: "Discard old-pet draft", subjectAction: "select", resolvedSubjectId: `pet:${roy._id}`,
      memoryKey: "food_preference", memoryValue: input, sourceQuote: input, memorySubjectId: `pet:${milo._id}` })), null, { currentConfig: config });
    assert.equal(resolved.status, "queued"); assert.equal(resolved.phase, "answer"); assert.equal(resolved.attempts.length, 1);
    assert.equal(resolved.attempts[0].accounting, "settled");
    assert.equal(await AssistantMessage.countDocuments({ run: first.run._id, role: "assistant" }), 0);
    const source = await AssistantMessage.findOne({ run: first.run._id, role: "user" });
    assert.equal(await AssistantMemory.countDocuments({ sourceMessage: source._id }), 0);
    assert.equal(await prepareRun(submitted.run.id, config, staleBatch), null);
    await failPreparation(submitted.run.id, new Error("stale retrieval failure"), stale);
    assert.equal((await AssistantRun.findById(submitted.run.id)).status, "queued");
    assert.equal(String((await AssistantAccount.findOne({ owner })).activeRun), submitted.run.id);
    let calls = 0;
    await processAssistantRun(submitted.run.id, { getConfig: () => config, adapterFactory: () => ({ async generate(request) {
      calls += 1; assert.match(request.instructions, /Roy-only-answer-context/); assert.doesNotMatch(request.instructions, /updated-condition/);
      return outcome(structuredReply({ reply: "Answer with Roy's context." }));
    } }) });
    const completed = await AssistantRun.findById(submitted.run.id);
    assert.equal(calls, 1); assert.equal(completed.status, "completed"); assert.equal(completed.attempts.length, 2);
    assert.ok(completed.attempts.every((attempt) => attempt.accounting === "settled" && attempt.chargedMicroUsd > 0));
    assert.equal((await AssistantAccount.findOne({ owner })).dayMessages, beforeMessages + 1);
    assert.equal((await service.submitMessage(owner, { text: input }, "natural-switch-two-attempts", config)).duplicate, true);
    assert.equal(await finishRun(first, outcome(), null, { currentConfig: config }), null, "late first attempt cannot settle/publish again");
  });

  await t.test("anonymous identity is created once and refined on the same ID from owned latest-message quotes", async () => {
    const guestOwner = await makeUser();
    const first = await service.submitMessage(guestOwner, { text: "I found an animal" }, "anonymous-pet-create", config);
    let calls = 0;
    await processAssistantRun(first.run.id, { getConfig: () => config, adapterFactory: () => ({ async generate(request) {
      calls += 1;
      assert.match(request.instructions, new RegExp(`"resolutionPhase":"${calls === 1 ? "resolve" : "answer"}"`));
      return outcome(structuredReply(calls === 1 ? { subjectAction: "create_unsaved", reply: "Discard this draft" } : { reply: "What can you tell me about this animal?" }));
    } }) });
    const resolved = await AssistantRun.findById(first.run.id);
    assert.equal(calls, 2); assert.equal(resolved.status, "completed"); assert.equal(resolved.attempts.length, 2);
    const id = resolved.subjectId;
    assert.match(id, /^chat:/);
    assert.equal(await AssistantMessage.countDocuments({ run: first.run.id, role: "assistant" }), 1);
    const before = await AssistantChat.findOne({ owner: guestOwner });
    assert.equal(before.subjects.length, 1); assert.equal(before.subjects[0].name, null); assert.equal(before.subjects[0].species, null);
    const second = await service.submitMessage(guestOwner, { text: "اسمه زيزو ونوعه قطة" }, "anonymous-pet-refine", config);
    const next = await prepareRun(second.run.id, config);
    const refined = await finishRun(next, outcome(structuredReply({ subjectAction: "update_unsaved", resolvedSubjectId: id,
      subjectName: "زيزو", subjectNameQuote: "اسمه زيزو", subjectSpecies: "قطة", subjectSpeciesQuote: "نوعه قطة" })), null, { currentConfig: config });
    assert.equal(refined.subjectId, id);
    await processAssistantRun(second.run.id, { getConfig: () => config, adapterFactory: () => ({ async generate() { return outcome(); } }) });
    const after = await AssistantChat.findOne({ owner: guestOwner });
    assert.equal(after.subjects.length, 1); assert.equal(after.subjects[0].id, id);
    assert.equal(after.subjects[0].name, "زيزو"); assert.equal(after.subjects[0].species, "قطة");
    assert.ok(after.subjects[0].nameSourceMessage); assert.equal(await PetModel.countDocuments({ petOwner: guestOwner }), 0);
  });

  await t.test("an explicit message selection after clarification remains selected on the next ordinary message", async () => {
    const isolatedOwner = await makeUser();
    const pet = await service.changeSubject(isolatedOwner, { name: "Visitor", species: "cat" }, config, true);
    const id = pet.activeSubjectId;
    const first = await service.submitMessage(isolatedOwner, { text: "Which one?" }, "clarify-before-override", config);
    await processAssistantRun(first.run.id, { getConfig: () => config, adapterFactory: () => ({ async generate() { return outcome(structuredReply({ subjectAction: "clarify" })); } }) });
    const waiting = await AssistantChat.findOne({ owner: isolatedOwner });
    assert.equal(waiting.awaitingSubject, true);
    const explicit = await service.submitMessage(isolatedOwner, { text: "This pet", subjectId: id }, "explicit-after-clarify", config);
    const selected = await AssistantChat.findOne({ owner: isolatedOwner });
    assert.equal(selected.awaitingSubject, false); assert.ok(selected.contextVersion > waiting.contextVersion);
    await processAssistantRun(explicit.run.id, { getConfig: () => config, adapterFactory: () => ({ async generate() { return outcome(); } }) });
    const next = await service.submitMessage(isolatedOwner, { text: "And feeding?" }, "ordinary-after-override", config);
    assert.equal(next.run.subjectId, id);
    await processAssistantRun(next.run.id, { getConfig: () => config, adapterFactory: () => ({ async generate() { return outcome(); } }) });
  });

  await t.test("unknown second charge preserves first settlement and never retries; budget denial before second call preserves first charge", async () => {
    for (const kind of ["unknown", "budget"]) {
      const isolatedOwner = await makeUser();
      const submitted = await service.submitMessage(isolatedOwner, { text: "An unsaved pet" }, `second-attempt-${kind}`, config);
      const prepared = await prepareRun(submitted.run.id, config);
      const queued = await finishRun(prepared, outcome(structuredReply({ subjectAction: "create_unsaved" })), null, { currentConfig: config });
      const firstCharge = queued.attempts[0].chargedMicroUsd;
      if (kind === "budget") await AssistantBudget.updateOne({ _id: queued.attempts[0].reservation.budgetIds[1] }, { $set: { spent: config.dailyBudgetMicroUsd } });
      let calls = 0;
      const options = { getConfig: () => config, adapterFactory: () => ({ async generate() { calls += 1; throw Object.assign(new Error("local uncertain charge"), { code: "timeout" }); } }) };
      await processAssistantRun(submitted.run.id, options);
      const current = await AssistantRun.findById(submitted.run.id);
      assert.equal(current.attempts[0].chargedMicroUsd, firstCharge); assert.equal(current.attempts[0].accounting, "settled");
      if (kind === "unknown") {
        assert.equal(current.status, "uncertain"); assert.equal(current.attempts[1].accounting, "reserved"); assert.equal(calls, 1);
        await processAssistantRun(submitted.run.id, options); assert.equal(calls, 1);
        await service.reconcileRun(admin, submitted.run.id, { resolution: "charge_reserved", reason: "Conservative local test closure" }, config);
        assert.equal((await AssistantRun.findById(submitted.run.id)).attempts[0].chargedMicroUsd, firstCharge);
      } else { assert.equal(current.status, "failed"); assert.equal(current.publicCode, "daily_spending_limit"); assert.equal(current.attempts.length, 1); assert.equal(calls, 0); }
    }
  });
});
