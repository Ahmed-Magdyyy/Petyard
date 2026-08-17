import { createHash } from "node:crypto";
import { paymentMethodEnum } from "../../shared/constants/enums.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { toPiastres } from "../../shared/utils/money.js";

function conflict(message, code) {
  const error = new ApiError(message, 409, [{ code }]);
  error.code = code;
  return error;
}

function lineQuantity(item) {
  if (Number.isInteger(item?.fulfillmentQuantity)) {
    return Math.max(0, item.fulfillmentQuantity);
  }
  return Number.isInteger(item?.quantity) ? Math.max(0, item.quantity) : 0;
}

function linePricePiastres(item) {
  if (Number.isSafeInteger(item?.itemPricePiastres)) {
    return Math.max(0, item.itemPricePiastres);
  }
  return toPiastres(item?.itemPrice || 0);
}

export function normalizeSubstitutionSelections(request, selections) {
  const shortages = Array.isArray(request?.shortages) ? request.shortages : [];
  const actionable = shortages.filter(
    (shortage) => Array.isArray(shortage.alternatives) && shortage.alternatives.length,
  );
  const input = Array.isArray(selections) ? selections : [];
  const inputByShortage = new Map();

  for (const selection of input) {
    const shortageId = String(selection?.shortageId || "");
    if (!shortageId || inputByShortage.has(shortageId)) {
      throw conflict(
        "Each shortage must appear exactly once",
        "SUBSTITUTION_SELECTION_INVALID",
      );
    }
    inputByShortage.set(shortageId, selection);
  }

  if (
    actionable.length !== inputByShortage.size ||
    actionable.some(
      (shortage) => !inputByShortage.has(String(shortage.shortageId)),
    )
  ) {
    throw conflict(
      "A selection is required for every actionable shortage",
      "SUBSTITUTION_SELECTION_INVALID",
    );
  }

  const inventoryBySku = new Map();
  const normalizedSelections = [];

  for (const shortage of actionable) {
    const submitted = inputByShortage.get(String(shortage.shortageId));
    const choices = Array.isArray(submitted?.choices) ? submitted.choices : [];
    const alternativeById = new Map(
      shortage.alternatives.map((alternative) => [
        String(alternative.candidateId),
        alternative,
      ]),
    );
    const seenCandidates = new Set();
    const normalizedChoices = [];
    let selectedQuantity = 0;

    for (const choice of choices) {
      const candidateId = String(choice?.candidateId || "");
      const alternative = alternativeById.get(candidateId);
      const quantity = choice?.quantity;
      if (
        !alternative ||
        seenCandidates.has(candidateId) ||
        !Number.isInteger(quantity) ||
        quantity <= 0 ||
        quantity > alternative.maxQuantity
      ) {
        throw conflict(
          "A selected substitute is invalid",
          "SUBSTITUTION_SELECTION_INVALID",
        );
      }

      seenCandidates.add(candidateId);
      selectedQuantity += quantity;
      normalizedChoices.push({ candidateId, quantity });

      const variantId = alternative.variantId
        ? String(alternative.variantId)
        : null;
      const skuKey = variantId
        ? `variant:${alternative.product}:${variantId}`
        : `simple:${alternative.product}`;
      const existing = inventoryBySku.get(skuKey);
      if (existing) {
        existing.quantity += quantity;
        existing.sources.push({
          shortageId: String(shortage.shortageId),
          candidateId,
          quantity,
        });
      } else {
        inventoryBySku.set(skuKey, {
          skuKey,
          productId: alternative.product,
          variantId: alternative.variantId || null,
          quantity,
          snapshot: alternative,
          sources: [
            {
              shortageId: String(shortage.shortageId),
              candidateId,
              quantity,
            },
          ],
        });
      }
    }

    if (selectedQuantity > shortage.unavailableQuantity) {
      throw conflict(
        "Selected substitute quantity exceeds the shortage",
        "SUBSTITUTION_SELECTION_INVALID",
      );
    }

    normalizedSelections.push({
      shortageId: String(shortage.shortageId),
      choices: normalizedChoices,
      rejectedQuantity: shortage.unavailableQuantity - selectedQuantity,
    });
  }

  return {
    selections: normalizedSelections,
    inventoryDemands: [...inventoryBySku.values()].sort((left, right) =>
      left.skuKey.localeCompare(right.skuKey),
    ),
  };
}

export function calculateSubstitutionQuote({
  order,
  request,
  selections,
  walletBalancePiastres = 0,
  registeredCustomer = false,
}) {
  const normalized = normalizeSubstitutionSelections(request, selections);
  const currentLines = Array.isArray(order?.items) ? order.items : [];
  const existingMerchandisePiastres = currentLines.reduce(
    (total, item) => total + lineQuantity(item) * linePricePiastres(item),
    0,
  );
  const selectedMerchandisePiastres = normalized.inventoryDemands.reduce(
    (total, demand) =>
      total + demand.quantity * demand.snapshot.unitPricePiastres,
    0,
  );
  const finalMerchandiseGrossPiastres =
    existingMerchandisePiastres + selectedMerchandisePiastres;
  const originalCouponDiscountPiastres = Number.isSafeInteger(
    order?.settlement?.originalCouponDiscountPiastres,
  )
    ? order.settlement.originalCouponDiscountPiastres
    : toPiastres(order?.discountAmount || 0);
  const preservedCouponDiscountPiastres = Math.min(
    originalCouponDiscountPiastres,
    finalMerchandiseGrossPiastres,
  );
  const hasDeliverableItems =
    currentLines.some((item) => lineQuantity(item) > 0) ||
    normalized.inventoryDemands.length > 0;
  const originalNetShippingPiastres = Number.isSafeInteger(
    order?.settlement?.lockedNetShippingPiastres,
  )
    ? order.settlement.lockedNetShippingPiastres
    : toPiastres(
        Math.max(
          0,
          (order?.shippingFee || 0) - (order?.shippingDiscount || 0),
        ),
      );
  const lockedNetShippingPiastres = hasDeliverableItems
    ? originalNetShippingPiastres
    : 0;
  const newOrderValuePiastres =
    finalMerchandiseGrossPiastres -
    preservedCouponDiscountPiastres +
    lockedNetShippingPiastres;
  const previousOrderValuePiastres = Number.isSafeInteger(
    order?.settlement?.currentOrderValuePiastres,
  )
    ? order.settlement.currentOrderValuePiastres
    : toPiastres(
        Math.max(0, (order?.subtotal || 0) - (order?.discountAmount || 0)) +
          Math.max(
            0,
            (order?.shippingFee || 0) - (order?.shippingDiscount || 0),
          ),
      );
  const deltaPiastres = newOrderValuePiastres - previousOrderValuePiastres;
  const safeWalletBalance =
    registeredCustomer &&
    Number.isSafeInteger(walletBalancePiastres) &&
    walletBalancePiastres > 0
      ? walletBalancePiastres
      : 0;
  const walletToUsePiastres =
    deltaPiastres > 0 ? Math.min(safeWalletBalance, deltaPiastres) : 0;
  const additionalPaymentPiastres = Math.max(
    0,
    deltaPiastres - walletToUsePiastres,
  );
  const refundOrCreditPiastres = Math.max(0, -deltaPiastres);
  const currentDeliveryDuePiastres = Number.isSafeInteger(
    order?.settlement?.deliveryDuePiastres,
  )
    ? order.settlement.deliveryDuePiastres
    : [paymentMethodEnum.COD, paymentMethodEnum.POS_ON_DELIVERY].includes(
          order?.paymentMethod,
        )
      ? toPiastres(order?.total || 0)
      : 0;
  const deliveryDuePiastres = [
    paymentMethodEnum.COD,
    paymentMethodEnum.POS_ON_DELIVERY,
  ].includes(order?.paymentMethod)
    ? Math.max(
        0,
        currentDeliveryDuePiastres +
          additionalPaymentPiastres -
          refundOrCreditPiastres,
      )
    : currentDeliveryDuePiastres;

  const quote = {
    previousOrderValuePiastres,
    finalMerchandiseGrossPiastres,
    preservedCouponDiscountPiastres,
    lockedNetShippingPiastres,
    newOrderValuePiastres,
    deltaPiastres,
    walletToUsePiastres,
    additionalPaymentPiastres,
    refundOrCreditPiastres,
    deliveryDuePiastres,
    requiresAdditionalInstapayScreenshots:
      order?.paymentMethod === paymentMethodEnum.INSTAPAY &&
      additionalPaymentPiastres > 0,
  };
  const quoteRevision = createHash("sha256")
    .update(
      JSON.stringify({
        requestId: String(request?._id || request?.id || ""),
        requestRevision: request?.revision || 0,
        walletBalancePiastres: safeWalletBalance,
        selections: normalized.selections,
        quote,
      }),
    )
    .digest("hex");

  return {
    ...normalized,
    quote,
    quoteRevision,
    walletBalancePiastres: safeWalletBalance,
  };
}
