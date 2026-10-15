import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { createEditorialVideoService } from "../../../../src/domains/videos/editorial/editorialVideo.service.js";
import { createEditorialVideoRouter } from "../../../../src/domains/videos/editorial/editorialVideo.routes.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";
import { EditorialVideoModel } from "../../../../src/domains/videos/editorial/editorialVideo.model.js";
import { createEditorialVideoRepository } from "../../../../src/domains/videos/editorial/editorialVideo.repository.js";
import { allowedTo, enabledControls as requireControl } from "../../../../src/domains/auth/auth.middleware.js";
import { roles, enabledControls } from "../../../../src/shared/constants/enums.js";

const superAdmin = { id: "super-1", role: "superAdmin" };

function fixture({ kind = "youtube", status = "published", replaceResult = true, missing = false, ...fields } = {}) {
  let record = { id: "video-1", revision: 3, kind, status, position: null, ...fields };
  const app = createEditorialVideoService({
    repository: {
      async create() { throw new Error("unused"); },
      async get() { return missing ? null : structuredClone(record); },
      async replace(id, revision, next) {
        assert.equal(id, "video-1");
        assert.equal(revision, record.revision);
        if (!replaceResult) return null;
        record = { ...next, revision: revision + 1 };
        return { ...record };
      },
    },
    verifyYouTube: async () => { throw new Error("ordering must not call YouTube"); },
  });
  return app;
}

test("super admin sets and clears one published YouTube position", async () => {
  const app = fixture();
  const positioned = await app.setPublicPosition({ id: "video-1", actor: superAdmin,
    input: { position: 0 } });
  assert.equal(positioned.position, 0);
  assert.equal(positioned.revision, 4);
  const cleared = await app.setPublicPosition({ id: "video-1", actor: superAdmin,
    input: { position: null } });
  assert.equal(cleared.position, null);
  assert.equal(cleared.revision, 5);
});

test("admins cannot change public position, and invalid or unpublished input fails closed", async () => {
  const app = fixture();
  await assert.rejects(app.setPublicPosition({ id: "video-1",
    actor: { id: "admin-1", role: "admin" }, input: { position: 1 } }),
  (error) => error.statusCode === 403);
  for (const input of [{}, { position: -1 }, { position: 1.5 },
    { position: "1" }, { position: 1, status: "published" }]) {
    await assert.rejects(app.setPublicPosition({ id: "video-1", actor: superAdmin, input }),
      (error) => error.statusCode === 422);
  }
  await assert.rejects(fixture({ status: "approved" }).setPublicPosition({
    id: "video-1", actor: superAdmin, input: { position: 1 },
  }), (error) => error.statusCode === 409);
});

test("concurrent edit causes a position conflict rather than a stale overwrite", async () => {
  await assert.rejects(fixture({ replaceResult: false }).setPublicPosition({
    id: "video-1", actor: superAdmin, input: { position: 3 },
  }), (error) => error.statusCode === 409);
});

test("super admin sets and clears a published Reel without changing its pending proposal or public media", async () => {
  const fields = { activeAssetId: "active-asset", activeUploadSessionId: "active-session", activeCoverId: "active-cover",
    publishedAt: new Date("2026-09-28T00:00:00Z"), title_en: "Public", title_ar: "عام",
    pendingChange: { status: "in_review", authorId: "admin-1", assetId: "pending-asset",
      uploadSessionId: "pending-session", content: { title_en: "Proposal", coverId: "pending-cover" } } };
  const app = fixture({ kind: "reel", ...fields });
  for (const position of [0, 8, null]) {
    const updated = await app.setPublicPosition({ id: "video-1", actor: superAdmin, input: { position } });
    assert.equal(updated.position, position); assert.equal(updated.status, "published");
    for (const [key, value] of Object.entries(fields)) assert.deepEqual(updated[key], value);
  }
});

test("Reel ordering rejects non-super-admin actors, hidden content, product projections and malformed positions", async () => {
  const app = fixture({ kind: "reel" });
  for (const actor of [null, { role: "superAdmin" }, { id: "admin-1", role: "admin" },
    { id: "moderator-1", role: "moderator" }, { id: "user-1", role: "user" }]) {
    await assert.rejects(app.setPublicPosition({ id: "video-1", actor, input: { position: 1 } }),
      (error) => error.statusCode === 403);
  }
  for (const input of [null, [], {}, { position: undefined }, { position: -1 }, { position: 0.1 },
    { position: "0" }, { position: true }, { position: NaN }, { position: Infinity },
    { position: Number.MAX_SAFE_INTEGER + 1 }, { position: 0, kind: "reel" }]) {
    await assert.rejects(app.setPublicPosition({ id: "video-1", actor: superAdmin, input }),
      (error) => error.statusCode === 422);
  }
  for (const status of ["draft", "in_review", "approved", "unpublished"]) {
    await assert.rejects(fixture({ kind: "reel", status }).setPublicPosition({ id: "video-1", actor: superAdmin,
      input: { position: 1 } }), (error) => error.statusCode === 409);
  }
  await assert.rejects(fixture({ kind: "product" }).setPublicPosition({ id: "video-1", actor: superAdmin,
    input: { position: 1 } }), (error) => error.statusCode === 409);
  await assert.rejects(fixture({ kind: "reel", missing: true }).setPublicPosition({ id: "video-1", actor: superAdmin,
    input: { position: 1 } }), (error) => error.statusCode === 404);
  await assert.rejects(fixture({ kind: "reel", replaceResult: false }).setPublicPosition({ id: "video-1", actor: superAdmin,
    input: { position: 1 } }), (error) => error.statusCode === 409);
});

test("editorial position schema permits clearing and rejects invalid numeric positions for both kinds", async () => {
  for (const kind of ["youtube", "reel"]) {
    const base = { kind, status: "published", authorId: "507f1f77bcf86cd799439011",
      title_en: "Test", title_ar: "اختبار", ...(kind === "youtube" ? { youtubeId: "dQw4w9WgXcQ" } : {}) };
    for (const position of [undefined, null, 0, Number.MAX_SAFE_INTEGER]) {
      await new EditorialVideoModel({ ...base, position }).validate();
    }
    for (const position of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      await assert.rejects(new EditorialVideoModel({ ...base, position }).validate(),
        (error) => Boolean(error.errors.position));
    }
  }
});

test("position writes retain the existing repository revision filter and update validators", async () => {
  const id = "507f1f77bcf86cd799439011";
  const app = createEditorialVideoService({ verifyYouTube: async () => assert.fail("no provider call"),
    repository: createEditorialVideoRepository({ assertAuthority: async () => {},
      connection: { async startSession() { return { async withTransaction(work) { await work(); }, async endSession() {} }; } }, videos: {
      findById(value) { assert.equal(value, id); return { async lean() {
        return { _id: id, kind: "reel", status: "published", revision: 7, position: 2 };
      } }; },
      findOneAndUpdate(filter, changes, options) {
        assert.deepEqual(filter, { _id: id, revision: 7 });
        assert.equal(changes.$set.position, null); assert.deepEqual(changes.$inc, { revision: 1 });
        assert.equal(options.runValidators, true); assert.equal(options.new, true);
        return { async lean() { return null; } };
      },
    }, reelLifecycle: {} }),
  });
  await assert.rejects(app.setPublicPosition({ id, actor: superAdmin, input: { position: null } }),
    (error) => error.statusCode === 409);
});

test("Reel position HTTP action uses real role/control checks and application set/clear validation", async () => {
  const app = express(); app.use(express.json());
  app.use("/api/v1/videos/admin", createEditorialVideoRouter({
    access: [(req, _res, next) => { req.user = { _id: "super-1", role: req.get("role") || roles.SUPER_ADMIN,
      enabledControls: req.get("control") === "no" ? [] : [enabledControls.VIDEOS] }; next(); },
      allowedTo(roles.SUPER_ADMIN, roles.ADMIN), requireControl(enabledControls.VIDEOS)],
    getService: () => fixture({ kind: "reel" }),
  }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/videos/admin/video-1/position`;
  const request = (input, headers = {}) => fetch(url, { method: "PATCH",
    headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input) });
  try {
    for (const headers of [{ role: roles.ADMIN }, { role: roles.USER }, { role: roles.MODERATOR },
      { role: roles.ADMIN, control: "no" }]) {
      assert.equal((await request({ position: 0 }, headers)).status, 403);
    }
    for (const position of [0, null]) {
      const response = await request({ position }); assert.equal(response.status, 200);
      assert.equal((await response.json()).data.position, position);
    }
    assert.equal((await request({ position: "0" })).status, 422);
    assert.equal((await request({ position: 0, status: "published" })).status, 422);
    assert.equal((await request({ position: 0 }, { control: "no" })).status, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("protected position route passes only a super-admin action to the application", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/videos/admin", createEditorialVideoRouter({
    access: [(req, _res, next) => { req.user = { _id: "super-1", role: "superAdmin" }; next(); }],
    reviewAccess: [(_req, _res, next) => next()],
    getService: () => ({
      async setPublicPosition({ id, actor, input }) {
        assert.equal(id, "video-1");
        assert.deepEqual(actor, superAdmin);
        assert.deepEqual(input, { position: 2 });
        return { id, position: 2 };
      },
    }),
  }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/videos/admin/video-1/position`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ position: 2 }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { id: "video-1", position: 2 } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
