import assert from "node:assert/strict";
import test from "node:test";
import { cartProposalHttpFixture, oid, OTHER, F } from "./fixtures/cartProposals.js";

test("actual authenticated HTTP flow prepares, confirms once, and recovers the retained receipt", async (t) => {
  const s = await cartProposalHttpFixture(t);
  const prepared = await s.httpPrepare(); assert.equal(prepared.status, 201);
  const proposal = prepared.body.data.proposal;
  assert.equal(proposal.status, "pending"); assert.equal(prepared.body.data.receipt, null);
  assert.equal(s.cart, null, "Preparation must not create the ordinary cart");
  const pending = await s.httpStatus(proposal); assert.equal(pending.status, 200);
  assert.equal(pending.body.data.proposal.status, "pending"); assert.equal(pending.body.data.receipt, null);
  const confirmation = await s.httpConfirm(proposal); assert.equal(confirmation.status, 200);
  const receipt = confirmation.body.data.receipt;
  assert.equal(confirmation.body.data.confirmed, true); assert.equal(confirmation.body.data.duplicate, false);
  assert.equal(s.cart.items[0].quantity, 2); assert.equal(s.cartWrites, 1);
  assert.deepEqual(s.fences, ["User", "AssistantAccount", "AssistantChat"]);
  const replay = await s.httpConfirm(proposal); assert.equal(replay.status, 200);
  assert.equal(replay.body.data.duplicate, true); assert.deepEqual(replay.body.data.receipt, receipt);
  s.cart.items = []; s.cart.totalCartPrice = 0; s.product.price = 999;
  const recovered = await s.httpStatus(proposal); assert.equal(recovered.status, 200);
  assert.equal(recovered.body.data.proposal.status, "confirmed"); assert.deepEqual(recovered.body.data.receipt, receipt);
  const preparedAgain = await s.httpPrepare(); assert.equal(preparedAgain.status, 200);
  assert.equal(preparedAgain.body.data.duplicate, true); assert.equal(preparedAgain.body.data.proposal.status, "confirmed");
  assert.deepEqual(preparedAgain.body.data.receipt, receipt); assert.equal(s.cartWrites, 1);
  assert.deepEqual(s.cart.items, []); assert.equal(s.account.cartRateCount, 6);
});

test("a committed addition followed by a simulated lost commit response recovers over actual HTTP without reapplying", async (t) => {
  const s = await cartProposalHttpFixture(t), prepared = await s.httpPrepare();
  const proposal = prepared.body.data.proposal;
  // Admission also commits; inject the ambiguous result only after the cart's receipt has been staged.
  s.beforeCommit = () => { if (s.receipts.length) { s.loseResponse = true; s.beforeCommit = null; } };
  const unknown = await s.httpConfirm(proposal); assert.equal(unknown.status, 503);
  assert.equal(unknown.body.error.code, "assistant_unavailable");
  assert.doesNotMatch(JSON.stringify(unknown.body), /simulated|unknown commit|stack/);
  assert.equal(s.cart.items[0].quantity, 2); assert.equal(s.receipts.length, 1);
  const writes = s.cartWrites;
  const recovered = await s.httpStatus(proposal); assert.equal(recovered.status, 200);
  assert.equal(recovered.body.data.proposal.status, "confirmed");
  const replay = await s.httpConfirm(proposal); assert.equal(replay.status, 200);
  assert.equal(replay.body.data.duplicate, true); assert.deepEqual(replay.body.data.receipt, recovered.body.data.receipt);
  assert.equal(s.cartWrites, writes); assert.equal(s.cart.items[0].quantity, 2);
});

test("actual HTTP confirmation rechecks user, account and chat changes and rolls back staged effects", async (t) => {
  for (const scenario of [
    { name: "user deactivation", code: "authentication_required", status: 401, change: (s) => { s.user.active = false; } },
    { name: "user phone verification removed", code: "access_denied", status: 403, change: (s) => { s.user.phoneVerified = false; } },
    { name: "assistant access blocked", code: "ai_restricted", status: 403, change: (s) => { s.account.blocked = true; } },
    { name: "selected context changed", code: "context_changed", status: 409, change: (s) => { s.chat.contextVersion++; } },
  ]) await t.test(scenario.name, async (t) => {
    const s = await cartProposalHttpFixture(t), prepared = await s.httpPrepare();
    s.onCartRefresh = () => scenario.change(s);
    const response = await s.httpConfirm(prepared.body.data.proposal);
    assert.equal(response.status, scenario.status); assert.equal(response.body.error.code, scenario.code);
    assert.equal(s.cart, null); assert.equal(s.receipts.length, 0);
    assert.equal(s.user.__v, 0); assert.equal(s.account.__v, 0); assert.equal(s.chat.__v, 0);
    assert.equal(s.account.cartRateCount, 2, "Admitted failure retains its separate rate charge");
  });
});

test("actual HTTP confirmation rejects changed saved-pet health context before returning success", async (t) => {
  const s = await cartProposalHttpFixture(t), petId = oid(), subjectId = `pet:${petId}`;
  s.pets = [{ _id: petId, __v: 0, petOwner: s.owner, name: "Cat", type: "cat", chronic_conditions: [], temp_health_issues: [] }];
  s.chat.activeSubject = subjectId; s.source.subjectId = subjectId; s.catalog.subjectId = subjectId;
  const prepared = await s.httpPrepare(); assert.equal(prepared.status, 201);
  s.onCartRefresh = () => { s.pets[0].chronic_conditions = ["Newly reported condition"]; };
  const rejected = await s.httpConfirm(prepared.body.data.proposal);
  assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, "context_changed");
  assert.equal(s.cart, null); assert.equal(s.receipts.length, 0); assert.equal(s.pets[0].__v, 0);
  assert.deepEqual(s.pets[0].chronic_conditions, []);
});

test("real HTTP authentication rejects guests and owned lookup hides a proposal stored under another owner", async (t) => {
  const s = await cartProposalHttpFixture(t);
  const guest = { "Content-Type": "application/json", "x-guest-id": "independent-guest" };
  const denied = await s.request("POST", "", s.body, guest);
  assert.equal(denied.status, 401); assert.equal(s.records.length, 0); assert.equal(s.account.cartRateCount, undefined);
  const prepared = await s.httpPrepare(); assert.equal(prepared.status, 201);
  const proposal = prepared.body.data.proposal; s.records[0].owner = oid(OTHER);
  const hidden = await s.httpStatus(proposal); assert.equal(hidden.status, 404);
  assert.equal(hidden.body.error.code, "cart_proposal_not_found"); assert.equal(hidden.body.data, undefined);
  const rejected = await s.httpConfirm(proposal); assert.equal(rejected.status, 404);
  assert.equal(rejected.body.error.code, "cart_proposal_not_found"); assert.equal(s.cartWrites, 0);
});

test("a dietary warning reported during HTTP confirmation prevents retaining an older food addition", async (t) => {
  const s = await cartProposalHttpFixture(t), petId = oid(), subjectId = `pet:${petId}`;
  s.pets = [{ _id: petId, __v: 0, petOwner: s.owner, name: "Cat", type: "cat", chronic_conditions: [], temp_health_issues: [] }];
  s.chat.activeSubject = subjectId; s.source.subjectId = subjectId; s.catalog.subjectId = subjectId; s.product.category = F;
  const prepared = await s.httpPrepare(); assert.equal(prepared.status, 201);
  s.onCartRefresh = () => { s.warnings = [{ _id: oid(), owner: s.owner, subjectId, state: "active", version: 1, text: "Avoid chicken" }]; };
  const rejected = await s.httpConfirm(prepared.body.data.proposal);
  assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, "food_review_required");
  assert.equal(s.cart, null); assert.equal(s.receipts.length, 0); assert.equal(s.account.cartRateCount, 2);
});

test("real HTTP confirmation preserves an admitted requote failure and serves recoverable pending state", async (t) => {
  const s = await cartProposalHttpFixture(t), prepared = await s.httpPrepare();
  const proposal = prepared.body.data.proposal; s.product.warehouseStocks = [{ warehouse: OTHER, quantity: 20 }];
  const changed = await s.httpConfirm(proposal); assert.equal(changed.status, 409);
  assert.equal(changed.body.error.code, "cart_requote_required"); assert.equal(s.cart, null); assert.equal(s.receipts.length, 0);
  const pending = await s.httpStatus(proposal); assert.equal(pending.status, 200);
  assert.equal(pending.body.data.proposal.status, "pending"); assert.equal(pending.body.data.receipt, null);
  assert.equal(s.account.cartRateCount, 3);
});

test("HTTP cart validation rejects malformed input before rate admission while retaining domain guards", async (t) => {
  const s = await cartProposalHttpFixture(t);
  const invalid = await s.request("POST", "", { ...s.body, quantity: "2" });
  assert.equal(invalid.status, 400); assert.equal(invalid.body.error.code, "invalid_request");
  assert.equal(s.account.cartRateCount, undefined); assert.equal(s.records.length, 0); assert.equal(s.cartWrites, 0);
  const prepared = await s.httpPrepare(); assert.equal(prepared.status, 201); assert.equal(s.account.cartRateCount, 1);
  const proposal = prepared.body.data.proposal;
  const invalidConfirmation = await s.httpConfirm(proposal, { expectedVersion: "1" });
  assert.equal(invalidConfirmation.status, 400); assert.equal(s.account.cartRateCount, 1); assert.equal(s.receipts.length, 0);
  const confirmed = await s.httpConfirm(proposal); assert.equal(confirmed.status, 200); assert.equal(s.account.cartRateCount, 2);
  assert.equal(s.cartWrites, 1);
});
