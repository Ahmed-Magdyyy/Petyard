import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { confirmOrderPaymentService, failOrderPaymentService, mapCartItemToOrderItem } from "../../../src/domains/order/order.service.js";
import { CartModel } from "../../../src/domains/cart/cart.model.js";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { LoyaltySettingsModel } from "../../../src/domains/loyalty/loyaltySettings.model.js";
import { CouponModel } from "../../../src/domains/coupon/coupon.model.js";
import { WalletTransactionModel } from "../../../src/domains/wallet/walletTransaction.model.js";
import { buildBundleCartPurchasePlan } from "../../../src/domains/bundle/bundle.purchase-plan.js";
import { buildBundleOrderMerchandise } from "../../../src/domains/bundle/bundle.order-snapshot.js";
import { presentOrder } from "../../../src/domains/order/order.presenter.js";

const U = "111111111111111111111111", C = "222222222222222222222222", W = "333333333333333333333333";
const P = "444444444444444444444444", B = "555555555555555555555555", G = "666666666666666666666666", OTHER = "777777777777777777777777";
const oid = value => new mongoose.Types.ObjectId(value);
const clone = value => mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize(value));
const query = read => { let session, selection; return { session(value) { session = value; return this; },
  select(value) { selection = value; return this; }, lean() { return Promise.resolve().then(() => read(session, selection)); },
  then(resolve, reject) { return Promise.resolve().then(() => read(session, selection)).then(resolve, reject); } }; };

function setup(t, { guest = false } = {}) {
  const s = { active: true, reads: 0, writes: 0, owner: guest ? { guestId: "legacy-shopping-guest" } : { user: oid(U) } };
  s.cart = { _id: oid(C), ...s.owner, warehouse: oid(W), currency: "EGP", items: [{ product: oid(P), productType: "SIMPLE", quantity: 2, itemPrice: 10 }], totalCartPrice: 20, checkoutKey: "keep-cart-key" };
  s.session = { inTransaction: () => s.active };
  t.mock.method(CartModel, "findOne", () => assert.fail("Existing confirmation does not require a cart fingerprint read"));
  t.mock.method(CartModel.collection, "updateOne", () => assert.fail("Existing confirmation uses its original model update"));
  t.mock.method(mongoose, "connect", () => assert.fail("No real database connections"));
  t.mock.method(globalThis, "fetch", () => assert.fail("No external provider calls"));
  return s;
}

test("the restored order model does not define or accept checkout fingerprint metadata", () => {
  assert.equal(OrderModel.schema.path("checkoutCart"), undefined);
  const doc = new OrderModel({ checkoutCart: { cartId: C, fingerprint: "a".repeat(64) } });
  assert.equal(doc.toObject().checkoutCart, undefined);
  assert.equal(doc.toJSON().checkoutCart, undefined);
});

async function payment(t, options) {
  const s = setup(t, options);
  const oldRedis = process.env.REDIS_URL; process.env.REDIS_URL = "";
  t.after(() => { if (oldRedis === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = oldRedis; });
  s.order = { _id: oid(OTHER), ...s.owner, warehouse: oid(W), currency: "EGP",
    status: "awaiting_payment", paymentStatus: "pending", sideEffectsCommitted: false, paymentMethod: "card",
    subtotal: 20, discountAmount: 0, total: 20, walletUsed: 0, history: [],
    items: [{ product: oid(P), productType: "SIMPLE", productName: "Food", quantity: 2 }] };
  s.orderSaves = 0; s.legacyUpdates = []; s.bundleUpdates = []; s.productSaves = 0; s.active = false;
  s.walletBalance = options?.bundles ? 10 : 0; s.walletDebits = 0; s.walletLedger = []; s.couponUses = 0;
  s.session.withTransaction = async callback => { s.active = true; try { return await callback(); } finally { s.active = false; } };
  s.session.endSession = () => {};
  t.mock.method(mongoose, "startSession", async () => s.session);
  t.mock.method(OrderModel, "findById", () => query((session, selection) => {
    if (session) { assert.equal(s.active, true); assert.equal(session, s.session); }
    const doc = clone(s.order);
    assert.equal(selection, undefined);
    doc.save = async ({ session } = {}) => {
      assert.equal(session, s.active ? s.session : undefined);
      if (s.order.bundleGroups?.length) await new OrderModel(doc).validate();
      s.orderSaves++; Object.assign(s.order, clone(doc)); return doc;
    };
    return doc;
  }));
  const product = { _id: oid(P), type: "SIMPLE", warehouseStocks: [{ warehouse: oid(W), quantity: 10, revision: 0 }],
    save: async ({ session }) => { assert.equal(session, s.session); s.productSaves++; } };
  s.product = product;
  if (options?.bundles) {
    Object.assign(product, { isActive: true, price: 10, name_en: "Food", images: [] });
    if (options.variant) Object.assign(product, { type: "VARIANT", variants: [{ _id: oid(B), price: 10, options: [], images: [],
      warehouseStocks: [{ warehouse: oid(W), quantity: 10, revision: 0 }, { warehouse: oid(C), quantity: 1000, revision: 0 }] }] });
    const component = { productId: P, productType: product.type, quantity: 2, ...(options.variant ? { variantId: B } : {}) };
    const definition = { _id: B, origin: "manual", status: "published", revision: 1, name_en: "Pair", pricePiastres: 1500, components: [component] };
    const plan = buildBundleCartPurchasePlan({ warehouseId: W, warehouse: { _id: W, active: true }, products: [product],
      bundles: [{ groupId: G, bundle: definition, expectedRevision: 1, quantity: 2 }] });
    const ordinaryItems = options.ordinary === false ? [] : [mapCartItemToOrderItem({ ...s.cart.items[0], productName: "Food" })];
    const merchandise = buildBundleOrderMerchandise({ plan, userId: U, ordinaryItems });
    const discount = options.coupon ? 2 : 0, total = merchandise.subtotal + 40 - discount;
    s.order = new OrderModel({ ...s.order, ...merchandise, orderNumber: "CARD-FIXTURE", shippingFee: 50,
      walletUsed: 10, discountAmount: discount, total, couponCode: options.coupon ? "SAVE" : undefined,
      settlement: { schemaVersion: 1, revision: 0, currency: "EGP", migrationState: "native",
        currentMerchandiseGrossPiastres: merchandise.subtotal * 100, originalCouponDiscountPiastres: discount * 100,
        preservedCouponDiscountPiastres: discount * 100, lockedNetShippingPiastres: 5000,
        currentOrderValuePiastres: (merchandise.subtotal + 50 - discount) * 100, walletDebitedPiastres: 1000,
        walletCreditedPiastres: 0, cardCapturedPiastres: 0, cardRefundedPiastres: 0, cardDuePiastres: total * 100,
        instapaySubmittedPiastres: 0, instapayConfirmedPiastres: 0, deliveryDuePiastres: 0, pendingRefundLiabilityPiastres: 0 } }).toObject();
    s.cart.items = options.ordinary === false ? [] : s.cart.items;
    s.cart.bundles = [{ id: G, bundleId: B, bundleRevision: 1, quantity: 2, unitPricePiastres: 1500 }];
    s.cart.totalCartPrice = merchandise.subtotal; s.cart.__v = 4;
    s.cart.deliveryAddress = { name: "Fixture", warehouse: oid(W) };
    t.mock.method(CartModel.collection, "updateOne", async (filter, update, { session }) => {
      assert.equal(session, s.session); assert.equal(s.active, true);
      assert.equal(String(filter.user), U); assert.equal(filter.guestId, null);
      s.bundleUpdates.push({ filter, update, session });
      if (!s.cart || String(s.cart.user) !== U || s.cart.guestId != null) return { matchedCount: 0, modifiedCount: 0 };
      s.writes++; Object.assign(s.cart, clone(update.$set));
      for (const field of Object.keys(update.$unset)) delete s.cart[field];
      s.cart.__v = (s.cart.__v ?? 0) + update.$inc.__v;
      return { matchedCount: 1, modifiedCount: 1 };
    });
  }
  t.mock.method(ProductModel, "find", () => query(session => { assert.equal(session, s.session); return [product]; }));
  t.mock.method(CartModel, "updateOne", async (filter, update, options) => {
    assert.deepEqual(filter, s.owner);
    s.legacyUpdates.push({ filter, update, options });
    if (!s.cart || (filter.user ? String(s.cart.user) !== String(filter.user) : s.cart.guestId !== filter.guestId)) return { matchedCount: 0 };
    Object.assign(s.cart, clone(update.$set ?? update));
    return { matchedCount: 1 };
  });
  t.mock.method(UserModel, "find", () => query(() => []));
  t.mock.method(UserModel, "findById", () => query(session => { assert.equal(session, s.session); return { walletBalance: s.walletBalance }; }));
  t.mock.method(UserModel, "updateOne", async (filter, update, { session }) => {
    assert.equal(session, s.session); assert.equal(String(filter._id), U);
    const debit = -update.$inc.walletBalance; assert.equal(filter.walletBalance.$gte, debit);
    if (s.walletBalance < debit) return { matchedCount: 0 };
    s.walletBalance -= debit; s.walletDebits++; return { matchedCount: 1 };
  });
  t.mock.method(WalletTransactionModel, "create", async ([row], { session }) => {
    assert.equal(session, s.session); const doc = new WalletTransactionModel(row); await doc.validate();
    s.walletLedger.push(doc.toObject()); return [doc];
  });
  t.mock.method(CouponModel, "updateOne", async (filter, update, { session }) => {
    assert.equal(session, s.session); assert.equal(filter.code, "SAVE"); assert.equal(update.$inc.usageCount, 1);
    s.couponUses++; return { matchedCount: 1 };
  });
  t.mock.method(WarehouseModel, "findById", () => query(() => ({ moderators: [] })));
  t.mock.method(LoyaltySettingsModel, "findOne", () => query(() => ({ isActive: false })));
  t.mock.method(UserModel, "findByIdAndUpdate", () => assert.fail("Successful payment must not refund the order"));
  t.mock.method(console, "warn", () => {});
  s.errors = []; t.mock.method(console, "error", (...values) => s.errors.push(values));
  s.confirm = () => confirmOrderPaymentService({ orderId: OTHER, paymobOrderId: "fixture-provider-order", paymobTransactionId: "fixture-capture" });
  s.fail = () => failOrderPaymentService(OTHER);
  return s;
}

test("existing card confirmation retains cart clearing and the original subsequent key rotation", async t => {
  const s = await payment(t, { bundles: false }); await s.confirm();
  assert.equal(s.order.status, "pending"); assert.equal(s.order.paymentStatus, "paid"); assert.equal(s.order.sideEffectsCommitted, true);
  assert.deepEqual(s.cart.items, []); assert.notEqual(s.cart.checkoutKey, "keep-cart-key");
  assert.equal(s.writes, 0); assert.equal(s.reads, 0); assert.equal(s.productSaves, 1);
  assert.equal(s.legacyUpdates.length, 2);
  assert.deepEqual(s.legacyUpdates[0].update.items, []); assert.equal(s.legacyUpdates[0].options.session, s.session);
  assert.equal(typeof s.legacyUpdates[1].update.$set.checkoutKey, "string");
  assert.equal(s.legacyUpdates[1].options, undefined);
  assert.deepEqual(s.errors, []);
});

test("cart edits made during payment retain the previous clearing behavior without adding a new flow", async t => {
  const s = await payment(t, { bundles: false }); s.cart.items[0].quantity = 9;
  await s.confirm(); assert.deepEqual(s.cart.items, []); assert.equal(s.writes, 0); assert.equal(s.reads, 0);
  assert.equal(s.order.status, "pending"); assert.equal(s.order.paymentStatus, "paid");
  assert.equal(s.productSaves, 1); assert.equal(s.legacyUpdates.length, 2); assert.deepEqual(s.errors, []);
});

test("a repeated payment confirmation never clears a newer cart or commits stock twice", async t => {
  const s = await payment(t, { bundles: false }); await s.confirm();
  s.cart.items = [{ product: oid(P), productType: "SIMPLE", quantity: 1, itemPrice: 10 }];
  const before = clone(s.cart); await s.confirm();
  assert.deepEqual(s.cart, before); assert.equal(s.productSaves, 1); assert.equal(s.writes, 0);
  assert.equal(s.legacyUpdates.length, 2);
});

test("a missing cart does not introduce a fingerprint requirement or fail a successful payment", async t => {
  const s = await payment(t, { bundles: false }); s.cart = null;
  await s.confirm(); assert.equal(s.writes, 0); assert.equal(s.reads, 0);
  assert.equal(s.order.paymentStatus, "paid"); assert.equal(s.order.sideEffectsCommitted, true);
  assert.equal(s.productSaves, 1); assert.equal(s.legacyUpdates.length, 2); assert.deepEqual(s.errors, []);
});

test("existing guest shopping retains the same payment confirmation and cart owner", async t => {
  const s = await payment(t, { bundles: false, guest: true });
  await s.confirm(); assert.equal(s.order.paymentStatus, "paid"); assert.equal(s.legacyUpdates.length, 2);
  assert.deepEqual(s.legacyUpdates[0].update.items, []); assert.equal(s.legacyUpdates[0].options.session, s.session);
  assert.equal(typeof s.legacyUpdates[1].update.$set.checkoutKey, "string"); assert.equal(s.writes, 0);
});

test("existing card confirmation clears mixed merchandise and retains its wallet, capture and key-rotation rules", async t => {
  const s = await payment(t, { bundles: true }), address = clone(s.cart.deliveryAddress);
  await s.confirm();
  assert.equal(s.order.paymentStatus, "paid"); assert.equal(s.order.status, "pending"); assert.equal(s.order.sideEffectsCommitted, true);
  assert.equal(s.product.warehouseStocks[0].quantity, 4); assert.equal(s.productSaves, 1);
  assert.equal(s.walletDebits, 1); assert.equal(s.walletBalance, 0); assert.equal(s.walletLedger[0].amount, -10);
  assert.equal(s.order.settlement.cardCapturedPiastres, 9000); assert.equal(s.order.settlement.cardDuePiastres, 0);
  assert.deepEqual(s.cart.items, []); assert.equal(s.cart.bundles, undefined); assert.equal(s.cart.totalCartPrice, 0); assert.equal(s.cart.__v, 5);
  assert.deepEqual(s.cart.deliveryAddress, address); assert.notEqual(s.cart.checkoutKey, "keep-cart-key");
  assert.equal(s.bundleUpdates.length, 1); assert.equal(s.bundleUpdates[0].session, s.session);
  assert.equal(s.legacyUpdates.length, 1); assert.equal(s.legacyUpdates[0].options, undefined); assert.deepEqual(s.errors, []);
});

test("existing card confirmation supports bundle-only merchandise without charging its components twice", async t => {
  const s = await payment(t, { bundles: true, ordinary: false }); await s.confirm();
  assert.equal(s.product.warehouseStocks[0].quantity, 6); assert.equal(s.order.total, 70);
  assert.equal(s.order.settlement.cardCapturedPiastres, 7000); assert.equal(s.walletDebits, 1);
  assert.deepEqual(presentOrder(s.order).items, []); assert.equal(presentOrder(s.order).bundles.length, 1);
  assert.equal(s.cart.bundles, undefined); assert.deepEqual(s.errors, []);
});

test("card confirmation decrements only the exact selected variant and warehouse", async t => {
  const s = await payment(t, { bundles: true, ordinary: false, variant: true }); await s.confirm();
  assert.equal(s.product.variants[0].warehouseStocks[0].quantity, 6);
  assert.equal(s.product.variants[0].warehouseStocks[1].quantity, 1000);
  assert.equal(s.product.warehouseStocks[0].quantity, 10); assert.equal(s.productSaves, 1); assert.deepEqual(s.errors, []);
});

test("repeated confirmations do not repeat bundle stock, wallet, coupon or cart changes", async t => {
  const s = await payment(t, { bundles: true, coupon: true }); await s.confirm();
  s.cart.items = [{ product: oid(P), productType: "SIMPLE", quantity: 1, itemPrice: 10 }];
  const cart = clone(s.cart); await s.confirm();
  assert.deepEqual(s.cart, cart); assert.equal(s.productSaves, 1); assert.equal(s.walletDebits, 1);
  assert.equal(s.walletLedger.length, 1); assert.equal(s.couponUses, 1); assert.equal(s.bundleUpdates.length, 1);
  assert.equal(s.order.settlement.cardCapturedPiastres, 8800); assert.deepEqual(s.errors, []);
});

test("a missing cart does not change the existing successful payment behavior for bundles", async t => {
  const s = await payment(t, { bundles: true }); s.cart = null; await s.confirm();
  assert.equal(s.order.paymentStatus, "paid"); assert.equal(s.walletDebits, 1); assert.equal(s.productSaves, 1);
  assert.equal(s.bundleUpdates.length, 1); assert.equal(s.writes, 0); assert.deepEqual(s.errors, []);
});

test("a bundle confirmation cannot clear a cart belonging to another owner", async t => {
  const s = await payment(t, { bundles: true }); s.cart.user = oid(OTHER); const cart = clone(s.cart);
  await s.confirm(); assert.deepEqual(s.cart, cart); assert.equal(s.writes, 0);
  assert.equal(s.order.paymentStatus, "paid"); assert.deepEqual(s.errors, []);
});

test("existing unpaid-card failure leaves bundle stock, wallet and cart untouched", async t => {
  const s = await payment(t, { bundles: true }), cart = clone(s.cart); await s.fail();
  assert.equal(s.order.status, "cancelled"); assert.equal(s.order.paymentStatus, "failed");
  assert.equal(s.product.warehouseStocks[0].quantity, 10); assert.equal(s.productSaves, 0);
  assert.equal(s.walletBalance, 10); assert.equal(s.walletDebits, 0); assert.deepEqual(s.walletLedger, []);
  assert.deepEqual(s.cart, cart); assert.deepEqual(s.bundleUpdates, []); assert.deepEqual(s.legacyUpdates, []);
});
