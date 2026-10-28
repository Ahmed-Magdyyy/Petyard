import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import { createAssistantRouter } from "../../../src/domains/assistant/assistant.routes.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { testConfig } from "./fixtures/foundationPolicy.js";

const ID = "111111111111111111111111", OTHER = "222222222222222222222222";
const SUBJECT = `pet:${ID}`, CHAT = "chat:12345678-1234-1234-1234-123456789012";
async function fixture(t) {
  const previous = process.env.JWT_ACCESS_SECRET; process.env.JWT_ACCESS_SECRET = "synthetic-customer-validator-tests";
  t.after(() => { if (previous === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = previous; });
  const state = { config: testConfig({ maxMessageChars: 40, memoryValueChars: 20 }), calls: [] };
  t.mock.method(UserModel, "findById", async () => ({ _id: ID, active: true, phoneVerified: true, role: "user" }));
  const application = Object.fromEntries(["getHistory", "submitMessage", "getRun", "changeSubject", "saveMemory", "forgetMemory",
    "listDietaryWarnings", "editDietaryWarning", "removeDietaryWarning"].map((name) => [name, async (...args) => {
    state.calls.push({ name, args }); return name === "submitMessage" ? { duplicate: false, run: { id: OTHER } } : { accepted: true };
  }]));
  // Admit JSON primitives here so the router's own root-shape guard is exercised too.
  const app = express(); app.use(express.json({ strict: false }));
  app.use("/api/v1/assistant", createAssistantRouter({ getConfig: () => state.config, application }));
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); listener.once("error", reject);
  });
  t.after(() => { server.closeAllConnections(); return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
  const url = `http://127.0.0.1:${server.address().port}/api/v1/assistant`;
  state.headers = { Authorization: `Bearer ${jwt.sign({ userId: ID }, process.env.JWT_ACCESS_SECRET)}`,
    "Content-Type": "application/json", "Idempotency-Key": "customer-message-1" };
  state.request = async (method, route, body, headers = state.headers) => {
    const response = await fetch(url + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  state.invalid = async (method, route, body, headers) => {
    const calls = state.calls.length, response = await state.request(method, route, body, headers);
    assert.equal(response.status, 400, JSON.stringify({ method, route, body, response }));
    assert.equal(response.body.error.code, "invalid_request"); assert.equal(state.calls.length, calls);
    assert.equal(response.body.errors, undefined); assert.equal(response.body.error.value, undefined);
    return response;
  };
  return state;
}

test("customer message validators preserve raw valid payloads and authenticated owner, including null subject/warehouse", async (t) => {
  const s = await fixture(t);
  for (const body of [{ text: "  hello  " }, { text: "food?", subjectId: null }, { text: "pet", subjectId: SUBJECT },
    { text: "pet", subjectId: CHAT }, { text: "food", catalogContext: { warehouseId: null, language: "ar" } },
    { text: "food", catalogContext: { warehouseId: OTHER, language: "en" } },
    { text: "grooming", bookingContext: { location: null } },
    { text: "grooming", bookingContext: { location: { governorateCode: "alexandria", areaCode: "smouha" } } },
    { text: "grooming", bookingContext: { location: { lat: 31.2, lng: 29.9 } } }]) {
    const response = await s.request("POST", "/messages", body); assert.equal(response.status, 202);
    const call = s.calls.at(-1); assert.equal(call.name, "submitMessage"); assert.equal(call.args[0], ID);
    assert.deepEqual(call.args[1], body); assert.equal(call.args[2], "customer-message-1");
  }
});

test("customer message validators reject malformed text, subject, nested catalog and key without application dispatch", async (t) => {
  const s = await fixture(t);
  for (const body of [{}, { text: " " }, { text: "x".repeat(41) }, { text: "a\u0000b" }, { text: ["hello"] },
    { text: "x", subjectId: "user" }, { text: "x", subjectId: OTHER }, { text: "x", subjectId: [SUBJECT] },
    { text: "x", catalogContext: null }, { text: "x", catalogContext: [] }, { text: "x", catalogContext: {} },
    { text: "x", catalogContext: { warehouseId: OTHER } }, { text: "x", catalogContext: { warehouseId: "bad", language: "en" } },
    { text: "x", catalogContext: { warehouseId: OTHER, language: "en", owner: "private-value" } },
    { text: "x", catalogContext: { warehouseId: OTHER, language: ["en"] } }, { text: "x", owner: "private-value" },
    { text: "x", bookingContext: null }, { text: "x", bookingContext: {} }, { text: "x", bookingContext: [] },
    { text: "x", bookingContext: { location: { lat: "31", lng: 29 } } },
    { text: "x", bookingContext: { location: { lat: 31, lng: 29, governorateCode: "alexandria" } } },
    { text: "x", bookingContext: { location: { governorateCode: "alexandria", eligible: true } } },
    { text: "x", bookingContext: { location: null, owner: "private-value" } }]) {
    const response = await s.invalid("POST", "/messages", body); assert.doesNotMatch(JSON.stringify(response.body), /private-value/);
  }
  for (const key of [undefined, "short", "bad key"]) {
    const headers = { ...s.headers }; if (key === undefined) delete headers["Idempotency-Key"]; else headers["Idempotency-Key"] = key;
    await s.invalid("POST", "/messages", { text: "hello" }, headers);
  }
});

test("history validation retains scalar numeric query conventions and blocks duplicate, unsafe and unknown fields", async (t) => {
  const s = await fixture(t);
  for (const suffix of ["", "?limit=1&before=100", "?limit=1e1&before=100.0"]) {
    assert.equal((await s.request("GET", "/messages" + suffix)).status, 200);
  }
  assert.deepEqual(s.calls.at(-1).args[1], { limit: "1e1", before: "100.0" });
  for (const suffix of ["?limit=0", "?limit=101", "?limit=1.5", "?before=9007199254740992", "?limit=1&limit=2", "?owner=private-value"]) {
    await s.invalid("GET", "/messages" + suffix);
  }
});

test("subject validation supports null reset and optional temporary labels without request mutation", async (t) => {
  const s = await fixture(t);
  for (const subjectId of [null, SUBJECT, CHAT]) assert.equal((await s.request("PUT", "/subject", { subjectId })).status, 200);
  for (const body of [{}, { name: null, species: null }, { name: "  Milo  ", species: "cat" }]) {
    assert.equal((await s.request("POST", "/subjects", body)).status, 201); assert.deepEqual(s.calls.at(-1).args[1], body);
  }
  for (const body of [{}, { subjectId: "user" }, { subjectId: SUBJECT, owner: ID }]) await s.invalid("PUT", "/subject", body);
  for (const body of [[], null, { name: " " }, { species: 1 }, { name: "x".repeat(81) }, { species: "x\u0000y" }, { owner: ID }]) {
    await s.invalid("POST", "/subjects", body);
  }
});

test("memory validators accept user/pet subjects and configured text bounds, refusing foreign request identity fields", async (t) => {
  const s = await fixture(t);
  for (const subjectId of ["user", SUBJECT, CHAT]) {
    const body = { subjectId, key: "food_preference", value: " fish " };
    assert.equal((await s.request("PUT", "/memory", body)).status, 200); assert.deepEqual(s.calls.at(-1).args[1], body);
  }
  for (const changes of [{ subjectId: null }, { key: "unknown" }, { value: "x".repeat(21) }, { value: " " }, { owner: ID }]) {
    await s.invalid("PUT", "/memory", { subjectId: "user", key: "food_preference", value: "fish", ...changes });
  }
  assert.equal((await s.request("DELETE", `/memory/${ID}`)).status, 200);
  await s.invalid("DELETE", "/memory/not-an-id");
  assert.equal((await s.request("GET", `/runs/${ID}`)).status, 200);
  await s.invalid("GET", "/runs/not-an-id");
});

test("dietary warning validators retain integer version, cursor and text rules with safe errors", async (t) => {
  const s = await fixture(t);
  assert.equal((await s.request("GET", `/dietary-warnings?subjectId=${SUBJECT}&before=${OTHER}&limit=01`)).status, 200);
  assert.equal((await s.request("PUT", `/dietary-warnings/${ID}`, { expectedVersion: 1, text: "  Avoid chicken  " })).status, 200);
  assert.equal((await s.request("POST", `/dietary-warnings/${ID}/removals`, { expectedVersion: 1 })).status, 200);
  for (const suffix of ["?limit=1e1", "?limit=1&limit=2", "?limit=101", "?before=bad", "?subjectId=user", "?owner=private-value"]) {
    const response = await s.invalid("GET", "/dietary-warnings" + suffix); assert.equal(response.headers.get("cache-control"), "no-store");
  }
  for (const body of [{ expectedVersion: "1", text: "x" }, { expectedVersion: Number.MAX_SAFE_INTEGER, text: "x" },
    { expectedVersion: 1, text: " " }, { expectedVersion: 1, text: "x".repeat(501) }, { expectedVersion: 1, text: "x", owner: ID }]) {
    await s.invalid("PUT", `/dietary-warnings/${ID}`, body);
  }
  await s.invalid("POST", `/dietary-warnings/${ID}/removals`, { expectedVersion: 1, text: "x" });
  await s.invalid("PUT", "/dietary-warnings/bad", { expectedVersion: 1, text: "x" });
});

test("authentication and disabled configuration still precede customer request validation", async (t) => {
  const s = await fixture(t);
  const guest = await s.request("POST", "/messages", {}, { "Content-Type": "application/json", "x-guest-id": "guest" });
  assert.equal(guest.status, 401); assert.equal(s.calls.length, 0);
  s.config = { enabled: false };
  for (const [method, route, body] of [["POST", "/messages", {}], ["GET", "/messages?limit=bad"], ["PUT", "/subject", {}],
    ["GET", "/runs/bad"], ["PUT", "/memory", {}], ["PUT", "/dietary-warnings/bad", {}]]) {
    const response = await s.request(method, route, body); assert.equal(response.status, 503); assert.equal(response.body.error.code, "assistant_disabled");
  }
  assert.equal(s.calls.length, 0);
});
