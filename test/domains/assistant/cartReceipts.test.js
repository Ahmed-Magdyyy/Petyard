import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { CartModel } from "../../../src/domains/cart/cart.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { CollectionModel } from "../../../src/domains/collection/collection.model.js";
import { AssistantCartReceipt } from "../../../src/domains/assistant/shared/assistant.cart-receipt.model.js";
import { assistantModels } from "../../../src/domains/assistant/shared/assistant.models.js";
import { stageCartAdditionWithReceipt } from "../../../src/domains/assistant/customer/assistant.cart-receipts.js";
import { previewCartAdditionService, writeConfirmedCartAdditionService } from "../../../src/domains/cart/cart.service.js";

const U = "111111111111111111111111", W = "222222222222222222222222", P = "333333333333333333333333";
const ID = "444444444444444444444444", OTHER = "555555555555555555555555", V = "666666666666666666666666";
const plain = (value) => JSON.parse(JSON.stringify(value));
const savedCart = () => new CartModel({ user: U, warehouse: W, checkoutKey: "keep-key", __v: 7,
  deliveryAddress: { name: "Keep address", area: "Keep area" }, currency: "EGP", abandonedAt: new Date(),
  items: [{ product: P, productType: "SIMPLE", quantity: 3, itemPrice: 100 }], totalCartPrice: 300 }).toObject();

function fixture(t, { existing = true } = {}) {
  const state = { cart: existing ? savedCart() : null, receipts: [], reads: 0, cartWrites: [], receiptWrites: [],
    cartIndexes: [{ key: { user: 1 }, unique: true, partialFilterExpression: { user: { $type: "objectId" } } }],
    receiptIndexes: [{ name: "_id_", key: { _id: 1 } }], active: true,
    product: { _id: P, type: "SIMPLE", isActive: true, name_en: "Toy", name_ar: "لعبة", price: 100,
      images: [], warehouseStocks: [{ warehouse: W, quantity: 20 }] } };
  state.session = { inTransaction: () => state.active };
  function query(read) {
    let session;
    return { select() { return this; }, lean() { return this; }, session(value) { session = value; return this; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        assert.equal(session, state.session, "all operation reads must use the caller's transaction");
        state.reads++; return read();
      }).then(resolve, reject); } };
  }
  t.mock.method(WarehouseModel, "findById", () => query(() => ({ _id: W, active: true })));
  t.mock.method(ProductModel, "findById", () => query(() => state.product));
  t.mock.method(ProductModel, "find", () => query(() => [state.product]));
  t.mock.method(CollectionModel, "findOne", () => query(() => null));
  t.mock.method(CollectionModel, "updateMany", () => assert.fail("no promotion maintenance"));
  t.mock.method(CartModel, "findOne", (filter) => query(() => {
    assert.equal(String(filter.user), U);
    return state.cart ? mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize(state.cart)) : null;
  }));
  t.mock.method(CartModel.collection, "indexes", async () => state.cartIndexes);
  t.mock.method(AssistantCartReceipt.collection, "indexes", async () => state.receiptIndexes);
  t.mock.method(CartModel.collection, "updateOne", async (filter, update, options) => {
    assert.equal(options.session, state.session);
    state.onWrite?.();
    state.cartWrites.push({ filter, update, session: options.session });
    // Only the exact preimage predicate is simulated; this is not a MongoDB transaction engine.
    const snapshot = filter.$expr.$eq[1].$literal;
    assert.equal(filter.$expr.$eq[0], "$$ROOT");
    if (state.forceMismatch || JSON.stringify(plain(snapshot)) !== JSON.stringify(plain(state.cart))) return { matchedCount: 0 };
    Object.assign(state.cart, update.$set);
    for (const key of Object.keys(update.$unset)) delete state.cart[key];
    state.cart.__v += update.$inc.__v;
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(CartModel, "create", async ([row], options) => {
    assert.equal(options.session, state.session); state.cartWrites.push({ created: row, session: options.session });
    state.cart = new CartModel(row).toObject(); return [new CartModel(row)];
  });
  t.mock.method(CartModel.prototype, "save", () => assert.fail("do not call ordinary cart save"));
  t.mock.method(AssistantCartReceipt, "findOne", (filter) => query(() => state.receipts.find((row) =>
    String(row._id) === String(filter._id) && String(row.owner) === String(filter.owner)) ?? null));
  t.mock.method(AssistantCartReceipt, "create", async ([row], options) => {
    assert.equal(options.session, state.session);
    if (state.failReceipt) throw new Error("receipt insert failed");
    if (state.receipts.some((entry) => String(entry._id) === String(row._id))) throw Object.assign(new Error("duplicate receipt"), { code: 11000 });
    const doc = new AssistantCartReceipt(row); assert.equal(doc.validateSync(), undefined);
    state.receipts.push(doc.toObject()); state.receiptWrites.push(options.session); return [doc];
  });
  state.addition = { warehouseId: W, productId: P, productType: "SIMPLE", quantity: 2, language: "en" };
  state.input = () => ({ userId: U, warehouseId: W, productId: P, productType: state.addition.productType,
    variantId: state.addition.variantId ?? null, quantity: state.addition.quantity, lang: state.addition.language });
  state.prepare = async () => { state.quote = await previewCartAdditionService(state.input(), { session: state.session }); };
  state.stage = (changes = {}, session = state.session) => stageCartAdditionWithReceipt({ owner: U, proposalId: ID,
    proposalFingerprint: "a".repeat(64), addition: state.addition, expectedQuote: state.quote, ...changes }, { session });
  return state;
}

test("receipt schema uses the proposal's unique ID and cannot initialize/expire implicitly", () => {
  const schema = AssistantCartReceipt.schema;
  assert.equal(schema.path("_id").options.required, true);
  assert.equal(schema.options.autoCreate, false); assert.equal(schema.options.autoIndex, false);
  assert.equal(schema.options.bufferCommands, false);
  assert.equal(Object.values(assistantModels).includes(AssistantCartReceipt), false);
  assert.ok(schema.indexes().every(([, options]) => options.expireAfterSeconds === undefined));
});

test("existing-cart mutation and durable result are staged in the same transaction", async (t) => {
  const s = fixture(t); await s.prepare();
  const address = plain(s.cart.deliveryAddress); const cartId = String(s.cart._id);
  const result = await s.stage();
  assert.equal(result.duplicate, false); assert.equal(result.receipt.cartId, cartId);
  assert.equal(result.receipt.result.addition.quantityAfter, 5);
  assert.equal(s.cart.items[0].quantity, 5); assert.equal(s.cart.totalCartPrice, 500); assert.equal(s.cart.__v, 8);
  assert.deepEqual(plain(s.cart.deliveryAddress), address); assert.equal(s.cart.checkoutKey, "keep-key");
  assert.equal(s.cart.abandonedAt, undefined);
  assert.equal(s.cartWrites.length, 1); assert.equal(s.receiptWrites.length, 1);
  assert.equal(s.cartWrites[0].session, s.receiptWrites[0]);
  assert.doesNotThrow(() => mongoose.mongo.BSON.serialize(s.cartWrites[0].filter));
  assert.equal(result.receipt.proposalId, ID); assert.equal(s.receipts.length, 1);
});

test("a lost-response retry returns the retained result without touching the changed current cart", async (t) => {
  const s = fixture(t); await s.prepare(); const first = await s.stage();
  s.cart.items = []; s.cart.totalCartPrice = 0; s.product.price = 999;
  const reads = s.reads;
  const repeated = await s.stage();
  assert.deepEqual(repeated.receipt, first.receipt); assert.equal(repeated.duplicate, true);
  assert.deepEqual(s.cart.items, []); assert.equal(s.cartWrites.length, 1); assert.equal(s.reads, reads + 1);
});

test("same proposal with changed input, preview or fingerprint rejects rather than reapplying", async (t) => {
  const s = fixture(t); await s.prepare(); await s.stage();
  for (const changes of [{ addition: { ...s.addition, quantity: 3 } }, { proposalFingerprint: "b".repeat(64) },
    { expectedQuote: { ...s.quote, itemsSubtotalAfter: 123 } }]) {
    await assert.rejects(s.stage(changes), { code: "idempotency_conflict", status: 409 });
  }
  assert.equal(s.cartWrites.length, 1);
});

test("new-cart insertion preserves the ordinary schema/key and retains real cart/item IDs", async (t) => {
  const s = fixture(t, { existing: false }); await s.prepare(); const temporaryId = s.quote.itemsAfter[0].id;
  const result = await s.stage();
  assert.equal(s.quote.cartId, null); assert.equal(result.receipt.cartId, String(s.cart._id));
  assert.ok(s.cart.checkoutKey); assert.equal(String(s.cart.user), U);
  assert.equal(s.cart.deliveryAddress, undefined);
  assert.equal(result.receipt.result.itemsAfter[0].id, String(s.cart.items[0]._id));
  assert.notEqual(result.receipt.result.itemsAfter[0].id, temporaryId);
  assert.equal(s.cartWrites.length, 1);
  assert.deepEqual((await s.stage()).receipt, result.receipt);
  s.quote.itemsAfter[0].id = OTHER;
  assert.deepEqual((await s.stage()).receipt, result.receipt);
});

test("missing/unsafe owner uniqueness refuses writes without creating an index", async (t) => {
  const s = fixture(t); await s.prepare();
  for (const index of [null, { key: { user: 1 } }, { key: { user: 1 }, unique: true, sparse: true },
    { key: { user: 1 }, unique: true, partialFilterExpression: { status: "ACTIVE" } },
    { key: { user: 1 }, unique: true, collation: { locale: "en", strength: 2 } }]) {
    s.cartIndexes = index ? [index] : [];
    await assert.rejects(s.stage(), /Cart uniqueness is not ready/);
  }
  assert.equal(s.cartWrites.length, 0); assert.equal(s.receipts.length, 0);
});

test("missing receipt store, identifier index or any TTL fails before a cart write", async (t) => {
  const s = fixture(t); await s.prepare();
  for (const indexes of [[], [{ name: "_id_", key: { other: 1 } }],
    [{ name: "_id_", key: { _id: 1 } }, { key: { recordedAt: 1 }, expireAfterSeconds: 10 }]]) {
    s.receiptIndexes = indexes;
    await assert.rejects(s.stage(), { code: "cart_receipt_store_unavailable", status: 503 });
  }
  assert.equal(s.cartWrites.length, 0);
});

test("missing/invalid cart versions fail closed instead of accepting a version-zero guess", async (t) => {
  const s = fixture(t);
  for (const value of [undefined, -1, Number.MAX_SAFE_INTEGER]) {
    if (value === undefined) delete s.cart.__v; else s.cart.__v = value;
    await s.prepare(); await assert.rejects(s.stage(), /Cart version is not ready/);
  }
  assert.equal(s.cartWrites.length, 0);
});

test("intervening quantity, address, key and identity changes fail the exact preimage even without a version advance", async (t) => {
  const s = fixture(t); await s.prepare(); const initial = plain(s.cart);
  for (const change of [() => { s.cart.items[0].quantity = 9; }, () => { s.cart.deliveryAddress.area = "Changed"; },
    () => { s.cart.checkoutKey = "new-key"; }, () => { s.cart.user = OTHER; }]) {
    s.cart = CartModel.hydrate(initial).toObject(); s.onWrite = change;
    await assert.rejects(s.stage(), /Cart changed/);
  }
  assert.equal(s.receipts.length, 0);
});

test("changed price, quantity or local stock refuses mutation after recalculation", async (t) => {
  const s = fixture(t); await s.prepare();
  s.product.price = 200; await assert.rejects(s.stage(), /Cart changed/);
  s.product.price = 100; s.product.warehouseStocks = [{ warehouse: OTHER, quantity: 100 }];
  await assert.rejects(s.stage(), /not available/);
  s.product.warehouseStocks = [{ warehouse: W, quantity: 4 }];
  await assert.rejects(s.stage(), /exceeds available stock/);
  assert.equal(s.cartWrites.length, 0); assert.equal(s.receipts.length, 0);
});

test("a selected variant writes only that locally stocked variant and retains its options", async (t) => {
  const s = fixture(t, { existing: false });
  s.addition = { ...s.addition, productType: "VARIANT", variantId: V };
  s.product = { ...s.product, type: "VARIANT", variants: [{ _id: V, price: 200,
    options: [{ name: "Weight", value: "3kg" }], warehouseStocks: [{ warehouse: W, quantity: 10 }] }] };
  await s.prepare(); const result = await s.stage();
  assert.equal(String(s.cart.items[0].variantId), V); assert.equal(s.cart.items[0].quantity, 2);
  assert.equal(result.receipt.result.addition.unitPrice, 200);
  assert.deepEqual(plain(s.cart.items[0].variantOptionsSnapshot), [{ name: "Weight", value: "3kg" }]);
});

test("inactive/missing transactions and ownership overrides reject before any write", async (t) => {
  const s = fixture(t); await s.prepare();
  for (const session of [undefined, {}, { inTransaction: () => false }]) {
    await assert.rejects(stageCartAdditionWithReceipt({ owner: U }, { session }), { code: "cart_transaction_required" });
  }
  await assert.rejects(s.stage({ addition: { ...s.addition, userId: OTHER } }), { code: "invalid_request" });
  s.active = false;
  await assert.rejects(writeConfirmedCartAdditionService(s.input(), s.quote, { session: s.session }), /Active transaction/);
  assert.equal(s.cartWrites.length, 0);
});

test("a receipt insertion error propagates so the caller must abort; no success is returned", async (t) => {
  const s = fixture(t); await s.prepare(); s.failReceipt = true;
  await assert.rejects(s.stage(), /receipt insert failed/);
  assert.equal(s.cartWrites.length, 1); assert.equal(s.receipts.length, 0);
  // The stub does not roll back: native transaction rollback remains a separate acceptance requirement.
});

test("corrupt retained result cannot become a replay success", async (t) => {
  const s = fixture(t); await s.prepare(); await s.stage();
  s.receipts[0].resultJson = '{}';
  await assert.rejects(s.stage(), { code: "cart_receipt_unavailable", status: 503 });
  assert.equal(s.cartWrites.length, 1);
});

test("malformed inputs and oversized quotes cannot reach a cart write", async (t) => {
  const s = fixture(t); await s.prepare();
  for (const changes of [{ owner: "bad" }, { proposalId: "bad" }, { proposalFingerprint: "bad" },
    { addition: { ...s.addition, quantity: "2" } }, { addition: { ...s.addition, variantId: V } },
    { addition: { ...s.addition, language: "fr" } }, { expectedQuote: {} },
    { expectedQuote: { ...s.quote, padding: "x".repeat(65536) } }]) {
    await assert.rejects(s.stage(changes));
  }
  assert.equal(s.cartWrites.length, 0); assert.equal(s.receipts.length, 0);
});

test("a foreign-owned receipt cannot be replayed and duplicate insertion propagates to the transaction owner", async (t) => {
  const s = fixture(t); const original = s.cart; await s.prepare();
  const snapshot = mongoose.mongo.BSON.deserialize(mongoose.mongo.BSON.serialize(original));
  await s.stage();
  s.receipts[0].owner = new mongoose.Types.ObjectId(OTHER);
  // Restore the pre-add state; this test checks owner lookup and the globally unique proposal ID.
  s.cart = snapshot;
  await assert.rejects(s.stage(), (error) => error.code === 11000);
});
