import assert from "node:assert/strict";
import test from "node:test";
import { isExpiredTusRejection } from "./fixtures/videoLiveMediaAcceptance.js";

test("expired TUS proof accepts explicit expiry errors and rejects unrelated failures", () => {
  assert.equal(isExpiredTusRejection(400, "Authorization has expired"), true);
  assert.equal(isExpiredTusRejection(400, "Invalid expiry time. It cannot be in the past."), true);
  for (const status of [401, 403]) assert.equal(isExpiredTusRejection(status, ""), true);
  for (const [status, body] of [[400, "Invalid upload offset"], [400, "Invalid signature"],
    [400, "Invalid expiry time"], [400, "Expiry time exceeds the allowed future limit"],
    [404, "Resource not found"], [409, "Offset mismatch"], [500, "Authorization has expired"], [204, ""]]) {
    assert.equal(isExpiredTusRejection(status, body), false);
  }
});
