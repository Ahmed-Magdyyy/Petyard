import assert from "node:assert/strict";
import test from "node:test";
import { createEditorialVideoService } from "../../../../src/domains/videos/editorial/editorialVideo.service.js";
import { createEditorialVideoRepository } from "../../../../src/domains/videos/editorial/editorialVideo.repository.js";
import { replacementDatabase } from "../productVideos/fixtures/replacementDatabase.js";
import { createReelLifecycleRepository } from "../../../../src/domains/videos/reels/reelLifecycle.repository.js";
import { createReelLifecycle } from "../../../../src/domains/videos/reels/reelLifecycle.service.js";
import { recordVideoProviderOperation } from "../../../../src/domains/videos/provider/videoProviderOperation.service.js";
import { createReelUploadRepository } from "../../../../src/domains/videos/reels/reelUpload.repository.js";
import { createReelUploadService } from "../../../../src/domains/videos/reels/reelUpload.service.js";
import express from "express";
import { createEditorialVideoRouter } from "../../../../src/domains/videos/editorial/editorialVideo.routes.js";
import { allowedTo, enabledControls as requireControl } from "../../../../src/domains/auth/auth.middleware.js";
import { roles, enabledControls } from "../../../../src/shared/constants/enums.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";
import { EditorialVideoModel } from "../../../../src/domains/videos/editorial/editorialVideo.model.js";

const first = "507f1f77bcf86cd799439011";
const second = "507f1f77bcf86cd799439012";
const admin = { id: "507f1f77bcf86cd799439099", role: "admin" };
const superAdmin = { id: "507f1f77bcf86cd799439098", role: "superAdmin" };
const input = { youtubeUrl: "https://youtu.be/dQw4w9WgXcQ", title_en: "Care", title_ar: "رعاية" };

function fixture({ hydrateTransactionalReads = false } = {}) {
  const db = replacementDatabase({ products: [{ _id: first, isActive: true }, { _id: second, isActive: true }] });
  const videos = { ...db.placements,
    findOne(filter) {
      const query = db.placements.findOne(filter);
      return hydrateTransactionalReads ? { ...query, async session(session) {
        const row = await query.session(session);
        return row ? new EditorialVideoModel(row) : null;
      } } : query;
    },
    async create(records) {
    return db.placements.create(records.map(record => ({ revision: 0, ...record })));
  } };
  const lifecycleRepository = createReelLifecycleRepository({ videos, products: db.products,
    assertAuthority: async () => {},
    assets: db.assets, sessions: db.sessions, connection: db.connection, libraryId: "754739",
    attempts: db.attempts, recordOperation: input => recordVideoProviderOperation({ ...input, model: db.operations }) });
  const repository = createEditorialVideoRepository({ videos, products: db.products,
    assertAuthority: async () => {},
    connection: db.connection, reelLifecycle: lifecycleRepository });
  const service = createEditorialVideoService({ repository, verifyYouTube: async () => {},
    verifyReelReady: async () => true, verifyReelReplacementReady: async () => true,
    enqueue: async () => {} });
  return { service, db, lifecycleRepository };
}

async function automaticReel(options) {
  const setup = fixture(options);
  const video = await setup.service.createReelDraft({ actor: superAdmin,
    input: { kind: "reel", title_en: "Care", title_ar: "رعاية", productIds: [first] } });
  const [asset] = await setup.db.assets.create([{ ownerType: "reel", ownerId: video.id,
    libraryId: "754739", providerGuid: "guid", technicalState: "ready", providerStatus: 4,
    readyAt: new Date(), durationSeconds: 20, width: 720, height: 1280, availableResolutions: ["720p"] }]);
  const [session] = await setup.db.sessions.create([{ videoId: video.id, assetId: asset._id,
    status: "issued", purpose: "initial", actorId: superAdmin.id }]);
  await setup.db.placements.updateOne({ _id: video.id }, { $set: {
    activeAssetId: asset._id, activeUploadSessionId: session._id } });
  return { ...setup, video, asset, session };
}

test("editorial create retains ordered product links and omission creates no links", async () => {
  const { service } = fixture();
  const linked = await service.createYouTubeVideo({ actor: superAdmin, input: { ...input, productIds: [second, first] } });
  assert.equal(linked.status, "published");
  assert.deepEqual((await service.getAdmin({ id: linked.id, actor: superAdmin })).productIds, [second, first]);
  const legacy = await service.createReelDraft({ actor: admin, input: { kind: "reel", title_en: "Care", title_ar: "رعاية" } });
  assert.deepEqual(legacy.productIds, []);
});

test("pending link edits preserve active CTAs, retain omitted links and apply only on approval", async () => {
  const { service } = fixture();
  const video = await service.createYouTubeVideo({ actor: superAdmin, input: { ...input, productIds: [first] } });
  const pending = await service.editVideo({ id: video.id, actor: admin, input: { productIds: [second] } });
  assert.deepEqual(pending.productIds, [first]);
  assert.deepEqual(pending.pendingChange.content.productIds, [second]);
  const edited = await service.editVideo({ id: video.id, actor: admin, input: { title_en: "Proposed title" } });
  assert.deepEqual(edited.pendingChange.content.productIds, [second]);
  await service.submit({ id: video.id, actor: admin });
  const approved = await service.approve({ id: video.id, actor: superAdmin });
  assert.equal(approved.status, "published");
  assert.deepEqual(approved.productIds, [second]);
  assert.equal(approved.pendingChange, null);
  const cleared = await service.editVideo({ id: video.id, actor: superAdmin, input: { productIds: [] } });
  assert.deepEqual(cleared.productIds, []);
});

test("publication and proposal approval recheck active product eligibility", async () => {
  const { service, db } = fixture();
  const video = await service.createYouTubeVideo({ actor: admin, input: { ...input, productIds: [first] } });
  await service.submit({ id: video.id, actor: admin });
  await service.approve({ id: video.id, actor: superAdmin });
  await db.products.updateOne({ _id: first }, { $set: { isActive: false } });
  await assert.rejects(service.publish({ id: video.id, actor: superAdmin }),
    error => error.statusCode === 422 && error.errors[0].code === "VIDEO_INVALID_PRODUCT_IDS");
  assert.equal((await service.getAdmin({ id: video.id, actor: admin })).status, "approved");
});

test("automatic Reel publication rechecks product eligibility after the HLS probe", async () => {
  const { db, lifecycleRepository, service, video, asset } = await automaticReel();
  const lifecycle = createReelLifecycle({ repository: lifecycleRepository, verifyPreviewReady: async () => {
    await db.products.updateOne({ _id: first }, { $set: { isActive: false } });
    return true;
  } });
  await assert.rejects(lifecycle.handleVerifiedAsset(asset), error => error.statusCode === 422);
  assert.equal((await service.getAdmin({ id: video.id, actor: superAdmin })).status, "draft");
});

test("product links reject invalid duplicate missing and inactive references without changing the video", async () => {
  const { service, db } = fixture();
  const video = await service.createReelDraft({ actor: admin,
    input: { kind: "reel", title_en: "Care", title_ar: "رعاية", productIds: [first] } });
  await db.products.updateOne({ _id: second }, { $set: { isActive: false } });
  for (const productIds of [null, "not-an-array", [null], [7], ["invalid"], [first, first.toUpperCase()],
    [second], ["507f1f77bcf86cd799439017"], Array(51).fill(first)]) {
    await assert.rejects(service.editVideo({ id: video.id, actor: admin, input: { productIds } }),
      error => error.statusCode === 422 && error.errors[0].code === "VIDEO_INVALID_PRODUCT_IDS" &&
        error.errors[0].field.startsWith("productIds"));
    assert.deepEqual((await service.getAdmin({ id: video.id, actor: admin })).productIds, [first]);
  }
  const retained = await service.editVideo({ id: video.id, actor: admin, input: { title_en: "Edited" } });
  assert.deepEqual(retained.productIds, [first]);
  assert.deepEqual((await service.editVideo({ id: video.id, actor: admin, input: { productIds: [] } })).productIds, []);
});

test("all fifty eligible links retain selection order and canonicalize ID case", async () => {
  const { service, db } = fixture();
  const ids = Array.from({ length: 50 }, (_value, index) => (1000 + index).toString(16).padStart(24, "0")).reverse();
  await db.products.create(ids.map(_id => ({ _id, isActive: true })));
  const created = await service.createYouTubeVideo({ actor: superAdmin,
    input: { ...input, productIds: ids.map(id => id.toUpperCase()) } });
  assert.deepEqual(created.productIds, ids);
});

test("a rejected or cancelled proposal never changes current links", async () => {
  const { service, db } = fixture();
  const video = await service.createYouTubeVideo({ actor: superAdmin, input: { ...input, productIds: [first] } });
  await service.editVideo({ id: video.id, actor: admin, input: { productIds: [second] } });
  await service.submit({ id: video.id, actor: admin });
  await db.products.updateOne({ _id: second }, { $set: { isActive: false } });
  await assert.rejects(service.approve({ id: video.id, actor: superAdmin }), error => error.statusCode === 422);
  const rejected = await service.reject({ id: video.id, actor: superAdmin, reason: "Unavailable product" });
  assert.deepEqual(rejected.productIds, [first]);
  assert.deepEqual(rejected.pendingChange.content.productIds, [second]);
  const cancelled = await service.cancelPendingChange({ id: video.id, actor: admin });
  assert.equal(cancelled.pendingChange, null);
  assert.deepEqual(cancelled.productIds, [first]);
  await db.products.updateOne({ _id: first }, { $set: { isActive: false } });
  assert.equal((await service.unpublish({ id: video.id, actor: superAdmin })).status, "unpublished");
});

test("editing links during automatic HLS verification fences the old publication attempt", async () => {
  const { lifecycleRepository, service, video, asset } = await automaticReel();
  const lifecycle = createReelLifecycle({ repository: lifecycleRepository, verifyPreviewReady: async () => {
    await service.editVideo({ id: video.id, actor: superAdmin, input: { productIds: [second] } });
    return true;
  } });
  assert.deepEqual(await lifecycle.handleVerifiedAsset(asset), { status: "stale" });
  assert.equal((await service.getAdmin({ id: video.id, actor: superAdmin })).status, "draft");
});

test("reviewed and automatic Reel replacements apply their own links with the new media", async () => {
  for (const automatic of [false, true]) {
    const { db, lifecycleRepository, service, video, asset } = await automaticReel({ hydrateTransactionalReads: true });
    const actor = automatic ? superAdmin : admin;
    const [nextAsset] = await db.assets.create([{ ...asset, _id: "507f1f77bcf86cd799439050", providerGuid: "replacement-guid" }]);
    const [nextSession] = await db.sessions.create([{ videoId: video.id, assetId: nextAsset._id,
      previousAssetId: asset._id, purpose: "replacement", actorId: actor.id,
      status: "issued", autoApplyWhenReady: automatic, safeFilename: "replacement.mp4" }]);
    await db.placements.updateOne({ _id: video.id }, { $set: { status: "published", pendingChange: {
      authorId: actor.id, status: automatic ? "draft" : "in_review", autoApplyWhenReady: automatic,
      assetId: nextAsset._id, uploadSessionId: nextSession._id,
      content: { kind: "reel", title_en: "Replacement", title_ar: "بديل",
        description_en: "", description_ar: "", productIds: [second] }, createdAt: new Date(), updatedAt: new Date() } } });
    const apply = () => automatic
      ? createReelLifecycle({ repository: lifecycleRepository, verifyPreviewReady: async () => true,
        enqueue: async () => {} }).handleVerifiedAsset(nextAsset)
      : service.approve({ id: video.id, actor: superAdmin });
    await db.products.updateOne({ _id: second }, { $set: { isActive: false } });
    await assert.rejects(apply(), error => error.statusCode === 422);
    const preserved = await service.getAdmin({ id: video.id, actor: superAdmin });
    assert.deepEqual(preserved.productIds, [first]);
    assert.equal(preserved.activeAssetId, asset._id);
    await db.products.updateOne({ _id: second }, { $set: { isActive: true } });
    await apply();
    const switched = await service.getAdmin({ id: video.id, actor: superAdmin });
    assert.deepEqual(switched.productIds, [second]);
    assert.equal(switched.activeAssetId, nextAsset._id);
    assert.equal(switched.pendingChange, null);
  }
});

test("starting a replacement copies active links into its proposal", async () => {
  const { db, service, video } = await automaticReel();
  await db.placements.updateOne({ _id: video.id }, { $set: { status: "published" } });
  const uploads = createReelUploadService({ repository: createReelUploadRepository({
    videos: db.placements, assets: db.assets, sessions: db.sessions, connection: db.connection,
    libraryId: "754739", attempts: db.attempts,
    recordOperation: input => recordVideoProviderOperation({ ...input, model: db.operations }),
  }), provider: {
    async createVideo() { return { guid: "new-guid" }; },
    async createTusUpload({ expiresAt }) { return { uploadUrl: "https://video.bunnycdn.com/tusupload/new-resource", resourceExpiresAt: expiresAt }; },
    createTusUploadAuthorization({ expiresAt }) { return { expiresAt, headers: {} }; },
  }, enqueue: async () => {} });
  await uploads.createSession({ videoId: video.id, actor: superAdmin, purpose: "replacement",
    idempotencyKey: "replacement-links-key", file: { filename: "next.mp4", mimeType: "video/mp4", sizeBytes: 1000 } });
  const current = await service.getAdmin({ id: video.id, actor: superAdmin });
  assert.deepEqual(current.productIds, [first]);
  assert.deepEqual(current.pendingChange.content.productIds, [first]);
});

test("existing editorial HTTP create edit and detail routes carry the additive links and safe field errors", async () => {
  const { service } = fixture();
  const app = express();
  app.use(express.json());
  app.use("/api/v1/videos/admin", createEditorialVideoRouter({
    access: [(req, _res, next) => { req.user = { _id: admin.id, role: roles.ADMIN,
      enabledControls: [enabledControls.VIDEOS] }; next(); },
    allowedTo(roles.ADMIN, roles.SUPER_ADMIN), requireControl(enabledControls.VIDEOS)],
    getService: () => service,
  }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/v1/videos/admin`;
    const write = (path, method, body) => fetch(`${url}${path}`, { method,
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await write("", "POST", { ...input, productIds: [second, first] });
    assert.equal(created.status, 201);
    const video = (await created.json()).data;
    assert.deepEqual(video.productIds, [second, first]);
    const invalid = await write(`/${video.id}`, "PATCH", { productIds: [first, first.toUpperCase()] });
    assert.equal(invalid.status, 422);
    const error = await invalid.json();
    assert.equal(error.error[0].code, "VIDEO_INVALID_PRODUCT_IDS");
    assert.equal(error.error[0].field, "productIds[1]");
    assert.deepEqual((await (await fetch(`${url}/${video.id}`)).json()).data.productIds, [second, first]);
    assert.equal((await write(`/${video.id}`, "PATCH", { productIds: [] })).status, 200);
    assert.deepEqual((await (await fetch(`${url}/${video.id}`)).json()).data.productIds, []);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
