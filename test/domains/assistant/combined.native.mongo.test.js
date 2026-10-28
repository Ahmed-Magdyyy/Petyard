import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import mongoose from "mongoose";
import { validateSharedMongoTarget, sharedMongoConfirmation } from "./fixtures/sharedMongo.js";
import { combinedNativeOptIn, validateCombinedNativePlan, combinedNativeConnection, claimCombinedNativeDatabase,
  cleanupCombinedNativeDatabase, installCombinedNativeGuard } from "./fixtures/combinedNative.js";
import { combinedNativeModels, combinedNativeConfig } from "./fixtures/combinedNativeModels.js";

test("isolated current mixed-cart, business processing and native outcome reports", {
  skip: process.env.ASSISTANT_COMBINED_NATIVE_TEST !== combinedNativeOptIn && "Exact isolated test opt-in required",
  timeout: 600000,
}, async t => {
  const plan = validateCombinedNativePlan(JSON.parse(await readFile(process.env.ASSISTANT_COMBINED_NATIVE_PLAN, "utf8")));
  const uri = validateSharedMongoTarget(process.env.ASSISTANT_COMBINED_NATIVE_URI, sharedMongoConfirmation);
  mongoose.set("autoCreate", false); mongoose.set("autoIndex", false); mongoose.set("bufferCommands", false);
  assert.equal(process.env.OPENAI_API_KEY, undefined);
  const refuse = () => { throw Error("External HTTP/provider/storage/push is outside this test"); };
  t.mock.method(globalThis, "fetch", refuse);
  for (const module of [http, https]) for (const method of ["request", "get"]) t.mock.method(module, method, refuse);
  let claimed = false, guard, fakeCalls = 0;
  const runCase = async (name, callback) => {
    let failure;
    await t.test(name, async () => { try { await callback(); t.diagnostic(`combined_native_case=${name}:passed`); }
      catch (error) { failure = error; throw error; } });
    if (failure) throw failure;
  };
  try {
    await mongoose.connect(uri.href, { dbName: plan.database, retryWrites: false, autoCreate: false, autoIndex: false,
      bufferCommands: false, serverSelectionTimeoutMS: 20000, connectTimeoutMS: 20000 });
    const { db, client, check } = combinedNativeConnection(mongoose.connection, plan);
    const inventory = await client.db(plan.database).admin().listDatabases({ nameOnly: true, authorizedDatabases: false, maxTimeMS: 5000 });
    assert.ok(inventory.databases.length <= 100); let total = 0;
    for (const { name } of inventory.databases) if (!["admin", "config", "local"].includes(name)) {
      total += (await client.db(name).listCollections({}, { nameOnly: true, maxTimeMS: 5000 }).toArray()).length; check();
    }
    assert.ok(total + plan.collections.length <= 500, "No free collection capacity");
    await claimCombinedNativeDatabase(mongoose.connection, plan); claimed = true;
    guard = installCombinedNativeGuard(t, mongoose.connection, plan);
    for (const name of plan.collections.filter(name => name !== "assistanttestownership")) await db.createCollection(name, { maxTimeMS: 5000 });
    const M = await combinedNativeModels();
    for (const model of M.indexed) await model.createIndexes();
    await db.collection("carts").createIndex({ user: 1 }, { unique: true });
    const { initializeAssistantStore } = await import("../../../src/domains/assistant/shared/assistant.store.js");
    await initializeAssistantStore();
    const { knownUsage } = await import("./fixtures/foundationPolicy.js");
    const { prepareCartAdditionProposal, confirmCartAdditionProposal, getCartAdditionState } = await import("../../../src/domains/assistant/customer/assistant.cart-proposals.js");
    const { prepareBundleCartReview, confirmBundleCartReview } = await import("../../../src/domains/assistant/customer/assistant.bundle-cart-proposals.js");
    const { previewUserCheckoutService } = await import("../../../src/domains/checkout/checkout.preview.js");
    const { readAssistantCatalog } = await import("../../../src/domains/assistant/products/assistant.catalog-read.js");
    const { buildCatalogSnapshot, storedCatalogDto } = await import("../../../src/domains/assistant/products/assistant.product-cards.js");
    const { submitBusinessMessage, getBusinessRun, getBusinessHistory } = await import("../../../src/domains/assistant/admin/assistant.admin-service.js");
    const { processBusinessPlan } = await import("../../../src/domains/assistant/admin/assistant.admin-worker.js");
    const { processBusinessReports } = await import("../../../src/domains/assistant/admin/assistant.admin-reports.js");
    const { getOutcomeReport } = await import("../../../src/domains/assistant/reporting/assistant.outcomes.js");
    const { getUsageReport } = await import("../../../src/domains/assistant/reporting/assistant.reporting.js");
    const oid = () => new mongoose.Types.ObjectId(), id = String, hash = v => createHash("sha256").update(JSON.stringify(v)).digest("hex");
    const clientId = oid(), adminId = oid(), otherId = oid(), W = oid(), otherW = oid(), P = oid(), B = oid(), C = oid();
    const config = await combinedNativeConfig(C);
    assert.equal(config.bundleCartEnabled, true);
    process.env.ASSISTANT_BUNDLE_CART_ENABLED = "true";
    const actor = { _id: clientId, __v: 0, role: "user", active: true, phoneVerified: true, account_status: "confirmed", walletBalance: 30 };
    for (const row of [actor, { ...actor, _id: adminId, role: "superAdmin" }, { ...actor, _id: otherId }]) await db.collection("users").insertOne(row);
    for (const _id of [W, otherW]) await db.collection("warehouses").insertOne({ _id, active: true, name: "Fictional warehouse", code: id(_id), defaultShippingPrice: 50, primeShippingPrice: 20 });
    await db.collection("categories").insertOne({ _id: C, name_en: "Fixture non-food", name_ar: "اختبار غير غذائي" });
    await db.collection("products").insertOne({ _id: P, type: "SIMPLE", isActive: true, category: C, name_en: "Fixture toy", name_ar: "لعبة اختبار", slug: "fixture-toy", price: 100,
      images: [], createdAt: new Date("2026-01-01"), warehouseStocks: [{ warehouse: W, quantity: 20 }, { warehouse: otherW, quantity: 0 }] });
    await db.collection("manualbundles").insertOne({ _id: B, origin: "manual", status: "published", revision: 1, name_en: "Fixture pair", name_ar: "طقم اختبار",
      pricePiastres: 15000, components: [{ productId: P, productType: "SIMPLE", variantId: null, quantity: 2 }] });
    await db.collection("loyaltysettings").insertOne({ _id: oid(), isActive: true, pointsEarnRate: 1 });
    for (const [date, total] of [["2026-09-15", 240], ["2026-08-15", 100]]) await db.collection("orders").insertOne({ _id: oid(), user: clientId, warehouse: W,
      createdAt: new Date(date), status: "delivered", total, items: [{ product: P, quantity: 1, itemPrice: total }] });
    await M.AssistantAccount.create({ owner: clientId });
    await M.AssistantAccount.create({ owner: otherId });
    const chat = await M.AssistantChat.create({ owner: clientId });
    const catalog = await readAssistantCatalog({ query: "Fixture", warehouseId: id(W), language: "en", subject: null, warnings: [],
      filters: { minimumPackageWeightGrams: null, maximumPriceMinor: null, options: [] } }, config);
    assert.equal(catalog.products.length, 2); assert.ok(catalog.products.every(row => row.inStock));
    const snapshot = buildCatalogSnapshot(catalog, { constrained: false }, { warehouseId: id(W) }, null, "en");
    assert.equal(storedCatalogDto(JSON.stringify(snapshot)).status, "results");
    const sourceId = oid(), sourceRun = oid(), cartId = oid(), expiresAt = new Date("2100-01-01");
    await db.collection("assistantruns").insertOne({ _id: sourceRun, owner: clientId, chat: chat._id, purpose: "customer", status: "completed", responseMessage: sourceId,
      key: "combined-source", createdAt: new Date(), expiresAt, config, attempts: [] });
    await M.AssistantMessage.create({ _id: sourceId, owner: clientId, chat: chat._id, run: sourceRun, role: "assistant", sequence: 1, text: "Fictional catalog",
      subjectId: null, catalogJson: JSON.stringify(snapshot), expiresAt });
    await db.collection("carts").insertOne(new M.CartModel({ _id: cartId, user: clientId, warehouse: W, currency: "EGP", __v: 7, checkoutKey: "combined-key",
      items: [], bundles: [{ id: id(oid()), bundleId: id(B), bundleRevision: 1, quantity: 1, unitPricePiastres: 15000 }], totalCartPrice: 150 }).toObject());
    const cart = () => db.collection("carts").findOne({ _id: cartId });
    const productRequest = { sourceMessageId: id(sourceId), warehouseId: id(W), productId: id(P), quantity: 2, language: "en" };
    const prepare = (key, quantity = 2) => prepareCartAdditionProposal(clientId, { ...productRequest, quantity }, key, config, { expiresAt: new Date(Date.now() + 300000) });
    const confirm = p => confirmCartAdditionProposal(clientId, p.id, { expectedVersion: p.version, fingerprint: p.fingerprint }, config);
    await runCase("mixed_product_confirmation", async () => {
      const before = await cart(), first = await prepare("combined-product");
      assert.deepEqual(await cart(), before);
      const settled = await Promise.allSettled([confirm(first.proposal), confirm(first.proposal)]);
      for (const result of settled) if (result.status === "rejected") throw result.reason;
      const results = settled.map(result => result.value);
      assert.equal(results.filter(row => row.duplicate === false).length, 1);
      const saved = await cart(); assert.equal(saved.items[0].quantity, 2); assert.equal(saved.totalCartPrice, 350);
      assert.deepEqual(saved.bundles, before.bundles); assert.equal(saved.checkoutKey, before.checkoutKey);
      const state = await getCartAdditionState(clientId, first.proposal.id, config); assert.equal(state.proposal.status, "confirmed");
      assert.equal((await confirm(first.proposal)).duplicate, true);
      await assert.rejects(getCartAdditionState(otherId, first.proposal.id, config), { code: "cart_proposal_not_found" });
    });
    await runCase("same_cart_bundle_confirmation", async () => {
      const before = await cart();
      const prepared = await prepareBundleCartReview(actor, { warehouseId: id(W), language: "en", sourceMessageId: id(sourceId),
        change: { action: "add", bundleId: id(B), expectedRevision: 1, quantity: 1 } }, "combined-bundle", config);
      assert.deepEqual(await cart(), before); const p = prepared.proposal;
      const body = { expectedVersion: p.version, fingerprint: p.fingerprint, warehouseId: id(W) };
      assert.equal((await confirmBundleCartReview(actor, p.id, body, config)).duplicate, false);
      assert.equal((await confirmBundleCartReview(actor, p.id, body, config)).duplicate, true);
      const saved = await cart(); assert.equal(id(saved._id), id(cartId)); assert.equal(saved.totalCartPrice, 500);
      assert.equal(saved.items[0].quantity, 2); assert.equal(saved.bundles.reduce((n, row) => n + row.quantity, 0), 2);
    });
    await runCase("receipt_failure_rollback", async () => {
      const prepared = await prepare("combined-rollback", 1), before = await cart();
      const accountsBefore = await M.AssistantAccount.findOne({ owner: clientId }).lean();
      const hook = t.mock.method(M.AssistantCartReceipt, "create", async () => { throw Error("Fictional receipt failure"); });
      try { await assert.rejects(confirm(prepared.proposal), /Fictional receipt failure/); } finally { hook.mock.restore(); }
      assert.deepEqual(await cart(), before); assert.deepEqual(await M.AssistantAccount.findOne({ owner: clientId }).lean(), accountsBefore);
      assert.equal(await M.AssistantCartReceipt.countDocuments({ _id: prepared.proposal.id }), 0);
    });
    await runCase("checkout_freshness", async () => {
      const preview = warehouse => previewUserCheckoutService({ userId: id(clientId), warehouseId: id(warehouse), lang: "en" });
      const before = await cart(), missing = await preview(W);
      assert.equal(missing.status, "needs_address"); assert.equal(missing.pricing.subtotal, 500); assert.equal(missing.pricing.finalTotal, null);
      assert.equal(missing.action.type, "open_checkout"); assert.deepEqual(await cart(), before);
      await db.collection("carts").updateOne({ _id: cartId }, { $set: { deliveryAddress: { name: "Fictional customer", governorate: "Alexandria", phone: "01012345678",
        building: "1", floor: "2", apartment: "3", details: "Fixture", warehouse: W, location: { lat: 31, lng: 30 } } } });
      const readyBefore = await cart(), summary = await preview(W);
      assert.equal(summary.status, "summary"); assert.equal(summary.pricing.subtotal, 500); assert.equal(summary.pricing.shippingFee, 50);
      assert.equal(summary.pricing.walletUsed, 30); assert.equal(summary.pricing.finalTotal, 520); assert.deepEqual(await cart(), readyBefore);
      await assert.rejects(preview(otherW));
      await db.collection("products").updateOne({ _id: P }, { $set: { "warehouseStocks.0.quantity": 5 } });
      await assert.rejects(preview(W)); assert.deepEqual(await cart(), readyBefore);
      await db.collection("products").updateOne({ _id: P }, { $set: { "warehouseStocks.0.quantity": 20 } });
    });
    for (const [language, text] of [["en", "Compare September 2026 and August 2026 sales"], ["ar", "2aren mabe3at september 2026 w august 2026"]]) {
      await runCase(language === "en" ? "business_english" : "business_arabizi", async () => {
        const key = `combined-business-${language}`, submitted = await submitBusinessMessage(adminId, { text }, key, config);
        assert.equal((await submitBusinessMessage(adminId, { text }, key, config)).duplicate, true);
        const adapter = { async generate(request) { assert.ok(fakeCalls < plan.maxFakeCalls); fakeCalls++;
          assert.equal(request.messages.at(-1).content, text); assert.deepEqual(request.tools, []);
          return { structured: { outcome: "reports", language, clarification: "none", reports: [{ tool: "compare_order_months",
            arguments: { month: "2026-09", compareTo: "2026-08", metric: null, warehouse: id(W), limit: null } }] },
            usage: knownUsage, serviceTier: "default", finishReason: "completed", toolCalls: [], providerRequestId: `fictional-${language}`, latencyMs: 5 };
        } };
        await processBusinessPlan(submitted.run.id, { getConfig: () => config, adapterFactory: () => adapter });
        assert.equal((await processBusinessReports(submitted.run.id, { getConfig: () => config })).status, "completed");
        const saved = await getBusinessRun(adminId, submitted.run.id, config);
        assert.equal(saved.run.status, "completed"); assert.equal(saved.reports.length, 1); assert.equal(saved.reports[0].status, "success");
        assert.equal(saved.reports[0].data.periods.current.metrics.totalSales, 240);
        assert.equal(saved.reports[0].data.periods.baseline.metrics.totalSales, 100);
        assert.equal(saved.reports[0].data.changes.totalSales.absolute, 140);
        assert.equal(saved.message.language, language); if (language === "ar") assert.match(saved.message.text, /[\u0600-\u06ff]/);
        const callsBefore = fakeCalls; await processBusinessPlan(submitted.run.id, { getConfig: () => config, adapterFactory: () => adapter });
        await processBusinessReports(submitted.run.id, { getConfig: () => config }); assert.equal(fakeCalls, callsBefore);
        await assert.rejects(getBusinessRun(clientId, submitted.run.id, config), { code: "access_denied" });
        assert.ok((await getBusinessHistory(adminId, {}, config)).messages.length >= 2);
      });
    }
    await runCase("native_outcomes_and_usage", async () => {
      const recordedAt = new Date();
      await M.AssistantBookingReceipt.create({ _id: oid(), owner: clientId, requestHash: "a".repeat(64), resultJson: "{}", resultHash: hash({}), recordedAt, notificationPending: false });
      for (const [status, quantity] of [["delivered", 2], ["cancelled", 1]]) await db.collection("orders").insertOne({ _id: oid(), user: clientId, warehouse: W,
        createdAt: new Date("2026-10-15"), status, bundleGroups: [{ quantity }], items: [] });
      const now = new Date(Date.now() + 1000), report = await getOutcomeReport(adminId, { month: "2026-10" }, config, now);
      assert.equal(report.confirmedCartActions, 2); assert.equal(report.confirmedBookingActions, 1);
      assert.equal(report.bundleSales.ordersByCurrentStatus.delivered, 1); assert.equal(report.bundleSales.unitsByCurrentStatus.delivered, 2);
      assert.equal(report.bundleSales.unitsByCurrentStatus.cancelled, 1); assert.equal(report.coverage.attributedPurchases, "unavailable");
      const usage = await getUsageReport({ month: "2026-10" }, config, now);
      assert.equal(usage.totals.providerAttempts, 2); assert.equal(usage.totals.tokenUsage.inputTokens.knownTokens, knownUsage.inputTokens * 2);
      assert.ok(usage.budget.accountedMicroUsd > 0); assert.equal(usage.budget.reservedMicroUsd, 0);
      assert.equal(await db.collection("notificationoutboxes").countDocuments({}), 0);
    });
    await runCase("report_exclusions_and_readonly", async () => {
      const before = await cart(), receiptId = oid();
      await db.collection("assistantcartreceipts").insertOne({ _id: receiptId, owner: otherId, recordedAt: new Date() });
      const args = [adminId, { month: "2026-10" }, config, new Date(Date.now() + 1000)];
      assert.equal((await getOutcomeReport(...args)).confirmedCartActions, 2);
      const bad = oid(); await db.collection("orders").insertOne({ _id: bad, user: clientId, createdAt: new Date("2026-10-16"), status: "delivered", bundleGroups: [{ quantity: 0 }] });
      await assert.rejects(getOutcomeReport(...args), { code: "outcome_report_unavailable" });
      assert.deepEqual(await cart(), before); assert.equal(fakeCalls, 2);
    });
  } finally {
    try { if (claimed) {
      const cleanup = await cleanupCombinedNativeDatabase(mongoose.connection, plan);
      t.diagnostic(`combined_native_cleanup=${JSON.stringify(cleanup)}`);
      t.diagnostic(`combined_native_insert_attempts=${guard?.insertAttempts() ?? 1}`);
      t.diagnostic(`combined_native_fake_calls=${fakeCalls}`);
    } } finally { await mongoose.disconnect(); }
  }
});
