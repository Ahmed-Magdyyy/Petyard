import test from "node:test";
import assert from "node:assert/strict";
import { validateSchema, validateObject } from "../../../src/domains/assistant/providers/providerContract.js";
import { outputSchema } from "../../../src/domains/assistant/customer/assistant.policy.js";
import { adminPlanSchema } from "../../../src/domains/assistant/admin/assistant.admin-plan.js";
import { structuredReply } from "./fixtures/foundationPolicy.js";

const objectSchema = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const validPlan = () => ({ outcome: "reports", language: "ar", clarification: "none", reports: [{
  tool: "highest_selling_products", arguments: { month: "2026-09", compareTo: null, metric: "units", warehouse: null, limit: 5 },
}] });
const invalid = (schema) => assert.throws(() => validateSchema(schema), { code: "unsupported_schema", chargeExposure: "none" });

test("the 21-field customer schema supports bounded typed intent; scalar-only native tools reject it explicitly", () => {
  assert.equal(outputSchema.required.length, 21);
  invalid(objectSchema(Object.fromEntries(Array.from({ length: 22 }, (_, index) => [`field${index}`, { type: "string" }]))));
  assert.doesNotThrow(() => validateSchema(outputSchema));
  assert.throws(() => validateSchema(outputSchema, { flatOnly: true }), { code: "unsupported_schema" });
  const value = structuredReply();
  assert.doesNotThrow(() => validateObject(outputSchema, value));
  for (const changed of [{ ...value, answer: 5 }, { ...value, added: "no" }]) {
    assert.throws(() => validateObject(outputSchema, changed, "invalid_structured_output"), { code: "invalid_structured_output" });
  }
  const missing = { ...value }; delete missing[outputSchema.required[0]];
  assert.throws(() => validateObject(outputSchema, missing), { code: "invalid_tool_arguments" });
});

test("typed output supports strict nested reports and explicit nulls without coercing values", () => {
  assert.doesNotThrow(() => validateSchema(adminPlanSchema));
  assert.doesNotThrow(() => validateObject(adminPlanSchema, validPlan()));
  const value = validPlan(); value.reports[0].arguments.limit = null;
  assert.doesNotThrow(() => validateObject(adminPlanSchema, value));
  for (const outcome of ["clarify", "unsupported", "identity"]) {
    assert.doesNotThrow(() => validateObject(adminPlanSchema, { ...validPlan(), outcome, reports: [] }));
  }
  const nullableEnum = objectSchema({ field: { type: ["null", "string"], enum: ["value", null] } });
  assert.doesNotThrow(() => validateSchema(nullableEnum));
  assert.doesNotThrow(() => validateObject(nullableEnum, { field: null }));
  nullableEnum.properties.field.enum = ["value"];
  assert.throws(() => validateObject(nullableEnum, { field: null }), { code: "invalid_tool_arguments" });
});

test("shopping extraction uses supported option keys and preserves verbatim values", () => {
  const value = structuredReply();
  for (const name of ["weight", "size", "color", "flavor", "pieces", "scent", "brand", "sku", "other"]) {
    value.productSearch.options = [{ name, value: "WW-F17", sourceQuote: "WW-F17" }];
    assert.doesNotThrow(() => validateObject(outputSchema, value));
  }
  for (const name of ["food type", "protein", "life stage", "species", "minimum package weight", "maximum price"]) {
    value.productSearch.options[0].name = name;
    assert.throws(() => validateObject(outputSchema, value), { code: "invalid_tool_arguments" });
  }
});

test("nested values reject missing fields, extra fields, malformed arrays, invalid enums and out-of-range integers", () => {
  const mutations = [
    (value) => { value.reports[0].extra = "no"; },
    (value) => { delete value.reports[0].arguments.warehouse; },
    (value) => { value.reports[0].arguments.query = { $where: "no" }; },
    (value) => { value.reports[0].tool = "place_order"; },
    (value) => { value.reports = null; },
    (value) => { value.reports = {}; },
    (value) => { value.reports = [null]; },
    (value) => { value.reports[0].arguments = null; },
    (value) => { value.reports[0].arguments.month = null; },
    (value) => { value.reports = Array(4).fill(value.reports[0]); },
    (value) => { value.reports = Array(1); },
  ];
  for (const limit of ["5", true, 0, 51, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    mutations.push((value) => { value.reports[0].arguments.limit = limit; });
  }
  for (const mutate of mutations) {
    const value = validPlan(); mutate(value);
    assert.throws(() => validateObject(adminPlanSchema, value, "invalid_structured_output"), { code: "invalid_structured_output" });
  }
});

test("unsupported schema features and malformed definitions fail closed at every level", () => {
  for (const field of [
    { type: "number" }, { type: "boolean" }, { type: "null" }, { type: ["string"] },
    { type: ["string", "integer", "null"] }, { type: ["string", "string"] },
    { type: ["object", "null"], properties: {}, required: [], additionalProperties: false },
    { type: "string", pattern: "x" }, { type: "string", enum: [] }, { type: "string", enum: [null] },
    { type: "string", enum: [5] }, { type: "integer" }, { type: "integer", minimum: 2, maximum: 1 },
    { type: "integer", minimum: 1.5, maximum: 5 }, { type: "integer", minimum: 0, maximum: Infinity },
    { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER + 1 },
    { type: "array", items: objectSchema({ name: { type: "string" } }) },
    { type: "array", maxItems: 51, items: objectSchema({ name: { type: "string" } }) },
    { type: "array", maxItems: -1, items: objectSchema({ name: { type: "string" } }) },
    { type: "array", maxItems: 1.5, items: objectSchema({ name: { type: "string" } }) },
    { type: "array", maxItems: 3, items: { type: "string" } },
    { ...objectSchema({ name: { type: "string" } }), required: [] },
    { ...objectSchema({ name: { type: "string" } }), additionalProperties: true },
    { ...objectSchema({ name: { type: "string" } }), $ref: "arbitrary" },
  ]) invalid(objectSchema({ field }));
  for (const schema of [null, [], { type: "string" }, objectSchema({}),
    { ...objectSchema({ name: { type: "string" } }), anyOf: [] },
    { ...objectSchema({ name: { type: "string" } }), required: ["other"] },
    { ...objectSchema({ name: { type: "string" } }), required: ["name", "name"] }]) invalid(schema);
  assert.throws(() => validateSchema(adminPlanSchema, { flatOnly: true }), { code: "unsupported_schema" });
  assert.throws(() => validateSchema(objectSchema({ count: { type: "integer", minimum: 1, maximum: 5 } }),
    { flatOnly: true }), { code: "unsupported_schema" });
});

test("schema work stays bounded by depth, node count and object width, including cyclic input", () => {
  let nested = { type: "string" };
  for (let index = 0; index < 5; index++) nested = objectSchema({ child: nested });
  assert.doesNotThrow(() => validateSchema(nested));
  invalid(objectSchema({ child: nested }));
  const cycle = objectSchema({ child: { type: "string" } }); cycle.properties.child = cycle;
  invalid(cycle);
  const leaves = (count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`field${index}`, { type: "string" }]));
  assert.doesNotThrow(() => validateSchema(objectSchema(leaves(21))));
  invalid(objectSchema(leaves(22)));
  const hundredNodes = objectSchema({ a: objectSchema(leaves(20)), b: objectSchema(leaves(20)),
    c: objectSchema(leaves(20)), d: objectSchema(leaves(20)), e: objectSchema(leaves(14)) });
  assert.doesNotThrow(() => validateSchema(hundredNodes));
  hundredNodes.properties.e = objectSchema(leaves(15)); invalid(hundredNodes);
});

test("integer endpoints and empty bounded lists work without adding unsupported coercion or keywords", () => {
  const schema = objectSchema({ count: { type: "integer", minimum: -1, maximum: 1 },
    rows: { type: "array", maxItems: 0, items: objectSchema({ name: { type: "string" } }) } });
  assert.doesNotThrow(() => validateSchema(schema));
  for (const count of [-1, 0, 1]) assert.doesNotThrow(() => validateObject(schema, { count, rows: [] }));
  assert.throws(() => validateObject(schema, { count: null, rows: [] }), { code: "invalid_tool_arguments" });
  assert.throws(() => validateObject(schema, { count: 0, rows: [{ name: "extra" }] }), { code: "invalid_tool_arguments" });
});
