import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import { createAssistantRouter } from "../../../src/domains/assistant/assistant.routes.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { AssistantError } from "../../../src/domains/assistant/shared/assistant.errors.js";
import { loadAssistantConfig, periods } from "../../../src/domains/assistant/shared/assistant.config.js";
import { metadataDto } from "../../../src/domains/assistant/shared/assistant.dto.js";
import { testConfig, testPolicy } from "./fixtures/foundationPolicy.js";

const U = "111111111111111111111111", L = "222222222222222222222222";
async function fixture(t) {
  const config = { ...testConfig(), bookingReadsEnabled: true }, calls = [];
  const previous = process.env.JWT_ACCESS_SECRET; process.env.JWT_ACCESS_SECRET = "synthetic-booking-http-test-only";
  t.after(() => { if (previous === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = previous; });
  const user = { _id: U, active: true, phoneVerified: true, account_status: "confirmed" };
  t.mock.method(UserModel, "findById", async () => user);
  const application = Object.fromEntries(["getAssistantBookingOptions", "getAssistantBookingPreview"].map((name) => [name, async (owner, body, receivedConfig) => {
    calls.push({ name, owner: String(owner), body }); assert.equal(receivedConfig, config);
    if (state.error) throw state.error;
    return { eligible: true, services: [], locations: [], estimateOnly: true };
  }]));
  const app = express(); app.use(express.json({ limit: "32kb" }));
  app.use("/api/v1/assistant", createAssistantRouter({ getConfig: () => config, bookingApplication: application }));
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const token = jwt.sign({ userId: U }, process.env.JWT_ACCESS_SECRET, { expiresIn: "5m" });
  const state = { config, calls, user, error: null, body: { location: { governorateCode: "alexandria", areaCode: "smouha" }, language: "en" },
    async request(path = "options", body = state.body, headers = { authorization: `Bearer ${token}` }) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/assistant/booking/${path}`, {
        method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
      });
      assert.equal(response.headers.get("cache-control"), "no-store");
      return { status: response.status, headers: response.headers, body: await response.json() };
    } };
  return state;
}
test("booking API uses real authenticated principal and passes validated manual or GPS input unchanged", async (t) => {
  const f = await fixture(t); assert.equal((await f.request()).status, 200); assert.equal(f.calls[0].owner, U);
  assert.deepEqual(f.calls[0].body, f.body);
  const gps = { location: { lat: 31.2, lng: 29.9 }, language: "ar" };
  assert.equal((await f.request("options", gps)).status, 200); assert.deepEqual(f.calls[1].body, gps);
  const preview = { ...f.body, booking: { locationId: L, serviceType: "CLINIC", serviceOptionKey: "checkup", date: "2026-10-24", hour24: 14 } };
  assert.equal((await f.request("preview", preview)).status, 200); assert.equal(f.calls[2].name, "getAssistantBookingPreview");
});
test("guest, invalid bearer and unverified users cannot enter booking reads", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("options", f.body, { "x-guest-id": "guest" })).status, 401);
  assert.equal((await f.request("options", f.body, { authorization: "Bearer invalid" })).status, 401);
  f.user.phoneVerified = false; assert.equal((await f.request()).status, 403); assert.equal(f.calls.length, 0);
});
test("dedicated validators reject forged evidence, extra query/body fields and unsupported services before dispatch", async (t) => {
  const f = await fixture(t);
  for (const body of [{ ...f.body, owner: U }, { ...f.body, resolvedLocation: { eligible: true } },
    { ...f.body, location: { ...f.body.location, city: "Alexandria" } }, { ...f.body, location: { lat: 31 } },
    { ...f.body, location: { lat: "31", lng: 29 } }, { ...f.body, location: { lat: 31, lng: 29, governorateCode: "alexandria" } },
    { ...f.body, language: "arabizi" }, { ...f.body, location: { governorateCode: {} } }]) {
    const response = await f.request("options", body); assert.equal(response.status, 400); assert.equal(response.body.error.code, "invalid_request");
  }
  assert.equal((await f.request("options?eligible=true")).status, 400);
  const booking = { locationId: L, serviceType: "BOARDING", date: "2026-10-24", hour24: 14 };
  assert.equal((await f.request("preview", { ...f.body, booking })).status, 400);
  assert.equal((await f.request("preview", { ...f.body, booking: { ...booking, serviceType: "CLINIC", owner: U } })).status, 400);
  for (const ids of [{ locationId: [L] }, { petId: [U] }]) assert.equal((await f.request("preview", {
    ...f.body, booking: { ...booking, serviceType: "CLINIC", ...ids },
  })).status, 400);
  assert.equal((await f.request("preview", f.body)).status, 400); assert.equal(f.calls.length, 0);
});
test("read switch rejects authenticated requests before validation, while error envelopes remain safe", async (t) => {
  const f = await fixture(t); f.config.bookingReadsEnabled = false;
  const off = await f.request("preview", {}); assert.equal(off.status, 503); assert.equal(off.body.error.code, "booking_reads_unavailable");
  assert.equal(f.calls.length, 0); f.config.bookingReadsEnabled = true;
  f.error = new Error("private phone address database details"); const failed = await f.request();
  assert.equal(failed.status, 503); assert.equal(JSON.stringify(failed.body).includes("private"), false);
  f.error = new AssistantError("booking_request_rate_limit", 429, new Date(Date.now() + 30000));
  const limited = await f.request(); assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get("retry-after")) > 0);
});
test("booking read capability is separate, default off and never grants geographic eligibility or mutation", () => {
  const env = { ASSISTANT_ENABLED: "true", OPENAI_API_KEY: "synthetic", ASSISTANT_POLICY_JSON: JSON.stringify(testPolicy()) };
  const config = loadAssistantConfig(env); assert.equal(config.bookingReadsEnabled, false);
  const enabled = loadAssistantConfig({ ...env, ASSISTANT_BOOKING_READS_ENABLED: "true" }); assert.equal(enabled.bookingReadsEnabled, true);
  const metadata = metadataDto(enabled, null, periods(enabled)); assert.equal(metadata.capabilities.bookingReads, true); assert.equal(metadata.capabilities.commerceActions, false);
  assert.equal(metadataDto(enabled, { blocked: true }, periods(enabled)).capabilities.bookingReads, false);
});
