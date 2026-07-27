import { getPrivateImageDeliveryUrl } from "../../shared/utils/privateImageDelivery.js";

export function presentOrder(order, deliveryOptions) {
  if (order == null) {
    return order;
  }

  const value =
    typeof order.toJSON === "function" ? order.toJSON() : { ...order };
  if (!Object.prototype.hasOwnProperty.call(value, "instapayScreenshot")) {
    return value;
  }

  return {
    ...value,
    instapayScreenshot: getPrivateImageDeliveryUrl(
      value.instapayScreenshot,
      deliveryOptions,
    ),
  };
}

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
