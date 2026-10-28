import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { createAssistantRouter } from "../../../src/domains/assistant/assistant.routes.js";
import { testConfig } from "./fixtures/foundationPolicy.js";

test("dietary-warning HTTP uses authenticated ownership, verified phones and private responses", async (t) => {
  const previousSecret = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = "dietary-warning-local-test-secret";
  t.after(() => { if (previousSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = previousSecret; });
  const user = { _id: new mongoose.Types.ObjectId(), role: "user", active: true, phoneVerified: true };
  t.mock.method(UserModel, "findById", async () => user);
  const config = testConfig(); const calls = []; let fail = false;
  const application = Object.fromEntries(["listDietaryWarnings", "editDietaryWarning", "removeDietaryWarning"].map((operation) => [operation,
    async (...args) => {
      calls.push({ operation, args });
      if (fail) throw new Error("private provider prompt and database details");
      return { operation };
    }]));
  const app = express(); app.use(express.json());
  app.use("/assistant", createAssistantRouter({ getConfig: () => config, application }));
  const server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/assistant/dietary-warnings`;
  const auth = `Bearer ${jwt.sign({ userId: String(user._id) }, process.env.JWT_ACCESS_SECRET)}`;
  const id = String(new mongoose.Types.ObjectId()); const subject = `pet:${new mongoose.Types.ObjectId()}`;
  const variants = [
    { operation: "listDietaryWarnings", url: `${base}?subjectId=${subject}&limit=5`, method: "GET", payload: { subjectId: subject, limit: "5" } },
    { operation: "editDietaryWarning", url: `${base}/${id}`, method: "PUT", payload: { expectedVersion: 1, text: "User-reported food warning" } },
    { operation: "removeDietaryWarning", url: `${base}/${id}/removals`, method: "POST", payload: { expectedVersion: 2 } },
  ];
  for (const item of variants) {
    const request = (authenticated = true) => fetch(item.url, { method: item.method,
      headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: auth } : {}) },
      ...(item.method === "GET" ? {} : { body: JSON.stringify(item.payload) }) });
    const denied = await request(false);
    assert.equal(denied.status, 401); assert.equal(denied.headers.get("cache-control"), "no-store");
    user.phoneVerified = false;
    const unverified = await request(); assert.equal(unverified.status, 403);
    assert.equal(unverified.headers.get("cache-control"), "no-store");
    assert.equal(calls.length, 0);
    user.phoneVerified = true;
    for (const role of ["user", "moderator", "admin", "superAdmin"]) {
      user.role = role;
      const response = await request(); assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { data: { operation: item.operation } });
      const call = calls.pop(); assert.equal(call.operation, item.operation);
      assert.equal(String(call.args[0]), String(user._id));
      if (item.method === "GET") assert.deepEqual({ ...call.args[1] }, item.payload);
      else { assert.equal(call.args[1], id); assert.deepEqual(call.args[2], item.payload); }
      assert.equal(call.args.at(-1), config);
    }
    fail = true;
    const failed = await request(); assert.equal(failed.status, 503);
    assert.equal(failed.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(JSON.stringify(await failed.json()), /private|provider|prompt|database|stack/);
    calls.length = 0; fail = false;
  }
});
