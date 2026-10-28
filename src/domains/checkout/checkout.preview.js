import { ApiError } from "../../shared/utils/ApiError.js";
import { previewCurrentUserCartService } from "../cart/cart.service.js";
import { resolveCartPrimeLocation } from "../cart/cartAddressSnapshot.js";
import { selectShippingPrice } from "../warehouse/warehouse.delivery.js";
import { UserModel } from "../user/user.model.js";
import { LoyaltySettingsModel } from "../loyalty/loyaltySettings.model.js";
import { calculateCheckoutShipping, applyWalletToMerchandise, estimateCheckoutLoyaltyPoints } from "./checkout.calculations.js";

// Estimates follow checkout's no-coupon rules; the normal checkout refresh remains authoritative.
export async function previewUserCheckoutService({ userId, warehouseId, lang = "en" }) {
  const snapshot = await previewCurrentUserCartService({ userId, warehouseId, lang });
  const { cart, warehouse, sourceCart, changed } = snapshot;
  const base = { status: cart ? "empty_cart" : "missing_cart", cartId: cart ? String(cart.id) : null,
    warehouseId: String(warehouse._id), currency: cart?.currency ?? "EGP", dataMode: "estimate", requiresCheckoutRefresh: true,
    couponState: "checkout_managed", items: cart?.items ?? [], removedItems: cart?.removedItems ?? [],
    ...(cart?.bundles?.length ? { bundles: cart.bundles } : {}),
    cartChanged: changed, addressComplete: false, isPrimeLocation: null, pricing: null, action: null };
  if (!cart?.items.length && !cart?.bundles?.length) return { ...base, status: changed ? "review_cart" : base.status,
    action: changed ? { type: "open_cart", cartId: base.cartId, warehouseId: base.warehouseId } : null };
  if (cart.totalCartPrice <= 0) return { ...base, status: "review_cart",
    action: { type: "open_cart", cartId: base.cartId, warehouseId: base.warehouseId } };
  const addr = cart.deliveryAddress;
  const addressComplete = Boolean(addr && ["name", "governorate", "phone", "building", "floor", "apartment", "details"].every((key) => addr[key]) &&
    Number.isFinite(addr.location?.lat) && Math.abs(addr.location.lat) <= 90 && Number.isFinite(addr.location?.lng) && Math.abs(addr.location.lng) <= 180);
  const prime = addressComplete ? await resolveCartPrimeLocation(sourceCart, warehouse) : null;
  const subtotal = cart.totalCartPrice;
  const rawShipping = selectShippingPrice(warehouse, prime === true);
  if (addressComplete && (!Number.isFinite(rawShipping) || rawShipping < 0)) throw new ApiError("Shipping pricing is unavailable", 503);
  const shippingFee = addressComplete ? calculateCheckoutShipping(subtotal, rawShipping) : null;
  const user = await UserModel.findById(userId).select("walletBalance").lean();
  if (!user) throw new ApiError("User no longer exists", 401);
  const walletBalance = user.walletBalance ?? 0;
  if (!Number.isFinite(walletBalance) || walletBalance < 0) throw new ApiError("Wallet pricing is unavailable", 503);
  const { walletUsed, remainingSubtotal } = applyWalletToMerchandise(subtotal, walletBalance);
  const settings = await LoyaltySettingsModel.findOne().select("isActive pointsEarnRate").lean();
  const points = estimateCheckoutLoyaltyPoints(subtotal, settings);
  const finalTotal = shippingFee === null ? null : remainingSubtotal + shippingFee;
  const total = shippingFee === null ? null : subtotal + shippingFee;
  for (const amount of [walletBalance, walletUsed, shippingFee, total, finalTotal]) {
    if (amount !== null && !Number.isSafeInteger(Math.round(amount * 100))) throw new ApiError("Checkout pricing is unavailable", 503);
  }
  return { ...base, status: changed ? "review_cart" : addressComplete ? "summary" : "needs_address", addressComplete,
    isPrimeLocation: prime, pricing: { subtotal, shippingFee, discountAmount: 0, shippingDiscount: 0, totalDiscount: 0,
      total, walletBalance, walletUsed, finalTotal,
      loyaltyPoints: points },
    action: { type: "open_checkout", cartId: base.cartId, warehouseId: base.warehouseId } };
}
