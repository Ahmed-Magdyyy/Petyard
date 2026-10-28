import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import mongoose from "mongoose";
import { DateTime } from "luxon";
import { validateSharedMongoTarget, sharedMongoConfirmation } from "./fixtures/sharedMongo.js";
import { automaticBundleNativeOptIn, validateAutomaticBundleNativePlan, claimAutomaticBundleNativeDatabase,
  installAutomaticBundleNativeGuard, inspectAutomaticBundleNativeDatabase, cleanupAutomaticBundleNativeDatabase } from "./fixtures/automaticBundleNative.js";

test("isolated automatic bundle persistence and concurrency", {
  skip: process.env.ASSISTANT_AUTOMATIC_BUNDLE_NATIVE_TEST !== automaticBundleNativeOptIn && "Prepared only; isolated setup/run/cleanup needs explicit approval",
  timeout: 600000,
}, async t => {
  const plan = validateAutomaticBundleNativePlan(JSON.parse(await fs.readFile(process.env.ASSISTANT_AUTOMATIC_BUNDLE_NATIVE_PLAN, "utf8")));
  const uri = validateSharedMongoTarget(process.env.ASSISTANT_AUTOMATIC_BUNDLE_NATIVE_URI, sharedMongoConfirmation);
  mongoose.set("autoCreate", false); mongoose.set("autoIndex", false); mongoose.set("bufferCommands", false);
  assert.equal(process.env.OPENAI_API_KEY, undefined); assert.equal(process.env.MONGO_URI, undefined); assert.equal(process.env.REDIS_URL, undefined);
  const refuse = () => { throw Error("HTTP/provider/push calls are outside this native test"); };
  t.mock.method(globalThis, "fetch", refuse);
  for (const module of [http, https]) for (const method of ["request", "get"]) t.mock.method(module, method, refuse);
  let claimed = false, guard, fakeCalls = 0;
  try {
    try {
      await mongoose.connect(uri.href, { dbName: plan.database, autoCreate: false, autoIndex: false, bufferCommands: false,
        retryWrites: false, serverSelectionTimeoutMS: 20000, connectTimeoutMS: 20000 });
    } catch (error) {
      t.diagnostic(`automatic_bundle_native_connection=${JSON.stringify({ name:error.name, code:error.code, topology:error.reason?.type,
        servers:Array.from(error.reason?.servers ?? [], ([address,server]) => ({ address,error:server.error?.name,
          code:server.error?.code,causeCode:server.error?.cause?.code })) })}`);
      throw error;
    }
    await claimAutomaticBundleNativeDatabase(mongoose.connection, plan); claimed = true;
    guard = installAutomaticBundleNativeGuard(t, mongoose.connection, plan); const db = mongoose.connection.db;
    const worker = await import("../../../src/domains/assistant/bundles/assistant.bundle-worker.js");
    const { readBundleEvidence } = await import("../../../src/domains/assistant/bundles/assistant.bundle-evidence.js");
    const { AssistantRun, AssistantAccount, AssistantBudget } = await import("../../../src/domains/assistant/shared/assistant.models.js");
    const { initializeAssistantStore } = await import("../../../src/domains/assistant/shared/assistant.store.js");
    const { reconcileRun } = await import("../../../src/domains/assistant/customer/assistant.service.js");
    const { ManualBundle } = await import("../../../src/domains/bundle/bundle.model.js");
    const { bundleManagementService } = await import("../../../src/domains/bundle/bundle.service.js");
    const { bundleCatalogService } = await import("../../../src/domains/bundle/bundle.customer-service.js");
    const { testConfig, knownUsage } = await import("./fixtures/foundationPolicy.js");
    const { costMicroUsd, reservationMicroUsd } = await import("../../../src/domains/assistant/shared/assistant.config.js");
    for (const name of ["users", "warehouses", "products", "orders", "manualbundles"]) await db.createCollection(name);
    await ManualBundle.createIndexes(); await initializeAssistantStore();
    const oid = () => new mongoose.Types.ObjectId(), owner = oid(), warehouses = Array.from({ length: 4 }, oid);
    const [X, Y, Z, N, V, OTHER] = Array.from({ length: 6 }, oid), week = worker.bundleWeek(), end = DateTime.fromJSDate(week.end, { zone: "Africa/Cairo" });
    const config = { ...testConfig({ runDays: 1, historyDays: 1, timeoutMs: 30000, queueTimeoutMs: 300000 }),
      bundleCartEnabled: true, bundleGenerationEnabled: true, bundleGenerationOwner: String(owner) };
    const actor = { _id: owner, role: "superAdmin", active: true, phoneVerified: true, account_status: "confirmed" };
    const insert = (name, row) => db.collection(name).insertOne(row);
    await insert("users", { ...actor, name: "Fictional native reviewer", deletedAt: null });
    for (let i = 0; i < warehouses.length; i++) await insert("warehouses", { _id: warehouses[i], active: true, name: `Fictional warehouse ${i + 1}`, code: `NATIVE${i + 1}` });
    const stocks = rows => rows.map(([index, quantity]) => ({ warehouse: warehouses[index - 1], quantity }));
    const product = (id, name, price, stock) => ({ _id: id, type: "SIMPLE", isActive: true, name_en: name, name_ar: "منتج اختبار",
      desc_en: "Fictional cat-care item for persistence testing only", desc_ar: "بيانات اختبار وهمية", tags: ["cat"], price,
      createdAt: end.minus({ days: 200 }).toJSDate(), warehouseStocks: stocks(stock) });
    await insert("products", product(X, "Fictional litter", 100, [[1, 8], [2, 10], [4, 4]]));
    await insert("products", product(Y, "Fictional scoop", 20, [[2, 6], [3, 5], [4, 3]]));
    await insert("products", { ...product(Z, "Fictional variant item", 30, []), type: "VARIANT", variants: [
      { _id: V, price: 30, options: [{ name: "Color", value: "Blue" }], warehouseStocks: stocks([[2, 3]]) },
      { _id: OTHER, price: 40, options: [{ name: "Color", value: "Red" }], warehouseStocks: stocks([[1, 100], [3, 100]]) },
    ] });
    await insert("products", { ...product(N, "Fictional new brush", 25, [[2, 8], [4, 8]]), createdAt: end.minus({ days: 7 }).toJSDate() });
    const line = (product, quantity, extra = {}) => ({ product, productType: "SIMPLE", quantity, ...extra });
    const order = (status, createdAt, items) => insert("orders", { _id: oid(), status, createdAt, items });
    await order("delivered", end.minus({ days: 80 }).toJSDate(), [line(X, 4), line(Y, 2)]);
    await order("delivered", end.minus({ days: 10 }).toJSDate(), [line(X, 6, { fulfillmentQuantity: 5 }), line(Y, 1), line(Z, 3, { productType: "VARIANT", variantId: V })]);
    await order("delivered", end.minus({ days: 91 }).toJSDate(), [line(X, 1000)]);
    await order("delivered", week.end, [line(X, 1000)]);
    await order("pending", end.minus({ days: 5 }).toJSDate(), [line(X, 1000)]);
    await order("returned", end.minus({ days: 5 }).toJSDate(), [line(X, 1000)]);
    await order("delivered", end.minus({ days: 30 }).toJSDate(), [line(X, 2)]);
    await order("delivered", end.minus({ days: 90 }).toJSDate(), [line(Y, 1)]);
    const originalStock = await db.collection("products").find({}).sort({ _id: 1 }).toArray();
    const passed = async name => { const snapshot = await inspectAutomaticBundleNativeDatabase(mongoose.connection, plan);
      t.diagnostic(`automatic_bundle_native_case=${name}:passed;documents=${snapshot.documents};insertAttempts=${guard.insertAttempts()}`); };
    let scheduledId, firstDraft;
    const adapter = (selected = [X, Y], extras = {}) => () => ({ async generate(request) {
      fakeCalls++;
      const evidence = JSON.parse(request.messages[0].content);
      return { serviceTier: "default", finishReason: "completed", toolCalls: [], usage: knownUsage, providerRequestId: "fictional-not-a-provider-request", latencyMs: 1,
        structured: { drafts: [{ name_en: "Fictional Care Kit", name_ar: "باقة اختبار وهمية", fit_ar: "المنتجات دي بتكمل بعض في نفس الاستخدام.",
          benefit_ar: "العميل يقدر يشتري احتياجاته مع بعض بسهولة.", reason: "useful_kit", slowOfferKey: null,
          components: selected.map(id => ({ offerKey: evidence.offers.find(row => row.productId === String(id) && row.variantId === null).key,
            quantity: String(id) === String(X) ? 2 : 1 })) }] }, ...extras };
    } });
    const options = factory => ({ getConfig: () => config, adapterFactory: factory ?? adapter() });
    const queuedFixture = async label => {
      const [run] = await AssistantRun.create([{ owner, chat: owner, purpose: "automatic_bundles", key: `native-${label}`, hash: label,
        input: "Fictional isolated failure-case job", userSequence: 0, contextVersion: 0, status: "queued", phase: "plan",
        config: worker.bundleGenerationConfig(config), bundleWindowEnd: week.end, deadline: new Date(Date.now() + 300000) }]);
      await AssistantAccount.updateOne({ owner }, { $set: { activeRun: run._id } }); return run._id;
    };
    await t.test("real aggregation uses exact SKU identity, the 90/30/60 boundaries and delivered fulfillment only", async () => {
      const evidence = await readBundleEvidence(week.end), x = evidence.offers.find(row => row.productId === String(X)), y = evidence.offers.find(row => row.productId === String(Y));
      assert.deepEqual([x.earlierUnits, x.recentUnits, y.earlierUnits, y.recentUnits], [4, 7, 3, 1]);
      assert.equal(evidence.offers.find(row => row.variantId === String(V)).recentUnits, 3);
      assert.equal(evidence.offers.find(row => row.variantId === String(OTHER)).recentUnits, 0);
      assert.equal(evidence.offers.find(row => row.variantId === String(V)).variantHistoryVerified, false);
      assert.equal(evidence.offers.find(row => row.productId === String(N)).historyEligible, false);
      await passed("actual_sales_evidence");
    });
    await t.test("competing schedulers create only one weekly job and owner lock", async () => {
      const results = await Promise.all([worker.enqueueWeeklyBundleGeneration(config), worker.enqueueWeeklyBundleGeneration(config)]);
      assert.equal(results.filter(row => row.queued).length, 1); assert.equal(results.filter(row => row.duplicate).length, 1);
      scheduledId = new mongoose.Types.ObjectId(results.find(row => row.queued).runId);
      assert.equal(await AssistantRun.countDocuments({ purpose: "automatic_bundles" }), 1);
      assert.equal(String((await AssistantAccount.findOne({ owner }).lean()).activeRun), String(scheduledId));
      await passed("one_weekly_job");
    });
    await t.test("competing workers dispatch one fake attempt and atomically settle/save one unpriced draft", async () => {
      const results = await Promise.all([worker.processBundleGeneration(scheduledId, options()), worker.processBundleGeneration(scheduledId, options())]);
      const run = await AssistantRun.findById(scheduledId).lean();
      t.diagnostic(`automatic_bundle_native_worker=${JSON.stringify({results,status:run.status,internalCode:run.internalCode,accounting:run.accounting,fakeCalls})}`);
      assert.equal(fakeCalls, 1);
      assert.equal(run.status, "completed"); assert.equal(run.accounting, "settled"); assert.equal(run.attempts.length, 1);
      assert.equal(run.bundleDraftIds.length, 1); firstDraft = await ManualBundle.findById(run.bundleDraftIds[0]).lean();
      assert.equal(firstDraft.origin, "ai"); assert.equal(firstDraft.status, "draft"); assert.equal(firstDraft.pricePiastres, 0);
      assert.equal((await AssistantAccount.findOne({ owner }).lean()).activeRun, null);
      for (const row of await AssistantBudget.find({ _id: { $ne: "control" } }).lean()) { assert.equal(row.reserved, 0); assert.equal(row.spent, costMicroUsd(knownUsage, config)); }
      await worker.processBundleGeneration(scheduledId, options()); assert.equal(fakeCalls, 1);
      await passed("one_attempt_and_settlement");
    });
    await t.test("existing review/publish and catalog retain exact four-warehouse stock without changing inventory", async () => {
      const id = String(firstDraft._id), initial = await bundleManagementService.get(actor, id);
      await assert.rejects(bundleManagementService.publish(actor, id, { expectedRevision: 1 }), { code: "BUNDLE_PUBLICATION_PRICE_REQUIRED" });
      await bundleManagementService.replace(actor, id, { name_en: initial.bundle.name_en, name_ar: initial.bundle.name_ar,
        price: 100, components: initial.bundle.components, expectedRevision: 1 });
      const results = await Promise.allSettled([bundleManagementService.publish(actor, id, { expectedRevision: 2 }), bundleManagementService.publish(actor, id, { expectedRevision: 2 })]);
      assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
      assert.equal(results.find(row => row.status === "rejected").reason.code, "BUNDLE_REVISION_CONFLICT");
      for (const index of [0, 2]) await assert.rejects(bundleCatalogService.get(actor, id, { warehouseId: String(warehouses[index]), language: "ar" }), { code: "BUNDLE_NOT_FOUND" });
      for (const [index, stock] of [[1, 5], [3, 2]]) {
        const { bundle } = await bundleCatalogService.get(actor, id, { warehouseId: String(warehouses[index]), language: "ar" });
        assert.equal(bundle.stock, stock); assert.equal(bundle.type, "BUNDLE"); assert.equal(bundle.aiEvidenceJson, undefined); assert.equal(bundle.origin, undefined);
      }
      assert.deepEqual(await db.collection("products").find({}).sort({ _id: 1 }).toArray(), originalStock);
      await passed("review_and_four_warehouses");
    });
    await t.test("rejection retains immutable AI evidence and denies stale publication", async () => {
      const [draft] = await ManualBundle.create([{ origin: "ai", status: "draft", name_en: "Fictional rejected draft", name_ar: "اقتراح اختبار مرفوض",
        pricePiastres: 0, components: firstDraft.components, aiEvidenceJson: firstDraft.aiEvidenceJson, createdBy: owner, updatedBy: owner }]);
      await bundleManagementService.reject(actor, String(draft._id), { expectedRevision: 1 });
      const saved = await ManualBundle.findById(draft._id).lean(); assert.equal(saved.status, "rejected"); assert.equal(saved.aiEvidenceJson, firstDraft.aiEvidenceJson);
      await assert.rejects(bundleManagementService.publish(actor, String(draft._id), { expectedRevision: 2 }), { code: "BUNDLE_STATE_CONFLICT" });
      await assert.rejects(bundleCatalogService.get(actor, String(draft._id), { warehouseId: String(warehouses[1]), language: "ar" }), { code: "BUNDLE_NOT_FOUND" });
      await passed("rejection_retains_evidence");
    });
    await t.test("post-insert failure rolls back staged draft/settlement and recovery never calls the provider again", async child => {
      const id = await queuedFixture("rollback"), before = await ManualBundle.countDocuments({}), create = ManualBundle.create.bind(ManualBundle);
      let inserted = false;
      child.mock.method(ManualBundle, "create", async (...args) => { const result = await create(...args); inserted = true; throw Error("synthetic failure after staged draft insert"); });
      await assert.rejects(worker.processBundleGeneration(id, options(adapter([X, N]))), /synthetic failure/); assert.equal(inserted, true);
      assert.equal(await ManualBundle.countDocuments({}), before);
      const run = await AssistantRun.findById(id).lean(); assert.equal(run.status, "dispatching"); assert.equal(run.accounting, "reserved");
      await AssistantRun.updateOne({ _id: id }, { $set: { dispatchDeadline: new Date(0) } });
      await worker.recoverBundleGenerations(config); assert.equal((await AssistantRun.findById(id).lean()).status, "uncertain");
      const calls = fakeCalls; await worker.processBundleGeneration(id, options()); assert.equal(fakeCalls, calls);
      await reconcileRun(owner, String(id), { resolution: "charge_reserved", reason: "Fictional native recovery" }, config);
      assert.equal((await AssistantAccount.findOne({ owner }).lean()).activeRun, null);
      await passed("atomic_rollback_and_no_retry");
    });
    await t.test("lost application reply after actual commit leaves one durable draft and charge", async child => {
      const id = await queuedFixture("lost-reply"), start = mongoose.startSession.bind(mongoose); let lost = false;
      child.mock.method(mongoose, "startSession", async (...args) => {
        const session = await start(...args), native = session.withTransaction.bind(session);
        session.withTransaction = async (...parameters) => {
          const result = await native(...parameters);
          if (result?.status === "completed" && String(result._id) === String(id) && !lost) { lost = true; throw Error("synthetic lost application reply after commit"); }
          return result;
        }; return session;
      });
      await assert.rejects(worker.processBundleGeneration(id, options(adapter([X, N]))), /lost application reply/); assert.equal(lost, true);
      const run = await AssistantRun.findById(id).lean(); assert.equal(run.status, "completed"); assert.equal(run.accounting, "settled"); assert.equal(run.bundleDraftIds.length, 1);
      assert.ok(await ManualBundle.findById(run.bundleDraftIds[0]).lean());
      const before = fakeCalls; await worker.processBundleGeneration(id, options()); assert.equal(fakeCalls, before);
      await passed("committed_reply_recovery");
    });
    await t.test("unknown usage stays reserved until existing reconciliation closes it once and keeps the weekly retry barrier", async () => {
      const id = await queuedFixture("unknown-usage");
      await worker.processBundleGeneration(id, options(adapter([Y, N], { usage: null })));
      const unknown = await AssistantRun.findById(id).lean(); assert.equal(unknown.status, "uncertain"); assert.equal(unknown.accounting, "reserved");
      assert.equal(unknown.reservation.amount, reservationMicroUsd(config));
      const before = fakeCalls; await worker.processBundleGeneration(id, options()); assert.equal(fakeCalls, before);
      const body = { resolution: "charge_reserved", reason: "Fictional unknown-usage reconciliation" };
      assert.equal((await reconcileRun(owner, String(id), body, config)).duplicate, false);
      assert.equal((await reconcileRun(owner, String(id), body, config)).duplicate, true);
      const saved = await AssistantRun.findById(id).lean(); assert.equal(saved.accounting, "charged_reservation"); assert.equal(saved.status, "failed");
      assert.ok(saved.expiresAt.getTime() >= saved.updatedAt.getTime() + 8 * 86400000 - 1000);
      assert.deepEqual(await worker.enqueueWeeklyBundleGeneration(config), { duplicate: true });
      for (const row of await AssistantBudget.find({ _id: { $ne: "control" } }).lean()) assert.equal(row.reserved, 0);
      await passed("unknown_usage_reconciliation");
    });
    assert.equal(fakeCalls, 4); assert.equal(await ManualBundle.countDocuments({}), 3);
    for (const name of ["assistantchats", "assistantmessages", "assistantmemories", "assistantdietarywarnings", "notificationoutboxes"]) assert.equal(await db.collection(name).countDocuments({}), 0);
  } finally {
    try {
      if (guard) {
        t.diagnostic(`automatic_bundle_native_insert_attempts=${guard.insertAttempts()}`);
        t.diagnostic(`automatic_bundle_native_fake_calls=${fakeCalls}`);
      }
      if (claimed) {
        const cleanup = await cleanupAutomaticBundleNativeDatabase(mongoose.connection, plan);
        t.diagnostic(`automatic_bundle_native_cleanup=${JSON.stringify(cleanup)}`);
      }
    } finally { await mongoose.disconnect(); }
  }
});
