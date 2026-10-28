import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { CartModel } from "../../../src/domains/cart/cart.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { CollectionModel } from "../../../src/domains/collection/collection.model.js";
import { SubcategoryModel } from "../../../src/domains/subcategory/subcategory.model.js";
import { previewCartAdditionService } from "../../../src/domains/cart/cart.service.js";
import { resolveEffectiveWarehouse } from "../../../src/domains/warehouse/warehouse.fulfillment.js";

const U = "111111111111111111111111", W = "222222222222222222222222", P = "333333333333333333333333";
const R = "444444444444444444444444", S = "555555555555555555555555", A = "666666666666666666666666";
const F = "777777777777777777777777", V = "888888888888888888888888";
const args = { userId: U, warehouseId: W, productId: P, productType: "SIMPLE", quantity: 2 };

function fixture(t, { saved = true, transactional = true } = {}) {
  const session = transactional ? { inTransaction: () => true } : undefined;
  const product = (id) => ({ _id: id, type: "SIMPLE", isActive: true, price: 100, name_en: "Toy",
    subcategory: S, images: [], warehouseStocks: [{ warehouse: W, quantity: 20 }] });
  const state = { session, reads: [], active: 0, maxActive: 0, products: [product(P), product(R)],
    warehouse: { _id: W, active: true }, parents: [{ _id: S, parent: A }, { _id: A, parent: null }],
    promotion: { _id: A, slug: "sale", promotion: { discountPercent: 10 } },
    cart: saved ? new CartModel({ user: U, warehouse: W, checkoutKey: "kept", __v: 7,
      items: [{ product: R, productType: "SIMPLE", quantity: 1, itemPrice: 100 }] }).toObject() : null };
  function query(kind, filter, get) {
    let selectedSession;
    const value = { select() { return this; }, lean() { return this; },
      session(value) { selectedSession = value; return this; },
      async then(resolve, reject) {
        try {
          assert.equal(selectedSession, session, `${kind} must use the caller's session`);
          state.reads.push({ kind, filter });
          state.active++; state.maxActive = Math.max(state.maxActive, state.active);
          await new Promise(setImmediate);
          state.active--;
          if (state.failKind === kind) throw new Error("read failed");
          resolve(get());
        } catch (error) { reject(error); }
      } };
    return value;
  }
  t.mock.method(WarehouseModel, "findById", (id) => query("warehouse", id,
    () => String(id) === F ? { _id: F, active: true } : state.warehouse));
  t.mock.method(WarehouseModel, "findOne", (filter) => query("defaultWarehouse", filter, () => ({ _id: F, active: true })));
  t.mock.method(ProductModel, "findById", (id) => query("selectedProduct", id,
    () => state.products.find((product) => String(product._id) === String(id))));
  t.mock.method(ProductModel, "find", (filter) => query("cartProducts", filter,
    () => state.products.filter((product) => filter._id.$in.includes(String(product._id)))));
  t.mock.method(CartModel, "findOne", (filter) => query("cart", filter, () => state.cart));
  t.mock.method(SubcategoryModel, "find", (filter) => query("parents", filter, () => state.parents));
  t.mock.method(CollectionModel, "findOne", (filter) => query("promotion", filter, () => state.promotion));
  for (const model of [CartModel, ProductModel, WarehouseModel, CollectionModel, SubcategoryModel]) {
    for (const method of ["create", "updateOne", "updateMany", "deleteOne", "deleteMany"]) {
      t.mock.method(model, method, () => assert.fail("quotation must not write or maintain promotions"));
    }
    t.mock.method(model.prototype, "save", () => assert.fail("quotation must not save documents"));
  }
  state.preview = (changes = {}) => previewCartAdditionService({ ...args, ...changes }, { session });
  return state;
}

test("transaction quotation uses one session for every read including promotion ancestors", async (t) => {
  const state = fixture(t);
  const before = JSON.stringify(state.cart);
  const quote = await state.preview();
  assert.equal(quote.itemsSubtotalAfter, 270);
  assert.equal(quote.addition.unitPrice, 90);
  assert.equal(quote.itemsBefore.length, 1); assert.equal(quote.itemsAfter.length, 2);
  assert.deepEqual(new Set(state.reads.map(({ kind }) => kind)), new Set(["warehouse", "selectedProduct", "cart", "cartProducts", "parents", "promotion"]));
  for (const { filter } of state.reads.filter(({ kind }) => kind === "promotion")) {
    const subcategories = filter.$or.find((entry) => entry["selector.subcategoryIds"]);
    assert.deepEqual(subcategories["selector.subcategoryIds"].$in, [S, A]);
  }
  assert.equal(state.maxActive, 1, "transaction reads cannot run concurrently on one session");
  assert.equal(JSON.stringify(state.cart), before);
  assert.equal(Object.hasOwn(quote, "session"), false);
});

test("transaction quotation of a new cart still creates nothing and needs no address", async (t) => {
  const state = fixture(t, { saved: false });
  const quote = await state.preview();
  assert.equal(quote.cartId, null); assert.equal(quote.itemsSubtotalAfter, 180);
  assert.equal(quote.itemsAfter[0].quantity, 2);
  assert.equal(state.maxActive, 1);
});

test("transaction quotation keeps exact-variant warehouse stock and pricing rules", async (t) => {
  const state = fixture(t, { saved: false });
  state.products[0] = { ...state.products[0], type: "VARIANT", variants: [{ _id: V, price: 150,
    options: [{ name: "Color", value: "Blue" }], warehouseStocks: [{ warehouse: W, quantity: 2 }] }] };
  const quote = await state.preview({ productType: "VARIANT", variantId: V });
  assert.equal(quote.addition.variantId, V); assert.equal(quote.addition.unitPrice, 135);
  state.products[0].variants[0].warehouseStocks = [{ warehouse: F, quantity: 10 }];
  await assert.rejects(state.preview({ productType: "VARIANT", variantId: V }), /not available/);
});

test("inactive or malformed supplied sessions fail before any database reads", async (t) => {
  const state = fixture(t);
  for (const session of [{}, { inTransaction: () => false }]) {
    await assert.rejects(previewCartAdditionService(args, { session }), /Active transaction session/);
  }
  assert.equal(state.reads.length, 0);
});

test("transaction reads propagate errors and do not fall back to nontransactional reads", async (t) => {
  const state = fixture(t); state.failKind = "parents";
  await assert.rejects(state.preview(), /read failed/);
  assert.equal(state.reads.filter(({ kind }) => kind === "parents").length, 1);
  assert.equal(state.reads.filter(({ kind }) => kind === "promotion").length, 0);
});

test("configured and default fallback warehouse lookups stay in the same transaction", async (t) => {
  const state = fixture(t);
  for (const fallbackWarehouse of [F, undefined]) {
    state.reads.length = 0;
    state.warehouse.fulfillment = { status: "MAINTENANCE", fallbackWarehouse };
    await assert.rejects(state.preview(), /Warehouse changed/);
    assert.deepEqual(state.reads.map(({ kind }) => kind), fallbackWarehouse ? ["warehouse", "warehouse"] : ["warehouse", "defaultWarehouse"]);
  }
});

test("a supplied warehouse document is reread inside the transaction", async (t) => {
  const state = fixture(t);
  const cached = { _id: W, active: true };
  state.warehouse.active = false;
  await assert.rejects(resolveEffectiveWarehouse(cached, { session: state.session }), /inactive/);
  assert.equal(state.reads.length, 1); assert.equal(state.reads[0].kind, "warehouse");
});

test("the ordinary nontransactional quote keeps its result and attaches no session", async (t) => {
  const state = fixture(t, { transactional: false });
  const quote = await state.preview();
  assert.equal(quote.itemsSubtotalAfter, 270); assert.equal(quote.addition.unitPrice, 90);
  assert.ok(state.reads.length > 0);
});
