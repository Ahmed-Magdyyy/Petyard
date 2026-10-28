import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import { bookingCoordinatorFixture } from "./fixtures/bookingCoordinator.js";
import { oid, match } from "./fixtures/bookingReceipts.js";
import { createAssistantRouter } from "../../../src/domains/assistant/assistant.routes.js";
import { ServiceReservationModel } from "../../../src/domains/serviceReservation/reservations/serviceReservation.model.js";
import { metadataDto } from "../../../src/domains/assistant/shared/assistant.dto.js";
import { periods, loadAssistantConfig } from "../../../src/domains/assistant/shared/assistant.config.js";
import { testPolicy } from "./fixtures/foundationPolicy.js";
import { AssistantBookingProposal } from "../../../src/domains/assistant/shared/assistant.booking-proposal.model.js";

async function fixture(t) {
  const f = bookingCoordinatorFixture(t), previous = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = "synthetic-booking-action-http-only";
  t.after(() => { if (previous === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = previous; });
  t.mock.method(ServiceReservationModel, "find", filter => f.query(() => f.reservations.filter(row => match(row, filter))));
  const app = express(); app.use(express.json({ limit: "64kb" }));
  app.use("/api/v1/assistant", createAssistantRouter({ getConfig: () => f.config }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const token = jwt.sign({ userId: String(f.owner) }, process.env.JWT_ACCESS_SECRET, { expiresIn: "2d" });
  f.body = { location: f.location, language: "en", booking: f.payload };
  f.request = async (method, path = "", body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/assistant/booking-proposals${path}`, {
      method, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "Idempotency-Key": "http-booking-review-1", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  f.prepareHttp = () => f.request("POST", "", f.body);
  f.confirmHttp = proposal => f.request("POST", `/${proposal.id}/confirmations`, {
    expectedVersion: proposal.version, fingerprint: proposal.fingerprint, location: f.location,
  });
  f.historyHttp = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/assistant/messages`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: await response.json() };
  };
  return f;
}
test("real authenticated HTTP flow prepares, confirms, recovers and reads current owned status", async t => {
  const f = await fixture(t), started = Date.now(), prepared = await f.prepareHttp();
  assert.equal(prepared.status, 201); const p = prepared.body.data.proposal;
  assert.equal(prepared.body.data.chatMessageId, p.id); assert.equal(prepared.body.data.bookingReview.status, "pending");
  assert.ok(new Date(p.expiresAt) >= started + 599000); assert.ok(new Date(p.expiresAt) <= Date.now() + 600000);
  assert.equal(JSON.stringify(prepared.body).includes("PRIVATE"), false);
  assert.equal(new Date(f.proposals[0].detailsExpireAt) - new Date(p.expiresAt), 85800000);
  assert.equal((await f.prepareHttp()).status, 200); assert.equal(f.proposals.length, 1);
  assert.equal((await f.request("GET", `/${p.id}`)).body.data.receipt, null);
  const confirmed = await f.confirmHttp(p); assert.equal(confirmed.status, 200); assert.equal(confirmed.body.data.duplicate, false);
  assert.equal(confirmed.body.data.chatMessageId, p.id); assert.equal(confirmed.body.data.bookingReview.kind, "creation_result");
  assert.equal(f.messages.length, 1);
  assert.equal((await f.confirmHttp(p)).body.data.duplicate, true); assert.equal(f.reservations.length, 1);
  const replayedPreparation = await f.prepareHttp(); assert.equal(replayedPreparation.body.data.proposal.status, "confirmed");
  assert.ok(replayedPreparation.body.data.receipt);
  f.reservations[0].status = "CANCELLED";
  assert.equal((await f.request("GET", `/${p.id}`)).body.data.proposal.status, "confirmed");
  assert.equal((await f.request("GET", `/${p.id}/status`)).body.data.reservations[0].status, "CANCELLED");
  const history = await f.historyHttp(); assert.equal(history.status, 200);
  assert.equal(history.body.data.messages[0].runId, null); assert.equal(history.body.data.messages[0].kind, "booking_review");
  assert.equal(history.body.data.messages[0].bookingReview.status, "confirmed");
  assert.equal(history.body.data.messages[0].bookingReview.currentStatusIncluded, false);
  assert.equal(f.account.bookingActionRateCount, 8); assert.equal(f.account.bookingReadRateCount, 2); assert.equal(f.account.dayMessages, undefined);
});
test("guest, invalid token, unverified/inactive/banned and AI-blocked users cannot enter actions", async t => {
  const f = await fixture(t);
  for (const headers of [{ authorization: "", "x-guest-id": "guest" }, { authorization: "Bearer invalid" }])
    assert.equal((await f.request("POST", "", f.body, headers)).status, 401);
  f.user.phoneVerified = false; assert.equal((await f.prepareHttp()).status, 403); f.user.phoneVerified = true;
  f.user.active = false; assert.equal((await f.prepareHttp()).status, 401); f.user.active = true;
  f.user.account_status = "banned"; assert.equal((await f.prepareHttp()).status, 403); f.user.account_status = "confirmed";
  f.account.blocked = true; assert.equal((await f.prepareHttp()).status, 403);
  assert.equal(f.proposals.length, 0); assert.equal(f.account.bookingActionRateCount, undefined);
});
test("dedicated validators reject extra identities, prices, expiry, evidence, query and wrong confirmation shapes before admission", async t => {
  const f = await fixture(t), id = String(oid());
  for (const change of [{ owner: String(f.owner) }, { expiresAt: "2100-01-01" }, { price: 1 }, { resolvedLocation: {} },
    { location: { ...f.location, prime: true } }, { booking: { ...f.payload, serviceType: "BOARDING" } }, { booking: { ...f.payload, totalPrice: 1 } }])
    assert.equal((await f.request("POST", "", { ...f.body, ...change })).status, 400);
  for (const key of ["", "bad key", "x".repeat(129)]) assert.equal((await f.request("POST", "", f.body, { "Idempotency-Key": key })).status, 400);
  const valid = { expectedVersion: 1, fingerprint: "a".repeat(64), location: f.location };
  for (const change of [{ expectedVersion: "1" }, { fingerprint: ["a".repeat(64)] }, { expectedVersion: 2 }, { booking: f.payload },
    { language: "ar" }, { location: { lat: "31", lng: 29.9 } }, { location: { lat: 31, lng: 29.9, governorateCode: "alexandria" } }])
    assert.equal((await f.request("POST", `/${id}/confirmations`, { ...valid, ...change })).status, 400);
  for (const path of ["/not-an-id", `/${id}?owner=x`, `/${id}/status?extra=1`]) assert.equal((await f.request("GET", path)).status, 400);
  assert.equal((await f.request("POST", "?extra=1", f.body)).status, 400);
  assert.equal((await f.request("POST", `/${id}/confirmations?extra=1`, valid)).status, 400);
  assert.equal((await f.request("POST", "", { ...f.body, privateExtra: "x".repeat(33000) })).status, 413);
  assert.equal(f.account.bookingActionRateCount, undefined); assert.equal(f.reservations.length, 0);
});
test("action switch defaults off, metadata stays separate, owned reads survive disabling new actions", async t => {
  const f = await fixture(t), p = (await f.prepareHttp()).body.data.proposal;
  const env = { ASSISTANT_ENABLED: "true", OPENAI_API_KEY: "synthetic", ASSISTANT_POLICY_JSON: JSON.stringify(testPolicy()) };
  assert.equal(loadAssistantConfig(env).bookingActionsEnabled, false); assert.equal(loadAssistantConfig(env).bookingRetentionEnabled, false);
  assert.equal(metadataDto(f.config, f.account, periods(f.config)).capabilities.bookingActions, true);
  f.config.bookingRetentionEnabled = false;
  assert.equal(metadataDto(f.config, f.account, periods(f.config)).capabilities.bookingActions, false);
  assert.equal((await f.prepareHttp()).status, 503); f.config.bookingRetentionEnabled = true;
  t.mock.method(AssistantBookingProposal.collection, "indexes", async () => [{ key: { owner: 1, key: 1 }, unique: true }]);
  const unready = await f.prepareHttp(); assert.equal(unready.status, 503); assert.equal(unready.body.error.code, "booking_retention_store_unavailable");
  f.config.bookingActionsEnabled = false;
  assert.equal(metadataDto(f.config, f.account, periods(f.config)).capabilities.bookingActions, false);
  assert.equal((await f.prepareHttp()).status, 503); assert.equal((await f.confirmHttp(p)).status, 503);
  assert.equal((await f.request("GET", `/${p.id}`)).status, 200);
  assert.equal((await f.request("GET", `/${p.id}/status`)).status, 200);
  f.config.bookingReadsEnabled = false; assert.equal((await f.request("GET", `/${p.id}`)).status, 503);
});
test("foreign and missing proposals remain indistinguishable and current access is required", async t => {
  const f = await fixture(t), p = (await f.prepareHttp()).body.data.proposal; f.proposals[0].owner = oid();
  for (const path of [`/${p.id}`, `/${oid()}`, `/${p.id}/status`]) assert.equal((await f.request("GET", path)).status, 404);
  assert.equal((await f.confirmHttp(p)).status, 404); assert.equal(f.reservations.length, 0);
});
test("removed owned reviews return safe 410 responses and old keys cannot select a different booking", async t => {
  const f = await fixture(t), p = (await f.prepareHttp()).body.data.proposal;
  f.proposals[0].detailsRemovedAt = new Date();
  for (const key of ["inputJson", "quoteJson", "binding"]) delete f.proposals[0][key];
  for (const path of [`/${p.id}`, `/${p.id}/status`]) {
    const response = await f.request("GET", path); assert.equal(response.status, 410); assert.equal(response.body.error.code, "booking_review_removed");
  }
  assert.equal((await f.prepareHttp()).status, 410); assert.equal((await f.confirmHttp(p)).status, 410);
  f.body.booking = { ...f.body.booking, hour24: 15 }; assert.equal((await f.prepareHttp()).status, 409);
  assert.equal(f.reservations.length, 0); assert.equal(f.resolveCalls, 1);
});
test("expired reviews remain historical but cannot create a booking, and rate admission resets separately", async t => {
  const f = await fixture(t), p = (await f.prepareHttp()).body.data.proposal;
  t.mock.timers.enable({ apis: ["Date"], now: new Date(p.expiresAt).getTime() + 1 });
  assert.equal((await f.request("GET", `/${p.id}`)).body.data.proposal.status, "expired");
  assert.equal((await f.confirmHttp(p)).body.error.code, "booking_proposal_expired");
  f.config.rateMax = 2; f.account.bookingActionRateCount = 2;
  const limited = await f.request("GET", `/${p.id}`); assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get("retry-after")) > 0);
  t.mock.timers.tick(61000); assert.equal((await f.request("GET", `/${p.id}`)).status, 200); assert.equal(f.account.bookingActionRateCount, 1);
});
test("lost booking commit reply is recovered through the same HTTP proposal without duplicate capacity", async t => {
  const f = await fixture(t), p = (await f.prepareHttp()).body.data.proposal;
  f.loseAfterBooking = true; f.loseResponse = true;
  const uncertain = await f.confirmHttp(p); assert.equal(uncertain.status, 503); assert.equal(JSON.stringify(uncertain.body).includes("simulated"), false);
  assert.equal((await f.request("GET", `/${p.id}`)).body.data.proposal.status, "confirmed");
  assert.equal((await f.confirmHttp(p)).body.data.duplicate, true);
  assert.equal(f.reservations.length, 1); assert.equal(f.inventory[0].bookedCount, 1);
});
test("proposal serialization failure and changed memory context prevent new writes, but committed recovery survives context changes", async t => {
  const f = await fixture(t), p = (await f.prepareHttp()).body.data.proposal; f.failFence = "AssistantBookingProposal";
  assert.equal((await f.confirmHttp(p)).status, 409); assert.equal(f.reservations.length, 0); assert.equal(f.inventory.length, 0);
  f.failFence = null; f.chat.contextVersion++; assert.equal((await f.confirmHttp(p)).body.error.code, "context_changed");
  f.chat.contextVersion--; assert.equal((await f.confirmHttp(p)).status, 200); f.chat.contextVersion++;
  assert.equal((await f.confirmHttp(p)).body.data.duplicate, true); assert.equal(f.reservations.length, 1);
});
