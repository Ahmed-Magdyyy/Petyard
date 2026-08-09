import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFinalFulfilledLineTotalExpression,
  buildFinalFulfilledLineMatchExpression,
  buildFinalFulfillmentQuantityExpression,
  getFinalFulfillmentQuantity,
  selectFinalFulfilledOrderItems,
} from "../../../src/domains/order/order.fulfillment.js";

test("reorder uses final fulfillment and omits unavailable original units", () => {
  const items = [
    { product: "original-a", quantity: 3, fulfillmentQuantity: 1 },
    { product: "original-b", quantity: 2, fulfillmentQuantity: 0 },
    { product: "substitute", quantity: 2, fulfillmentQuantity: 2 },
    { product: "legacy", quantity: 4 },
  ];

  const selected = selectFinalFulfilledOrderItems(items);

  assert.deepEqual(
    selected.map(({ product, quantity }) => ({ product, quantity })),
    [
      { product: "original-a", quantity: 1 },
      { product: "substitute", quantity: 2 },
      { product: "legacy", quantity: 4 },
    ],
  );
  assert.equal(items[0].quantity, 3);
  assert.equal(getFinalFulfillmentQuantity({ quantity: 2 }), 2);
});

test("sales aggregations use fulfillment quantity with a legacy fallback", () => {
  assert.deepEqual(buildFinalFulfillmentQuantityExpression(), {
    $ifNull: [
      "$items.fulfillmentQuantity",
      { $ifNull: ["$items.quantity", 0] },
    ],
  });
  assert.deepEqual(buildFinalFulfilledLineTotalExpression(), {
    $multiply: [
      {
        $ifNull: [
          "$items.fulfillmentQuantity",
          { $ifNull: ["$items.quantity", 0] },
        ],
      },
      { $ifNull: ["$items.itemPrice", 0] },
    ],
  });
  assert.deepEqual(buildFinalFulfilledLineMatchExpression(), {
    $expr: {
      $gt: [
        {
          $ifNull: [
            "$items.fulfillmentQuantity",
            { $ifNull: ["$items.quantity", 0] },
          ],
        },
        0,
      ],
    },
  });
});
