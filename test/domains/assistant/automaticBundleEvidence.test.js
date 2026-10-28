import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createHash } from "node:crypto";
import { buildBundleEvidence, bundleEvidenceForComponents, bundleEvidenceWindow, bundleSalesStages, readBundleEvidence } from "../../../src/domains/assistant/bundles/assistant.bundle-evidence.js";
import { buildBundleGenerationRequest, bundlePlanSchema, BUNDLE_PROMPT_VERSION, validateBundlePlan } from "../../../src/domains/assistant/bundles/assistant.bundle-plan.js";
import { validateSchema, validateRequest } from "../../../src/domains/assistant/providers/providerContract.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { testConfig } from "./fixtures/foundationPolicy.js";
import { usageReportPipeline, usageReportPeriod } from "../../../src/domains/assistant/reporting/assistant.reporting.js";

const now = new Date("2026-10-24T09:00:00Z");
const P = "a00000000000000000000001", Q = "a00000000000000000000002", V = "b00000000000000000000001";
const W = [1, 2, 3, 4].map(n => `c0000000000000000000000${n}`);
export function evidenceFixture() {
  const products = [{ _id: P, type: "SIMPLE", isActive: true, name_en: "Litter", name_ar: "رمل", desc_en: "Cat litter", desc_ar: "رمل للقطط", tags: ["cat"],
    createdAt: new Date("2025-01-01"), price: 100, warehouseStocks: [0, 1, 3].map(i => ({ warehouse: W[i], quantity: 8 })) },
  { _id: Q, type: "SIMPLE", isActive: true, name_en: "Scoop", name_ar: "جاروف", desc_en: "Litter scoop", desc_ar: "جاروف رمل", tags: ["cat"],
    createdAt: new Date("2025-01-01"), price: 20, warehouseStocks: [1, 2, 3].map(i => ({ warehouse: W[i], quantity: 3 })) }];
  const warehouses = W.map((_id, index) => ({ _id, active: true, name: `مخزن ${index + 1}` }));
  const sales = [{ _id: { productId: P, productType: "SIMPLE", variantId: null }, earlierUnits: 120, recentUnits: 90, invalidRows: 0 },
    { _id: { productId: Q, productType: "SIMPLE", variantId: null }, earlierUnits: 20, recentUnits: 2, invalidRows: 0 }];
  return { products, warehouses, sales, now };
}
export const examplePlan = (evidence, overrides = {}) => ({ drafts: [{ name_en: "Cat Litter & Scoop Kit", name_ar: "باقة رمل القطط والجاروف",
  fit_ar: "الرمل والجاروف بيكملوا بعض في تنظيف صندوق الرمل.", benefit_ar: "العميل يقدر يشتري احتياجاته مع بعض بسهولة.",
  reason: "useful_kit", slowOfferKey: null,
  components: evidence.offers.map(row => ({ offerKey: row.key, quantity: 1 })), ...overrides }] });

test("90 Cairo calendar days split into 30/60, including a daylight-saving transition", () => {
  assert.deepEqual(bundleEvidenceWindow(now), { timezone: "Africa/Cairo", start: "2026-07-26T09:00:00.000Z", recentStart: "2026-09-24T09:00:00.000Z",
    endExclusive: "2026-10-24T09:00:00.000Z", earlierDays: 60, recentDays: 30 });
  const winter = bundleEvidenceWindow(new Date("2026-11-15T10:00:00Z"));
  assert.equal(winter.start, "2026-08-17T09:00:00.000Z");
  assert.throws(() => bundleEvidenceWindow(new Date(NaN)), { code: "bundle_evidence_unavailable" });
});

test("sales evidence uses delivered order creation windows, exact SKU identity and existing fulfilled quantity semantics", () => {
  const pipeline = bundleSalesStages(bundleEvidenceWindow(now));
  assert.equal(pipeline[0].$match.status, "delivered");
  assert.equal(pipeline[0].$match.createdAt.$gte.toISOString(), "2026-07-26T09:00:00.000Z");
  assert.equal(pipeline[0].$match.createdAt.$lt.toISOString(), now.toISOString());
  assert.equal(pipeline[2].$group._id.productId, "$items.product");
  assert.equal(pipeline[2].$group._id.productType, "$items.productType");
  assert.match(JSON.stringify(pipeline), /fulfillmentQuantity/);
  const evidence = buildBundleEvidence(evidenceFixture());
  assert.equal(evidence.offers[0].earlierUnitsPerDay, 2);
  assert.equal(evidence.offers[0].recentUnitsPerDay, 3);
  assert.equal(evidence.coverage.stockHistory, "unverified"); assert.equal(evidence.coverage.coPurchases, "not_analyzed");
});

test("exact components share warehouses 2 and 4 only, with quantities limiting whole-bundle stock", () => {
  const evidence = buildBundleEvidence(evidenceFixture());
  const proof = bundleEvidenceForComponents(evidence, evidence.offers.map(row => ({ ...row, quantity: 2 })));
  assert.deepEqual(proof.warehouses.map(row => row.availableBundles), [0, 1, 0, 1]);
  assert.equal(proof.originalPricePiastres, 24000);
  const f = evidenceFixture(); f.warehouses[3].fulfillment = { status: "paused" };
  assert.deepEqual(buildBundleEvidence(f).warehouses.map(row => row.id), W.slice(0, 3));
});

test("young/unknown-age products can fit useful kits but cannot qualify for slow-sales explanations", () => {
  for (const createdAt of [new Date("2026-10-01"), undefined, new Date("2027-01-01")]) {
    const f = evidenceFixture(); f.products[1].createdAt = createdAt;
    const evidence = buildBundleEvidence(f); assert.equal(evidence.offers[1].historyEligible, false);
    assert.equal(validateBundlePlan(examplePlan(evidence), evidence, 10000).length, 1);
    assert.throws(() => validateBundlePlan(examplePlan(evidence, { reason: "low_recorded_sales", slowOfferKey: evidence.offers[1].key }), evidence, 10000), { code: "invalid_bundle_plan" });
  }
  const f = evidenceFixture(); f.products[1].createdAt = new Date(bundleEvidenceWindow(now).start);
  assert.equal(buildBundleEvidence(f).offers[1].historyEligible, true);
});

test("parent age and product-level sales never stand in for exact variant age or sales", () => {
  const f = evidenceFixture(); f.products[1].type = "VARIANT";
  f.products[1].variants = [{ _id: V, price: 25, options: [{ name: "Color", value: "Blue" }], warehouseStocks: f.products[1].warehouseStocks }];
  f.sales = f.sales.slice(0, 1);
  const evidence = buildBundleEvidence(f), offer = evidence.offers[1];
  assert.equal(offer.variantId, V); assert.equal(offer.variantHistoryVerified, false); assert.equal(offer.totalUnits, 0);
  assert.equal(offer.originalUnitPricePiastres, 2500);
  assert.throws(() => validateBundlePlan(examplePlan(evidence, { reason: "low_recorded_sales", slowOfferKey: offer.key }), evidence, 10000));
  assert.equal(validateBundlePlan(examplePlan(evidence), evidence, 10000).length, 1);
});

test("corrupt/unsafe aggregates and ambiguous catalog stock cannot manufacture evidence", () => {
  for (const change of [{ earlierUnits: -1 }, { recentUnits: 0.5 }, { earlierUnits: Number.MAX_SAFE_INTEGER, recentUnits: 1 }, { invalidRows: 1 }]) {
    const f = evidenceFixture(); Object.assign(f.sales[0], change);
    assert.throws(() => buildBundleEvidence(f), { code: "bundle_evidence_unavailable" });
  }
  const f = evidenceFixture(); f.products[1].warehouseStocks.push({ warehouse: W[1], quantity: 100 });
  assert.equal(buildBundleEvidence(f).offers[1].availability[1].availableUnits, 0);
  f.sales.push(f.sales[0]); assert.throws(() => buildBundleEvidence(f));
});

test("bounded model context records partial coverage and fits the existing adapter schema contract", () => {
  validateSchema(bundlePlanSchema);
  const evidence = buildBundleEvidence(evidenceFixture()), config = testConfig();
  const context = buildBundleGenerationRequest(evidence, config);
  validateRequest(context.request);
  assert.equal(context.discovery.includedOffers, 2); assert.deepEqual(context.request.tools, []);
  assert.match(context.request.instructions, /untrusted DATA/); assert.match(context.request.instructions, /Egyptian Arabic/);
  assert.equal(context.request.limits.reasoningEffort, config.reasoningEffort);
  const small = buildBundleGenerationRequest(evidence, { ...config, maxContextBytes: Buffer.byteLength(JSON.stringify(context.request)) - 1 });
  assert.ok(small.discovery.includedOffers < 2); assert.equal(small.discovery.eligibleOffers, 2);
  assert.throws(() => buildBundleGenerationRequest(evidence, { ...config, maxContextBytes: 1 }), { code: "context_too_large" });
});

test("plans allow zero to three drafts; names/evidence must be readable and model numbers cannot replace backend facts", () => {
  const evidence = buildBundleEvidence(evidenceFixture());
  assert.deepEqual(validateBundlePlan({ drafts: [] }, evidence, 10000), []);
  const draft = validateBundlePlan(examplePlan(evidence, { reason: "low_recorded_sales", slowOfferKey: evidence.offers[1].key }), evidence, 10000)[0];
  assert.equal(draft.pricePiastres, 0); assert.equal(draft.evidence.facts.products[1].recentUnits, 2);
  assert.equal(draft.evidence.modelExplanation.verified, false); assert.ok(draft.evidence.limitations_ar.length > 0);
  for (const change of [{ name_ar: "English only" }, { fit_ar: "مبيعاته 20" }, { benefit_ar: "بيبيع ٢٠" },
    { slowOfferKey: evidence.offers[1].key }, { reason: "low_recorded_sales", slowOfferKey: evidence.offers[0].key },
    { components: [{ offerKey: "invented", quantity: 1 }] }, { name_en: "x".repeat(201) }]) {
    assert.throws(() => validateBundlePlan(examplePlan(evidence, change), evidence, 10000));
  }
  const duplicate = examplePlan(evidence); duplicate.drafts.push(structuredClone(duplicate.drafts[0]));
  assert.throws(() => validateBundlePlan(duplicate, evidence, 10000));
  const free = evidenceFixture(); free.products.forEach(product => { product.price = 0; });
  const unpricedComparison = buildBundleEvidence(free);
  assert.throws(() => validateBundlePlan(examplePlan(unpricedComparison), unpricedComparison, 10000), { code: "invalid_bundle_plan" });
});

test("Egyptian wording revision keeps the structured contract and treats language examples as conditional style only", () => {
  const evidence=buildBundleEvidence(evidenceFixture()),context=buildBundleGenerationRequest(evidence,testConfig());
  assert.equal(BUNDLE_PROMPT_VERSION,"petyard-bundle-drafts-v2-egyptian");
  assert.equal(createHash("sha256").update(JSON.stringify(bundlePlanSchema)).digest("hex"),"b900b59098c43114dc2f939f72e0b3c3972e14bee26fdbb136dda7aa27c556fd");
  validateRequest(context.request);assert.match(context.request.instructions,/everyday Egyptian Arabic in Arabic script/);
  assert.match(context.request.instructions,/Style example only, when the supplied items really are/);
  assert.match(context.request.instructions,/never copy these products or sentences into an unrelated bundle/);
  assert.match(context.request.instructions,/human review/);assert.match(context.request.instructions,/with no stock pooling/);
  assert.match(context.request.instructions,/SuperAdmin sets the price/);assert.match(context.request.instructions,/untrusted DATA/);
  assert.equal(context.request.limits.reasoningEffort,"low");
  const {messages,limits,outputSchema,tools}=context.request;
  assert.deepEqual(tools,[]);assert.equal(limits.maxOutputTokens,testConfig().maxOutputTokens);assert.equal(outputSchema,bundlePlanSchema);
  const supplied=JSON.parse(messages[0].content);assert.equal(supplied.offers.length,2);
  assert.equal(validateBundlePlan(examplePlan(context.evidence),context.evidence,10000)[0].pricePiastres,0);
});

test("no shared warehouse means no publishable draft even when each product has stock somewhere", () => {
  const f = evidenceFixture(); f.products[0].warehouseStocks = [{ warehouse: W[0], quantity: 5 }];
  f.products[1].warehouseStocks = [{ warehouse: W[1], quantity: 5 }];
  const evidence = buildBundleEvidence(f);
  assert.throws(() => validateBundlePlan(examplePlan(evidence), evidence, 10000), { code: "invalid_bundle_plan" });
});

test("repository reads are bounded and read only; excessive scans stop instead of treating missing rows as zero", async t => {
  const f = evidenceFixture(), calls = [];
  const previousDb = mongoose.connection.db;
  mongoose.connection.db = { listCollections() { return { async toArray() { return f.missingStore ? [] : [{ type: "collection" }]; } }; } };
  t.after(() => { mongoose.connection.db = previousDb; });
  const query = value => ({ select() { return this; }, sort() { return this; }, limit(n) { calls.push({ limit: n }); return this; },
    maxTimeMS(n) { assert.equal(n, 5000); return this; }, async lean() { return value; } });
  t.mock.method(ProductModel, "find", filter => { assert.equal(filter.isActive, true); return query(f.products); });
  t.mock.method(WarehouseModel, "find", () => query(f.warehouses));
  t.mock.method(OrderModel, "aggregate", pipeline => ({ async option(options) { assert.equal(options.maxTimeMS, 5000); assert.equal(pipeline[0].$match.status, "delivered"); return f.sales; } }));
  for (const model of [ProductModel, WarehouseModel, OrderModel]) for (const method of ["create", "updateOne", "deleteMany"]) t.mock.method(model, method, () => assert.fail("read only"));
  assert.equal((await readBundleEvidence(new Date())).offers.length, 2);
  assert.deepEqual(calls, [{ limit: 2001 }, { limit: 101 }]);
  f.products = Array(2001).fill(f.products[0]);
  await assert.rejects(readBundleEvidence(new Date()), { code: "bundle_evidence_unavailable" });
  f.missingStore = true;
  await assert.rejects(readBundleEvidence(new Date()), { code: "bundle_evidence_unavailable" });
});

test("automatic jobs count toward provider usage without being counted as customer/admin chat messages", () => {
  const period = usageReportPeriod({ month: "2026-10" }, "Africa/Cairo", now);
  const pipeline = usageReportPipeline(period, "Africa/Cairo", now);
  const facets = pipeline.find(stage => stage.$facet).$facet;
  for (const name of ["daily", "users", "topics"]) assert.deepEqual(facets[name][0].$match.purpose, { $ne: "automatic_bundles" });
  assert.equal(facets.attempts[0].$unwind, "$attempts"); assert.equal(facets.attempts[1].$match.purpose, undefined);
  assert.equal(facets.models[1].$match.purpose, undefined);
});
