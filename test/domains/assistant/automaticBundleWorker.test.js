import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { createHash } from "node:crypto";
import { AssistantAccount, AssistantBudget, AssistantEvent, AssistantRun, AssistantMessage, AssistantAdminMessage } from "../../../src/domains/assistant/shared/assistant.models.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { ProductModel } from "../../../src/domains/product/product.model.js";
import { WarehouseModel } from "../../../src/domains/warehouse/warehouse.model.js";
import { ManualBundle } from "../../../src/domains/bundle/bundle.model.js";
import { buildBundleEvidence } from "../../../src/domains/assistant/bundles/assistant.bundle-evidence.js";
import { bundleGenerationConfig, bundleWeek, enqueueWeeklyBundleGeneration, processBundleGeneration, finishBundleGeneration, recoverBundleGenerations } from "../../../src/domains/assistant/bundles/assistant.bundle-worker.js";
import { mockAssistantTransactions } from "./fixtures/mockAssistantTransactions.js";
import { matchesQuery } from "./fixtures/matchesQuery.js";
import { testConfig, knownUsage } from "./fixtures/foundationPolicy.js";
import { costMicroUsd } from "../../../src/domains/assistant/shared/assistant.config.js";
import { BUNDLE_PROMPT_VERSION } from "../../../src/domains/assistant/bundles/assistant.bundle-plan.js";

const owner = new mongoose.Types.ObjectId("a00000000000000000000001"), W = "b00000000000000000000001";
const P = "c00000000000000000000001", Q = "c00000000000000000000002";
const config = { ...testConfig(), bundleGenerationEnabled: true, bundleCartEnabled: true, bundleGenerationOwner: String(owner) };
const query = read => {
  let limit = Infinity;
  const value = () => { const result = read(); return Array.isArray(result) ? result.slice(0, limit) : result; };
  return { session() { return this; }, select() { return this; }, maxTimeMS() { return this; }, sort() { return this; },
    limit(n) { limit = n; return this; }, async lean() { return value(); }, then(resolve, reject) { return Promise.resolve().then(value).then(resolve, reject); } };
};
function fixture(t) {
  mockAssistantTransactions(t);
  mongoose.connection.db.listCollections = () => ({ async toArray() { return [{ type: "collection" }]; } });
  t.mock.method(ManualBundle.collection, "indexes", async () => [{ name: "_id_", key: { _id: 1 } },
    { name: "manual_bundle_catalog_v1", key: { origin: 1, status: 1, _id: -1 } }]);
  const week = bundleWeek();
  const state = { user: { _id: owner, role: "superAdmin", active: true, phoneVerified: true, account_status: "confirmed" },
    account: { owner, activeRun: week.id, blocked: false, async save() {} },
    products: [P, Q].map((_id, i) => ({ _id, type: "SIMPLE", name_en: i ? "Scoop" : "Litter", name_ar: i ? "جاروف" : "رمل", desc_en: "Cat litter care", desc_ar: "تنظيف رمل القطط",
      price: i ? 20 : 100, isActive: true, createdAt: new Date("2025-01-01"), warehouseStocks: [{ warehouse: W, quantity: 10 }] })),
    warehouses: [{ _id: W, active: true, name: "مخزن" }], drafts: [], events: [], rows: [], calls: 0, budgetWrites: [], budgets: new Map() };
  const makeRun = values => {
    const run = { _id: week.id, owner, chat: owner, purpose: "automatic_bundles", status: "queued", phase: "plan", key: `automatic-bundles/${week.week}`,
      hash: "synthetic", input: "Automatic weekly bundle draft generation", userSequence: 0, contextVersion: 0, createdAt: new Date(),
      deadline: new Date(Date.now() + 60000), bundleWindowEnd: week.end, config: bundleGenerationConfig(config), accounting: "none", attempts: [], attempt: null, reservation: null,
      toObject() { const { save, toObject, ...plain } = this; return { ...plain, attempts: plain.attempts.map(attempt => ({ ...attempt })) }; },
      async save() { assert.equal(new AssistantRun(this.toObject()).validateSync(), undefined); }, ...values };
    return run;
  };
  state.run = makeRun(); state.rows = [state.run];
  t.mock.method(UserModel, "findById", () => query(() => state.user));
  t.mock.method(AssistantAccount, "findOne", () => query(() => state.account));
  t.mock.method(AssistantAccount, "findOneAndUpdate", () => query(() => state.account));
  t.mock.method(AssistantAccount, "updateOne", async filter => {
    if (String(state.account.activeRun) === String(filter.activeRun)) state.account.activeRun = null;
    return { modifiedCount: 1 };
  });
  t.mock.method(AssistantRun, "findOne", filter => query(() => state.rows.find(row => matchesQuery(row, filter)) ?? null));
  t.mock.method(AssistantRun, "findById", id => query(() => state.rows.find(row => String(row._id) === String(id)) ?? null));
  t.mock.method(AssistantRun, "find", filter => query(() => state.rows.filter(row => matchesQuery(row, filter))));
  t.mock.method(AssistantRun, "create", async ([values]) => { const row = makeRun(values); state.rows.push(row); state.run = row; return [row]; });
  t.mock.method(AssistantEvent, "create", async ([values]) => { state.events.push(values); return [{ _id: new mongoose.Types.ObjectId() }]; });
  t.mock.method(AssistantBudget, "findOneAndUpdate", () => query(() => ({ billingTimezone: config.timezone, openingExposure: config.openingExposure, frozen: false })));
  t.mock.method(AssistantBudget, "updateOne", async (filter, update) => {
    state.budgetWrites.push({ filter, update });
    if (state.settlementOutage && update.$inc?.spent !== undefined) throw Error("Synthetic settlement outage");
    let row = state.budgets.get(filter._id);
    if (update.$setOnInsert) { if (!row) state.budgets.set(filter._id, { spent: update.$setOnInsert.spent ?? 0, reserved: 0 }); return { modifiedCount: 1 }; }
    if (update.$set) return { modifiedCount: 1 };
    if (state.budgetDenied && filter.$expr) return { modifiedCount: 0 };
    if (filter.reserved) assert.ok(row.reserved >= filter.reserved.$gte);
    for (const [field, amount] of Object.entries(update.$inc ?? {})) row[field] += amount;
    return { modifiedCount: 1 };
  });
  t.mock.method(ProductModel, "find", () => query(() => state.products));
  t.mock.method(WarehouseModel, "find", () => query(() => state.warehouses));
  t.mock.method(ManualBundle, "find", () => query(() => state.drafts));
  t.mock.method(ManualBundle, "create", async ([values], options) => {
    assert.ok(options.session); assert.equal(new ManualBundle(values).validateSync(), undefined);
    state.drafts.push(values); return [values];
  });
  for (const model of [AssistantMessage, AssistantAdminMessage]) for (const method of ["find", "create"]) t.mock.method(model, method, () => assert.fail("No customer/business chat context or messages"));
  const evidenceReader = async end => buildBundleEvidence({ products: state.products, warehouses: state.warehouses, sales: [], now: end });
  state.options = { getConfig: () => state.currentConfig ?? config, evidenceReader, adapterFactory: () => ({ async generate(request) {
    state.calls++; state.request = request; state.beforeResult?.();
    const evidence = JSON.parse(request.messages[0].content);
    return { usage: knownUsage, serviceTier: "default", finishReason: "completed", toolCalls: [], providerRequestId: "local-only-request", latencyMs: 1,
      structured: { drafts: state.zero ? [] : [{ name_en: "Cat Litter & Scoop Kit", name_ar: "باقة رمل القطط والجاروف", fit_ar: "الرمل والجاروف بيكملوا بعض في تنظيف صندوق الرمل.",
        benefit_ar: "العميل يقدر يشتري احتياجاته مع بعض بسهولة.", reason: "useful_kit", slowOfferKey: null,
        components: evidence.offers.map(offer => ({ offerKey: offer.key, quantity: 1 })) }] }, ...state.resultOverrides };
  } }) };
  return state;
}

test("one bounded paid attempt uses shared budgets and stores unpublished AI drafts with Arabic evidence and no price approval", async t => {
  const state = fixture(t);
  assert.deepEqual(await processBundleGeneration(state.run._id, state.options), { status: "completed" });
  assert.equal(state.calls, 1); assert.equal(state.drafts.length, 1); assert.equal(state.account.activeRun, null);
  assert.equal(state.run.accounting, "settled"); assert.equal(state.run.chargedMicroUsd, costMicroUsd(knownUsage, config));
  assert.equal(state.run.attempts.length, 1); assert.equal(state.run.bundleDraftIds.length, 1);
  const draft = state.drafts[0]; assert.equal(draft.origin, "ai"); assert.equal(draft.status, "draft"); assert.equal(draft.pricePiastres, 0);
  const evidence = JSON.parse(draft.aiEvidenceJson); assert.equal(evidence.runId, String(state.run._id)); assert.equal(evidence.source.reasoningEffort, "low");
  assert.equal(evidence.facts.warehouses[0].availableBundles, 10); assert.equal(evidence.modelExplanation.verified, false);
  assert.deepEqual(await processBundleGeneration(state.run._id, state.options), { skipped: true }); assert.equal(state.calls, 1);
  for (const id of state.budgets.keys()) assert.match(id, /^(global:|user:)/);
});

test("weekly key is global across owners, Cairo Monday-based, and deferred when the configured SuperAdmin is busy", async t => {
  const state = fixture(t);
  assert.equal(bundleWeek(new Date("2026-10-24T09:00:00Z")).week, "2026-10-19");
  assert.equal(String(bundleWeek(new Date("2026-10-19T01:00:00Z")).id), String(bundleWeek(new Date("2026-10-24T09:00:00Z")).id));
  assert.deepEqual(await enqueueWeeklyBundleGeneration(config), { duplicate: true });
  state.rows = []; state.account.activeRun = new mongoose.Types.ObjectId();
  assert.deepEqual(await enqueueWeeklyBundleGeneration(config), { deferred: true }); assert.equal(state.rows.length, 0);
  state.account.activeRun = null;
  assert.equal((await enqueueWeeklyBundleGeneration(config)).queued, true); assert.equal(state.rows.length, 1);
  assert.equal(state.run.purpose, "automatic_bundles"); assert.equal(String(state.account.activeRun), String(state.run._id));
  assert.deepEqual(await enqueueWeeklyBundleGeneration({ ...config, bundleGenerationOwner: "f00000000000000000000001" }), { duplicate: true });
});

test("default-off generation, invalid owner, non-SuperAdmin and expired queues cannot spend", async t => {
  const state = fixture(t);
  assert.deepEqual(await enqueueWeeklyBundleGeneration({ enabled: false }), { enabled: false });
  assert.deepEqual(await processBundleGeneration(state.run._id, { ...state.options, getConfig: () => ({ enabled: false }) }), { skipped: true });
  assert.throws(() => bundleGenerationConfig({ ...config, bundleGenerationOwner: null }), { code: "bundle_generation_disabled" });
  state.user.role = "admin";
  assert.deepEqual(await processBundleGeneration(state.run._id, state.options), { failedBeforeDispatch: true });
  assert.equal(state.calls, 0); assert.equal(state.budgetWrites.length, 0); assert.equal(state.run.status, "failed");
});

test("an older prompt snapshot cannot dispatch after the Egyptian wording revision", async t => {
  const state=fixture(t),current=bundleGenerationConfig(config);
  const signature=createHash("sha256").update(JSON.stringify({base:config.signature,owner:config.bundleGenerationOwner,
    purpose:"automatic_bundles",selection:current.bundleSelectionVersion,prompt:"petyard-bundle-drafts-v1"})).digest("hex");
  assert.equal(current.bundlePromptVersion,BUNDLE_PROMPT_VERSION);assert.notEqual(current.signature,signature);
  state.run.config={...current,signature,bundlePromptVersion:"petyard-bundle-drafts-v1"};
  assert.deepEqual(await processBundleGeneration(state.run._id,state.options),{failedBeforeDispatch:true});
  assert.equal(state.run.publicCode,"configuration_changed");assert.equal(state.calls,0);assert.equal(state.budgetWrites.length,0);
});

test("zero viable catalog and zero model suggestions complete without manufacturing drafts", async t => {
  const state = fixture(t); state.products = state.products.slice(0, 1);
  assert.deepEqual(await processBundleGeneration(state.run._id, state.options), { skipped: true });
  assert.equal(state.run.status, "completed"); assert.equal(state.calls, 0); assert.equal(state.budgetWrites.length, 0);
});

test("a valid zero-suggestion response is accounted once and publishes nothing", async t => {
  const state = fixture(t); state.zero = true;
  await processBundleGeneration(state.run._id, state.options);
  assert.equal(state.calls, 1); assert.equal(state.run.status, "completed"); assert.equal(state.drafts.length, 0);
  assert.deepEqual(state.run.bundleDraftIds, []);
});

test("changed permissions or disabled generation after dispatch charge known usage but withhold drafts", async t => {
  const state = fixture(t); state.beforeResult = () => { state.user.role = "moderator"; };
  await processBundleGeneration(state.run._id, state.options);
  assert.equal(state.run.status, "failed"); assert.equal(state.run.accounting, "settled"); assert.equal(state.calls, 1);
  assert.equal(state.drafts.length, 0); assert.equal(state.account.activeRun, null);
});

test("unknown usage remains reserved and uncertain, with no automatic paid retry", async t => {
  const state = fixture(t); state.resultOverrides = { usage: null };
  await processBundleGeneration(state.run._id, state.options);
  assert.equal(state.run.status, "uncertain"); assert.equal(state.run.accounting, "reserved"); assert.equal(state.drafts.length, 0);
  await processBundleGeneration(state.run._id, state.options); assert.equal(state.calls, 1);
  assert.equal(String(state.account.activeRun), String(state.run._id));
});

test("invalid/truncated or nondefault-tier results are never saved as bundles", async t => {
  const state = fixture(t); state.resultOverrides = { finishReason: "incomplete" };
  await processBundleGeneration(state.run._id, state.options);
  assert.equal(state.run.status, "failed"); assert.equal(state.drafts.length, 0); assert.equal(state.run.accounting, "settled");
});

test("unverified service tier keeps the shared reservation uncertain instead of applying default-tier prices", async t => {
  const state = fixture(t); state.resultOverrides = { serviceTier: "priority" };
  await processBundleGeneration(state.run._id, state.options);
  assert.equal(state.run.status, "uncertain"); assert.equal(state.run.accounting, "reserved"); assert.equal(state.drafts.length, 0);
  assert.equal(state.calls, 1); assert.equal(state.run.providerRequestId, "local-only-request");
});

test("shared budget denial prevents dispatch and before-dispatch adapter failure releases its reservation", async t => {
  const state = fixture(t); state.budgetDenied = true;
  await processBundleGeneration(state.run._id, state.options);
  assert.equal(state.calls, 0); assert.equal(state.run.status, "failed"); assert.equal(state.run.accounting, "none");
});

test("before-dispatch adapter failure settles zero usage and unlocks without a paid call", async t => {
  const state = fixture(t);
  await processBundleGeneration(state.run._id, { ...state.options, adapterFactory() { throw Error("Synthetic adapter failure"); } });
  assert.equal(state.calls, 0); assert.equal(state.run.accounting, "settled"); assert.equal(state.run.chargedMicroUsd, 0);
  assert.equal(state.run.status, "failed"); assert.equal(state.account.activeRun, null);
});

test("generation disabled after dispatch withholds drafts while recording known usage", async t => {
  const state = fixture(t); state.beforeResult = () => { state.currentConfig = { ...config, bundleGenerationEnabled: false }; };
  await processBundleGeneration(state.run._id, state.options);
  assert.equal(state.calls, 1); assert.equal(state.run.status, "failed"); assert.equal(state.run.accounting, "settled"); assert.equal(state.drafts.length, 0);
});

test("stock changed during the model call fails without drafts and settles its known usage", async t => {
  const state = fixture(t); state.beforeResult = () => { state.products[1].warehouseStocks[0].quantity = 0; };
  await processBundleGeneration(state.run._id, state.options);
  assert.equal(state.run.status, "failed"); assert.equal(state.run.publicCode, "bundle_stock_changed");
  assert.equal(state.run.accounting, "settled"); assert.equal(state.drafts.length, 0); assert.equal(state.account.activeRun, null);
  assert.equal(state.run.chargedMicroUsd, costMicroUsd(knownUsage, config));
});

test("references changed during the model call are withheld without erasing known usage", async t => {
  const state = fixture(t); state.beforeResult = () => { state.products[1].type = "VARIANT"; state.products[1].variants = []; };
  await processBundleGeneration(state.run._id, state.options);
  assert.equal(state.run.status, "failed"); assert.equal(state.run.accounting, "settled"); assert.equal(state.drafts.length, 0);
});

test("a zero component-total price after dispatch cannot create an unpublishable priced offer", async t => {
  const state = fixture(t); state.beforeResult = () => state.products.forEach(product => { product.price = 0; });
  await processBundleGeneration(state.run._id, state.options);
  assert.equal(state.run.status, "failed"); assert.equal(state.run.publicCode, "bundle_price_changed");
  assert.equal(state.run.accounting, "settled"); assert.equal(state.drafts.length, 0);
});

test("duplicate existing bundle contents are skipped while a new weekly run still settles once", async t => {
  const state = fixture(t); state.drafts.push({ components: state.products.map(row => ({ productId: row._id, productType: "SIMPLE", variantId: null, quantity: 1 })) });
  await processBundleGeneration(state.run._id, state.options);
  assert.equal(state.run.status, "completed"); assert.deepEqual(state.run.bundleDraftIds, []); assert.equal(state.drafts.length, 1);
});

test("overdue dispatch is marked uncertain; unrelated customer runs and newer locks remain untouched", async t => {
  const state = fixture(t); state.resultOverrides = { usage: null };
  await processBundleGeneration(state.run._id, state.options);
  state.run.status = "dispatching"; state.run.dispatchDeadline = new Date(0);
  const foreign = { ...state.run, _id: new mongoose.Types.ObjectId(), purpose: "customer" }; state.rows.push(foreign);
  await recoverBundleGenerations(config);
  assert.equal(state.run.status, "uncertain"); assert.equal(foreign.status, "dispatching"); assert.equal(state.calls, 1);
  assert.equal(await finishBundleGeneration({ run: foreign }, null, null), null);
});
