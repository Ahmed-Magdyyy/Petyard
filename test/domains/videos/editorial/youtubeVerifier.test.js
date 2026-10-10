import assert from "node:assert/strict";
import test from "node:test";

import { createYouTubeVerifier } from "../../../../src/domains/videos/editorial/youtubeVerifier.js";

const videoId = "dQw4w9WgXcQ";

function publicVideo(overrides = {}) {
  return {
    id: videoId,
    status: { privacyStatus: "public", embeddable: true, uploadStatus: "processed" },
    snippet: { liveBroadcastContent: "none" },
    ...overrides,
  };
}

test("YouTube verifier sends the key in a header and accepts a public embeddable video", async () => {
  const verify = createYouTubeVerifier({
    apiKey: "test-key",
    request: async (url, options) => {
      assert.equal(url.origin, "https://www.googleapis.com");
      assert.equal(url.pathname, "/youtube/v3/videos");
      assert.equal(url.searchParams.get("id"), videoId);
      assert.equal(url.searchParams.has("key"), false);
      assert.equal(options.headers["X-Goog-Api-Key"], "test-key");
      return { ok: true, json: async () => ({ items: [publicVideo()] }) };
    },
  });

  assert.deepEqual(await verify(videoId), { youtubeId: videoId });
});

test("YouTube verifier rejects missing, private, non-embeddable, unprocessed, or live videos", async () => {
  const rejected = [
    [],
    [publicVideo({ status: { privacyStatus: "private", embeddable: true, uploadStatus: "processed" } })],
    [publicVideo({ status: { privacyStatus: "public", embeddable: false, uploadStatus: "processed" } })],
    [publicVideo({ status: { privacyStatus: "public", embeddable: true, uploadStatus: "uploaded" } })],
    [publicVideo({ snippet: { liveBroadcastContent: "live" } })],
    [publicVideo({ liveStreamingDetails: { actualEndTime: "2026-09-28T00:00:00Z" } })],
  ];
  for (const items of rejected) {
    const verify = createYouTubeVerifier({
      apiKey: "test-key",
      request: async () => ({ ok: true, json: async () => ({ items }) }),
    });
    await assert.rejects(verify(videoId), (error) =>
      error.statusCode === 422 && error.errors?.[0]?.code === "VIDEO_YOUTUBE_UNAVAILABLE");
  }
});

test("YouTube verifier fails closed without a key and on provider errors", async () => {
  const missingKey = createYouTubeVerifier({ request: async () => { throw new Error("unexpected request"); } });
  await assert.rejects(missingKey(videoId), (error) =>
    error.statusCode === 503 && error.errors?.[0]?.code === "VIDEO_YOUTUBE_CHECK_UNAVAILABLE");

  for (const request of [
    async () => ({ ok: false, status: 403 }),
    async () => { throw new Error("sensitive provider response"); },
    async () => ({ ok: true, json: async () => { throw new Error("bad JSON"); } }),
  ]) {
    const verify = createYouTubeVerifier({ apiKey: "test-key", request });
    await assert.rejects(verify(videoId), (error) =>
      error.statusCode === 503 && error.errors?.[0]?.code === "VIDEO_YOUTUBE_CHECK_UNAVAILABLE" &&
      !error.message.includes("sensitive"));
  }
});
