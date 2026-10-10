import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createEditorialVideoService } from "../../../../src/domains/videos/editorial/editorialVideo.service.js";
import { createEditorialVideoRepository } from "../../../../src/domains/videos/editorial/editorialVideo.repository.js";
import { replacementDatabase } from "../productVideos/fixtures/replacementDatabase.js";
import { createEditorialVideoRouter } from "../../../../src/domains/videos/editorial/editorialVideo.routes.js";
import { allowedTo, enabledControls as requireControl } from "../../../../src/domains/auth/auth.middleware.js";
import { roles, enabledControls } from "../../../../src/shared/constants/enums.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";

const superAdmin = { id: "507f1f77bcf86cd799439099", role: "superAdmin" };
const ids = ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012",
  "507f1f77bcf86cd799439013", "507f1f77bcf86cd799439014"];

function fixture(rows = ids.map((_id, index) => ({ _id, revision: 3,
  kind: index < 2 ? "youtube" : "reel", status: "published", position: index % 2,
  title_en: "Current title", publishedAt: new Date("2026-10-01T00:00:00Z"),
  ...(index < 2 ? { youtubeId: "dQw4w9WgXcQ" } : { activeAssetId: "active-asset", activeUploadSessionId: "active-session" }),
  pendingChange: { status: "in_review", authorId: "admin", content: { title_en: "Pending title" } },
}))) {
  const db = replacementDatabase({ placements: rows });
  const service = createEditorialVideoService({
    repository: createEditorialVideoRepository({ videos: db.placements, connection: db.connection, reelLifecycle: {} }),
    verifyYouTube: async () => assert.fail("ordering must not call YouTube"),
    enqueue: async () => assert.fail("ordering must not enqueue provider work"),
  });
  return service;
}

test("a super admin atomically reorders one published section without changing content or the other section", async () => {
  const service = fixture();
  const before = await Promise.all(ids.map((id) => service.getAdmin({ id, actor: superAdmin })));
  const result = await service.setPublicPositions({ actor: superAdmin, input: { kind: "youtube", items: [
    { videoId: ids[1], revision: 3, position: 0 }, { videoId: ids[0], revision: 3, position: 1 },
  ] } });
  assert.deepEqual(result, { kind: "youtube", items: [
    { videoId: ids[1], revision: 4, position: 0 }, { videoId: ids[0], revision: 4, position: 1 },
  ] });
  const after = await Promise.all(ids.map((id) => service.getAdmin({ id, actor: superAdmin })));
  assert.deepEqual(after, [
    { ...before[0], revision: 4, position: 1 }, { ...before[1], revision: 4, position: 0 }, before[2], before[3],
  ]);
});

test("a stale later entry rolls back the entire batch, including the first position and revision", async () => {
  const service = fixture();
  const before = await Promise.all(ids.map((id) => service.getAdmin({ id, actor: superAdmin })));
  await assert.rejects(service.setPublicPositions({ actor: superAdmin, input: { kind: "youtube", items: [
    { videoId: ids[0], revision: 3, position: 8 }, { videoId: ids[1], revision: 2, position: 9 },
  ] } }), (error) => error.statusCode === 409 && error.errors[0].code === "VIDEO_STATE_CONFLICT");
  assert.deepEqual(await Promise.all(ids.map((id) => service.getAdmin({ id, actor: superAdmin }))), before);
});

test("hidden, missing and other-section entries cannot partially commit public ordering", async () => {
  for (const kind of ["youtube", "reel"]) {
    for (const state of ["draft", "in_review", "approved", "unpublished", "other-section", "product", "missing"]) {
      const service = fixture([
        { _id: ids[0], kind, status: "published", position: 5, revision: 0 },
        ...(state === "missing" ? [] : [{ _id: ids[1],
          kind: state === "other-section" ? (kind === "youtube" ? "reel" : "youtube") : state === "product" ? "product" : kind,
          status: ["other-section", "product"].includes(state) ? "published" : state, position: 6, revision: 0 }]),
      ]);
      const before = await service.getAdmin({ id: ids[0], actor: superAdmin });
      await assert.rejects(service.setPublicPositions({ actor: superAdmin, input: { kind, items: [
        { videoId: ids[0], revision: 0, position: 0 }, { videoId: ids[1], revision: 0, position: 1 },
      ] } }), (error) => error.statusCode === 409 && error.errors[0].code === "VIDEO_STATE_CONFLICT");
      assert.deepEqual(await service.getAdmin({ id: ids[0], actor: superAdmin }), before);
    }
  }
});

test("clearing positions restores fallback without shifting omitted entries or rejecting equal positions", async () => {
  const service = fixture();
  const omitted = await service.getAdmin({ id: ids[3], actor: superAdmin });
  assert.deepEqual(await service.setPublicPositions({ actor: superAdmin, input: { kind: "reel", items: [
    { videoId: ids[2].toUpperCase(), revision: 3, position: null },
  ] } }), { kind: "reel", items: [{ videoId: ids[2], revision: 4, position: null }] });
  assert.deepEqual(await service.getAdmin({ id: ids[3], actor: superAdmin }), omitted);
  assert.deepEqual(await service.setPublicPositions({ actor: superAdmin, input: { kind: "reel", items: [
    { videoId: ids[2], revision: 4, position: 0 }, { videoId: ids[3], revision: 3, position: 0 },
  ] } }), { kind: "reel", items: [
    { videoId: ids[2], revision: 5, position: 0 }, { videoId: ids[3], revision: 4, position: 0 },
  ] });
});

test("overlapping batches with stale revisions have one winner and no interleaved partial order", async () => {
  const service = fixture();
  const orders = [
    [{ videoId: ids[0], revision: 3, position: 8 }, { videoId: ids[1], revision: 3, position: 9 }],
    [{ videoId: ids[1], revision: 3, position: 0 }, { videoId: ids[0], revision: 3, position: 1 }],
  ];
  const results = await Promise.allSettled(orders.map((items) => service.setPublicPositions({
    actor: superAdmin, input: { kind: "youtube", items },
  })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.errors[0].code, "VIDEO_STATE_CONFLICT");
  const winner = results.find((result) => result.status === "fulfilled").value;
  const actual = await Promise.all(winner.items.map(async ({ videoId }) => {
    const row = await service.getAdmin({ id: videoId, actor: superAdmin });
    return { videoId, revision: row.revision, position: row.position };
  }));
  assert.deepEqual(actual, winner.items);
});

test("only super admins may call bulk ordering, even when bypassing HTTP middleware", async () => {
  const service = fixture();
  for (const actor of [null, { role: roles.SUPER_ADMIN },
    { ...superAdmin, role: roles.ADMIN }, { ...superAdmin, role: roles.MODERATOR }, { ...superAdmin, role: roles.USER }]) {
    await assert.rejects(service.setPublicPositions({ actor, input: {} }),
      (error) => error.statusCode === 403 && error.errors[0].code === "VIDEO_FORBIDDEN");
  }
});

test("malformed, duplicate and oversized batches fail validation without changing any Video", async () => {
  const service = fixture();
  const item = { videoId: ids[0], revision: 3, position: 0 };
  const before = await service.getAdmin({ id: ids[0], actor: superAdmin });
  const invalid = [null, [], {}, { kind: "youtube" }, { kind: "youtube", items: [] },
    { kind: "product", items: [item] }, { kind: "all", items: [item] },
    { kind: "youtube", items: [item], status: "published" },
    { kind: "youtube", items: Array.from({ length: 101 }, () => item) },
    { kind: "youtube", items: [item, { ...item, videoId: ids[0].toUpperCase() }] },
    ...[null, [], {}, { ...item, videoId: 123 }, { ...item, videoId: "invalid" },
      { ...item, revision: undefined }, { ...item, revision: -1 }, { ...item, revision: 0.5 },
      { ...item, revision: "3" }, { ...item, revision: Number.MAX_SAFE_INTEGER },
      { ...item, position: undefined }, { ...item, position: -1 }, { ...item, position: 0.5 },
      { ...item, position: "0" }, { ...item, position: true }, { ...item, position: NaN },
      { ...item, position: Infinity }, { ...item, position: Number.MAX_SAFE_INTEGER + 1 },
      { ...item, activeAssetId: "cannot-write-media" }].map((entry) => ({ kind: "youtube", items: [entry] })),
  ];
  for (const input of invalid) await assert.rejects(service.setPublicPositions({ actor: superAdmin, input }),
    (error) => error.statusCode === 422 && error.errors[0].code === "VIDEO_INVALID_POSITION");
  assert.deepEqual(await service.getAdmin({ id: ids[0], actor: superAdmin }), before);
});

test("one bounded batch accepts 100 distinct entries and a safe maximum position", async () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ _id: index.toString(16).padStart(24, "0"),
    kind: "reel", status: "published", revision: 0 }));
  const service = fixture(rows);
  const result = await service.setPublicPositions({ actor: superAdmin, input: { kind: "reel",
    items: rows.map((row, index) => ({ videoId: row._id, revision: 0,
      position: index === 99 ? Number.MAX_SAFE_INTEGER : index })),
  } });
  assert.equal(result.items.length, 100);
  assert.deepEqual(result.items[99], { videoId: "000000000000000000000063", revision: 1, position: Number.MAX_SAFE_INTEGER });
});

test("the bulk-order HTTP route is super-admin-only and returns committed revisions for drag ordering", async () => {
  const service = fixture();
  const app = express(); app.use(express.json());
  app.use("/api/v1/videos/admin", createEditorialVideoRouter({
    access: [(req, _res, next) => { req.user = { _id: superAdmin.id,
      role: req.get("role") || roles.SUPER_ADMIN,
      enabledControls: req.get("control") === "no" ? [] : [enabledControls.VIDEOS] }; next(); },
    allowedTo(roles.SUPER_ADMIN, roles.ADMIN), requireControl(enabledControls.VIDEOS)],
    getService: () => service,
  }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/videos/admin/positions`;
  const input = { kind: "reel", items: [
    { videoId: ids[3], revision: 3, position: 0 }, { videoId: ids[2], revision: 3, position: 1 },
  ] };
  const request = (body, headers = {}) => fetch(url, { method: "PATCH",
    headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    for (const headers of [{ role: roles.ADMIN }, { role: roles.ADMIN, control: "no" },
      { role: roles.MODERATOR }, { role: roles.USER }]) {
      assert.equal((await request(input, headers)).status, 403);
    }
    assert.equal((await request({}, { role: roles.ADMIN })).status, 403);
    const invalid = await request({ ...input, items: [] });
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error[0].code, "VIDEO_INVALID_POSITION");
    assert.equal((await service.getAdmin({ id: ids[2], actor: superAdmin })).revision, 3);
    const response = await request(input, { control: "no" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { data: { kind: "reel", items: [
      { videoId: ids[3], revision: 4, position: 0 }, { videoId: ids[2], revision: 4, position: 1 },
    ] } });
    const replay = await request(input);
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).error[0].code, "VIDEO_STATE_CONFLICT");
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("the production bulk-order route requires authentication before validation or service construction", async () => {
  const app = express(); app.use(express.json());
  app.use("/api/v1/videos/admin", createEditorialVideoRouter({
    getService: () => assert.fail("unauthenticated ordering must not construct a service"),
  }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    for (const authorization of [undefined, "Bearer invalid-token"]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/videos/admin/positions`, {
        method: "PATCH", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
        body: "{}",
      });
      assert.equal(response.status, 401);
    }
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
