import assert from "node:assert/strict";
import test from "node:test";

import { createEditorialVideoService } from "../../../../src/domains/videos/editorial/editorialVideo.service.js";
import { createYouTubeVerifier } from "../../../../src/domains/videos/editorial/youtubeVerifier.js";

test("an admin can prepare a YouTube Video without publishing it", async () => {
  const records = new Map();
  const app = createEditorialVideoService({
    repository: {
      async create(record) {
        const saved = { ...record, id: "video-1", revision: 0 };
        records.set(saved.id, saved);
        return saved;
      },
    },
    verifyYouTube: async () => {},
  });

  const video = await app.createYouTubeVideo({
    actor: { id: "admin-1", role: "admin" },
    input: {
      youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title_en: "Training",
      title_ar: "تدريب",
    },
  });

  assert.equal(video.id, "video-1");
  assert.equal(video.kind, "youtube");
  assert.equal(video.youtubeId, "dQw4w9WgXcQ");
  assert.equal(video.status, "draft");
  assert.equal(video.publishedAt, null);
});

test("a super admin's verified YouTube Video publishes immediately", async () => {
  const app = createEditorialVideoService({
    repository: { async create(record) { return { ...record, id: "video-2" }; } },
    verifyYouTube: async () => {},
    now: () => new Date("2026-09-28T12:00:00.000Z"),
  });

  const video = await app.createYouTubeVideo({
    actor: { id: "super-1", role: "superAdmin" },
    input: { youtubeUrl: "https://youtu.be/dQw4w9WgXcQ", title_en: "Care", title_ar: "رعاية" },
  });

  assert.equal(video.status, "published");
  assert.equal(video.publishedAt.toISOString(), "2026-09-28T12:00:00.000Z");
});

test("an admin submits a draft for review without making it public", async () => {
  let saved;
  const app = createEditorialVideoService({
    repository: {
      async create(record) { saved = { ...record, id: "video-3", revision: 0 }; return saved; },
      async get() { return { ...saved }; },
      async replace(_id, expectedRevision, next) {
        assert.equal(expectedRevision, saved.revision);
        saved = { ...next, revision: saved.revision + 1 };
        return { ...saved };
      },
    },
    verifyYouTube: async () => {},
  });
  await app.createYouTubeVideo({
    actor: { id: "admin-1", role: "admin" },
    input: { youtubeUrl: "https://www.youtube.com/shorts/dQw4w9WgXcQ", title_en: "Training", title_ar: "تدريب" },
  });

  const video = await app.submit({ id: "video-3", actor: { id: "admin-1", role: "admin" } });

  assert.equal(video.status, "in_review");
  assert.equal(video.publishedAt, null);
});

test("a super admin approves an in-review YouTube Video but it remains hidden", async () => {
  let saved = {
    id: "video-4", revision: 2, kind: "youtube", youtubeId: "dQw4w9WgXcQ",
    status: "in_review", authorId: "admin-1", publishedAt: null,
  };
  const app = createEditorialVideoService({
    repository: {
      async create() { throw new Error("unused"); },
      async get() { return { ...saved }; },
      async replace(_id, expectedRevision, next) {
        assert.equal(expectedRevision, saved.revision);
        saved = { ...next, revision: saved.revision + 1 };
        return { ...saved };
      },
    },
    verifyYouTube: async () => {},
  });

  const video = await app.approve({ id: "video-4", actor: { id: "super-1", role: "superAdmin" } });

  assert.equal(video.status, "approved");
  assert.equal(video.publishedAt, null);
  assert.equal(video.reviewerId, "super-1");
});

test("only a super admin can publish an approved YouTube Video", async () => {
  let saved = {
    id: "video-5", revision: 1, kind: "youtube", youtubeId: "dQw4w9WgXcQ",
    status: "approved", authorId: "admin-1", publishedAt: null,
  };
  const app = createEditorialVideoService({
    repository: {
      async create() { throw new Error("unused"); },
      async get() { return { ...saved }; },
      async replace(_id, expectedRevision, next) {
        assert.equal(expectedRevision, saved.revision);
        saved = { ...next, revision: saved.revision + 1 };
        return { ...saved };
      },
    },
    verifyYouTube: async () => {},
    now: () => new Date("2026-09-28T13:00:00.000Z"),
  });

  await assert.rejects(app.publish({ id: "video-5", actor: { id: "admin-1", role: "admin" } }),
    (error) => error.statusCode === 403);
  const video = await app.publish({ id: "video-5", actor: { id: "super-1", role: "superAdmin" } });

  assert.equal(video.status, "published");
  assert.equal(video.publishedAt.toISOString(), "2026-09-28T13:00:00.000Z");
});

test("rejecting a new Video returns it to an editable draft", async () => {
  let saved = { id: "video-6", revision: 1, kind: "youtube", youtubeId: "dQw4w9WgXcQ",
    status: "in_review", authorId: "admin-1", publishedAt: null };
  const app = createEditorialVideoService({
    repository: {
      async create() { throw new Error("unused"); },
      async get() { return { ...saved }; },
      async replace(_id, _revision, next) { saved = { ...next, revision: saved.revision + 1 }; return { ...saved }; },
    },
    verifyYouTube: async () => {},
  });

  const video = await app.reject({ id: "video-6", actor: { id: "super-1", role: "superAdmin" },
    reason: "Please revise the title" });

  assert.equal(video.status, "draft");
  assert.equal(video.reviewReason, "Please revise the title");
  assert.equal(video.publishedAt, null);
});

test("unpublishing hides a Video without deleting its approved content", async () => {
  let saved = { id: "video-7", revision: 3, kind: "youtube", youtubeId: "dQw4w9WgXcQ",
    status: "published", authorId: "admin-1", title_en: "Care",
    publishedAt: new Date("2026-09-27T12:00:00.000Z") };
  const app = createEditorialVideoService({
    repository: {
      async create() { throw new Error("unused"); },
      async get() { return { ...saved }; },
      async replace(_id, _revision, next) { saved = { ...next, revision: saved.revision + 1 }; return { ...saved }; },
    },
    verifyYouTube: async () => {},
  });

  const video = await app.unpublish({ id: "video-7", actor: { id: "super-1", role: "superAdmin" } });

  assert.equal(video.status, "unpublished");
  assert.equal(video.title_en, "Care");
  assert.equal(video.publishedAt.toISOString(), "2026-09-27T12:00:00.000Z");
});

test("an admin edit to a published Video remains isolated for review", async () => {
  let saved = { id: "video-8", revision: 4, kind: "youtube", youtubeId: "dQw4w9WgXcQ",
    status: "published", authorId: "admin-1", title_en: "Original", title_ar: "أصلي",
    description_en: "", description_ar: "", publishedAt: new Date("2026-09-27T12:00:00.000Z") };
  const app = createEditorialVideoService({
    repository: {
      async create() { throw new Error("unused"); },
      async get() { return { ...saved }; },
      async replace(_id, _revision, next) { saved = { ...next, revision: saved.revision + 1 }; return { ...saved }; },
    },
    verifyYouTube: async () => {},
  });

  const video = await app.editVideo({ id: "video-8", actor: { id: "admin-2", role: "admin" },
    input: { title_en: "Improved" } });

  assert.equal(video.title_en, "Original");
  assert.equal(video.pendingChange.content.title_en, "Improved");
  assert.equal(video.pendingChange.authorId, "admin-2");
  assert.equal(video.status, "published");
});

test("an admin can submit only their own Pending Video Change", async () => {
  let saved = { id: "video-9", revision: 5, kind: "youtube", youtubeId: "dQw4w9WgXcQ",
    status: "published", title_en: "Original", pendingChange: {
      authorId: "admin-2", status: "draft", content: {
        youtubeId: "dQw4w9WgXcQ", title_en: "Improved", title_ar: "جديد",
        description_en: "", description_ar: "",
      },
    } };
  const app = createEditorialVideoService({
    repository: {
      async create() { throw new Error("unused"); },
      async get() { return { ...saved }; },
      async replace(_id, _revision, next) { saved = { ...next, revision: saved.revision + 1 }; return { ...saved }; },
    },
    verifyYouTube: async () => {},
  });

  await assert.rejects(app.submit({ id: "video-9", actor: { id: "admin-1", role: "admin" } }),
    (error) => error.statusCode === 403);
  const video = await app.submit({ id: "video-9", actor: { id: "admin-2", role: "admin" } });

  assert.equal(video.status, "published");
  assert.equal(video.title_en, "Original");
  assert.equal(video.pendingChange.status, "in_review");
});

test("approving an edit after unpublish changes content but does not republish", async () => {
  let saved = { id: "video-10", revision: 7, kind: "youtube", youtubeId: "dQw4w9WgXcQ",
    status: "unpublished", title_en: "Original", title_ar: "أصلي",
    publishedAt: new Date("2026-09-27T12:00:00.000Z"), pendingChange: {
      authorId: "admin-2", status: "in_review", content: {
        youtubeId: "dQw4w9WgXcQ", title_en: "Improved", title_ar: "جديد",
        description_en: "", description_ar: "",
      },
    } };
  const app = createEditorialVideoService({
    repository: {
      async create() { throw new Error("unused"); },
      async get() { return { ...saved }; },
      async replace(_id, _revision, next) { saved = { ...next, revision: saved.revision + 1 }; return { ...saved }; },
    },
    verifyYouTube: async () => {},
  });

  const video = await app.approve({ id: "video-10", actor: { id: "super-1", role: "superAdmin" } });

  assert.equal(video.status, "unpublished");
  assert.equal(video.title_en, "Improved");
  assert.equal(video.pendingChange, null);
});

test("a private YouTube video cannot become a PetYard Video", async () => {
  const app = createEditorialVideoService({
    repository: { async create() { throw new Error("must not create"); } },
    verifyYouTube: createYouTubeVerifier({
      apiKey: "test-key",
      request: async (_url, options) => {
        assert.equal(options.headers["X-Goog-Api-Key"], "test-key");
        return { ok: true, async json() { return { items: [{ id: "dQw4w9WgXcQ",
          snippet: { liveBroadcastContent: "none" },
          status: { privacyStatus: "private", embeddable: true, uploadStatus: "processed" } }] }; } };
      },
    }),
  });

  await assert.rejects(app.createYouTubeVideo({
    actor: { id: "super-1", role: "superAdmin" },
    input: { youtubeUrl: "https://youtu.be/dQw4w9WgXcQ", title_en: "Care", title_ar: "رعاية" },
  }), (error) => error.statusCode === 422 && error.errors?.[0]?.code === "VIDEO_YOUTUBE_UNAVAILABLE");
});

test("YouTube creation rejects a playlist or a Reel payload", async () => {
  const app = createEditorialVideoService({
    repository: { async create() { throw new Error("must not create"); } },
    verifyYouTube: async () => {},
  });
  const actor = { id: "super-1", role: "superAdmin" };
  const metadata = { title_en: "Care", title_ar: "رعاية" };

  await assert.rejects(app.createYouTubeVideo({ actor, input: {
    ...metadata, youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123",
  } }), (error) => error.statusCode === 422);
  await assert.rejects(app.createYouTubeVideo({ actor, input: {
    ...metadata, kind: "reel", youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
  } }), (error) => error.statusCode === 422);
});

test("rejecting a Pending Video Change preserves the published version for revision", async () => {
  let saved = { id: "video-11", revision: 3, kind: "youtube", youtubeId: "dQw4w9WgXcQ",
    status: "published", title_en: "Original", pendingChange: { authorId: "admin-2",
      status: "in_review", content: { youtubeId: "dQw4w9WgXcQ", title_en: "Proposed",
        title_ar: "مقترح", description_en: "", description_ar: "" } } };
  const app = createEditorialVideoService({
    repository: {
      async create() { throw new Error("unused"); },
      async get() { return { ...saved }; },
      async replace(_id, _revision, next) { saved = { ...next, revision: saved.revision + 1 }; return { ...saved }; },
    },
    verifyYouTube: async () => {},
  });

  const video = await app.reject({ id: "video-11", actor: { id: "super-1", role: "superAdmin" },
    reason: "Review the translation" });

  assert.equal(video.status, "published");
  assert.equal(video.title_en, "Original");
  assert.equal(video.pendingChange.status, "rejected");
  assert.equal(video.pendingChange.reviewReason, "Review the translation");
});

test("the Pending Video Change author can cancel without changing public content", async () => {
  let saved = { id: "video-12", revision: 2, kind: "youtube", youtubeId: "dQw4w9WgXcQ",
    status: "published", title_en: "Original", pendingChange: { authorId: "admin-2",
      status: "draft", content: { youtubeId: "dQw4w9WgXcQ", title_en: "Proposed",
        title_ar: "مقترح", description_en: "", description_ar: "" } } };
  const app = createEditorialVideoService({
    repository: {
      async create() { throw new Error("unused"); },
      async get() { return { ...saved }; },
      async replace(_id, _revision, next) { saved = { ...next, revision: saved.revision + 1 }; return { ...saved }; },
    },
    verifyYouTube: async () => {},
  });

  const video = await app.cancelPendingChange({ id: "video-12", actor: { id: "admin-2", role: "admin" } });

  assert.equal(video.status, "published");
  assert.equal(video.title_en, "Original");
  assert.equal(video.pendingChange, null);
});

test("staff can page through Videos administration without public flags", async () => {
  const app = createEditorialVideoService({
    repository: {
      async create() { throw new Error("unused"); },
      async list({ page, limit }) {
        assert.deepEqual({ page, limit }, { page: 2, limit: 10 });
        return { totalResults: 11, data: [{ id: "video-11", status: "in_review" }] };
      },
    },
    verifyYouTube: async () => {},
  });

  const result = await app.listAdmin({ actor: { id: "admin-1", role: "admin" }, page: "2", limit: "10" });

  assert.deepEqual(result, { totalResults: 11, totalPages: 2, page: 2, results: 1,
    data: [{ id: "video-11", status: "in_review" }] });
});

test("staff can inspect an unpublished Video and its Pending Video Change", async () => {
  const app = createEditorialVideoService({
    repository: {
      async create() { throw new Error("unused"); },
      async get() { return { id: "video-13", status: "unpublished",
        pendingChange: { status: "in_review", content: { title_en: "Proposed" } } }; },
    },
    verifyYouTube: async () => {},
  });

  const video = await app.getAdmin({ id: "video-13", actor: { id: "admin-1", role: "admin" } });

  assert.equal(video.pendingChange.content.title_en, "Proposed");
});

test("a YouTube share URL with harmless share parameters keeps only the canonical ID", async () => {
  const app = createEditorialVideoService({
    repository: { async create(record) { return { ...record, id: "video-14" }; } },
    verifyYouTube: async () => {},
  });

  const video = await app.createYouTubeVideo({ actor: { id: "admin-1", role: "admin" },
    input: { youtubeUrl: "https://youtu.be/dQw4w9WgXcQ?si=share-token",
      title_en: "Care", title_ar: "رعاية" } });

  assert.equal(video.youtubeId, "dQw4w9WgXcQ");
});

test("missing YouTube verification configuration fails closed before publication", async () => {
  const app = createEditorialVideoService({
    repository: { async create() { throw new Error("must not create"); } },
    verifyYouTube: createYouTubeVerifier({ apiKey: "" }),
  });

  await assert.rejects(app.createYouTubeVideo({ actor: { id: "super-1", role: "superAdmin" },
    input: { youtubeUrl: "https://youtu.be/dQw4w9WgXcQ", title_en: "Care", title_ar: "رعاية" } }),
  (error) => error.statusCode === 503 && error.errors?.[0]?.code === "VIDEO_YOUTUBE_CHECK_UNAVAILABLE");
});

test("a completed YouTube live broadcast is not accepted as an editorial Video", async () => {
  const app = createEditorialVideoService({
    repository: { async create() { throw new Error("must not create"); } },
    verifyYouTube: createYouTubeVerifier({ apiKey: "test-key", request: async () => ({
      ok: true, async json() { return { items: [{ id: "dQw4w9WgXcQ",
        snippet: { liveBroadcastContent: "none" }, liveStreamingDetails: { actualEndTime: "2026-09-27T12:00:00Z" },
        status: { privacyStatus: "public", embeddable: true, uploadStatus: "processed" } }] }; },
    }) }),
  });

  await assert.rejects(app.createYouTubeVideo({ actor: { id: "super-1", role: "superAdmin" },
    input: { youtubeUrl: "https://youtu.be/dQw4w9WgXcQ", title_en: "Care", title_ar: "رعاية" } }),
  (error) => error.statusCode === 422 && error.errors?.[0]?.code === "VIDEO_YOUTUBE_UNAVAILABLE");
});
