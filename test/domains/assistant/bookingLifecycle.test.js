import assert from "node:assert/strict";
import test from "node:test";
import { bookingCoordinatorFixture } from "./fixtures/bookingCoordinator.js";
import { oid, clone, match } from "./fixtures/bookingReceipts.js";
import { AssistantBookingProposal } from "../../../src/domains/assistant/shared/assistant.booking-proposal.model.js";
import { AssistantBookingReceipt } from "../../../src/domains/assistant/shared/assistant.booking-receipt.model.js";
import { removeExpiredBookingReviews } from "../../../src/domains/assistant/customer/assistant.booking-lifecycle.js";
import { prepareBookingProposal } from "../../../src/domains/assistant/customer/assistant.booking-proposals.js";
import { loadAssistantConfig } from "../../../src/domains/assistant/shared/assistant.config.js";
import { drainAssistantWork } from "../../../src/domains/assistant/assistant.runtime.js";

function fixture(t) {
  const f = bookingCoordinatorFixture(t); f.config.bookingRetentionEnabled = true;
  f.indexes = [{ key: { owner: 1, key: 1 }, unique: true }, { key: { detailsCleanupAttemptedAt: 1, detailsExpireAt: 1, _id: 1 } }];
  t.mock.method(AssistantBookingProposal.collection, "indexes", async () => f.indexes);
  t.mock.method(AssistantBookingProposal, "find", filter => {
    let limit;
    const q = f.query(() => f.proposals.filter(row => match(row, filter)).sort((a, b) =>
      (a.detailsCleanupAttemptedAt?.getTime() ?? 0) - (b.detailsCleanupAttemptedAt?.getTime() ?? 0) || String(a._id).localeCompare(String(b._id))).slice(0, limit));
    q.limit = value => { assert.equal(value, 25); limit = value; return q; }; return q;
  });
  f.drain = () => removeExpiredBookingReviews(f.config);
  f.advance = proposal => t.mock.timers.enable({ apis: ["Date"], now: f.proposals.find(row => String(row._id) === proposal.id).detailsExpireAt.getTime() + 1 });
  return f;
}
test("unused review details are removed after 24 hours with a valid retry tombstone and no booking writes", async t => {
  const f = fixture(t), p = await f.prepare(); assert.equal((await f.drain()).removed, 0); f.advance(p);
  assert.equal((await f.drain()).removed, 1); const row = f.proposals[0];
  for (const key of ["inputJson", "quoteJson", "binding", "detailsExpireAt"]) assert.equal(Object.hasOwn(row, key), false);
  assert.ok(row.detailsRemovedAt instanceof Date); assert.equal(row.requestHash.length, 64); assert.equal(row.key, "coordinator-prepare-1");
  assert.equal(new AssistantBookingProposal(row).validateSync(), undefined);
  assert.equal(JSON.stringify(row).includes("PRIVATE"), false); assert.equal(f.receipts.length, 0); assert.equal(f.inventory.length, 0); assert.equal(f.reservations.length, 0);
  await assert.rejects(f.prepare(), { code: "booking_review_removed" });
  await assert.rejects(f.status(p), { code: "booking_review_removed" }); await assert.rejects(f.confirm(p), { code: "booking_review_removed" });
  await assert.rejects(prepareBookingProposal(f.owner, { location: f.location, language: "en", booking: { ...f.payload, hour24: 15 } },
    "coordinator-prepare-1", f.config, { expiresAt: new Date(Date.now() + 60000) }), { code: "idempotency_conflict" });
  assert.equal((await f.drain()).removed, 0);
});
test("confirmed review and receipt remain intact, and are removed from the unused-detail queue", async t => {
  const f = fixture(t), p = await f.prepare(); await f.confirm(p); const originalInput = f.proposals[0].inputJson, receipt = clone(f.receipts[0]); f.advance(p);
  assert.equal((await f.drain()).confirmed, 1); assert.equal(f.proposals[0].inputJson, originalInput); assert.equal(f.proposals[0].detailsRemovedAt, undefined);
  assert.deepEqual(f.receipts[0], receipt); assert.equal(f.reservations.length, 1); assert.equal(f.inventory[0].bookedCount, 1);
  assert.equal((await f.status(p)).proposal.status, "confirmed"); assert.equal((await f.confirm(p)).duplicate, true);
  assert.equal((await f.drain()).confirmed, 0);
});
test("retention does not depend on customer block, current chat, booking actions or booking-read access", async t => {
  const f = fixture(t), p = await f.prepare(); f.advance(p); f.account.blocked = true; f.chat.contextVersion++;
  f.config.bookingActionsEnabled = false; f.config.bookingReadsEnabled = false;
  assert.equal((await f.drain()).removed, 1); assert.equal(f.reservations.length, 0);
});
test("retention still runs with the assistant globally disabled and without provider configuration", async t => {
  const f = fixture(t), p = await f.prepare(); f.advance(p);
  const config = loadAssistantConfig({ ASSISTANT_BOOKING_RETENTION_ENABLED: "true" });
  assert.deepEqual(config, { enabled: false, bookingRetentionEnabled: true });
  const result = await drainAssistantWork({ getConfig: () => config });
  assert.equal(result.enabled, false); assert.equal(result.bookingRetention.removed, 1); assert.equal(result.failed, 0);
});
test("retention is default-off and rejects missing/TTL/partial scan indexes without setup", async t => {
  const f = fixture(t); f.config.bookingRetentionEnabled = false;
  t.mock.method(AssistantBookingReceipt.collection, "indexes", async () => { throw new Error("must not query while disabled"); });
  assert.equal((await f.drain()).enabled, false); f.config.bookingRetentionEnabled = true;
  f.indexes.pop(); await assert.rejects(f.drain(), { code: "booking_retention_store_unavailable" });
  f.indexes.push({ key: { detailsCleanupAttemptedAt: 1, detailsExpireAt: 1, _id: 1 }, partialFilterExpression: { owner: { $exists: true } } });
  await assert.rejects(f.drain(), { code: "booking_retention_store_unavailable" });
  f.indexes.push({ key: { expiresAt: 1 }, expireAfterSeconds: 0 });
  await assert.rejects(f.drain(), { code: "booking_proposal_store_unavailable" });
});
test("foreign receipt and invalid dates fail safely without erasing review details", async t => {
  const f = fixture(t), p = await f.prepare(); await f.confirm(p); f.advance(p); f.receipts[0].owner = oid();
  assert.equal((await f.drain()).failed, 1); assert.ok(f.proposals[0].inputJson); assert.equal(f.proposals[0].detailsRemovedAt, undefined);
  f.receipts = []; f.proposals[0].expiresAt = null;
  assert.equal((await f.drain()).failed, 1); assert.ok(f.proposals[0].inputJson);
});
test("failed redaction rolls back private-field changes and keeps retry work, while attempts rotate", async t => {
  const f = fixture(t), p = await f.prepare(); f.advance(p);
  const write = AssistantBookingProposal.collection.updateOne;
  t.mock.method(AssistantBookingProposal.collection, "updateOne", async (filter, update, options) => {
    const result = await write(filter, update, options); if (options?.session && update.$unset?.inputJson) throw new Error("simulated failure before commit"); return result;
  });
  assert.equal((await f.drain()).failed, 1); assert.ok(f.proposals[0].inputJson); assert.equal(f.proposals[0].detailsRemovedAt, undefined);
  assert.ok(f.proposals[0].detailsCleanupAttemptedAt instanceof Date);
});
test("a confirmed receipt visible after an earlier pending read prevents redaction", async t => {
  const f = fixture(t), p = await f.prepare(); await f.confirm(p); f.advance(p);
  // The cleanup decision must use the transactional receipt read, not a candidate-list snapshot.
  assert.equal((await f.drain()).confirmed, 1); assert.ok(f.proposals[0].inputJson); assert.equal(f.proposals[0].detailsRemovedAt, undefined);
});
test("failed old rows do not starve later due reviews and cleanup cannot remove unexpired details", async t => {
  const f = fixture(t), p = await f.prepare(), original = clone(f.proposals[0]); f.advance(p);
  f.proposals = Array.from({ length: 25 }, () => ({ ...clone(original), _id: oid(), expiresAt: null }));
  f.proposals.push({ ...clone(original), _id: oid() });
  assert.equal((await f.drain()).failed, 25); assert.equal((await f.drain()).removed, 1);
  f.proposals = [{ ...clone(original), expiresAt: new Date(Date.now() + 1) }];
  assert.equal((await f.drain()).failed, 1); assert.ok(f.proposals[0].inputJson);
});
