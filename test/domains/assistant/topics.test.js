import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { TOPIC_TAXONOMY_VERSION, topicKeys, summarizeTopics } from "../../../src/domains/assistant/reporting/assistant.topics.js";
import { instructions, outputSchema, PROMPT_VERSION, validateResult } from "../../../src/domains/assistant/customer/assistant.policy.js";
import { AssistantRun } from "../../../src/domains/assistant/shared/assistant.models.js";
import { runDto } from "../../../src/domains/assistant/shared/assistant.dto.js";
import { usageReportPipeline, usageReportPeriod } from "../../../src/domains/assistant/reporting/assistant.reporting.js";
import { testConfig, structuredReply } from "./fixtures/foundationPolicy.js";

const config = testConfig();

test("versioned topic observations share one bounded enum and cannot leak through the public run DTO", () => {
  assert.equal(config.promptVersion, PROMPT_VERSION);
  assert.equal(PROMPT_VERSION, "petyard-focused-reference-catalog-v5");
  assert.ok(outputSchema.required.includes("primaryTopic"));
  assert.deepEqual(outputSchema.properties.primaryTopic.enum, topicKeys);
  assert.equal(outputSchema.required.length, 21);
  const run = new AssistantRun({ owner: new mongoose.Types.ObjectId(), chat: new mongoose.Types.ObjectId(),
    key: "test-key", hash: "test-hash", status: "queued", contextVersion: 0, input: "hello", userSequence: 1, config: {},
    topic: { key: "nutrition", taxonomyVersion: TOPIC_TAXONOMY_VERSION } });
  assert.equal(run.validateSync(), undefined);
  assert.doesNotMatch(JSON.stringify(runDto(run)), /nutrition|topic|taxonomy/);
  run.topic.key = "invented-diagnosis";
  assert.ok(run.validateSync()?.errors["topic.key"]);
  assert.match(instructions, /natural Egyptian Arabic written in Arabic script/);
  assert.match(instructions, /Never infer a diagnosis from a topic/);
});

test("scripted topic labels validate for Egyptian Arabic, Arabizi and English without asserting model comprehension", () => {
  const fixtures = [
    { input: "أغيّر نوع أكل قطتي بالتدريج إزاي؟", primaryTopic: "nutrition" },
    { input: "الكلب بيهرش كتير", primaryTopic: "health_symptoms" },
    { input: "أنضف ودنه إزاي؟", primaryTopic: "grooming" },
    { input: "el order lesa mawasalsh", primaryTopic: "orders" },
    { input: "Can I book a visit?", primaryTopic: "bookings" },
  ];
  for (const fixture of fixtures) {
    const result = { finishReason: "completed", toolCalls: [], structured: structuredReply({ primaryTopic: fixture.primaryTopic }) };
    assert.equal(validateResult(result, { input: fixture.input, subjectId: null }, config, []).primaryTopic, fixture.primaryTopic);
  }
  const result = (primaryTopic) => ({ finishReason: "completed", toolCalls: [], structured: structuredReply({ primaryTopic }) });
  for (const invalid of ["invented-diagnosis", "nutrition; drop users", null, { key: "behavior" }]) {
    assert.throws(() => validateResult(result(invalid), { input: "hello" }, config, []));
  }
  const missing = result("unknown"); delete missing.structured.primaryTopic;
  assert.throws(() => validateResult(missing, { input: "hello" }, config, []));
});

test("topic shares use all retained accepted messages, retain unknowns, and never turn coverage into accuracy", () => {
  const report = summarizeTopics([{ _id: "nutrition", count: 2 }, { _id: "behavior", count: 1 }, { _id: "unknown", count: 1 }], 4);
  assert.equal(report.totalMessages, 4); assert.equal(report.classifiedMessages, 3); assert.equal(report.unknownMessages, 1);
  assert.equal(report.assessment, "model_unreviewed"); assert.equal(report.denominator, "retained_accepted_messages");
  assert.deepEqual(report.categories[0], { key: "nutrition", count: 2, shareBasisPoints: 5000 });
  assert.equal(report.categories.reduce((sum, row) => sum + row.count, 0), 4);
  assert.equal(report.categories.length, topicKeys.length);
  assert.equal(summarizeTopics([], 3).unknownMessages, 3, "older records are not backfilled by a paid call");
  assert.ok(summarizeTopics([], 0).categories.every((row) => row.count === 0 && row.shareBasisPoints === null));
});

test("topic aggregation accepts only current completed observations and counts messages instead of attempts", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const pipeline = usageReportPipeline(usageReportPeriod({}, config.timezone, now), config.timezone, now);
  const stages = pipeline[2].$facet.topics;
  const condition = stages[1].$group._id.$cond;
  assert.deepEqual(condition[0].$and, [
    { $eq: ["$status", "completed"] }, { $eq: ["$topic.taxonomyVersion", TOPIC_TAXONOMY_VERSION] },
    { $in: ["$topic.key", topicKeys] },
  ]);
  assert.equal(condition[1], "$topic.key"); assert.equal(condition[2], "unknown");
  assert.equal(stages.length, 2); assert.ok(stages.every((stage) => !stage.$unwind));
});
