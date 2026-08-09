import { getPrivateImageDeliveryUrl } from "../../shared/utils/privateImageDelivery.js";

function toPlain(value) {
  if (value == null) return value;
  if (typeof value.toJSON === "function") return value.toJSON();
  if (typeof value.toObject === "function") return value.toObject();
  return { ...value };
}

function presentReferenceId(value) {
  if (value == null) return value;
  if (typeof value !== "object") return value;
  if (value._id != null) return value._id;
  if (value.id != null && typeof value.id !== "object") return value.id;
  return value;
}

function presentCustomerVariantOptions(value) {
  if (!Array.isArray(value)) return [];
  return value.map((option) => ({
    name: option?.name,
    value: option?.value,
  }));
}

function presentCustomerAlternative(value) {
  return {
    candidateId: value?.candidateId,
    productName_en: value?.productName_en,
    productName_ar: value?.productName_ar,
    productImageUrl: value?.productImageUrl || null,
    variantOptions: presentCustomerVariantOptions(value?.variantOptions),
    unitPricePiastres: value?.unitPricePiastres,
    maxQuantity: value?.maxQuantity,
  };
}

function presentCustomerShortage(value) {
  return {
    shortageId: value?.shortageId,
    productName_en: value?.productName_en,
    productName_ar: value?.productName_ar,
    productImageUrl: value?.productImageUrl || null,
    variantOptions: presentCustomerVariantOptions(value?.variantOptions),
    quantityBefore: value?.quantityBefore,
    deliverableOriginalQuantity: value?.deliverableOriginalQuantity,
    unavailableQuantity: value?.unavailableQuantity,
    originalUnitPricePiastres: value?.originalUnitPricePiastres,
    alternatives: Array.isArray(value?.alternatives)
      ? value.alternatives.map(presentCustomerAlternative)
      : [],
  };
}

function presentCustomerSelections(value) {
  if (!Array.isArray(value)) return [];
  return value.map((selection) => ({
    shortageId: selection?.shortageId,
    choices: Array.isArray(selection?.choices)
      ? selection.choices.map((choice) => ({
          candidateId: choice?.candidateId,
          quantity: choice?.quantity,
        }))
      : [],
    rejectedQuantity: selection?.rejectedQuantity,
  }));
}

export function presentSubstitutionQuote(quote) {
  if (!quote) return quote;
  return {
    selections: presentCustomerSelections(quote.selections),
    quote: {
      previousOrderValuePiastres: quote.quote?.previousOrderValuePiastres,
      finalMerchandiseGrossPiastres:
        quote.quote?.finalMerchandiseGrossPiastres,
      preservedCouponDiscountPiastres:
        quote.quote?.preservedCouponDiscountPiastres,
      lockedNetShippingPiastres: quote.quote?.lockedNetShippingPiastres,
      newOrderValuePiastres: quote.quote?.newOrderValuePiastres,
      deltaPiastres: quote.quote?.deltaPiastres,
      walletToUsePiastres: quote.quote?.walletToUsePiastres,
      additionalPaymentPiastres: quote.quote?.additionalPaymentPiastres,
      refundOrCreditPiastres: quote.quote?.refundOrCreditPiastres,
      deliveryDuePiastres: quote.quote?.deliveryDuePiastres,
      requiresAdditionalInstapayScreenshot: Boolean(
        quote.quote?.requiresAdditionalInstapayScreenshot,
      ),
    },
    quoteRevision: quote.quoteRevision,
    walletBalancePiastres: quote.walletBalancePiastres,
  };
}

export function presentSubstitutionRequest(
  request,
  { staff = false, deliveryOptions } = {},
) {
  const value = toPlain(request);
  if (!value) return value;

  const presented = {
    id: value._id || value.id,
    orderId: presentReferenceId(value.order),
    orderNumber: value.orderNumber,
    requestSequence: value.requestSequence,
    paymentMethod: value.paymentMethod,
    status: value.status,
    revision: value.revision,
    offerPresetMinutes: value.offerPresetMinutes,
    offerExpiresAt: value.offerExpiresAt,
    paymentExpiresAt: value.paymentExpiresAt || null,
    shortages: Array.isArray(value.shortages)
      ? value.shortages.map(presentCustomerShortage)
      : [],
    selections: presentCustomerSelections(value.selections),
    pricing: value.pricingSnapshot || null,
    additionalInstapayScreenshotSubmitted: Boolean(
      value.additionalInstapayScreenshot,
    ),
    activePaymentAttempt: presentReferenceId(value.activePaymentAttempt),
    terminalReason: value.terminalReason || null,
    finalizedAt: value.finalizedAt || null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };

  if (!staff) return presented;

  return {
    ...presented,
    warehouseId: value.warehouse,
    shortages: value.shortages || [],
    selections: value.selections || [],
    user: value.user || null,
    guestId: value.guestId || null,
    isActive: Boolean(value.isActive),
    offeredBy: value.offeredBy,
    originalInstapayVerifiedAt: value.originalInstapayVerifiedAt || null,
    originalInstapayVerifiedBy: value.originalInstapayVerifiedBy || null,
    reservation: value.reservation || null,
    settlementOperationId: value.settlementOperationId || null,
    lifecycle: value.lifecycle || [],
    additionalInstapayScreenshot: getPrivateImageDeliveryUrl(
      value.additionalInstapayScreenshot,
      deliveryOptions,
    ),
  };
}

export function presentSubstitutionRequestPage(
  pageResult,
  options,
) {
  if (!pageResult || !Array.isArray(pageResult.data)) return pageResult;
  return {
    ...pageResult,
    data: pageResult.data.map((request) =>
      presentSubstitutionRequest(request, options),
    ),
  };
}
