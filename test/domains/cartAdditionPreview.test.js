import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { CartModel } from "../../src/domains/cart/cart.model.js";
import { ProductModel } from "../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../src/domains/warehouse/warehouse.model.js";
import { CollectionModel } from "../../src/domains/collection/collection.model.js";
import { previewCartAdditionService, upsertCartItemService, updateCartItemQuantityService,
  removeCartItemService, clearCartService } from "../../src/domains/cart/cart.service.js";

const U = "111111111111111111111111", W = "222222222222222222222222", F = "333333333333333333333333";
const P = "444444444444444444444444", V = "555555555555555555555555", R = "666666666666666666666666";
const input = (changes = {}) => ({ userId: U, warehouseId: W, productId: P, productType: "SIMPLE", quantity: 2, ...changes });
const product = (changes = {}) => ({ _id: new mongoose.Types.ObjectId(P), type: "SIMPLE", isActive: true,
  name_en: "Toy", name_ar: "لعبة", price: 100, images: [], warehouseStocks: [{ warehouse: W, quantity: 10 }], ...changes });
const savedCart = (changes = {}) => new CartModel({ user: U, warehouse: W, currency: "EGP", checkoutKey: "existing-checkout-key",
  items: [{ product: P, productType: "SIMPLE", quantity: 3, itemPrice: 80, productName: "Old name" }], totalCartPrice: 240, ...changes }).toObject();

function fixture(t, saved = null, row = product()) {
  const state = { saved, products: [row], warehouse: { _id: W, active: true }, promotion: null,
    warehouseReads: 0, productReads: 0, refreshes: 0, cartReads: 0, writes: 0, writable: false, identity: { userId: U } };
  const query = (get) => ({ select() { return this; }, lean() { return Promise.resolve(get()); },
    then(resolve, reject) { return Promise.resolve().then(get).then(resolve, reject); } });
  t.mock.method(WarehouseModel, "findById", (id) => {
    state.warehouseReads++;
    return query(() => String(id) === F ? { _id: F, active: true } : state.warehouse);
  });
  t.mock.method(ProductModel, "findById", async (id) => {
    state.productReads++; return state.products.find((entry) => String(entry._id) === String(id)) ?? null;
  });
  t.mock.method(ProductModel, "find", (filter) => query(() => {
    state.refreshes++;
    state.onRefresh?.(state.refreshes);
    return state.products.filter((entry) => filter._id.$in.includes(String(entry._id)));
  }));
  t.mock.method(CartModel, "findOne", (filter) => {
    state.cartReads++;
    if (state.identity.userId) { assert.equal(String(filter.user), U); assert.equal(filter.guestId, undefined); }
    else { assert.equal(filter.user, undefined); assert.equal(filter.guestId, state.identity.guestId); }
    const raw = state.saved;
    const result = query(() => raw ? CartModel.hydrate(raw) : null);
    result.lean = () => Promise.resolve(raw);
    return result;
  });
  t.mock.method(CollectionModel, "findOne", (filter) => {
    assert.equal(filter["promotion.enabled"], true);
    assert.equal(filter["promotion.isActive"], true);
    return query(() => state.promotion);
  });
  t.mock.method(CartModel.prototype, "save", async function () {
    assert.equal(state.writable, true, "preview must never save a cart");
    state.writes++; state.persisted = this.toObject(); return this;
  });
  t.mock.method(CollectionModel, "updateMany", async () => {
    assert.equal(state.writable, true, "preview must not run promotion maintenance");
    return { acknowledged: true };
  });
  for (const model of [CartModel, ProductModel, WarehouseModel]) {
    for (const method of ["create", "updateOne", "updateMany", "deleteOne", "deleteMany"]) {
      t.mock.method(model, method, async (value) => {
        if (state.writable && model === CartModel && method === "create") {
          state.created = new CartModel(value); return state.created;
        }
        if (state.writable && model === CartModel && method === "deleteOne") {
          state.deleted = value; return { deletedCount: 1 };
        }
        assert.fail("preview must not write to the database");
      });
    }
  }
  state.preview = (changes = {}) => previewCartAdditionService(input(changes));
  return state;
}

test("a new-cart preview requires no saved address and creates no cart or maintenance writes", async (t) => {
  const state = fixture(t);
  const result = await state.preview();
  assert.equal(result.cartId, null); assert.equal(result.warehouseId, W);
  assert.equal(result.currency, "EGP"); assert.equal(result.pricingScope, "items_only");
  assert.deepEqual(result.itemsBefore, []); assert.equal(result.itemsAfter.length, 1);
  assert.equal(result.itemsSubtotalAfter, 200);
  assert.deepEqual(result.addition, { productId: P, productType: "SIMPLE", variantId: null, quantity: 2, quantityAfter: 2, unitPrice: 100 });
  assert.equal(state.writes, 0);
  assert.equal(Object.hasOwn(result, "shippingFee"), false);
  assert.equal(Object.hasOwn(result, "deliveryAddress"), false);
});

test("the existing cart is isolated and before/after quantities use current pricing without mutating saved data", async (t) => {
  const original = savedCart(); const before = JSON.stringify(original);
  const state = fixture(t, original);
  const result = await state.preview({ lang: "ar" });
  assert.equal(result.cartId, String(original._id)); assert.equal(result.itemsBefore[0].quantity, 3);
  assert.equal(result.itemsBefore[0].itemPrice, 80); assert.equal(result.itemsAfter[0].quantity, 5);
  assert.equal(result.itemsAfter[0].productName, "لعبة"); assert.equal(result.itemsAfter[0].itemPrice, 100);
  assert.equal(result.addition.quantityAfter, 5); assert.equal(result.itemsSubtotalAfter, 500);
  assert.equal(JSON.stringify(original), before); assert.equal(state.writes, 0);
});

test("ordinary app additions preserve numeric quantities, save flow and the existing response", async (t) => {
  const state = fixture(t, savedCart()); state.writable = true;
  const result = await upsertCartItemService(input());
  assert.equal(result.items[0].quantity, 5); assert.equal(result.totalCartPrice, 500);
  assert.equal(result.shippingFee, 0, "legacy mutation response remains items-only");
  assert.equal(state.writes, 2, "existing pre/post rebind saves are preserved");
  assert.equal(state.persisted.items[0].quantity, 5);
  const wire = JSON.parse(JSON.stringify(result));
  assert.deepEqual(Object.keys(wire).sort(), ["currency", "deliveryAddress", "guestId", "id", "isPrimeLocation", "items",
    "shippingFee", "totalCartPrice", "userId", "warehouseId"].sort());
});

test("the ordinary guest addition retains guest ownership and its existing numeric addition flow", async (t) => {
  const original = savedCart({ user: undefined, guestId: "guest-live-cart" });
  const state = fixture(t, original); state.writable = true; state.identity = { guestId: "guest-live-cart" };
  const result = await upsertCartItemService(input({ userId: null, guestId: "guest-live-cart", quantity: 1 }));
  assert.equal(result.userId, null); assert.equal(result.guestId, "guest-live-cart");
  assert.equal(result.items[0].quantity, 4); assert.equal(result.totalCartPrice, 400); assert.equal(state.writes, 2);
});

test("an ordinary new-cart addition retains cart creation, checkout key and mutation response", async (t) => {
  const state = fixture(t); state.writable = true;
  const result = await upsertCartItemService(input());
  assert.equal(String(state.created.user), U); assert.equal(String(state.created.warehouse), W);
  assert.match(state.created.checkoutKey, /^[a-f\d-]{36}$/);
  assert.equal(result.items[0].quantity, 2); assert.equal(result.totalCartPrice, 200);
  assert.equal(result.shippingFee, 0); assert.equal(state.writes, 2);
});

test("ordinary variant additions preserve variant option snapshots and promotion pricing", async (t) => {
  const row = product({ type: "VARIANT", variants: [{ _id: V, price: 200, options: [{ name: "Color", value: "Blue" }],
    warehouseStocks: [{ warehouse: W, quantity: 3 }] }] });
  const state = fixture(t, savedCart({ items: [], totalCartPrice: 0 }), row); state.writable = true;
  state.promotion = { _id: new mongoose.Types.ObjectId(), slug: "test", promotion: { discountPercent: 10 } };
  const result = await upsertCartItemService(input({ productType: "VARIANT", variantId: V }));
  const wire = JSON.parse(JSON.stringify(result));
  assert.equal(wire.items[0].variantId, V); assert.equal(wire.items[0].quantity, 2);
  assert.equal(wire.items[0].itemPrice, 180); assert.equal(wire.totalCartPrice, 360);
  assert.deepEqual(wire.items[0].variantOptions, [{ name: "Color", value: "Blue" }]);
});

test("ordinary quantity update, item removal and clear retain their existing results", async (t) => {
  const original = savedCart(); const state = fixture(t, original); state.writable = true;
  const args = { userId: U, warehouseId: W, itemId: String(original.items[0]._id) };
  const updated = await updateCartItemQuantityService({ ...args, quantity: 4 });
  assert.equal(updated.items[0].quantity, 4); assert.equal(updated.totalCartPrice, 400);
  const removed = await removeCartItemService(args);
  assert.equal(removed.items.length, 0); assert.equal(removed.totalCartPrice, 0);
  assert.deepEqual(await clearCartService(args), { success: true });
  assert.deepEqual(state.deleted, { user: U });
});

test("ordinary additions still reject insufficient stock without silently changing the quantity", async (t) => {
  const original = savedCart(); const state = fixture(t, original, product({ warehouseStocks: [{ warehouse: W, quantity: 4 }] }));
  state.writable = true;
  await assert.rejects(upsertCartItemService(input()), { statusCode: 400 });
  assert.equal(state.persisted.items[0].quantity, 3); assert.equal(state.writes, 1);
});

test("preview preserves manual discount versus promotion selection from the ordinary cart", async (t) => {
  const state = fixture(t, null, product({ price: 1200.5, discountedPrice: 950.25 }));
  state.promotion = { _id: new mongoose.Types.ObjectId(), slug: "test", promotion: { discountPercent: 20 } };
  const result = await state.preview();
  assert.equal(result.addition.unitPrice, 950.25); assert.equal(result.itemsSubtotalAfter, 1900.5);
});

test("preview requires stock for the full resulting quantity in this exact warehouse", async (t) => {
  const state = fixture(t, savedCart(), product({ warehouseStocks: [{ warehouse: W, quantity: 4 }, { warehouse: F, quantity: 100 }] }));
  await assert.rejects(state.preview(), { statusCode: 400 });
  state.products[0].warehouseStocks = [{ warehouse: F, quantity: 100 }];
  await assert.rejects(state.preview(), { statusCode: 400 });
  assert.equal(state.writes, 0);
});

test("variant previews use the selected variant and cannot borrow remote stock or another option's price", async (t) => {
  const state = fixture(t, null, product({ type: "VARIANT", variants: [
    { _id: V, price: 250, options: [{ name: "Color", value: "Blue" }], warehouseStocks: [{ warehouse: W, quantity: 3 }] },
    { _id: R, price: 50, options: [{ name: "Color", value: "Red" }], warehouseStocks: [{ warehouse: F, quantity: 100 }] },
  ] }));
  await assert.rejects(state.preview({ productType: "VARIANT", variantId: R }), { statusCode: 400 });
  const result = await state.preview({ productType: "VARIANT", variantId: V });
  assert.equal(result.addition.unitPrice, 250); assert.equal(result.itemsSubtotalAfter, 500);
  assert.equal(result.addition.variantId, V);
  assert.deepEqual(result.itemsAfter[0].variantOptions, [{ name: "Color", value: "Blue" }]);
});

test("invalid preview inputs fail before any database reads", async (t) => {
  const state = fixture(t);
  for (const changes of [{ userId: null }, { warehouseId: "invalid" }, { productId: "invalid" },
    { quantity: "2" }, { quantity: 0 }, { quantity: -1 }, { quantity: 1.5 }, { quantity: Infinity },
    { quantity: Number.MAX_SAFE_INTEGER + 1 }, { productType: "other" }, { variantId: V },
    { productType: "VARIANT" }, { lang: "de" }]) await assert.rejects(state.preview(changes), { statusCode: 400 });
  assert.equal(state.warehouseReads, 0); assert.equal(state.productReads, 0); assert.equal(state.cartReads, 0);
});

test("inactive/missing products and stale cart or routing context cannot become a preview", async (t) => {
  const state = fixture(t, savedCart());
  state.products[0].isActive = false;
  await assert.rejects(state.preview(), { statusCode: 404 });
  state.products[0].isActive = true;
  await assert.rejects(state.preview({ productId: R }), { statusCode: 404 });
  state.saved.warehouse = new mongoose.Types.ObjectId(F);
  await assert.rejects(state.preview(), { statusCode: 409 });
  state.warehouse.fulfillment = { status: "MAINTENANCE", fallbackWarehouse: F };
  const before = state.productReads;
  await assert.rejects(state.preview(), { statusCode: 409 });
  assert.equal(state.productReads, before);
});

test("before/after snapshots expose removed stale items without persisting removals", async (t) => {
  const original = savedCart(); const old = { ...product(), _id: new mongoose.Types.ObjectId(R), warehouseStocks: [] };
  original.items.push({ _id: new mongoose.Types.ObjectId(), product: old._id, productType: "SIMPLE", quantity: 1, itemPrice: 50 });
  const before = JSON.stringify(original); const state = fixture(t, original); state.products.push(old);
  const result = await state.preview();
  assert.equal(result.itemsBefore.length, 2); assert.equal(result.itemsAfter.length, 1);
  assert.equal(JSON.stringify(original), before); assert.equal(state.writes, 0);
});

test("stock loss during refresh cannot return a preview claiming the addition survived", async (t) => {
  const state = fixture(t);
  state.onRefresh = () => { state.products[0].warehouseStocks[0].quantity = 0; };
  await assert.rejects(state.preview(), { statusCode: 409 });
  assert.equal(state.writes, 0);
});
