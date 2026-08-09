import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import mongoose from "mongoose";

import {
  orderStatusEnum,
  paymentMethodEnum,
} from "../../../src/shared/constants/enums.js";
import { buildWarehouseSkuSnapshot } from "../../../src/domains/product/productPricing.service.js";
import {
  calculateSubstitutionQuote,
  normalizeSubstitutionSelections,
} from "../../../src/domains/substitution/substitution.pricing.js";
import { SubstitutionRequestModel } from "../../../src/domains/substitution/substitutionRequest.model.js";
import { applyQuoteToLegacyOrderAmounts } from "../../../src/domains/substitution/substitution.order.js";

function alternative({
  candidateId,
  product,
  unitPricePiastres = 333,
  maxQuantity = 2,
}) {
  return {
    candidateId,
    product,
    productType: "SIMPLE",
    unitPricePiastres,
    maxQuantity,
    stockQuantitySnapshot: maxQuantity,
    stockRevisionSnapshot: 4,
  };
}

function requestFixture() {
  return {
    _id: "request-1",
    revision: 3,
    shortages: [
      {
        shortageId: "shortage-1",
        unavailableQuantity: 2,
        alternatives: [
          alternative({ candidateId: "candidate-1", product: "substitute-sku" }),
        ],
      },
      {
        shortageId: "shortage-2",
        unavailableQuantity: 1,
        alternatives: [
          alternative({
            candidateId: "candidate-2",
            product: "substitute-sku",
            maxQuantity: 1,
          }),
        ],
      },
    ],
  };
}

function orderFixture(paymentMethod = paymentMethodEnum.CARD) {
  return {
    paymentMethod,
    // quantity intentionally differs from fulfillmentQuantity. Quotes must only
    // price deliverable order lines, never restore the unavailable original units.
    items: [{ quantity: 3, fulfillmentQuantity: 1, itemPricePiastres: 1000 }],
    settlement: {
      originalCouponDiscountPiastres: 300,
      lockedNetShippingPiastres: 500,
      currentOrderValuePiastres: 1200,
      deliveryDuePiastres: 1200,
    },
  };
}

function baseStoredRequest({ user, guestId } = {}) {
  const order = new mongoose.Types.ObjectId();
  const warehouse = new mongoose.Types.ObjectId();
  const product = new mongoose.Types.ObjectId();
  const offeredBy = new mongoose.Types.ObjectId();
  return {
    order,
    warehouse,
    orderNumber: "PY-SUB-1",
    user,
    guestId,
    requestSequence: 1,
    paymentMethod: paymentMethodEnum.COD,
    offerExpiresAt: new Date(Date.now() + 60_000),
    offeredBy,
    offerIdempotencyKey: "offer-key-123",
    shortages: [
      {
        shortageId: "shortage-1",
        lineId: "line-1",
        product,
        productType: "SIMPLE",
        productName_en: "Original",
        productName_ar: "Original",
        quantityBefore: 2,
        deliverableOriginalQuantity: 1,
        unavailableQuantity: 1,
        finalizedUnavailableStart: 0,
        finalizedUnavailableEnd: 1,
        originalUnitPricePiastres: 1000,
        expectedUnallocatedQuantity: 4,
        expectedStockRevision: 2,
        correctedUnallocatedQuantity: 3,
      },
    ],
  };
}

async function loadFeatureConfig({ enabled, allowlist } = {}) {
  const savedEnabled = process.env.ORDER_SUBSTITUTIONS_ENABLED;
  const savedAllowlist = process.env.ORDER_SUBSTITUTION_WAREHOUSE_ALLOWLIST;
  try {
    if (enabled === undefined) delete process.env.ORDER_SUBSTITUTIONS_ENABLED;
    else process.env.ORDER_SUBSTITUTIONS_ENABLED = enabled;
    if (allowlist === undefined) {
      delete process.env.ORDER_SUBSTITUTION_WAREHOUSE_ALLOWLIST;
    } else {
      process.env.ORDER_SUBSTITUTION_WAREHOUSE_ALLOWLIST = allowlist;
    }
    const moduleUrl = pathToFileURL(
      resolve("src/domains/substitution/substitution.config.js"),
    );
    return await import(`${moduleUrl.href}?feature-test=${crypto.randomUUID()}`);
  } finally {
    if (savedEnabled === undefined) delete process.env.ORDER_SUBSTITUTIONS_ENABLED;
    else process.env.ORDER_SUBSTITUTIONS_ENABLED = savedEnabled;
    if (savedAllowlist === undefined) {
      delete process.env.ORDER_SUBSTITUTION_WAREHOUSE_ALLOWLIST;
    } else {
      process.env.ORDER_SUBSTITUTION_WAREHOUSE_ALLOWLIST = savedAllowlist;
    }
  }
}

test("substitution configuration is disabled by default and scopes an enabled rollout to its exact warehouse allowlist", async () => {
  const disabled = await loadFeatureConfig();
  assert.equal(disabled.isOrderSubstitutionEnabledForWarehouse("warehouse-a"), false);
  assert.equal(disabled.getSubstitutionExpiryMinutes(), 30);
  assert.equal(disabled.getSubstitutionExpiryMinutes(15), 15);
  assert.equal(disabled.getSubstitutionExpiryMinutes(16), 30);

  const enabled = await loadFeatureConfig({
    enabled: "true",
    allowlist: "warehouse-a, warehouse-b",
  });
  assert.equal(enabled.isOrderSubstitutionEnabledForWarehouse("warehouse-a"), true);
  assert.equal(enabled.isOrderSubstitutionEnabledForWarehouse("warehouse-b"), true);
  assert.equal(enabled.isOrderSubstitutionEnabledForWarehouse("warehouse-c"), false);
});

test("candidate snapshot reads only the stored order warehouse and locks the effective price in piastres", () => {
  const product = {
    _id: "product-1",
    type: "SIMPLE",
    name_en: "Substitute",
    name_ar: "بديل",
    price: 30,
    discountedPrice: 19.99,
    isActive: true,
    warehouseStocks: [
      { warehouse: "other-warehouse", quantity: 50, revision: 8 },
      { warehouse: "order-warehouse", quantity: 2, revision: 6 },
    ],
  };

  const snapshot = buildWarehouseSkuSnapshot({
    product,
    warehouseId: "order-warehouse",
  });
  assert.equal(snapshot.stockQuantity, 2);
  assert.equal(snapshot.stockRevision, 6);
  assert.equal(snapshot.unitPricePiastres, 1999);

  assert.throws(
    () =>
      buildWarehouseSkuSnapshot({
        product,
        warehouseId: "missing-warehouse",
      }),
    (error) => error.statusCode === 409,
  );
});

test("quotes require each actionable shortage, support flexible rejection, aggregate repeated substitute SKUs, and use integer piastres", () => {
  const request = requestFixture();
  const selections = [
    {
      shortageId: "shortage-1",
      choices: [{ candidateId: "candidate-1", quantity: 2 }],
    },
    {
      shortageId: "shortage-2",
      choices: [{ candidateId: "candidate-2", quantity: 1 }],
    },
  ];
  const quote = calculateSubstitutionQuote({
    order: orderFixture(),
    request,
    selections,
    walletBalancePiastres: 400,
    registeredCustomer: true,
  });

  assert.deepEqual(
    quote.inventoryDemands.map((demand) => ({
      skuKey: demand.skuKey,
      quantity: demand.quantity,
    })),
    [{ skuKey: "simple:substitute-sku", quantity: 3 }],
  );
  assert.equal(quote.selections[0].rejectedQuantity, 0);
  assert.equal(quote.selections[1].rejectedQuantity, 0);
  assert.deepEqual(quote.quote, {
    previousOrderValuePiastres: 1200,
    finalMerchandiseGrossPiastres: 1999,
    preservedCouponDiscountPiastres: 300,
    lockedNetShippingPiastres: 500,
    newOrderValuePiastres: 2199,
    deltaPiastres: 999,
    walletToUsePiastres: 400,
    additionalPaymentPiastres: 599,
    refundOrCreditPiastres: 0,
    deliveryDuePiastres: 1200,
    requiresAdditionalInstapayScreenshot: false,
  });
  assert.match(quote.quoteRevision, /^[a-f0-9]{64}$/);

  const flexible = normalizeSubstitutionSelections(request, [
    {
      shortageId: "shortage-1",
      choices: [{ candidateId: "candidate-1", quantity: 1 }],
    },
    { shortageId: "shortage-2", choices: [] },
  ]);
  assert.deepEqual(
    flexible.selections.map(({ shortageId, rejectedQuantity }) => ({
      shortageId,
      rejectedQuantity,
    })),
    [
      { shortageId: "shortage-1", rejectedQuantity: 1 },
      { shortageId: "shortage-2", rejectedQuantity: 1 },
    ],
  );
});

test("guest quotes cannot spend a wallet and malformed or incomplete selections fail closed", () => {
  const request = requestFixture();
  const selections = [
    { shortageId: "shortage-1", choices: [{ candidateId: "candidate-1", quantity: 2 }] },
    { shortageId: "shortage-2", choices: [{ candidateId: "candidate-2", quantity: 1 }] },
  ];
  const guestQuote = calculateSubstitutionQuote({
    order: orderFixture(),
    request,
    selections,
    walletBalancePiastres: 999_999,
    registeredCustomer: false,
  });
  assert.equal(guestQuote.walletBalancePiastres, 0);
  assert.equal(guestQuote.quote.walletToUsePiastres, 0);
  assert.equal(guestQuote.quote.additionalPaymentPiastres, 999);

  assert.throws(
    () => normalizeSubstitutionSelections(request, selections.slice(0, 1)),
    (error) => error.code === "SUBSTITUTION_SELECTION_INVALID",
  );
  assert.throws(
    () =>
      normalizeSubstitutionSelections(request, [
        {
          shortageId: "shortage-1",
          choices: [
            { candidateId: "candidate-1", quantity: 1 },
            { candidateId: "candidate-1", quantity: 1 },
          ],
        },
        { shortageId: "shortage-2", choices: [] },
      ]),
    (error) => error.code === "SUBSTITUTION_SELECTION_INVALID",
  );
  assert.throws(
    () =>
      normalizeSubstitutionSelections(request, [
        {
          shortageId: "shortage-1",
          choices: [{ candidateId: "candidate-1", quantity: 3 }],
        },
        { shortageId: "shortage-2", choices: [] },
      ]),
    (error) => error.code === "SUBSTITUTION_SELECTION_INVALID",
  );
});

test("legacy order totals reflect the net wallet retained after a substitution credit", () => {
  const order = {
    subtotal: 100,
    discountAmount: 0,
    shippingFee: 0,
    shippingDiscount: 0,
    totalDiscount: 0,
    walletUsed: 80,
    total: 20,
    settlement: {
      currentOrderValuePiastres: 5_000,
      walletDebitedPiastres: 8_000,
      walletCreditedPiastres: 5_000,
    },
  };
  applyQuoteToLegacyOrderAmounts({
    order,
    quote: {
      finalMerchandiseGrossPiastres: 5_000,
      preservedCouponDiscountPiastres: 0,
      lockedNetShippingPiastres: 0,
      newOrderValuePiastres: 5_000,
      deltaPiastres: -5_000,
    },
  });
  assert.equal(order.walletUsed, 30);
  assert.equal(order.total, 20);
});

test("request schema enforces exactly one owner and one active request per order, without adding an order status", async () => {
  const user = new mongoose.Types.ObjectId();
  const bothOwners = new SubstitutionRequestModel(
    baseStoredRequest({ user, guestId: "guest-1" }),
  );
  await assert.rejects(
    bothOwners.validate(),
    (error) => Boolean(error.errors.user && error.errors.guestId),
  );

  const noOwner = new SubstitutionRequestModel(baseStoredRequest());
  await assert.rejects(
    noOwner.validate(),
    (error) => Boolean(error.errors.user && error.errors.guestId),
  );

  const indexes = SubstitutionRequestModel.schema.indexes();
  assert.equal(
    indexes.some(
      ([keys, options]) =>
        keys.order === 1 &&
        options.unique === true &&
        options.partialFilterExpression?.isActive === true,
    ),
    true,
  );
  assert.equal(
    indexes.some(
      ([keys, options]) =>
        keys.order === 1 &&
        keys.offerIdempotencyKey === 1 &&
        options.unique === true,
    ),
    true,
  );
  assert.equal(
    Object.values(orderStatusEnum).some((status) => /substitut/i.test(status)),
    false,
  );
});

test("offer implementation protects stored order warehouse and original quantity invariants", async () => {
  const source = await readFile(
    resolve("src/domains/substitution/substitution.service.js"),
    "utf8",
  );
  const offerSource = source.slice(
    source.indexOf("export async function createSubstitutionOfferService"),
    source.indexOf("export async function listSubstitutionRequestsForStaffService"),
  );

  assert.match(offerSource, /warehouseId:\s*order\.warehouse/);
  assert.match(offerSource, /line\.fulfillmentQuantity\s*=\s*deliverable/);
  assert.match(offerSource, /line\.finalizedUnavailableQuantity\s*=/);
  assert.match(offerSource, /correctUnallocatedInventoryCAS\(/);
  assert.doesNotMatch(offerSource, /line\.quantity\s*=/);
  assert.doesNotMatch(offerSource, /reserveInventoryAtomically/);
  assert.doesNotMatch(offerSource, /fallbackWarehouse|resolveEffectiveFulfillmentWarehouse/);
  assert.match(offerSource, /findSubstitutionRequestByOfferKey/);
  assert.match(offerSource, /SUBSTITUTION_ALREADY_ACTIVE/);
  assert.doesNotMatch(
    offerSource,
    /line\.lineKind\s*===\s*orderLineKindEnum\.SUBSTITUTE/,
  );
  assert.doesNotMatch(
    source,
    /sourceLine\.lineKind\s*===\s*orderLineKindEnum\.SUBSTITUTE/,
  );
});
