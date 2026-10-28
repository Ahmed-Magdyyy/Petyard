import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { getOutcomeReport } from "../../../src/domains/assistant/reporting/assistant.outcomes.js";
import { createAssistantRouter } from "../../../src/domains/assistant/assistant.routes.js";
import { AssistantCartReceipt } from "../../../src/domains/assistant/shared/assistant.cart-receipt.model.js";
import { AssistantCartProposal } from "../../../src/domains/assistant/shared/assistant.cart-proposal.model.js";
import { AssistantBookingReceipt } from "../../../src/domains/assistant/shared/assistant.booking-receipt.model.js";
import { AssistantAccount } from "../../../src/domains/assistant/shared/assistant.models.js";
import { OrderModel } from "../../../src/domains/order/order.model.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { testConfig } from "./fixtures/foundationPolicy.js";

const U = "111111111111111111111111", now = new Date("2026-10-24T12:00:00Z");
function fixture(t) {
  const s = { config: testConfig(), actor: { _id: U, role: "superAdmin", active: true, phoneVerified: true, enabledControls: [] },
    reads: [], cart: [{ count: 20 }], bookings: 5,
    bundles: [{ orders: [{ _id: "delivered", count: 2 }, { _id: "cancelled", count: 1 }], units: [{ _id: "delivered", count: 8, invalid: 0 }, { _id: "cancelled", count: 3, invalid: 0 }] }] };
  const query = read => ({ select() { return this; }, maxTimeMS(ms) { assert.equal(ms, 5000); return this; }, lean() { return this; },
    then(resolve, reject) { return Promise.resolve().then(read).then(resolve, reject); } });
  t.mock.method(UserModel, "findById", () => query(() => ({ ...s.actor })));
  t.mock.method(AssistantAccount, "findOne", () => query(() => ({ blocked: true })));
  const originalDb = OrderModel.db.db;
  OrderModel.db.db = { listCollections(filter, options) { s.reads.push({ storeFilter: filter, storeOptions: options });
    if (s.rejectNameOperator && filter.name && typeof filter.name === "object") throw Object.assign(Error("can't get regex from filter doc not a regex"), { code: 8000 });
    return { async toArray() {
    const names = [AssistantCartReceipt, AssistantCartProposal, AssistantBookingReceipt, OrderModel].map(model => model.collection.name);
    return s.missingStore ? [] : names.map(name => ({ name, type: "collection" }));
  } }; } };
  t.after(() => { OrderModel.db.db = originalDb; });
  t.mock.method(AssistantCartReceipt, "aggregate", pipeline => ({ async option(options) { s.reads.push({ type: "cart", pipeline, options }); return s.cart; } }));
  t.mock.method(AssistantBookingReceipt, "countDocuments", filter => query(() => { s.reads.push({ type: "booking", filter }); return s.bookings; }));
  t.mock.method(OrderModel, "aggregate", pipeline => ({ async option(options) { s.reads.push({ type: "bundle", pipeline, options }); s.onRead?.(); return s.bundles; } }));
  for (const Model of [AssistantCartReceipt, AssistantCartProposal, AssistantBookingReceipt, OrderModel]) {
    for (const method of ["create", "createCollection", "createIndexes", "updateOne", "deleteMany"]) t.mock.method(Model, method, () => assert.fail("Outcome reports must not write"));
  }
  s.report = (query = { month: "2026-10" }) => getOutcomeReport(U, query, s.config, now);
  return s;
}

test("separate durable actions and whole-bundle quantities never become an attributed conversion claim", async t => {
  const s = fixture(t), report = await s.report();
  assert.equal(report.confirmedCartActions, 20); assert.equal(report.confirmedBookingActions, 5);
  assert.equal(report.bundleSales.ordersByCurrentStatus.delivered, 2); assert.equal(report.bundleSales.unitsByCurrentStatus.delivered, 8);
  assert.equal(report.bundleSales.unitsByCurrentStatus.cancelled, 3); assert.equal(report.bundleSales.unitsByCurrentStatus.returned, 0);
  assert.equal(report.coverage.attributedPurchases, "unavailable"); assert.equal(report.coverage.clicks, "unavailable");
  assert.equal(report.coverage.completeness, "not_guaranteed"); assert.doesNotMatch(JSON.stringify(report), /111111111111111111111111|inputJson|resultJson/);
  assert.equal(report.period.observedThrough, now.toISOString());
  const cartRead = s.reads.find(row => row.type === "cart"), lookup = cartRead.pipeline.find(stage => stage.$lookup).$lookup;
  assert.equal(lookup.from, AssistantCartProposal.collection.name);
  assert.deepEqual(lookup.let, { id: "$_id", owner: "$owner" });
  assert.ok(new RegExp(lookup.pipeline[0].$match.inputJson.$regex).test('{"sourceMessageId":"123456789012345678901234"}'));
  assert.equal(cartRead.options.maxTimeMS, 5000);
});

test("Cairo calendar boundaries are reused and future/unknown periods reject without report queries", async t => {
  const s = fixture(t); const report = await s.report({ month: "2026-09" });
  assert.equal(report.period.start, "2026-08-31T21:00:00.000Z"); assert.equal(report.period.endExclusive, "2026-09-30T21:00:00.000Z");
  s.reads = [];
  for (const query of [{ month: "2026-13" }, { month: "2027-01" }, { month: "2026-10", owner: U }]) await assert.rejects(s.report(query));
  assert.deepEqual(s.reads, []);
});

test("SuperAdmin access is required before queries and rechecked before returning aggregates", async t => {
  const s = fixture(t); s.actor.role = "admin"; s.actor.enabledControls = ["analytics"];
  await assert.rejects(s.report(), { code: "access_denied" }); assert.deepEqual(s.reads, []);
  s.actor.role = "superAdmin"; s.onRead = () => { s.actor.role = "user"; };
  await assert.rejects(s.report(), { code: "access_denied" });
});

test("missing stores never appear as trustworthy zero totals; corrupt counts/statuses fail closed", async t => {
  const s = fixture(t); s.missingStore = true;
  await assert.rejects(s.report(), { code: "outcome_report_unavailable" });
  s.missingStore = false;
  for (const bad of [{ orders: [{ _id: "unknown", count: 2 }], units: [] }, { orders: [], units: [{ _id: "delivered", count: 2, invalid: 1 }] },
    { orders: [], units: [{ _id: "delivered", count: Number.MAX_SAFE_INTEGER + 1, invalid: 0 }] }]) {
    s.bundles = [bad]; await assert.rejects(s.report(), { code: "outcome_report_unavailable" });
  }
});

test("zero retained activity remains zero with explicit coverage limits", async t => {
  const s = fixture(t); s.cart = []; s.bookings = 0; s.bundles = [];
  const report = await s.report(); assert.equal(report.confirmedCartActions, 0); assert.equal(report.confirmedBookingActions, 0);
  assert.equal(report.bundleSales.unitsByCurrentStatus.delivered, 0); assert.equal(report.coverage.attributedPurchases, "unavailable");
});

test("store readiness uses supported unfiltered metadata while retaining required-store checks", async t => {
  const s = fixture(t); s.rejectNameOperator = true;
  assert.equal((await s.report()).confirmedCartActions, 20);
  const metadata = s.reads.find(row => row.storeFilter);
  assert.deepEqual(metadata.storeFilter, {}); assert.deepEqual(metadata.storeOptions, { nameOnly: true, maxTimeMS: 5000 });
  s.missingStore = true; await assert.rejects(s.report(), { code: "outcome_report_unavailable" });
});

test("the mounted outcome endpoint reuses real authentication, monthly validators and no-store errors", async t => {
  const s = fixture(t), previous = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = "outcomes-local-fixture";
  t.after(() => { if (previous === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = previous; });
  const app = express(); app.use(express.json()); app.use("/api/v1/assistant", createAssistantRouter({ getConfig: () => s.config }));
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const headers = { Authorization: `Bearer ${jwt.sign({ userId: U }, process.env.JWT_ACCESS_SECRET)}` };
  const url = `http://127.0.0.1:${server.address().port}/api/v1/assistant/admin/outcomes`;
  assert.equal((await fetch(url)).status, 401);
  s.actor.role = "user"; assert.equal((await fetch(url, { headers })).status, 403); s.actor.role = "superAdmin";
  assert.equal((await fetch(url + "?month=bad", { headers })).status, 400);
  assert.equal((await fetch(url + "?month=2026-09&ownerId=" + U, { headers })).status, 400);
  const response = await fetch(url + "?month=2026-09", { headers }), body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.data.confirmedCartActions, 20); assert.equal(body.data.bundleSales.unitsByCurrentStatus.delivered, 8);
});
