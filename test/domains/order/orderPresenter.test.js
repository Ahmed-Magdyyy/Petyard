import assert from "node:assert/strict";
import test from "node:test";

import {
  presentOrder,
  presentOrderPage,
} from "../../../src/domains/order/order.presenter.js";

function withPrivateDeliveryEnvironment(run) {
  const before = {
    BUNNY_PRIVATE_CDN_BASE_URL: process.env.BUNNY_PRIVATE_CDN_BASE_URL,
    BUNNY_PRIVATE_TOKEN_KEY: process.env.BUNNY_PRIVATE_TOKEN_KEY,
    BUNNY_PRIVATE_URL_TTL_SECONDS: process.env.BUNNY_PRIVATE_URL_TTL_SECONDS,
  };
  Object.assign(process.env, {
    BUNNY_PRIVATE_CDN_BASE_URL: "https://proofs.petyardstores.com",
    BUNNY_PRIVATE_TOKEN_KEY: "presenter-test-key",
    BUNNY_PRIVATE_URL_TTL_SECONDS: "300",
  });
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("presentOrder preserves the legacy proof field and adds the proof array", () => {
  const order = {
    _id: "order-1",
    status: "pending",
    items: [{ productName: "Food", quantity: 1 }],
    instapayScreenshot: "https://proofs.petyardstores.com/instapay_screenshots/proof.webp",
  };
  const result = withPrivateDeliveryEnvironment(() => presentOrder(order));

  assert.notEqual(result, order);
  assert.notEqual(result.instapayScreenshot, order.instapayScreenshot);
  assert.equal(result.instapayScreenshots.length, 1);
  assert.equal(result.instapayScreenshots[0], result.instapayScreenshot);
  assert.equal(order.instapayScreenshot, "https://proofs.petyardstores.com/instapay_screenshots/proof.webp");
  assert.match(result.instapayScreenshot, /[?&]token=HS256-/);
  assert.match(result.instapayScreenshot, /[?&]expires=/);
});

test("presentOrder signs every InstaPay proof and keeps the first as the legacy value", () => {
  const order = {
    _id: "order-multiple",
    instapayScreenshot: "https://proofs.petyardstores.com/instapay_screenshots/one.webp",
    instapayScreenshots: [
      "https://proofs.petyardstores.com/instapay_screenshots/one.webp",
      "https://proofs.petyardstores.com/instapay_screenshots/two.webp",
    ],
  };

  const result = withPrivateDeliveryEnvironment(() => presentOrder(order));

  assert.equal(result.instapayScreenshots.length, 2);
  assert.equal(result.instapayScreenshot, result.instapayScreenshots[0]);
  assert.match(result.instapayScreenshots[0], /[?&]token=HS256-/);
  assert.match(result.instapayScreenshots[1], /[?&]token=HS256-/);
});

test("presentOrder uses toJSON exactly once without mutating a Mongoose-like object", () => {
  let serializations = 0;
  const document = {
    instapayScreenshot: "https://res.cloudinary.com/dxemmiorv/image/upload/v1/instapay_screenshots/proof.png",
    toJSON() {
      serializations += 1;
      return { _id: "order-2", status: "pending", instapayScreenshot: this.instapayScreenshot };
    },
  };
  const result = presentOrder(document);
  assert.equal(serializations, 1);
  assert.deepEqual(result, {
    _id: "order-2",
    status: "pending",
    instapayScreenshot: document.instapayScreenshot,
    instapayScreenshots: [document.instapayScreenshot],
  });
  assert.equal(document.instapayScreenshot, "https://res.cloudinary.com/dxemmiorv/image/upload/v1/instapay_screenshots/proof.png");
});

test("presentOrder leaves missing, null, and Cloudinary proof values unchanged", () => {
  assert.deepEqual(presentOrder({ _id: "missing" }), { _id: "missing" });
  assert.deepEqual(presentOrder({ _id: "null", instapayScreenshot: null }), { _id: "null", instapayScreenshot: null });
  assert.equal(presentOrder(null), null);
});

test("presentOrder exposes settlement money in EGP without leaking piastre fields", () => {
  const order = {
    _id: "settlement-order",
    settlement: {
      schemaVersion: 1,
      revision: 1,
      currency: "EGP",
      currentMerchandiseGrossPiastres: 96_500,
      originalCouponDiscountPiastres: 0,
      preservedCouponDiscountPiastres: 0,
      lockedNetShippingPiastres: 3_000,
      currentOrderValuePiastres: 99_500,
      walletDebitedPiastres: 0,
      walletCreditedPiastres: 0,
      cardCapturedPiastres: 0,
      cardRefundedPiastres: 0,
      cardDuePiastres: 0,
      instapaySubmittedPiastres: 0,
      instapayConfirmedPiastres: 0,
      deliveryDuePiastres: 99_500,
      pendingRefundLiabilityPiastres: 0,
      migrationState: "native",
    },
  };

  const result = presentOrder(order);

  assert.deepEqual(result.settlement, {
    schemaVersion: 1,
    revision: 1,
    currency: "EGP",
    currentMerchandiseGross: 965,
    originalCouponDiscount: 0,
    preservedCouponDiscount: 0,
    lockedNetShipping: 30,
    currentOrderValue: 995,
    walletDebited: 0,
    walletCredited: 0,
    cardCaptured: 0,
    cardRefunded: 0,
    cardDue: 0,
    instapaySubmitted: 0,
    instapayConfirmed: 0,
    deliveryDue: 995,
    pendingRefundLiability: 0,
    migrationState: "native",
  });
  assert.equal(
    Object.keys(result.settlement).some((key) => key.endsWith("Piastres")),
    false,
  );
  assert.equal(order.settlement.currentOrderValuePiastres, 99_500);
});

test("presentOrderPage preserves pagination metadata and only presents data entries", () => {
  const page = {
    data: [
      { _id: "one", instapayScreenshot: null },
      { _id: "two", instapayScreenshot: "https://external.example/proof.png" },
    ],
    page: 2,
    totalPages: 4,
    statusCounts: { pending: 3 },
  };
  const result = presentOrderPage(page);
  assert.notEqual(result, page);
  assert.notEqual(result.data, page.data);
  assert.equal(result.page, 2);
  assert.equal(result.totalPages, 4);
  assert.equal(result.statusCounts, page.statusCounts);
  assert.deepEqual(result.data, [
    page.data[0],
    {
      ...page.data[1],
      instapayScreenshots: [page.data[1].instapayScreenshot],
    },
  ]);
});
