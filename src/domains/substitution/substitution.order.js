import crypto from "node:crypto";
import { orderLineKindEnum } from "../../shared/constants/enums.js";
import { fromPiastres } from "../../shared/utils/money.js";

function findShortage(request, shortageId) {
  return (request?.shortages || []).find(
    (shortage) => String(shortage.shortageId) === String(shortageId),
  );
}

function findAlternative(shortage, candidateId) {
  return (shortage?.alternatives || []).find(
    (alternative) =>
      String(alternative.candidateId) === String(candidateId),
  );
}

export function buildSubstituteOrderLines({ request, selections }) {
  const lines = [];
  for (const selection of selections || []) {
    const shortage = findShortage(request, selection.shortageId);
    if (!shortage) continue;

    for (const choice of selection.choices || []) {
      const alternative = findAlternative(shortage, choice.candidateId);
      if (!alternative) continue;
      const unitPricePiastres = alternative.unitPricePiastres;
      const lineTotalPiastres = unitPricePiastres * choice.quantity;
      lines.push({
        product: alternative.product,
        productType: alternative.productType,
        productName: alternative.productName_en,
        productImageUrl: alternative.productImageUrl || undefined,
        variantId: alternative.variantId || undefined,
        variantOptions: alternative.variantOptions || [],
        quantity: choice.quantity,
        lineId: crypto.randomUUID(),
        lineKind: orderLineKindEnum.SUBSTITUTE,
        sourceLineId: shortage.lineId,
        sourceSubstitutionRequest: request._id,
        fulfillmentQuantity: choice.quantity,
        finalizedUnavailableQuantity: 0,
        baseEffectivePrice: fromPiastres(unitPricePiastres),
        itemPrice: fromPiastres(unitPricePiastres),
        lineTotal: fromPiastres(lineTotalPiastres),
        itemPricePiastres: unitPricePiastres,
        lineTotalPiastres,
      });
    }
  }
  return lines;
}

export function applyQuoteToLegacyOrderAmounts({
  order,
  quote,
  walletDebitPiastres = 0,
}) {
  const hasNativeSettlement =
    Number.isSafeInteger(order?.settlement?.currentOrderValuePiastres) &&
    Number.isSafeInteger(order?.settlement?.walletDebitedPiastres) &&
    Number.isSafeInteger(order?.settlement?.walletCreditedPiastres);
  const netWalletPiastres = hasNativeSettlement
    ? Math.max(
        0,
        order.settlement.walletDebitedPiastres -
          order.settlement.walletCreditedPiastres,
      )
    : Math.max(
        0,
        Math.round(Number(order.walletUsed || 0) * 100) +
          walletDebitPiastres,
      );
  const nextPaymentPortionPiastres = hasNativeSettlement
    ? Math.max(0, quote.newOrderValuePiastres - netWalletPiastres)
    : Math.max(
        0,
        Math.round(Number(order.total || 0) * 100) +
          quote.deltaPiastres -
          walletDebitPiastres,
      );

  order.subtotal = fromPiastres(quote.finalMerchandiseGrossPiastres);
  order.discountAmount = fromPiastres(
    quote.preservedCouponDiscountPiastres,
  );
  order.shippingFee = fromPiastres(
    quote.lockedNetShippingPiastres +
      Math.round(Number(order.shippingDiscount || 0) * 100),
  );
  order.totalDiscount =
    order.discountAmount + Number(order.shippingDiscount || 0);
  order.walletUsed = fromPiastres(netWalletPiastres);
  order.total = fromPiastres(nextPaymentPortionPiastres);
}
