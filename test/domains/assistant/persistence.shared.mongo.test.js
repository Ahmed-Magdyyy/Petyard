import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import mongoose from "mongoose";
import { createSharedMongoManifest, validateSharedMongoTarget, sharedMongoRecords } from "./fixtures/sharedMongo.js";
import { cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";

test("shared test database persistence, privacy, uniqueness, rollback and daily-limit contention", {
  skip: !process.env.ASSISTANT_SHARED_PERSISTENCE_TEST && "Prepared only; requires independent persistence opt-in",
}, async (t) => {
  assert.equal(process.env.ASSISTANT_SHARED_PERSISTENCE_TEST, "owned-records-only");
  const uri = validateSharedMongoTarget(process.env.ASSISTANT_SHARED_TEST_MONGO_URI, process.env.ASSISTANT_SHARED_TEST_CONFIRM);
  mongoose.set("autoCreate", false); mongoose.set("autoIndex", false); mongoose.set("bufferCommands", false);
  const { persistenceSeed } = await import("./fixtures/persistenceSeed.js");
  const { AssistantAccount, AssistantAdminChat, AssistantRun } = await import("../../../src/domains/assistant/shared/assistant.models.js");
  const { getBusinessHistory, getBusinessRun } = await import("../../../src/domains/assistant/admin/assistant.admin-service.js");
  const { getHistory, getRun } = await import("../../../src/domains/assistant/customer/assistant.service.js");
  const { admitMessage } = await import("../../../src/domains/assistant/shared/assistant.store.js");
  const { testConfig } = await import("./fixtures/foundationPolicy.js");
  const config = testConfig(); const now = new Date();
  const manifest = createSharedMongoManifest("persistence"); const { ids, seed } = persistenceSeed(manifest, config, now);
  const directory = new URL("../../../.scratch/assistant-shared-db/", import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL(`${manifest.marker}.json`, directory), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  t.diagnostic(`persistence_manifest=${manifest.marker}.json`);
  let records;
  t.after(() => cleanupAssistantTestResources({ servers: [], cleanupCollections: () => records?.cleanup(),
    disconnect: () => mongoose.disconnect(), restoreEnvironment() {},
  }));
  try {
    await mongoose.connect(uri.href, { serverSelectionTimeoutMS: 5000, autoCreate: false, autoIndex: false, bufferCommands: false });
  } catch { throw new Error("Shared persistence connection failed; connection details withheld"); }
  records = sharedMongoRecords(mongoose.connection, manifest); await records.prepare();
  for (const { collection, document } of seed) await records.insert(collection, document);
  const owner = ids.users[0]; const foreign = ids.users[1];

  await t.test("stored customer and business replies remain purpose- and owner-scoped", async () => {
    const customer = await getHistory(owner, {}, config); const business = await getBusinessHistory(owner, {}, config);
    assert.deepEqual(customer.messages.map((message) => message.text), ["Customer-only synthetic text"]);
    assert.deepEqual(business.messages.map((message) => message.text), ["Business-only synthetic text"]);
    assert.equal((await getRun(owner, String(ids.assistantruns[0]), config)).message.text, customer.messages[0].text);
    assert.equal((await getBusinessRun(owner, String(ids.assistantruns[1]), config)).message.text, business.messages[0].text);
    await assert.rejects(getBusinessRun(owner, String(ids.assistantruns[0]), config), { code: "run_not_found" });
    await assert.rejects(getRun(owner, String(ids.assistantruns[1]), config), { code: "run_not_found" });
    await assert.rejects(getBusinessRun(foreign, String(ids.assistantruns[1]), config), { code: "run_not_found" });
    await assert.rejects(getBusinessRun(owner, String(ids.assistantruns[2]), config), { code: "run_not_found" });
  });

  await t.test("database owner/key uniqueness rejects a second registered run ID", async () => {
    const source = seed.find((entry) => String(entry.document._id) === String(ids.assistantruns[1])).document;
    await assert.rejects(records.insert("assistantruns", { ...source, _id: ids.assistantruns[3] }), (error) => error.code === 11000);
    assert.equal(await AssistantRun.countDocuments({ _id: { $in: [ids.assistantruns[1], ids.assistantruns[3]] } }), 1);
  });

  // Native transactions exercise the real models/guard without invoking store initialization or global ledgers.
  const transact = async (callback) => {
    const session = await mongoose.startSession();
    try { return await session.withTransaction(() => callback(session), {
      readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary", maxCommitTimeMS: 10000,
    }); } finally { await session.endSession(); }
  };
  await t.test("aborting a transaction rolls back account and chat writes together", async () => {
    const aborted = new Error("Intentional synthetic rollback");
    await assert.rejects(transact(async (session) => {
      const account = await AssistantAccount.updateOne({ _id: ids.assistantaccounts[0], owner }, { $inc: { dayMessages: 1 } }, { session });
      const chat = await AssistantAdminChat.updateOne({ _id: ids.assistantadminchats[0], owner }, { $inc: { nextSequence: 1 } }, { session });
      assert.equal(account.modifiedCount, 1); assert.equal(chat.modifiedCount, 1);
      throw aborted;
    }), (error) => error === aborted);
    assert.equal((await AssistantAccount.findById(ids.assistantaccounts[0]).lean()).dayMessages, 0);
    assert.equal((await AssistantAdminChat.findById(ids.assistantadminchats[0]).lean()).nextSequence, 0);
  });

  await t.test("competing transactions accept only one message under a one-message daily limit", async () => {
    let readers = 0; const barrier = Promise.withResolvers();
    const timer = setTimeout(() => barrier.reject(new Error("Concurrent reads did not reach the barrier")), 5000);
    let outcomes;
    try {
      outcomes = await Promise.allSettled([1, 2].map(() => {
        let firstRead = true;
        return transact(async (session) => {
          const account = await AssistantAccount.findOne({ _id: ids.assistantaccounts[0], owner }).session(session);
          assert.ok(account);
          if (firstRead) {
            firstRead = false; readers += 1; if (readers === 2) barrier.resolve(); await barrier.promise;
          }
          admitMessage(account, { ...config, dailyMessageLimit: 1 }, now); await account.save({ session });
          return "accepted";
        });
      }));
    } finally { clearTimeout(timer); }
    assert.equal(readers, 2, "Both initial snapshots must be read before either contender writes");
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(outcomes.find((result) => result.status === "rejected")?.reason.code, "daily_message_limit");
    assert.equal((await AssistantAccount.findById(ids.assistantaccounts[0]).lean()).dayMessages, 1);
  });
});
