import test from "node:test";
import assert from "node:assert/strict";
import { buildContextWithKnowledge } from "../../../src/domains/assistant/customer/assistant.context.js";
import { customerChatFixture } from "./fixtures/customerChat.js";

const passage = index => ({ sourceId: `fictional-source-${index}`, version: "fixture-version", title: "Fictional reference",
  locator: `PDF page ${index + 1}`, excerpt: String(index).repeat(500), reviewed: true, species: ["cat"] });
const batch = (s, passages) => ({ ownerId: String(s.run.owner), runId: String(s.run._id), subjectId: s.run.subjectId, contextVersion: 0,
  generation: 0, phase: "resolve", profileFingerprint: s.run.subjectFingerprint, passages });

test("context fitting preserves whole excerpts, leaves the input unchanged and reports exactly used evidence", async t => {
  const s = customerChatFixture(t), first = batch(s, [passage(0)]);
  const measured = await buildContextWithKnowledge(s.run, s.chat, [s.subject], s.config, {}, new Date(), first);
  const budget = Buffer.byteLength(JSON.stringify(measured.request)); assert.ok(budget <= s.config.maxContextBytes);
  const full = batch(s, [passage(0), passage(1), passage(2)]), before = structuredClone(full);
  const fitted = await buildContextWithKnowledge(s.run, s.chat, [s.subject], { ...s.config, maxContextBytes: budget }, {}, new Date(), full);
  assert.deepEqual(fitted.passages, [passage(0)]); assert.deepEqual(full, before);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted.request)) <= budget);
  assert.ok(fitted.request.instructions.includes(passage(0).excerpt)); assert.equal(fitted.request.instructions.includes(passage(1).excerpt), false);
});

test("evidence can fall back to empty without removing dietary cautions or increasing the context limit", async t => {
  const s = customerChatFixture(t);
  s.warnings.push({ _id: "a".repeat(24), owner: s.run.owner, subjectId: s.run.subjectId, state: "active", text: "OWNER_CAUTION", source: "user", version: 1 });
  const base = await buildContextWithKnowledge(s.run, s.chat, [s.subject], s.config, {});
  const budget = Buffer.byteLength(JSON.stringify(base.request)) + 10;
  const fitted = await buildContextWithKnowledge(s.run, s.chat, [s.subject], { ...s.config, maxContextBytes: budget }, {}, new Date(), batch(s, [passage(0)]));
  assert.deepEqual(fitted.passages, []); assert.match(fitted.request.instructions, /OWNER_CAUTION/);
  assert.match(fitted.request.instructions, /"state":"no_reviewed_evidence"/);
  await assert.rejects(buildContextWithKnowledge(s.run, s.chat, [s.subject], { ...s.config, maxContextBytes: 1000 }, {}, new Date(), batch(s, [passage(0)])),
    { code: "context_too_large" });
});
