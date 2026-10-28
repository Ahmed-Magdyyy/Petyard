import assert from "node:assert/strict";
import test from "node:test";
import { bookingCoordinatorFixture } from "./fixtures/bookingCoordinator.js";
import { match, oid } from "./fixtures/bookingReceipts.js";
import { ServiceReservationModel } from "../../../src/domains/serviceReservation/reservations/serviceReservation.model.js";
import { getBookingLiveStatus } from "../../../src/domains/assistant/customer/assistant.booking-status.js";

async function fixture(t, confirmed = true) {
  const f = bookingCoordinatorFixture(t), p = await f.prepare(); if (confirmed) await f.confirm(p);
  t.mock.method(ServiceReservationModel, "find", filter => f.query(() => { f.onStatusRead?.(); return f.reservations.filter(row => match(row, filter)); }));
  f.live = () => getBookingLiveStatus(f.owner, p.id, f.config); f.proposal = p; return f;
}
test("current status comes from owned records while historical receipt stays confirmed", async t => {
  const f = await fixture(t);
  for (const status of ["BOOKED", "IN_PROGRESS", "CANCELLED", "COMPLETED", "NO_SHOW"]) {
    f.reservations[0].status = status; const result = await f.live();
    assert.equal(result.creationStatus, "confirmed"); assert.equal(result.reservations[0].status, status); assert.equal(result.allReservationsFound, true);
    assert.equal(result.dataMode, "snapshot"); assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  }
  f.config.bookingActionsEnabled = false; assert.equal((await f.live()).creationStatus, "confirmed");
});
test("unconfirmed proposals never invent current reservations", async t => {
  const f = await fixture(t, false), result = await f.live(); assert.equal(result.creationStatus, "pending"); assert.deepEqual(result.reservations, []); assert.equal(result.allReservationsFound, false);
});
test("missing or foreign-owned rows are unavailable, never guessed as cancelled", async t => {
  const f = await fixture(t); f.reservations[0].user = oid(); const result = await f.live();
  assert.equal(result.allReservationsFound, false); assert.equal(result.reservations[0].found, false); assert.equal(result.reservations[0].status, null);
});
test("blocked access during status read and corrupt dates/status fail safely", async t => {
  const f = await fixture(t); f.onStatusRead = () => { f.account.blocked = true; }; await assert.rejects(f.live(), { code: "ai_restricted" });
  f.onStatusRead = null; f.account.blocked = false; f.reservations[0].status = "UNKNOWN"; await assert.rejects(f.live(), { code: "booking_status_unavailable" });
  f.reservations[0].status = "BOOKED"; f.reservations[0].startsAt = "invalid"; await assert.rejects(f.live(), { code: "booking_status_unavailable" });
});
