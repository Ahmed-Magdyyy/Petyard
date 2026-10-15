import assert from "node:assert/strict";
import test from "node:test";
import { createEditorialVideoService } from "../../../../src/domains/videos/editorial/editorialVideo.service.js";
import { createEditorialVideoRepository } from "../../../../src/domains/videos/editorial/editorialVideo.repository.js";
import { replacementDatabase } from "../productVideos/fixtures/replacementDatabase.js";
import { createEditorialVideoAuthorityFence } from "../../../../src/domains/videos/editorial/editorialVideoAuthority.repository.js";
import { createReelLifecycleRepository } from "../../../../src/domains/videos/reels/reelLifecycle.repository.js";
import { createReelUploadRepository } from "../../../../src/domains/videos/reels/reelUpload.repository.js";

const id = "507f1f77bcf86cd799439011";
const actorId = "507f1f77bcf86cd799439099";
const input = { title_en: "Changed", title_ar: "عنوان", youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };

function fixture(role = "admin", verify = async () => {}) {
  const actor = { id: actorId, role };
  const db = replacementDatabase({ products: [{ _id: actorId, role, active: true, deletedAt: null,
    account_status: "confirmed", phoneVerified: true, enabledControls: ["videos"], __v: 3 }],
  placements: [{ _id: id, kind: "youtube", status: "draft", revision: 0, authorId: actorId,
    title_en: "Original", title_ar: "عنوان", youtubeId: "dQw4w9WgXcQ", productIds: [] }] });
  const videos = { ...db.placements, async create(rows, options) {
    const created = await db.placements.create(Array.isArray(rows) ? rows : [rows], options);
    return Array.isArray(rows) ? created : { toObject: () => created[0] };
  } };
  const repository = createEditorialVideoRepository({ videos, users: db.products,
    connection: db.connection, reelLifecycle: {}, coverReferences: { async sync() { return []; } },
    deletion: { assets: db.assets, sessions: db.sessions, covers: db.covers, saves: db.saves, placements: db.replacements } });
  const service = createEditorialVideoService({ repository, verifyYouTube: () => verify(db), enqueue: async () => {},
    covers: { describe: value => value } });
  return { service, actor, db };
}

test("an authenticated editor whose account is disabled during YouTube verification cannot edit", async () => {
  const { service, actor } = fixture("admin", db => db.products.updateOne({ _id: actorId }, { $set: { active: false } }));
  const before = await service.getAdmin({ id, actor });
  await assert.rejects(service.editVideo({ id, actor, input }), error =>
    error.statusCode === 403 && error.errors[0].code === "VIDEO_FORBIDDEN");
  assert.deepEqual(await service.getAdmin({ id, actor }), before);
});

for (const [name, revoked] of Object.entries({
  "a deleted account": { deletedAt: new Date() },
  "a banned account": { account_status: "banned" },
  "an unverified phone": { phoneVerified: false },
  "a changed role": { role: "superAdmin" },
  "a removed videos control": { enabledControls: [] },
  "a wildcard instead of the literal videos control": { enabledControls: ["*"] },
})) {
  test(`YouTube edit rejects ${name} revoked while verification runs`, async () => {
    const { service, actor } = fixture("admin", db => db.products.updateOne({ _id: actorId }, { $set: revoked }));
    const before = await service.getAdmin({ id, actor });
    await assert.rejects(service.editVideo({ id, actor, input }), error =>
      error.statusCode === 403 && error.errors[0].code === "VIDEO_FORBIDDEN");
    assert.deepEqual(await service.getAdmin({ id, actor }), before);
  });
}

test("creation, submission, approval and publication recheck persisted authority after verification", async () => {
  for (const [method, role, status] of [
    ["createYouTubeVideo", "admin", "draft"], ["createYouTubeVideo", "superAdmin", "draft"],
    ["submit", "admin", "draft"], ["approve", "superAdmin", "in_review"], ["publish", "superAdmin", "approved"],
  ]) {
    const { service, actor, db } = fixture(role, db => db.products.updateOne({ _id: actorId }, { $set: { active: false } }));
    await db.placements.updateOne({ _id: id }, { $set: { status } });
    const before = await service.getAdmin({ id, actor });
    await assert.rejects(service[method]({ id, actor, input }), error =>
      error.statusCode === 403 && error.errors[0].code === "VIDEO_FORBIDDEN", method);
    assert.deepEqual(await service.getAdmin({ id, actor }), before);
    assert.equal(await db.placements.countDocuments({}), 1);
  }
});

test("eligible admins and super admins retain creation and editing behavior", async () => {
  for (const role of ["admin", "superAdmin"]) {
    const { service, actor, db } = fixture(role);
    if (role === "superAdmin") await db.products.updateOne({ _id: actorId }, { $set: { enabledControls: [] } });
    const edited = await service.editVideo({ id, actor, input });
    assert.equal(edited.title_en, "Changed");
    assert.equal(edited.revision, 1);
    const created = await service.createYouTubeVideo({ actor, input });
    assert.equal(created.status, role === "superAdmin" ? "published" : "draft");
    assert.equal(created.authorId, actorId);
    assert.equal((await db.products.findById(actorId)).__v, 5);
  }
});

test("cover, cancellation, rejection, visibility, ordering and deletion writes reject revoked authority", async () => {
  for (const [method, role, fields, actionInput] of [
    ["createReelDraft", "admin", {}, { kind: "reel", title_en: "New", title_ar: "عنوان" }],
    ["editCover", "admin", {}, undefined],
    ["cancelPendingChange", "admin", { pendingChange: { authorId: actorId, status: "draft", content: {} } }, undefined],
    ["reject", "superAdmin", { status: "in_review" }, undefined],
    ["unpublish", "superAdmin", { status: "published" }, undefined],
    ["setDraftPosition", "admin", {}, { revision: 0, draftPosition: 1 }],
    ["setPublicPosition", "superAdmin", { status: "published" }, { position: 1 }],
    ["setPublicPositions", "superAdmin", { status: "published" }, { kind: "youtube", items: [{ videoId: id, revision: 0, position: 1 }] }],
    ["deletePermanently", "superAdmin", {}, { revision: 0 }],
  ]) {
    const { service, actor, db } = fixture(role);
    await db.placements.updateOne({ _id: id }, { $set: fields });
    const before = await service.getAdmin({ id, actor });
    await db.products.updateOne({ _id: actorId }, { $set: { active: false } });
    await assert.rejects(service[method]({ id, actor, input: actionInput, remove: true, reason: "Rejected" }), error =>
      error.statusCode === 403 && error.errors[0].code === "VIDEO_FORBIDDEN", method);
    assert.deepEqual(await service.getAdmin({ id, actor }), before);
  }
});

test("failed video mutation rolls back the internal user version without changing account timestamps", async () => {
  const { service, actor, db } = fixture("superAdmin");
  const account = await db.products.findById(actorId);
  await assert.rejects(service.setPublicPositions({ actor, input: { kind: "youtube", items: [
    { videoId: id, revision: 0, position: 1 },
  ] } }), error => error.statusCode === 409);
  assert.deepEqual(await db.products.findById(actorId), account);
});

test("the authority write and video mutation use the same transaction and disable User timestamps", async () => {
  const { service, actor, db } = fixture("admin");
  const updateUser = db.products.updateOne.bind(db.products);
  const updateVideo = db.placements.findOneAndUpdate.bind(db.placements);
  let authoritySession;
  db.products.updateOne = (filter, changes, options) => {
    authoritySession = options.session;
    assert.ok(authoritySession);
    assert.equal(options.timestamps, false);
    assert.deepEqual(changes, { $inc: { __v: 1 } });
    return updateUser(filter, changes, options);
  };
  db.placements.findOneAndUpdate = (filter, changes, options) => {
    assert.equal(options.session, authoritySession);
    return updateVideo(filter, changes, options);
  };
  await service.editVideo({ id, actor, input });
});

test("a retried transaction checks authority again and refuses a revocation committed between attempts", async () => {
  const { service, actor, db } = fixture("admin");
  const before = await service.getAdmin({ id, actor });
  const transient = new Error("simulated transient write conflict");
  const updateUser = db.products.updateOne.bind(db.products);
  let firstAttempt = true;
  db.products.updateOne = (...args) => {
    if (firstAttempt) { firstAttempt = false; throw transient; }
    return updateUser(...args);
  };
  db.connection.startSession = async () => ({ async withTransaction(work) {
    try { await work(); } catch (error) {
      if (error !== transient) throw error;
      await updateUser({ _id: actorId }, { $set: { active: false } });
      await work();
    }
  }, async endSession() {} });
  await assert.rejects(service.editVideo({ id, actor, input }), error =>
    error.statusCode === 403 && error.errors[0].code === "VIDEO_FORBIDDEN");
  assert.deepEqual(await service.getAdmin({ id, actor }), before);
});

test("manual Reel replacement promotion and cancellation fence persisted authority", async () => {
  for (const method of ["approve", "cancelPendingChange"]) {
    const actor = { id: actorId, role: "superAdmin" };
    const db = replacementDatabase({ products: [{ _id: actorId, role: actor.role, active: true,
      deletedAt: null, phoneVerified: true, account_status: "confirmed" }], placements: [{
      _id: id, kind: "reel", status: "published", revision: 0, activeAssetId: "old-asset",
      pendingChange: { assetId: "new-asset", uploadSessionId: "new-session", authorId: actorId,
        status: "in_review", content: { productIds: [] } },
    }] });
    const dependencies = { videos: db.placements, connection: db.connection, libraryId: "754739",
      assertAuthority: createEditorialVideoAuthorityFence({ users: db.products }) };
    const service = createEditorialVideoService({
      repository: createEditorialVideoRepository({ ...dependencies,
        reelLifecycle: createReelLifecycleRepository(dependencies),
        reelUploads: createReelUploadRepository(dependencies) }),
      verifyYouTube: async () => assert.fail("not a YouTube Video"), enqueue: async () => {},
      verifyReelReplacementReady: async () => {
        await db.products.updateOne({ _id: actorId }, { $set: { active: false } });
        return true;
      },
    });
    const before = await service.getAdmin({ id, actor });
    if (method === "cancelPendingChange") await db.products.updateOne({ _id: actorId }, { $set: { active: false } });
    await assert.rejects(service[method]({ id, actor }), error =>
      error.statusCode === 403 && error.errors[0].code === "VIDEO_FORBIDDEN", method);
    assert.deepEqual(await service.getAdmin({ id, actor }), before);
  }
});
