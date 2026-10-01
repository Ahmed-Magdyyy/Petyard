import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import {
  adminUiBuilderRouter, adminUiLayoutRouter, publicUiLayoutRouter,
} from "../../../src/domains/uiLayout/uiLayout.routes.js";
import { uiLayoutService } from "../../../src/domains/uiLayout/uiLayout.service.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { HomeLayoutModel } from "../../../src/domains/homeLayout/homeLayout.model.js";
import homeLayoutRoutes from "../../../src/domains/homeLayout/homeLayout.routes.js";
import { previewReadLimiter, previewCreateLimiter } from "../../../src/domains/uiLayout/uiLayout.limiters.js";

test("catalog enforces backend super-admin authorization", async () => {
  const originalFindById = UserModel.findById;
  const originalSecret = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = "ui-layout-http-test-secret";
  UserModel.findById = async (id) => ({
    _id: id, role: id === "super" ? "superAdmin" : "admin",
    phoneVerified: true, active: true, account_status: "active",
  });
  const app = express();
  app.use((req, _res, next) => { req.requestId = "test-request"; next(); });
  app.use("/api/v1/admin/ui-builder", adminUiBuilderRouter);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/admin/ui-builder/catalog`;
  try {
    const missing = await fetch(base);
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error.code, "UNAUTHORIZED");
    const ordinary = await fetch(base, { headers: {
      Authorization: `Bearer ${jwt.sign({ userId: "ordinary" }, process.env.JWT_ACCESS_SECRET)}`,
    } });
    assert.equal(ordinary.status, 403);
    assert.equal((await ordinary.json()).error.code, "FORBIDDEN");
    const superAdmin = await fetch(base, { headers: {
      Authorization: `Bearer ${jwt.sign({ userId: "super" }, process.env.JWT_ACCESS_SECRET)}`,
    } });
    assert.equal(superAdmin.status, 200);
    const body = await superAdmin.json();
    assert.equal(body.data.schema_version, 1);
    assert.equal(body.meta.request_id, "test-request");
    assert.ok(body.data.section_types.some((section) => section.key === "admin_promo"));
    assert.equal(body.data.asset_upload.mode, "multipart");
    assert.equal(body.data.asset_upload.image_field, "image");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    UserModel.findById = originalFindById;
    if (originalSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = originalSecret;
  }
});

test("preview creation passes validated context and rejects malformed hints", async () => {
  const originalFindById = UserModel.findById;
  const originalCreatePreview = uiLayoutService.createPreview;
  const originalSecret = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = "ui-layout-http-test-secret";
  UserModel.findById = async (id) => ({ _id: id, role: "superAdmin",
    phoneVerified: true, active: true, account_status: "active" });
  let received;
  uiLayoutService.createPreview = async (request) => {
    received = request;
    return { preview_id: "preview", token: "secret" };
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.requestId = "test-preview"; next(); });
  app.use("/api/v1/admin/home-layouts", adminUiLayoutRouter);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const draftId = "8ec682ef-aacd-4639-9d23-b98ea8234dbe";
  const url = `http://127.0.0.1:${server.address().port}/api/v1/admin/home-layouts/drafts/${draftId}/preview`;
  const headers = { Authorization: `Bearer ${jwt.sign({ userId: "super" }, process.env.JWT_ACCESS_SECRET)}`,
    "Content-Type": "application/json" };
  try {
    const valid = await fetch(url, { method: "POST", headers, body: JSON.stringify({
      revision: 8, device_profile: "mobile", locale: "en", platform: "android",
      location_id: "6e5966ec-642b-4a15-a6a0-779dd6a6274f",
    }) });
    assert.equal(valid.status, 201);
    assert.equal(received.id, draftId);
    assert.deepEqual(received.context, { device_profile: "mobile", locale: "en",
      platform: "android", location_id: "6e5966ec-642b-4a15-a6a0-779dd6a6274f" });
    const invalid = await fetch(url, { method: "POST", headers, body: JSON.stringify({
      revision: 8, platform: "desktop",
    }) });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "UI_LAYOUT_INVALID_REQUEST");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    UserModel.findById = originalFindById;
    uiLayoutService.createPreview = originalCreatePreview;
    if (originalSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = originalSecret;
  }
});

test("published endpoint emits ETag/304 and never exposes draft fields", async () => {
  const originalGetPublic = uiLayoutService.getPublic;
  uiLayoutService.getPublic = async () => ({
    layout_id: "b1e94213-b895-4809-ab06-6738cbf71e8f",
    version_id: "66ee543b-96f6-4dbf-9729-9c836a7dba86",
    version_number: 1, schema_version: 1, published_at: "2026-09-24T00:00:00Z",
    checksum: "sha256:example", sections: [{ section_type: "banners", data: {}, position: 0 }],
    navigation: { items: [{ key: "home", destination: "home", enabled: true, order: 0 }] },
  });
  const app = express();
  app.use((req, _res, next) => { req.requestId = "test-public"; next(); });
  app.use("/api/v1/ui-layouts", publicUiLayoutRouter);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const url = `http://127.0.0.1:${server.address().port}/api/v1/ui-layouts/customer_home`;
  try {
    const first = await fetch(url);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("etag"), '"sha256:example"');
    const body = await first.json();
    assert.equal(body.data.sections.length, 1);
    assert.equal(body.data.draft, undefined);
    assert.equal(body.meta.request_id, "test-public");
    const second = await fetch(url, { headers: { "If-None-Match": '"sha256:example"' } });
    assert.equal(second.status, 304);
    assert.equal(await second.text(), "");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    uiLayoutService.getPublic = originalGetPublic;
  }
});

test("legacy Home GET remains default while cutover flag selects published contract", async () => {
  const originalFindById = UserModel.findById;
  const originalHomeFind = HomeLayoutModel.findOne;
  const originalGetPublic = uiLayoutService.getPublic;
  const originalSecret = process.env.JWT_ACCESS_SECRET;
  const originalCutover = process.env.UI_BUILDER_PUBLIC_CUTOVER_ENABLED;
  process.env.JWT_ACCESS_SECRET = "ui-layout-http-test-secret";
  delete process.env.UI_BUILDER_PUBLIC_CUTOVER_ENABLED;
  UserModel.findById = async (id) => ({
    _id: id, role: "superAdmin", phoneVerified: true, active: true,
    account_status: "active",
  });
  HomeLayoutModel.findOne = async () => ({
    sections: [{ key: "banners", name_en: "Banners", name_ar: "البانرات", position: 0 }],
  });
  uiLayoutService.getPublic = async () => ({
    layout_id: "b1e94213-b895-4809-ab06-6738cbf71e8f",
    version_id: "66ee543b-96f6-4dbf-9729-9c836a7dba86",
    version_number: 1, schema_version: 1, published_at: "2026-09-24T00:00:00Z",
    checksum: "sha256:cutover", sections: [{ section_type: "banners", data: {}, position: 0 }],
    navigation: { items: [{ key: "home", destination: "home", enabled: true, order: 0 }] },
  });
  const app = express();
  app.use((req, _res, next) => { req.requestId = "test-cutover"; next(); });
  app.use("/api/v1/home-layout", homeLayoutRoutes);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const url = `http://127.0.0.1:${server.address().port}/api/v1/home-layout`;
  const headers = { Authorization: `Bearer ${jwt.sign({ userId: "super" }, process.env.JWT_ACCESS_SECRET)}` };
  try {
    const legacy = await (await fetch(url, { headers })).json();
    assert.equal(legacy.data.sections[0].key, "banners");
    assert.equal(legacy.data.navigation, undefined);
    assert.equal(legacy.meta, undefined);
    const legacyWithBuilderHeader = await fetch(url, { headers: { ...headers, "X-App-Platform": "desktop" } });
    assert.equal(legacyWithBuilderHeader.status, 200);
    process.env.UI_BUILDER_PUBLIC_CUTOVER_ENABLED = "true";
    const cutover = await (await fetch(url, { headers })).json();
    assert.equal(cutover.data.version_number, 1);
    assert.equal(cutover.data.navigation.items[0].key, "home");
    assert.equal(cutover.meta.request_id, "test-cutover");
    const malformedTarget = await fetch(url, { headers: { ...headers, "X-App-Platform": "desktop" } });
    assert.equal(malformedTarget.status, 400);
    assert.equal((await malformedTarget.json()).error.details[0].path, "X-App-Platform");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    UserModel.findById = originalFindById;
    HomeLayoutModel.findOne = originalHomeFind;
    uiLayoutService.getPublic = originalGetPublic;
    if (originalSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = originalSecret;
    if (originalCutover === undefined) delete process.env.UI_BUILDER_PUBLIC_CUTOVER_ENABLED;
    else process.env.UI_BUILDER_PUBLIC_CUTOVER_ENABLED = originalCutover;
  }
});

test("route validators preserve authorization, save input, release guards and upload errors", async () => {
  const originalFindById = UserModel.findById;
  const originalSave = uiLayoutService.saveDraft;
  const originalPublish = uiLayoutService.publish;
  const originalRollback = uiLayoutService.rollback;
  const originalSecret = process.env.JWT_ACCESS_SECRET;
  const originalRelease = process.env.UI_BUILDER_PUBLISH_ENABLED;
  process.env.JWT_ACCESS_SECRET = "ui-layout-refactor-test-secret";
  delete process.env.UI_BUILDER_PUBLISH_ENABLED;
  UserModel.findById = async (id) => ({ _id: id, role: "superAdmin",
    phoneVerified: true, active: true, account_status: "active" });
  const calls = [];
  uiLayoutService.saveDraft = async (input) => { calls.push(["save", input]); return { revision: 3 }; };
  uiLayoutService.publish = async (input) => { calls.push(["publish", input]); return { version_id: "version" }; };
  uiLayoutService.rollback = async (input) => { calls.push(["rollback", input]); return { version_id: "rollback" }; };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.requestId = "refactor-request"; next(); });
  app.use("/api/v1/admin/home-layouts", adminUiLayoutRouter);
  app.use("/api/v1/admin/ui-builder", adminUiBuilderRouter);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/admin`;
  const draftId = "8ec682ef-aacd-4639-9d23-b98ea8234dbe";
  const key = "25973937-7de2-41fd-a165-64053129c10e";
  const authorization = `Bearer ${jwt.sign({ userId: "super" }, process.env.JWT_ACCESS_SECRET)}`;
  const headers = { Authorization: authorization, "Content-Type": "application/json" };
  const body = { name: "Home", targeting: {}, content: { sections: [], navigation: { items: [] } } };
  try {
    const unauthenticated = await fetch(`${base}/home-layouts/drafts/not-a-uuid`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(unauthenticated.status, 401);
    const missingRevision = await fetch(`${base}/home-layouts/drafts/${draftId}`, {
      method: "PATCH", headers, body: JSON.stringify({ ...body, unknown: true }),
    });
    assert.equal((await missingRevision.json()).error.code, "UI_DRAFT_IF_MATCH_REQUIRED");
    const unknownField = await fetch(`${base}/home-layouts/drafts/${draftId}`, {
      method: "PATCH", headers: { ...headers, "If-Match": '"2"' },
      body: JSON.stringify({ ...body, unknown: true }),
    });
    assert.equal(unknownField.status, 400);
    assert.equal((await unknownField.json()).error.details[0].path, "body.unknown");
    assert.equal(calls.length, 0);
    const saved = await fetch(`${base}/home-layouts/drafts/${draftId}`, {
      method: "PATCH", headers: { ...headers, "If-Match": '"2"', "X-Client-Mutation-Id": key },
      body: JSON.stringify(body),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.headers.get("cache-control"), "no-store");
    assert.deepEqual(calls[0], ["save", { id: draftId, revision: 2, body, mutationId: key,
      actorId: "super", requestId: "refactor-request" }]);

    for (const path of ["drafts/not-a-uuid/publish", "versions/not-a-uuid/rollback"]) {
      const disabled = await fetch(`${base}/home-layouts/${path}`, {
        method: "POST", headers, body: "{}",
      });
      assert.equal(disabled.status, 503);
      assert.equal((await disabled.json()).error.code, "UI_LAYOUT_RELEASE_DISABLED");
    }
    process.env.UI_BUILDER_PUBLISH_ENABLED = "true";
    const malformed = await fetch(`${base}/home-layouts/drafts/${draftId}/publish`, {
      method: "POST", headers: { ...headers, "Idempotency-Key": "invalid" },
      body: JSON.stringify({ revision: 2, mode: "other", change_note: "Release" }),
    });
    assert.equal((await malformed.json()).error.details[0].path, "Idempotency-Key");
    const published = await fetch(`${base}/home-layouts/drafts/${draftId}/publish`, {
      method: "POST", headers: { ...headers, "Idempotency-Key": key },
      body: JSON.stringify({ revision: 2, mode: "now", change_note: "Release" }),
    });
    assert.equal(published.status, 201);
    assert.deepEqual(calls[1], ["publish", { id: draftId, revision: 2, idempotencyKey: key,
      changeNote: "Release", actorId: "super", requestId: "refactor-request" }]);
    const rollback = await fetch(`${base}/home-layouts/versions/${draftId}/rollback`, {
      method: "POST", headers: { ...headers, "Idempotency-Key": key },
      body: JSON.stringify({ change_note: "Restore" }),
    });
    assert.equal(rollback.status, 201);
    assert.deepEqual(calls[2], ["rollback", { versionId: draftId, changeNote: "Restore",
      idempotencyKey: key, actorId: "super", requestId: "refactor-request" }]);
    const upload = new FormData();
    upload.append("usage", "promo");
    upload.append("image", new Blob(["first"], { type: "image/png" }), "first.png");
    upload.append("image", new Blob(["second"], { type: "image/png" }), "second.png");
    const rejectedUpload = await fetch(`${base}/ui-builder/assets`, {
      method: "POST", headers: { Authorization: authorization }, body: upload,
    });
    assert.equal(rejectedUpload.status, 400);
    assert.equal((await rejectedUpload.json()).error.code, "UI_ASSET_INVALID_UPLOAD");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    UserModel.findById = originalFindById;
    uiLayoutService.saveDraft = originalSave;
    uiLayoutService.publish = originalPublish;
    uiLayoutService.rollback = originalRollback;
    if (originalSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = originalSecret;
    if (originalRelease === undefined) delete process.env.UI_BUILDER_PUBLISH_ENABLED;
    else process.env.UI_BUILDER_PUBLISH_ENABLED = originalRelease;
  }
});

test("extracted preview limiters keep independent counters, thresholds and error envelopes", async () => {
  const app = express();
  app.use((req, _res, next) => { req.requestId = "limiter-request"; next(); });
  app.get("/read", previewReadLimiter, (_req, res) => res.status(200).end());
  app.post("/create", previewCreateLimiter, (_req, res) => res.status(201).end());
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  previewReadLimiter.resetKey("127.0.0.1");
  previewCreateLimiter.resetKey("127.0.0.1");
  try {
    for (const [path, method, limit, status, message] of [
      ["/read", "GET", 60, 200, "Too many preview requests."],
      ["/create", "POST", 30, 201, "Too many previews created."],
    ]) {
      for (let count = 0; count < limit; count += 1) {
        assert.equal((await fetch(base + path, { method })).status, status);
      }
      const blocked = await fetch(base + path, { method });
      assert.equal(blocked.status, 429);
      assert.deepEqual(await blocked.json(), { error: {
        code: "UI_PREVIEW_RATE_LIMITED", message, request_id: "limiter-request",
      } });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    previewReadLimiter.resetKey("127.0.0.1");
    previewCreateLimiter.resetKey("127.0.0.1");
  }
});
