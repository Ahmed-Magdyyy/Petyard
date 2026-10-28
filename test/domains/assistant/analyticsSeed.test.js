import test from "node:test";
import assert from "node:assert/strict";
import { analyticsSeed } from "./fixtures/analyticsSeed.js";
import { createSharedMongoManifest } from "./fixtures/sharedMongo.js";

test("analytics fixtures stay registered, use an isolated warehouse and respect unique user emails", () => {
  const manifest = createSharedMongoManifest(); const { seed, actor, warehouse, sold } = analyticsSeed(manifest);
  assert.equal(seed.length, 5); assert.match(seed[0].document.email, /^[a-f\d]{24}@assistant-test\.invalid$/);
  for (const { collection, document } of seed) assert.ok(manifest.records[collection].includes(String(document._id)));
  assert.equal(String(warehouse), manifest.warehouse);
  for (const { document } of seed.filter((entry) => entry.collection === "products")) {
    assert.equal(String(document.warehouseStocks[0].warehouse), String(warehouse));
  }
  const orders = seed.filter((entry) => entry.collection === "orders").map((entry) => entry.document);
  assert.deepEqual(orders.map((order) => order.total), [240, 100]);
  assert.equal(orders[0].items[0].quantity * orders[0].items[0].itemPrice, 200);
  for (const order of orders) {
    assert.equal(String(order.warehouse), String(warehouse)); assert.equal(String(order.user), String(actor));
    assert.equal(String(order.items[0].product), String(sold)); assert.equal(order.status, "delivered");
  }
});
