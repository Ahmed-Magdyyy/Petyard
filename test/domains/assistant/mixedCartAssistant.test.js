import test from "node:test";
import assert from "node:assert/strict";
import { cartProposalFixture, cartProposalHttpFixture, oid, W, P, OTHER, V } from "./fixtures/cartProposals.js";
import { CartModel } from "../../../src/domains/cart/cart.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { ManualBundle } from "../../../src/domains/bundle/bundle.model.js";
import { LoyaltySettingsModel } from "../../../src/domains/loyalty/loyaltySettings.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { previewUserCheckoutService } from "../../../src/domains/checkout/checkout.preview.js";
import { buildCheckoutSnapshot, storedCheckoutDto } from "../../../src/domains/assistant/customer/assistant.checkout-cards.js";

const B = "777777777777777777777777", G = "888888888888888888888888";
const plain = value => JSON.parse(JSON.stringify(value));

function mixed(t, s = cartProposalFixture(t, { confirmation: true })) {
  const previous = process.env.ASSISTANT_BUNDLE_CART_ENABLED;
  process.env.ASSISTANT_BUNDLE_CART_ENABLED = "true";
  t.after(() => { if (previous === undefined) delete process.env.ASSISTANT_BUNDLE_CART_ENABLED; else process.env.ASSISTANT_BUNDLE_CART_ENABLED = previous; });
  s.user.role = "user"; s.user.walletBalance = 30;
  s.definition = { _id: B, origin: "manual", status: "published", revision: 2, name_en: "Pair", name_ar: "طقم",
    pricePiastres: 15000, components: [{ productId: P, productType: "SIMPLE", variantId: null, quantity: 2 }] };
  s.cart = new CartModel({ user: s.owner, warehouse: W, currency: "EGP", __v: 7, checkoutKey: "keep-key", items: [],
    bundles: [{ id: G, bundleId: B, bundleRevision: 2, quantity: 1, unitPricePiastres: 15000 }], totalCartPrice: 150 }).toObject();
  s.warehouse = { _id: W, active: true, defaultShippingPrice: 50, primeShippingPrice: 20 };
  const query = read => {
    let session;
    return { select() { return this; }, maxTimeMS() { return this; }, session(value) { session = value; return this; }, lean() { return this; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        if (s.confirming) assert.equal(session, s.session, "confirmation reads must share the caller's transaction");
        return read();
      }).then(resolve, reject); } };
  };
  t.mock.method(ManualBundle, "find", () => query(() => [s.definition]));
  t.mock.method(ProductModel, "find", () => query(() => { s.onGroupedRead?.(); return [s.product]; }));
  t.mock.method(WarehouseModel, "findById", id => query(() => String(id) === W ? s.warehouse : null));
  t.mock.method(LoyaltySettingsModel, "findOne", () => query(() => ({ isActive: true, pointsEarnRate: 1 })));
  s.preview = () => previewUserCheckoutService({ userId: String(s.owner), warehouseId: W, lang: "en" });
  s.address = () => { s.cart.deliveryAddress = { name: "Test", governorate: "Alexandria", phone: "01012345678", building: "1", floor: "2",
    apartment: "3", details: "Fixture", warehouse: oid(W), location: { lat: 31, lng: 30 } }; };
  return s;
}

test("ordinary product preparation and its existing confirmation/receipt include bundles without another cart flow", async t => {
  const s = mixed(t), before = plain(s.cart), prepared = await s.prepare();
  const q = prepared.proposal.quote;
  assert.deepEqual(plain(s.cart), before); assert.equal(s.cartWrites, 0);
  assert.equal(q.itemsBefore.length, 0); assert.equal(q.itemsAfter[0].quantity, 2);
  assert.equal(q.addition.productId, P); assert.equal(q.addition.quantityAfter, 2);
  assert.equal(q.itemsSubtotalAfter, 350); assert.equal(q.bundles[0].id, G); assert.equal(q.bundles[0].itemPrice, 150);
  assert.doesNotMatch(JSON.stringify(q.bundles), /Piastres|allocations|demands|patch|owner/);
  const result = await s.confirm(prepared.proposal);
  assert.equal(result.receipt.result.itemsSubtotalAfter, 350); assert.equal(result.receipt.cartId, String(s.cart._id));
  assert.deepEqual(plain(s.cart.bundles), before.bundles); assert.equal(s.cart.items[0].quantity, 2);
  assert.equal(s.cart.totalCartPrice, 350); assert.equal(s.cart.checkoutKey, "keep-key"); assert.equal(s.cart.__v, 8);
  s.catalog.products = []; s.source.expiresAt = new Date(0); s.product.warehouseStocks = [];
  assert.equal((await s.confirm(prepared.proposal)).duplicate, true); assert.equal(s.cartWrites, 1);
});

test("the normal HTTP product request and two-field confirmation recover mixed-cart results without duplicate increments", async t => {
  const s = mixed(t, await cartProposalHttpFixture(t));
  const response = await s.httpPrepare(); assert.equal(response.status, 201, JSON.stringify(response.body));
  const proposal = response.body.data.proposal; assert.equal(proposal.quote.bundles[0].bundleId, B);
  const confirmed = await s.httpConfirm(proposal); assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.data.receipt.result.itemsSubtotalAfter, 350); assert.equal(s.cartWrites, 1);
  const recovered = await s.httpStatus(proposal); assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.body.data.receipt, confirmed.body.data.receipt);
  assert.equal((await s.httpConfirm(proposal)).body.data.duplicate, true); assert.equal(s.cart.items[0].quantity, 2);
});

test("combined demand includes ordinary units plus the fixed components in the exact selected warehouse", async t => {
  const s = mixed(t); s.product.warehouseStocks = [{ warehouse: W, quantity: 3 }, { warehouse: OTHER, quantity: 100 }];
  await assert.rejects(s.prepare(), /stock/i); assert.equal(s.cartWrites, 0); assert.equal(s.records.length, 0);
  s.product.warehouseStocks[0].quantity = 4; const result = await s.prepare();
  assert.equal(result.proposal.quote.itemsSubtotalAfter, 350);
});

test("exact variants share their demand while another variant's stock cannot supply a shortage", async t => {
  const s = mixed(t); s.product.type = "VARIANT";
  s.product.variants = [{ _id: oid(V), price: 100, options: [{ name: "Color", value: "Blue" }], warehouseStocks: [{ warehouse: W, quantity: 3 }] },
    { _id: oid(OTHER), price: 1, options: [], warehouseStocks: [{ warehouse: W, quantity: 100 }] }];
  s.catalog.products[0].type = "VARIANT"; s.catalog.products[0].hasVariants = true;
  s.body.variantId = V; Object.assign(s.definition.components[0], { productType: "VARIANT", variantId: V });
  await assert.rejects(s.prepare(), /stock/i);
  s.product.variants[0].warehouseStocks[0].quantity = 4;
  const prepared = await s.prepare(); assert.equal(prepared.proposal.quote.addition.variantId, V);
  await s.confirm(prepared.proposal); assert.equal(String(s.cart.items[0].variantId), V); assert.equal(s.cart.totalCartPrice, 350);
});

for (const changed of ["stock", "revision", "price", "paused", "warehouse", "flag"]) test(`first ordinary confirmation rejects changed bundle ${changed}`, async t => {
  const s = mixed(t); const prepared = await s.prepare(), before = plain(s.cart);
  if (changed === "stock") s.product.warehouseStocks[0].quantity = 3;
  if (changed === "revision") s.definition.revision++;
  if (changed === "price") s.definition.pricePiastres++;
  if (changed === "paused") s.definition.status = "paused";
  if (changed === "warehouse") s.cart.warehouse = oid(OTHER);
  if (changed === "flag") process.env.ASSISTANT_BUNDLE_CART_ENABLED = "false";
  await assert.rejects(s.confirm(prepared.proposal)); assert.equal(s.cartWrites, 0); assert.equal(s.receipts.length, 0);
  if (changed !== "warehouse") assert.deepEqual(plain(s.cart), before);
});

test("bundle-only checkout estimate is nonempty, read only, and uses the same shipping/wallet/loyalty calculation", async t => {
  const s = mixed(t); s.address(); const before = plain(s.cart), result = await s.preview();
  assert.equal(result.status, "summary"); assert.equal(result.items.length, 0); assert.equal(result.bundles[0].bundleId, B);
  assert.deepEqual(result.pricing, { subtotal: 150, shippingFee: 50, discountAmount: 0, shippingDiscount: 0, totalDiscount: 0,
    total: 200, walletBalance: 30, walletUsed: 30, finalTotal: 170, loyaltyPoints: 150 });
  assert.equal(result.action.type, "open_checkout"); assert.deepEqual(plain(s.cart), before); assert.equal(s.cartWrites, 0);
  const snapshot = buildCheckoutSnapshot(result, W);
  assert.equal(snapshot.bundles, undefined); assert.equal(snapshot.items, undefined); assert.equal(snapshot.deliveryAddress, undefined);
  assert.deepEqual(storedCheckoutDto(JSON.stringify(snapshot)), snapshot);
});

test("a missing address leaves combined shipping/final totals unknown and provides existing checkout navigation", async t => {
  const s = mixed(t); const prepared = await s.prepare(); await s.confirm(prepared.proposal);
  const result = await s.preview(); assert.equal(result.status, "needs_address"); assert.equal(result.pricing.subtotal, 350);
  assert.equal(result.pricing.shippingFee, null); assert.equal(result.pricing.total, null); assert.equal(result.pricing.finalTotal, null);
  assert.equal(result.addressComplete, false); assert.equal(result.action.type, "open_checkout");
});

test("ordinary refresh differences require review without persisting changes to items or bundles", async t => {
  const s = mixed(t); s.cart.items = new CartModel({ items: [{ product: P, productType: "SIMPLE", quantity: 1, itemPrice: 90 }] }).items.toObject();
  s.cart.totalCartPrice = 240; s.address(); const before = plain(s.cart);
  const result = await s.preview(); assert.equal(result.status, "review_cart"); assert.equal(result.cartChanged, true);
  assert.equal(result.pricing.subtotal, 250); assert.deepEqual(plain(s.cart), before); assert.equal(s.cartWrites, 0);
});

test("bundle value counts toward normal free shipping and wallet covers merchandise only", async t => {
  const s = mixed(t); s.cart.bundles[0].quantity = 20; s.cart.totalCartPrice = 3000; s.product.warehouseStocks[0].quantity = 50;
  s.user.walletBalance = 5000; s.address(); const result = await s.preview();
  assert.equal(result.pricing.subtotal, 3000); assert.equal(result.pricing.shippingFee, 0);
  assert.equal(result.pricing.walletUsed, 3000); assert.equal(result.pricing.finalTotal, 0); assert.equal(result.pricing.loyaltyPoints, 3000);
});

test("checkout fails closed for stock/definition/warehouse conflicts and disabled bundles without a partial estimate", async t => {
  const s = mixed(t); s.address(); const before = plain(s.cart);
  s.product.warehouseStocks[0].quantity = 1; await assert.rejects(s.preview()); s.product.warehouseStocks[0].quantity = 10;
  s.definition.status = "paused"; await assert.rejects(s.preview()); s.definition.status = "published";
  s.cart.warehouse = oid(OTHER); await assert.rejects(s.preview()); s.cart.warehouse = oid(W);
  process.env.ASSISTANT_BUNDLE_CART_ENABLED = "false"; await assert.rejects(s.preview());
  assert.deepEqual(plain(s.cart), before); assert.equal(s.cartWrites, 0);
});

test("the existing authenticated checkout HTTP route returns bundle display entries and no address or payment details", async t => {
  const s = mixed(t, await cartProposalHttpFixture(t)); s.address();
  const response = await fetch(`${s.checkoutUrl}?warehouseId=${W}&language=en`, { headers: s.httpHeaders });
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.data.bundles[0].productName, "Pair"); assert.equal(body.data.pricing.subtotal, 150);
  assert.equal(body.data.deliveryAddress, undefined); assert.equal(body.data.checkoutKey, undefined);
  assert.doesNotMatch(JSON.stringify(body), /Piastres|allocations|clientSecret|Keep address/); assert.equal(s.cartWrites, 0);
});
