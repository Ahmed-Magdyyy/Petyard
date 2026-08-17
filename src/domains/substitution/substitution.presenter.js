import { assertPiastres, EGP_PIASTRES_PER_POUND } from "../../shared/utils/money.js";
import { getPrivateImageDeliveryUrl } from "../../shared/utils/privateImageDelivery.js";

const SUBSTITUTION_CURRENCY = "EGP";

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

function normalizeLang(lang) {
  return lang === "ar" ? "ar" : "en";
}

function localizedName(value, lang) {
  return normalizeLang(lang) === "ar"
    ? value?.productName_ar || value?.productName_en
    : value?.productName_en || value?.productName_ar;
}

function presentMoney(value, field, { allowNegative = false } = {}) {
  if (value == null) return value;
  return (
    assertPiastres(value, field, { allowNegative }) /
    EGP_PIASTRES_PER_POUND
  );
}

function presentVariantOptions(value) {
  if (!Array.isArray(value)) return [];
  return value.map((option) => ({
    name: option?.name,
    value: option?.value,
  }));
}

function presentCustomerAlternative(value, lang) {
  return {
    candidateId: value?.candidateId,
    productName: localizedName(value, lang),
    productImageUrl: value?.productImageUrl || null,
    variantOptions: presentVariantOptions(value?.variantOptions),
    unitPrice: presentMoney(
      value?.unitPricePiastres,
      "unitPricePiastres",
    ),
    maxQuantity: value?.maxQuantity,
  };
}

function presentStaffAlternative(value, lang) {
  return {
    ...presentCustomerAlternative(value, lang),
    product: presentReferenceId(value?.product),
    variantId: presentReferenceId(value?.variantId) || null,
    productType: value?.productType,
    stockQuantitySnapshot: value?.stockQuantitySnapshot,
    stockRevisionSnapshot: value?.stockRevisionSnapshot,
  };
}

function presentCustomerShortage(value, lang) {
  return {
    shortageId: value?.shortageId,
    productName: localizedName(value, lang),
    productImageUrl: value?.productImageUrl || null,
    variantOptions: presentVariantOptions(value?.variantOptions),
    quantityBefore: value?.quantityBefore,
    deliverableOriginalQuantity: value?.deliverableOriginalQuantity,
    unavailableQuantity: value?.unavailableQuantity,
    originalUnitPrice: presentMoney(
      value?.originalUnitPricePiastres,
      "originalUnitPricePiastres",
    ),
    alternatives: Array.isArray(value?.alternatives)
      ? value.alternatives.map((alternative) =>
          presentCustomerAlternative(alternative, lang),
        )
      : [],
  };
}

function presentStaffShortage(value, lang) {
  return {
    ...presentCustomerShortage(value, lang),
    lineId: value?.lineId,
    product: presentReferenceId(value?.product),
    variantId: presentReferenceId(value?.variantId) || null,
    productType: value?.productType,
    finalizedUnavailableStart: value?.finalizedUnavailableStart,
    finalizedUnavailableEnd: value?.finalizedUnavailableEnd,
    expectedUnallocatedQuantity: value?.expectedUnallocatedQuantity,
    expectedStockRevision: value?.expectedStockRevision,
    correctedUnallocatedQuantity: value?.correctedUnallocatedQuantity,
    correctionReason: value?.correctionReason,
    correctionNote: value?.correctionNote || null,
    alternatives: Array.isArray(value?.alternatives)
      ? value.alternatives.map((alternative) =>
          presentStaffAlternative(alternative, lang),
        )
      : [],
  };
}

function presentSelections(value) {
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

function presentPricing(value) {
  if (!value) return null;
  return {
    previousOrderValue: presentMoney(
      value.previousOrderValuePiastres,
      "previousOrderValuePiastres",
    ),
    finalMerchandiseGross: presentMoney(
      value.finalMerchandiseGrossPiastres,
      "finalMerchandiseGrossPiastres",
    ),
    preservedCouponDiscount: presentMoney(
      value.preservedCouponDiscountPiastres,
      "preservedCouponDiscountPiastres",
    ),
    lockedNetShipping: presentMoney(
      value.lockedNetShippingPiastres,
      "lockedNetShippingPiastres",
    ),
    newOrderValue: presentMoney(
      value.newOrderValuePiastres,
      "newOrderValuePiastres",
    ),
    delta: presentMoney(value.deltaPiastres, "deltaPiastres", {
      allowNegative: true,
    }),
    walletToUse: presentMoney(
      value.walletToUsePiastres,
      "walletToUsePiastres",
    ),
    additionalPayment: presentMoney(
      value.additionalPaymentPiastres,
      "additionalPaymentPiastres",
    ),
    refundOrCredit: presentMoney(
      value.refundOrCreditPiastres,
      "refundOrCreditPiastres",
    ),
    deliveryDue: presentMoney(
      value.deliveryDuePiastres,
      "deliveryDuePiastres",
    ),
  };
}

function presentReservation(value) {
  if (!value) return null;
  return {
    operationId: value.operationId || null,
    state: value.state,
    items: Array.isArray(value.items)
      ? value.items.map((item) => ({
          product: presentReferenceId(item?.product),
          variantId: presentReferenceId(item?.variantId) || null,
          quantity: item?.quantity,
        }))
      : [],
  };
}

function presentLifecycle(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => ({
    at: entry?.at,
    from: entry?.from || null,
    to: entry?.to,
    reason: entry?.reason || null,
    actorType: entry?.actorType,
    actorUser: presentReferenceId(entry?.actorUser) || null,
  }));
}

export function presentSubstitutionQuote(quote) {
  if (!quote) return quote;
  return {
    currency: SUBSTITUTION_CURRENCY,
    selections: presentSelections(quote.selections),
    quote: {
      ...presentPricing(quote.quote),
      requiresAdditionalInstapayScreenshots: Boolean(
        quote.quote?.requiresAdditionalInstapayScreenshots,
      ),
    },
    quoteRevision: quote.quoteRevision,
    walletBalance: presentMoney(
      quote.walletBalancePiastres,
      "walletBalancePiastres",
    ),
  };
}

export function presentSubstitutionRequest(
  request,
  { staff = false, deliveryOptions, lang } = {},
) {
  const value = toPlain(request);
  if (!value) return value;

  const presented = {
    id: value._id || value.id,
    orderId: presentReferenceId(value.order),
    orderNumber: value.orderNumber,
    currency: SUBSTITUTION_CURRENCY,
    requestSequence: value.requestSequence,
    paymentMethod: value.paymentMethod,
    status: value.status,
    revision: value.revision,
    offerPresetMinutes: value.offerPresetMinutes,
    offerExpiresAt: value.offerExpiresAt,
    paymentExpiresAt: value.paymentExpiresAt || null,
    shortages: Array.isArray(value.shortages)
      ? value.shortages.map((shortage) =>
          presentCustomerShortage(shortage, lang),
        )
      : [],
    selections: presentSelections(value.selections),
    pricing: presentPricing(value.pricingSnapshot),
    additionalInstapayScreenshotsSubmitted: Array.isArray(value.additionalInstapayScreenshots)
      && value.additionalInstapayScreenshots.length > 0,
    activePaymentAttempt: presentReferenceId(value.activePaymentAttempt),
    terminalReason: value.terminalReason || null,
    finalizedAt: value.finalizedAt || null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };

  if (!staff) return presented;

  return {
    ...presented,
    warehouseId: presentReferenceId(value.warehouse),
    shortages: Array.isArray(value.shortages)
      ? value.shortages.map((shortage) =>
          presentStaffShortage(shortage, lang),
        )
      : [],
    isActive: Boolean(value.isActive),
    offeredBy: presentReferenceId(value.offeredBy),
    reservation: presentReservation(value.reservation),
    settlementOperationId: value.settlementOperationId || null,
    lifecycle: presentLifecycle(value.lifecycle),
    additionalInstapayScreenshots: Array.isArray(value.additionalInstapayScreenshots)
      ? value.additionalInstapayScreenshots.map((url) => getPrivateImageDeliveryUrl(url, deliveryOptions))
      : [],
  };
}

export function presentSubstitutionPayment(value) {
  if (!value) return null;
  const attempt = value.attempt;
  return {
    attempt: attempt
      ? {
          id: attempt.id || attempt._id,
          status: attempt.status,
          amount: presentMoney(attempt.amountPiastres, "amountPiastres"),
          currency: attempt.currency || SUBSTITUTION_CURRENCY,
          expiresAt: attempt.expiresAt,
          attemptNumber: attempt.attemptNumber,
          errorCode: attempt.errorCode || null,
        }
      : null,
    clientSecret: value.clientSecret || null,
    publicKey: value.publicKey || null,
    initializationInProgress: Boolean(value.initializationInProgress),
    alreadyInitialized: Boolean(value.alreadyInitialized),
    expired: Boolean(value.expired),
    initializationFailed: Boolean(value.initializationFailed),
    errorCode: value.errorCode || null,
  };
}

export function presentSubstitutionRefund(value) {
  if (!value) return null;
  return {
    id: value.id || value._id,
    method: value.method,
    status: value.status || null,
    amount: presentMoney(value.amountPiastres, "amountPiastres"),
    currency: value.currency || SUBSTITUTION_CURRENCY,
  };
}

export function presentSubstitutionRequestPage(pageResult, options) {
  if (!pageResult || !Array.isArray(pageResult.data)) return pageResult;
  return {
    ...pageResult,
    data: pageResult.data.map((request) =>
      presentSubstitutionRequest(request, options),
    ),
  };
}
