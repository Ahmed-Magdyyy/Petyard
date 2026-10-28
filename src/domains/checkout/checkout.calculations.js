import { FREE_SHIPPING_THRESHOLD } from "../../shared/constants/enums.js";

// Subtotal is EGP; the validated shipping price keeps its caller's money unit.
export function calculateCheckoutShipping(subtotalEGP, shippingPrice) {
  return subtotalEGP >= FREE_SHIPPING_THRESHOLD ? 0 : shippingPrice;
}

// Both inputs use the caller's money unit; preserve its existing precision.
export function applyWalletToMerchandise(netSubtotal, walletBalance) {
  const walletUsed = Math.min(walletBalance, netSubtotal);
  return { walletUsed, remainingSubtotal: netSubtotal - walletUsed };
}

// Read-only estimates must not initialize missing loyalty settings.
export function estimateCheckoutLoyaltyPoints(netSubtotalEGP, settings) {
  if (settings?.isActive === false) return 0;
  if (settings?.isActive !== true || !Number.isFinite(settings.pointsEarnRate) || settings.pointsEarnRate < 0) return null;
  const points = Math.floor(netSubtotalEGP * settings.pointsEarnRate);
  return Number.isSafeInteger(points) ? points : null;
}
