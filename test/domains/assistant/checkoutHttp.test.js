import assert from "node:assert/strict";
import test from "node:test";
import { CartModel } from "../../../src/domains/cart/cart.model.js";
import { LoyaltySettingsModel } from "../../../src/domains/loyalty/loyaltySettings.model.js";
import { cartProposalHttpFixture, W, P, OTHER } from "./fixtures/cartProposals.js";

async function fixture(t) {
  const state = await cartProposalHttpFixture(t);
  state.cart = new CartModel({ user: state.owner, warehouse: W, __v: 0, checkoutKey: "keep",
    items: [{ product: P, productType: "SIMPLE", quantity: 2, itemPrice: 100 }], totalCartPrice: 200 }).toObject();
  t.mock.method(LoyaltySettingsModel, "findOne", () => ({ select() { return this; }, async lean() { return null; } }));
  t.mock.method(LoyaltySettingsModel, "create", () => assert.fail("Summary must not initialize loyalty"));
  state.checkout = async (query = `warehouseId=${W}&language=en`, headers = state.httpHeaders) => {
    const before = JSON.stringify(state.cart);
    const response = await fetch(`${state.checkoutUrl}?${query}`, { headers });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(JSON.stringify(state.cart), before); assert.equal(state.cartWrites, 0);
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return state;
}

test("real authenticated assistant checkout GET returns a no-address estimate and semantic action without cart writes", async (t) => {
  const s = await fixture(t), response = await s.checkout();
  assert.equal(response.status, 200); assert.equal(response.body.data.status, "needs_address");
  assert.equal(response.body.data.pricing.subtotal, 200); assert.equal(response.body.data.pricing.finalTotal, null);
  assert.deepEqual(response.body.data.action, { type: "open_checkout", cartId: String(s.cart._id), warehouseId: W });
  assert.equal(s.account.cartRateCount, 1); assert.equal(s.cart.checkoutKey, "keep");
});

test("checkout route rejects guests and invalid input, shares the off switch and respects assistant restriction", async (t) => {
  const s = await fixture(t);
  const guest = await s.checkout(undefined, { "x-guest-id": "guest" }); assert.equal(guest.status, 401);
  for (const query of [`warehouseId=${W}`, `warehouseId=${W}&language=arabizi`, `warehouseId=bad&language=en`,
    `warehouseId=${W}&language=en&isPrimeLocation=true`, `warehouseId=${W}&language=en&couponCode=TEST`,
    `warehouseId=${W}&warehouseId=${OTHER}&language=en`]) {
    const rejected = await s.checkout(query); assert.equal(rejected.status, 400); assert.equal(rejected.body.error.code, "invalid_request");
    assert.equal(rejected.body.error.value, undefined); assert.equal(rejected.body.errors, undefined);
  }
  assert.equal(s.account.cartRateCount, undefined);
  s.apiConfig.cartEnabled = false; const disabled = await s.checkout(); assert.equal(disabled.status, 503);
  assert.equal(disabled.body.error.code, "cart_actions_unavailable"); assert.equal(s.account.cartRateCount, undefined);
  s.apiConfig.cartEnabled = true; s.account.blocked = true;
  const blocked = await s.checkout(); assert.equal(blocked.status, 403); assert.equal(blocked.body.error.code, "ai_restricted");
});

test("checkout reads share cart rate admission, allow an active chat run and surface warehouse conflicts safely", async (t) => {
  const s = await fixture(t); s.account.activeRun = OTHER;
  const allowed = await s.checkout(); assert.equal(allowed.status, 200);
  s.cart.warehouse = OTHER;
  const changed = await s.checkout(); assert.equal(changed.status, 409); assert.equal(changed.body.error.code, "cart_requote_required");
  assert.equal(s.account.cartRateCount, 2);
  s.apiConfig.cartPolicy.rateMax = 2;
  const limited = await s.checkout(); assert.equal(limited.status, 429); assert.equal(limited.body.error.code, "cart_request_rate_limit");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
});
