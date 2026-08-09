import assert from "node:assert/strict";
import test from "node:test";

import { OrderModel } from "../../../src/domains/order/order.model.js";
import {
  getInstapayScreenshotFiles,
  MAX_INSTAPAY_SCREENSHOTS,
} from "../../../src/domains/order/order.instapay.js";

test("legacy InstaPay upload field remains supported", () => {
  const legacyFile = { originalname: "proof.jpg" };

  assert.deepEqual(
    getInstapayScreenshotFiles({
      files: { instapayScreenshot: [legacyFile] },
    }),
    [legacyFile],
  );
});

test("new InstaPay upload field returns all submitted files", () => {
  const files = Array.from({ length: MAX_INSTAPAY_SCREENSHOTS }, (_, index) => ({
    originalname: `proof-${index + 1}.jpg`,
  }));

  assert.deepEqual(
    getInstapayScreenshotFiles({ files: { instapayScreenshots: files } }),
    files,
  );
});

test("order model permits five InstaPay screenshots and rejects six", () => {
  const fiveScreenshots = Array.from(
    { length: MAX_INSTAPAY_SCREENSHOTS },
    (_, index) => `https://example.com/proof-${index + 1}.jpg`,
  );
  const validOrder = new OrderModel({ instapayScreenshots: fiveScreenshots });
  const invalidOrder = new OrderModel({
    instapayScreenshots: [
      ...fiveScreenshots,
      "https://example.com/proof-6.jpg",
    ],
  });

  assert.equal(validOrder.validateSync()?.errors.instapayScreenshots, undefined);
  assert.ok(invalidOrder.validateSync()?.errors.instapayScreenshots);
});
