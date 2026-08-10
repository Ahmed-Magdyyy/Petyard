import { getPrivateImageDeliveryUrl } from "../../shared/utils/privateImageDelivery.js";
import { fromPiastres } from "../../shared/utils/money.js";

function presentSettlementMoney(settlement, field) {
  const value = settlement?.[field];
  return value == null ? value : fromPiastres(value, field);
}

function presentOrderSettlement(settlement) {
  if (!settlement) return settlement;

  return {
    schemaVersion: settlement.schemaVersion,
    revision: settlement.revision,
    currency: settlement.currency,
    currentMerchandiseGross: presentSettlementMoney(
      settlement,
      "currentMerchandiseGrossPiastres",
    ),
    originalCouponDiscount: presentSettlementMoney(
      settlement,
      "originalCouponDiscountPiastres",
    ),
    preservedCouponDiscount: presentSettlementMoney(
      settlement,
      "preservedCouponDiscountPiastres",
    ),
    lockedNetShipping: presentSettlementMoney(
      settlement,
      "lockedNetShippingPiastres",
    ),
    currentOrderValue: presentSettlementMoney(
      settlement,
      "currentOrderValuePiastres",
    ),
    walletDebited: presentSettlementMoney(
      settlement,
      "walletDebitedPiastres",
    ),
    walletCredited: presentSettlementMoney(
      settlement,
      "walletCreditedPiastres",
    ),
    cardCaptured: presentSettlementMoney(
      settlement,
      "cardCapturedPiastres",
    ),
    cardRefunded: presentSettlementMoney(
      settlement,
      "cardRefundedPiastres",
    ),
    cardDue: presentSettlementMoney(settlement, "cardDuePiastres"),
    instapaySubmitted: presentSettlementMoney(
      settlement,
      "instapaySubmittedPiastres",
    ),
    instapayConfirmed: presentSettlementMoney(
      settlement,
      "instapayConfirmedPiastres",
    ),
    deliveryDue: presentSettlementMoney(
      settlement,
      "deliveryDuePiastres",
    ),
    pendingRefundLiability: presentSettlementMoney(
      settlement,
      "pendingRefundLiabilityPiastres",
    ),
    migrationState: settlement.migrationState,
  };
}

export function presentOrder(order, deliveryOptions) {
  if (order == null) {
    return order;
  }

  const value =
    typeof order.toJSON === "function" ? order.toJSON() : { ...order };
  const presentedValue = value.settlement
    ? {
        ...value,
        settlement: presentOrderSettlement(value.settlement),
      }
    : value;
  const screenshotUrls = Array.isArray(value.instapayScreenshots)
    ? value.instapayScreenshots.filter(
        (url) => typeof url === "string" && url,
      )
    : [];
  const legacyScreenshot =
    typeof value.instapayScreenshot === "string" && value.instapayScreenshot
      ? value.instapayScreenshot
      : null;

  if (!legacyScreenshot && screenshotUrls.length === 0) {
    return presentedValue;
  }

  const allScreenshotUrls = screenshotUrls.length
    ? screenshotUrls
    : [legacyScreenshot];
  const presentedScreenshots = allScreenshotUrls.map((url) =>
    getPrivateImageDeliveryUrl(url, deliveryOptions),
  );

  return {
    ...presentedValue,
    instapayScreenshot: getPrivateImageDeliveryUrl(
      legacyScreenshot || allScreenshotUrls[0],
      deliveryOptions,
    ),
    instapayScreenshots: presentedScreenshots,
  };
}

export { presentOrderSettlement };

export function presentOrderPage(pageResult, deliveryOptions) {
  if (!pageResult || !Array.isArray(pageResult.data)) {
    return pageResult;
  }

  return {
    ...pageResult,
    data: pageResult.data.map((order) =>
      presentOrder(order, deliveryOptions),
    ),
  };
}
