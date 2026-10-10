import assert from "node:assert/strict";
import test from "node:test";
import { createEditorialVideoGuards } from "../../../../src/domains/videos/editorial/editorialVideo.middleware.js";

test("production upload guards open only after explicit pipeline activation", () => {
  const configuration = {
    BUNNY_STREAM_LIBRARY_ID: "754739",
    BUNNY_STREAM_API_KEY: "test-api-key",
    BUNNY_STREAM_READ_ONLY_API_KEY: "test-read-only-key",
    BUNNY_STREAM_CDN_HOSTNAME: "example.b-cdn.net",
    BUNNY_STREAM_TOKEN_KEY: "test-token-key",
    REEL_UPLOADS_ENABLED: "true",
    REEL_UPLOAD_PIPELINE_READY: "false",
    VIDEO_COVER_PIPELINE_READY: "false",
  };
  const previous = Object.fromEntries(Object.keys(configuration).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, configuration);
    const guards = createEditorialVideoGuards();
    const result = guard => { let error; guard({}, {}, value => { error = value; }); return error; };
    assert.equal(result(guards.requireReelUploads).statusCode, 503);
    assert.equal(result(guards.requireCoverUploads).statusCode, 503);
    process.env.REEL_UPLOAD_PIPELINE_READY = "true";
    process.env.VIDEO_COVER_PIPELINE_READY = "true";
    assert.equal(result(guards.requireReelUploads), undefined);
    assert.equal(result(guards.requireCoverUploads), undefined);
    process.env.REEL_UPLOADS_ENABLED = "false";
    assert.equal(result(guards.requireReelUploads).statusCode, 503);
    assert.equal(result(guards.requireCoverUploads), undefined);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
