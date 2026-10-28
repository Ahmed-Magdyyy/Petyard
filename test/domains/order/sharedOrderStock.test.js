import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { validateStockReadOnly, ensureSufficientStockAndDecrement } from "../../../src/domains/order/order.service.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";

const X = "111111111111111111111111", Y = "222222222222222222222222";
const V = "333333333333333333333333", OTHER = "444444444444444444444444";
const W = "555555555555555555555555", ELSEWHERE = "666666666666666666666666";
const G = "777777777777777777777777", H = "888888888888888888888888";
const simple = (quantity, extra = {}) => ({ product: X, productType: "SIMPLE", productName: "Food", quantity, ...extra });
const component = (quantity, extra = {}) => simple(quantity, { bundleGroupId: G, bundleComponentIndex: 0, ...extra });
const variant = (quantity, extra = {}) => component(quantity, { product: Y, productType: "VARIANT", variantId: V, ...extra });

function setup(t) {
  const s = { reads: 0, saves: 0, session: { inTransaction: () => true },
    products: [{ _id: X, type: "SIMPLE", isActive: true, warehouseStocks: [{ warehouse: W, quantity: 7, revision: 2 }] }],
    cart: { warehouse: W, items: [simple(2), component(2), component(1), component(2, { bundleGroupId: H })] } };
  t.mock.method(ProductModel, "find", filter => {
    s.reads++;
    assert.deepEqual(Object.keys(filter), ["_id"]);
    assert.ok(filter._id.$in.every(id => [X, Y].includes(String(id))));
    return { session(session) { assert.equal(session, s.session); return this; }, then(resolve, reject) {
      return Promise.resolve(s.products.filter(product => filter._id.$in.some(id => String(id) === String(product._id))).map(product => {
        product.save = async options => { assert.equal(options.session, s.session); assert.equal(options.validateBeforeSave, false); s.saves++; };
        return product;
      })).then(resolve, reject);
    } };
  });
  t.mock.method(WarehouseModel, "findOne", () => assert.fail("Stock checks cannot select a fallback warehouse"));
  t.mock.method(mongoose, "connect", () => assert.fail("No real database connections"));
  t.mock.method(globalThis, "fetch", () => assert.fail("No provider calls"));
  s.snapshot = () => JSON.stringify({ products: s.products, cart: s.cart });
  s.check = changes => validateStockReadOnly({ cart: s.cart, session: s.session, ...changes });
  s.decrement = () => ensureSufficientStockAndDecrement({ cart: s.cart, session: s.session });
  return s;
}

test("card admission combines ordinary rows, allocation rows and multiple bundles using one SKU", async t => {
  const s = setup(t); s.products[0].warehouseStocks[0].quantity = 6;
  const before = s.snapshot();
  await assert.rejects(s.check(), { statusCode: 400, message: "product Food is out of stock" });
  assert.equal(s.saves, 0); assert.equal(s.snapshot(), before);
});

test("the exact combined quantity succeeds without reserving or changing stock", async t => {
  const s = setup(t), before = s.snapshot(); await s.check();
  assert.equal(s.saves, 0); assert.equal(s.snapshot(), before); assert.equal(s.reads, 1);
});

test("exact variants share their own demand and cannot use another variant or warehouse", async t => {
  const s = setup(t); s.cart.items = [variant(2, { bundleGroupId: undefined, bundleComponentIndex: undefined }), variant(3)];
  s.products = [{ _id: Y, type: "VARIANT", isActive: true, variants: [
    { _id: V, warehouseStocks: [{ warehouse: W, quantity: 4 }, { warehouse: ELSEWHERE, quantity: 1000 }] },
    { _id: OTHER, warehouseStocks: [{ warehouse: W, quantity: 1000 }] }] }];
  await assert.rejects(s.check(), { statusCode: 400 });
  s.products[0].variants[0].warehouseStocks[0].quantity = 5; await s.check();
  assert.equal(s.saves, 0);
});

test("different exact variants are checked independently", async t => {
  const s = setup(t); s.cart.items = [variant(2), variant(3, { variantId: OTHER })];
  s.products = [{ _id: Y, type: "VARIANT", isActive: true, variants: [
    { _id: V, warehouseStocks: [{ warehouse: W, quantity: 2 }] },
    { _id: OTHER, warehouseStocks: [{ warehouse: W, quantity: 3 }] }] }];
  await s.check(); assert.equal(s.saves, 0);
});

test("four warehouse stock pools stay separate during card admission", async t => {
  const s = setup(t), ids = [W, ELSEWHERE, G, H];
  s.cart.items = [component(2), component(2, { product: Y })];
  s.products = [{ _id: X, type: "SIMPLE", isActive: true,
    warehouseStocks: [0, 1, 3].map(index => ({ warehouse: ids[index], quantity: 2 })) },
    { _id: Y, type: "SIMPLE", isActive: true,
      warehouseStocks: [1, 2, 3].map(index => ({ warehouse: ids[index], quantity: 2 })) }];
  for (const [index, id] of ids.entries()) {
    s.cart.warehouse = id;
    if ([1, 3].includes(index)) await s.check();
    else await assert.rejects(s.check(), { statusCode: 400 });
  }
  assert.equal(s.saves, 0);
});

test("component quantities and summed demand must remain positive safe integers", async t => {
  const s = setup(t);
  for (const quantity of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    s.cart.items = [component(quantity)]; await assert.rejects(s.check(), { statusCode: 400 });
  }
  s.cart.items = [component(Number.MAX_SAFE_INTEGER), component(1)];
  await assert.rejects(s.check(), { statusCode: 400 }); assert.equal(s.reads, 0);
});

test("invalid component product types and inactive products cannot pass shared admission", async t => {
  const s = setup(t); s.products[0].isActive = false;
  await assert.rejects(s.check(), { statusCode: 400 });
  s.products[0].isActive = true; s.cart.items[0].productType = "VARIANT"; s.cart.items[0].variantId = V;
  await assert.rejects(s.check(), { statusCode: 400 });
});

test("malformed stock quantities cannot authorize bundle purchases", async t => {
  const s = setup(t);
  for (const quantity of [NaN, Infinity, -1, 7.5, Number.MAX_SAFE_INTEGER + 1]) {
    s.products[0].warehouseStocks[0].quantity = quantity;
    await assert.rejects(s.check(), { statusCode: 400 });
  }
  assert.equal(s.saves, 0);
});

test("ambiguous warehouse rows or duplicate selected variants fail closed", async t => {
  const s = setup(t); s.products[0].warehouseStocks.push({ warehouse: W, quantity: 1000 });
  await assert.rejects(s.check(), { statusCode: 400 });
  s.cart.items = [variant(1)]; s.products = [{ _id: Y, type: "VARIANT", isActive: true,
    variants: [0, 1].map(() => ({ _id: V, warehouseStocks: [{ warehouse: W, quantity: 1 }] })) }];
  await assert.rejects(s.check(), { statusCode: 404 });
});

test("component admission requires the active caller transaction", async t => {
  const s = setup(t);
  for (const session of [null, {}, { inTransaction: () => false }]) {
    await assert.rejects(s.check({ session }), { statusCode: 503 });
  }
  assert.equal(s.reads, 0);
});

test("ordinary product stock checks retain their normal success and localized failures", async t => {
  const s = setup(t); s.cart.items = [simple(7)]; await s.check();
  s.cart.items[0].quantity = 8;
  await assert.rejects(s.check(), { statusCode: 400, message: "product Food is out of stock" });
  await assert.rejects(s.check({ lang: "ar" }), { statusCode: 400, message: "المنتج Food غير متوفر في المخزون" });
  s.cart.items = []; await assert.rejects(s.check(), { statusCode: 400, message: "Cart is empty" });
  assert.equal(s.saves, 0);
});

test("existing decrement consumes combined physical quantities once and saves each product once", async t => {
  const s = setup(t); await s.decrement();
  assert.equal(s.products[0].warehouseStocks[0].quantity, 0);
  assert.equal(s.products[0].warehouseStocks[0].revision, 6);
  assert.equal(s.saves, 1);
  assert.deepEqual(s.cart.items.map(row => row.quantity), [2, 2, 1, 2]);
});

test("existing decrement rejects combined shortages before saving and never borrows another pool", async t => {
  const s = setup(t); s.products[0].warehouseStocks[0].quantity = 6;
  s.products[0].warehouseStocks.push({ warehouse: ELSEWHERE, quantity: 1000 });
  await assert.rejects(s.decrement(), { statusCode: 400 });
  assert.equal(s.saves, 0); assert.equal(s.products[0].warehouseStocks[1].quantity, 1000);
});

test("existing exact-variant decrement combines allocations and preserves other variants and warehouses", async t => {
  const s = setup(t); s.cart.items = [variant(2), variant(3)];
  s.products = [{ _id: Y, type: "VARIANT", isActive: true, variants: [
    { _id: V, warehouseStocks: [{ warehouse: W, quantity: 5, revision: 0 }, { warehouse: ELSEWHERE, quantity: 1000 }] },
    { _id: OTHER, warehouseStocks: [{ warehouse: W, quantity: 1000 }] }] }];
  await s.decrement();
  assert.equal(s.products[0].variants[0].warehouseStocks[0].quantity, 0);
  assert.equal(s.products[0].variants[0].warehouseStocks[0].revision, 2);
  assert.equal(s.products[0].variants[0].warehouseStocks[1].quantity, 1000);
  assert.equal(s.products[0].variants[1].warehouseStocks[0].quantity, 1000); assert.equal(s.saves, 1);
});
