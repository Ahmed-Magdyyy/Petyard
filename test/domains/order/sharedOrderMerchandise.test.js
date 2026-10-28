import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { fixture, U, W, P, B, G, OTHER, clone } from "../bundle/fixtures/bundleCartTransaction.js";
import { buildOrderItemsWithPromotions, createOrderForUserService } from "../../../src/domains/order/order.service.js";
import { presentOrder } from "../../../src/domains/order/order.presenter.js";
import { assertBundleOrderSnapshot } from "../../../src/domains/bundle/bundle.order-snapshot.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { CollectionModel } from "../../../src/domains/collection/collection.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { CartModel } from "../../../src/domains/cart/cart.model.js";

function setup(t, { ordinary = true } = {}) {
  const s = fixture(t, { ordinary });
  const previous = process.env.ASSISTANT_BUNDLE_CART_ENABLED;
  process.env.ASSISTANT_BUNDLE_CART_ENABLED = "true";
  t.after(() => { if (previous === undefined) delete process.env.ASSISTANT_BUNDLE_CART_ENABLED; else process.env.ASSISTANT_BUNDLE_CART_ENABLED = previous; });
  s.cart.bundles = [{ id: G, bundleId: B, bundleRevision: 2, quantity: 2, unitPricePiastres: 1500 }];
  if (ordinary) s.cart.items[0].itemPrice = 10;
  const query = read => { let session; return { select() { return this; }, lean() { return this; },
    session(value) { session = value; return this; }, maxTimeMS() { return this; },
    then(resolve, reject) { return Promise.resolve().then(() => read(session)).then(resolve, reject); } }; };
  t.mock.method(ProductModel, "find", filter => query(session => {
    assert.equal(session, s.session);
    if (filter.$or) {
      assert.equal(filter.isActive, true);
      assert.equal(String(filter.$or[0].warehouseStocks.$elemMatch.warehouse), s.expectedWarehouseId ?? W);
      assert.equal(String(filter.$or[1].variants.$elemMatch.warehouseStocks.$elemMatch.warehouse), s.expectedWarehouseId ?? W);
    }
    return s.products.filter(row => filter._id.$in.some(id => String(row._id) === String(id)) && (!filter.isActive || row.isActive));
  }));
  t.mock.method(CollectionModel, "findOne", () => query(() => s.promotion ?? null));
  s.maintenance = 0;
  t.mock.method(CollectionModel, "updateMany", async () => { s.maintenance++; return { modifiedCount: 0 }; });
  t.mock.method(WarehouseModel, "findOne", () => assert.fail("Merchandise must never select a fallback warehouse"));
  t.mock.method(ProductModel.prototype, "save", () => assert.fail("Preparing merchandise must not change stock"));
  t.mock.method(UserModel, "updateOne", () => assert.fail("Preparing merchandise must not change wallet balances"));
  t.mock.method(OrderModel, "create", () => assert.fail("Preparing merchandise must not place an order"));
  t.mock.method(mongoose, "connect", () => assert.fail("No real database connection"));
  t.mock.method(globalThis, "fetch", () => assert.fail("No provider calls"));
  s.prepare = changes => buildOrderItemsWithPromotions({ cart: clone(s.cart), session: s.session, lang: "en", ...changes });
  s.capture = () => clone({ cart: s.cart, user: s.user, products: s.products, definitions: s.definitions, receipts: s.receipts });
  s.order = result => ({ _id: new mongoose.Types.ObjectId(OTHER), user: U, warehouse: s.cart.warehouse,
    currency: "EGP", items: result.orderItems, subtotal: result.subtotal, bundleGroups: result.bundleGroups });
  return s;
}

test("shared order preparation prices one mixed cart and keeps component allocations private", async t => {
  const s = setup(t), before = s.capture(), result = await s.prepare();
  assert.equal(result.subtotal, 50); assert.equal(result.hasPromotionalItems, false);
  assert.equal(result.orderItems.filter(row => row.bundleGroupId == null).length, 1);
  assert.equal(result.orderItems.filter(row => row.bundleGroupId === G).reduce((sum, row) => sum + row.quantity, 0), 4);
  assert.equal(result.orderItems.reduce((sum, row) => sum + row.lineTotalPiastres, 0), 5000);
  assert.equal(result.productById.get(P).price, 10);
  assertBundleOrderSnapshot(s.order(result));
  const response = presentOrder(s.order(result));
  assert.equal(response.items.length, 1); assert.equal(response.bundles.length, 1);
  assert.equal(response.bundles[0].itemPrice, 15); assert.equal(response.bundles[0].quantity, 2);
  assert.equal(response.bundleGroups, undefined); assert.equal(response.bundleCheckout, undefined);
  assert.deepEqual(s.capture(), before); assert.deepEqual(s.writes, []); assert.equal(s.maintenance, 0);
});

test("bundle-only merchandise is nonempty and does not require ordinary product pricing", async t => {
  const s = setup(t, { ordinary: false }), result = await s.prepare();
  assert.equal(result.subtotal, 30); assert.equal(result.productById.size, 0);
  assert.ok(result.orderItems.every(row => row.bundleGroupId === G));
  assert.equal(presentOrder(s.order(result)).items.length, 0); assert.equal(s.maintenance, 0);
});

test("ordinary-only preparation retains its response shape, promotion maintenance and empty-cart error", async t => {
  const s = setup(t); delete s.cart.bundles;
  for (const bundles of [undefined, []]) {
    s.cart.bundles = bundles;
    const result = await s.prepare();
    assert.equal(result.subtotal, 20); assert.equal(result.orderItems.length, 1);
    assert.equal(result.bundleGroups, undefined); assert.equal(result.orderItems[0].bundleGroupId, undefined);
    assert.equal(result.orderItems[0].quantity, 2); assert.equal(result.orderItems[0].itemPrice, 10);
  }
  assert.equal(s.maintenance, 2);
  s.cart.items = []; await assert.rejects(s.prepare(), { statusCode: 400, message: "Cart is empty" });
});

test("ordinary promotions and manual discounts do not reduce the agreed bundle selling price", async t => {
  const s = setup(t); s.cart.items[0].itemPrice = 8;
  s.promotion = { _id: new mongoose.Types.ObjectId(OTHER), slug: "ordinary-sale", promotion: { discountPercent: 20 } };
  const promoted = await s.prepare();
  assert.equal(promoted.subtotal, 46); assert.equal(promoted.hasPromotionalItems, true);
  assert.equal(promoted.bundleGroups[0].unitPricePiastres, 1500);
  assert.equal(promoted.orderItems.find(row => !row.bundleGroupId).itemPrice, 8);
  assert.ok(promoted.orderItems.filter(row => row.bundleGroupId).every(row => row.promotion == null));
  s.promotion = null; s.products[0].discountedPrice = 8;
  const discounted = await s.prepare(); assert.equal(discounted.subtotal, 46);
  assert.equal(discounted.hasPromotionalItems, false); assert.equal(discounted.bundleGroups[0].unitPricePiastres, 1500);
});

test("stale ordinary prices or missing ordinary products require review rather than silent removal", async t => {
  const s = setup(t), before = s.capture(); s.cart.items[0].itemPrice = 7;
  await assert.rejects(s.prepare(), { statusCode: 409 });
  s.cart.items[0].itemPrice = 10; s.products[0].isActive = false;
  await assert.rejects(s.prepare(), { statusCode: 409 });
  s.products[0].isActive = true;
  assert.deepEqual(s.capture(), before); assert.deepEqual(s.writes, []); assert.equal(s.maintenance, 0);
});

test("saved bundle price, revision, publication and exact group identity are revalidated", async t => {
  const s = setup(t), saved = s.capture();
  const changes = [
    () => { s.definitions[0].pricePiastres = 1400; },
    () => { s.definitions[0].revision++; },
    () => { s.definitions[0].status = "paused"; },
    () => { s.cart.bundles.push(clone(s.cart.bundles[0])); },
    () => { s.definitions = []; },
  ];
  for (const change of changes) {
    Object.assign(s, clone(saved)); change(); await assert.rejects(s.prepare(), { statusCode: 409 });
    assert.deepEqual(s.writes, []);
  }
});

test("mixed and multiple bundles share the same exact SKU stock instead of checking each entry separately", async t => {
  const s = setup(t); s.products[0].warehouseStocks[0].quantity = 5;
  s.products[0].warehouseStocks.push({ warehouse: OTHER, quantity: 1000 });
  await assert.rejects(s.prepare(), { statusCode: 409 });
  s.products[0].warehouseStocks[0].quantity = 6; assert.equal((await s.prepare()).subtotal, 50);
  const second = clone(s.definitions[0]); second._id = OTHER; s.definitions.push(second);
  s.cart.bundles.push({ ...s.cart.bundles[0], id: "aaaaaaaaaaaaaaaaaaaaaaaa", bundleId: OTHER });
  await assert.rejects(s.prepare(), { statusCode: 409 }); assert.deepEqual(s.writes, []);
});

test("the four warehouses qualify only where all component stock exists", async t => {
  const s = setup(t, { ordinary: false }), ids = [W, "888888888888888888888888", "999999999999999999999999", "aaaaaaaaaaaaaaaaaaaaaaaa"];
  s.warehouses = ids.map(_id => ({ _id, active: true }));
  s.products = [{ ...s.products[0], warehouseStocks: [0, 1, 3].map(index => ({ warehouse: ids[index], quantity: 10 })) },
    { ...s.products[0], _id: OTHER, warehouseStocks: [1, 2, 3].map(index => ({ warehouse: ids[index], quantity: 10 })) }];
  s.definitions[0].components = [{ productId: P, productType: "SIMPLE", quantity: 1 }, { productId: OTHER, productType: "SIMPLE", quantity: 1 }];
  for (const [index, id] of ids.entries()) {
    s.cart.warehouse = new mongoose.Types.ObjectId(id); s.expectedWarehouseId = id;
    if ([1, 3].includes(index)) assert.equal((await s.prepare()).bundleGroups[0].warehouseId, id);
    else await assert.rejects(s.prepare(), { statusCode: 409 });
  }
});

test("variant components require the selected variant in the selected warehouse", async t => {
  const s = setup(t, { ordinary: false }), variant = "bbbbbbbbbbbbbbbbbbbbbbbb";
  s.products[0] = { _id: P, type: "VARIANT", isActive: true, name_en: "Food", variants: [
    { _id: variant, price: 10, options: [{ name: "Size", value: "Small" }], warehouseStocks: [{ warehouse: W, quantity: 4 }] },
    { _id: OTHER, price: 10, warehouseStocks: [{ warehouse: W, quantity: 1000 }] }] };
  s.definitions[0].components[0] = { productId: P, productType: "VARIANT", variantId: variant, quantity: 2 };
  const result = await s.prepare(); assert.equal(result.orderItems[0].variantId, variant);
  assert.deepEqual(result.orderItems[0].variantOptions, [{ name: "Size", value: "Small" }]);
  s.products[0].variants[0].warehouseStocks = [{ warehouse: OTHER, quantity: 1000 }];
  await assert.rejects(s.prepare(), { statusCode: 409 });
});

test("the disabled gate, guests and inactive or unverified accounts cannot prepare bundle merchandise", async t => {
  const s = setup(t); process.env.ASSISTANT_BUNDLE_CART_ENABLED = "false";
  await assert.rejects(s.prepare(), { code: "BUNDLE_CART_FLOW_REQUIRED", statusCode: 409 });
  process.env.ASSISTANT_BUNDLE_CART_ENABLED = "true";
  await assert.rejects(s.prepare({ cart: { ...s.cart, guestId: "guest-fixture" } }), { statusCode: 409 });
  for (const field of ["active", "phoneVerified"]) {
    s.user[field] = false; await assert.rejects(s.prepare(), { statusCode: 403 }); s.user[field] = true;
  }
  assert.deepEqual(s.writes, []);
});

test("stale carts, fallback warehouses and calls outside the order transaction fail before writes", async t => {
  const s = setup(t), stale = clone(s.cart); stale.__v--;
  await assert.rejects(s.prepare({ cart: stale }), { statusCode: 409 });
  await assert.rejects(s.prepare({ session: null }), { statusCode: 503 });
  s.active = false; await assert.rejects(s.prepare(), { statusCode: 503 }); s.active = true;
  s.warehouse.active = false; await assert.rejects(s.prepare(), { statusCode: 409 });
  assert.deepEqual(s.writes, []);
});

test("prepared purchase contents survive later definition and product edits without repricing", async t => {
  const s = setup(t), result = await s.prepare(), order = s.order(result), before = presentOrder(order);
  s.products[0].price = 100; s.definitions[0].pricePiastres = 1800; s.definitions[0].components = [];
  assert.deepEqual(presentOrder(order), before); assertBundleOrderSnapshot(order);
});

test("public order placement still rejects saved bundles when the gate is disabled", async t => {
  const s = setup(t);
  process.env.ASSISTANT_BUNDLE_CART_ENABLED = "false";
  t.mock.method(CartModel, "findOne", async () => clone(s.cart));
  await assert.rejects(createOrderForUserService({ userId: U, paymentMethod: "card" }), { code: "BUNDLE_CART_FLOW_REQUIRED", statusCode: 409 });
  assert.deepEqual(s.writes, []);
});
