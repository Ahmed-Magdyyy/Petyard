import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import { UserModel } from "../../../../src/domains/user/user.model.js";
import { createVideoAnalyticsRouter } from "../../../../src/domains/videos/analytics/videoAnalytics.routes.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";
import { fixture, body, guest, id, assetId, productId, uploadId } from "./fixtures/analyticsDatabase.js";

async function prepared(kind = "youtube") {
  const context = fixture({ kind });
  const session = await context.service.issueSession({ body: { kind, contentId: id }, identity: guest });
  context.clock.time += 1000;
  const event = (type = "share", changes = {}) => ({ eventId: randomUUID(),
    playbackSessionId: session.playbackSessionId, type,
    occurredAt: new Date(context.clock.time).toISOString(), ...changes });
  const ingest = (events, identity = guest) => context.service.ingestEvents({ body: { events }, identity });
  return { ...context, session, event, ingest };
}

const rejectsCode = (promise, status, code) => assert.rejects(promise, error =>
  error.statusCode === status && error.errors[0].code === code);

async function httpFixture(t, service) {
  t.mock.method(console, "warn", () => {});
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use("/analytics", createVideoAnalyticsRouter({ getService: async () => service }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (body, headers = { "x-guest-id": guest.id }) => fetch(
    `http://127.0.0.1:${server.address().port}/analytics/events`,
    { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

test("HTTP ingestion authenticates the owner and returns only a private acknowledgement", async t => {
  const { service, clock } = fixture();
  const { playbackSessionId } = await service.issueSession({ body, identity: guest });
  clock.time += 1000;
  const payload = { events: [{ eventId: randomUUID(), playbackSessionId,
    type: "share", occurredAt: new Date(clock.time).toISOString() }] };
  const request = await httpFixture(t, service);
  assert.equal((await request(payload, {})).status, 401);
  const response = await request(payload);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { data: { accepted: 1, duplicates: 0 } });
  assert.equal((await request(payload, { "x-guest-id": "other-owner" })).status, 404);
  assert.equal((await request(payload, { authorization: "Bearer invalid", "x-guest-id": guest.id })).status, 401);
});

test("a batch commits once and exact retries do not count events twice", async () => {
  const { service, clock } = fixture();
  const session = await service.issueSession({ body, identity: guest });
  clock.time += 1000;
  const events = ["impression", "share"].map(type => ({ eventId: randomUUID(),
    playbackSessionId: session.playbackSessionId, type, occurredAt: "2026-10-02T23:00:01+03:00" }));
  assert.deepEqual(await service.ingestEvents({ body: { events }, identity: guest }),
    { accepted: 2, duplicates: 0 });
  assert.deepEqual(await service.ingestEvents({ body: { events }, identity: guest }),
    { accepted: 0, duplicates: 2 });
});

test("UUID casing and equivalent explicit time offsets normalize to an exact retry", async () => {
  const { event, ingest } = await prepared();
  const item = event();
  assert.deepEqual(await ingest([item]), { accepted: 1, duplicates: 0 });
  assert.deepEqual(await ingest([{ ...item, eventId: item.eventId.toUpperCase(),
    playbackSessionId: item.playbackSessionId.toUpperCase(), occurredAt: "2026-10-02T23:00:01+03:00" }]),
  { accepted: 0, duplicates: 1 });
});

test("a conflicting reuse rolls back the entire batch, including other sessions", async () => {
  const { service, session, event, ingest } = await prepared();
  const second = await service.issueSession({ body, identity: guest });
  const [firstId, lastId] = [session.playbackSessionId, second.playbackSessionId].sort();
  const committed = event("share", { playbackSessionId: lastId });
  await ingest([committed]);
  // The valid group is processed first, so the later conflict must undo it.
  const fresh = event("share", { playbackSessionId: firstId });
  await rejectsCode(ingest([fresh, { ...committed, type: "playback_error", reason: "network" }]),
    409, "VIDEO_ANALYTICS_EVENT_CONFLICT");
  assert.deepEqual(await ingest([fresh, committed]), { accepted: 1, duplicates: 1 });
});

test("same-batch duplicates consume one slot and conflicting same-batch payloads consume none", async () => {
  const { event, ingest } = await prepared();
  const item = event();
  assert.deepEqual(await ingest([item, item]), { accepted: 1, duplicates: 1 });
  const fresh = event();
  await rejectsCode(ingest([fresh, { ...fresh, type: "impression" }]), 409, "VIDEO_ANALYTICS_EVENT_CONFLICT");
  assert.deepEqual(await ingest([fresh]), { accepted: 1, duplicates: 0 });
});

test("five hundred distinct events are allowed; retries do not consume the ceiling", async () => {
  const { event, ingest } = await prepared();
  let previous;
  for (let batch = 0; batch < 10; batch++) {
    previous = Array.from({ length: 50 }, () => event());
    assert.deepEqual(await ingest(previous), { accepted: 50, duplicates: 0 });
  }
  assert.deepEqual(await ingest(previous), { accepted: 0, duplicates: 50 });
  await rejectsCode(ingest([previous[0], event()]), 409, "VIDEO_ANALYTICS_SESSION_LIMIT");
  assert.deepEqual(await ingest(previous), { accepted: 0, duplicates: 50 });
});

test("new events must be chronological, but older exact retries are harmless", async () => {
  const { event, ingest, clock } = await prepared();
  const old = event();
  await ingest([old]);
  clock.time += 6 * 60 * 1000;
  await ingest([event()]);
  assert.deepEqual(await ingest([old]), { accepted: 0, duplicates: 1 });
  await rejectsCode(ingest([event("share", { occurredAt: new Date(clock.time - 1).toISOString() })]),
    422, "VIDEO_INVALID_ANALYTICS_EVENTS");
});

test("new-event time limits are absolute instants with inclusive boundaries", async () => {
  const offsets = [-300001, -300000, 30000, 30001];
  for (const offset of offsets) {
    const { clock, event, ingest } = await prepared();
    clock.time += 6 * 60 * 1000;
    const promise = ingest([event("share", { occurredAt: new Date(clock.time + offset).toISOString() })]);
    if (offset === -300001 || offset === 30001) await rejectsCode(promise, 422, "VIDEO_INVALID_ANALYTICS_EVENTS");
    else assert.deepEqual(await promise, { accepted: 1, duplicates: 0 });
  }
  for (const offset of [-30001, -30000]) {
    const { clock, event, ingest } = await prepared();
    const promise = ingest([event("share", { occurredAt: new Date(clock.time - 1000 + offset).toISOString() })]);
    if (offset === -30001) await rejectsCode(promise, 422, "VIDEO_INVALID_ANALYTICS_EVENTS");
    else assert.equal((await promise).accepted, 1);
  }
});

test("impressions require at least one elapsed second and count only once per session", async () => {
  const { clock, event, ingest, events } = await prepared();
  clock.time -= 1;
  await rejectsCode(ingest([event("impression")]), 422, "VIDEO_INVALID_ANALYTICS_EVENTS");
  clock.time += 1;
  const stored = [];
  const create = events.create;
  events.create = async rows => { stored.push(...rows); return create(rows); };
  assert.equal((await ingest([event("impression"), event("impression")])).accepted, 2);
  assert.deepEqual(stored.map(row => row.counted), [true, false]);
});

test("raw events have no viewer identifiers, IP addresses, locations or provider URLs", async () => {
  const { event, ingest, events } = await prepared();
  let stored;
  const create = events.create;
  events.create = async rows => { stored = rows; return create(rows); };
  await ingest([event("playback_error", { reason: "embedding_disabled" })]);
  assert.deepEqual(Object.keys(stored[0]).sort(), ["eventId", "playbackSessionId", "type", "occurredAt",
    "reason", "kind", "contentId", "payloadHash", "counted", "receivedAt", "expiresAt"].sort());
  assert.equal(stored[0].expiresAt - stored[0].receivedAt, 30 * 24 * 60 * 60 * 1000);
  assert.equal(JSON.stringify(stored).includes(guest.id), false);
});

test("expired, disabled and wrong-owner sessions reject even exact retries", async () => {
  for (const mode of ["expired", "disabled", "wrong-owner", "typed-owner", "unknown"]) {
    const { clock, flags, event, ingest } = await prepared();
    const item = event();
    await ingest([item]);
    if (mode === "expired") clock.time += 30 * 60 * 1000;
    if (mode === "disabled") flags.editorial = false;
    const identity = mode === "wrong-owner" ? { type: "guest", id: "other-owner" }
      : mode === "typed-owner" ? { type: "user", id } : guest;
    await rejectsCode(ingest([mode === "unknown" ? { ...item, playbackSessionId: randomUUID() } : item], identity),
      404, "VIDEO_ANALYTICS_SESSION_NOT_AVAILABLE");
  }
  const { service } = fixture();
  const owner = { type: "user", id };
  const session = await service.issueSession({ body, identity: owner });
  await rejectsCode(service.ingestEvents({ body: { events: [{ eventId: randomUUID(),
    playbackSessionId: session.playbackSessionId, type: "share", occurredAt: "2026-10-02T20:00:00Z" }] },
    identity: { type: "guest", id } }), 404, "VIDEO_ANALYTICS_SESSION_NOT_AVAILABLE");
});

test("current media, publication, provider acceptance and product availability are checked at ingestion", async () => {
  const cases = [
    ["youtube", db => db.placements.updateOne({ _id: id }, { $set: { youtubeId: "abcdefghijk" } })],
    ["youtube", db => db.placements.updateOne({ _id: id }, { $set: { status: "unpublished" } })],
    ["youtube", db => db.placements.deleteOne({ _id: id })],
    ["reel", db => db.placements.updateOne({ _id: id }, { $set: { activeAssetId: productId } })],
    ["reel", db => db.operations.updateOne({ _id: uploadId }, { $set: { status: "cancelled" } })],
    ["reel", db => db.assets.updateOne({ _id: assetId }, { $set: { ownerId: productId } })],
    ["reel", db => db.assets.updateOne({ _id: assetId }, { $set: { durationSeconds: 20 } })],
    ["product", db => db.products.updateOne({ _id: productId }, { $set: { isActive: false } })],
    ["product", db => db.products.deleteOne({ _id: productId })],
    ["product", db => db.replacements.updateOne({ _id: id }, { $set: { removedAt: new Date() } })],
    ["product", db => db.assets.updateOne({ _id: assetId }, { $set: { deleteAcceptedAt: new Date() } })],
  ];
  for (const [kind, change] of cases) {
    const { db, event, ingest } = await prepared(kind);
    await change(db);
    await rejectsCode(ingest([event()]), 404, "VIDEO_ANALYTICS_SESSION_NOT_AVAILABLE");
  }
});

test("all three types accept basic metrics; product pending deletion and gallery-only media remain eligible", async () => {
  for (const kind of ["youtube", "reel", "product"]) {
    const { db, event, ingest } = await prepared(kind);
    if (kind === "product") {
      await db.replacements.updateOne({ _id: id }, { $set: { lifecycleState: "deleting", showInReelsFeed: false } });
      await db.assets.updateOne({ _id: assetId }, { $set: { deletionRequestedAt: new Date() } });
    }
    assert.deepEqual(await ingest([event("impression"), event("share"), event("playback_error", { reason: "network" })]),
      { accepted: 3, duplicates: 0 });
  }
});

test("database failure rolls back the batch and returns no private storage details", async () => {
  const { events, event, ingest } = await prepared();
  const items = [event(), event()];
  const create = events.create;
  events.create = async rows => { await create(rows); throw new Error("private-db https://secret.example"); };
  await rejectsCode(ingest(items), 503, "VIDEO_ANALYTICS_UNAVAILABLE");
  events.create = create;
  assert.deepEqual(await ingest(items), { accepted: 2, duplicates: 0 });
});

test("failed owner fences and flags changed during storage cannot commit events", async () => {
  for (const mode of ["owner", "flag", "expiry"]) {
    const { events, videos, flags, clock, event, ingest } = await prepared();
    const item = event();
    const create = events.create;
    const update = videos.findOneAndUpdate;
    if (mode === "owner") videos.findOneAndUpdate = () => Promise.resolve(null);
    else events.create = async rows => {
      await create(rows);
      if (mode === "flag") flags.editorial = false;
      else clock.time += 30 * 60 * 1000;
    };
    await rejectsCode(ingest([item]), 404, "VIDEO_ANALYTICS_SESSION_NOT_AVAILABLE");
    events.create = create;
    videos.findOneAndUpdate = update;
    flags.editorial = true;
    clock.time = Date.parse("2026-10-02T20:00:01Z");
    assert.deepEqual(await ingest([item]), { accepted: 1, duplicates: 0 });
  }
});

test("concurrent exact submissions acknowledge one insertion and one duplicate with the fake transactional adapter", async () => {
  const { event, ingest } = await prepared();
  const item = event();
  const results = await Promise.all([ingest([item]), ingest([item])]);
  assert.deepEqual(results, [{ accepted: 1, duplicates: 0 }, { accepted: 0, duplicates: 1 }]);
});

test("YouTube native playback metrics remain explicitly unavailable without verified callbacks and duration", async () => {
  const { event, ingest } = await prepared("youtube");
  for (const type of ["play_start", "watch_time", "progress_25", "progress_50", "progress_75", "complete", "replay", "rebuffer"]) {
    const fields = ["watch_time", "rebuffer"].includes(type) ? { durationMs: 1 }
      : type.startsWith("progress_") || type === "complete" ? { positionSeconds: 0 } : {};
    await rejectsCode(ingest([event("share"), event(type, fields)]), 422, "VIDEO_ANALYTICS_METRIC_NOT_AVAILABLE");
  }
});

test("malformed batches, unsafe fields, unknown types and ambiguous timestamps are rejected", async () => {
  const { service, event } = await prepared();
  const item = event();
  const badBodies = [null, [], {}, { events: [] }, { events: Array.from({ length: 51 }, () => item) },
    { events: [item], identityId: guest.id }, { events: [null] }, { events: [[item]] },
    ...["save", "qualified_view", "other"].map(type => ({ events: [{ ...item, type }] })),
    ...["viewerId", "ip", "url", "message", "positionSeconds", "durationMs"].map(key => ({ events: [{ ...item, [key]: "private" }] })),
    ...["", "2026-10-02T20:00:01", "2026-02-30T20:00:01Z", "2026-10-02T24:00:00Z",
      "2026-10-02T20:00:01+24:00", "2026-10-02T20:00:01+03:60", "2026-10-02T20:00:01.1234Z", 123].map(occurredAt =>
      ({ events: [{ ...item, occurredAt }] })),
    { events: [{ ...item, eventId: "not-a-uuid" }] },
    { events: [{ ...item, type: "playback_error" }] },
    { events: [{ ...item, type: "playback_error", reason: "raw-private-message" }] }];
  for (const payload of badBodies) {
    await rejectsCode(service.ingestEvents({ body: payload, identity: guest }), 422, "VIDEO_INVALID_ANALYTICS_EVENTS");
  }
  await rejectsCode(service.ingestEvents({ body: { events: [{ ...item, playbackSessionId: "not-a-session" }] },
    identity: guest }), 404, "VIDEO_ANALYTICS_SESSION_NOT_AVAILABLE");
});

test("HTTP caps logical UTF-8 JSON at 64 KiB and rejects an invalid batch without storing its valid part", async t => {
  const { service, event } = await prepared();
  const request = await httpFixture(t, service);
  const item = event();
  const large = await request({ events: [item], extra: "🐈".repeat(20000) });
  assert.equal(large.status, 413);
  assert.equal((await large.json()).error[0].code, "VIDEO_ANALYTICS_PAYLOAD_TOO_LARGE");
  const rejected = await request({ events: [item, { ...item, eventId: randomUUID(), url: "https://private.example" }] });
  assert.equal(rejected.status, 422);
  assert.deepEqual(await (await request({ events: [item] })).json(), { data: { accepted: 1, duplicates: 0 } });
});

test("HTTP event limiting counts rejected attempts independently of session issuance", async t => {
  const { service } = fixture();
  const request = await httpFixture(t, service);
  for (let attempt = 0; attempt < 60; attempt++) assert.equal((await request({ events: [] }, {})).status, 401);
  const response = await request({ events: [] }, { "x-guest-id": "rotated-guest" });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error[0].code, "VIDEO_ANALYTICS_RATE_LIMITED");
});

test("HTTP account authentication wins over a matching guest header without merging identities", async t => {
  const { service, clock } = fixture();
  const session = await service.issueSession({ body, identity: { type: "user", id } });
  clock.time += 1000;
  const request = await httpFixture(t, service);
  const previous = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = "test-analytics-ingestion-secret";
  t.after(() => {
    if (previous === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = previous;
  });
  t.mock.method(UserModel.collection, "findOne", async () => ({ _id: id,
    role: "user", active: true, phoneVerified: true, account_status: "confirmed" }));
  const token = jwt.sign({ userId: id }, process.env.JWT_ACCESS_SECRET, { expiresIn: "5m" });
  const payload = { events: [{ eventId: randomUUID(), playbackSessionId: session.playbackSessionId,
    type: "share", occurredAt: new Date(clock.time).toISOString() }] };
  assert.equal((await request(payload, { "x-guest-id": id })).status, 404);
  const response = await request(payload, { authorization: `Bearer ${token}`, "x-guest-id": id });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { accepted: 1, duplicates: 0 } });
});
