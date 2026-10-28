import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { readFileSync } from "node:fs";
import { previewUserCheckoutService } from "../../../src/domains/checkout/checkout.preview.js";
import { CartModel } from "../../../src/domains/cart/cart.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { CollectionModel } from "../../../src/domains/collection/collection.model.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { LoyaltySettingsModel } from "../../../src/domains/loyalty/loyaltySettings.model.js";

const U = "111111111111111111111111", W = "222222222222222222222222", P = "333333333333333333333333";
const V = "444444444444444444444444", OTHER = "555555555555555555555555";
const plain = (value) => JSON.parse(JSON.stringify(value));
function fixture(t) {
  const state = { user: { walletBalance: 30 }, settings: { isActive: true, pointsEarnRate: 1 },
    warehouse: { _id: W, active: true, fulfillment: { status: "OPERATIONAL" }, defaultShippingPrice: 50,
      primeShippingPrice: 20, boundaryGeometry: { type: "Polygon", coordinates: [[[30, 29], [32, 29], [32, 32], [30, 32], [30, 29]]] },
      primeBoundaryGeometry: { type: "MultiPolygon", coordinates: [[[[30.5, 29.5], [31.5, 29.5], [31.5, 31.5], [30.5, 31.5], [30.5, 29.5]]]] } },
    product: { _id: P, type: "SIMPLE", isActive: true, price: 100, images: [], name_en: "Toy", name_ar: "لعبة",
      warehouseStocks: [{ warehouse: W, quantity: 100 }] } };
  state.cart = new CartModel({ user: U, warehouse: W, __v: 7, checkoutKey: "keep-key", items: [
    { product: P, productType: "SIMPLE", quantity: 3, itemPrice: 100 }], totalCartPrice: 300,
    deliveryAddress: { warehouse: OTHER, name: "Test", governorate: "Cairo", phone: "01012345678", building: "1", floor: "2",
      apartment: "3", details: "Fixture", location: { lat: 30, lng: 31 } } }).toObject();
  const query = (read) => ({ select() { return this; }, lean() { return Promise.resolve().then(read); },
    then(resolve, reject) { return Promise.resolve().then(read).then(resolve, reject); } });
  t.mock.method(CartModel, "findOne", (filter) => { assert.deepEqual(filter, { user: U }); return query(() => state.cart); });
  t.mock.method(WarehouseModel, "findById", (id) => { assert.equal(String(id), W); return query(() => state.warehouse); });
  t.mock.method(ProductModel, "find", (filter) => {
    assert.ok(filter._id.$in.every((id) => String(id) === P)); return query(() => [state.product]);
  });
  t.mock.method(CollectionModel, "findOne", () => query(() => null));
  t.mock.method(UserModel, "findById", (id) => { assert.equal(String(id), U); return query(() => state.user); });
  t.mock.method(LoyaltySettingsModel, "findOne", () => query(() => state.settings));
  for (const Model of Object.values(mongoose.models)) {
    for (const method of ["create", "insertMany", "updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany", "bulkWrite", "createCollection", "createIndexes"]) {
      if (typeof Model[method] === "function") t.mock.method(Model, method, () => assert.fail("Checkout preview must not write or initialize any model"));
    }
    t.mock.method(Model.prototype, "save", () => assert.fail("Checkout preview must not save any document"));
  }
  state.preview = async (changes = {}) => {
    const before = plain(state.cart);
    try { return await previewUserCheckoutService({ userId: U, warehouseId: W, lang: "en", ...changes }); }
    finally { assert.deepEqual(plain(state.cart), before, "The persisted source snapshot must remain unchanged"); }
  };
  return state;
}

test("read-only summary uses ordinary no-coupon shipping/wallet/loyalty rules without modifying cart or keys", async (t) => {
  const s = fixture(t), result = await s.preview();
  assert.equal(result.status, "summary"); assert.equal(result.isPrimeLocation, false);
  assert.equal(result.dataMode, "estimate"); assert.equal(result.requiresCheckoutRefresh, true);
  assert.deepEqual(result.pricing, { subtotal: 300, shippingFee: 50, discountAmount: 0, shippingDiscount: 0,
    totalDiscount: 0, total: 350, walletBalance: 30, walletUsed: 30, finalTotal: 320, loyaltyPoints: 300 });
  assert.deepEqual(result.action, { type: "open_checkout", cartId: String(s.cart._id), warehouseId: W });
  assert.equal(result.deliveryAddress, undefined); assert.equal(s.cart.checkoutKey, "keep-key"); assert.equal(s.cart.__v, 7);
});

test("missing or incomplete address preserves checkout navigation and does not guess shipping or final total", async (t) => {
  const s = fixture(t);
  for (const address of [undefined, { name: "Partial" }, { ...s.cart.deliveryAddress, location: { lat: NaN, lng: 31 } }]) {
    s.cart.deliveryAddress = address;
    const result = await s.preview(); assert.equal(result.status, "needs_address"); assert.equal(result.addressComplete, false);
    assert.equal(result.pricing.subtotal, 300); assert.equal(result.pricing.shippingFee, null);
    assert.equal(result.pricing.total, null); assert.equal(result.pricing.finalTotal, null); assert.equal(result.isPrimeLocation, null);
    assert.equal(result.action.type, "open_checkout");
  }
});

test("Prime eligibility is recomputed from the stored delivery zone and current geometry", async (t) => {
  const s = fixture(t); s.cart.deliveryAddress.warehouse = new mongoose.Types.ObjectId(W);
  let result = await s.preview(); assert.equal(result.isPrimeLocation, true); assert.equal(result.pricing.shippingFee, 20);
  s.cart.deliveryAddress.warehouse = new mongoose.Types.ObjectId(OTHER);
  result = await s.preview(); assert.equal(result.isPrimeLocation, false); assert.equal(result.pricing.shippingFee, 50);
});

test("free shipping threshold and wallet deduction remain item-only", async (t) => {
  const s = fixture(t); s.cart.items[0].quantity = 30; s.cart.totalCartPrice = 3000; s.user.walletBalance = 5000;
  let result = await s.preview(); assert.equal(result.pricing.shippingFee, 0); assert.equal(result.pricing.walletUsed, 3000);
  assert.equal(result.pricing.finalTotal, 0);
  s.cart.items[0].quantity = 3; s.cart.totalCartPrice = 300;
  result = await s.preview(); assert.equal(result.pricing.walletUsed, 300); assert.equal(result.pricing.finalTotal, 50);
});

test("remote-only stock and inactive products are removed from the draft with a cart-review action", async (t) => {
  const s = fixture(t);
  for (const change of [() => { s.product.warehouseStocks = [{ warehouse: OTHER, quantity: 100 }]; },
    () => { s.product.warehouseStocks = [{ warehouse: W, quantity: 100 }]; s.product.isActive = false; }]) {
    change(); const result = await s.preview(); assert.equal(result.status, "review_cart"); assert.equal(result.cartChanged, true);
    assert.equal(result.items.length, 0); assert.equal(result.removedItems.length, 1); assert.equal(result.pricing, null);
    assert.equal(result.action.type, "open_cart");
  }
});

test("fresh prices flag review and retain persisted items and subtotal", async (t) => {
  const s = fixture(t); s.product.price = 120;
  const result = await s.preview(); assert.equal(result.status, "review_cart"); assert.equal(result.pricing.subtotal, 360);
  assert.equal(result.pricing.finalTotal, 380); assert.equal(s.cart.totalCartPrice, 300); assert.equal(s.cart.items[0].itemPrice, 100);
});

test("missing and empty carts do not create a cart, select an address or initialize loyalty settings", async (t) => {
  const s = fixture(t); s.cart.items = []; let result = await s.preview();
  assert.equal(result.status, "empty_cart"); assert.equal(result.pricing, null); assert.equal(result.action, null);
  s.cart = null; result = await s.preview(); assert.equal(result.status, "missing_cart"); assert.equal(result.cartId, null);
  assert.equal(result.action, null); assert.equal(result.pricing, null);
});

test("warehouse mismatches and invalid quantities/prices fail closed within the preview only", async (t) => {
  const s = fixture(t); const original = s.cart.warehouse;
  s.cart.warehouse = new mongoose.Types.ObjectId(OTHER); await assert.rejects(s.preview(), { statusCode: 409 }); s.cart.warehouse = original;
  s.cart.items[0].quantity = 1.5; await assert.rejects(s.preview(), { statusCode: 409 }); s.cart.items[0].quantity = 3;
  s.product.price = -1; await assert.rejects(s.preview(), { statusCode: 409 });
  s.product.price = 100; s.product.discountedPrice = 101; await assert.rejects(s.preview(), { statusCode: 409 });
  await assert.rejects(s.preview({ warehouseId: "bad" }), { statusCode: 400 });
});

test("missing loyalty settings produce an unknown estimate without creating defaults", async (t) => {
  const s = fixture(t); s.settings = null; let result = await s.preview(); assert.equal(result.pricing.loyaltyPoints, null);
  s.settings = { isActive: false }; result = await s.preview(); assert.equal(result.pricing.loyaltyPoints, 0);
  s.user.walletBalance = "unverified"; await assert.rejects(s.preview(), { statusCode: 503 });
});

test("zero subtotal follows checkout's positive-subtotal requirement and requires normal cart review", async (t) => {
  const s = fixture(t); s.product.price = 0;
  const result = await s.preview(); assert.equal(result.status, "review_cart"); assert.equal(result.pricing, null);
  assert.equal(result.action.type, "open_cart");
});

test("variant pricing and stock use only the cart's exact variant in the requested warehouse", async (t) => {
  const s = fixture(t); s.product.type = "VARIANT";
  s.product.variants = [{ _id: new mongoose.Types.ObjectId(V), price: 250, options: [], warehouseStocks: [{ warehouse: W, quantity: 10 }] },
    { _id: new mongoose.Types.ObjectId(OTHER), price: 1, options: [], warehouseStocks: [{ warehouse: W, quantity: 100 }] }];
  Object.assign(s.cart.items[0], { productType: "VARIANT", variantId: new mongoose.Types.ObjectId(V), quantity: 2, itemPrice: 250 });
  s.cart.totalCartPrice = 500;
  let result = await s.preview(); assert.equal(result.pricing.subtotal, 500); assert.equal(String(result.items[0].variantId), V);
  s.product.variants[0].warehouseStocks = [{ warehouse: OTHER, quantity: 10 }];
  result = await s.preview(); assert.equal(result.items.length, 0); assert.equal(result.status, "review_cart");
});

test("saved checkout examples match actual response field shapes and the local request has no stored credentials", async (t) => {
  const examples = JSON.parse(readFileSync(new URL("./fixtures/contracts/assistant-checkout-examples.json", import.meta.url), "utf8"));
  const shape = (value) => value === null ? "null" : Array.isArray(value) ? value.map(shape) : typeof value === "object" ?
    Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])])) : typeof value;
  const s = fixture(t); assert.deepEqual(shape({ data: plain(await s.preview()) }), shape(examples.summaryResponse));
  s.cart.deliveryAddress = undefined;
  assert.deepEqual(shape({ data: plain(await s.preview()) }), shape(examples.needsAddressResponse));
  s.cart = null; assert.deepEqual(shape({ data: plain(await s.preview()) }), shape(examples.missingCartResponse));
  const collection = JSON.parse(readFileSync(new URL("./fixtures/contracts/AssistantCheckout.postman_collection.json", import.meta.url), "utf8"));
  assert.equal(collection.auth.type, "bearer"); assert.equal(collection.variable.find(({ key }) => key === "accessToken").value, "");
  assert.equal(collection.item.length, 4); assert.equal(collection.item[0].request.method, "GET");
  const chat = collection.item.find((item) => item.request.method === "POST");
  assert.equal(chat.request.url, "{{baseUrl}}/api/v1/assistant/messages");
  assert.equal(collection.variable.find((value) => value.key === "messageKey").value, "");
  assert.match(chat.event.find((event) => event.listen === "prerequest").script.exec.join("\n"), /if \(!pm.variables.get\('messageKey'\)\) throw/);
  assert.ok(collection.item.some((item) => item.request.url === "{{baseUrl}}/api/v1/assistant/runs/{{runId}}"));
  assert.ok(collection.item.some((item) => item.request.url === "{{baseUrl}}/api/v1/assistant/messages?limit=20"));
  assert.equal(collection.item[0].request.url, "{{baseUrl}}/api/v1/assistant/checkout-summary?warehouseId={{warehouseId}}&language={{language}}");
  for (const response of collection.item[0].response) assert.deepEqual(JSON.parse(response.body), examples[response.name]);
});
