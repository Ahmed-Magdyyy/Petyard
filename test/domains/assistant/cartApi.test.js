import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { createAssistantRouter } from "../../../src/domains/assistant/assistant.routes.js";
import { loadAssistantConfig, cartActionsEnabled } from "../../../src/domains/assistant/shared/assistant.config.js";
import { metadataDto } from "../../../src/domains/assistant/shared/assistant.dto.js";
import { AssistantError } from "../../../src/domains/assistant/shared/assistant.errors.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { testPolicy, testConfig } from "./fixtures/foundationPolicy.js";

const U = "111111111111111111111111", ID = "222222222222222222222222", P = "333333333333333333333333", W = "444444444444444444444444";
const cartPolicy = () => ({ version: "synthetic-only", proposalSeconds: 60, rateMax: 20, rateWindowSeconds: 60 });
const environment = (policy) => ({ ASSISTANT_ENABLED: "true", ASSISTANT_CART_ENABLED: "true", OPENAI_API_KEY: "synthetic-only",
  ASSISTANT_POLICY_JSON: JSON.stringify(testPolicy({ productSearchEnabled: true, cartPolicy: cartPolicy(), ...policy })) });

test("cart activation is separately disabled by default and requires a complete explicit policy", () => {
  assert.equal(cartActionsEnabled(testConfig()), false);
  const config = loadAssistantConfig(environment());
  assert.equal(cartActionsEnabled(config), true); assert.equal(Object.isFrozen(config.cartPolicy), true);
  const defaultOff = environment(); delete defaultOff.ASSISTANT_CART_ENABLED;
  assert.equal(cartActionsEnabled(loadAssistantConfig(defaultOff)), false);
  for (const changes of [{ cartPolicy: undefined }, { productSearchEnabled: false },
    { cartPolicy: { ...cartPolicy(), proposalSeconds: 0 } }, { cartPolicy: { ...cartPolicy(), rateMax: "20" } },
    { cartPolicy: { ...cartPolicy(), extra: true } }, { cartPolicy: { ...cartPolicy(), rateWindowSeconds: 86401 } }]) {
    assert.throws(() => loadAssistantConfig(environment(changes)), { code: "assistant_configuration_required" });
  }
});

test("metadata adds only the specific cart capability and does not imply order/payment or general commerce", () => {
  const config = loadAssistantConfig(environment());
  const period = { day: "today", dayReset: new Date() };
  const metadata = metadataDto(config, null, period);
  assert.equal(metadata.capabilities.cartAdditions, true);
  assert.equal(metadata.capabilities.checkoutSummary, true);
  assert.equal(metadata.capabilities.commerceActions, false);
  assert.equal(metadataDto(config, { blocked: true }, period).capabilities.cartAdditions, false);
  assert.equal(metadataDto({ enabled: false }, null, null).capabilities.cartAdditions, false);
  assert.equal(metadataDto({ enabled: false }, null, null).capabilities.checkoutSummary, false);
});

test("local runnable request collection has the three documented authenticated operations without credentials", () => {
  const collection = JSON.parse(readFileSync(new URL("./fixtures/contracts/AssistantCart.postman_collection.json", import.meta.url), "utf8"));
  assert.equal(collection.auth.type, "bearer");
  assert.equal(collection.variable.find(({ key }) => key === "accessToken").value, "");
  assert.deepEqual(collection.item.map(({ request }) => request.method), ["POST", "GET", "POST"]);
  assert.ok(collection.item[0].request.header.some(({ key }) => key === "Idempotency-Key"));
  assert.equal(JSON.parse(collection.item[2].request.body.raw).expectedVersion, 1);
  for (const item of collection.item) {
    assert.match(item.request.url, /^\{\{baseUrl\}\}\/api\/v1\/assistant\/cart-proposals/);
    for (const example of item.response) assert.ok(JSON.parse(example.body).data);
  }
});

async function fixture(t) {
  const previous = process.env.JWT_ACCESS_SECRET; process.env.JWT_ACCESS_SECRET = "synthetic-cart-http-only";
  t.after(() => { if (previous === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = previous; });
  const state = { config: loadAssistantConfig(environment()), calls: [], user: { _id: U, active: true, phoneVerified: true, role: "user" },
    prepared: { proposal: { id: ID, version: 1, fingerprint: "a".repeat(64), status: "pending" }, receipt: null, duplicate: false } };
  t.mock.method(UserModel, "findById", async () => state.user);
  const cartApplication = {
    async prepareCartProposal(...args) { state.calls.push(["prepare", ...args]); if (state.error) throw state.error; return state.prepared; },
    async getCartProposal(...args) { state.calls.push(["get", ...args]); if (state.error) throw state.error; return { proposal: state.prepared.proposal, receipt: null }; },
    async confirmCartProposal(...args) { state.calls.push(["confirm", ...args]); if (state.error) throw state.error; return { confirmed: true, duplicate: false, receipt: { proposalId: ID } }; },
  };
  const app = express(); app.use(express.json());
  app.use("/api/v1/assistant", createAssistantRouter({ getConfig: () => state.config, cartApplication }));
  const server = await new Promise((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  state.url = `http://127.0.0.1:${server.address().port}/api/v1/assistant/cart-proposals`;
  state.headers = { Authorization: `Bearer ${jwt.sign({ userId: U }, process.env.JWT_ACCESS_SECRET)}`, "Content-Type": "application/json", "Idempotency-Key": "cart-prepare-1" };
  state.body = { sourceMessageId: ID, warehouseId: W, productId: P, quantity: 2, language: "en" };
  state.post = (suffix, body, headers = state.headers) => fetch(state.url + suffix, { method: "POST", headers, body: JSON.stringify(body) });
  return state;
}

test("cart routes reject guests, bad tokens, inactive and unverified users using actual auth", async (t) => {
  const s = await fixture(t);
  for (const suffix of ["", `/${ID}/confirmations`]) {
    const response = await s.post(suffix, {}, { "Content-Type": "application/json", "x-guest-id": "guest-only" });
    assert.equal(response.status, 401); assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal((await fetch(s.url + `/${ID}`, { headers: { "x-guest-id": "guest-only" } })).status, 401);
  assert.equal((await s.post("", s.body, { ...s.headers, Authorization: "Bearer invalid" })).status, 401);
  s.user.phoneVerified = false; assert.equal((await s.post("", s.body)).status, 403);
  s.user.phoneVerified = true; s.user.active = false; assert.equal((await s.post("", s.body)).status, 401);
  assert.equal(s.calls.length, 0);
});

test("cart routes derive owner from auth and preserve explicit preparation/confirmation results", async (t) => {
  const s = await fixture(t);
  const created = await s.post("", s.body);
  assert.equal(created.status, 201); assert.equal(created.headers.get("cache-control"), "no-store");
  assert.deepEqual((await created.json()).data, s.prepared);
  assert.equal(s.calls[0][0], "prepare"); assert.equal(String(s.calls[0][1]), U);
  assert.deepEqual(s.calls[0][2], s.body); assert.equal(s.calls[0][3], "cart-prepare-1");
  s.prepared.duplicate = true; assert.equal((await s.post("", s.body)).status, 200);
  const status = await fetch(s.url + `/${ID}`, { headers: s.headers });
  assert.equal(status.status, 200); assert.equal(s.calls.at(-1)[0], "get"); assert.equal(s.calls.at(-1)[2], ID);
  const body = { expectedVersion: 1, fingerprint: "a".repeat(64) };
  const confirmed = await s.post(`/${ID}/confirmations`, body);
  assert.equal(confirmed.status, 200); assert.equal((await confirmed.json()).data.confirmed, true);
  assert.deepEqual(s.calls.at(-1).slice(0, 4), ["confirm", U, ID, body]);
});

test("disabled cart routes call no application and never leak through a catalog-only capability", async (t) => {
  const s = await fixture(t); s.config = { ...s.config, cartEnabled: false };
  for (const response of [await s.post("", s.body), await s.post(`/${ID}/confirmations`, {}),
    await fetch(s.url + `/${ID}`, { headers: s.headers })]) {
    assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "cart_actions_unavailable");
  }
  assert.equal(s.calls.length, 0);
});

test("cart route rejects unexpected query fields and oversized bodies before application dispatch", async (t) => {
  const s = await fixture(t);
  assert.equal((await s.post("?owner=attacker", s.body)).status, 400);
  assert.equal((await fetch(s.url + `/${ID}?warehouseId=${W}`, { headers: s.headers })).status, 400);
  assert.equal((await s.post(`/${ID}/confirmations?retry=true`, {})).status, 400);
  const response = await s.post("", { text: "x".repeat(2048) });
  assert.equal(response.status, 413); assert.equal(s.calls.length, 0);
});

test("cart API sanitizes unknown failures and exposes rate/reset and known conflict codes", async (t) => {
  const s = await fixture(t); s.error = new Error("private mongo key stack");
  const confirmation = { expectedVersion: 1, fingerprint: "a".repeat(64) };
  const response = await s.post(`/${ID}/confirmations`, confirmation);
  assert.equal(response.status, 503); assert.doesNotMatch(JSON.stringify(await response.json()), /private mongo|stack/);
  s.error = new AssistantError("cart_request_rate_limit", 429, new Date(Date.now() + 60000));
  const limited = await s.post("", s.body); assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal((await limited.json()).error.code, "cart_request_rate_limit");
  s.error = new AssistantError("cart_proposal_expired", 409);
  const expired = await s.post(`/${ID}/confirmations`, confirmation); assert.equal(expired.status, 409);
  assert.equal((await expired.json()).error.code, "cart_proposal_expired");
});

test("dedicated cart validators reject malformed fields before application dispatch and preserve valid null variants", async (t) => {
  const s = await fixture(t);
  for (const changes of [{ sourceMessageId: "bad" }, { warehouseId: [W] }, { productId: null }, { variantId: 12 },
    { quantity: "2" }, { quantity: 1.5 }, { quantity: 0 }, { quantity: Number.MAX_SAFE_INTEGER + 1 },
    { language: "arabizi" }, { owner: U }, { nested: { secret: "private-value" } }]) {
    const response = await s.post("", { ...s.body, ...changes });
    assert.equal(response.status, 400); const value = await response.json(); assert.equal(value.error.code, "invalid_request");
    assert.doesNotMatch(JSON.stringify(value), /private-value|sourceMessageId|Validation error/);
  }
  for (const key of [undefined, "short", "key with spaces"]) {
    const headers = { ...s.headers }; if (key === undefined) delete headers["Idempotency-Key"]; else headers["Idempotency-Key"] = key;
    assert.equal((await s.post("", s.body, headers)).status, 400);
  }
  for (const body of [{}, { expectedVersion: "1", fingerprint: "a".repeat(64) },
    { expectedVersion: 1, fingerprint: "A".repeat(64) }, { expectedVersion: 1, fingerprint: "a".repeat(64), owner: U }]) {
    assert.equal((await s.post(`/${ID}/confirmations`, body)).status, 400);
  }
  assert.equal((await fetch(s.url + "/bad", { headers: s.headers })).status, 400);
  assert.equal((await s.post("/bad/confirmations", { expectedVersion: 1, fingerprint: "a".repeat(64) })).status, 400);
  assert.equal(s.calls.length, 0);
  assert.equal((await s.post("", { ...s.body, variantId: null })).status, 201);
  assert.equal(s.calls.length, 1); assert.equal(s.calls[0][2].variantId, null);
  assert.equal(typeof s.calls[0][2].quantity, "number");
});


test("the same cart-proposal routes accept bundle selections and current-warehouse confirmations", async t => {
  const s = await fixture(t); s.config = { ...s.config, bundleCartEnabled: true };
  const bundle = { sourceMessageId: ID, warehouseId: W, bundleId: P, expectedRevision: 2, quantity: 1, language: "ar" };
  assert.equal((await s.post("", bundle)).status, 201); assert.deepEqual(s.calls.at(-1)[2], bundle);
  const confirmation = { expectedVersion: 1, fingerprint: "a".repeat(64), warehouseId: W };
  assert.equal((await s.post(`/${ID}/confirmations`, confirmation)).status, 200); assert.deepEqual(s.calls.at(-1)[3], confirmation);
});

test("bundle preparation rejects mixed identities, client prices and invalid revisions before dispatch", async t => {
  const s = await fixture(t), bundle = { sourceMessageId: ID, warehouseId: W, bundleId: P, expectedRevision: 2, quantity: 1, language: "en" };
  for (const body of [{ ...bundle, productId: P }, { ...bundle, variantId: null }, { ...bundle, price: 1 }, { ...bundle, expectedRevision: 0 },
    { ...bundle, expectedRevision: "2" }, { ...bundle, quantity: 0 }, { ...bundle, quantity: "1" }, { ...bundle, bundleId: "bad" },
    { ...bundle, expectedRevision: undefined }, { ...s.body, expectedRevision: 2 }, { ...bundle, sourceMessageId: undefined }]) {
    assert.equal((await s.post("", body)).status, 400, JSON.stringify(body));
  }
  assert.equal(s.calls.length, 0);
});
