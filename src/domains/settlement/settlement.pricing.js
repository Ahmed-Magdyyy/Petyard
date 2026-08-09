import { assertPiastres, toPiastres } from '../../shared/utils/money.js';

function nonNegative(value, field) {
  return assertPiastres(value ?? 0, field);
}

export function calculateMerchandiseGrossPiastres(lines = []) {
  if (!Array.isArray(lines)) {
    throw new TypeError('lines must be an array');
  }

  return lines.reduce((total, line, index) => {
    if (!line || typeof line !== 'object') {
      throw new TypeError(`lines[${index}] must be an object`);
    }
    const quantity = line.fulfillmentQuantity ?? line.quantity;
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      throw new TypeError(
        `lines[${index}].fulfillmentQuantity must be a non-negative safe integer`,
      );
    }
    const unitPricePiastres =
      line.itemPricePiastres ??
      line.unitPricePiastres ??
      (line.itemPrice === undefined
        ? undefined
        : toPiastres(line.itemPrice, `lines[${index}].itemPrice`));
    const safeUnitPrice = nonNegative(
      unitPricePiastres,
      `lines[${index}].itemPricePiastres`,
    );
    return total + assertPiastres(
      safeUnitPrice * quantity,
      `lines[${index}].lineTotalPiastres`,
    );
  }, 0);
}

export function calculatePreservedCouponDiscountPiastres({
  originalCouponDiscountPiastres = 0,
  finalMerchandiseGrossPiastres,
} = {}) {
  const gross = nonNegative(
    finalMerchandiseGrossPiastres,
    'finalMerchandiseGrossPiastres',
  );
  const originalDiscount = nonNegative(
    originalCouponDiscountPiastres,
    'originalCouponDiscountPiastres',
  );
  return Math.min(originalDiscount, gross);
}

export function calculateLockedNetShippingPiastres({
  hasDeliverableItems,
  shippingFeePiastres = 0,
  shippingDiscountPiastres = 0,
} = {}) {
  if (typeof hasDeliverableItems !== 'boolean') {
    throw new TypeError('hasDeliverableItems must be a boolean');
  }
  if (!hasDeliverableItems) return 0;

  return Math.max(
    0,
    nonNegative(shippingFeePiastres, 'shippingFeePiastres') -
      nonNegative(shippingDiscountPiastres, 'shippingDiscountPiastres'),
  );
}

export function calculateCurrentOrderValuePiastres({
  finalMerchandiseGrossPiastres,
  originalCouponDiscountPiastres = 0,
  hasDeliverableItems,
  shippingFeePiastres = 0,
  shippingDiscountPiastres = 0,
} = {}) {
  const finalMerchandiseGross = nonNegative(
    finalMerchandiseGrossPiastres,
    'finalMerchandiseGrossPiastres',
  );
  const preservedCouponDiscountPiastres = calculatePreservedCouponDiscountPiastres({
    originalCouponDiscountPiastres,
    finalMerchandiseGrossPiastres: finalMerchandiseGross,
  });
  const lockedNetShippingPiastres = calculateLockedNetShippingPiastres({
    hasDeliverableItems,
    shippingFeePiastres,
    shippingDiscountPiastres,
  });
  const currentOrderValuePiastres = assertPiastres(
    finalMerchandiseGross -
      preservedCouponDiscountPiastres +
      lockedNetShippingPiastres,
    'currentOrderValuePiastres',
  );

  return {
    finalMerchandiseGrossPiastres: finalMerchandiseGross,
    preservedCouponDiscountPiastres,
    lockedNetShippingPiastres,
    currentOrderValuePiastres,
  };
}

export function calculateOrderValueDeltaPiastres({
  previousOrderValuePiastres,
  currentOrderValuePiastres,
} = {}) {
  const previous = nonNegative(
    previousOrderValuePiastres,
    'previousOrderValuePiastres',
  );
  const current = nonNegative(
    currentOrderValuePiastres,
    'currentOrderValuePiastres',
  );
  const deltaPiastres = current - previous;
  if (!Number.isSafeInteger(deltaPiastres)) {
    throw new TypeError('deltaPiastres must be a safe integer');
  }
  return deltaPiastres;
}
