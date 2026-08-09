import assert from "node:assert/strict";
import test from "node:test";

import {
  presentSubstitutionQuote,
  presentSubstitutionRequest,
} from "../../../src/domains/substitution/substitution.presenter.js";

function requestFixture() {
  return {
    _id: "request-1",
    order: "order-1",
    orderNumber: "PY-1",
    warehouse: "warehouse-1",
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

test("customer substitution presentation excludes warehouse, inventory, and staff correction metadata", () => {
  const fixture = requestFixture();
  fixture.order = { _id: "order-1", instapayScreenshot: "private-proof" };
  fixture.activePaymentAttempt = {
    _id: "payment-attempt-1",
    merchantOrderId: "must-not-leak",
    paymobOrderId: "must-not-leak",
  };
  const presented = presentSubstitutionRequest(fixture);
  const [shortage] = presented.shortages;
  const [alternative] = shortage.alternatives;

  assert.equal("warehouseId" in presented, false);
  assert.equal(presented.orderId, "order-1");
  assert.equal(presented.activePaymentAttempt, "payment-attempt-1");
  assert.deepEqual(Object.keys(shortage).sort(), [
    "alternatives",
    "deliverableOriginalQuantity",
    "originalUnitPricePiastres",
    "productImageUrl",
    "productName_ar",
    "productName_en",
    "quantityBefore",
    "shortageId",
    "unavailableQuantity",
    "variantOptions",
  ]);
  assert.deepEqual(Object.keys(alternative).sort(), [
    "candidateId",
    "maxQuantity",
    "productImageUrl",
    "productName_ar",
    "productName_en",
    "unitPricePiastres",
    "variantOptions",
  ]);
  assert.equal(JSON.stringify(presented).match(
    /stockQuantitySnapshot|stockRevisionSnapshot|expectedUnallocatedQuantity|expectedStockRevision|correctionNote|warehouse-1|merchantOrderId|paymobOrderId|private-proof/,
  ), null);
});

test("staff substitution presentation retains the operational snapshot", () => {
  const presented = presentSubstitutionRequest(requestFixture(), { staff: true });
  const [shortage] = presented.shortages;

  assert.equal(presented.warehouseId, "warehouse-1");
  assert.equal(shortage.lineId, "order-line-1");
  assert.equal(shortage.expectedStockRevision, 7);
  assert.equal(shortage.alternatives[0].stockQuantitySnapshot, 15);
});

test("customer quote presentation excludes internal inventory demand snapshots", () => {
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
      deltaPiastres: 1500,
      walletToUsePiastres: 1000,
      additionalPaymentPiastres: 500,
      refundOrCreditPiastres: 0,
      deliveryDuePiastres: 0,
      requiresAdditionalInstapayScreenshot: false,
    },
    quoteRevision: "quote-revision",
    walletBalancePiastres: 1000,
  });

  assert.deepEqual(Object.keys(presented).sort(), [
    "quote",
    "quoteRevision",
    "selections",
    "walletBalancePiastres",
  ]);
  assert.equal(JSON.stringify(presented).match(
    /inventoryDemands|stockQuantitySnapshot|stockRevisionSnapshot|skuKey|productId/,
  ), null);
});
