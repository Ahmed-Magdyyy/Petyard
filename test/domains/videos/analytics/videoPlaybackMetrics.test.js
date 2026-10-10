import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { createVideoAnalyticsRouter } from "../../../../src/domains/videos/analytics/videoAnalytics.routes.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";
import { fixture, id, assetId, guest } from "./fixtures/analyticsDatabase.js";

async function playback(kind = "reel", durationSeconds = 18) {
  const context = fixture({ kind });
  if (kind !== "youtube") await context.db.assets.updateOne({ _id: assetId }, { $set: { durationSeconds } });
  const session = await context.service.issueSession({ body: { kind, contentId: id }, identity: guest });
  const stored = [];
  const create = context.events.create;
  // Observe the external storage boundary, not private metric functions.
  context.events.create = async rows => { const result = await create(rows); stored.push(...rows); return result; };
  const event = (type, fields = {}) => ({ eventId: randomUUID(), playbackSessionId: session.playbackSessionId,
    type, occurredAt: new Date(context.clock.time).toISOString(), ...fields });
  const ingest = events => context.service.ingestEvents({ body: { events }, identity: guest });
  return { ...context, session, stored, event, ingest };
}

const invalid = promise => assert.rejects(promise, error => error.statusCode === 422 &&
  error.errors[0].code === "VIDEO_INVALID_ANALYTICS_EVENTS");

test("uploaded playback starts and replays count once per session, while exact retries remain duplicates", async () => {
  for (const kind of ["reel", "product"]) {
    const { event, ingest, stored } = await playback(kind);
    const start = event("play_start");
    const replay = event("replay");
    assert.deepEqual(await ingest([start, replay, event("play_start"), event("replay")]),
      { accepted: 4, duplicates: 0 });
    assert.deepEqual(stored.map(row => row.counted), [true, true, false, false]);
    assert.deepEqual(await ingest([start, replay]), { accepted: 0, duplicates: 2 });
  }
});

test("admitted watch intervals derive one qualified view in the chunk crossing two seconds", async () => {
  const { clock, event, ingest, stored } = await playback();
  await ingest([event("play_start")]);
  clock.time += 1000;
  const first = event("watch_time", { durationMs: 1000 });
  assert.deepEqual(await ingest([first]), { accepted: 1, duplicates: 0 });
  clock.time += 1000;
  const crossing = event("watch_time", { durationMs: 1000 });
  await ingest([crossing]);
  clock.time += 5000;
  await ingest([event("watch_time", { durationMs: 5000 })]);
  assert.deepEqual(stored.filter(row => row.type === "watch_time").map(row => row.qualifiedViewCounted),
    [false, true, false]);
  assert.deepEqual(await ingest([first, crossing]), { accepted: 0, duplicates: 2 });
});

test("uploaded progress and completion require admitted watch time and count each metric once", async () => {
  const { clock, event, ingest, stored } = await playback();
  await ingest([event("play_start")]);
  for (const [type, positionSeconds] of [["progress_25", 4.5], ["progress_50", 9], ["progress_75", 13.5]]) {
    clock.time += 4500;
    await ingest([event("watch_time", { durationMs: 4500 }), event(type, { positionSeconds }),
      event(type, { positionSeconds })]);
  }
  clock.time += 3600;
  await ingest([event("watch_time", { durationMs: 3600 }), event("complete", { positionSeconds: 18 }),
    event("complete", { positionSeconds: 18 })]);
  assert.deepEqual(stored.filter(row => row.type.startsWith("progress_") || row.type === "complete")
    .map(row => [row.type, row.counted]), [["progress_25", true], ["progress_25", false],
      ["progress_50", true], ["progress_50", false], ["progress_75", true], ["progress_75", false],
      ["complete", true], ["complete", false]]);
});

test("a buffering episode after playback starts does not grant watch time or progress", async () => {
  const { clock, event, ingest, stored } = await playback();
  await ingest([event("play_start")]);
  clock.time += 2000;
  await ingest([event("watch_time", { durationMs: 2000 })]);
  clock.time += 3000;
  const episode = event("rebuffer", { durationMs: 3000 });
  assert.deepEqual(await ingest([episode]), { accepted: 1, duplicates: 0 });
  await invalid(ingest([event("progress_25", { positionSeconds: 4.5 })]));
  assert.deepEqual(await ingest([episode]), { accepted: 0, duplicates: 1 });
  assert.equal(stored.find(row => row.type === "rebuffer").qualifiedViewCounted, undefined);
  clock.time += 2500;
  assert.equal((await ingest([event("watch_time", { durationMs: 2500 }),
    event("progress_25", { positionSeconds: 4.5 })])).accepted, 2);
});

test("overlapping watch intervals are invalid, including callbacks with new event IDs", async () => {
  const { clock, event, ingest } = await playback();
  await ingest([event("play_start")]);
  clock.time += 1000;
  const first = event("watch_time", { durationMs: 1000 });
  await ingest([first]);
  await invalid(ingest([{ ...first, eventId: randomUUID() }]));
  clock.time += 1000;
  await invalid(ingest([event("watch_time", { durationMs: 1001 })]));
  assert.deepEqual(await ingest([event("watch_time", { durationMs: 1000 })]), { accepted: 1, duplicates: 0 });
});

test("a watch interval cannot include time before a reported actual playback start", async () => {
  const { clock, event, ingest } = await playback();
  clock.time += 1000;
  await ingest([event("play_start")]);
  clock.time += 1000;
  await invalid(ingest([event("watch_time", { durationMs: 1001 })]));
  assert.equal((await ingest([event("watch_time", { durationMs: 1000 })])).accepted, 1);
});

test("non-overlapping clock-skewed watch chunks still cannot exceed elapsed server time", async () => {
  const { clock, event, ingest } = await playback();
  const issuedAt = clock.time;
  await ingest([event("play_start", { occurredAt: new Date(issuedAt - 30000).toISOString() })]);
  clock.time += 1000;
  await ingest([event("watch_time", { durationMs: 1000, occurredAt: new Date(issuedAt - 29000).toISOString() })]);
  await invalid(ingest([event("watch_time", { durationMs: 1000,
    occurredAt: new Date(issuedAt - 28000).toISOString() })]));
  clock.time += 1000;
  assert.equal((await ingest([event("watch_time", { durationMs: 1000,
    occurredAt: new Date(issuedAt - 28000).toISOString() })])).accepted, 1);
});

test("watch intervals cannot extend before the issuance clock-tolerance boundary", async () => {
  const { clock, event, ingest } = await playback();
  const issuedAt = clock.time;
  clock.time += 1000;
  await invalid(ingest([event("watch_time", { durationMs: 1,
    occurredAt: new Date(issuedAt - 30000).toISOString() })]));
  assert.equal((await ingest([event("watch_time", { durationMs: 1,
    occurredAt: new Date(issuedAt - 29999).toISOString() })])).accepted, 1);
});

test("invalid milestone conditions roll back preceding watch chunks and qualified-view state", async () => {
  const { clock, event, ingest, stored } = await playback();
  await ingest([event("play_start")]);
  clock.time += 4500;
  await invalid(ingest([event("watch_time", { durationMs: 4499 }), event("progress_25", { positionSeconds: 4.5 })]));
  await invalid(ingest([event("watch_time", { durationMs: 4500 }), event("progress_25", { positionSeconds: 4.499 })]));
  await invalid(ingest([event("progress_25", { positionSeconds: 18 })]));
  assert.deepEqual(await ingest([event("watch_time", { durationMs: 4500 }), event("progress_25", { positionSeconds: 4.5 })]),
    { accepted: 2, duplicates: 0 });
  assert.equal(stored.at(-2).qualifiedViewCounted, true);
});

test("seeking to the end without watched time cannot earn milestones or completion", async () => {
  const { clock, event, ingest } = await playback();
  await ingest([event("play_start")]);
  clock.time += 18000;
  for (const type of ["progress_25", "progress_50", "progress_75", "complete"]) {
    await invalid(ingest([event(type, { positionSeconds: 18 })]));
  }
});

test("completion requires both 95 percent admitted watch and position in the final second", async () => {
  const { clock, event, ingest } = await playback();
  await ingest([event("play_start")]);
  clock.time += 10000;
  await ingest([event("watch_time", { durationMs: 10000 })]);
  clock.time += 7099;
  await ingest([event("watch_time", { durationMs: 7099 })]);
  await invalid(ingest([event("complete", { positionSeconds: 18 })]));
  clock.time += 1;
  await ingest([event("watch_time", { durationMs: 1 })]);
  await invalid(ingest([event("complete", { positionSeconds: 16.999 })]));
  await invalid(ingest([event("complete", { positionSeconds: 18.001 })]));
  assert.equal((await ingest([event("complete", { positionSeconds: 17 })])).accepted, 1);
});

test("a short Product Video may complete without a two-second qualified view", async () => {
  const { clock, event, ingest, stored } = await playback("product", 1);
  await ingest([event("play_start")]);
  clock.time += 950;
  await ingest([event("watch_time", { durationMs: 950 }), event("complete", { positionSeconds: 1 })]);
  assert.equal(stored.find(row => row.type === "watch_time").qualifiedViewCounted, false);
  assert.equal(stored.find(row => row.type === "complete").counted, true);
});

test("a later milestone does not invent intermediate milestones", async () => {
  const { clock, event, ingest, stored } = await playback();
  await ingest([event("play_start")]);
  clock.time += 10000;
  await ingest([event("watch_time", { durationMs: 10000 })]);
  clock.time += 3500;
  await ingest([event("watch_time", { durationMs: 3500 }), event("progress_75", { positionSeconds: 13.5 })]);
  assert.deepEqual(stored.map(row => row.type), ["play_start", "watch_time", "watch_time", "progress_75"]);
});

test("watch chunks accept one millisecond through ten seconds and reject unsafe numeric or extra fields", async () => {
  const { clock, event, ingest } = await playback();
  clock.time += 10000;
  for (const durationMs of [undefined, null, 0, -1, 10001, 1.5, "1000", NaN, Infinity]) {
    await invalid(ingest([event("watch_time", { durationMs })]));
  }
  for (const fields of [{ durationMs: 1000, qualifiedViewCounted: true }, { durationMs: 1000, visible: true },
    { durationMs: 1000, positionSeconds: 2 }, { positionSeconds: 18, ended: true }]) {
    await invalid(ingest([event(fields.ended ? "complete" : "watch_time", fields)]));
  }
  assert.equal((await ingest([event("watch_time", { durationMs: 10000 })])).accepted, 1);
  clock.time += 1;
  assert.equal((await ingest([event("watch_time", { durationMs: 1 })])).accepted, 1);
});

test("position callbacks accept only finite numbers within the server-verified duration", async () => {
  const { clock, event, ingest } = await playback();
  clock.time += 10000;
  await ingest([event("watch_time", { durationMs: 10000 })]);
  for (const positionSeconds of [undefined, null, -1, 18.001, "9", NaN, Infinity]) {
    await invalid(ingest([event("progress_50", { positionSeconds })]));
  }
  assert.equal((await ingest([event("progress_50", { positionSeconds: 9 })])).accepted, 1);
});

test("initial loading is not rebuffering, and an episode cannot start before actual playback", async () => {
  const { clock, event, ingest } = await playback();
  clock.time += 1000;
  await invalid(ingest([event("rebuffer", { durationMs: 1000 })]));
  await ingest([event("play_start")]);
  clock.time += 1000;
  await invalid(ingest([event("rebuffer", { durationMs: 1001 })]));
  assert.equal((await ingest([event("rebuffer", { durationMs: 1000 })])).accepted, 1);
});

test("buffering and watch intervals cannot overlap or multiply the same buffering episode", async () => {
  const { clock, event, ingest } = await playback();
  await ingest([event("play_start")]);
  clock.time += 1000;
  await ingest([event("watch_time", { durationMs: 1000 })]);
  clock.time += 1000;
  await invalid(ingest([event("rebuffer", { durationMs: 1001 })]));
  const episode = event("rebuffer", { durationMs: 1000 });
  await ingest([episode]);
  await invalid(ingest([{ ...episode, eventId: randomUUID() }]));
  clock.time += 1000;
  await invalid(ingest([event("watch_time", { durationMs: 1001 })]));
  assert.equal((await ingest([event("watch_time", { durationMs: 1000 })])).accepted, 1);
});

test("buffering durations are integer milliseconds through five minutes and fit elapsed session time", async () => {
  const { clock, event, ingest } = await playback();
  await ingest([event("play_start")]);
  clock.time += 300000;
  for (const durationMs of [undefined, null, 0, -1, 300001, 1.5, "1000", NaN, Infinity]) {
    await invalid(ingest([event("rebuffer", { durationMs })]));
  }
  assert.equal((await ingest([event("rebuffer", { durationMs: 300000 })])).accepted, 1);
  const early = await playback();
  await early.ingest([early.event("play_start", { occurredAt: new Date(early.clock.time - 30000).toISOString() })]);
  early.clock.time += 1000;
  await invalid(early.ingest([early.event("rebuffer", { durationMs: 1001 })]));
});

test("normalized native retries preserve numeric payloads and changed watch duration conflicts", async () => {
  const { clock, event, ingest } = await playback();
  clock.time += 2000;
  const item = event("watch_time", { durationMs: 2000 });
  await ingest([item]);
  assert.deepEqual(await ingest([{ ...item, occurredAt: "2026-10-02T23:00:02+03:00" }]),
    { accepted: 0, duplicates: 1 });
  await assert.rejects(ingest([{ ...item, durationMs: 1999 }]), error =>
    error.statusCode === 409 && error.errors[0].code === "VIDEO_ANALYTICS_EVENT_CONFLICT");
});

test("a fresh replay session has an independent watch/view budget without extending the original session", async () => {
  const { clock, service, event, ingest, stored } = await playback();
  await ingest([event("play_start")]);
  clock.time += 2000;
  await ingest([event("watch_time", { durationMs: 2000 })]);
  const replay = await service.issueSession({ body: { kind: "reel", contentId: id }, identity: guest });
  const replayEvent = (type, fields = {}) => event(type, { ...fields, playbackSessionId: replay.playbackSessionId });
  await ingest([replayEvent("play_start"), replayEvent("replay")]);
  clock.time += 2000;
  await ingest([replayEvent("watch_time", { durationMs: 2000 })]);
  assert.deepEqual(stored.filter(row => row.type === "watch_time").map(row => row.qualifiedViewCounted), [true, true]);
});

test("native telemetry persists through the protected HTTP route with the unchanged acknowledgement", async t => {
  const { service, clock, event } = await playback("product", 1);
  const start = event("play_start");
  clock.time += 1000;
  const events = [start, event("watch_time", { durationMs: 1000 }), event("complete", { positionSeconds: 1 })];
  t.mock.method(console, "warn", () => {});
  const app = express();
  app.use(express.json());
  app.use("/analytics", createVideoAnalyticsRouter({ getService: async () => service }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = headers => fetch(`http://127.0.0.1:${server.address().port}/analytics/events`,
    { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ events }) });
  assert.equal((await request({})).status, 401);
  const response = await request({ "x-guest-id": guest.id });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { data: { accepted: 3, duplicates: 0 } });
  assert.deepEqual(await (await request({ "x-guest-id": guest.id })).json(), { data: { accepted: 0, duplicates: 3 } });
});
