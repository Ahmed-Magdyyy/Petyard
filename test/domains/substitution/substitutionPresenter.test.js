import assert from "node:assert/strict";
import test from "node:test";

import {
  presentSubstitutionPayment,
  presentSubstitutionQuote,
  presentSubstitutionRefund,
  presentSubstitutionRequest,
} from "../../../src/domains/substitution/substitution.presenter.js";

function requestFixture() {
  return {
    _id: "request-1",
    order: "order-1",
    orderNumber: "PY-1",
    warehouse: "warehouse-1",
    user: "user-1",
    guestId: "must-not-leak",
    status: "offered",
    revision: 0,
    offerPresetMinutes: 30,
    offerExpiresAt: new Date("2026-07-29T12:30:00.000Z"),
    shortages: [
      {
        shortageId: "shortage-1",
        lineId: "order-line-1",
        product: "original-product-1",
        variantId: "original-variant-1",
        productName_en: "Original",
        productName_ar: "Original ar",
        productImageUrl: "https://cdn.example/original.webp",
        variantOptions: [{ name: "Size", value: "Large", internal: "omit" }],
        quantityBefore: 3,
        deliverableOriginalQuantity: 1,
        unavailableQuantity: 2,
        finalizedUnavailableStart: 4,
        finalizedUnavailableEnd: 6,
        originalUnitPricePiastres: 2500,
        expectedUnallocatedQuantity: 11,
        expectedStockRevision: 7,
        correctedUnallocatedQuantity: 9,
        correctionReason: "offline_sale",
        correctionNote: "Internal staff note",
        alternatives: [
          {
            candidateId: "candidate-1",
            product: "substitute-product-1",
            variantId: "substitute-variant-1",
            productType: "VARIANT",
            productName_en: "Substitute",
            productName_ar: "Substitute ar",
            productImageUrl: "https://cdn.example/substitute.webp",
            variantOptions: [{ name: "Flavor", value: "Salmon", internal: "omit" }],
            unitPricePiastres: 3000,
            maxQuantity: 2,
            stockQuantitySnapshot: 15,
            stockRevisionSnapshot: 8,
          },
        ],
      },
    ],
    selections: [
      {
        shortageId: "shortage-1",
        choices: [{ candidateId: "candidate-1", quantity: 2, internal: "omit" }],
        rejectedQuantity: 0,
      },
    ],
  };
}

test("customer substitution presentation localizes names, converts EGP prices, and excludes operational metadata", () => {
  const fixture = requestFixture();
  fixture.order = { _id: "order-1", instapayScreenshot: "private-proof" };
  fixture.activePaymentAttempt = {
    _id: "payment-attempt-1",
    merchantOrderId: "must-not-leak",
    paymobOrderId: "must-not-leak",
  };
  const presented = presentSubstitutionRequest(fixture, { lang: "en" });
  const [shortage] = presented.shortages;
  const [alternative] = shortage.alternatives;

  assert.equal("warehouseId" in presented, false);
  assert.equal(presented.orderId, "order-1");
  assert.equal(presented.activePaymentAttempt, "payment-attempt-1");
  assert.deepEqual(Object.keys(shortage).sort(), [
    "alternatives",
    "deliverableOriginalQuantity",
    "originalUnitPrice",
    "productImageUrl",
    "productName",
    "quantityBefore",
    "shortageId",
    "unavailableQuantity",
    "variantOptions",
  ]);
  assert.deepEqual(Object.keys(alternative).sort(), [
    "candidateId",
    "maxQuantity",
    "productImageUrl",
    "productName",
    "unitPrice",
    "variantOptions",
  ]);
  assert.equal(JSON.stringify(presented).match(
    /Piastres|productName_en|productName_ar|guestId|must-not-leak|stockQuantitySnapshot|stockRevisionSnapshot|expectedUnallocatedQuantity|expectedStockRevision|correctionNote|warehouse-1|merchantOrderId|paymobOrderId|private-proof/,
  ), null);
  assert.equal(presented.currency, "EGP");
  assert.equal(presented.additionalInstapayScreenshotsSubmitted, false);
  assert.equal(shortage.productName, "Original");
  assert.equal(shortage.originalUnitPrice, 25);
  assert.equal(alternative.productName, "Substitute");
  assert.equal(alternative.unitPrice, 30);
});

test("staff substitution presentation retains safe operations data with Arabic names and EGP prices", () => {
  const presented = presentSubstitutionRequest(requestFixture(), {
    staff: true,
    lang: "ar",
  });
  const [shortage] = presented.shortages;
  const [alternative] = shortage.alternatives;

  assert.equal(presented.warehouseId, "warehouse-1");
  assert.equal(shortage.lineId, "order-line-1");
  assert.equal(shortage.productName, "Original ar");
  assert.equal(shortage.originalUnitPrice, 25);
  assert.equal(shortage.expectedStockRevision, 7);
  assert.equal(alternative.productName, "Substitute ar");
  assert.equal(alternative.unitPrice, 30);
  assert.equal(alternative.stockQuantitySnapshot, 15);
  assert.equal("guestId" in presented, false);
  assert.equal("originalInstapayVerifiedAt" in presented, false);
  assert.equal("originalInstapayVerifiedBy" in presented, false);
  assert.equal("user" in presented, false);
  assert.equal(
    JSON.stringify(presented).match(
      /Piastres|productName_en|productName_ar|must-not-leak/,
    ),
    null,
  );
});

test("customer quote presentation converts signed and unsigned money to EGP and excludes inventory demands", () => {
  const presented = presentSubstitutionQuote({
    selections: [{
      shortageId: "shortage-1",
      choices: [{ candidateId: "candidate-1", quantity: 2 }],
      rejectedQuantity: 0,
    }],
    inventoryDemands: [{
      skuKey: "simple:substitute-product-1",
      productId: "substitute-product-1",
      quantity: 2,
      snapshot: { stockQuantitySnapshot: 15, stockRevisionSnapshot: 8 },
    }],
    quote: {
      previousOrderValuePiastres: 5000,
      finalMerchandiseGrossPiastres: 6000,
      preservedCouponDiscountPiastres: 500,
      lockedNetShippingPiastres: 1000,
      newOrderValuePiastres: 6500,
      deltaPiastres: -1500,
      walletToUsePiastres: 0,
      additionalPaymentPiastres: 0,
      refundOrCreditPiastres: 1500,
      deliveryDuePiastres: 0,
      requiresAdditionalInstapayScreenshots: false,
    },
    quoteRevision: "quote-revision",
    walletBalancePiastres: 1000,
  });

  assert.deepEqual(Object.keys(presented).sort(), [
    "currency",
    "quote",
    "quoteRevision",
    "selections",
    "walletBalance",
  ]);
  assert.deepEqual(presented.quote, {
    previousOrderValue: 50,
    finalMerchandiseGross: 60,
    preservedCouponDiscount: 5,
    lockedNetShipping: 10,
    newOrderValue: 65,
    delta: -15,
    walletToUse: 0,
    additionalPayment: 0,
    refundOrCredit: 15,
    deliveryDue: 0,
    requiresAdditionalInstapayScreenshots: false,
  });
  assert.equal(presented.currency, "EGP");
  assert.equal(presented.walletBalance, 10);
  assert.equal(JSON.stringify(presented).match(
    /Piastres|inventoryDemands|stockQuantitySnapshot|stockRevisionSnapshot|skuKey|productId/,
  ), null);
});

test("payment and refund presentation expose normal EGP amounts without internal piastre fields", () => {
  const payment = presentSubstitutionPayment({
    attempt: {
      id: "attempt-1",
      status: "awaiting_payment",
      amountPiastres: 2050,
      currency: "EGP",
      attemptNumber: 1,
    },
    clientSecret: "client-secret",
    publicKey: "public-key",
  });
  const refund = presentSubstitutionRefund({
    id: "refund-1",
    method: "card",
    status: "pending",
    amountPiastres: 1550,
  });

  assert.equal(payment.attempt.amount, 20.5);
  assert.equal(payment.attempt.currency, "EGP");
  assert.equal(refund.amount, 15.5);
  assert.equal(refund.currency, "EGP");
  assert.equal(JSON.stringify({ payment, refund }).includes("Piastres"), false);
});
