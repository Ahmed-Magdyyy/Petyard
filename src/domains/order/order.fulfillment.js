export function getFinalFulfillmentQuantity(item) {
  if (Number.isInteger(item?.fulfillmentQuantity)) {
    return Math.max(0, item.fulfillmentQuantity);
  }
  return Number.isInteger(item?.quantity) ? Math.max(0, item.quantity) : 0;
}

export function selectFinalFulfilledOrderItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      ...item,
      quantity: getFinalFulfillmentQuantity(item),
    }))
    .filter((item) => item.quantity > 0);
}

export function buildFinalFulfillmentQuantityExpression(path = "$items") {
  return {
    $ifNull: [
      `${path}.fulfillmentQuantity`,
      { $ifNull: [`${path}.quantity`, 0] },
    ],
  };
}

export function buildFinalFulfilledLineTotalExpression(path = "$items") {
  return {
    $multiply: [
      buildFinalFulfillmentQuantityExpression(path),
      { $ifNull: [`${path}.itemPrice`, 0] },
    ],
  };
}

export function buildFinalFulfilledLineMatchExpression(path = "$items") {
  return {
    $expr: {
      $gt: [buildFinalFulfillmentQuantityExpression(path), 0],
    },
  };
}
