import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { createEditorialVideoService } from "../../../../src/domains/videos/editorial/editorialVideo.service.js";
import { EditorialVideoModel } from "../../../../src/domains/videos/editorial/editorialVideo.model.js";
import { createEditorialVideoRouter } from "../../../../src/domains/videos/editorial/editorialVideo.routes.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";
import { createPublicVideoService } from "../../../../src/domains/videos/public/publicVideo.service.js";

const input = { kind: "reel", title_en: "Puppy care", title_ar: "رعاية الجرو" };

function fixture({ ready = false, initial } = {}) {
  let record = initial;
  let verified = 0;
  const app = createEditorialVideoService({
    repository: {
      async cancelReelPendingChange() {
        throw new Error("Cleanup persistence failed");
      },
      async create(value) {
        record = { ...value, id: "reel-1", revision: 0 };
        return { ...record };
      },
      async get() { return record ? { ...record } : null; },
      async replace(_id, expectedRevision, next) {
        if (expectedRevision !== record.revision) return null;
        record = { ...next, revision: expectedRevision + 1 };
        return { ...record };
      },
    },
    verifyYouTube: async () => { throw new Error("Reels must not use YouTube verification"); },
    verifyReelReady: async (reel) => {
      verified += 1;
      assert.equal(reel.activeAssetId, "asset-1");
      return ready;
    },
  });
  return { app, attachAsset() { record.activeAssetId = "asset-1"; },
    readRecord() { return { ...record }; },
    changeRecord(patch) { record = { ...record, ...patch }; },
    verificationCount() { return verified; } };
}

test("a Reel is a separate metadata draft, not a published YouTube Video", async () => {
  const { app } = fixture();
  const reel = await app.createReelDraft({ actor: { id: "super-1", role: "superAdmin" }, input });
  assert.equal(reel.kind, "reel");
  assert.equal(reel.status, "draft");
  assert.equal(reel.publishedAt, null);
  assert.equal(reel.youtubeId, undefined);
  assert.equal(reel.activeAssetId, undefined);
  assert.equal(reel.autoPublishWhenReady, true);
  assert.equal(reel.title_en, "Puppy care");
});

test("admin-authored Reel does not receive automatic publication authority", async () => {
  const { app } = fixture();
  const reel = await app.createReelDraft({ actor: { id: "admin-1", role: "admin" }, input });
  assert.equal(reel.autoPublishWhenReady, false);
});

test("Reel draft rejects unexpected media or product fields", async () => {
  const { app } = fixture();
  await assert.rejects(app.createReelDraft({ actor: { id: "admin-1", role: "admin" },
    input: { ...input, youtubeUrl: "https://youtu.be/dQw4w9WgXcQ" } }),
  (error) => error.statusCode === 422);
  await assert.rejects(app.createReelDraft({ actor: { id: "admin-1", role: "admin" },
    input: { ...input, productId: "product-1" } }),
  (error) => error.statusCode === 422);
});

test("Reel review and publication fail closed without a verified ready asset", async () => {
  const { app, attachAsset, verificationCount } = fixture();
  await app.createReelDraft({ actor: { id: "admin-1", role: "admin" }, input });
  await assert.rejects(app.submit({ id: "reel-1", actor: { id: "admin-1", role: "admin" } }),
    (error) => error.statusCode === 409 && error.errors?.[0]?.code === "VIDEO_ASSET_NOT_READY");
  assert.equal(verificationCount(), 0);
  attachAsset();
  await assert.rejects(app.submit({ id: "reel-1", actor: { id: "admin-1", role: "admin" } }),
    (error) => error.statusCode === 409);
  assert.equal(verificationCount(), 1);
});

test("a future ready-asset adapter can pass Reel through separate review and publish", async () => {
  const { app, attachAsset } = fixture({ ready: true });
  await app.createReelDraft({ actor: { id: "admin-1", role: "admin" }, input });
  attachAsset();
  const submitted = await app.submit({ id: "reel-1", actor: { id: "admin-1", role: "admin" } });
  assert.equal(submitted.status, "in_review");
  const approved = await app.approve({ id: "reel-1", actor: { id: "super-1", role: "superAdmin" } });
  assert.equal(approved.status, "approved");
  const published = await app.publish({ id: "reel-1", actor: { id: "super-1", role: "superAdmin" } });
  assert.equal(published.status, "published");
});

test("Video schema accepts a Reel without a YouTube ID while keeping YouTube ID required", async () => {
  const reel = new EditorialVideoModel({ kind: "reel", status: "draft",
    authorId: "507f1f77bcf86cd799439011", title_en: "Puppy care", title_ar: "رعاية الجرو" });
  assert.equal(reel.validateSync(), undefined);
  const youtube = new EditorialVideoModel({ kind: "youtube", status: "draft",
    authorId: "507f1f77bcf86cd799439011", title_en: "Puppy care", title_ar: "رعاية الجرو" });
  assert.ok(youtube.validateSync()?.errors?.youtubeId);
  const mixed = new EditorialVideoModel({ kind: "reel", status: "draft",
    authorId: "507f1f77bcf86cd799439011", title_en: "Puppy care", title_ar: "رعاية الجرو",
    youtubeId: "dQw4w9WgXcQ" });
  await assert.rejects(mixed.validate(), /Reels cannot reference YouTube media/);
});

test("protected editorial create route dispatches Reel metadata to the Reel application seam", async () => {
  const serverApp = express();
  serverApp.use(express.json());
  serverApp.use("/api/v1/videos/admin", createEditorialVideoRouter({
    access: [(req, _res, next) => { req.user = { _id: "admin-1", role: "admin" }; next(); }],
    getService: () => ({
      async createReelDraft({ actor, input: received }) {
        assert.equal(actor.id, "admin-1");
        assert.deepEqual(received, input);
        return { id: "reel-1", kind: "reel", status: "draft" };
      },
    }),
  }));
  serverApp.use(globalError);
  const server = serverApp.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/videos/admin`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { data: { id: "reel-1", kind: "reel", status: "draft" } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

const admin = { id: "admin-1", role: "admin" };
const superAdmin = { id: "super-1", role: "superAdmin" };
const publishedReel = { id: "reel-1", revision: 0, kind: "reel", status: "published",
  authorId: admin.id, title_en: "Original", title_ar: "أصلي", description_en: "", description_ar: "",
  activeAssetId: "asset-1", activeUploadSessionId: "session-1", autoPublishWhenReady: false,
  publishedAt: new Date("2026-09-28T12:00:00Z"), pendingChange: null };

test("Reel metadata remains editable during initial upload without changing assets or bypassing review", async () => {
  const f = fixture({ initial: { ...publishedReel, status: "draft", activeAssetId: undefined } });
  const result = await f.app.editVideo({ id: "reel-1", actor: admin,
    input: { title_en: " Updated ", description_ar: "وصف" } });
  assert.equal(result.title_en, "Updated");
  assert.equal(result.description_ar, "وصف");
  assert.equal(result.status, "draft");
  assert.equal(result.activeAssetId, undefined);
  assert.equal(result.activeUploadSessionId, "session-1");
  assert.equal(result.autoPublishWhenReady, false);
  assert.equal(f.verificationCount(), 0);
});

test("published Reel metadata edits stay isolated until preview-verified super-admin approval", async () => {
  const f = fixture({ ready: true, initial: publishedReel });
  const publicApp = createPublicVideoService({ isEnabled: () => true, repository: {
    listYouTube() {}, listReels() {}, listProducts() {}, listMixed() {}, listSaved() {}, save() {}, unsave() {},
    async savedIds() { return new Set(); },
    async getPublished() { return { ...f.readRecord(), asset: { durationSeconds: 2, width: 640, height: 360 } }; },
  } });
  const proposed = await f.app.editVideo({ id: "reel-1", actor: admin, input: { title_en: "Proposed" } });
  assert.equal(proposed.title_en, "Original");
  assert.equal(proposed.pendingChange.content.kind, "reel");
  const before = await publicApp.getVideo({ id: "reel-1" });
  assert.equal(before.title, "Original");
  assert.ok(!JSON.stringify(before).includes("Proposed"));
  assert.equal((await f.app.submit({ id: "reel-1", actor: admin })).pendingChange.status, "in_review");
  const approved = await f.app.approve({ id: "reel-1", actor: superAdmin });
  assert.equal(approved.status, "published");
  assert.equal(approved.title_en, "Proposed");
  assert.equal(approved.activeAssetId, "asset-1");
  assert.equal(approved.pendingChange, null);
  assert.equal((await publicApp.getVideo({ id: "reel-1" })).title, "Proposed");
  assert.equal(f.verificationCount(), 2);
});

test("Reel metadata rejection, revision, resubmission and cancellation preserve the current asset", async () => {
  const f = fixture({ ready: true, initial: publishedReel });
  await f.app.editVideo({ id: "reel-1", actor: admin, input: { title_en: "Proposed" } });
  await f.app.submit({ id: "reel-1", actor: admin });
  const rejected = await f.app.reject({ id: "reel-1", actor: superAdmin, reason: "Revise the title" });
  assert.equal(rejected.title_en, "Original");
  assert.equal(rejected.pendingChange.status, "rejected");
  const revised = await f.app.editVideo({ id: "reel-1", actor: admin, input: { description_en: "Revised" } });
  assert.equal(revised.pendingChange.content.title_en, "Proposed");
  assert.equal(revised.pendingChange.content.description_en, "Revised");
  assert.equal(revised.pendingChange.status, "draft");
  await f.app.submit({ id: "reel-1", actor: admin });
  const cancelled = await f.app.cancelPendingChange({ id: "reel-1", actor: admin });
  assert.equal(cancelled.title_en, "Original");
  assert.equal(cancelled.activeAssetId, "asset-1");
  assert.equal(cancelled.pendingChange, null);
});

test("approving Reel metadata after unpublish never republishes it", async () => {
  const f = fixture({ ready: true, initial: publishedReel });
  await f.app.editVideo({ id: "reel-1", actor: admin, input: { title_en: "Proposed" } });
  await f.app.submit({ id: "reel-1", actor: admin });
  await f.app.unpublish({ id: "reel-1", actor: superAdmin });
  const approved = await f.app.approve({ id: "reel-1", actor: superAdmin });
  assert.equal(approved.status, "unpublished");
  assert.equal(approved.title_en, "Proposed");
  assert.equal(approved.publishedAt.getTime(), publishedReel.publishedAt.getTime());
});

test("Reel pending metadata submission and approval fail closed when playback is not ready", async () => {
  const f = fixture({ initial: publishedReel });
  await f.app.editVideo({ id: "reel-1", actor: admin, input: { title_en: "Proposed" } });
  await assert.rejects(f.app.submit({ id: "reel-1", actor: admin }),
    (error) => error.errors[0].code === "VIDEO_ASSET_NOT_READY");
  const record = f.readRecord();
  f.changeRecord({ pendingChange: { ...record.pendingChange, status: "in_review" } });
  await assert.rejects(f.app.approve({ id: "reel-1", actor: superAdmin }),
    (error) => error.errors[0].code === "VIDEO_ASSET_NOT_READY");
  assert.equal(f.readRecord().title_en, "Original");
  assert.equal(f.readRecord().pendingChange.status, "in_review");
});

test("Reel metadata enforces one proposal/author, review locks, and super-admin draft bypass protection", async () => {
  const f = fixture({ initial: publishedReel });
  await f.app.editVideo({ id: "reel-1", actor: admin, input: { title_en: "Proposed" } });
  const other = { id: "admin-2", role: "admin" };
  await assert.rejects(f.app.editVideo({ id: "reel-1", actor: other, input: { title_en: "Competing" } }),
    (error) => error.statusCode === 409);
  await assert.rejects(f.app.submit({ id: "reel-1", actor: other }), (error) => error.statusCode === 403);
  await assert.rejects(f.app.cancelPendingChange({ id: "reel-1", actor: other }), (error) => error.statusCode === 403);
  await assert.rejects(f.app.editVideo({ id: "reel-1", actor: superAdmin, input: { title_en: "Overwrite" } }),
    (error) => error.statusCode === 409);
  await f.app.cancelPendingChange({ id: "reel-1", actor: superAdmin });
  f.changeRecord({ status: "in_review" });
  await assert.rejects(f.app.editVideo({ id: "reel-1", actor: admin, input: { title_en: "Locked" } }),
    (error) => error.statusCode === 409);
  f.changeRecord({ status: "draft", autoPublishWhenReady: true });
  await assert.rejects(f.app.editVideo({ id: "reel-1", actor: admin, input: { title_en: "Bypass" } }),
    (error) => error.statusCode === 403);
  assert.equal((await f.app.editVideo({ id: "reel-1", actor: superAdmin,
    input: { title_en: "Super edit" } })).title_en, "Super edit");
});

test("super-admin Reel metadata updates directly; unsupported media and invalid titles are rejected", async () => {
  const f = fixture({ initial: publishedReel });
  const result = await f.app.editVideo({ id: "reel-1", actor: superAdmin, input: { title_ar: "جديد" } });
  assert.equal(result.title_ar, "جديد");
  assert.equal(result.pendingChange, null);
  assert.equal(f.verificationCount(), 0);
  for (const bad of [{}, { title_en: null }, { title_en: " " }, { description_en: "x".repeat(2001) },
    { youtubeUrl: "https://youtu.be/dQw4w9WgXcQ" }, { activeAssetId: "other" }, { kind: "youtube" },
    { status: "published" }, { cover: "injected" }]) {
    await assert.rejects(f.app.editVideo({ id: "reel-1", actor: superAdmin, input: bad }),
      (error) => error.statusCode === 422);
  }
  await assert.rejects(f.app.editVideo({ id: "reel-1", actor: { id: "user-1", role: "user" },
    input: { title_en: "Forbidden" } }), (error) => error.statusCode === 403);
});

test("Reel metadata approval cannot overwrite a concurrent unpublish", async () => {
  let record = { ...publishedReel, pendingChange: { authorId: admin.id, status: "in_review",
    content: { kind: "reel", title_en: "Proposed", title_ar: "جديد", description_en: "", description_ar: "" } } };
  const app = createEditorialVideoService({ repository: {
    create() {}, async get() { return { ...record }; },
    async replace(_id, revision, next) { if (revision !== record.revision) return null;
      record = next; return next; },
  }, verifyYouTube: async () => { throw new Error("wrong provider"); },
  verifyReelReady: async () => { record = { ...record, status: "unpublished", revision: record.revision + 1 }; return true; } });
  await assert.rejects(app.approve({ id: "reel-1", actor: superAdmin }), (error) => error.statusCode === 409);
  assert.equal(record.status, "unpublished");
  assert.equal(record.title_en, "Original");
});

test("pending-change schema supports Reel metadata without weakening legacy YouTube validation", async () => {
  const metadata = { title_en: "Proposed", title_ar: "جديد" };
  const common = { authorId: "507f1f77bcf86cd799439011", status: "published", title_en: "Original", title_ar: "أصلي",
    pendingChange: { authorId: "507f1f77bcf86cd799439012", status: "draft", createdAt: new Date(), updatedAt: new Date(),
      content: { kind: "reel", ...metadata } } };
  await new EditorialVideoModel({ ...common, kind: "reel" }).validate();
  await assert.rejects(new EditorialVideoModel({ ...common, kind: "reel", pendingChange: {
    ...common.pendingChange, content: { kind: "reel", ...metadata, youtubeId: "dQw4w9WgXcQ" } } }).validate(),
  /Reel changes cannot reference YouTube media/);
  const legacy = new EditorialVideoModel({ ...common, kind: "youtube", youtubeId: "dQw4w9WgXcQ",
    pendingChange: { ...common.pendingChange, content: { ...metadata, youtubeId: "dQw4w9WgXcQ" } } });
  await legacy.validate();
  assert.equal(legacy.pendingChange.content.kind, "youtube");
  const missingId = new EditorialVideoModel({ ...common, kind: "youtube", youtubeId: "dQw4w9WgXcQ",
    pendingChange: { ...common.pendingChange, content: metadata } });
  assert.ok(missingId.validateSync().errors["pendingChange.content.youtubeId"]);
  await assert.rejects(new EditorialVideoModel({ ...common, kind: "reel", pendingChange: {
    ...common.pendingChange, content: { ...metadata, youtubeId: "dQw4w9WgXcQ" } } }).validate(),
  /Pending change must match its Video kind/);
});

test("metadata edits preserve replacement pointers and cannot accidentally approve or discard the pending asset", async () => {
  const pendingChange = { authorId: admin.id, status: "draft", content: { kind: "reel",
    title_en: "Proposed", title_ar: "جديد", description_en: "", description_ar: "" },
    uploadSessionId: "replacement-session", assetId: "replacement-asset", autoApplyWhenReady: false };
  const f = fixture({ ready: true, initial: { ...publishedReel, pendingChange } });
  const edited = await f.app.editVideo({ id: "reel-1", actor: admin, input: { description_en: "Revised" } });
  assert.equal(edited.pendingChange.uploadSessionId, "replacement-session");
  assert.equal(edited.pendingChange.assetId, "replacement-asset");
  await assert.rejects(f.app.submit({ id: "reel-1", actor: admin }),
    (error) => error.errors[0].code === "VIDEO_ASSET_NOT_READY");
  await assert.rejects(f.app.cancelPendingChange({ id: "reel-1", actor: admin }),
    /Cleanup persistence failed/);
  f.changeRecord({ pendingChange: { ...edited.pendingChange, status: "in_review" } });
  await assert.rejects(f.app.approve({ id: "reel-1", actor: superAdmin }),
    (error) => error.errors[0].code === "VIDEO_ASSET_NOT_READY");
  assert.equal(f.verificationCount(), 0);
  assert.equal(f.readRecord().activeAssetId, "asset-1");
  f.changeRecord({ pendingChange: { ...edited.pendingChange, autoApplyWhenReady: true } });
  await assert.rejects(f.app.editVideo({ id: "reel-1", actor: admin, input: { title_en: "Bypass" } }),
    (error) => error.statusCode === 403);
});
