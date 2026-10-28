import assert from "node:assert/strict";
import test from "node:test";
import { bookingCoordinatorFixture as fixture } from "./fixtures/bookingCoordinator.js";
import { oid, clone } from "./fixtures/bookingReceipts.js";
import { testPolicy } from "./fixtures/foundationPolicy.js";
import { confirmBookingProposal } from "../../../src/domains/assistant/customer/assistant.booking-proposals.js";
import { loadAssistantConfig } from "../../../src/domains/assistant/shared/assistant.config.js";
test("coordinator commits explicit saved proposal with current access/context fences and server location", async t => {
  const f = fixture(t), p = await f.prepare(), result = await f.confirm(p);
  assert.equal(result.confirmed, true); assert.equal(result.duplicate, false); assert.equal(f.receipts.length, 1); assert.equal(f.reservations.length, 1);
  assert.equal(f.account.bookingReadRateCount, 2); assert.equal(f.account.dayMessages, undefined); assert.equal(f.chat.contextVersion, 0);
  for (const name of ["AssistantAccount", "AssistantChat", "User", "Pet", "ServiceLocation", "ServiceCatalog"]) assert.ok(f.fences.includes(name), name);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal((await f.status(p)).proposal.status, "confirmed");
});
test("exact confirmation and owned status recover original after expiry/profile/location changes without resolving again", async t => {
  const f = fixture(t), p = await f.prepare(), first = await f.confirm(p), resolves = f.resolveCalls, writes = f.inventoryWrites;
  f.pet.name = "Changed"; f.chat.contextVersion++; f.config = { ...f.config, signature: "changed" };
  t.mock.timers.enable({ apis: ["Date"], now: new Date(p.expiresAt).getTime() + 1 });
  const replay = await f.confirm(p, { location: { governorateCode: "cairo", areaCode: "maadi" } });
  assert.equal(replay.duplicate, true); assert.deepEqual(replay.receipt, first.receipt);
  await assert.rejects(f.confirm(p, { location: { resolvedLocation: { eligible: true } } }), { code: "invalid_request" });
  f.config.bookingActionsEnabled = false;
  assert.deepEqual((await f.status(p)).receipt, first.receipt); assert.equal(f.resolveCalls, resolves); assert.equal(f.inventoryWrites, writes);
  f.account.blocked = true; await assert.rejects(f.status(p), { code: "ai_restricted" });
});
test("default-off action gate is separate from booking reads; altered confirmation fields and guests fail", async t => {
  const f = fixture(t), p = await f.prepare(); f.config.bookingActionsEnabled = false;
  await assert.rejects(f.confirm(p), { code: "booking_actions_unavailable" }); f.config.bookingActionsEnabled = true;
  for (const changes of [{ expectedVersion: 2 }, { fingerprint: "b".repeat(64) }, { booking: f.payload }, { owner: String(f.owner) }, { location: null }])
    await assert.rejects(f.confirm(p, changes));
  await assert.rejects(confirmBookingProposal("guest", p.id, { expectedVersion: 1, fingerprint: p.fingerprint, location: f.location }, f.config), { code: "invalid_identifier" });
  assert.equal(f.reservations.length, 0);
  const env = { ASSISTANT_ENABLED: "true", OPENAI_API_KEY: "synthetic-key", ASSISTANT_POLICY_JSON: JSON.stringify(testPolicy()) };
  assert.equal(loadAssistantConfig(env).bookingActionsEnabled, false);
  assert.equal(loadAssistantConfig({ ...env, ASSISTANT_BOOKING_ACTIONS_ENABLED: "true" }).bookingActionsEnabled, true);
});
test("blocked/inactive users, foreign proposals and changed chat/pet context cannot confirm or leak status", async t => {
  const f = fixture(t), p = await f.prepare();
  for (const [name, key, value] of [["account", "blocked", true], ["user", "active", false], ["chat", "contextVersion", 1], ["pet", "name", "Changed"], ["pet", "temp_health_issues", ["Changed"]]]) {
    const before = clone(f[name]); f[name][key] = value; await assert.rejects(f.confirm(p)); f[name] = before;
  }
  const owner = f.proposals[0].owner; f.proposals[0].owner = oid();
  await assert.rejects(f.confirm(p), { code: "booking_proposal_not_found" }); await assert.rejects(f.status(p), { code: "booking_proposal_not_found" }); f.proposals[0].owner = owner;
  assert.equal(f.reservations.length, 0);
});
test("expiry and fresh Cairo location fail; forged resolved evidence and warehouse keys cannot authorize geography", async t => {
  const f = fixture(t), p = await f.prepare();
  await assert.rejects(f.confirm(p, { location: { governorateCode: "cairo", areaCode: "maadi" } }), { code: "booking_region_unavailable" });
  await assert.rejects(f.confirm(p, { location: { source: "manual", governorate: { name: "alexandria" } } }), { code: "invalid_request" });
  await assert.rejects(f.confirm(p, { location: { ...f.location, warehouseId: String(oid()) } }), { code: "invalid_request" });
  t.mock.timers.enable({ apis: ["Date"], now: new Date(p.expiresAt).getTime() + 1 });
  await assert.rejects(f.confirm(p), { code: "booking_proposal_expired" }); assert.equal(f.reservations.length, 0);
});
test("state changed between preflight and write transaction is rechecked after backend resolution", async t => {
  const f = fixture(t), p = await f.prepare();
  f.onWarehouse = () => { f.account.blocked = true; };
  await assert.rejects(f.confirm(p), { code: "ai_restricted" }); assert.equal(f.reservations.length, 0);
});
test("changed chat, price and action switch during area resolution cannot pass the final transaction", async t => {
  const f = fixture(t), p = await f.prepare();
  f.onWarehouse = () => { f.chat.contextVersion = 1; };
  await assert.rejects(f.confirm(p), { code: "context_changed" }); f.chat.contextVersion = 0;
  f.onWarehouse = () => { f.definitions[0].options[0].price = 80; };
  await assert.rejects(f.confirm(p), { code: "booking_proposal_changed" }); f.definitions[0].options[0].price = 75;
  f.onWarehouse = () => { f.config.bookingActionsEnabled = false; };
  await assert.rejects(f.confirm(p), { code: "booking_actions_unavailable" }); assert.equal(f.reservations.length, 0); assert.equal(f.receipts.length, 0);
});
test("receipt committed while area is resolving wins over later context and outside-city checks", async t => {
  const f = fixture(t), p = await f.prepare();
  f.onWarehouse = async () => {
    f.onWarehouse = null;
    const args = JSON.parse(f.proposals[0].inputJson);
    await f.stage({ owner: String(f.owner), proposalId: p.id, proposalFingerprint: p.fingerprint, booking: args.booking, language: args.language,
      expectedQuote: p.quote, resolvedLocation: f.resolvedLocation });
    f.chat.contextVersion++;
  };
  const result = await f.confirm(p, { location: { governorateCode: "cairo", areaCode: "maadi" } });
  assert.equal(result.duplicate, true); assert.equal(result.confirmed, true); assert.equal(f.reservations.length, 1); assert.equal(f.inventoryWrites, 1);
});
test("failed account/chat/profile fences and failed receipt leave no booking", async t => {
  const f = fixture(t), p = await f.prepare();
  for (const model of ["AssistantAccount", "AssistantChat", "Pet"]) {
    f.failFence = model; await assert.rejects(f.confirm(p), { code: "context_changed" }); assert.equal(f.reservations.length, 0); assert.equal(f.inventory.length, 0);
  }
  f.failFence = null; f.failReceipt = true; await assert.rejects(f.confirm(p), /simulated receipt failure/);
  assert.equal(f.receipts.length, 0); assert.equal(f.account.__v, 0); assert.equal(f.chat.__v, 0);
});
test("expiry after reservation staging aborts reservations, inventory, receipt and context writes", async t => {
  const f = fixture(t), p = await f.prepare(); t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  f.afterReservationInsert = () => t.mock.timers.tick(61000);
  await assert.rejects(f.confirm(p), { code: "booking_proposal_expired" }); assert.equal(f.reservations.length, 0); assert.equal(f.inventory.length, 0); assert.equal(f.receipts.length, 0);
});
test("an action switch disabled during staging aborts every booking write", async t => {
  const f = fixture(t), p = await f.prepare(); f.afterReservationInsert = () => { f.config.bookingActionsEnabled = false; };
  await assert.rejects(f.confirm(p), { code: "booking_actions_unavailable" });
  assert.equal(f.reservations.length, 0); assert.equal(f.inventory.length, 0); assert.equal(f.receipts.length, 0); assert.equal(f.account.__v, 0);
});
test("lost successful write response is recovered by original proposal without double booking", async t => {
  const f = fixture(t), p = await f.prepare(); f.loseAfterBooking = true; f.loseResponse = true;
  await assert.rejects(f.confirm(p), /simulated unknown commit response/); assert.equal(f.receipts.length, 1);
  const result = await f.confirm(p); assert.equal(result.duplicate, true); assert.equal(f.reservations.length, 1); assert.equal(f.inventory[0].bookedCount, 1);
});
test("late resolver result after read timeout cannot start a booking transaction", async t => {
  const f = fixture(t), p = await f.prepare(); f.config.timeoutMs = 5; let release;
  f.onWarehouse = () => new Promise(resolve => { release = resolve; });
  await assert.rejects(f.confirm(p), { code: "booking_read_timeout" }); f.onWarehouse = null; release();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.reservations.length, 0); assert.equal(f.receipts.length, 0);
});
test("different active and explicitly targeted owned pets are both fenced without replacing the target", async t => {
  const f = fixture(t); f.otherPets.push({ ...clone(f.pet), _id: oid(), name: "Other pet" }); f.chat.activeSubject = `pet:${f.otherPets[0]._id}`;
  const p = await f.prepare(), result = await f.confirm(p);
  assert.equal(result.receipt.result.pet.id, String(f.pet._id)); assert.equal(f.otherPets[0].__v, 1); assert.equal(f.pet.__v, 2);
});
