import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { FavoriteModel } from "../../../src/domains/favorite/favorite.model.js";
import { mergeGuestFavoriteService } from "../../../src/domains/favorite/favorite.service.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { CollectionModel } from "../../../src/domains/collection/collection.model.js";
import { SubcategoryModel } from "../../../src/domains/subcategory/subcategory.model.js";

const USER = "111111111111111111111111";
const OTHER_USER = "222222222222222222222222";
const GUEST = "guest-credential";
const OTHER_GUEST = "other-guest-credential";
const SIMPLE = "333333333333333333333333";
const VARIANT = "444444444444444444444444";
const OTHER_PRODUCT = "555555555555555555555555";

function query(value) {
  return {
    select() { return this; },
    populate() { return this; },
    lean() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}

function favorite({ id, user, guestId, items = [] }) {
  return {
    _id: id,
    user,
    guestId,
    items: structuredClone(items),
    async save() { return this; },
  };
}

function product(_id, type) {
  const isVariant = type === "VARIANT";
  return {
    _id,
    type,
    name_en: isVariant ? "Variant item" : "Simple item",
    name_ar: isVariant ? "منتج متغير" : "منتج بسيط",
    price: isVariant ? undefined : 100,
    discountedPrice: undefined,
    images: [],
    variants: isVariant ? [{ isDefault: true, price: 120, images: [] }] : [],
  };
}

function fixture(t, rows, products) {
  let databaseConnections = 0;
  let providerCalls = 0;
  t.mock.method(mongoose.Connection.prototype, "openUri", () => {
    databaseConnections++;
    assert.fail("Favorite merge tests must not connect to a database");
  });
  t.mock.method(globalThis, "fetch", () => {
    providerCalls++;
    assert.fail("Favorite merge tests must not call providers");
  });

  t.mock.method(FavoriteModel, "findOne", filter => {
    const row = rows.find(value => Object.entries(filter).every(([key, expected]) =>
      String(value[key] ?? "") === String(expected)));
    return query(row ?? null);
  });
  t.mock.method(FavoriteModel, "create", async doc => {
    const created = favorite({ id: `created-${rows.length}`, ...doc });
    rows.push(created);
    return created;
  });
  t.mock.method(FavoriteModel, "deleteOne", async filter => {
    const index = rows.findIndex(row => String(row._id) === String(filter._id));
    if (index < 0) return { deletedCount: 0 };
    rows.splice(index, 1);
    return { deletedCount: 1 };
  });
  t.mock.method(ProductModel, "find", filter => query(
    products.filter(value => filter._id.$in.some(id => String(id) === String(value._id))),
  ));
  t.mock.method(SubcategoryModel, "find", () => query([]));
  t.mock.method(CollectionModel, "find", () => query([]));

  return {
    rows,
    assertNoExternalCalls() {
      assert.equal(databaseConnections, 0);
      assert.equal(providerCalls, 0);
    },
  };
}

test("adopts guest-only product favorites for the authenticated user", async t => {
  const guest = favorite({ id: "guest-favorite", guestId: GUEST, items: [
    { product: SIMPLE, productName: "Old name", price: 80 },
  ] });
  const state = fixture(t, [guest], [product(SIMPLE, "SIMPLE")]);

  const result = await mergeGuestFavoriteService({ userId: USER, guestId: GUEST });

  assert.equal(guest.user, USER);
  assert.equal(guest.guestId, undefined);
  assert.equal(result.userId, USER);
  assert.equal(result.guestId, undefined);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].productId, SIMPLE);
  assert.equal(result.items[0].productType, "SIMPLE");
  state.assertNoExternalCalls();
});

test("combines favorites by product ID and refreshes variant product type", async t => {
  const guest = favorite({ id: "guest-favorite", guestId: GUEST, items: [
    { product: SIMPLE, productName: "Guest copy", price: 80 },
    { product: VARIANT, productType: "VARIANT", productName: "Guest variant", price: 90 },
  ] });
  const userFavorite = favorite({ id: "user-favorite", user: USER, items: [
    { product: SIMPLE, productName: "User copy", price: 100 },
    { product: OTHER_PRODUCT, productName: "Existing account item", price: 50 },
  ] });
  const unrelatedGuest = favorite({ id: "other-guest", guestId: OTHER_GUEST, items: [
    { product: OTHER_PRODUCT, productName: "Other guest item", price: 40 },
  ] });
  const unrelatedAccount = favorite({ id: "other-account", user: OTHER_USER, items: [
    { product: VARIANT, productType: "VARIANT", productName: "Other account item", price: 60 },
  ] });
  const unrelatedBefore = structuredClone({
    guest: { guestId: unrelatedGuest.guestId, items: unrelatedGuest.items },
    account: { user: unrelatedAccount.user, items: unrelatedAccount.items },
  });
  const state = fixture(t, [guest, userFavorite, unrelatedGuest, unrelatedAccount], [
    product(SIMPLE, "SIMPLE"), product(VARIANT, "VARIANT"), product(OTHER_PRODUCT, "SIMPLE"),
  ]);

  const result = await mergeGuestFavoriteService({ userId: USER, guestId: GUEST });

  assert.equal(state.rows.includes(guest), false);
  assert.equal(result.items.length, 3);
  assert.deepEqual(result.items.map(item => String(item.productId)).sort(),
    [SIMPLE, VARIANT, OTHER_PRODUCT].sort());
  assert.equal(result.items.filter(item => String(item.productId) === SIMPLE).length, 1);
  assert.equal(result.items.find(item => String(item.productId) === VARIANT).productType, "VARIANT");
  assert.deepEqual({
    guest: { guestId: unrelatedGuest.guestId, items: unrelatedGuest.items },
    account: { user: unrelatedAccount.user, items: unrelatedAccount.items },
  }, unrelatedBefore);
  state.assertNoExternalCalls();
});

test("empty guest favorite merge is repeatable and preserves the account favorites", async t => {
  const guest = favorite({ id: "empty-guest", guestId: GUEST });
  const userFavorite = favorite({ id: "user-favorite", user: USER, items: [
    { product: SIMPLE, productName: "Existing item", price: 100 },
  ] });
  const state = fixture(t, [guest, userFavorite], [product(SIMPLE, "SIMPLE")]);

  const first = await mergeGuestFavoriteService({ userId: USER, guestId: GUEST });
  const afterFirst = structuredClone(userFavorite.items);
  const second = await mergeGuestFavoriteService({ userId: USER, guestId: GUEST });

  assert.equal(state.rows.includes(guest), false);
  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 1);
  assert.deepEqual(userFavorite.items, afterFirst);
  state.assertNoExternalCalls();
});

test("a failed account save retains the guest favorites for recovery", async t => {
  const guest = favorite({ id: "guest-favorite", guestId: GUEST, items: [{ product: SIMPLE, productName: "Saved", price: 100 }] });
  const user = favorite({ id: "user-favorite", user: USER });
  const state = fixture(t, [guest, user], [product(SIMPLE, "SIMPLE")]);
  user.save = async () => { throw new Error("account save failed"); };
  await assert.rejects(mergeGuestFavoriteService({ userId: USER, guestId: GUEST }), /account save failed/);
  assert.equal(state.rows.includes(guest), true); assert.equal(guest.items.length, 1);
  state.assertNoExternalCalls();
});

test("a failed guest-source deletion can be retried without duplicate favorites", async t => {
  const guest = favorite({ id: "guest-favorite", guestId: GUEST, items: [{ product: SIMPLE, productName: "Saved", price: 100 }] });
  const user = favorite({ id: "user-favorite", user: USER });
  const state = fixture(t, [guest, user], [product(SIMPLE, "SIMPLE")]);
  const remove = FavoriteModel.deleteOne; let fail = true;
  t.mock.method(FavoriteModel, "deleteOne", async filter => { if (fail) throw new Error("source delete failed"); return remove(filter); });
  await assert.rejects(mergeGuestFavoriteService({ userId: USER, guestId: GUEST }), /source delete failed/);
  assert.equal(state.rows.includes(guest), true); assert.equal(user.items.length, 1);
  fail = false; const result = await mergeGuestFavoriteService({ userId: USER, guestId: GUEST });
  assert.equal(result.items.length, 1); assert.equal(state.rows.includes(guest), false);
  state.assertNoExternalCalls();
});
