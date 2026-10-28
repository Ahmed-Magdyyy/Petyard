import assert from "node:assert/strict";
import test from "node:test";
import { bookingCoordinatorFixture } from "./fixtures/bookingCoordinator.js";
import { oid, clone, match } from "./fixtures/bookingReceipts.js";
import { prepareBookingReview, confirmBookingReview, getBookingReview } from "../../../src/domains/assistant/customer/assistant.booking-api.js";
import { bookingMessageDtos, ensureBookingReviewMessage } from "../../../src/domains/assistant/customer/assistant.booking-messages.js";
import { AssistantBookingProposal } from "../../../src/domains/assistant/shared/assistant.booking-proposal.model.js";
import { AssistantBookingReceipt } from "../../../src/domains/assistant/shared/assistant.booking-receipt.model.js";
import { AssistantMessage } from "../../../src/domains/assistant/shared/assistant.models.js";
import { getHistory } from "../../../src/domains/assistant/customer/assistant.service.js";
import { buildBookingReviewCard, renderBookingReview } from "../../../src/domains/assistant/customer/assistant.booking-review-cards.js";
import { removeExpiredBookingReviews } from "../../../src/domains/assistant/customer/assistant.booking-lifecycle.js";

function fixture(t) {
  const f = bookingCoordinatorFixture(t);
  t.mock.method(AssistantBookingProposal, "find", filter => f.query(() => f.proposals.filter(row => match(row, filter))));
  t.mock.method(AssistantBookingReceipt, "find", filter => f.query(() => f.receipts.filter(row => match(row, filter))));
  f.body = { location: f.location, language: "en", booking: f.payload };
  f.prepareApi = () => prepareBookingReview(f.owner, f.body, "review-chat-key-1", f.config);
  f.confirmApi = proposal => confirmBookingReview(f.owner, proposal.id, { expectedVersion: proposal.version, fingerprint: proposal.fingerprint,
    location: f.location }, f.config);
  f.history = () => getHistory(f.owner, {}, f.config);
  return f;
}
test("preparation retains one private-safe reference and owner history resolves the actual saved review", async t => {
  const f = fixture(t), result = await f.prepareApi(), p = result.proposal;
  assert.equal(result.chatMessageId, p.id); assert.equal(result.bookingReview.status, "pending");
  assert.equal(result.bookingReview.action.type, "confirm_booking_review"); assert.equal(f.messages.length, 1); assert.equal(f.chat.nextSequence, 1);
  const raw = f.messages[0]; assert.equal(String(raw.run), p.id); assert.equal(String(raw._id), p.id); assert.equal(raw.bookingReview.language, "en");
  assert.equal(raw.bookingJson, undefined); assert.doesNotMatch(JSON.stringify(raw), /PRIVATE|ownerPhone|comment|price|Milo|fingerprint/);
  const history = await f.history(), message = history.messages[0]; assert.equal(message.kind, "booking_review"); assert.equal(message.runId, null);
  assert.equal(message.bookingReview.details.services[0].price, p.quote.services[0].price); assert.equal(message.bookingReview.proposalId, p.id);
  assert.equal(JSON.stringify(message).includes("PRIVATE"), false); assert.equal(f.reservations.length, 0); assert.equal(f.inventory.length, 0);
  assert.equal((await f.prepareApi()).duplicate, true); assert.equal(f.messages.length, 1); assert.equal(f.chat.nextSequence, 1);
});
test("confirmation upgrades the same reference to committed creation and preserves original prices after later changes", async t => {
  const f = fixture(t), initial = await f.prepareApi(), result = await f.confirmApi(initial.proposal);
  assert.equal(result.bookingReview.kind, "creation_result"); assert.equal(result.bookingReview.status, "confirmed");
  assert.equal(result.bookingReview.action.type, "refresh_booking_status"); assert.equal(result.bookingReview.currentStatusIncluded, false);
  assert.equal(result.chatMessageId, initial.chatMessageId); assert.equal(f.messages.length, 1); assert.equal(f.reservations.length, 1);
  f.definitions[0].options[0].price += 100; f.reservations[0].status = "CANCELLED";
  const card = (await f.history()).messages[0].bookingReview;
  assert.equal(card.status, "confirmed"); assert.equal(card.details.totalPrice, result.receipt.result.totalPrice);
  assert.equal(card.details.services[0].reservationId, String(f.reservations[0]._id)); assert.equal(card.currentStatusIncluded, false);
  assert.equal((await f.confirmApi(initial.proposal)).duplicate, true); assert.equal(f.messages.length, 1); assert.equal(f.inventory[0].bookedCount, 1);
});
test("presentation failure after booking commit is recovered by the original confirmation without duplicate writes", async t => {
  const f = fixture(t), p = await f.prepare(); f.failMessageInsert = true;
  await assert.rejects(f.confirmApi(p)); assert.equal(f.receipts.length, 1); assert.equal(f.reservations.length, 1);
  assert.equal(f.messages.length, 0); assert.equal(f.chat.nextSequence, 0);
  f.failMessageInsert = false;
  const recovered = await f.confirmApi(p); assert.equal(recovered.duplicate, true); assert.equal(recovered.bookingReview.status, "confirmed");
  assert.equal(f.messages.length, 1); assert.equal(f.chat.nextSequence, 1); assert.equal(f.reservations.length, 1); assert.equal(f.inventory[0].bookedCount, 1);
});
test("failed timeline allocation never leaves a sequence gap or a partial reference", async t => {
  const f = fixture(t), p = await f.prepare(); f.failTimeline = true;
  await assert.rejects(ensureBookingReviewMessage(f.owner, p.id, f.config), { code: "context_changed" });
  assert.equal(f.messages.length, 0); assert.equal(f.chat.nextSequence, 0); assert.equal(f.receipts.length, 0);
  f.failTimeline = false; await ensureBookingReviewMessage(f.owner, p.id, f.config);
  await ensureBookingReviewMessage(f.owner, p.id, f.config); assert.equal(f.messages.length, 1); assert.equal(f.chat.nextSequence, 1);
});
test("lost successful reference reply reuses the retained message instead of adding another sequence", async t => {
  const f = fixture(t), p = await f.prepare(), insert = AssistantMessage.create;
  t.mock.method(AssistantMessage, "create", async (...args) => { const result = await insert(...args); f.loseResponse = true; return result; });
  await assert.rejects(ensureBookingReviewMessage(f.owner, p.id, f.config)); assert.equal(f.messages.length, 1); assert.equal(f.chat.nextSequence, 1);
  t.mock.method(AssistantMessage, "create", insert);
  await ensureBookingReviewMessage(f.owner, p.id, f.config); assert.equal(f.messages.length, 1); assert.equal(f.chat.nextSequence, 1);
});
test("Arabic review language is retained without model output and the history card uses Egyptian Arabic", async t => {
  const f = fixture(t); f.body.language = "ar"; await f.prepareApi();
  assert.equal(f.messages[0].bookingReview.language, "ar"); const message = (await f.history()).messages[0];
  assert.match(message.text, /راجع الخدمة/); assert.doesNotMatch(message.text, /Review the service/);
});
test("expired and removed reviews lose confirmation controls, and cleanup cannot restore private details from messages", async t => {
  const f = fixture(t), result = await f.prepareApi(), p = result.proposal;
  t.mock.timers.enable({ apis: ["Date"], now: new Date(p.expiresAt).getTime() + 1 });
  let card = (await f.history()).messages[0].bookingReview; assert.equal(card.status, "expired"); assert.equal(card.action, null);
  t.mock.timers.setTime(f.proposals[0].detailsExpireAt.getTime() + 1);
  assert.equal((await removeExpiredBookingReviews(f.config)).removed, 1);
  card = (await f.history()).messages[0].bookingReview; assert.equal(card.status, "removed"); assert.equal(card.details, null);
  assert.equal(card.version, null); assert.equal(card.fingerprint, null); assert.equal(card.action, null);
  assert.equal(JSON.stringify(f.messages[0]).includes("Milo"), false); assert.equal(f.receipts.length, 0);
});
test("a physically expired reference is not recreated by later committed-booking recovery", async t => {
  const f = fixture(t), first = await f.prepareApi(); await f.confirmApi(first.proposal);
  t.mock.timers.enable({ apis: ["Date"], now: f.proposals[0].chatMessageExpiresAt.getTime() + 1 }); f.messages = [];
  const result = await f.confirmApi(first.proposal); assert.equal(result.duplicate, true); assert.equal(result.chatMessageId, null);
  assert.equal(result.bookingReview.status, "confirmed"); assert.equal(f.messages.length, 0); assert.equal(f.chat.nextSequence, 1);
});
test("foreign/missing/corrupt proposal or receipt never exposes another booking through timeline hydration", async t => {
  const f = fixture(t), first = await f.prepareApi(); await f.confirmApi(first.proposal); const original = clone(f.receipts[0]);
  for (const mode of ["foreign_receipt", "bad_hash", "foreign_proposal", "missing"]) {
    const owner = f.proposals[0].owner;
    if (mode === "foreign_receipt") f.receipts[0].owner = oid();
    if (mode === "bad_hash") f.receipts[0].resultHash = "b".repeat(64);
    if (mode === "foreign_proposal") f.proposals[0].owner = oid();
    const saved = f.proposals; if (mode === "missing") f.proposals = [];
    const card = (await f.history()).messages[0].bookingReview; assert.equal(card.status, "unavailable"); assert.equal(card.details, null);
    f.proposals = saved; f.proposals[0].owner = owner; f.receipts[0] = clone(original);
  }
});
test("current read/access gates suppress booking details while action disable only removes confirmation control", async t => {
  const f = fixture(t); await f.prepareApi(); f.config.bookingActionsEnabled = false;
  assert.equal((await f.history()).messages[0].bookingReview.action, null);
  f.config.bookingReadsEnabled = false; assert.equal((await f.history()).messages[0].bookingReview.status, "unavailable");
  f.config.bookingReadsEnabled = true; f.config.blockedHistoryAllowed = true; f.account.blocked = true;
  const limited = await f.history(); assert.equal(limited.messages[0].bookingReview.status, "unavailable"); assert.equal(limited.messages[0].bookingReview.details, null);
});
test("batched timeline hydration bounds and rechecks access after reads without model/geocoder/booking writes", async t => {
  const f = fixture(t); await f.prepareApi(); let proposalReads = 0, receiptReads = 0;
  const find = AssistantBookingProposal.find, receiptFind = AssistantBookingReceipt.find;
  t.mock.method(AssistantBookingProposal, "find", filter => { proposalReads++; return find(filter); });
  t.mock.method(AssistantBookingReceipt, "find", filter => { receiptReads++; return receiptFind(filter); });
  await f.history(); assert.equal(proposalReads, 1); assert.equal(receiptReads, 1); assert.equal(f.reservations.length, 0);
  t.mock.method(AssistantBookingReceipt, "find", filter => { f.account.blocked = true; return receiptFind(filter); });
  const dtos = await bookingMessageDtos(f.messages, f.owner, f.config); assert.equal(dtos[0].bookingReview.status, "unavailable");
});
test("safe card projection rejects malformed source data and renders English or Egyptian Arabic", async t => {
  const f = fixture(t), result = await f.prepareApi();
  const card = buildBookingReviewCard(result, { actionsAllowed: true }); assert.match(renderBookingReview(card, "ar"), /تأكيد/);
  assert.match(renderBookingReview(card, "en"), /Confirm/); assert.equal(card.details.pet.name, result.proposal.quote.pet.name);
  const expiry = new Date(result.proposal.expiresAt).getTime();
  assert.equal(buildBookingReviewCard(result, { capturedAt: new Date(expiry - 1).toISOString() }).status, "pending");
  assert.equal(buildBookingReviewCard(result, { capturedAt: new Date(expiry + 1).toISOString() }).status, "expired");
  for (const mutate of [source => { source.quote.services[0].price = -1; }, source => { source.quote.services[0].serviceType = "BOARDING"; },
    source => { source.quote.location.id = "bad"; }, source => { source.quote.pet.name = { secret: "PRIVATE" }; }]) {
    const source = clone(result.proposal); mutate(source); assert.throws(() => buildBookingReviewCard({ proposal: source }), { code: "booking_review_card_unavailable" });
  }
});
test("owned GET recovery returns a card without creating a new timeline event", async t => {
  const f = fixture(t), p = await f.prepare(); const result = await getBookingReview(f.owner, p.id, f.config);
  assert.equal(result.chatMessageId, null); assert.equal(result.bookingReview.status, "pending"); assert.equal(f.messages.length, 0); assert.equal(f.chat.nextSequence, 0);
});
test("GET presentation reconciles a booking committed after its initial pending-state read", async t => {
  const f = fixture(t), p = await f.prepare(); let confirmed = false;
  t.mock.method(AssistantMessage, "findOne", () => f.query(async () => {
    if (!confirmed) { confirmed = true; await f.confirm(p); } return null;
  }));
  const result = await getBookingReview(f.owner, p.id, f.config);
  assert.equal(result.proposal.status, "confirmed"); assert.equal(result.bookingReview.status, "confirmed");
  assert.equal(result.bookingReview.action.type, "refresh_booking_status"); assert.equal(f.reservations.length, 1);
});
