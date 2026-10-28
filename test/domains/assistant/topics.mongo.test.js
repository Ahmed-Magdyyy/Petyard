import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { AssistantAccount, AssistantRun } from "../../../src/domains/assistant/shared/assistant.models.js";
import { initializeAssistantStore } from "../../../src/domains/assistant/shared/assistant.store.js";
import { processAssistantRun } from "../../../src/domains/assistant/customer/assistant.worker.service.js";
import * as service from "../../../src/domains/assistant/customer/assistant.service.js";
import { getUsageReport } from "../../../src/domains/assistant/reporting/assistant.reporting.js";
import { TOPIC_TAXONOMY_VERSION } from "../../../src/domains/assistant/reporting/assistant.topics.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { PetModel } from "../../../src/domains/pet/pet.model.js";
import { testConfig, knownUsage, structuredReply } from "./fixtures/foundationPolicy.js";
import { createAssistantTestDbName, validateAssistantMongoTarget } from "./fixtures/mongoTarget.js";
import { cleanupAssistantTestCollections, cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";

test("isolated Mongo topic persistence: only final validated answers count, with no classifier call or duplicate turn", {
  skip: !process.env.ASSISTANT_TEST_MONGO_URI && "Requires explicitly authorized assistant test target",
}, async (t) => {
  const uri = validateAssistantMongoTarget(process.env.ASSISTANT_TEST_MONGO_URI, process.env.ASSISTANT_TEST_ATLAS_HOST);
  const database = createAssistantTestDbName(); uri.pathname = `/${database}`;
  let connected = false;
  t.after(() => cleanupAssistantTestResources({ servers: [],
    cleanupCollections: () => connected ? cleanupAssistantTestCollections(mongoose.connection, database) : undefined,
    disconnect: () => mongoose.disconnect(), restoreEnvironment() {},
  }));
  await mongoose.connect(uri.href, { serverSelectionTimeoutMS: 3000 }); connected = true;
  t.diagnostic(`assistant_test_database=${database}`);
  await initializeAssistantStore();
  const config = testConfig({ rateMax: 100 });
  const owner = new mongoose.Types.ObjectId();
  await UserModel.collection.insertOne({ _id: owner, name: "topic test", role: "user", active: true,
    phoneVerified: true, account_status: "confirmed", deletedAt: null });
  const [milo, roy] = await PetModel.create([{ petOwner: owner, name: "Milo", type: "cat" }, { petOwner: owner, name: "Roy", type: "dog" }]);
  await service.changeSubject(owner, { subjectId: `pet:${milo._id}` }, config);
  let calls = 0;
  const outcome = (data) => ({ structured: structuredReply(data), finishReason: "completed", toolCalls: [],
    usage: knownUsage, serviceTier: "default", latencyMs: 1, providerRequestId: "local-scripted-topic-result" });
  const switched = await service.submitMessage(owner, { text: "طب وروي؟ عايز أفكار لعب ليه" }, "topic-switch-test", config);
  await processAssistantRun(switched.run.id, { getConfig: () => config, adapterFactory: () => ({ async generate() {
    calls += 1;
    return outcome(calls === 1 ? { primaryTopic: "nutrition", subjectAction: "select", resolvedSubjectId: `pet:${roy._id}`, reply: "" }
      : { primaryTopic: "behavior", reply: "General indoor play ideas." });
  } }) });
  const completed = await AssistantRun.findById(switched.run.id);
  assert.equal(completed.status, "completed"); assert.equal(calls, 2);
  assert.equal(completed.attempts.length, 2); assert.equal(completed.topic.key, "behavior");
  assert.equal(completed.topic.taxonomyVersion, TOPIC_TAXONOMY_VERSION);
  assert.equal((await AssistantAccount.findOne({ owner }).lean()).reviewEvidenceVersion, 1, "Two-call switch records one completed observation version");
  assert.equal((await service.submitMessage(owner, { text: "طب وروي؟ عايز أفكار لعب ليه" }, "topic-switch-test", config)).duplicate, true);
  assert.equal((await AssistantAccount.findOne({ owner }).lean()).reviewEvidenceVersion, 1, "Duplicate admission never advances evidence");
  const unrelated = await service.submitMessage(owner, { text: "Football scores" }, "topic-unrelated-test", config);
  await processAssistantRun(unrelated.run.id, { getConfig: () => config, adapterFactory: () => ({ async generate() {
    calls += 1; return outcome({ primaryTopic: "off_topic", scope: "off_topic" });
  } }) });
  const invalid = await service.submitMessage(owner, { text: "Some care advice" }, "topic-invalid-test", config);
  await processAssistantRun(invalid.run.id, { getConfig: () => config, adapterFactory: () => ({ async generate() {
    calls += 1; return outcome({ primaryTopic: "invented-diagnosis" });
  } }) });
  const rejected = await AssistantRun.findById(invalid.run.id);
  assert.equal(rejected.status, "failed"); assert.equal(rejected.topic, null);
  const pending = await service.submitMessage(owner, { text: "Hello" }, "topic-pending-test", config);
  assert.equal((await AssistantRun.findById(pending.run.id)).topic, null);
  assert.equal((await AssistantAccount.findOne({ owner }).lean()).reviewEvidenceVersion, 2, "Invalid/pending results create no completed observation version");
  const report = await getUsageReport({}, config);
  assert.equal(calls, 4, "The report did not run a classifier or provider call");
  assert.equal(report.totals.acceptedMessages, 4); assert.equal(report.totals.providerAttempts, 4);
  assert.equal(report.topics.classifiedMessages, 2); assert.equal(report.topics.unknownMessages, 2);
  assert.equal(report.topics.categories.find((row) => row.key === "behavior").count, 1);
  assert.equal(report.topics.categories.find((row) => row.key === "off_topic").count, 1);
  assert.equal(report.topics.categories.find((row) => row.key === "nutrition").count, 0, "First discarded draft did not label a turn");
  assert.equal(report.topics.categories.reduce((sum, row) => sum + row.count, 0), 4);
});
