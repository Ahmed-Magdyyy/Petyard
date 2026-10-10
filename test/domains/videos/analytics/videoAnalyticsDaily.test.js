import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import { roles, enabledControls } from "../../../../src/shared/constants/enums.js";
import { UserModel } from "../../../../src/domains/user/user.model.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";
import { createVideoAnalyticsRouter } from "../../../../src/domains/videos/analytics/videoAnalytics.routes.js";
import { VideoAnalyticsDailyModel } from "../../../../src/domains/videos/analytics/videoAnalyticsDaily.model.js";
import { createPublicVideoRepository } from "../../../../src/domains/videos/public/publicVideo.repository.js";
import { createPublicVideoService } from "../../../../src/domains/videos/public/publicVideo.service.js";
import { fixture, id, guest } from "./fixtures/analyticsDatabase.js";

const actor = { id, role: roles.SUPER_ADMIN };

function saves(context) {
  return createPublicVideoService({ repository: createPublicVideoRepository({
    videos: context.videos, saves: context.db.saves,
    assets: { ...context.db.assets, collection: { name: "assets" } },
    sessions: { ...context.db.operations, collection: { name: "uploads" } },
    analyticsEvents: context.events, daily: context.daily, connection: context.db.connection }),
    isEnabled: () => context.flags.editorial, now: () => context.clock.time });
}

async function playback(kind = "reel", time = "2026-10-02T20:00:00Z") {
  const context = fixture({ kind });
  context.clock.time = Date.parse(time);
  const session = await context.service.issueSession({ body: { kind, contentId: id }, identity: guest });
  const event = (type, fields = {}) => ({ eventId: randomUUID(), playbackSessionId: session.playbackSessionId,
    type, occurredAt: new Date(context.clock.time).toISOString(), ...fields });
  const ingest = events => context.service.ingestEvents({ body: { events }, identity: guest });
  const report = (query = {}) => context.service.listDailyReport({ actor, query });
  return { ...context, session, event, ingest, report };
}

test("daily reports count committed actions, not exact retries or semantic duplicates", async () => {
  const { clock, event, ingest, report } = await playback();
  clock.time += 1000;
  const impression = event("impression");
  const share = event("share");
  await ingest([impression, event("impression"), share]);
  await ingest([impression, share]);
  const result = await report();
  assert.equal(result.totalResults, 1);
  assert.deepEqual(result.data.map(row => [row.day, row.kind, row.contentId,
    row.metrics.impressions, row.metrics.shares]), [["2026-10-02", "reel", id, 1, 1]]);
});

test("native daily totals distinguish watch, qualified views, progress, completion and buffering", async () => {
  const { clock, event, ingest, report } = await playback();
  clock.time += 1000;
  await ingest([event("impression"), event("play_start"), event("replay")]);
  for (const [type, positionSeconds] of [["progress_25", 4.5], ["progress_50", 9], ["progress_75", 13.5]]) {
    clock.time += 4500;
    await ingest([event("watch_time", { durationMs: 4500 }), event(type, { positionSeconds }),
      event(type, { positionSeconds })]);
  }
  clock.time += 3600;
  await ingest([event("watch_time", { durationMs: 3600 }), event("complete", { positionSeconds: 18 })]);
  clock.time += 3000;
  const rebuffer = event("rebuffer", { durationMs: 3000 });
  await ingest([rebuffer, event("share"), event("playback_error", { reason: "network" })]);
  await ingest([rebuffer]);
  assert.deepEqual((await report()).data[0].metrics, {
    impressions: 1, playStarts: 1, qualifiedViews: 1, progress25: 1, progress50: 1,
    progress75: 1, completions: 1, watchTimeMs: 17100, replays: 1, shares: 1,
    saveAdditions: 0, saveRemovals: 0, playbackErrors: 1, rebuffers: 1, rebufferTimeMs: 3000,
  });
});

test("watch time splits at Cairo midnight, with the qualified view on the crossing chunk's end day", async () => {
  const { clock, event, ingest, report } = await playback("reel", "2026-10-02T20:59:58Z");
  await ingest([event("play_start")]);
  clock.time += 4000;
  await ingest([event("watch_time", { durationMs: 4000 })]);
  assert.deepEqual((await report()).data.map(row => [row.day, row.metrics.watchTimeMs,
    row.metrics.qualifiedViews, row.metrics.playStarts]),
  [["2026-10-03", 2000, 1, 0], ["2026-10-02", 2000, 0, 1]]);
});

test("YouTube playback metrics and Product Video save metrics are unavailable, not fabricated zeroes", async () => {
  const youtube = await playback("youtube");
  youtube.clock.time += 1000;
  await youtube.ingest([youtube.event("impression"), youtube.event("share"),
    youtube.event("playback_error", { reason: "unavailable" })]);
  const metrics = (await youtube.report()).data[0].metrics;
  assert.deepEqual(metrics, { impressions: 1, playStarts: null, qualifiedViews: null,
    progress25: null, progress50: null, progress75: null, completions: null,
    watchTimeMs: null, replays: null, shares: 1, saveAdditions: 0, saveRemovals: 0,
    playbackErrors: 1, rebuffers: null, rebufferTimeMs: null });
  const product = await playback("product");
  await product.ingest([product.event("play_start")]);
  const productMetrics = (await product.report()).data[0].metrics;
  assert.equal(productMetrics.playStarts, 1);
  assert.equal(productMetrics.saveAdditions, null);
  assert.equal(productMetrics.saveRemovals, null);
});

test("daily reports apply inclusive calendar ranges and content filters instead of the default window", async () => {
  const { clock, event, ingest, report } = await playback("reel", "2026-09-01T10:00:00Z");
  await ingest([event("share")]);
  clock.time = Date.parse("2026-10-02T20:00:00Z");
  assert.equal((await report()).totalResults, 0);
  assert.equal((await report({ from: "2026-09-01", to: "2026-09-01", kind: "reel",
    contentId: id.toUpperCase() })).totalResults, 1);
  assert.equal((await report({ from: "2026-09-01", to: "2026-09-01", kind: "youtube" })).totalResults, 0);
  assert.equal((await report({ from: "2026-09-01", to: "2026-09-01",
    contentId: "507f1f77bcf86cd799439099" })).totalResults, 0);
});

test("daily save totals come from actual state transitions and share the playback report", async () => {
  const context = fixture();
  const publicService = saves(context);
  const request = { id, identity: guest };
  await publicService.save(request);
  await publicService.save(request);
  await publicService.unsave(request);
  await publicService.unsave(request);
  const result = await context.service.listDailyReport({ actor });
  assert.deepEqual(result.data.map(row => [row.kind, row.metrics.saveAdditions, row.metrics.saveRemovals]),
    [["youtube", 1, 1]]);
});

async function httpFixture(t, service) {
  const previous = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = "test-video-daily-report-auth";
  t.after(() => {
    if (previous === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = previous;
  });
  t.mock.method(console, "warn", () => {});
  let account = { _id: id, role: roles.SUPER_ADMIN, active: true,
    phoneVerified: true, account_status: "confirmed" };
  t.mock.method(UserModel.collection, "findOne", async () => account);
  const token = jwt.sign({ userId: id }, process.env.JWT_ACCESS_SECRET, { expiresIn: "5m" });
  const headers = { authorization: `Bearer ${token}` };
  const app = express();
  app.use(express.json());
  app.use("/videos/analytics", createVideoAnalyticsRouter({ getService: async () => service }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { setAccount: fields => { account = { ...account, ...fields }; },
    request: (query = "", suppliedHeaders = headers) => fetch(
      `http://127.0.0.1:${server.address().port}/videos/analytics/reports/daily${query}`,
      { headers: suppliedHeaders }) };
}

test("daily report HTTP access uses protect, staff roles and the existing analytics control", async t => {
  const { service, event, ingest } = await playback();
  await ingest([event("share")]);
  const { request, setAccount } = await httpFixture(t, service);
  assert.equal((await request("", {})).status, 401);
  assert.equal((await request("", { "x-guest-id": guest.id })).status, 401);
  assert.equal((await request("", { authorization: "Bearer invalid" })).status, 401);
  for (const role of [roles.USER, roles.MODERATOR, roles.ADMIN]) {
    setAccount({ role, enabledControls: [enabledControls.VIDEOS] });
    assert.equal((await request()).status, 403);
  }
  setAccount({ role: roles.ADMIN, enabledControls: [enabledControls.ANALYTICS] });
  const response = await request("?kind=reel&limit=1");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal((await response.json()).data[0].metrics.shares, 1);
  setAccount({ role: roles.SUPER_ADMIN, enabledControls: [] });
  assert.equal((await request()).status, 200);
});

test("Cairo DST skips and repeated hours do not misattribute or duplicate watch milliseconds", async () => {
  for (const [time, expected] of [
    ["2026-04-23T21:59:58Z", [["2026-04-24", 2000], ["2026-04-23", 2000]]],
    ["2026-10-29T21:59:58Z", [["2026-10-30", 2000], ["2026-10-29", 2000]]],
    ["2026-10-29T20:59:58Z", [["2026-10-29", 4000]]],
  ]) {
    const { clock, event, ingest, report } = await playback("reel", time);
    await ingest([event("play_start")]);
    clock.time += 4000;
    await ingest([event("watch_time", { durationMs: 4000 })]);
    assert.deepEqual((await report()).data.map(row => [row.day, row.metrics.watchTimeMs]), expected);
  }
});

test("a watch chunk ending exactly at midnight puts no watch milliseconds in the following day", async () => {
  const { clock, event, ingest, report } = await playback("reel", "2026-10-02T20:59:58Z");
  clock.time += 2000;
  await ingest([event("watch_time", { durationMs: 2000 })]);
  assert.deepEqual((await report()).data.map(row => [row.day, row.metrics.watchTimeMs, row.metrics.qualifiedViews]),
    [["2026-10-03", 0, 1], ["2026-10-02", 2000, 0]]);
});

test("daily expiry is twelve calendar months after the bucket end, independent of TTL cleanup", async () => {
  for (const [time, day, expiry] of [
    ["2026-10-02T20:00:00Z", "2026-10-02", "2027-10-02T21:00:00Z"],
    ["2024-02-29T12:00:00Z", "2024-02-29", "2025-02-28T22:00:00Z"],
  ]) {
    const context = await playback("reel", time);
    const update = context.daily.updateOne;
    const documents = [];
    context.daily.updateOne = async (filter, changes, options) => {
      documents.push(changes.$setOnInsert);
      return update(filter, changes, options);
    };
    await context.ingest([context.event("share")]);
    assert.equal(documents[0].expiresAt.toISOString(), new Date(expiry).toISOString());
    context.clock.time = Date.parse(expiry) - 1;
    assert.equal((await context.report({ from: day, to: day })).totalResults, 1);
    context.clock.time++;
    assert.equal((await context.report({ from: day, to: day })).totalResults, 0);
  }
});

test("aggregate write failures roll back raw events and session state so the same event can be retried", async () => {
  const { event, ingest, report, daily } = await playback();
  const item = event("share");
  const update = daily.updateOne;
  daily.updateOne = async (...args) => { await update(...args); throw new Error("private-db-secret"); };
  await assert.rejects(ingest([item]), error => error.statusCode === 503 &&
    error.errors[0].code === "VIDEO_ANALYTICS_UNAVAILABLE" && !error.message.includes("private-db-secret"));
  assert.equal((await report()).totalResults, 0);
  daily.updateOne = update;
  assert.deepEqual(await ingest([item]), { accepted: 1, duplicates: 0 });
  assert.equal((await report()).data[0].metrics.shares, 1);
});

test("aggregate failures roll back actual save additions and removals", async () => {
  const context = fixture();
  const publicService = saves(context);
  const request = { id, identity: guest };
  const update = context.daily.updateOne;
  context.daily.updateOne = async (...args) => { await update(...args); throw new Error("private failure"); };
  await assert.rejects(publicService.save(request), error => error.statusCode === 503);
  assert.equal((await publicService.getVideo(request)).isSaved, false);
  assert.equal((await context.service.listDailyReport({ actor })).totalResults, 0);
  context.daily.updateOne = update;
  await publicService.save(request);
  context.daily.updateOne = async (...args) => { await update(...args); throw new Error("private failure"); };
  await assert.rejects(publicService.unsave(request), error => error.statusCode === 503);
  assert.equal((await publicService.getVideo(request)).isSaved, true);
  assert.equal((await context.service.listDailyReport({ actor })).data[0].metrics.saveRemovals, 0);
  context.daily.updateOne = update;
  await publicService.unsave(request);
  assert.equal((await context.service.listDailyReport({ actor })).data[0].metrics.saveRemovals, 1);
});

test("invalid report filters, unbounded dates and structured query values are rejected", async () => {
  const { report } = await playback();
  for (const query of [null, [], { from: "2026-01-01" }, { to: "2026-01-01" },
    { from: "2026-01-02", to: "2026-01-01" }, { from: "2026-02-30", to: "2026-03-01" },
    { from: "2026-01-01T00:00:00Z", to: "2026-01-02" },
    { from: "2025-01-01", to: "2026-01-02" }, { kind: "other" },
    { contentId: "invalid" }, { viewerId: id }, { kind: ["reel"] },
    { from: { $gt: "2026-01-01" }, to: "2026-01-02" }, { page: 0 }, { limit: 101 }]) {
    await assert.rejects(report(query), error => error.statusCode === 422);
  }
  assert.equal((await report({ from: "2025-01-01", to: "2026-01-01" })).totalResults, 0);
});

test("daily report service also enforces staff permissions and preserves history with public flags off", async () => {
  const { service, flags, event, ingest, report } = await playback();
  await ingest([event("share")]);
  for (const invalidActor of [undefined, { id, role: roles.USER }, { id, role: roles.MODERATOR },
    { id, role: roles.ADMIN, enabledControls: [enabledControls.VIDEOS] }]) {
    await assert.rejects(service.listDailyReport({ actor: invalidActor }), error => error.statusCode === 403);
  }
  flags.editorial = false;
  flags.product = false;
  assert.equal((await report()).data[0].metrics.shares, 1);
  assert.equal((await service.listDailyReport({ actor: { id, role: roles.ADMIN,
    enabledControls: [enabledControls.ANALYTICS] } })).totalResults, 1);
});

test("daily history survives owner deletion without customer-removal counts or viewer/provider data", async () => {
  const context = fixture();
  const publicService = saves(context);
  await publicService.save({ id, identity: guest });
  // External adapter simulates the existing automatic deletion transaction.
  await context.db.saves.deleteMany({ videoId: id });
  await context.videos.deleteOne({ _id: id });
  await publicService.unsave({ id, identity: guest });
  const result = await context.service.listDailyReport({ actor });
  assert.equal(result.data[0].metrics.saveAdditions, 1);
  assert.equal(result.data[0].metrics.saveRemovals, 0);
  assert.deepEqual(Object.keys(result.data[0]).sort(), ["contentId", "day", "kind", "metrics"]);
  for (const privateValue of [guest.id, "playbackSessionId", "expiresAt", "youtubeId", "assetId", "identityId", "url"]) {
    assert.equal(JSON.stringify(result).includes(privateValue), false);
  }
});

test("daily pagination is stable and follows the existing Videos response shape", async () => {
  const { clock, event, ingest, report, service } = await playback("reel", "2026-09-30T20:00:00Z");
  await ingest([event("share")]);
  clock.time = Date.parse("2026-10-01T20:00:00Z");
  const next = await service.issueSession({ body: { kind: "reel", contentId: id }, identity: guest });
  await ingest([{ ...event("share"), playbackSessionId: next.playbackSessionId }]);
  const first = await report({ limit: "1" });
  const second = await report({ page: "2", limit: "1" });
  assert.deepEqual([first.totalResults, first.totalPages, first.page, first.results, first.data[0].day],
    [2, 2, 1, 1, "2026-10-01"]);
  assert.deepEqual([second.totalResults, second.totalPages, second.page, second.results, second.data[0].day],
    [2, 2, 2, 1, "2026-09-30"]);
  assert.equal((await report({ page: 3, limit: 1 })).results, 0);
});

test("concurrent playback attempts and exact retries increment only their committed actions", async () => {
  const { event, ingest, report, service } = await playback();
  const next = await service.issueSession({ body: { kind: "reel", contentId: id }, identity: guest });
  const item = event("share");
  await Promise.all([ingest([item]), ingest([item]),
    ingest([{ ...event("share"), playbackSessionId: next.playbackSessionId }])]);
  assert.equal((await report()).data[0].metrics.shares, 2);
});

test("the real Mongoose daily update casts a transactional upsert without conflicting counter defaults", async t => {
  const context = await playback();
  const commands = [];
  t.mock.method(VideoAnalyticsDailyModel.collection, "updateOne", async (filter, changes, options) => {
    commands.push({ filter, changes, options });
    return context.db.daily.updateOne(filter, changes, options);
  });
  context.daily.updateOne = (...args) => VideoAnalyticsDailyModel.updateOne(...args);
  await context.ingest([context.event("share")]);
  const report = await context.report();
  assert.equal(report.data[0].metrics.shares, 1);
  assert.equal(commands[0].filter.contentId.toHexString(), id);
  assert.ok(commands[0].options.session);
  assert.equal(commands[0].options.upsert, true);
  assert.equal(commands[0].changes.$setOnInsert.shares, undefined);
  assert.equal(commands[0].changes.$setOnInsert.expiresAt.toISOString(), "2027-10-02T21:00:00.000Z");
});

test("report storage errors are safe and invalid HTTP filters never become a public report", async t => {
  const { service, daily } = fixture();
  const { request, setAccount } = await httpFixture(t, service);
  for (const query of ["?kind=other", "?kind[]=reel", "?from=2026-01-01",
    "?from=2026-02-30&to=2026-03-01", "?limit=101", "?viewerId=private"]) {
    assert.equal((await request(query)).status, 422);
  }
  daily.countDocuments = () => { throw new Error("private-db-credential"); };
  const response = await request();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const data = await response.json();
  assert.equal(data.error[0].code, "VIDEO_ANALYTICS_UNAVAILABLE");
  assert.equal(JSON.stringify(data).includes("private-db-credential"), false);
  setAccount({ role: roles.ADMIN, enabledControls: [enabledControls.ANALYTICS], phoneVerified: false });
  assert.equal((await request()).status, 403);
});
