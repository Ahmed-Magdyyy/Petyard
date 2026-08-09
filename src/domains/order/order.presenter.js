import { getPrivateImageDeliveryUrl } from "../../shared/utils/privateImageDelivery.js";

export function presentOrder(order, deliveryOptions) {
  if (order == null) {
    return order;
  }

  const value =
    typeof order.toJSON === "function" ? order.toJSON() : { ...order };
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
    return value;
  }

  const allScreenshotUrls = screenshotUrls.length
    ? screenshotUrls
    : [legacyScreenshot];
  const presentedScreenshots = allScreenshotUrls.map((url) =>
    getPrivateImageDeliveryUrl(url, deliveryOptions),
  );

  return {
    ...value,
    instapayScreenshot: getPrivateImageDeliveryUrl(
      legacyScreenshot || allScreenshotUrls[0],
      deliveryOptions,
    ),
    instapayScreenshots: presentedScreenshots,
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
