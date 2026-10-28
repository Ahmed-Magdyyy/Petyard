import assert from "node:assert/strict";
import test from "node:test";
import { buildBundlePurchaseSnapshot } from "../../../src/domains/bundle/bundle.purchase-snapshot.js";
import { calculateMerchandiseGrossPiastres } from "../../../src/domains/settlement/settlement.pricing.js";
import { aggregateInventoryDemands } from "../../../src/domains/inventory/inventory.service.js";

const x = "a00000000000000000000001", y = "a00000000000000000000002", variant = "b00000000000000000000001";
const here = "c00000000000000000000001", elsewhere = "c00000000000000000000002";
const bundleId = "d00000000000000000000001", groupId = "e00000000000000000000001";
function fixture() {
  return { groupId, warehouseId: here, warehouse: { _id: here, active: true }, expectedRevision: 2, quantity: 2,
    bundle: { _id: bundleId, origin: "manual", status: "published", revision: 2, name_en: "Essentials", name_ar: "الأساسيات",
      pricePiastres: 23000, components: [{ productId: x, productType: "SIMPLE", quantity: 2 },
        { productId: y, productType: "VARIANT", variantId: variant, quantity: 1 }] },
    products: [{ _id: x, type: "SIMPLE", isActive: true, name_en: "Food", name_ar: "أكل", price: 100, discountedPrice: 1,
      warehouseStocks: [{ warehouse: here, quantity: 9 }] },
    { _id: y, type: "VARIANT", isActive: true, name_en: "Litter", name_ar: "رمل", variants: [
      { _id: variant, price: 80, discountedPrice: 1, options: [{ name: "Weight", value: "5kg" }], warehouseStocks: [{ warehouse: here, quantity: 5 }] },
      { _id: x, price: 1, warehouseStocks: [{ warehouse: elsewhere, quantity: 1000 }] }] }] };
}
const summedDemands = items => aggregateInventoryDemands(items).map(({ productId, productType, variantId, quantity }) => ({ productId, productType, variantId, quantity }));

test("purchase snapshot preserves bundle identity, fixed price and exact physical stock demands", () => {
  const { snapshot, itemDrafts, inventory } = buildBundlePurchaseSnapshot(fixture());
  assert.equal(snapshot.id, groupId); assert.equal(snapshot.bundleId, bundleId); assert.equal(snapshot.bundleRevision, 2);
  assert.equal(snapshot.unitPricePiastres, 23000); assert.equal(snapshot.originalUnitPricePiastres, 28000);
  assert.equal(snapshot.lineTotalPiastres, 46000); assert.equal(snapshot.quantity, 2);
  assert.deepEqual(inventory, { warehouseId: here, demands: [
    { productId: x, productType: "SIMPLE", variantId: null, quantity: 4 },
    { productId: y, productType: "VARIANT", variantId: variant, quantity: 2 }] });
  assert.deepEqual(summedDemands(itemDrafts), inventory.demands);
  assert.equal(calculateMerchandiseGrossPiastres(itemDrafts), 46000);
  assert.ok(itemDrafts.every(row => row.bundleGroupId === groupId && row.promotion === null && row.fulfillmentQuantity === row.quantity));
});

test("one pound over three identical units produces exact 33/34-piastre cohorts without losing physical units", () => {
  const f = fixture(); f.bundle.components = [{ productId: x, productType: "SIMPLE", quantity: 3 }]; f.bundle.pricePiastres = 100;
  const { snapshot, itemDrafts, inventory } = buildBundlePurchaseSnapshot(f);
  assert.deepEqual(snapshot.components[0].allocations, [{ quantity: 2, unitPricePiastres: 33 }, { quantity: 1, unitPricePiastres: 34 }]);
  assert.deepEqual(itemDrafts.map(row => [row.quantity, row.itemPricePiastres, row.lineTotalPiastres]), [[4, 33, 132], [2, 34, 68]]);
  assert.equal(calculateMerchandiseGrossPiastres(itemDrafts), 200); assert.equal(inventory.demands[0].quantity, 6);
});

test("allocation is proportional to regular exact-variant prices and never stacks component discounts", () => {
  const f = fixture(); f.bundle.pricePiastres = 14000;
  const result = buildBundlePurchaseSnapshot(f);
  assert.deepEqual(result.snapshot.components.map(row => row.allocations), [
    [{ quantity: 2, unitPricePiastres: 5000 }], [{ quantity: 1, unitPricePiastres: 4000 }]]);
  assert.equal(calculateMerchandiseGrossPiastres(result.itemDrafts), 28000);
});

test("fractional ties use canonical exact-SKU order regardless of source arrays or duplicate definition entries", () => {
  const f = fixture(); f.products[0].price = 1; f.products[1].variants[0].price = 1; f.bundle.pricePiastres = 1;
  f.bundle.components[0].quantity = 1;
  const first = buildBundlePurchaseSnapshot(f);
  f.bundle.components.reverse(); f.products.reverse();
  assert.deepEqual(buildBundlePurchaseSnapshot(f), first);
  assert.equal(first.snapshot.components[0].allocations[0].unitPricePiastres, 1);
  assert.equal(first.snapshot.components[1].allocations[0].unitPricePiastres, 0);
  const duplicate = fixture(); duplicate.bundle.components[0].quantity = 1;
  duplicate.bundle.components.push({ productId: x.toUpperCase(), productType: "SIMPLE", quantity: 1 });
  assert.deepEqual(buildBundlePurchaseSnapshot(duplicate), buildBundlePurchaseSnapshot(fixture()));
});

test("zero-priced components get zero allocation while a low positive bundle still totals correctly", () => {
  const f = fixture(); f.products[0].price = 0; f.products[0].discountedPrice = 0; f.bundle.pricePiastres = 1;
  const result = buildBundlePurchaseSnapshot(f);
  assert.equal(result.snapshot.components[0].allocations[0].unitPricePiastres, 0);
  assert.equal(calculateMerchandiseGrossPiastres(result.itemDrafts), 2);
  assert.deepEqual(summedDemands(result.itemDrafts), result.inventory.demands);
});

test("saved snapshots retain purchased contents, names, options and prices after later source edits", () => {
  const f = fixture(), before = structuredClone(f), result = buildBundlePurchaseSnapshot(f), saved = structuredClone(result);
  assert.deepEqual(f, before);
  f.bundle.components[0].quantity = 99; f.bundle.pricePiastres = 1; f.bundle.revision++;
  f.products[1].variants[0].options[0].value = "changed"; f.products[0].name_en = "changed";
  assert.deepEqual(result, saved);
  result.itemDrafts.find(row => row.productType === "VARIANT").variantOptions[0].value = "changed";
  assert.equal(result.snapshot.components[1].variantOptions[0].value, "5kg");
});

test("revision, identifier, language and exact-warehouse context errors fail before a purchase can be saved", () => {
  for (const change of [{ groupId: "bad" }, { warehouseId: "bad" }, { language: "arabizi" }, { expectedRevision: "2" }, { expectedRevision: 0 }]) {
    assert.throws(() => buildBundlePurchaseSnapshot({ ...fixture(), ...change }), { code: "BUNDLE_PURCHASE_INVALID" });
  }
  assert.throws(() => buildBundlePurchaseSnapshot({ ...fixture(), expectedRevision: 1 }), { code: "BUNDLE_REVISION_CONFLICT" });
  assert.throws(() => buildBundlePurchaseSnapshot({ ...fixture(), warehouseId: elsewhere }), { code: "BUNDLE_WAREHOUSE_UNAVAILABLE" });
  for (const quantity of [0, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildBundlePurchaseSnapshot({ ...fixture(), quantity }), { code: "BUNDLE_INVALID_QUANTITY" });
  }
});

test("publication, warehouse operation, price drift and exact SKU stock admission remain authoritative", () => {
  for (const mutate of [f => { f.bundle.status = "paused"; }, f => { f.bundle.origin = "ai"; }, f => { f.bundle.pricePiastres = 0; },
    f => { f.bundle.pricePiastres = 28001; }, f => { f.warehouse.active = false; },
    f => { f.warehouse.fulfillment = { status: "MAINTENANCE", fallbackWarehouse: elsewhere }; },
    f => { f.products[0].isActive = false; }, f => { f.products[1].variants[0].warehouseStocks[0].warehouse = elsewhere; }]) {
    const f = fixture(); mutate(f); assert.throws(() => buildBundlePurchaseSnapshot(f), { code: "BUNDLE_PURCHASE_UNAVAILABLE" });
  }
  assert.throws(() => buildBundlePurchaseSnapshot({ ...fixture(), quantity: 5 }), { code: "BUNDLE_STOCK_CONFLICT" });
});

test("large exact quantities use bounded cohorts, reject overflow and preserve safe integer totals", () => {
  const f = fixture(); f.bundle.components = [{ productId: x, productType: "SIMPLE", quantity: Number.MAX_SAFE_INTEGER }];
  f.products[0].price = 0.01; f.products[0].warehouseStocks[0].quantity = Number.MAX_SAFE_INTEGER;
  f.quantity = 1; f.bundle.pricePiastres = 1;
  const result = buildBundlePurchaseSnapshot(f);
  assert.equal(result.itemDrafts.length, 2); assert.equal(calculateMerchandiseGrossPiastres(result.itemDrafts), 1);
  assert.equal(result.inventory.demands[0].quantity, Number.MAX_SAFE_INTEGER);
  assert.throws(() => buildBundlePurchaseSnapshot({ ...f, quantity: 2 }), { code: "BUNDLE_INVALID_QUANTITY" });
  const overflow = fixture(); overflow.bundle.components = [{ productId: x, productType: "SIMPLE", quantity: 1 }];
  overflow.products[0].price = 40000000000000; overflow.bundle.pricePiastres = 4000000000000000; overflow.quantity = 3;
  assert.throws(() => buildBundlePurchaseSnapshot(overflow), { code: "BUNDLE_PURCHASE_OVERFLOW" });
});

test("Arabic labels remain normal Arabic script and private source metadata is not saved", () => {
  const f = fixture(); f.language = "ar"; f.bundle.createdBy = "private staff"; f.products[0].cost = "private cost";
  const result = buildBundlePurchaseSnapshot(f);
  assert.equal(result.snapshot.name, "الأساسيات"); assert.equal(result.itemDrafts[0].productName, "أكل");
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("maximum safe unit amount does not overflow when no extra-piastre cohort is needed", () => {
  const f = fixture(); f.quantity = 1; f.bundle.components = [{ productId: x, productType: "SIMPLE", quantity: 1 }];
  f.products[0].price = Number.MAX_SAFE_INTEGER / 100; f.bundle.pricePiastres = Number.MAX_SAFE_INTEGER;
  const result = buildBundlePurchaseSnapshot(f);
  assert.equal(result.itemDrafts.length, 1);
  assert.equal(result.itemDrafts[0].itemPricePiastres, Number.MAX_SAFE_INTEGER);
  assert.equal(result.snapshot.lineTotalPiastres, Number.MAX_SAFE_INTEGER);
});

test("bounded allocation matrix always preserves exact money and quantities", () => {
  for (const counts of [[1, 1], [2, 3], [7, 4]]) for (const prices of [[1, 1], [7, 13], [0, 11]]) {
    const original = counts[0] * prices[0] + counts[1] * prices[1];
    for (const selling of [...new Set([1, Math.max(1, Math.floor(original / 2)), original])]) {
      const f = fixture(); f.bundle.components[0].quantity = counts[0]; f.bundle.components[1].quantity = counts[1];
      f.products[0].price = prices[0] / 100; f.products[1].variants[0].price = prices[1] / 100;
      f.products[0].warehouseStocks[0].quantity = 100; f.products[1].variants[0].warehouseStocks[0].quantity = 100;
      f.bundle.pricePiastres = selling;
      const result = buildBundlePurchaseSnapshot(f);
      assert.equal(calculateMerchandiseGrossPiastres(result.itemDrafts), selling * f.quantity);
      assert.deepEqual(summedDemands(result.itemDrafts), result.inventory.demands);
      assert.ok(result.snapshot.components.every(row => row.allocations.length <= 2));
    }
  }
});
