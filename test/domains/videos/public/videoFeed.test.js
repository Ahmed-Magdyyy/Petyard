import assert from "node:assert/strict";
import test from "node:test";
import { orderVideoFeed, feedGenerationKey } from "../../../../src/domains/videos/public/videoFeed.policy.js";
import { createVideoFeedService } from "../../../../src/domains/videos/public/videoFeed.service.js";
import { createVideoFeedSnapshotStore, VIDEO_FEED_IDLE_TTL_MS } from "../../../../src/domains/videos/public/videoFeedSnapshot.store.js";
import { createPublicVideoService } from "../../../../src/domains/videos/public/publicVideo.service.js";

const id = number => number.toString(16).padStart(24, "0");
const video = (number, day = "2026-10-30", kind = "reel") => ({
  id: id(number), kind, activeAssetId: id(number + 100), feedAt: `${day}T12:00:00Z`,
  publishedAt: `${day}T12:00:00Z`, title_en: `Video ${number}`, title_ar: "فيديو",
  productId: id(number + 200), product: { name_en: `Product ${number}`, name_ar: "منتج" },
  asset: { durationSeconds: 18, width: 720, height: 1280, poster: { url: "https://images.example/poster.webp" } },
});

function redisFixture(clock) {
  const values = new Map();
  return {
    values,
    async get(key) {
      const entry = values.get(key);
      if (entry && entry.expiresAt <= clock.time) values.delete(key);
      return values.get(key)?.raw ?? null;
    },
    async pexpire(key, ttl) {
      const entry = values.get(key);
      if (entry) entry.expiresAt = clock.time + Number(ttl);
      return entry ? 1 : 0;
    },
    async eval(_script, count, key, expected, next, ttl) {
      assert.equal(count, 1);
      const entry = values.get(key);
      const current = entry && entry.expiresAt > clock.time ? entry.raw : null;
      if (!current || current === expected) values.set(key, { raw: next, expiresAt: clock.time + Number(ttl) });
      else values.get(key).expiresAt = clock.time + Number(ttl);
      return values.get(key).raw;
    },
  };
}

test("unseen Cairo days rank newest first, shuffle within days, and precede all watched generations", () => {
  const recent = [video(1), video(2), video(3), video(4), video(5)];
  const older = video(6, "2026-10-29");
  const seen = video(7, "2026-11-01");
  const rows = [seen, older, ...recent];
  const watched = new Set([feedGenerationKey(seen)]);
  assert.deepEqual(orderVideoFeed(rows, watched, () => 0),
    [recent[1], recent[2], recent[3], recent[4], recent[0], older, seen].map(feedGenerationKey));
  assert.deepEqual(orderVideoFeed(rows, watched, maximum => maximum - 1),
    [...recent, older, seen].map(feedGenerationKey));
  assert.deepEqual(orderVideoFeed([video(1)], new Set([`reel:${id(1)}:${id(999)}`])), [feedGenerationKey(video(1))]);
});

test("twenty unseen videos on twenty distinct days still shuffle within newest-first cohorts", () => {
  const rows = Array.from({ length: 20 }, (_, index) => video(index + 1, `2026-10-${String(index + 1).padStart(2, "0")}`));
  const first = orderVideoFeed(rows, new Set(), () => 0);
  const second = orderVideoFeed(rows, new Set(), maximum => maximum - 1);
  assert.notDeepEqual(first, second);
  assert.deepEqual(new Set(first.slice(0, 5)), new Set(rows.slice(-5).map(feedGenerationKey)));
  assert.deepEqual(new Set(second.slice(0, 5)), new Set(rows.slice(-5).map(feedGenerationKey)));
  assert.equal(new Set(first).size, 20);
});

test("a single fresh video stays above an older densely populated day", () => {
  const recent = video(1);
  const older = Array.from({ length: 20 }, (_, index) => video(index + 2, "2026-10-29"));
  const order = orderVideoFeed([...older, recent], new Set(), () => 0);
  assert.equal(order[0], feedGenerationKey(recent));
  assert.equal(order.length, 21);
});

test("freshness follows Cairo midnight rather than UTC midnight", () => {
  const early = { ...video(1), feedAt: "2026-10-30T21:59:00Z" };
  const late = { ...video(2), feedAt: "2026-10-30T22:01:00Z" };
  assert.deepEqual(orderVideoFeed([early, late], new Set(), maximum => maximum - 1),
    [late, early].map(feedGenerationKey));
});

test("five unseen videos precede all fifteen watched videos in a twenty-video catalog", () => {
  const rows = Array.from({ length: 20 }, (_, index) => video(index + 1));
  const seen = new Set(rows.slice(5).map(feedGenerationKey));
  const ordered = orderVideoFeed(rows, seen);
  assert.deepEqual(new Set(ordered.slice(0, 5)), new Set(rows.slice(0, 5).map(feedGenerationKey)));
  assert.deepEqual(new Set(ordered.slice(5)), seen);
  assert.deepEqual(new Set(orderVideoFeed(rows, new Set(rows.map(feedGenerationKey)))), new Set(rows.map(feedGenerationKey)));
});

test("concurrent initial snapshot builds return one winner, retries reuse it, and scrolling renews its idle TTL", async () => {
  const clock = { time: 100000 };
  const redis = redisFixture(clock);
  const store = createVideoFeedSnapshotStore({ client: () => redis, now: () => clock.time });
  let resume;
  const blocked = new Promise(resolve => { resume = resolve; });
  const first = store.resolve("key", { refresh: true, build: async () => { await blocked; return [feedGenerationKey(video(1))]; } });
  const winner = await store.resolve("key", { refresh: true, build: async () => [feedGenerationKey(video(2))] });
  resume();
  assert.deepEqual(await first, winner);
  clock.time += 1000;
  assert.deepEqual(await store.resolve("key", { refresh: true, build: () => assert.fail("retry rebuilt order") }), winner);
  clock.time += VIDEO_FEED_IDLE_TTL_MS - 1;
  assert.deepEqual(await store.resolve("key", { refresh: false, build: () => assert.fail("scroll rebuilt order") }), winner);
  assert.equal(redis.values.get("key").expiresAt, clock.time + VIDEO_FEED_IDLE_TTL_MS);
  const refreshed = await store.resolve("key", { refresh: true, build: async () => [feedGenerationKey(video(3))] });
  assert.notDeepEqual(refreshed.order, winner.order);
  clock.time += VIDEO_FEED_IDLE_TTL_MS + 1;
  const expired = await store.resolve("key", { refresh: false, build: async () => [] });
  assert.deepEqual(expired.order, []);
});

test("corrupt or missing snapshots rebuild; Redis failures fall back without swallowing database failures", async () => {
  const clock = { time: 100000 };
  const redis = redisFixture(clock);
  redis.values.set("key", { raw: "not-json", expiresAt: clock.time + 10000 });
  const store = createVideoFeedSnapshotStore({ client: () => redis, now: () => clock.time });
  assert.deepEqual((await store.resolve("key", { refresh: false, build: async () => [] })).order, []);
  assert.equal(await createVideoFeedSnapshotStore({ client: () => null }).resolve("key", { build: assert.fail }), null);
  assert.equal(await createVideoFeedSnapshotStore({ client: () => ({ get() { throw Error("down"); } }) })
    .resolve("key", { build: assert.fail }), null);
  await assert.rejects(store.resolve("missing", { build: async () => { throw Error("database failure"); } }), /database failure/);
  redis.eval = async () => { throw Error("Redis disconnected"); };
  assert.equal(await store.resolve("missing", { build: async () => [] }), null);
});

function feedFixture() {
  const clock = { time: Date.parse("2026-10-30T12:00:00Z") };
  const redis = redisFixture(clock);
  const state = { rows: Array.from({ length: 20 }, (_, index) => video(index + 1)), seen: new Set(), orders: 0 };
  const repository = {
    async listFeedCandidates({ includeReels, includeProducts }) {
      return state.rows.filter(row => row.kind === "reel" ? includeReels : includeProducts);
    },
    async seenFeedGenerations({ identity }) { return identity ? state.seen : new Set(); },
    async loadFeedRows({ candidates, includeReels, includeProducts }) {
      return state.rows.filter(row => (row.kind === "reel" ? includeReels : includeProducts) &&
        candidates.some(candidate => feedGenerationKey(candidate) === feedGenerationKey(row))).reverse();
    },
  };
  const feed = createVideoFeedService({ repository,
    snapshots: createVideoFeedSnapshotStore({ client: () => redis, now: () => clock.time }),
    now: () => clock.time,
    order: (rows, seen) => orderVideoFeed(rows, seen, ++state.orders % 2 ? () => 0 : maximum => maximum - 1),
  });
  const request = { page: 1, limit: 5, kind: "all", identity: { type: "guest", id: "viewer" }, includeReels: true, includeProducts: true };
  return { feed, state, redis, repository, clock, request };
}

test("20 videos paginate once each while watch history and new publications wait for a refresh", async () => {
  const { feed, state, clock, request } = feedFixture();
  const pages = [(await feed.list(request)).data];
  state.seen.add(feedGenerationKey(state.rows[1]));
  state.rows.push(video(21));
  for (let page = 2; page <= 4; page++) {
    clock.time += 10000;
    const response = await feed.list({ ...request, page });
    assert.equal(response.totalResults, 20);
    pages.push(response.data);
  }
  assert.equal(new Set(pages.flat().map(row => row.id)).size, 20);
  assert.equal(state.orders, 1);
  const refreshed = await feed.list({ ...request, limit: 100 });
  assert.equal(refreshed.totalResults, 21);
  assert.equal(refreshed.data.at(-1).id, id(2));
  assert.equal(state.orders, 2);
});

test("cached order rechecks visibility and media generation, and isolates viewers, filters, flags and bearer scopes", async () => {
  const { feed, state, redis, request } = feedFixture();
  await feed.list(request);
  state.rows = state.rows.filter(row => row.id !== id(1));
  state.rows[0] = { ...state.rows[0], activeAssetId: id(999) };
  const response = await feed.list({ ...request, limit: 100 });
  assert.equal(response.totalResults, 18);
  assert.ok(!response.data.some(row => [id(1), id(2)].includes(row.id)));
  const variations = [
    { identity: { type: "user", id: "viewer" } }, { identity: { type: "guest", id: "other" } },
    { kind: "reel" }, { includeProducts: false }, { feedScope: "another-device" }, { identity: null },
  ];
  for (const variation of variations) await feed.list({ ...request, ...variation });
  assert.equal(redis.values.size, 6);
  assert.ok([...redis.values.keys()].every(key => !key.includes("viewer")));
});

test("public feed DTO and pagination stay unchanged, with current language/save hydration and legacy fallback", async () => {
  const { feed, state, repository, request } = feedFixture();
  let fallback = 0;
  const legacy = async () => { fallback++; return { totalResults: 1, data: [state.rows[0]] }; };
  const appRepository = { ...repository, listYouTube: legacy, listReels: legacy, listProducts: legacy,
    listMixed: legacy, getPublished: legacy, listSaved: legacy, save: legacy, unsave: legacy,
    savedIds: async () => new Set([id(2)]) };
  const app = createPublicVideoService({ repository: appRepository, feed,
    isEnabled: () => true, isProductEnabled: () => true });
  const response = await app.listFeed({ ...request, lang: "ar" });
  assert.deepEqual(Object.keys(response), ["totalResults", "totalPages", "page", "results", "data"]);
  assert.equal(response.totalResults, 20);
  assert.equal(response.totalPages, 4);
  assert.equal(response.data[0].title, "فيديو");
  assert.equal(response.data[0].isSaved, true);
  assert.ok(!JSON.stringify(response).includes("activeAssetId"));
  assert.equal((await app.listFeed({ ...request, identity: null })).totalResults, 1);
  const degraded = createPublicVideoService({ repository: appRepository,
    feed: createVideoFeedService({ repository, snapshots: { resolve: async () => null } }), isEnabled: () => true });
  assert.equal((await degraded.listFeed(request)).totalResults, 1);
  assert.equal(fallback, 2);
});
