import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import jwt from "jsonwebtoken";

import { createVideoAnalyticsRouter } from "../../../../src/domains/videos/analytics/videoAnalytics.routes.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";
import { UserModel } from "../../../../src/domains/user/user.model.js";
import { egyptTimezoneReplacer } from "../../../../src/shared/utils/egyptTimezone.js";
import { fixture, id, guest, body, assetId, productId, uploadId } from "./fixtures/analyticsDatabase.js";

test("a guest receives an opaque thirty-minute session for the current published YouTube Video", async () => {
  const { service } = fixture();
  const session = await service.issueSession({ body, identity: guest });
  assert.match(session.playbackSessionId, /^[a-f\d-]{36}$/);
  assert.deepEqual(Object.keys(session).sort(), ["expiresAt", "playbackSessionId"]);
  assert.equal(session.expiresAt, "2026-10-02T20:30:00.000+00:00");
  const content = await service.resolveSession({ playbackSessionId: session.playbackSessionId,
    identity: guest });
  assert.equal(content.kind, "youtube");
  assert.equal(content.contentId, id);
  assert.equal(content.durationSeconds, null);
  assert.equal(JSON.stringify(session).includes("guest-session-owner"), false);
});

async function httpFixture(t, service) {
  t.mock.method(console, "warn", () => {});
  const app = express();
  app.set("json replacer", egyptTimezoneReplacer);
  app.use(express.json());
  app.use("/api/v1/videos/analytics", createVideoAnalyticsRouter({ getService: async () => service }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (headers = {}, requestBody = body) => fetch(
    `http://127.0.0.1:${server.address().port}/api/v1/videos/analytics/playback-sessions`,
    { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(requestBody) });
}

test("the session HTTP route requires the real user-or-guest middleware and returns a private grant", async t => {
  const { service } = fixture();
  const request = await httpFixture(t, service);
  assert.equal((await request()).status, 401);
  const response = await request({ "x-guest-id": guest.id });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const { data } = await response.json();
  assert.equal(data.expiresAt, "2026-10-02T20:30:00.000+00:00");
  assert.equal((await service.resolveSession({ playbackSessionId: data.playbackSessionId,
    identity: guest })).contentId, id);
  assert.equal((await request({ authorization: "Bearer invalid", "x-guest-id": guest.id })).status, 401);
});

test("expired and corrupt session timestamps fail closed even before TTL removes the row", async () => {
  for (const corrupt of [false, true]) {
    const { service, db, clock } = fixture();
    const session = await service.issueSession({ body, identity: guest });
    if (corrupt) await db.sessions.updateOne({ _id: session.playbackSessionId },
      { $set: { expiresAt: "not-a-date" } });
    else clock.time = Date.parse("2026-10-02T20:30:00Z");
    await assert.rejects(service.resolveSession({ ...session, identity: guest }), error =>
      error.statusCode === 404 && error.errors[0].code === "VIDEO_ANALYTICS_SESSION_NOT_AVAILABLE");
  }
});

test("Reel and Product Video sessions capture current media without requiring feed opt-in", async () => {
  for (const kind of ["reel", "product"]) {
    const { service } = fixture({ kind });
    const session = await service.issueSession({ body: { kind, contentId: id }, identity: guest });
    const media = await service.resolveSession({ ...session, identity: guest });
    assert.equal(media.kind, kind);
    assert.equal(media.assetId, assetId);
    assert.equal(media.durationSeconds, 18);
    assert.equal(media.uploadSessionId, kind === "reel" ? uploadId : undefined);
    assert.equal(JSON.stringify(session).includes(assetId), false);
  }
});

test("session ownership keeps users and guests separate even when their identity strings match", async () => {
  const { service } = fixture();
  const user = { type: "user", id };
  const sameIdGuest = { type: "guest", id };
  const session = await service.issueSession({ body, identity: user });
  assert.equal((await service.resolveSession({ ...session, identity: user })).contentId, id);
  for (const identity of [sameIdGuest, guest, { type: "user", id: productId }]) {
    await assert.rejects(service.resolveSession({ ...session, identity }), error => error.statusCode === 404);
  }
  const separate = await service.issueSession({ body, identity: sameIdGuest });
  assert.notEqual(separate.playbackSessionId, session.playbackSessionId);
  assert.equal((await service.resolveSession({ ...separate, identity: sameIdGuest })).contentId, id);
});

test("unavailable or wrong-type content and independent public flags do not issue sessions", async () => {
  for (const status of ["draft", "approved", "in_review", "unpublished"]) {
    const { service, videos } = fixture();
    await videos.updateOne({ _id: id }, { $set: { status } });
    await assert.rejects(service.issueSession({ body, identity: guest }), error => error.statusCode === 404);
  }
  const { service, flags } = fixture();
  await assert.rejects(service.issueSession({ body: { kind: "reel", contentId: id }, identity: guest }),
    error => error.statusCode === 404);
  await assert.rejects(service.issueSession({ body: { kind: "youtube", contentId: productId }, identity: guest }),
    error => error.statusCode === 404);
  flags.editorial = false;
  await assert.rejects(service.issueSession({ body, identity: guest }), error => error.statusCode === 404);
  const product = fixture({ kind: "product" });
  product.flags.editorial = false;
  assert.ok(await product.service.issueSession({ body: { kind: "product", contentId: id }, identity: guest }));
  product.flags.product = false;
  await assert.rejects(product.service.issueSession({ body: { kind: "product", contentId: id }, identity: guest }),
    error => error.statusCode === 404);
});

test("public eligibility excludes unready, unowned and removed uploaded media", async () => {
  for (const kind of ["reel", "product"]) {
    for (const changes of [{ ownerId: productId }, { providerStatus: 0 },
      { technicalState: "failed" }, { durationSeconds: 91 }, { width: 720.5 }, { availableResolutions: [] },
      kind === "reel" ? { deletionRequestedAt: new Date() } : { deleteAcceptedAt: new Date() }]) {
      const { service, db } = fixture({ kind });
      await db.assets.updateOne({ _id: assetId }, { $set: changes });
      await assert.rejects(service.issueSession({ body: { kind, contentId: id }, identity: guest }),
        error => error.statusCode === 404);
    }
  }
  const product = fixture({ kind: "product" });
  await product.db.products.updateOne({ _id: productId }, { $set: { isActive: false } });
  await assert.rejects(product.service.issueSession({ body: { kind: "product", contentId: id }, identity: guest }),
    error => error.statusCode === 404);
});

test("pending Product Video deletion stays eligible until provider acceptance", async () => {
  const { service, db } = fixture({ kind: "product" });
  const productBody = { kind: "product", contentId: id };
  await db.replacements.updateOne({ _id: id }, { $set: { lifecycleState: "deleting" } });
  await db.assets.updateOne({ _id: assetId }, { $set: { deletionRequestedAt: new Date() } });
  const session = await service.issueSession({ body: productBody, identity: guest });
  assert.equal((await service.resolveSession({ ...session, identity: guest })).assetId, assetId);
  await db.assets.updateOne({ _id: assetId }, { $set: { deleteAcceptedAt: new Date() } });
  await assert.rejects(service.resolveSession({ ...session, identity: guest }), error => error.statusCode === 404);
});

test("existing sessions recheck link, asset, publication and product availability", async () => {
  const changes = [
    ["youtube", async db => db.placements.updateOne({ _id: id }, { $set: { youtubeId: "abcdefghijk" } })],
    ["youtube", async db => db.placements.updateOne({ _id: id }, { $set: { status: "unpublished" } })],
    ["youtube", async db => db.placements.deleteOne({ _id: id })],
    ["reel", async db => db.placements.updateOne({ _id: id }, { $set: { activeUploadSessionId: productId } })],
    ["reel", async db => db.placements.updateOne({ _id: id }, { $set: { activeAssetId: productId } })],
    ["product", async db => db.products.updateOne({ _id: productId }, { $set: { isActive: false } })],
    ["product", async db => db.products.deleteOne({ _id: productId })],
    ["product", async db => db.replacements.updateOne({ _id: id }, { $set: { removedAt: new Date() } })],
  ];
  for (const [kind, change] of changes) {
    const { service, db } = fixture({ kind });
    const session = await service.issueSession({ body: { kind, contentId: id }, identity: guest });
    await change(db);
    await assert.rejects(service.resolveSession({ ...session, identity: guest }), error => error.statusCode === 404);
  }
  const { service, flags, videos } = fixture();
  const session = await service.issueSession({ body, identity: guest });
  await videos.updateOne({ _id: id }, { $set: { title_en: "New title" } });
  assert.equal((await service.resolveSession({ ...session, identity: guest })).contentId, id);
  flags.editorial = false;
  await assert.rejects(service.resolveSession({ ...session, identity: guest }), error => error.statusCode === 404);
});

test("invalid request fields and identities cannot issue or resolve sessions", async () => {
  const { service } = fixture();
  for (const invalid of [null, [], {}, { kind: "all", contentId: id },
    { kind: "youtube", contentId: "invalid" }, { ...body, youtubeId: "abcdefghijk" },
    { ...body, viewerId: "raw-viewer" }, { ...body, url: "https://private.example" }]) {
    await assert.rejects(service.issueSession({ body: invalid, identity: guest }), error =>
      error.statusCode === 422 && error.errors[0].code === "VIDEO_INVALID_PLAYBACK_SESSION");
  }
  for (const identity of [null, { type: "staff", id }, { type: "user", id: "invalid" },
    { type: "guest", id: " " }, { type: "guest", id: "g".repeat(257) }]) {
    await assert.rejects(service.issueSession({ body, identity }), error => error.statusCode === 401);
  }
  for (const playbackSessionId of ["invalid", id, "00000000-0000-0000-0000-000000000000"]) {
    await assert.rejects(service.resolveSession({ playbackSessionId, identity: guest }), error => error.statusCode === 404);
  }
});

test("a media change during persistence removes the obsolete issued session", async () => {
  const { service, playbackSessions, videos } = fixture();
  const create = playbackSessions.create;
  let capturedId;
  playbackSessions.create = async rows => {
    capturedId = rows[0]._id;
    await create(rows);
    await videos.updateOne({ _id: id }, { $set: { youtubeId: "abcdefghijk" } });
  };
  await assert.rejects(service.issueSession({ body, identity: guest }), error => error.statusCode === 404);
  await videos.updateOne({ _id: id }, { $set: { youtubeId: "dQw4w9WgXcQ" } });
  await assert.rejects(service.resolveSession({ playbackSessionId: capturedId, identity: guest }),
    error => error.statusCode === 404);
});

test("database failures return safe errors without exposing the external error or creating a grant", async () => {
  const { service, playbackSessions } = fixture();
  playbackSessions.create = async () => { throw new Error("private-db-error https://secret.example"); };
  await assert.rejects(service.issueSession({ body, identity: guest }), error =>
    error.statusCode === 503 && error.errors[0].code === "VIDEO_ANALYTICS_UNAVAILABLE" &&
    !error.message.includes("private"));
});

test("HTTP session issuance accepts verified accounts and does not merge them with matching guest IDs", async t => {
  const { service } = fixture();
  const request = await httpFixture(t, service);
  const previous = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = "test-analytics-authentication-secret";
  t.after(() => {
    if (previous === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = previous;
  });
  t.mock.method(UserModel.collection, "findOne", async () => ({ _id: id,
    role: "user", active: true, phoneVerified: true, account_status: "confirmed" }));
  const token = jwt.sign({ userId: id }, process.env.JWT_ACCESS_SECRET, { expiresIn: "5m" });
  const response = await request({ authorization: `Bearer ${token}`, "x-guest-id": id });
  assert.equal(response.status, 201);
  const { data } = await response.json();
  assert.equal((await service.resolveSession({ ...data, identity: { type: "user", id } })).contentId, id);
  await assert.rejects(service.resolveSession({ ...data, identity: { type: "guest", id } }),
    error => error.statusCode === 404);
});

test("HTTP rate limiting counts rejected attempts and survives guest-ID rotation", async t => {
  const { service } = fixture();
  const request = await httpFixture(t, service);
  for (let attempt = 0; attempt < 120; attempt++) assert.equal((await request()).status, 401);
  const response = await request({ "x-guest-id": "new-guest" });
  assert.equal(response.status, 429);
  assert.deepEqual((await response.json()).error, [{ code: "VIDEO_ANALYTICS_RATE_LIMITED" }]);
  assert.ok(response.headers.has("ratelimit-limit"));
});
