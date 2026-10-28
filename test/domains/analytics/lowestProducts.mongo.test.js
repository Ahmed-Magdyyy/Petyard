import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { getLowestProductsService } from "../../../src/domains/analytics/analytics.lowest-products.js";
import { getHighestProductsService } from "../../../src/domains/analytics/analytics.highest-products.js";
import { getTopProductsService } from "../../../src/domains/analytics/analytics.service.js";
import { createAssistantTestDbName, validateAssistantMongoTarget } from "../assistant/fixtures/mongoTarget.js";
import { cleanupAssistantTestCollections, cleanupAssistantTestResources } from "../assistant/fixtures/mongoCleanup.js";

test("isolated Mongo highest and lowest sellers preserve distinct populations and existing top sellers", {
  skip: !process.env.ASSISTANT_TEST_MONGO_URI && "Requires explicitly authorized assistant test target",
}, async (t) => {
  const uri = validateAssistantMongoTarget(process.env.ASSISTANT_TEST_MONGO_URI, process.env.ASSISTANT_TEST_ATLAS_HOST);
  const database = createAssistantTestDbName(); uri.pathname = `/${database}`; let connected = false;
  t.after(() => cleanupAssistantTestResources({ servers: [],
    cleanupCollections: () => connected ? cleanupAssistantTestCollections(mongoose.connection, database) : undefined,
    disconnect: () => mongoose.disconnect(), restoreEnvironment() {},
  }));
  await mongoose.connect(uri.href, { serverSelectionTimeoutMS: 3000 }); connected = true; t.diagnostic(`assistant_test_database=${database}`);
  const warehouse = new mongoose.Types.ObjectId(); const other = new mongoose.Types.ObjectId();
  const products = Array.from({ length: 9 }, (_, index) => ({ _id: new mongoose.Types.ObjectId(), slug: `lowest-${index}`, name_en: `Product ${index}`,
    name_ar: `منتج ${index}`, type: "SIMPLE", isActive: true, createdAt: new Date("2026-01-01"), warehouseStocks: [{ warehouse, quantity: 0 }] }));
  products[1].type = "VARIANT"; products[1].warehouseStocks = []; products[1].variants = [{ warehouseStocks: [{ warehouse, quantity: 0 }] }];
  products[4].createdAt = new Date("2026-09-15"); products[5].isActive = false;
  products[6].createdAt = new Date("2026-08-31T21:00:00Z"); products[7].warehouseStocks = [{ warehouse: other, quantity: 10 }];
  delete products[8].createdAt;
  await ProductModel.collection.insertMany(products);
  const deleted = new mongoose.Types.ObjectId();
  const line = (index, quantity, itemPrice, extras = {}) => ({ product: products[index]._id, quantity, itemPrice, ...extras });
  await OrderModel.collection.insertMany([
    { orderNumber: "low-primary", warehouse, createdAt: new Date("2026-08-31T21:00:00Z"), status: "pending", items: [
      line(2, 99, 100, { fulfillmentQuantity: 2 }), line(3, 5, 10), line(3, 1, 10), line(0, 99, 100, { fulfillmentQuantity: 0 }),
      line(4, 1000, 10), line(5, 8, 2), { product: deleted, quantity: 4, itemPrice: 20 }] },
    { orderNumber: "low-failed", warehouse, createdAt: new Date("2026-09-30T20:59:59.999Z"), status: "failed", items: [line(2, 1, 100)] },
    ...["cancelled", "returned"].map((status) => ({ orderNumber: `low-${status}`, warehouse, createdAt: new Date("2026-09-15"), status, items: [line(0, 100, 100)] })),
    { orderNumber: "low-next-month", warehouse, createdAt: new Date("2026-09-30T21:00:00Z"), status: "delivered", items: [line(0, 100, 100)] },
    { orderNumber: "low-other", warehouse: other, createdAt: new Date("2026-09-15"), status: "delivered", items: [line(0, 7, 1)] },
    { orderNumber: "highest-ties-free", warehouse, createdAt: new Date("2026-07-15"), status: "delivered",
      items: [line(2, 2, 1), line(3, 2, 0), { product: deleted, quantity: 1, itemPrice: 5 }] },
  ]);
  const query = { month: "2026-09", metric: "units", warehouse: String(warehouse), limit: "50" };
  const now = new Date("2026-10-19T12:00:00Z");
  const units = await getLowestProductsService(query, now);
  assert.deepEqual(units.results.map((row) => row.productId), products.slice(0, 4).map((row) => String(row._id)));
  assert.deepEqual(units.results.map((row) => row.unitsSold), [0, 0, 3, 6]);
  assert.deepEqual(units.results.map((row) => row.recordedItemValue), [0, 0, 300, 60]);
  const values = await getLowestProductsService({ ...query, metric: "item_value" }, now);
  assert.deepEqual(values.results.map((row) => row.productId), [0, 1, 3, 2].map((index) => String(products[index]._id)));
  const all = await getLowestProductsService({ month: "2026-09", metric: "units", limit: "50" }, now);
  assert.equal(all.results.find((row) => row.productId === String(products[0]._id)).unitsSold, 7);
  assert.ok(all.results.some((row) => row.productId === String(products[7]._id)));
  const empty = await getLowestProductsService({ ...query, warehouse: String(new mongoose.Types.ObjectId()) }, now);
  assert.deepEqual(empty.results, []);
  const limited = await getLowestProductsService({ ...query, limit: "1" }, now);
  assert.equal(limited.results.length, 1); assert.equal(limited.results[0].productId, String(products[0]._id));
  const top = await getTopProductsService({ from: "2026-08-31T21:00:00Z", to: "2026-09-30T20:59:59.999Z", warehouse });
  assert.deepEqual(top.topProducts.map((row) => String(row.productId)), [products[4]._id, products[2]._id, deleted, products[3]._id, products[5]._id].map(String));
  assert.equal(top.topProducts[0].totalIncome, 10000); assert.equal(top.topProducts[2].name, "Deleted Product");
  const highest = await getHighestProductsService(query, now);
  assert.deepEqual(highest.results.map((row) => row.productId), [4, 5, 3].map((index) => String(products[index]._id)).concat(String(deleted), String(products[2]._id)));
  assert.deepEqual(highest.results.map((row) => row.unitsSold), [1000, 8, 6, 4, 3]);
  const missing = highest.results.find((row) => row.productId === String(deleted));
  assert.equal(missing.catalogPresent, false); assert.equal(missing.name_en, null); assert.equal(missing.imageUrl, null);
  assert.equal(highest.results.find((row) => row.productId === String(products[5]._id)).catalogPresent, true);
  const highValues = await getHighestProductsService({ ...query, metric: "item_value" }, now);
  assert.deepEqual(highValues.results.map((row) => row.productId), top.topProducts.map((row) => String(row.productId)));
  assert.deepEqual(highValues.results.map((row) => row.recordedItemValue), [10000, 300, 80, 60, 16]);
  const ties = await getHighestProductsService({ ...query, month: "2026-07" }, now);
  assert.deepEqual(ties.results.map((row) => row.productId), [products[2]._id, products[3]._id, deleted].map(String));
  const free = await getHighestProductsService({ ...query, month: "2026-07", metric: "item_value" }, now);
  assert.equal(free.results.at(-1).recordedItemValue, 0); assert.equal(free.results.at(-1).unitsSold, 2);
  const highAll = await getHighestProductsService({ month: "2026-09", metric: "units", limit: "50" }, now);
  assert.ok(highAll.results.some((row) => row.productId === String(products[0]._id) && row.unitsSold === 7));
  assert.deepEqual((await getHighestProductsService({ ...query, warehouse: String(new mongoose.Types.ObjectId()) }, now)).results, []);
  assert.equal((await getHighestProductsService({ ...query, limit: "1" }, now)).results.length, 1);
});
