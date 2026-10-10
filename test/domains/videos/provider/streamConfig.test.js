import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../../../../src/shared/utils/ApiError.js";
import {
  getVideosStreamConfiguration,
  validateVideosStreamConfiguration,
} from "../../../../src/domains/videos/provider/streamConfig.js";

const completeStreamEnvironment = {
  BUNNY_STREAM_LIBRARY_ID: "754739",
  BUNNY_STREAM_API_KEY: "stream-api-key",
  BUNNY_STREAM_READ_ONLY_API_KEY: "stream-read-only-key",
  BUNNY_STREAM_CDN_HOSTNAME: "vz-75c6f60b-a70.b-cdn.net",
  BUNNY_STREAM_TOKEN_KEY: "cdn-token-key",
};

test("Videos Stream configuration keeps all feature switches disabled by default", () => {
  assert.deepEqual(getVideosStreamConfiguration({}), {
    flags: {
      videosPublicEnabled: false,
      reelUploadsEnabled: false,
      reelPipelineReady: false,
      coverPipelineReady: false,
      productVideoUploadsEnabled: false,
      productVideosPublicEnabled: false,
    },
    stream: null,
  });
});

test("Videos Stream configuration rejects a misspelled feature switch", () => {
  assert.throws(
    () => validateVideosStreamConfiguration({ REEL_UPLOADS_ENABLED: "treu" }),
    /REEL_UPLOADS_ENABLED must be true or false/,
  );
});

test("upload readiness requires explicit release switches and valid provider configuration", () => {
  const configuration = validateVideosStreamConfiguration({
    ...completeStreamEnvironment,
    REEL_UPLOAD_PIPELINE_READY: "true",
    VIDEO_COVER_PIPELINE_READY: "true",
  });
  assert.equal(configuration.flags.reelPipelineReady, true);
  assert.equal(configuration.flags.coverPipelineReady, true);
  assert.equal(configuration.flags.reelUploadsEnabled, false);
  assert.throws(() => validateVideosStreamConfiguration({ REEL_UPLOAD_PIPELINE_READY: "true" }), /BUNNY_STREAM_LIBRARY_ID is required/);
  assert.throws(() => validateVideosStreamConfiguration({ VIDEO_COVER_PIPELINE_READY: "yes" }), /VIDEO_COVER_PIPELINE_READY must be true or false/);
});

test("Videos Stream configuration leaves incomplete staged Stream values inert while every switch is off", () => {
  assert.equal(
    validateVideosStreamConfiguration({
      BUNNY_STREAM_LIBRARY_ID: "754739",
    }).stream,
    null,
  );
});

test("Videos Stream configuration can support protected previews while public switches stay off", () => {
  const configuration = validateVideosStreamConfiguration(completeStreamEnvironment);
  assert.equal(configuration.flags.videosPublicEnabled, false);
  assert.equal(configuration.stream.libraryId, "754739");
});

test("Videos Stream configuration rejects an enabled feature without complete Stream configuration", () => {
  assert.throws(
    () =>
      validateVideosStreamConfiguration({
        VIDEOS_PUBLIC_ENABLED: "true",
        BUNNY_STREAM_LIBRARY_ID: "754739",
      }),
    (error) =>
      error instanceof ApiError &&
      error.statusCode === 500 &&
      error.message === "BUNNY_STREAM_API_KEY is required when a Videos feature is enabled",
  );
});

test("Videos Stream configuration accepts complete Stream configuration only when required", () => {
  const configuration = validateVideosStreamConfiguration({
    ...completeStreamEnvironment,
    PRODUCT_VIDEO_UPLOADS_ENABLED: "true",
  });

  assert.equal(configuration.flags.productVideoUploadsEnabled, true);
  assert.equal(configuration.stream.uploadAuthorizationTtlSeconds, 21600);
  assert.equal(configuration.stream.playbackTtlSeconds, 900);
  assert.equal(configuration.stream.requestTimeoutMs, 15000);
  assert.equal(configuration.stream.readOnlyApiKey, "stream-read-only-key");
});

test("Videos Stream configuration requires the webhook signing key before enabling a feature", () => {
  const { BUNNY_STREAM_READ_ONLY_API_KEY, ...withoutWebhookKey } =
    completeStreamEnvironment;
  assert.throws(
    () =>
      validateVideosStreamConfiguration({
        ...withoutWebhookKey,
        REEL_UPLOADS_ENABLED: "true",
      }),
    /BUNNY_STREAM_READ_ONLY_API_KEY is required/,
  );
});

test("Videos Stream configuration never authorizes more than six hours of TUS access", () => {
  const configuration = validateVideosStreamConfiguration({
    ...completeStreamEnvironment,
    REEL_UPLOADS_ENABLED: "true",
    BUNNY_STREAM_UPLOAD_AUTH_TTL_SECONDS: "30000",
  });
  assert.equal(configuration.stream.uploadAuthorizationTtlSeconds, 21600);
});

test("Videos Stream configuration caps playback lifetime at fifteen minutes", () => {
  const configuration = validateVideosStreamConfiguration({
    ...completeStreamEnvironment,
    VIDEOS_PUBLIC_ENABLED: "true",
    BUNNY_STREAM_PLAYBACK_TTL_SECONDS: "901",
  });

  assert.equal(configuration.stream.playbackTtlSeconds, 900);
});
