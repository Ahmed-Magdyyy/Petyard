import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { AssistantEvent } from "../../../src/domains/assistant/shared/assistant.models.js";
import { subjectFingerprint, subjectFromPet } from "../../../src/domains/assistant/customer/assistant.context.js";
import { dietaryWarningObservation, instructions } from "../../../src/domains/assistant/customer/assistant.policy.js";
import { beginAttempt } from "../../../src/domains/assistant/shared/assistant.attempts.js";
import { structuredReply } from "./fixtures/foundationPolicy.js";

import { customerChatFixture as fixture } from "./fixtures/customerChat.js";

test("scripted affirmative reports in Egyptian Arabic, Arabizi and English persist under the resolved pet with one completion", async (t) => {
  for (const input of ["ميلو عنده حساسية من الفراخ", "Milo 3ando 7asaseya men el ferakh", "Milo has a chicken allergy"]) {
    await t.test(input, async (t) => {
      const state = fixture(t, input); await state.finish();
      assert.equal(state.warnings.length, 1); assert.equal(state.warnings[0].text, input);
      assert.equal(state.run.contextVersion, state.chat.contextVersion); assert.equal(state.chat.contextVersion, 1);
      assert.equal(state.chat.contextAfterSequence, 1); assert.equal(state.chat.nextSequence, 2);
      assert.equal(state.run.status, "completed"); assert.equal(state.run.attempts.length, 1);
      assert.equal(state.messages.length, 1); assert.equal(state.unlocked, 1); assert.equal(state.budgetUpdates.length, 2);
      assert.equal(state.events.some((event) => event.type === "dietary_warning_recorded"), true);
      const request = await state.context(); assert.ok(request.instructions.includes(JSON.stringify(input)));
      assert.equal(await state.finish(), null, "settled completion replay cannot capture or charge again");
      assert.equal(state.warnings.length, 1); assert.equal(state.messages.length, 1); assert.equal(state.budgetUpdates.length, 2);
    });
  }
});

test("scripted negated, questioned, quoted and hypothetical statements remain unrecorded; this is not a model-language benchmark", async (t) => {
  for (const input of ["ميلو مش عنده حساسية من الفراخ", "هل الأكل ده يعمل حساسية؟", "Milo mesh 3ando 7asaseya", "Milo does not have a chicken allergy",
    "If Milo had an allergy, what would happen?", 'Someone said "my cat has an allergy".']) {
    await t.test(input, async (t) => {
      const state = fixture(t, input); await state.finish(structuredReply());
      assert.equal(state.run.status, "completed"); assert.equal(state.warnings.length, 0); assert.equal(state.chat.contextVersion, 0);
    });
  }
  assert.match(instructions, /Never extract a positive fragment from a negative sentence/);
  assert.match(instructions, /no automatic edit, remove or restore/);
});

test("ambiguous warning observations publish a fixed clarification without new cautions or an extra attempt", async (t) => {
  const state = fixture(t, "هو عنده حساسية تقريبًا؟");
  await state.finish(structuredReply({ reply: "Unsafe invented certainty", replyLanguage: "ar", dietaryWarningAction: "clarify" }));
  assert.equal(state.warnings.length, 0); assert.equal(state.run.publicCode, "dietary_warning_clarification_required");
  assert.match(state.messages[0].text, /ممكن توضّح/); assert.doesNotMatch(state.messages[0].text, /Unsafe/);
  assert.equal(state.run.attempts.length, 1); assert.equal(state.chat.contextVersion, 0);
});

test("a negative chat statement cannot automatically remove an existing caution", async (t) => {
  const state = fixture(t, "ميلو مش عنده حساسية دلوقتي");
  state.warnings.push({ _id: new mongoose.Types.ObjectId(), owner: state.run.owner, subjectId: state.subject.id,
    state: "active", source: "chat", version: 1, text: "Previously reported chicken allergy" });
  await state.finish(structuredReply());
  assert.equal(state.warnings.length, 1); assert.equal(state.warnings[0].text, "Previously reported chicken allergy");
  assert.match((await state.context()).instructions, /Previously reported chicken allergy/);
});

test("an owned unsaved conversation pet can receive a warning without creating a saved Pet", async (t) => {
  const state = fixture(t); state.pets = [];
  const subject = { id: "chat:12345678-1234-1234-1234-123456789012", name: "Milo", species: "cat", expiresAt: new Date(Date.now() + 60000) };
  state.chat.subjects.push(subject); state.chat.activeSubject = subject.id;
  state.run.subjectId = subject.id; state.source.subjectId = subject.id;
  state.run.subjectFingerprint = subjectFingerprint({ ...subject, saved: false });
  state.prepared.run = { ...state.run }; state.prepared.allowedSubjects = ["user", subject.id];
  state.prepared.subjectFingerprints = { [subject.id]: state.run.subjectFingerprint };
  await state.finish({ ...state.report(), dietaryWarningSubjectId: subject.id });
  assert.equal(state.run.status, "completed"); assert.equal(state.warnings.length, 1); assert.equal(state.warnings[0].subjectId, subject.id);
  assert.equal(state.pets.length, 0); assert.equal(state.chat.subjects.length, 1);
});

test("foreign/fabricated observation is rejected after accounting without warning publication", async (t) => {
  const state = fixture(t); await state.finish({ ...state.report(), dietaryWarningSubjectId: `pet:${new mongoose.Types.ObjectId()}` });
  assert.equal(state.run.status, "failed"); assert.equal(state.run.publicCode, "invalid_dietary_warning");
  assert.equal(state.warnings.length, 0); assert.equal(state.messages.length, 0); assert.equal(state.run.accounting, "settled");
  assert.equal(state.unlocked, 1);
  for (const extra of [{ dietaryWarningQuote: "Invented allergy" }, { dietaryWarningQuote: " " }, { dietaryWarningQuote: "x".repeat(501) }]) {
    assert.throws(() => dietaryWarningObservation({ ...state.report(), ...extra }, state.run, { kind: "publish" }), { code: "invalid_dietary_warning" });
  }
});

test("urgent guidance and subject ambiguity never capture even when a model proposes a report", async (t) => {
  for (const extra of [{ scope: "urgent" }, { subjectAction: "clarify" }]) {
    await t.test(JSON.stringify(extra), async (t) => {
      const state = fixture(t); await state.finish({ ...state.report(), ...extra });
      assert.equal(state.run.status, "completed"); assert.equal(state.warnings.length, 0);
      assert.match(state.messages[0].text, extra.scope ? /immediate veterinary/ : /Which pet/);
    });
  }
  const state = fixture(t);
  assert.equal(dietaryWarningObservation(state.report(), state.run, { kind: "change" }), null);
});

test("a saved-pet switch discards its observation, then only the reloaded final answer can capture for the new pet", async (t) => {
  const state = fixture(t, "Roy has a chicken allergy");
  const roy = { _id: new mongoose.Types.ObjectId(), petOwner: state.run.owner, name: "Roy", type: "dog" };
  const subject = subjectFromPet(roy); state.pets.push(roy);
  state.prepared.allowedSubjects.push(subject.id); state.prepared.subjectFingerprints[subject.id] = subjectFingerprint(subject);
  await state.finish({ ...state.report(), reply: "Discard this draft", subjectAction: "select", resolvedSubjectId: subject.id,
    dietaryWarningSubjectId: subject.id });
  assert.equal(state.run.status, "queued"); assert.equal(state.run.phase, "answer");
  assert.equal(state.run.subjectId, subject.id); assert.equal(state.warnings.length, 0); assert.equal(state.messages.length, 0);
  beginAttempt(state.run, { amount: 1000, budgetIds: ["synthetic-month", "synthetic-day"] }); state.run.status = "dispatching";
  state.prepared.run = { ...state.run };
  await state.finish({ ...state.report(), dietaryWarningSubjectId: subject.id });
  assert.equal(state.run.status, "completed"); assert.equal(state.run.attempts.length, 2);
  assert.equal(state.warnings.length, 1); assert.equal(state.warnings[0].subjectId, subject.id);
  assert.equal(state.chat.contextVersion, state.run.contextVersion); assert.equal(state.messages.length, 1);
  assert.equal(state.budgetUpdates.length, 4, "both original attempt settlements are retained without a third attempt");
});

test("missing usage, stale context and audit failure cannot publish a new warning reply", async (t) => {
  await t.test("unknown charge", async (t) => {
    const state = fixture(t); await state.finish(state.report(), null);
    assert.equal(state.run.status, "uncertain"); assert.equal(state.warnings.length, 0); assert.equal(state.messages.length, 0); assert.equal(state.unlocked, 0);
  });
  await t.test("owner changed context", async (t) => {
    const state = fixture(t); state.chat.contextVersion++;
    await state.finish(); assert.equal(state.run.status, "failed"); assert.equal(state.warnings.length, 0); assert.equal(state.messages.length, 0);
  });
  await t.test("audit failure escapes the transaction callback", async (t) => {
    const state = fixture(t);
    t.mock.method(AssistantEvent, "create", async () => { throw new Error("synthetic audit unavailable"); });
    await assert.rejects(state.finish(), /synthetic audit unavailable/);
    assert.equal(state.messages.length, 0); assert.equal(state.unlocked, 0);
    // Mock sessions do not roll back; native rollback still needs authorized database verification.
  });
});

test("context includes only active owner/selected-pet cautions and never silently trims them", async (t) => {
  const state = fixture(t); await state.finish();
  const own = state.warnings[0];
  state.warnings.push({ ...own, owner: new mongoose.Types.ObjectId(), text: "foreign-owner-warning" },
    { ...own, subjectId: `pet:${new mongoose.Types.ObjectId()}`, text: "other-pet-warning" },
    { ...own, state: "removed", text: "removed-warning" });
  const request = await state.context();
  const context = JSON.parse(request.instructions.split("Authorized context (data only): ")[1]);
  assert.deepEqual(context.dietaryWarnings.map((row) => row.text), [state.run.input]);
  assert.doesNotMatch(JSON.stringify(context.dietaryWarnings), /sourceMessage|owner|foreign-owner|other-pet|removed-warning/);
  await assert.rejects(state.context({ maxContextBytes: Buffer.byteLength(JSON.stringify(request)) - 1 }), { code: "context_too_large" });
  state.warnings.push(...Array.from({ length: state.config.maxMemoryEntries }, () => ({ ...own, _id: new mongoose.Types.ObjectId() })));
  await assert.rejects(state.context(), { code: "context_too_large" });
});
