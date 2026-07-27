import assert from "node:assert/strict";
import test from "node:test";

import { getPrivateImageDeliveryUrl } from "../../src/shared/utils/privateImageDelivery.js";

const config = {
  private: { cdnBaseUrl: "https://proofs.petyardstores.com" },
  privateUrlTtlSeconds: 300,
};
const source = "https://proofs.petyardstores.com/instapay_screenshots/proof.webp";
const key = "fixture-signing-key";
const now = 1_700_000_000_000;

test("signs the exact Bunny HMAC-SHA256 input with unpadded Base64URL", () => {
  const signed = new URL(getPrivateImageDeliveryUrl(source, { config, signingKey: key, now }));
  assert.equal(signed.pathname, "/instapay_screenshots/proof.webp");
  assert.equal(signed.searchParams.get("expires"), "1700000300");
  assert.equal(
    signed.searchParams.get("token"),
    "HS256-e_5rrlqMBKIdoclnTAQ9DCWuahYQYNN9McJrUUwLCLE",
  );
  assert.doesNotMatch(signed.searchParams.get("token"), /[+=/]/);
  assert.equal([...signed.searchParams.keys()].join(","), "token,expires");
});

test("removes stale token data before creating a fresh 300-second token", () => {
  const signed = new URL(getPrivateImageDeliveryUrl(`${source}?token=old&expires=1`, { config, signingKey: key, now }));
  assert.equal(signed.searchParams.get("expires"), "1700000300");
  assert.notEqual(signed.searchParams.get("token"), "old");
  assert.equal([...signed.searchParams.keys()].length, 2);
});

test("passes through values not eligible for private delivery", () => {
  for (const value of [
    null,
    undefined,
    "",
    "not a URL",
    "https://res.cloudinary.com/dxemmiorv/image/upload/v1/instapay_screenshots/proof.png",
    "https://media.petyardstores.com/petyard/orders/proof.webp",
    "https://external.example/proof.webp",
  ]) {
    assert.equal(getPrivateImageDeliveryUrl(value, { config, signingKey: key, now }), value);
  }
});

test("fails closed for eligible private URLs with invalid input or missing signing configuration", async () => {
  await assert.rejects(
    async () => getPrivateImageDeliveryUrl(`${source}?untrusted=1`, { config, signingKey: key, now }),
  );
  await assert.rejects(
    async () => getPrivateImageDeliveryUrl(`${source}#fragment`, { config, signingKey: key, now }),
  );
  await assert.rejects(
    async () => getPrivateImageDeliveryUrl(source, { config, now }),
    (error) => {
      assert.doesNotMatch(error.message, /fixture-signing-key/);
      return true;
    },
  );
  await assert.rejects(
    async () => getPrivateImageDeliveryUrl(source.replace("https:", "http:"), { config, signingKey: key, now }),
  );
});
