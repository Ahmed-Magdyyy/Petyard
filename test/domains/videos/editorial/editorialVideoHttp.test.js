import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { createEditorialVideoRouter } from "../../../../src/domains/videos/editorial/editorialVideo.routes.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";
import { createEditorialVideoService } from "../../../../src/domains/videos/editorial/editorialVideo.service.js";
import { allowedTo, enabledControls as requireControl } from "../../../../src/domains/auth/auth.middleware.js";
import { roles, enabledControls } from "../../../../src/shared/constants/enums.js";

test("cover HTTP routes enforce staff controls, upload readiness, bounded multipart input and field-free removal", async () => {
  let ready = false; const calls = [];
  const app = express(); app.use(express.json());
  app.use("/api/v1/videos/admin", createEditorialVideoRouter({
    access: [(req, _res, next) => { req.user = { _id: "admin-1", role: req.get("role") || roles.ADMIN,
      enabledControls: req.get("control") === "no" ? [] : [enabledControls.VIDEOS] }; next(); },
      allowedTo(roles.ADMIN, roles.SUPER_ADMIN), requireControl(enabledControls.VIDEOS)],
    isCoverPipelineReady: () => ready,
    getService: () => ({ async editCover(input) { calls.push(input); return { id: input.id, coverUrl: null }; } }),
  }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/videos/admin/video-1/cover`;
  const form = (field = "cover", size = 12) => {
    const body = new FormData(); body.append(field, new Blob([Buffer.alloc(size)], { type: "image/jpeg" }), "portrait.jpg");
    return body;
  };
  try {
    for (const headers of [{ role: roles.USER }, { control: "no" }]) {
      assert.equal((await fetch(url, { method: "POST", headers, body: form() })).status, 403);
      assert.equal((await fetch(url, { method: "DELETE", headers })).status, 403);
    }
    assert.equal((await fetch(url, { method: "POST", body: form() })).status, 503);
    assert.equal(calls.length, 0);
    const removed = await fetch(url, { method: "DELETE" });
    assert.equal(removed.status, 200); assert.equal(removed.headers.get("cache-control"), "private, no-store");
    assert.equal(calls[0].remove, true);
    assert.equal((await fetch(url, { method: "DELETE", headers: { "content-type": "application/json" },
      body: JSON.stringify({ coverId: "untrusted" }) })).status, 422);
    ready = true;
    assert.equal((await fetch(url, { method: "POST" })).status, 422);
    const uploaded = await fetch(url, { method: "POST", body: form() });
    assert.equal(uploaded.status, 200); assert.equal(uploaded.headers.get("cache-control"), "private, no-store");
    assert.equal(calls[1].buffer.length, 12); assert.deepEqual(calls[1].actor, { id: "admin-1", role: roles.ADMIN });
    assert.equal((await fetch(url, { method: "POST", body: form("cover", 5 * 1024 * 1024 + 1) })).status, 400);
    const withFields = form(); withFields.append("coverUrl", "https://untrusted.example");
    assert.equal((await fetch(url, { method: "POST", body: withFields })).status, 400);
    assert.equal((await fetch(url, { method: "POST", body: form("other") })).status, 400);
    assert.equal(calls.length, 2);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("protected Videos administration creates a YouTube draft through the application", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/videos/admin", createEditorialVideoRouter({
    access: [(req, _res, next) => { req.user = { _id: "admin-1", role: "admin" }; next(); }],
    reviewAccess: [(_req, _res, next) => next()],
    getService: () => ({
      async createYouTubeVideo({ actor, input }) {
        assert.deepEqual(actor, { id: "admin-1", role: "admin" });
        assert.equal(input.youtubeUrl, "https://youtu.be/dQw4w9WgXcQ");
        return { id: "video-1", kind: "youtube", status: "draft" };
      },
    }),
  }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/videos/admin`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
        title_en: "Care", title_ar: "رعاية" }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { data: { id: "video-1", kind: "youtube", status: "draft" } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an admin cannot call a super-admin review action", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/videos/admin", createEditorialVideoRouter({
    access: [(req, _res, next) => { req.user = { _id: "admin-1", role: "admin" }; next(); }],
    getService: () => { throw new Error("review must not reach application"); },
  }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/videos/admin/video-1/approve`, {
      method: "POST",
    });
    assert.equal(response.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the protected cancel route reaches the pending-change application interface", async () => {
  const app = express();
  app.use("/api/v1/videos/admin", createEditorialVideoRouter({
    access: [(req, _res, next) => { req.user = { _id: "admin-2", role: "admin" }; next(); }],
    getService: () => ({
      async cancelPendingChange({ id, actor }) {
        assert.equal(id, "video-2");
        assert.equal(actor.id, "admin-2");
        return { id, pendingChange: null };
      },
    }),
  }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/videos/admin/video-2/pending-change`, {
      method: "DELETE",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { id: "video-2", pendingChange: null } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("staff can read the protected Videos administration list", async () => {
  const app = express();
  app.use("/api/v1/videos/admin", createEditorialVideoRouter({
    access: [(req, _res, next) => { req.user = { _id: "admin-1", role: "admin" }; next(); }],
    getService: () => ({
      async listAdmin({ page, limit }) {
        assert.equal(page, "2");
        assert.equal(limit, "10");
        return { totalResults: 11, totalPages: 2, page: 2, results: 1,
          data: [{ id: "video-11", status: "draft" }] };
      },
    }),
  }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/videos/admin?page=2&limit=10`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.data[0].id, "video-11");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("protected PATCH and review routes edit Reel metadata through the real application", async () => {
  let record = { id: "reel-1", revision: 0, kind: "reel", status: "published", authorId: "admin-1",
    title_en: "Original", title_ar: "أصلي", description_en: "", description_ar: "", activeAssetId: "asset-1" };
  const application = createEditorialVideoService({ repository: {
    create() {}, async get() { return { ...record }; },
    async replace(_id, expectedRevision, next) {
      if (record.revision !== expectedRevision) return null;
      record = { ...next, revision: expectedRevision + 1 }; return { ...record };
    },
  }, verifyYouTube: async () => { throw new Error("wrong provider"); }, verifyReelReady: async () => true });
  const app = express();
  app.use(express.json());
  app.use("/api/v1/videos/admin", createEditorialVideoRouter({
    access: [(req, _res, next) => { req.user = { _id: "admin-1", role: req.get("role") || roles.ADMIN,
      enabledControls: req.get("control") === "no" ? [] : [enabledControls.VIDEOS] }; next(); },
      allowedTo(roles.ADMIN, roles.SUPER_ADMIN), requireControl(enabledControls.VIDEOS)],
    getService: () => application,
  }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/videos/admin/reel-1`;
  try {
    for (const headers of [{ role: roles.USER }, { control: "no" }]) {
      assert.equal((await fetch(url, { method: "PATCH", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ title_en: "Forbidden" }) })).status, 403);
    }
    const edited = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title_en: "Proposed" }) });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).data.pendingChange.content.title_en, "Proposed");
    assert.equal(record.title_en, "Original");
    assert.equal((await fetch(`${url}/submit`, { method: "POST" })).status, 200);
    assert.equal((await fetch(`${url}/approve`, { method: "POST" })).status, 403);
    const approved = await fetch(`${url}/approve`, { method: "POST", headers: { role: roles.SUPER_ADMIN } });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).data.title_en, "Proposed");
    assert.equal(record.activeAssetId, "asset-1");
    assert.equal(record.status, "published");
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
