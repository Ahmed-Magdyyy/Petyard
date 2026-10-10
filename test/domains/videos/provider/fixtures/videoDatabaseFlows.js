import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { createPublicVideoRepository } from "../../../../../src/domains/videos/public/publicVideo.repository.js";
import { createPublicVideoService } from "../../../../../src/domains/videos/public/publicVideo.service.js";
import { createVideoAnalyticsRepository } from "../../../../../src/domains/videos/analytics/videoAnalytics.repository.js";
import { createVideoAnalyticsService } from "../../../../../src/domains/videos/analytics/videoAnalytics.service.js";
import { createEditorialVideoRepository } from "../../../../../src/domains/videos/editorial/editorialVideo.repository.js";
import { createEditorialVideoService } from "../../../../../src/domains/videos/editorial/editorialVideo.service.js";
import { createEditorialCoverReferencePersistence, createEditorialCoverRepository } from "../../../../../src/domains/videos/editorial/editorialCover.repository.js";
import { createReelLifecycleRepository } from "../../../../../src/domains/videos/reels/reelLifecycle.repository.js";
import { createProductVideoRepository } from "../../../../../src/domains/videos/productVideos/productVideo.repository.js";
import { createProductVideoProductDeletionRepository } from "../../../../../src/domains/videos/productVideos/productVideoProductDeletion.repository.js";

const objectId = () => new mongoose.Types.ObjectId();
const unavailable = error => error.statusCode === 404 && error.errors[0].code === "VIDEO_ANALYTICS_SESSION_NOT_AVAILABLE";

// Called only by the explicitly enabled runner, with its isolated connection and cloned models.
export async function verifyVideoDatabaseFlows(t, { models, connection, libraryId, recordOperation }) {
  const admin = { id: String(objectId()), role: "admin" };
  const superAdmin = { id: String(objectId()), role: "superAdmin" };
  const guest = { type: "guest", id: String(objectId()) };
  const user = { type: "user", id: guest.id };
  const clock = { time: Date.now() };
  const publicRepository = createPublicVideoRepository({ ...models, connection, analyticsEvents: models.events });
  const publicService = createPublicVideoService({ repository: publicRepository,
    isEnabled: () => true, isProductEnabled: () => true, now: () => clock.time });
  const coverReferences = createEditorialCoverReferencePersistence({ ...models, recordOperation });
  const covers = createEditorialCoverRepository({ ...models, connection, recordOperation });
  const reelLifecycle = createReelLifecycleRepository({ ...models, connection, libraryId, coverReferences, recordOperation });
  const editorialRepository = createEditorialVideoRepository({ ...models, connection, libraryId,
    coverReferences, reelLifecycle, deletion: { ...models, recordOperation } });
  const editorial = createEditorialVideoService({ repository: editorialRepository,
    verifyYouTube: async () => {}, enqueue: async () => {}, now: () => new Date(clock.time) });
  const analyticsRepository = createVideoAnalyticsRepository({ ...models, connection,
    playbackSessions: models.playback, uploads: models.sessions });
  const analytics = createVideoAnalyticsService({ repository: analyticsRepository,
    isEnabled: () => true, isProductEnabled: () => true, now: () => clock.time });
  const createYouTube = actor => editorial.createYouTubeVideo({ actor,
    input: { youtubeUrl: "https://youtu.be/dQw4w9WgXcQ", title_en: "Original", title_ar: "Original" } });
  const readyAsset = (ownerId, ownerType) => ({ _id: objectId(), ownerId, ownerType, libraryId,
    providerGuid: randomUUID(), technicalState: "ready", providerStatus: 4, readyAt: new Date(clock.time),
    durationSeconds: 18, width: 720, height: 1280, availableResolutions: ["720p"] });
  let youtube, reel, productPlacement;

  await t.test("real editorial review keeps approval hidden and isolates pending public edits", async () => {
    youtube = await createYouTube(admin);
    assert.equal(await publicRepository.getPublished(youtube.id), null);
    await editorial.submit({ id: youtube.id, actor: admin });
    await editorial.approve({ id: youtube.id, actor: superAdmin });
    assert.equal(await publicRepository.getPublished(youtube.id), null);
    await editorial.publish({ id: youtube.id, actor: superAdmin });
    await editorial.editVideo({ id: youtube.id, actor: admin, input: { title_en: "Pending" } });
    assert.equal((await publicRepository.getPublished(youtube.id)).title_en, "Original");
    await editorial.submit({ id: youtube.id, actor: admin });
    await editorial.approve({ id: youtube.id, actor: superAdmin });
    assert.equal((await publicRepository.getPublished(youtube.id)).title_en, "Pending");
  });

  await t.test("real mixed aggregation paginates ready Reels and eligible Product media", async () => {
    const reelId = objectId(), sessionId = objectId(), productId = objectId(), placementId = objectId();
    const reelAsset = await models.assets.create(readyAsset(reelId, "reel"));
    const productAsset = await models.assets.create(readyAsset(placementId, "product_video"));
    reel = await models.videos.create({ _id: reelId, kind: "reel", title_en: "Reel", title_ar: "Reel",
      authorId: admin.id, status: "published", activeAssetId: reelAsset._id,
      activeUploadSessionId: sessionId, publishedAt: new Date(clock.time) });
    await models.sessions.collection.insertOne({ _id: sessionId, videoId: reelId, assetId: reelAsset._id,
      actorId: objectId(), idempotencyKey: randomUUID(), status: "issued" });
    await models.products.collection.insertOne({ _id: productId, slug: `acceptance-${productId}`, isActive: true });
    await models.placements.collection.insertOne({ _id: placementId, productId, activeSlot: true,
      lifecycleState: "ready", activeAssetId: productAsset._id, position: 0, showInReelsFeed: true });
    productPlacement = { id: String(placementId), productId, assetId: productAsset._id };
    const pages = await Promise.all([1, 2].map(page => publicRepository.listMixed({ page, limit: 1 })));
    assert.ok(pages.every(page => page.totalResults === 2 && page.data.length === 1));
    assert.equal(new Set(pages.map(page => page.data[0].id)).size, 2);
    assert.deepEqual(pages.map(page => page.data[0].kind).sort(), ["product", "reel"]);
    await models.products.updateOne({ _id: productId }, { $set: { isActive: false } });
    assert.equal((await publicRepository.listMixed({ page: 1, limit: 10 })).totalResults, 1);
    await models.products.updateOne({ _id: productId }, { $set: { isActive: true } });
  });

  await t.test("real bulk ordering rolls back stale entries and serializes competing revisions", async () => {
    const second = await createYouTube(superAdmin);
    const first = await editorialRepository.get(youtube.id);
    const items = [{ videoId: first.id, revision: first.revision, position: 1 },
      { videoId: second.id, revision: second.revision + 1, position: 2 }];
    await assert.rejects(editorialRepository.setPublicPositions({ kind: "youtube", items }), error => error.statusCode === 409);
    assert.equal((await editorialRepository.get(first.id)).revision, first.revision);
    items[1].revision = second.revision;
    const results = await Promise.allSettled([0, 1].map(() => editorialRepository.setPublicPositions({ kind: "youtube", items })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.deepEqual((await publicRepository.listYouTube({ page: 1, limit: 10 })).data.map(row => row.id), [first.id, second.id]);
  });

  await t.test("real saves remain unique and isolate users from guests with the same identity text", async () => {
    const request = { id: youtube.id, identity: guest };
    await Promise.all([publicService.save(request), publicService.save(request)]);
    assert.equal(await models.saves.countDocuments({ videoId: youtube.id, identityType: "guest" }), 1);
    assert.equal(await models.events.countDocuments({ contentId: youtube.id, type: "save_added" }), 1);
    assert.equal((await publicRepository.listSaved({ identity: user, page: 1, limit: 10 })).totalResults, 0);
    await publicService.save({ ...request, identity: user });
    await Promise.all([publicService.unsave(request), publicService.unsave(request)]);
    assert.equal(await models.saves.countDocuments({ videoId: youtube.id, identityType: "guest" }), 0);
    assert.equal(await models.saves.countDocuments({ videoId: youtube.id, identityType: "user" }), 1);
    assert.equal(await models.events.countDocuments({ contentId: youtube.id, type: "save_removed" }), 1);
  });

  await t.test("real deletion versus concurrent saves leaves no owner or orphan associations", async () => {
    for (let iteration = 0; iteration < 3; iteration++) {
      const video = await createYouTube(superAdmin);
      const results = await Promise.allSettled([
        publicRepository.save({ identity: guest, videoId: video.id }),
        editorialRepository.deletePermanently({ id: video.id, revision: video.revision, now: new Date(clock.time) }),
      ]);
      assert.ok(results.every(result => result.status === "fulfilled"));
      assert.equal(await models.videos.countDocuments({ _id: video.id }), 0);
      assert.equal(await models.saves.countDocuments({ videoId: video.id }), 0);
    }
  });

  await t.test("real reviewed cover attachment stays private until approval and removal persists cleanup", async () => {
    const storage = { zone: "acceptance", endpoint: "https://storage.bunnycdn.com", cdnBaseUrl: "https://acceptance.example/" };
    const cover = await covers.reserve({ videoId: youtube.id, actorId: admin.id, storage, now: new Date(clock.time) });
    const descriptor = { public_id: `petyard/video-covers/${cover._id}`,
      url: `https://acceptance.example/petyard/video-covers/${cover._id}.webp` };
    await covers.recordUploaded({ coverId: cover._id, descriptor, now: new Date(clock.time) });
    const current = await editorialRepository.get(youtube.id);
    await editorialRepository.replaceWithCovers(youtube.id, current.revision, { ...current,
      pendingChange: { authorId: admin.id, status: "draft", content: { kind: "youtube", youtubeId: current.youtubeId,
        title_en: current.title_en, title_ar: current.title_ar, coverId: cover._id },
      createdAt: new Date(clock.time), updatedAt: new Date(clock.time) } }, { actorId: admin.id, now: new Date(clock.time) });
    assert.equal((await publicRepository.getPublished(youtube.id)).cover ?? null, null);
    await editorial.submit({ id: youtube.id, actor: admin });
    await editorial.approve({ id: youtube.id, actor: superAdmin });
    assert.equal((await publicRepository.getPublished(youtube.id)).cover.url, descriptor.url);
    const approved = await editorialRepository.get(youtube.id);
    await editorialRepository.replaceWithCovers(youtube.id, approved.revision, { ...approved, activeCoverId: null },
      { actorId: superAdmin.id, now: new Date(clock.time) });
    assert.equal((await publicRepository.getPublished(youtube.id)).cover ?? null, null);
    assert.equal((await models.covers.findById(cover._id)).state, "deleting");
    assert.equal(await models.operations.countDocuments({ coverId: cover._id, status: "pending" }), 1);
  });

  await t.test("real cover reservation versus permanent deletion cannot leave an untracked upload", async () => {
    const video = await createYouTube(superAdmin);
    const results = await Promise.allSettled([
      covers.reserve({ videoId: video.id, actorId: admin.id, now: new Date(clock.time),
        storage: { zone: "acceptance", endpoint: "https://storage.bunnycdn.com", cdnBaseUrl: "https://acceptance.example/" } }),
      editorialRepository.deletePermanently({ id: video.id, revision: video.revision, now: new Date(clock.time) }),
    ]);
    assert.equal(results[1].status, "fulfilled");
    if (results[0].status === "rejected") assert.equal(results[0].reason.message, "VIDEO_COVER_OWNER_NOT_FOUND");
    assert.equal(await models.videos.countDocuments({ _id: video.id }), 0);
    const reservations = await models.covers.find({ videoId: video.id }).lean();
    for (const cover of reservations) {
      assert.equal(cover.state, "deleting");
      assert.equal(await models.operations.countDocuments({ coverId: cover._id, status: "pending" }), 1);
    }
  });

  await t.test("real player-error alerts deduplicate concurrent reports and target only eligible staff", async () => {
    const recipients = [
      { _id: objectId(), role: "superAdmin", active: true },
      { _id: objectId(), role: "admin", active: true, enabledControls: ["videos"] },
      { _id: objectId(), role: "admin", active: true, enabledControls: [] },
      { _id: objectId(), role: "superAdmin", active: false },
      { _id: objectId(), role: "user", active: true },
    ];
    await models.users.collection.insertMany(recipients);
    const request = { id: youtube.id, youtubeId: youtube.youtubeId, day: "2026-10-08",
      notification: { title_en: "Video error", body_en: "Unverified test report" } };
    const results = await Promise.all([0, 1].map(() => publicRepository.recordPlayerErrorAlerts(request)));
    assert.deepEqual(results, [true, true]);
    const alerts = await models.outbox.find({ "source.referenceId": youtube.id }).lean();
    assert.deepEqual(alerts.map(alert => String(alert.recipientUser)).sort(), recipients.slice(0, 2).map(user => String(user._id)).sort());
    assert.ok(alerts.every(alert => alert.status === "pending"));
  });

  await t.test("real analytics ingestion serializes with concurrent YouTube/Reel/Product visibility changes", async () => {
    for (const [kind, contentId] of [["youtube", youtube.id], ["reel", String(reel._id)], ["product", productPlacement.id]]) {
      const session = await analytics.issueSession({ body: { kind, contentId }, identity: guest });
      const event = { playbackSessionId: session.playbackSessionId, eventId: randomUUID(),
        type: "share", occurredAt: new Date(clock.time).toISOString() };
      const target = kind === "product" ? models.products : models.videos;
      const id = kind === "product" ? productPlacement.productId : contentId;
      const hide = kind === "product" ? { isActive: false } : { status: "unpublished" };
      const results = await Promise.allSettled([
        analytics.ingestEvents({ body: { events: [event] }, identity: guest }),
        target.updateOne({ _id: id }, { $set: hide }),
      ]);
      assert.equal(results[1].status, "fulfilled");
      const accepted = results[0].status === "fulfilled" ? results[0].value.accepted : 0;
      if (results[0].status === "rejected") assert.ok(unavailable(results[0].reason));
      assert.equal(await models.events.countDocuments({ eventId: event.eventId }), accepted);
      const afterHide = { ...event, eventId: randomUUID() };
      await assert.rejects(analytics.ingestEvents({ body: { events: [afterHide] }, identity: guest }), unavailable);
      assert.equal(await models.events.countDocuments({ eventId: afterHide.eventId }), 0);
      await target.updateOne({ _id: id }, { $set: kind === "product" ? { isActive: true } : { status: "published" } });
    }
  });

  await t.test("real analytics retries, shared daily upserts and typed session ownership stay atomic", async () => {
    const previous = await models.daily.findOne({ contentId: reel._id }).lean();
    const sessions = await Promise.all([0, 1].map(() => analytics.issueSession({
      body: { kind: "reel", contentId: String(reel._id) }, identity: guest })));
    clock.time += 1_000;
    const event = (session, type) => ({ playbackSessionId: session.playbackSessionId, eventId: randomUUID(),
      type, occurredAt: new Date(clock.time).toISOString() });
    const item = event(sessions[0], "impression");
    const ingest = events => analytics.ingestEvents({ body: { events }, identity: guest });
    const retries = await Promise.all([ingest([item]), ingest([item])]);
    assert.equal(retries.reduce((sum, result) => sum + result.accepted, 0), 1);
    assert.equal(retries.reduce((sum, result) => sum + result.duplicates, 0), 1);
    await Promise.all(sessions.map(session => ingest([event(session, "share")])));
    assert.equal(await models.daily.countDocuments({ contentId: reel._id }), 1);
    const daily = await models.daily.findOne({ contentId: reel._id }).lean();
    assert.equal(daily.impressions, 1);
    assert.equal(daily.shares, (previous?.shares ?? 0) + 2);
    await assert.rejects(analytics.resolveSession({ ...sessions[0], identity: user }), unavailable);
    clock.time += 30 * 60 * 1_000;
    await assert.rejects(analytics.resolveSession({ ...sessions[0], identity: guest }), unavailable);
    // TTL is asynchronous: service expiry must work while the actual row still exists.
    assert.ok(await models.playback.findById(sessions[0].playbackSessionId));
    clock.time -= 30 * 60 * 1_000;
  });

  await t.test("real aggregate failure rolls back event and session state; media removal rejects later events", async () => {
    const previous = await models.daily.findOne({ contentId: productPlacement.id }).lean();
    const session = await analytics.issueSession({ body: { kind: "product", contentId: productPlacement.id }, identity: guest });
    const item = { ...session, eventId: randomUUID(), type: "share", occurredAt: new Date(clock.time).toISOString() };
    delete item.expiresAt;
    const failingDaily = { async updateOne(...args) {
      await models.daily.updateOne(...args);
      throw new Error("Injected aggregate failure");
    } };
    const failing = createVideoAnalyticsService({ repository: createVideoAnalyticsRepository({ ...models, connection,
      playbackSessions: models.playback, uploads: models.sessions, daily: failingDaily }),
    isEnabled: () => true, isProductEnabled: () => true, now: () => clock.time });
    await assert.rejects(failing.ingestEvents({ body: { events: [item] }, identity: guest }), error => error.statusCode === 503);
    assert.equal(await models.events.countDocuments({ eventId: item.eventId }), 0);
    assert.equal((await models.playback.findById(session.playbackSessionId)).eventCount, 0);
    assert.deepEqual(await models.daily.findOne({ contentId: productPlacement.id }).lean(), previous);
    assert.deepEqual(await analytics.ingestEvents({ body: { events: [item] }, identity: guest }), { accepted: 1, duplicates: 0 });
    await models.assets.updateOne({ _id: productPlacement.assetId }, { $set: { deleteAcceptedAt: new Date(clock.time) } });
    await assert.rejects(analytics.ingestEvents({ body: { events: [{ ...item, eventId: randomUUID() }] }, identity: guest }), unavailable);
  });

  await t.test("real Reel replacement keeps current public media until atomic cutover and records old cleanup", async () => {
    const replacement = await models.assets.create(readyAsset(reel._id, "reel"));
    const sessionId = objectId();
    await models.sessions.collection.insertOne({ _id: sessionId, videoId: reel._id, assetId: replacement._id,
      actorId: new mongoose.Types.ObjectId(admin.id), purpose: "replacement", previousAssetId: reel.activeAssetId,
      safeFilename: "replacement.mp4", idempotencyKey: randomUUID(), status: "issued" });
    await models.videos.updateOne({ _id: reel._id }, { $set: { pendingChange: { authorId: admin.id, status: "in_review",
      content: { kind: "reel", title_en: "Replacement", title_ar: "Replacement" }, createdAt: new Date(clock.time),
      updatedAt: new Date(clock.time), assetId: replacement._id, uploadSessionId: sessionId } } });
    assert.equal(String((await publicRepository.getPublished(String(reel._id))).activeAssetId), String(reel.activeAssetId));
    const current = await models.videos.findById(reel._id);
    const result = await reelLifecycle.applyReplacement({ videoId: reel._id, expectedRevision: current.revision,
      sessionId, assetId: replacement._id, reviewerId: superAdmin.id, now: new Date(clock.time) });
    assert.equal(String(result.video.activeAssetId), String(replacement._id));
    assert.equal((await publicRepository.getPublished(String(reel._id))).title_en, "Replacement");
    assert.equal((await models.assets.findById(reel.activeAssetId)).technicalState, "deleting");
    assert.equal(await models.operations.countDocuments({ assetId: reel.activeAssetId, type: "delete", status: "pending" }), 1);
  });

  await t.test("real Product replacement versus whole-Product deletion retains every media cleanup obligation", async () => {
    const productId = objectId(), videoId = objectId(), replacementId = objectId();
    const active = await models.assets.create(readyAsset(videoId, "product_video"));
    const pending = await models.assets.create(readyAsset(videoId, "product_video"));
    await models.products.collection.insertOne({ _id: productId, slug: `acceptance-${productId}`, isActive: true });
    await models.placements.collection.insertOne({ _id: videoId, productId, position: 0, activeSlot: true,
      lifecycleState: "ready", activeAssetId: active._id, pendingAssetId: pending._id, replacementId });
    await models.replacements.collection.insertOne({ _id: replacementId, videoId, productId, assetId: pending._id,
      actorId: new mongoose.Types.ObjectId(admin.id), safeFilename: "replacement.mp4", status: "issued", idempotencyKey: randomUUID() });
    const repository = createProductVideoRepository({ ...models, connection, libraryId, recordOperation, now: () => clock.time });
    const deletion = createProductVideoProductDeletionRepository({ ...models, connection, productId, recordOperation, now: () => clock.time });
    const outcomes = await Promise.allSettled([
      repository.commitReplacementReady({ placementId: videoId, assetId: pending._id }), deletion.deleteWithVideos(),
    ]);
    assert.ok(outcomes.every(result => result.status === "fulfilled"));
    assert.equal(await models.products.countDocuments({ _id: productId }), 0);
    assert.equal((await models.placements.findById(videoId)).activeSlot, false);
    for (const asset of [active, pending]) {
      assert.equal((await models.assets.findById(asset._id)).technicalState, "deleting");
      assert.ok(await models.operations.countDocuments({ assetId: asset._id, status: "pending" }));
    }
  });
}
