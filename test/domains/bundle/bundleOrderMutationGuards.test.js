import assert from "node:assert/strict";
import test from "node:test";

// This test file's isolated process enables only the existing substitution admission fixture.
process.env.ORDER_SUBSTITUTIONS_ENABLED = "true";
process.env.ORDER_SUBSTITUTION_WAREHOUSE_ALLOWLIST = "";
const { default: mongoose } = await import("mongoose");
const { OrderModel } = await import("../../../src/domains/order/order.model.js");
const { ProductModel } = await import("../../../src/domains/product/product.model.js");
const { SubstitutionRequestModel } = await import("../../../src/domains/substitution/substitutionRequest.model.js");
const { listSubstitutionCandidatesService, createSubstitutionOfferService } = await import("../../../src/domains/substitution/substitution.service.js");

const W = "222222222222222222222222", P = "333333333333333333333333", G = "555555555555555555555555";
function fixture(t) {
  const s = { order: { _id: "111111111111111111111111", warehouse: W, status: "pending", sideEffectsCommitted: true,
    paymentMethod: "cod", settlement: { migrationState: "native" }, items: [{ lineId: "line-1", product: P,
      productType: "SIMPLE", quantity: 3, fulfillmentQuantity: 3, bundleGroupId: G, bundleComponentIndex: 0 }] }, ends: 0 };
  const query = value => ({ lean() { return this; }, session() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
  t.mock.method(OrderModel, "findById", () => query(s.order));
  t.mock.method(SubstitutionRequestModel, "findOne", () => query(null));
  t.mock.method(ProductModel, "find", () => query([]));
  t.mock.method(mongoose, "startSession", async () => ({ withTransaction: async callback => callback(), endSession: async () => { s.ends++; } }));
  for (const Model of Object.values(mongoose.models)) {
    for (const method of ["create", "insertMany", "updateOne", "updateMany", "deleteOne", "deleteMany", "bulkWrite"]) {
      t.mock.method(Model, method, () => assert.fail("Rejected source cannot mutate models"));
      if (typeof Model.collection[method] === "function") t.mock.method(Model.collection, method, () => assert.fail("Rejected source cannot mutate raw collections"));
    }
    t.mock.method(Model.prototype, "save", () => assert.fail("Rejected source cannot save"));
  }
  return s;
}

test("candidate route service rejects bundle sources before any candidate product read", async t => {
  const s = fixture(t); t.mock.method(ProductModel, "find", () => assert.fail("No candidate product read"));
  await assert.rejects(listSubstitutionCandidatesService({ orderId: s.order._id, lineId: "line-1", warehouseScope: [W], lang: "en" }),
    { code: "BUNDLE_ORDER_SUBSTITUTION_UNSUPPORTED" });
  assert.equal(s.ends, 0);
});

test("offer route service rejects bundle shortages before corrections or writes", async t => {
  const s = fixture(t), before = JSON.stringify(s.order);
  await assert.rejects(createSubstitutionOfferService({ orderId: s.order._id, actorUserId: P, warehouseScope: [W],
    idempotencyKey: "bundle-guard", shortages: [{ lineId: "line-1", deliverableOriginalQuantity: 0,
      expectedUnallocatedQuantity: 0, correctedUnallocatedQuantity: 0, alternatives: [] }] }),
  { code: "BUNDLE_ORDER_SUBSTITUTION_UNSUPPORTED" });
  assert.equal(s.ends, 1); assert.equal(JSON.stringify(s.order), before);
});
