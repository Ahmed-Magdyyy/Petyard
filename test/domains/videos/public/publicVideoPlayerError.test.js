import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import jwt from "jsonwebtoken";

import { createPublicVideoService } from "../../../../src/domains/videos/public/publicVideo.service.js";
import { createPublicVideoRepository } from "../../../../src/domains/videos/public/publicVideo.repository.js";
import { replacementDatabase } from "../productVideos/fixtures/replacementDatabase.js";
import { createPublicVideoRouter } from "../../../../src/domains/videos/public/publicVideo.routes.js";
import { UserModel } from "../../../../src/domains/user/user.model.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";

const id = "507f1f77bcf86cd799439011";
const youtubeId = "dQw4w9WgXcQ";
const guest = { type: "guest", id: "private-reporter" };
const report = { id, identity: guest, body: { youtubeId, reason: "unavailable" } };
const staff = [
  { _id: "507f1f77bcf86cd799439021", role: "superAdmin", active: true },
  { _id: "507f1f77bcf86cd799439022", role: "admin", enabledControls: ["videos"], active: true },
  { _id: "507f1f77bcf86cd799439023", role: "admin", enabledControls: ["products"], active: true },
  { _id: "507f1f77bcf86cd799439024", role: "moderator", enabledControls: ["videos"], active: true },
  { _id: "507f1f77bcf86cd799439025", role: "superAdmin", active: false },
  { _id: "507f1f77bcf86cd799439026", role: "superAdmin", active: true, deletedAt: new Date() },
  { _id: "507f1f77bcf86cd799439027", role: "superAdmin", active: true, account_status: "banned" },
];

function fixture({ video = {}, users = staff, enabled = true } = {}) {
  const clock = { time: Date.parse("2026-10-02T23:59:00Z") };
  const db = replacementDatabase({ products: users.map(user => ({ deletedAt: null, ...user })),
    placements: [{ _id: id, kind: "youtube", status: "published", youtubeId,
      title_en: "Care", revision: 7, ...video }] }, { now: () => clock.time });
  const deliveries = [];
  const create = db.operations.create.bind(db.operations);
  const outbox = { ...db.operations, async create(rows, options) {
    return create(rows.map(row => ({ status: "pending", attempts: 0,
      nextAttemptAt: new Date(clock.time), ...row })), options);
  } };
  const startSession = db.connection.startSession.bind(db.connection);
  db.connection.startSession = async () => {
    const session = await startSession();
    const transaction = session.withTransaction.bind(session);
    session.withTransaction = async work => {
      await transaction(work);
      // Expose only committed commands to the fake notification delivery side.
      deliveries.splice(0, deliveries.length, ...await db.operations.find({}));
    };
    return session;
  };
  const videos = { ...db.placements, async aggregate() {
    const row = await db.placements.findById(id);
    return row?.status === "published" ? [row] : [];
  } };
  const repository = createPublicVideoRepository({ videos, users: db.products,
    outbox, saves: db.saves, connection: db.connection });
  const service = createPublicVideoService({ repository, isEnabled: () => enabled,
    now: () => clock.time });
  return { service, db, deliveries, clock, outbox, videos };
}

test("a YouTube player error records private staff alerts without unpublishing the Video", async () => {
  const { service, deliveries } = fixture();
  assert.deepEqual(await service.reportPlayerError(report), { reported: true });
  assert.deepEqual(deliveries.map(row => row.recipientUser).sort(), [
    "507f1f77bcf86cd799439021", "507f1f77bcf86cd799439022",
  ]);
  assert.ok(deliveries.every(row => row.status === "pending" &&
    row.source.domain === "videos" && row.source.referenceId === id));
  assert.equal(JSON.stringify(deliveries).includes("private-reporter"), false);
  const publicVideo = await service.getVideo({ id });
  assert.equal(publicVideo.youtubeId, youtubeId);
  assert.equal(publicVideo.title, "Care");
});

test("reports deduplicate across identities and reasons, but reset on a UTC day or link change", async () => {
  const { service, deliveries, clock, videos } = fixture();
  await Promise.all(Array.from({ length: 5 }, (_, index) => service.reportPlayerError({ ...report,
    id: id.toUpperCase(), identity: { type: "user", id: `user-${index}` },
    body: { youtubeId, reason: index % 2 ? "embedding_disabled" : "unavailable" } })));
  assert.equal(deliveries.length, 2);
  clock.time = Date.parse("2026-10-03T00:00:00Z");
  await service.reportPlayerError(report);
  assert.equal(deliveries.length, 4);
  await videos.updateOne({ _id: id }, { $set: { youtubeId: "abcdefghijk" } });
  await assert.rejects(service.reportPlayerError(report), error => error.statusCode === 404);
  await service.reportPlayerError({ ...report, body: { youtubeId: "abcdefghijk", reason: "unavailable" } });
  assert.equal(deliveries.length, 6);
});

test("reporting rejects hidden, non-YouTube, missing, stale-link and disabled content", async () => {
  for (const video of [{ status: "draft" }, { status: "unpublished" },
    { kind: "reel" }, { youtubeId: "abcdefghijk" }]) {
    const { service, deliveries } = fixture({ video });
    await assert.rejects(service.reportPlayerError(report), error =>
      error.statusCode === 404 && error.errors[0].code === "VIDEO_NOT_AVAILABLE");
    assert.equal(deliveries.length, 0);
  }
  for (const missing of [false, true]) {
    const { service, deliveries, videos } = fixture({ enabled: missing });
    if (missing) await videos.deleteOne({ _id: id });
    await assert.rejects(service.reportPlayerError(report), error => error.statusCode === 404);
    assert.equal(deliveries.length, 0);
  }
});

test("reporting rejects unbounded/raw client payloads and requires a user or guest identity", async () => {
  const { service, deliveries } = fixture();
  for (const body of [null, [], {}, { youtubeId, reason: 100 },
    { youtubeId, reason: "network_timeout" }, { youtubeId: "https://youtube.example", reason: "unavailable" },
    { youtubeId, reason: "unavailable", message: "private-error-text" },
    { youtubeId, reason: "unavailable", reporterId: "private-reporter" }]) {
    await assert.rejects(service.reportPlayerError({ ...report, body }), error =>
      error.statusCode === 422 && error.errors[0].code === "VIDEO_INVALID_PLAYER_ERROR");
  }
  await assert.rejects(service.reportPlayerError({ ...report, id: "invalid" }), error => error.statusCode === 422);
  for (const identity of [null, { type: "admin", id: "user" }, { type: "guest", id: " " }]) {
    await assert.rejects(service.reportPlayerError({ ...report, identity }), error => error.statusCode === 401);
  }
  assert.equal(deliveries.length, 0);
});

test("an outbox failure rolls back every recipient and can be retried without losing alerts", async () => {
  const { service, deliveries, outbox } = fixture();
  const create = outbox.create;
  let count = 0;
  outbox.create = async (...args) => {
    if (++count === 2) throw new Error("private-db-error https://secret.example");
    return create(...args);
  };
  await assert.rejects(service.reportPlayerError(report), error => error.statusCode === 503 &&
    error.errors[0].code === "VIDEO_REPORT_UNAVAILABLE" && !error.message.includes("private"));
  assert.equal(deliveries.length, 0);
  assert.equal((await service.getVideo({ id })).youtubeId, youtubeId);
  outbox.create = create;
  await service.reportPlayerError(report);
  assert.equal(deliveries.length, 2);
});

test("an acknowledged report does not expose whether eligible staff recipients exist", async () => {
  const { service, deliveries } = fixture({ users: [] });
  assert.deepEqual(await service.reportPlayerError(report), { reported: true });
  assert.equal(deliveries.length, 0);
});

test("a link edit before the owner fence rejects the stale report without alerting for new media", async () => {
  const { service, videos, deliveries } = fixture();
  const update = videos.findOneAndUpdate.bind(videos);
  videos.findOneAndUpdate = async (...args) => {
    await videos.updateOne({ _id: id }, { $set: { youtubeId: "abcdefghijk" } });
    return update(...args);
  };
  await assert.rejects(service.reportPlayerError(report), error => error.statusCode === 404);
  assert.equal(deliveries.length, 0);
});

async function httpFixture(t, service) {
  const app = express();
  app.use(express.json({ limit: "1kb" }));
  app.use("/api/v1/videos", createPublicVideoRouter({ getService: async () => service }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (headers = {}, body = report.body) => fetch(
    `http://127.0.0.1:${server.address().port}/api/v1/videos/${id}/player-errors`,
    { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

test("HTTP player reporting uses real user/guest protection and returns a private acknowledgement", async t => {
  const { service, deliveries } = fixture();
  const request = await httpFixture(t, service);
  assert.equal((await request()).status, 401);
  const guestResponse = await request({ "x-guest-id": "private-http-guest" });
  assert.equal(guestResponse.status, 202);
  assert.equal(guestResponse.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await guestResponse.json(), { data: { reported: true } });
  assert.equal((await request({ authorization: "Bearer invalid", "x-guest-id": "guest" })).status, 401);
  const previous = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = "test-player-error-authentication-secret";
  t.after(() => {
    if (previous === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = previous;
  });
  const userId = "507f1f77bcf86cd799439091";
  t.mock.method(UserModel.collection, "findOne", async filter => String(filter._id) === userId ? {
    _id: userId, role: "user", active: true, phoneVerified: true, account_status: "confirmed",
  } : null);
  const token = jwt.sign({ userId }, process.env.JWT_ACCESS_SECRET, { expiresIn: "5m" });
  assert.equal((await request({ authorization: `Bearer ${token}` })).status, 202);
  assert.equal(deliveries.length, 2, "changing the reporting identity does not duplicate alerts");
  assert.equal(/private-http-guest|439091/.test(JSON.stringify(deliveries)), false);
});

test("HTTP rate limiting cannot be bypassed by rotating guest IDs and returns a safe error", async t => {
  const { service, deliveries } = fixture();
  const request = await httpFixture(t, service);
  for (let index = 0; index < 10; index++) {
    assert.equal((await request({ "x-guest-id": `guest-${index}` })).status, 202);
  }
  const response = await request({ "x-guest-id": "different-guest" });
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.deepEqual(body.error, [{ code: "VIDEO_REPORT_RATE_LIMITED" }]);
  assert.ok(response.headers.has("ratelimit-limit"));
  assert.equal(deliveries.length, 2);
});
