import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createEditorialVideoService } from "../../../../src/domains/videos/editorial/editorialVideo.service.js";
import { createEditorialVideoRepository } from "../../../../src/domains/videos/editorial/editorialVideo.repository.js";
import { createEditorialVideoRouter } from "../../../../src/domains/videos/editorial/editorialVideo.routes.js";
import { replacementDatabase } from "../productVideos/fixtures/replacementDatabase.js";
import { allowedTo, enabledControls as requireControl } from "../../../../src/domains/auth/auth.middleware.js";
import { roles, enabledControls } from "../../../../src/shared/constants/enums.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";
import { EditorialVideoModel } from "../../../../src/domains/videos/editorial/editorialVideo.model.js";

const admin = { id: "507f1f77bcf86cd799439090", role: roles.ADMIN };
const superAdmin = { id: "507f1f77bcf86cd799439099", role: roles.SUPER_ADMIN };
const ids = Array.from({ length: 8 }, (_, index) => (index + 1).toString(16).padStart(24, "0"));
const draft = (index, fields = {}) => ({ _id: ids[index], kind: "youtube", status: "draft",
  authorId: superAdmin.id, revision: 3, position: 9, title_en: "Current title", title_ar: "عنوان",
  youtubeId: "dQw4w9WgXcQ", createdAt: new Date(`2026-09-${20 + index}T00:00:00Z`),
  pendingChange: null, ...fields });

function fixture(rows = [draft(0)], { verifyYouTube = async () => assert.fail("arranging must not call YouTube"),
  verifyReelReady = async () => false } = {}) {
  const db = replacementDatabase({ placements: rows });
  const update = db.placements.findOneAndUpdate.bind(db.placements);
  db.placements.findOneAndUpdate = (...args) => {
    const result = update(...args);
    return { lean: () => result, then: (resolve, reject) => result.then(async (row) => {
      if (!row) return null;
      const document = new EditorialVideoModel(row);
      await document.validate();
      return document;
    }).then(resolve, reject) };
  };
  const value = (expression, row) => {
    if (typeof expression === "string" && expression.startsWith("$")) return row[expression.slice(1)];
    if (!expression || typeof expression !== "object") return expression;
    if (expression.$ifNull) return value(expression.$ifNull[0], row) ?? value(expression.$ifNull[1], row);
    if (expression.$ne) return value(expression.$ne[0], row) !== value(expression.$ne[1], row);
    if (expression.$cond) return value(expression.$cond[0], row) ? value(expression.$cond[1], row) : value(expression.$cond[2], row);
    throw new Error("Unsupported fake aggregate expression");
  };
  const pipeline = (rows, stages) => stages.reduce((result, stage) => {
    if (stage.$match) return result.filter((row) => Object.entries(stage.$match).every(([key, expected]) => row[key] === expected));
    if (stage.$addFields) return result.map((row) => ({ ...row,
      ...Object.fromEntries(Object.entries(stage.$addFields).map(([key, expression]) => [key, value(expression, row)])) }));
    if (stage.$sort) return [...result].sort((a, b) => {
      for (const [key, direction] of Object.entries(stage.$sort)) {
        if (a[key] < b[key]) return -direction;
        if (a[key] > b[key]) return direction;
      }
      return 0;
    });
    if (stage.$skip !== undefined) return result.slice(stage.$skip);
    if (stage.$limit) return result.slice(0, stage.$limit);
    if (stage.$count) return result.length ? [{ [stage.$count]: result.length }] : [];
    if (stage.$unset) return result.map(({ [stage.$unset]: removed, ...row }) => row);
    if (stage.$facet) return [Object.fromEntries(Object.entries(stage.$facet).map(([key, stages]) => [key, pipeline(result, stages)]))];
    throw new Error("Unsupported fake aggregate stage");
  }, rows);
  db.placements.aggregate = async (stages) => pipeline(await db.placements.find({}).lean(), stages);
  return createEditorialVideoService({
    repository: createEditorialVideoRepository({ videos: db.placements, connection: db.connection, reelLifecycle: {} }),
    verifyYouTube, verifyReelReady, enqueue: async () => assert.fail("arranging must not enqueue provider work"),
  });
}

test("an admin arranges and clears an editable draft without changing content or public position", async () => {
  const service = fixture();
  const before = await service.getAdmin({ id: ids[0], actor: admin });
  const positioned = await service.setDraftPosition({ id: ids[0], actor: admin,
    input: { draftPosition: 0, revision: 3 } });
  assert.deepEqual(positioned, { videoId: ids[0], draftPosition: 0, revision: 4 });
  assert.deepEqual(await service.getAdmin({ id: ids[0], actor: admin }), { ...before, draftPosition: 0, revision: 4 });
  const cleared = await service.setDraftPosition({ id: ids[0], actor: superAdmin,
    input: { draftPosition: null, revision: 4 } });
  assert.deepEqual(cleared, { videoId: ids[0], draftPosition: null, revision: 5 });
  assert.equal((await service.getAdmin({ id: ids[0], actor: admin })).position, 9);
});

test("the dashboard HTTP route arranges drafts under existing controls and lists their private order", async () => {
  const service = fixture([draft(0), draft(1)]);
  const app = express(); app.use(express.json());
  app.use("/api/v1/videos/admin", createEditorialVideoRouter({ getService: () => service,
    access: [(req, _res, next) => { req.user = { _id: admin.id, role: req.get("role") || roles.ADMIN,
      enabledControls: req.get("control") === "no" ? [] : [enabledControls.VIDEOS] }; next(); },
    allowedTo(roles.SUPER_ADMIN, roles.ADMIN), requireControl(enabledControls.VIDEOS)],
  }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/videos/admin`;
  const update = (body, headers = {}) => fetch(`${url}/${ids[0]}/draft-position`, { method: "PATCH",
    headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    for (const headers of [{ role: roles.MODERATOR }, { role: roles.USER }, { control: "no" }]) {
      assert.equal((await update({}, headers)).status, 403);
    }
    const malformed = await update({ draftPosition: 0 });
    assert.equal(malformed.status, 422);
    assert.equal((await malformed.json()).error[0].code, "VIDEO_INVALID_POSITION");
    const changed = await update({ draftPosition: 0, revision: 3 });
    assert.equal(changed.status, 200);
    assert.equal(changed.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await changed.json(), { data: { videoId: ids[0], draftPosition: 0, revision: 4 } });
    assert.equal((await update({ draftPosition: 1, revision: 3 })).status, 409);
    const list = await fetch(`${url}?kind=youtube&status=draft&limit=1`);
    assert.equal(list.status, 200);
    assert.equal(list.headers.get("cache-control"), "private, no-store");
    const result = await list.json();
    assert.equal(result.data.totalResults, 2);
    assert.deepEqual(result.data.data.map((row) => row.id), [ids[0]]);
    const invalidFilter = await fetch(`${url}?kind=all&status=draft`);
    assert.equal(invalidFilter.status, 422);
    assert.equal((await invalidFilter.json()).error[0].code, "VIDEO_INVALID_FILTER");
    const superUpdate = await update({ draftPosition: null, revision: 4 }, { role: roles.SUPER_ADMIN, control: "no" });
    assert.equal(superUpdate.status, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("filtered draft lists have independent positions, newest-first fallback and pagination", async () => {
  const service = fixture([
    draft(0, { draftPosition: 5 }), draft(1, { draftPosition: 0 }), draft(2), draft(3, { draftPosition: null }),
    draft(4, { kind: "reel", draftPosition: 0 }), draft(5, { status: "published", draftPosition: 0 }),
  ]);
  assert.deepEqual((await service.listAdmin({ actor: admin, kind: "youtube", status: "draft" })).data.map((row) => row.id),
    [ids[1], ids[0], ids[3], ids[2]]);
  const second = await service.listAdmin({ actor: admin, kind: "youtube", status: "draft", page: 2, limit: 2 });
  assert.equal(second.totalResults, 4); assert.equal(second.totalPages, 2);
  assert.deepEqual(second.data.map((row) => row.id), [ids[3], ids[2]]);
  assert.equal(second.data.some((row) => Object.hasOwn(row, "draftSortRank")), false);
  const reels = await service.listAdmin({ actor: admin, kind: "reel", status: "draft" });
  assert.deepEqual(reels.data.map((row) => row.id), [ids[4]]);
});

test("draft arrangement uses existing editing rules, not ownership restrictions or public-order authority", async () => {
  const service = fixture([
    draft(0, { kind: "reel", youtubeId: undefined, autoPublishWhenReady: true }),
    draft(1, { kind: "reel", youtubeId: undefined, authorId: superAdmin.id }),
    draft(2, { pendingChange: { authorId: admin.id, status: "draft", content: { kind: "youtube" } } }),
  ]);
  await assert.rejects(service.setDraftPosition({ id: ids[0], actor: admin, input: { draftPosition: 0, revision: 3 } }),
    (error) => error.statusCode === 403 && error.errors[0].code === "VIDEO_FORBIDDEN");
  assert.deepEqual(await service.setDraftPosition({ id: ids[0], actor: superAdmin, input: { draftPosition: 0, revision: 3 } }),
    { videoId: ids[0], draftPosition: 0, revision: 4 });
  assert.deepEqual(await service.setDraftPosition({ id: ids[1], actor: admin, input: { draftPosition: 0, revision: 3 } }),
    { videoId: ids[1], draftPosition: 0, revision: 4 });
  await assert.rejects(service.setDraftPosition({ id: ids[2], actor: admin, input: { draftPosition: 0, revision: 3 } }),
    (error) => error.statusCode === 409);
  await assert.rejects(service.setPublicPosition({ id: ids[1], actor: admin, input: { position: 0 } }),
    (error) => error.statusCode === 403);
});

test("only initial drafts may be arranged; pending proposals and hidden/public content are not targets", async () => {
  for (const status of ["in_review", "approved", "published", "unpublished"]) {
    const service = fixture([draft(0, { status })]);
    const before = await service.getAdmin({ id: ids[0], actor: admin });
    await assert.rejects(service.setDraftPosition({ id: ids[0], actor: admin, input: { draftPosition: 1, revision: 3 } }),
      (error) => error.statusCode === 409);
    assert.deepEqual(await service.getAdmin({ id: ids[0], actor: admin }), before);
  }
  const service = fixture([draft(0, { kind: "product" })]);
  await assert.rejects(service.setDraftPosition({ id: ids[0], actor: superAdmin, input: { draftPosition: 0, revision: 3 } }),
    (error) => error.statusCode === 409);
  for (const id of ["invalid", ids[7]]) await assert.rejects(service.setDraftPosition({ id, actor: admin,
    input: { draftPosition: 0, revision: 3 } }), (error) => error.statusCode === 404);
});

test("invalid inputs and actors cannot alter a draft or its revision", async () => {
  const service = fixture();
  const before = await service.getAdmin({ id: ids[0], actor: admin });
  for (const input of [null, [], {}, { draftPosition: 0 }, { revision: 3 },
    { draftPosition: 0, revision: 3, position: 0 }, { position: 0, revision: 3 },
    ...[-1, 0.5, "0", true, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]
      .map((draftPosition) => ({ draftPosition, revision: 3 })),
    ...[-1, 0.5, "3", true, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER]
      .map((revision) => ({ draftPosition: 0, revision })),
  ]) await assert.rejects(service.setDraftPosition({ id: ids[0], actor: admin, input }),
    (error) => error.statusCode === 422 && error.errors[0].code === "VIDEO_INVALID_POSITION");
  for (const actor of [null, { role: roles.ADMIN }, { ...admin, role: roles.USER }, { ...admin, role: roles.MODERATOR }]) {
    await assert.rejects(service.setDraftPosition({ id: ids[0], actor, input: {} }), (error) => error.statusCode === 403);
  }
  assert.deepEqual(await service.getAdmin({ id: ids[0], actor: admin }), before);
  const changed = await service.setDraftPosition({ id: ids[0], actor: admin,
    input: { draftPosition: Number.MAX_SAFE_INTEGER, revision: 3 } });
  assert.equal(changed.draftPosition, Number.MAX_SAFE_INTEGER);
});

test("stale and concurrent arrangement requests cannot overwrite the winning order", async () => {
  const service = fixture();
  const results = await Promise.allSettled([0, 1].map((draftPosition) => service.setDraftPosition({ id: ids[0], actor: admin,
    input: { draftPosition, revision: 3 } })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.errors[0].code, "VIDEO_STATE_CONFLICT");
  const winner = results.find((result) => result.status === "fulfilled").value;
  const actual = await service.getAdmin({ id: ids[0], actor: admin });
  assert.equal(actual.revision, 4); assert.equal(actual.draftPosition, winner.draftPosition);
  await assert.rejects(service.setDraftPosition({ id: ids[0], actor: admin, input: { draftPosition: null, revision: 3 } }),
    (error) => error.statusCode === 409);
});

test("review and publication never promote draft arrangement into public ordering", async () => {
  for (const kind of ["youtube", "reel"]) {
    const service = fixture([draft(0, { kind, position: null, authorId: admin.id,
      ...(kind === "reel" ? { youtubeId: undefined, activeAssetId: ids[6] } : {}) })],
    { verifyYouTube: async () => {}, verifyReelReady: async () => true });
    await service.setDraftPosition({ id: ids[0], actor: admin, input: { draftPosition: 2, revision: 3 } });
    await service.submit({ id: ids[0], actor: admin });
    await service.approve({ id: ids[0], actor: superAdmin });
    const published = await service.publish({ id: ids[0], actor: superAdmin });
    assert.equal(published.status, "published");
    assert.equal(published.position, null); assert.equal(published.draftPosition, 2);
    assert.equal((await service.listAdmin({ actor: admin, kind, status: "draft" })).totalResults, 0);
  }
});

test("unfiltered admin listing keeps its existing newest-first order and filters fail closed", async () => {
  const service = fixture([draft(0, { draftPosition: 0 }), draft(1, { status: "published" })]);
  assert.deepEqual((await service.listAdmin({ actor: admin })).data.map((row) => row.id), [ids[1], ids[0]]);
  const page = await service.listAdmin({ actor: admin, page: 2, limit: 1 });
  assert.equal(page.totalResults, 2); assert.deepEqual(page.data.map((row) => row.id), [ids[0]]);
  for (const filter of [{ kind: "youtube" }, { status: "draft" }, { kind: "all", status: "draft" },
    { kind: "product", status: "draft" }, { kind: ["youtube"], status: "draft" }, { kind: "youtube", status: ["draft"] },
    { kind: "youtube", status: "published" }]) {
    await assert.rejects(service.listAdmin({ actor: admin, ...filter }),
      (error) => error.statusCode === 422 && error.errors[0].code === "VIDEO_INVALID_FILTER");
  }
});

test("the production draft-position route requires authentication before validation or service construction", async () => {
  const app = express(); app.use(express.json());
  app.use("/api/v1/videos/admin", createEditorialVideoRouter({
    getService: () => assert.fail("unauthenticated access must not construct a service"),
  }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/videos/admin/${ids[0]}/draft-position`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 401);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("equal draft positions use newest creation then ID, and an empty draft section is paginated safely", async () => {
  const createdAt = new Date("2026-10-01T00:00:00Z");
  const service = fixture([draft(0, { draftPosition: 0, createdAt }), draft(1, { draftPosition: 0, createdAt }),
    draft(2, { draftPosition: 0, createdAt: new Date("2026-09-30T00:00:00Z") })]);
  assert.deepEqual((await service.listAdmin({ actor: admin, kind: "youtube", status: "draft" })).data.map((row) => row.id),
    [ids[1], ids[0], ids[2]]);
  assert.deepEqual(await service.listAdmin({ actor: admin, kind: "reel", status: "draft", page: 2, limit: 1 }),
    { totalResults: 0, totalPages: 1, page: 2, results: 0, data: [] });
});

test("draft arrangement invalidates an in-flight submission instead of allowing a stale lifecycle write", async () => {
  let signalStarted, release;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const paused = new Promise((resolve) => { release = resolve; });
  const service = fixture([draft(0, { authorId: admin.id })], {
    verifyYouTube: async () => { signalStarted(); await paused; },
  });
  const submitting = service.submit({ id: ids[0], actor: admin });
  await started;
  await service.setDraftPosition({ id: ids[0], actor: admin, input: { draftPosition: 2, revision: 3 } });
  release();
  await assert.rejects(submitting, (error) => error.statusCode === 409 && error.errors[0].code === "VIDEO_STATE_CONFLICT");
  const actual = await service.getAdmin({ id: ids[0], actor: admin });
  assert.equal(actual.status, "draft"); assert.equal(actual.revision, 4); assert.equal(actual.draftPosition, 2);
});
