import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { createPublicVideoRepository } from "../../../../src/domains/videos/public/publicVideo.repository.js";
import { createPublicVideoService } from "../../../../src/domains/videos/public/publicVideo.service.js";
import { createPublicVideoRouter } from "../../../../src/domains/videos/public/publicVideo.routes.js";
import { createEditorialVideoService } from "../../../../src/domains/videos/editorial/editorialVideo.service.js";
import { createEditorialVideoRepository } from "../../../../src/domains/videos/editorial/editorialVideo.repository.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";
import { UserModel } from "../../../../src/domains/user/user.model.js";
import { roles } from "../../../../src/shared/constants/enums.js";
import { fixture, id, guest } from "./fixtures/analyticsDatabase.js";

function savedVideos(kind = "youtube") {
  const context = fixture({ kind });
  const stored = [];
  const create = context.events.create;
  context.events.create = async rows => { const result = await create(rows); stored.push(...rows); return result; };
  const repository = createPublicVideoRepository({ videos: context.videos,
    saves: context.db.saves, assets: { ...context.db.assets, collection: { name: "assets" } },
    sessions: { ...context.db.operations, collection: { name: "uploads" } },
    analyticsEvents: context.events, daily: context.daily, connection: context.db.connection });
  const service = createPublicVideoService({ repository,
    isEnabled: () => context.flags.editorial, now: () => context.clock.time });
  return { ...context, analytics: context.service, service, stored };
}

test("actual save additions and removals create one server event each, not one per retry", async () => {
  const { service, stored } = savedVideos();
  const request = { id, identity: guest };
  assert.deepEqual(await service.save(request), { videoId: id, isSaved: true });
  assert.equal((await service.getVideo(request)).isSaved, true);
  await service.save(request);
  assert.deepEqual(await service.unsave(request), { videoId: id, isSaved: false });
  assert.equal((await service.getVideo(request)).isSaved, false);
  await service.unsave(request);
  assert.deepEqual(stored.map(event => event.type), ["save_added", "save_removed"]);
});

test("YouTube and Reel transitions store only server-generated, anonymous raw-event fields", async () => {
  for (const kind of ["youtube", "reel"]) {
    const { service, stored, clock } = savedVideos(kind);
    await service.save({ id, identity: guest });
    clock.time += 1000;
    await service.unsave({ id, identity: guest });
    for (const event of stored) {
      assert.deepEqual(Object.keys(event).sort(), ["eventId", "type", "contentId", "kind", "counted",
        "occurredAt", "receivedAt", "expiresAt"].sort());
      assert.match(event.eventId, /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
      assert.equal(event.kind, kind);
      assert.equal(event.counted, true);
      assert.equal(event.expiresAt - event.receivedAt, 30 * 24 * 60 * 60 * 1000);
    }
    assert.equal(stored[0].occurredAt.toISOString(), "2026-10-02T20:00:00.000Z");
    assert.equal(stored[1].occurredAt.toISOString(), "2026-10-02T20:00:01.000Z");
    assert.notEqual(stored[0].eventId, stored[1].eventId);
    assert.equal(JSON.stringify(stored).includes(guest.id), false);
  }
});

test("guest and account transitions remain separate even when their identity strings match", async () => {
  const { service, stored } = savedVideos();
  const account = { type: "user", id };
  const matchingGuest = { type: "guest", id };
  await service.save({ id, identity: account });
  await service.save({ id, identity: matchingGuest });
  await service.unsave({ id, identity: matchingGuest });
  assert.equal((await service.getVideo({ id, identity: account })).isSaved, true);
  assert.equal((await service.getVideo({ id, identity: matchingGuest })).isSaved, false);
  assert.deepEqual(stored.map(event => event.type), ["save_added", "save_added", "save_removed"]);
});

test("re-saving after removal is a new transition, not a suppressed retry", async () => {
  const { service, stored } = savedVideos();
  const request = { id, identity: guest };
  await service.save(request);
  await service.unsave(request);
  await service.save(request);
  assert.deepEqual(stored.map(event => event.type), ["save_added", "save_removed", "save_added"]);
  assert.equal(new Set(stored.map(event => event.eventId)).size, 3);
});

test("hidden saves can be removed without permitting new saves for hidden content", async () => {
  const { service, videos, stored } = savedVideos();
  const request = { id, identity: guest };
  await service.save(request);
  await videos.updateOne({ _id: id }, { $set: { status: "unpublished" } });
  await assert.rejects(service.save(request), error => error.statusCode === 404);
  assert.deepEqual(await service.unsave(request), { videoId: id, isSaved: false });
  await videos.updateOne({ _id: id }, { $set: { status: "published" } });
  assert.equal((await service.getVideo(request)).isSaved, false);
  assert.deepEqual(stored.map(event => event.type), ["save_added", "save_removed"]);
});

test("disabled, absent and Product Video saves cannot create customer events", async () => {
  const { service, flags, videos, stored } = savedVideos();
  flags.editorial = false;
  for (const method of ["save", "unsave"]) {
    await assert.rejects(service[method]({ id, identity: guest }), error => error.statusCode === 404);
  }
  flags.editorial = true;
  await videos.deleteOne({ _id: id });
  await assert.rejects(service.save({ id, identity: guest }), error => error.statusCode === 404);
  assert.deepEqual(await service.unsave({ id, identity: guest }), { videoId: id, isSaved: false });
  // The Product Video placement remains in its separate collection.
  assert.equal(stored.length, 0);
});

test("failed addition analytics rolls back the save and returns a safe retryable error", async () => {
  const { service, events } = savedVideos();
  const create = events.create;
  events.create = async rows => { await create(rows); throw new Error("private-db https://secret.example"); };
  const request = { id, identity: guest };
  await assert.rejects(service.save(request), error => error.statusCode === 503 &&
    error.errors[0].code === "VIDEO_SAVE_UNAVAILABLE" && !error.message.includes("private-db"));
  assert.equal((await service.getVideo(request)).isSaved, false);
  events.create = create;
  await service.save(request);
  assert.equal((await service.getVideo(request)).isSaved, true);
});

test("failed removal analytics restores the save and can be retried", async () => {
  const { service, events } = savedVideos();
  const request = { id, identity: guest };
  await service.save(request);
  const create = events.create;
  events.create = async rows => { await create(rows); throw new Error("private storage failure"); };
  await assert.rejects(service.unsave(request), error => error.statusCode === 503 &&
    error.errors[0].code === "VIDEO_SAVE_UNAVAILABLE");
  assert.equal((await service.getVideo(request)).isSaved, true);
  events.create = create;
  await service.unsave(request);
  assert.equal((await service.getVideo(request)).isSaved, false);
});

test("concurrent identical actions record one transition with the fake transactional adapter", async () => {
  const { service, stored } = savedVideos();
  const request = { id, identity: guest };
  await Promise.all([service.save(request), service.save(request)]);
  await Promise.all([service.unsave(request), service.unsave(request)]);
  assert.deepEqual(stored.map(event => event.type), ["save_added", "save_removed"]);
});

test("the existing duplicate-key recovery commits one addition after an aborted attempt", async () => {
  const { service, events, stored } = savedVideos();
  const create = events.create;
  let first = true;
  events.create = async rows => {
    if (first) { first = false; throw Object.assign(new Error("duplicate"), { code: 11000 }); }
    return create(rows);
  };
  await service.save({ id, identity: guest });
  assert.equal((await service.getVideo({ id, identity: guest })).isSaved, true);
  assert.deepEqual(stored.map(event => event.type), ["save_added"]);
});

test("permanent editorial deletion cleans saves without recording a customer removal", async () => {
  const { service, analytics, videos, db, clock, stored } = savedVideos();
  await videos.updateOne({ _id: id }, { $set: { revision: 3 } });
  // Remove unused synthetic Reel media from this YouTube-only fixture.
  await db.assets.deleteMany({ ownerId: id });
  const editorial = createEditorialVideoService({ repository: createEditorialVideoRepository({
    assertAuthority: async () => {},
    videos, connection: db.connection, reelLifecycle: {}, deletion: { saves: db.saves,
      assets: db.assets, sessions: db.operations, covers: db.covers, placements: db.replacements } }),
    verifyYouTube: async () => assert.fail("deletion does not verify YouTube"),
    enqueue: async () => assert.fail("YouTube deletion has no provider cleanup"), now: () => new Date(clock.time) });
  await service.save({ id, identity: guest });
  await editorial.deletePermanently({ id, actor: { id, role: roles.SUPER_ADMIN }, input: { revision: 3 } });
  await service.unsave({ id, identity: guest });
  assert.deepEqual(stored.map(event => event.type), ["save_added"]);
  const report = await analytics.listDailyReport({ actor: { id, role: roles.SUPER_ADMIN } });
  assert.equal(report.data[0].metrics.saveAdditions, 1);
  assert.equal(report.data[0].metrics.saveRemovals, 0);
  await assert.rejects(service.getVideo({ id, identity: guest }), error => error.statusCode === 404);
});

test("client analytics cannot submit server-only save transition types", async () => {
  const { service, clock } = fixture();
  const session = await service.issueSession({ body: { kind: "youtube", contentId: id }, identity: guest });
  for (const type of ["save", "save_added", "save_removed"]) {
    await assert.rejects(service.ingestEvents({ body: { events: [{ type, eventId: randomUUID(),
      playbackSessionId: session.playbackSessionId, occurredAt: new Date(clock.time).toISOString() }] }, identity: guest }),
    error => error.statusCode === 422 && error.errors[0].code === "VIDEO_INVALID_ANALYTICS_EVENTS");
  }
});

async function httpFixture(t, service) {
  t.mock.method(console, "warn", () => {});
  const app = express();
  app.use(express.json());
  app.use("/videos", createPublicVideoRouter({ getService: async () => service }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (method, headers = { "x-guest-id": guest.id }) => fetch(
    `http://127.0.0.1:${server.address().port}/videos/saved/${id}`, { method, headers });
}

test("save HTTP routes use real authentication and return the unchanged private response", async t => {
  const { service, stored } = savedVideos();
  const request = await httpFixture(t, service);
  assert.equal((await request("PUT", {})).status, 401);
  const added = await request("PUT");
  assert.equal(added.status, 200);
  assert.equal(added.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await added.json(), { data: { videoId: id, isSaved: true } });
  assert.equal((await request("PUT")).status, 200);
  const removed = await request("DELETE");
  assert.equal(removed.status, 200);
  assert.equal(removed.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await removed.json(), { data: { videoId: id, isSaved: false } });
  assert.equal((await request("DELETE")).status, 200);
  assert.equal((await request("PUT", { authorization: "Bearer invalid", "x-guest-id": guest.id })).status, 401);
  assert.deepEqual(stored.map(event => event.type), ["save_added", "save_removed"]);
});

test("authenticated saves do not use or merge a matching guest header", async t => {
  const { service, stored } = savedVideos();
  const request = await httpFixture(t, service);
  const previous = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = "test-save-analytics-auth-secret";
  t.after(() => {
    if (previous === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = previous;
  });
  t.mock.method(UserModel.collection, "findOne", async () => ({ _id: id,
    role: "user", active: true, phoneVerified: true, account_status: "confirmed" }));
  const token = jwt.sign({ userId: id }, process.env.JWT_ACCESS_SECRET, { expiresIn: "5m" });
  assert.equal((await request("PUT", { authorization: `Bearer ${token}`, "x-guest-id": id })).status, 200);
  assert.equal((await request("DELETE", { "x-guest-id": id })).status, 200);
  assert.equal((await service.getVideo({ id, identity: { type: "user", id } })).isSaved, true);
  assert.deepEqual(stored.map(event => event.type), ["save_added"]);
});
