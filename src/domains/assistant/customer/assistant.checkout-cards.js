import { reject } from "../shared/assistant.errors.js";

export const CHECKOUT_MAX_BYTES = 8192;
const states = ["missing_cart", "empty_cart", "needs_address", "review_cart", "summary", "needs_location", "unavailable"];
const moneyKeys = ["subtotal", "shippingFee", "discountAmount", "shippingDiscount", "totalDiscount", "total", "walletBalance", "walletUsed", "finalTotal", "loyaltyPoints"];
const nullable = ["shippingFee", "total", "finalTotal", "loyaltyPoints"];
const id = (value) => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
const fail = () => reject("invalid_checkout_summary", 503);

// Retain only the summary header: cart lines and personal address/payment data stay in the existing app flow.
export function buildCheckoutSnapshot(value, warehouseId, generatedAt = new Date().toISOString()) {
  if (!value || !states.includes(value.status) || (warehouseId !== null && !id(warehouseId)) ||
      value.warehouseId !== warehouseId || !Number.isFinite(Date.parse(generatedAt)) || new Date(generatedAt).toISOString() !== generatedAt) fail();
  const fallback = ["needs_location", "unavailable"].includes(value.status);
  const cartId = fallback ? null : value.cartId;
  if (cartId !== null && !id(cartId)) fail();
  if (value.status === "needs_location" && warehouseId !== null) fail();
  if (!fallback && (!id(warehouseId) || (value.status === "missing_cart" ? cartId !== null : cartId === null))) fail();
  let pricing = null; let action = null;
  if (!fallback) {
    if (value.dataMode !== "estimate" || value.requiresCheckoutRefresh !== true || value.couponState !== "checkout_managed" ||
        !/^[A-Z]{3}$/.test(value.currency) || typeof value.cartChanged !== "boolean" || typeof value.addressComplete !== "boolean" ||
        ![true, false, null].includes(value.isPrimeLocation)) fail();
    if (value.pricing !== null) {
      if (!value.pricing || typeof value.pricing !== "object") fail();
      pricing = Object.fromEntries(moneyKeys.map((key) => {
        const amount = value.pricing[key];
        if (!(amount === null && nullable.includes(key)) && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 ||
            !Number.isSafeInteger(Math.round(amount * 100)) || (key === "loyaltyPoints" && !Number.isSafeInteger(amount)))) fail();
        return [key, amount];
      }));
      if (!value.addressComplete && ["shippingFee", "total", "finalTotal"].some((key) => pricing[key] !== null)) fail();
      if (value.addressComplete && ["shippingFee", "total", "finalTotal"].some((key) => pricing[key] === null)) fail();
    }
    if (value.action !== null) {
      if (!value.action || !["open_cart", "open_checkout"].includes(value.action.type) || !cartId ||
          value.action.cartId !== cartId || value.action.warehouseId !== warehouseId) fail();
      action = { type: value.action.type, cartId, warehouseId };
    }
    if (["missing_cart", "empty_cart"].includes(value.status) && (pricing || action)) fail();
    if (["summary", "needs_address"].includes(value.status) && (!pricing || action?.type !== "open_checkout")) fail();
    if (value.status === "summary" && !value.addressComplete) fail();
    if (value.status === "needs_address" && value.addressComplete) fail();
  }
  const snapshot = { status: value.status, generatedAt, cartId, warehouseId, currency: fallback ? "EGP" : value.currency,
    dataMode: "estimate", requiresCheckoutRefresh: true, couponState: "checkout_managed",
    cartChanged: fallback ? false : value.cartChanged, addressComplete: fallback ? false : value.addressComplete,
    isPrimeLocation: fallback ? null : value.isPrimeLocation, pricing, action };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > CHECKOUT_MAX_BYTES) fail();
  return snapshot;
}

export function storedCheckoutDto(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > CHECKOUT_MAX_BYTES) return null;
  try { const value = JSON.parse(raw); if (typeof value.generatedAt !== "string") return null;
    return buildCheckoutSnapshot(value, value.warehouseId, value.generatedAt); }
  catch { return null; }
}

export function renderCheckoutResponse(snapshot, language) {
  const ar = language === "ar";
  if (snapshot.status === "needs_location") return ar ? "اختار منطقة التوصيل في التطبيق الأول عشان أقدر أراجع سلتك." : "Select your delivery area in the app first so I can check your cart.";
  if (snapshot.status === "unavailable") return ar ? "مش قادر أراجع تقدير السلة دلوقتي. جرّب تاني أو افتح السلة من التطبيق." : "I can't read your cart estimate right now. Try again or open your cart in the app.";
  if (["missing_cart", "empty_cart"].includes(snapshot.status)) return ar ? "سلتك فاضية دلوقتي. ضيف المنتجات الأول، وبعدها نراجع حسابها." : "Your cart is empty. Add items first, then we can review the estimate.";
  if (snapshot.status === "review_cart") return ar ? "محتويات السلة أو أسعارها اتغيّرت. راجعها في التطبيق قبل تأكيد الطلب؛ الحساب النهائي بيتحدّث في شاشة إتمام الطلب." : "Your cart contents or prices changed. Review them in the app before placing an order; checkout will refresh the final calculation.";
  const subtotal = new Intl.NumberFormat(ar ? "ar-EG" : "en-EG", { maximumFractionDigits: 2 }).format(snapshot.pricing.subtotal);
  if (snapshot.status === "needs_address") return ar ? `تقدير المنتجات ${subtotal} ${snapshot.currency}. كمّل عنوانك في شاشة إتمام الطلب عشان يظهر الشحن والإجمالي؛ لسه مفيش طلب اتعمل.` : `The item estimate is ${subtotal} ${snapshot.currency}. Complete your address in checkout to see shipping and the total; no order has been placed.`;
  const total = new Intl.NumberFormat(ar ? "ar-EG" : "en-EG", { maximumFractionDigits: 2 }).format(snapshot.pricing.finalTotal);
  return ar ? `التقدير بعد المحفظة ومع الشحن ${total} ${snapshot.currency}. افتح شاشة إتمام الطلب عشان تراجع الحساب وتختار الدفع وتأكد الطلب بنفسك. ده تقدير ولسه مفيش طلب اتعمل.` : `The estimate after wallet credit and shipping is ${total} ${snapshot.currency}. Open checkout to review the calculation, choose payment and place the order yourself. This is an estimate; no order has been placed.`;
}
