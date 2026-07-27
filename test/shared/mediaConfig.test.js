import assert from "node:assert/strict";
import test from "node:test";

import {
  MEDIA_STORAGE_PROVIDERS,
  getMediaConfiguration,
  parseHttpsOrigin,
  parseMediaProvider,
  validateMediaConfiguration,
} from "../../src/shared/utils/mediaConfig.js";

const publicZone = {
  BUNNY_PUBLIC_STORAGE_ZONE: "petyardpublicmedia",
  BUNNY_PUBLIC_STORAGE_ACCESS_KEY: "public-secret-value",
  BUNNY_PUBLIC_STORAGE_ENDPOINT: "https://storage.bunnycdn.com",
  BUNNY_PUBLIC_CDN_BASE_URL: "https://media.petyardstores.com",
};

const privateZone = {
  BUNNY_PRIVATE_STORAGE_ZONE: "petyardprivatepayments",
  BUNNY_PRIVATE_STORAGE_ACCESS_KEY: "private-secret-value",
  BUNNY_PRIVATE_STORAGE_ENDPOINT: "https://storage.bunnycdn.com",
  BUNNY_PRIVATE_CDN_BASE_URL: "https://proofs.petyardstores.com",
  BUNNY_PRIVATE_TOKEN_KEY: "token-secret-value",
};

test("media providers default to Cloudinary and normalize accepted casing", () => {
  assert.equal(parseMediaProvider(undefined, "PUBLIC_MEDIA_STORAGE_PROVIDER"), "cloudinary");
  assert.equal(parseMediaProvider(" BuNnY ", "PUBLIC_MEDIA_STORAGE_PROVIDER"), "bunny");
  assert.deepEqual(getMediaConfiguration({}), {
    publicProvider: MEDIA_STORAGE_PROVIDERS.CLOUDINARY,
    privateProvider: MEDIA_STORAGE_PROVIDERS.CLOUDINARY,
    public: null,
    private: null,
    privateTokenKey: null,
    privateUrlTtlSeconds: 300,
    storageTimeoutMs: 15000,
  });
});

test("invalid provider and Bunny configuration failures are sanitized", () => {
  assert.throws(
    () => parseMediaProvider("s3", "PUBLIC_MEDIA_STORAGE_PROVIDER"),
    /PUBLIC_MEDIA_STORAGE_PROVIDER must be cloudinary or bunny/,
  );

  for (const variableName of Object.keys(publicZone)) {
    const env = { PUBLIC_MEDIA_STORAGE_PROVIDER: "bunny", ...publicZone };
    delete env[variableName];
    assert.throws(() => getMediaConfiguration(env), new RegExp(variableName));
  }

  for (const variableName of Object.keys(privateZone).filter(
    (name) => name !== "BUNNY_PRIVATE_TOKEN_KEY",
  )) {
    const env = { PRIVATE_MEDIA_STORAGE_PROVIDER: "bunny", ...privateZone };
    delete env[variableName];
    assert.throws(() => getMediaConfiguration(env), new RegExp(variableName));
  }

  assert.throws(
    () =>
      validateMediaConfiguration({
        PRIVATE_MEDIA_STORAGE_PROVIDER: "bunny",
        ...privateZone,
        BUNNY_PRIVATE_TOKEN_KEY: "",
      }),
    /BUNNY_PRIVATE_TOKEN_KEY/,
  );

  assert.throws(() => validateMediaConfiguration({ PUBLIC_MEDIA_STORAGE_PROVIDER: "bunny" }));
  for (const secret of Object.values({ ...publicZone, ...privateZone })) {
    try {
      getMediaConfiguration({ PUBLIC_MEDIA_STORAGE_PROVIDER: "bunny", ...publicZone });
    } catch (error) {
      assert.doesNotMatch(error.message, new RegExp(secret));
    }
  }
});

test("only HTTPS origin-only configuration URLs are accepted", () => {
  assert.equal(parseHttpsOrigin("https://media.petyardstores.com", "BUNNY_PUBLIC_CDN_BASE_URL"), "https://media.petyardstores.com");
  for (const value of [
    "http://media.petyardstores.com",
    "https://media.petyardstores.com/path",
    "https://media.petyardstores.com/?query=1",
    "https://user:password@media.petyardstores.com",
    "https://media.petyardstores.com/#fragment",
  ]) {
    assert.throws(() => parseHttpsOrigin(value, "BUNNY_PUBLIC_CDN_BASE_URL"));
  }
  assert.throws(
    () => parseHttpsOrigin("https://ny.storage.bunnycdn.com", "BUNNY_PUBLIC_STORAGE_ENDPOINT", { storageEndpoint: true }),
    /BUNNY_PUBLIC_STORAGE_ENDPOINT/,
  );
});

test("TTL and timeout use documented defaults and bounds", () => {
  assert.deepEqual(
    getMediaConfiguration({
      BUNNY_PRIVATE_URL_TTL_SECONDS: "1",
      BUNNY_STORAGE_TIMEOUT_MS: "999999",
    }),
    {
      publicProvider: "cloudinary",
      privateProvider: "cloudinary",
      public: null,
      private: null,
      privateTokenKey: null,
      privateUrlTtlSeconds: 60,
      storageTimeoutMs: 60000,
    },
  );
});
