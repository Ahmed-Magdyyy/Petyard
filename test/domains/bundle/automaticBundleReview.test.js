import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import { createBundleManagementService } from "../../../src/domains/bundle/bundle.service.js";
import { createBundleManagementRouter } from "../../../src/domains/bundle/bundle.routes.js";
import { buildBundleProductCard } from "../../../src/domains/bundle/bundle.product-card.js";
import { ManualBundle, supportedBundleOrigin } from "../../../src/domains/bundle/bundle.model.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { globalError } from "../../../src/shared/middlewares/errorMiddleware.js";
import { buildBundleEvidence } from "../../../src/domains/assistant/bundles/assistant.bundle-evidence.js";
import { validateBundlePlan } from "../../../src/domains/assistant/bundles/assistant.bundle-plan.js";

const A = "a00000000000000000000001", D = "b00000000000000000000001", R = "b00000000000000000000002";
const P = "c00000000000000000000001", Q = "c00000000000000000000002", W = "d00000000000000000000001";
const actor = { _id: A, role: "superAdmin", active: true, phoneVerified: true, account_status: "confirmed" };
function fixture() {
  const products = [P, Q].map((_id, i) => ({ _id, type: "SIMPLE", isActive: true, name_en: i ? "Scoop" : "Litter", name_ar: i ? "جاروف" : "رمل",
    price: i ? 20 : 100, createdAt: new Date("2025-01-01"), warehouseStocks: [{ warehouse: W, quantity: 10 }] }));
  const warehouse = { _id: W, name: "مخزن", active: true };
  const evidence = buildBundleEvidence({ products, warehouses: [warehouse], sales: [], now: new Date("2026-10-24") });
  const [draft] = validateBundlePlan({ drafts: [{ name_en: "Cat Litter & Scoop Kit", name_ar: "باقة رمل القطط والجاروف", fit_ar: "الرمل والجاروف بيكملوا بعض في تنظيف صندوق الرمل.",
    benefit_ar: "العميل يقدر يشتري احتياجاته مع بعض بسهولة.", reason: "useful_kit", slowOfferKey: null, components: evidence.offers.map(offer => ({ offerKey: offer.key, quantity: 1 })) }] }, evidence, 10000);
  const { evidence: proof, ...definition } = draft;
  const f = { row: { _id: D, ...definition, origin: "ai", status: "draft", revision: 1, createdBy: A, updatedBy: A,
    aiEvidenceJson: JSON.stringify({ ...proof, runId: R }), createdAt: new Date(), updatedAt: new Date() }, products, warehouse, writes: [], actor: { ...actor } };
  const db = { async requireManualBundleStore() {}, async findBundle() { return structuredClone(f.row); },
    async findBundleProducts() { return f.products; }, async findBundleWarehouses() { return [warehouse]; },
    async listManualBundles() { return [structuredClone(f.row)]; },
    async updateManualBundle(id, revision, status, values, origin) {
      f.writes.push({ id, revision, status, values, origin });
      if (id !== D || f.row.revision !== revision || f.row.status !== status || f.row.origin !== origin) return null;
      Object.assign(f.row, values, { revision: revision + 1 }); return structuredClone(f.row);
    }, async deleteManualDraft() { assert.fail("AI provenance cannot be deleted"); } };
  f.application = createBundleManagementService(db);
  f.replace = (price = 100, changes = {}) => ({ name_en: f.row.name_en, name_ar: f.row.name_ar, desc_en: "", desc_ar: "", price,
    components: f.row.components, expectedRevision: f.row.revision, ...changes });
  return f;
}

test("SuperAdmin edits names/price and approves the exact revision through the existing publish owner", async () => {
  const f = fixture(); const originalEvidence = f.row.aiEvidenceJson;
  assert.equal(new ManualBundle(f.row).validateSync(), undefined);
  const initial = await f.application.get(actor, D);
  assert.equal(initial.bundle.aiEvidenceMatchesContents, true); assert.equal(initial.bundle.price, 0);
  await assert.rejects(f.application.publish(actor, D, { expectedRevision: 1 }), { code: "BUNDLE_PUBLICATION_PRICE_REQUIRED" });
  await f.application.replace(actor, D, f.replace(100, { name_ar: "باقة تنظيف الرمل" }));
  assert.equal(f.row.aiEvidenceJson, originalEvidence); assert.equal(f.row.origin, "ai");
  await assert.rejects(f.application.publish(actor, D, { expectedRevision: 1 }), { code: "BUNDLE_REVISION_CONFLICT" });
  const published = await f.application.publish(actor, D, { expectedRevision: 2 });
  assert.equal(published.bundle.status, "published"); assert.equal(published.bundle.revision, 3); assert.equal(published.bundle.publishedBy, A);
  const card = buildBundleProductCard({ bundle: f.row, warehouse: f.warehouse, products: f.products, lang: "ar" });
  assert.equal(card.type, "BUNDLE"); assert.equal(card.name, "باقة تنظيف الرمل"); assert.equal(card.discountedPrice, 100);
  for (const field of ["aiEvidence", "aiEvidenceJson", "origin", "createdBy", "source", "modelExplanation"]) assert.equal(card[field], undefined);
  await f.application.pause(actor, D, { expectedRevision: 3 });
  assert.equal(buildBundleProductCard({ bundle: f.row, warehouse: f.warehouse, products: f.products }), null);
});

test("reject retains provenance and cannot publish, delete or accept a stale revision", async () => {
  const f = fixture(); const evidence = f.row.aiEvidenceJson;
  const rejected = await f.application.reject(actor, D, { expectedRevision: 1 });
  assert.equal(rejected.bundle.status, "rejected"); assert.equal(f.row.aiEvidenceJson, evidence); assert.equal(f.row.updatedBy, A);
  await assert.rejects(f.application.publish(actor, D, { expectedRevision: 2 }), { code: "BUNDLE_STATE_CONFLICT" });
  await assert.rejects(f.application.remove(actor, D, { expectedRevision: 2 }), { code: "BUNDLE_REJECT_REQUIRED" });
  assert.equal(buildBundleProductCard({ bundle: f.row, warehouse: f.warehouse, products: f.products }), null);
});

test("editing AI contents preserves source evidence and explicitly marks it as describing the earlier contents", async () => {
  const f = fixture(); const evidence = f.row.aiEvidenceJson;
  const updated = await f.application.replace(actor, D, f.replace(100, { components: [{ productId: P, productType: "SIMPLE", quantity: 2 }] }));
  assert.equal(updated.bundle.aiEvidenceMatchesContents, false); assert.equal(f.row.aiEvidenceJson, evidence);
  for (const field of ["origin", "aiEvidenceJson", "aiEvidence", "status", "publishedBy"]) await assert.rejects(
    f.application.replace(actor, D, { ...f.replace(), [field]: field === "origin" ? "manual" : "injected" }));
});

test("all non-SuperAdmin roles cannot review AI drafts; missing/invalid provenance cannot become public", async () => {
  const f = fixture();
  for (const role of ["user", "guest", "moderator", "admin"]) {
    const denied = { ...actor, role };
    for (const action of [() => f.application.get(denied, D), () => f.application.list(denied, {}),
      () => f.application.reject(denied, D, { expectedRevision: 1 }), () => f.application.publish(denied, D, { expectedRevision: 1 })]) await assert.rejects(action);
  }
  assert.equal(f.writes.length, 0);
  assert.equal(supportedBundleOrigin({ origin: "ai", aiEvidenceJson: "{}" }), false);
  assert.equal(new ManualBundle({ ...f.row, aiEvidenceJson: "{}" }).validateSync()?.name, "ValidationError");
});

test("real JWT/Express review endpoint reuses exact revision validation, auth, no-store and safe publication restrictions", async t => {
  const f = fixture(); const secret = process.env.JWT_ACCESS_SECRET, mode = process.env.NODE_ENV;
  process.env.JWT_ACCESS_SECRET = "synthetic-ai-bundle-review-only"; process.env.NODE_ENV = "test";
  t.after(() => { if (secret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = secret;
    if (mode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = mode; });
  t.mock.method(UserModel, "findById", async () => f.actor);
  t.mock.method(console, "warn", () => {}); t.mock.method(console, "error", () => {});
  const app = express(); app.use("/bundles/admin", createBundleManagementRouter({ application: f.application })); app.use(globalError);
  const server = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const token = jwt.sign({ userId: A }, process.env.JWT_ACCESS_SECRET, { expiresIn: "1h" });
  const request = async (body, authorized = true) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/bundles/admin/${D}/reject`, { method: "POST",
      headers: { "content-type": "application/json", ...(authorized ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    assert.equal(response.headers.get("cache-control"), "no-store"); return { status: response.status, body: await response.json() };
  };
  assert.equal((await request({ expectedRevision: 1 }, false)).status, 401);
  f.actor.role = "moderator"; assert.equal((await request({ expectedRevision: 1 })).status, 403); f.actor.role = "superAdmin";
  assert.equal((await request({ expectedRevision: "1" })).status, 400);
  assert.equal((await request({ expectedRevision: 1, origin: "manual" })).status, 400);
  const result = await request({ expectedRevision: 1 }); assert.equal(result.status, 200); assert.equal(result.body.data.bundle.status, "rejected");
  assert.equal((await request({ expectedRevision: 1 })).status, 409);
});
