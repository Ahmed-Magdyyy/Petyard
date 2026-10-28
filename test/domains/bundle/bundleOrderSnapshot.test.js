import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { buildBundleCartPurchasePlan } from "../../../src/domains/bundle/bundle.purchase-plan.js";
import { buildBundleOrderMerchandise, assertBundleOrderSnapshot, assertBundleOrderCanReorder, assertBundleLineCanSubstitute } from "../../../src/domains/bundle/bundle.order-snapshot.js";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { presentOrder, presentOrderPage } from "../../../src/domains/order/order.presenter.js";
import { aggregateInventoryDemands } from "../../../src/domains/inventory/inventory.service.js";
import { calculateMerchandiseGrossPiastres } from "../../../src/domains/settlement/settlement.pricing.js";
import { reorderService, getMyOrderByIdService } from "../../../src/domains/order/order.service.js";
import { CartModel } from "../../../src/domains/cart/cart.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";

const U = "111111111111111111111111", W = "222222222222222222222222", P = "333333333333333333333333";
const B = "444444444444444444444444", G = "555555555555555555555555", OTHER = "666666666666666666666666";
const copy = value => JSON.parse(JSON.stringify(value));
function fixture({ ordinary = true, variant = false } = {}) {
  const product = { _id: P, type: variant ? "VARIANT" : "SIMPLE", isActive: true, name_en: "Food", name_ar: "أكل", price: 1,
    warehouseStocks: [{ warehouse: W, quantity: 30 }], variants: [{ _id: OTHER, price: 1, options: [{ name: "Size", value: "Small" }], warehouseStocks: [{ warehouse: W, quantity: 30 }] }] };
  const bundle = { _id: B, origin: "manual", status: "published", revision: 2, name_en: "Triple", pricePiastres: 100,
    components: [{ productId: P, productType: product.type, ...(variant ? { variantId: OTHER } : {}), quantity: 3 }] };
  const plan = buildBundleCartPurchasePlan({ warehouseId: W, warehouse: { _id: W, active: true }, products: [product], ordinaryItems: [],
    bundles: [{ groupId: G, bundle, expectedRevision: 2, quantity: 2 }] });
  const ordinaryItems = ordinary ? [{ product: P, productType: "SIMPLE", productName: "Ordinary", quantity: 1, fulfillmentQuantity: 1,
    itemPrice: 1, lineTotal: 1, lineId: "ordinary-line", lineKind: "original" }] : [];
  const merchandise = buildBundleOrderMerchandise({ plan, ordinaryItems, userId: U });
  const order = { user: U, warehouse: W, currency: "EGP", orderNumber: "TEST-1", subtotal: ordinary ? 3 : 2, shippingFee: 50, total: ordinary ? 53 : 52, ...merchandise };
  return { order, plan, ordinaryItems, product, bundle };
}
const invalid = order => assert.throws(() => assertBundleOrderSnapshot(order), { code: "BUNDLE_ORDER_SNAPSHOT_INVALID" });

test("order merchandise copies complete bundle snapshots and unique real-SKU cohort rows", async () => {
  const s = fixture(), before = copy({ plan: s.plan, ordinary: s.ordinaryItems });
  const doc = new OrderModel(s.order); await doc.validate();
  assert.deepEqual(copy(s.plan), before.plan); assert.deepEqual(s.ordinaryItems, before.ordinary);
  assert.equal(doc.items.length, 3); assert.equal(doc.items[0].lineId, "ordinary-line");
  assert.equal(new Set(doc.items.map(row => row.lineId)).size, 3);
  assert.equal(doc.bundleGroups[0].components[0].allocations.length, 2);
  assert.equal(doc.items[1].bundleGroupId, G); assert.equal(doc.items[1].bundleComponentIndex, 0);
  s.bundle.name_en = "Changed"; s.plan.groups[0].name = "Changed plan";
  assert.equal(doc.bundleGroups[0].name, "Triple");
});

test("exact quantities and allocated money reuse inventory and settlement arithmetic without a second charge", () => {
  const { order } = fixture();
  assert.equal(calculateMerchandiseGrossPiastres(order.items), 300);
  const demands = aggregateInventoryDemands(order.items);
  assert.equal(demands.length, 1); assert.equal(demands[0].quantity, 7);
  assert.deepEqual(order.items.slice(1).map(row => [row.quantity, row.itemPricePiastres, row.lineTotalPiastres]), [[4, 33, 132], [2, 34, 68]]);
});

test("order subtotal cannot count the group summary as a second merchandise charge", () => {
  const { order } = fixture(); order.subtotal += 2; invalid(order);
});

test("exact variant cohorts survive schema casting without becoming a different variant", async () => {
  const { order } = fixture({ ordinary: false, variant: true }); const doc = new OrderModel(order); await doc.validate();
  assert.equal(String(doc.items[0].variantId), OTHER); assert.equal(doc.bundleGroups[0].components[0].variantId, OTHER);
  assert.deepEqual(copy(doc.items[0].variantOptions), [{ name: "Size", value: "Small" }]);
});

test("a positive one-piastre bundle may have zero-value physical cohorts", async () => {
  const s = fixture({ ordinary: false }); s.bundle.pricePiastres = 1;
  const plan = buildBundleCartPurchasePlan({ warehouseId: W, warehouse: { _id: W, active: true }, products: [s.product],
    bundles: [{ groupId: G, bundle: s.bundle, expectedRevision: 2, quantity: 2 }] });
  const order = { ...s.order, ...buildBundleOrderMerchandise({ plan, userId: U }), subtotal: 0.02, total: 50.02 };
  await new OrderModel(order).validate(); assert.equal(order.items[0].itemPricePiastres, 0);
  assert.equal(calculateMerchandiseGrossPiastres(order.items), 2);
});

test("normal orders retain absent optional fields and unchanged presentation", async () => {
  const s = fixture(); delete s.order.bundleGroups; s.order.items = [s.order.items[0]];
  const doc = new OrderModel(s.order); await doc.validate(); const json = doc.toJSON();
  assert.equal(Object.hasOwn(json, "bundleGroups"), false);
  assert.equal(Object.hasOwn(json, "bundleCheckout"), false);
  assert.equal(Object.hasOwn(json.items[0], "bundleGroupId"), false); assert.equal(Object.hasOwn(json.items[0], "bundleComponentIndex"), false);
  assert.deepEqual(presentOrder(json), json); assert.doesNotThrow(() => assertBundleOrderCanReorder(json));
  assert.doesNotThrow(() => assertBundleLineCanSubstitute(json.items[0]));
});

const retiredReceiptFields = ["bundleCheckout", "bundleCardPayment", "bundleCardInitialization", "bundleCaptureRefund", "bundleReturn", "bundleCancellation"];

test("orders no longer define or create the six retired lifecycle receipt fields", async () => {
  const { order } = fixture();
  const supplied = Object.fromEntries(retiredReceiptFields.map(field => [field, { internal: "retired" }]));
  const doc = new OrderModel({ ...order, ...supplied }); await doc.validate();
  for (const field of retiredReceiptFields) {
    assert.equal(OrderModel.schema.path(field), undefined);
    assert.equal(Object.hasOwn(doc.toObject(), field), false);
  }
  assert.equal(doc.bundleGroups.length, 1);
  assert.doesNotThrow(() => assertBundleOrderSnapshot(doc));
});

test("legacy stored receipt metadata stays private in plain and hydrated order responses", () => {
  const { order } = fixture();
  for (const field of retiredReceiptFields) order[field] = { internal: "retired" };
  for (const value of [order, OrderModel.hydrate(order)]) {
    const result = presentOrder(value);
    for (const field of retiredReceiptFields) assert.equal(Object.hasOwn(result, field), false);
    assert.equal(result.bundles.length, 1); assert.equal(result.items.length, 1);
  }
});

test("grouped history hides accounting cohorts and raw allocations while keeping ordinary rows", () => {
  const { order } = fixture(), before = copy(order), result = presentOrder(order);
  assert.deepEqual(order, before); assert.equal(result.items.length, 1); assert.equal(result.bundles.length, 1);
  assert.equal(result.bundleGroups, undefined); assert.equal(result.bundles[0].type, "BUNDLE");
  assert.equal(result.bundles[0].itemPrice, 1); assert.equal(result.bundles[0].originalItemPrice, 3); assert.equal(result.bundles[0].lineTotal, 2);
  assert.equal(result.bundles[0].components[0].quantity, 3); assert.equal(result.bundles[0].components[0].allocations, undefined);
  assert.equal(presentOrderPage({ data: [order] }).data[0].bundles[0].id, G);
});

test("Mongoose and populated staff-history records retain grouped saved metadata", () => {
  const { order } = fixture(); let result = presentOrder(new OrderModel(order)); assert.equal(result.bundles[0].name, "Triple");
  order.user = { _id: U, name: "Owner" }; order.warehouse = { _id: W, name: "Warehouse" };
  result = presentOrder(order); assert.equal(result.bundles[0].name, "Triple"); assert.equal(result.user.name, "Owner");
});

test("malformed grouping fails before a partial commercial order can be displayed", () => {
  const { order } = fixture(); order.items.pop();
  assert.throws(() => presentOrder(order), { code: "BUNDLE_ORDER_SNAPSHOT_INVALID" });
});

test("orphan, missing, duplicate and extra cohort associations fail", () => {
  for (const mutate of [order => { delete order.bundleGroups; }, order => { order.bundleGroups = null; },
    order => { order.bundleGroups.push(copy(order.bundleGroups[0])); }, order => { order.items.pop(); },
    order => { order.items.push({ ...order.items[1], lineId: "extra" }); }, order => { order.items[1].bundleGroupId = OTHER; },
    order => { order.items[1].bundleComponentIndex = 1; }, order => { delete order.items[1].bundleGroupId; },
    order => { order.items[1].lineId = order.items[0].lineId; }]) {
    const { order } = fixture(); mutate(order); invalid(order);
  }
});

test("warehouse, currency, ownership and duplicate component errors cannot form an order snapshot", () => {
  for (const mutate of [order => { order.warehouse = OTHER; }, order => { order.guestId = "guest"; }, order => { delete order.user; },
    order => { order.currency = "USD"; }, order => { order.bundleGroups[0].components.push(copy(order.bundleGroups[0].components[0])); }]) {
    const { order } = fixture(); mutate(order); invalid(order);
  }
});

test("changed SKU, unit count, piastre amount or EGP value cannot alter a bundle cohort", () => {
  for (const patch of [{ product: OTHER }, { productType: "VARIANT", variantId: OTHER }, { quantity: 3 }, { itemPrice: 0.331 },
    { itemPricePiastres: 32 }, { lineTotal: 1.31 }, { lineTotalPiastres: 131 }, { bundleComponentIndex: -1 }]) {
    const { order } = fixture(); Object.assign(order.items[1], patch); invalid(order);
  }
});

test("bundle partial fulfillment, promotions and substitution lineage are rejected", () => {
  for (const patch of [{ fulfillmentQuantity: 3 }, { finalizedUnavailableQuantity: 1 }, { lineKind: "substitute" },
    { sourceLineId: "old" }, { sourceSubstitutionRequest: OTHER }, { promotion: { discountPercent: 0 } },
    { promotionDiscountedPrice: 0 }, { productName: "Different" }, { productImageUrl: "different" }]) {
    const { order } = fixture(); Object.assign(order.items[1], patch); invalid(order);
  }
});

test("unsafe quantities, totals and allocation inconsistencies fail closed", () => {
  for (const mutate of [group => { group.quantity = Number.MAX_SAFE_INTEGER; }, group => { group.lineTotalPiastres++; },
    group => { group.components[0].quantity = 0; }, group => { group.components[0].allocations[0].quantity++; },
    group => { group.components[0].allocations[0].unitPricePiastres++; }, group => { group.originalUnitPricePiastres--; },
    group => { group.components[0].allocations = []; }, group => { group.components[0].regularUnitPricePiastres = Infinity; }]) {
    const { order } = fixture(); mutate(order.bundleGroups[0]); invalid(order);
  }
});

test("order validate middleware catches orphan associations and changed persisted nested snapshots", async () => {
  const { order } = fixture(); const orphan = copy(order); delete orphan.bundleGroups;
  await assert.rejects(new OrderModel(orphan).validate(), { code: "BUNDLE_ORDER_SNAPSHOT_INVALID" });
  const persisted = OrderModel.hydrate(new OrderModel(order).toObject());
  persisted.bundleGroups[0].name = "Edited after purchase";
  await assert.rejects(persisted.validate(), /immutable/);
  const untouched = OrderModel.hydrate(new OrderModel(order).toObject()); await untouched.validate();
});

test("ordinary allocation lines and source plan cannot smuggle bundle membership or duplicate line IDs", () => {
  const { plan, ordinaryItems } = fixture();
  assert.throws(() => buildBundleOrderMerchandise({ plan, ordinaryItems: [{ ...ordinaryItems[0], bundleGroupId: G }], userId: U }), { code: "BUNDLE_ORDER_SNAPSHOT_INVALID" });
  assert.throws(() => buildBundleOrderMerchandise({ plan, ordinaryItems: [ordinaryItems[0], ordinaryItems[0]], userId: U }), { code: "BUNDLE_ORDER_SNAPSHOT_INVALID" });
  assert.throws(() => buildBundleOrderMerchandise({ plan, userId: null }), { code: "BUNDLE_ORDER_SNAPSHOT_INVALID" });
});

test("bundle line guards leave ordinary substitution available and forbid partial bundle sources", () => {
  const { order } = fixture(); assert.doesNotThrow(() => assertBundleLineCanSubstitute(order.items[0]));
  assert.throws(() => assertBundleLineCanSubstitute(order.items[1]), { code: "BUNDLE_ORDER_SUBSTITUTION_UNSUPPORTED" });
  assert.throws(() => assertBundleLineCanSubstitute({ bundleComponentIndex: 0 }), { code: "BUNDLE_ORDER_SUBSTITUTION_UNSUPPORTED" });
});

test("existing reorder refuses grouped orders after ownership and before any cart read", async t => {
  const { order } = fixture(); t.mock.method(OrderModel, "findById", () => ({ lean: async () => order }));
  t.mock.method(CartModel, "findOne", () => assert.fail("No cart read or mutation for unsupported bundle reorder"));
  await assert.rejects(reorderService({ userId: U, orderId: OTHER }), { code: "BUNDLE_ORDER_REORDER_REQUIRED" });
  await assert.rejects(reorderService({ userId: OTHER, orderId: OTHER }), /Order not found/);
});

test("order history keeps purchased bundle labels without loading later catalog names", async t => {
  const { order } = fixture({ ordinary: false });
  const query = { select() { return this; }, populate() { return this; }, lean: async () => order };
  t.mock.method(OrderModel, "findById", () => query);
  t.mock.method(ProductModel, "find", () => assert.fail("Bundle history uses saved display snapshots"));
  const result = await getMyOrderByIdService({ userId: U, orderId: OTHER, lang: "ar" });
  assert.equal(presentOrder(result).bundles[0].name, "Triple");
});
