import test from "node:test";
import assert from "node:assert/strict";
import { ADMIN_REPORT_LIMIT, adminPlanSchema, validateAdminPlan } from "../../../src/domains/assistant/admin/assistant.admin-plan.js";
import { validateSchema } from "../../../src/domains/assistant/providers/providerContract.js";

const now = new Date("2026-10-19T12:00:00Z");
const warehouse = "ab1111111111111111111111";
const options = { maxChars: 4096, allowedWarehouseIds: [warehouse] };
const report = (tool = "highest_selling_products", extras = {}) => ({ tool, arguments: {
  month: "2026-09", compareTo: null, metric: "units", warehouse: null, limit: null, ...extras } });
const plan = (reports = [report()]) => ({ outcome: "reports", language: "ar", clarification: "none", reports });
const invalid = (value, overrides = options) => assert.throws(() => validateAdminPlan(value, overrides, now),
  (error) => error.code === "invalid_admin_plan" && error.status === 503);

test("admin plans normalize three typed reports to the existing internal tool interface without any execution", () => {
  const value = plan([report("compare_order_months", { compareTo: "2026-08", metric: null }),
    report("lowest_selling_products", { metric: "item_value", limit: 10, warehouse: warehouse.toUpperCase() }), report()]);
  assert.deepEqual(validateAdminPlan(value, options, now), { outcome: "reports", language: "ar", clarification: "none", reports: [
    { tool: "compare_order_months", arguments: { month: "2026-09", compareTo: "2026-08" } },
    { tool: "lowest_selling_products", arguments: { month: "2026-09", metric: "item_value", limit: 10, warehouse } },
    { tool: "highest_selling_products", arguments: { month: "2026-09", metric: "units", limit: 5 } },
  ] });
  assert.equal(ADMIN_REPORT_LIMIT, 3);
  assert.equal(value.reports[2].arguments.limit, null, "Normalization does not mutate model output");
});

test("clarification, unsupported and identity plans cannot contain executable report requests or free-form text", () => {
  for (const language of ["ar", "en", "arabizi"]) {
    const value = { outcome: "clarify", language, clarification: "metric", reports: [] };
    assert.deepEqual(validateAdminPlan(value, options, now), value);
  }
  for (const outcome of ["unsupported", "identity"]) {
    const value = { outcome, language: "ar", clarification: "none", reports: [] };
    assert.deepEqual(validateAdminPlan(value, options, now), value);
    invalid({ ...value, reports: [report()] }); invalid({ ...value, clarification: "request" });
  }
  invalid({ outcome: "clarify", language: "ar", clarification: "none", reports: [] });
  invalid({ outcome: "clarify", language: "ar", clarification: "period", reports: [report()] });
  invalid({ ...plan(), explanation: "unverified numbers or private identity" });
});

test("strict root, report and argument shapes reject extras, unknown tools and execution payloads", () => {
  for (const value of [null, [], {}, { ...plan(), language: "unknown" }, { ...plan(), clarification: "metric" },
    plan([]), plan([report("create_bundle")]), plan([{ ...report(), command: "not executable" }]),
    plan([{ tool: report().tool, arguments: { month: "2026-09", metric: "units" } }]),
    plan([report("highest_selling_products", { query: { $where: "code" } })])]) invalid(value);
  const missing = plan(); delete missing.outcome; invalid(missing);
});

test("calendar validation, report cross-fields, limits and authoritative warehouse allowlist prevent guessed arguments", () => {
  for (const extras of [{ month: "2026-9" }, { month: "2026-11" }, { month: ["2026-09"] }, { month: "2026-02-30" },
    { compareTo: "2026-08" }, { metric: "profit" }, { limit: "5" }, { limit: 0 }, { limit: 51 }, { limit: 1.5 },
    { warehouse: "cd1111111111111111111111" }, { warehouse: { $ne: null } }, { warehouse: "" }]) invalid(plan([report(undefined, extras)]));
  invalid(plan([report("compare_order_months", { compareTo: "2026-08" })]));
  invalid(plan([report("compare_order_months", { compareTo: "2026-11", metric: null })]));
  invalid(plan([report("compare_order_months", { compareTo: "2026-08", metric: null, limit: 5 })]));
  invalid(plan([report(undefined, { warehouse })]), { maxChars: 4096 });
});

test("duplicate normalized requests and oversized plans are rejected while different periods remain distinct", () => {
  invalid(plan([report(), report(undefined, { limit: 5 })]));
  invalid(plan([report(undefined, { warehouse }), report(undefined, { warehouse: warehouse.toUpperCase() })]));
  invalid(plan(Array.from({ length: 4 }, (_, index) => report(undefined, { month: `2026-0${index + 1}` }))));
  invalid(plan(), { ...options, maxChars: 10 });
  assert.equal(validateAdminPlan(plan([report(), report(undefined, { month: "2026-08" })]), options, now).reports.length, 2);
});

test("configuration must provide explicit size bounds and valid server-owned warehouse identifiers", () => {
  for (const value of [{}, { maxChars: 0 }, { maxChars: 16001 }, { maxChars: 4096, allowedWarehouseIds: ["not-an-id"] }]) {
    assert.throws(() => validateAdminPlan(plan(), value, now), (error) => error.code === "admin_plan_configuration_required");
  }
});

test("nested planner schema is supported without broadening native tool parameters", () => {
  assert.equal(adminPlanSchema.properties.reports.type, "array");
  assert.equal(adminPlanSchema.properties.reports.maxItems, 3);
  assert.doesNotThrow(() => validateSchema(adminPlanSchema));
  assert.throws(() => validateSchema(adminPlanSchema, { flatOnly: true }), (error) => error.code === "unsupported_schema");
});
