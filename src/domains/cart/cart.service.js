import { randomUUID } from "crypto";
import mongoose from "mongoose";
import { CartModel } from "./cart.model.js";
import { assertOrdinaryCart } from "./cart.bundle-compatibility.js";
import {
  findProductById,
  findProductsByIds,
  findProductsByIdsWithOptions,
} from "../product/product.repository.js";
import { WarehouseModel } from "../warehouse/warehouse.model.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import { normalizeProductType } from "../../shared/utils/productType.js";
import {
  cartStatusEnum,
  productTypeEnum,
  FREE_SHIPPING_THRESHOLD,
} from "../../shared/constants/enums.js";
import {
  autoHideExpiredCollections,
  findActivePromotionForProduct,
} from "../collection/collection.promotion.js";
import { computeFinalDiscountedPrice } from "../../shared/utils/pricing.js";
import {
  findCart,
  createCart,
  deleteCart,
  findCarts,
  countCarts,
  markCartsAbandoned,
} from "./cart.repository.js";
import sendEmail from "../../shared/Email/sendEmails.js";
import { abandonedCart } from "../../shared/Email/emailHtml.js";
import { buildCartDeliveryAddressSnapshot, resolveCartPrimeLocation } from "./cartAddressSnapshot.js";
import { selectShippingPrice } from "../warehouse/warehouse.delivery.js";

import { resolveEffectiveWarehouse } from '../warehouse/warehouse.fulfillment.js';

const MAX_ABANDON_EMAILS_PER_CART = 3;
const ABANDON_EMAIL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const AUTO_HIDE_EXPIRED_COLLECTIONS_COOLDOWN_MS = 60 * 1000;
let lastAutoHideExpiredCollectionsAt = 0;
let autoHideExpiredCollectionsInFlight = null;

function normalizeLang(lang) {
  return lang === "ar" ? "ar" : "en";
}

function generateCheckoutKey() {
  return randomUUID();
}

async function autoHideExpiredCollectionsThrottled() {
  const now = Date.now();
  if (
    now - lastAutoHideExpiredCollectionsAt <
    AUTO_HIDE_EXPIRED_COLLECTIONS_COOLDOWN_MS
  ) {
    return;
  }
  if (autoHideExpiredCollectionsInFlight) {
    return autoHideExpiredCollectionsInFlight;
  }
  autoHideExpiredCollectionsInFlight = autoHideExpiredCollections()
    .catch(() => undefined)
    .finally(() => {
      lastAutoHideExpiredCollectionsAt = Date.now();
      autoHideExpiredCollectionsInFlight = null;
    });
  return autoHideExpiredCollectionsInFlight;
}

async function assertWarehouseExists(warehouseId) {
  if (!warehouseId) {
    throw new ApiError("Warehouse ID is required", 400);
  }
  const exists = await WarehouseModel.exists({ _id: warehouseId });
  if (!exists) {
    throw new ApiError(`No warehouse found for this id: ${warehouseId}`, 400);
  }
}

async function resolveCartWarehouseId(warehouseId, session) {
  if (!warehouseId) {
    throw new ApiError('Warehouse ID is required', 400);
  }

  const { effectiveWarehouse } = await resolveEffectiveWarehouse(warehouseId, { session });
  return String(effectiveWarehouse._id);
}

function buildIdentityFilter({ userId, guestId }) {
  if (userId) {
    return { user: userId };
  }
  if (guestId) {
    return { guestId };
  }
  throw new ApiError("Either userId or guestId must be provided", 400);
}

function isUserCartConflict(error, userId) {
  return Boolean(userId && error?.code === 11000 && error.keyPattern?.user === 1 &&
    Object.keys(error.keyPattern).length === 1 &&
    (error.keyValue == null || String(error.keyValue.user) === String(userId)));
}

async function saveCart(cart) {
  try {
    await cart.save();
  } catch (error) {
    if (cart.user && (error instanceof mongoose.Error.VersionError || error instanceof mongoose.Error.DocumentNotFoundError)) {
      throw new ApiError("Your cart changed. Please try again.", 409);
    }
    throw error;
  }
}

async function getOrCreateCart({ userId, guestId, warehouseId }) {
  const identityFilter = buildIdentityFilter({ userId, guestId });

  let cart = await findCart(identityFilter);

  if (!cart) {
    try {
      cart = await createCart({
        ...identityFilter,
        warehouse: warehouseId,
        items: [],
        totalCartPrice: 0,
        status: cartStatusEnum.ACTIVE,
        lastActivityAt: new Date(),
        checkoutKey: generateCheckoutKey(),
      });
    } catch (error) {
      if (!isUserCartConflict(error, userId)) throw error;
      cart = await findCart(identityFilter);
      if (!cart) throw new ApiError("Your cart changed. Please try again.", 409);
    }
  }
  assertOrdinaryCart(cart);
  if (!cart.checkoutKey) {
    // Backfill existing carts that were created before checkoutKey existed
    cart.checkoutKey = generateCheckoutKey();
    await saveCart(cart);
  }

  return cart;
}

async function getExistingCartOrThrow({ userId, guestId, warehouseId }) {
  const identityFilter = buildIdentityFilter({ userId, guestId });

  let cart = await findCart(identityFilter);

  if (!cart) {
    throw new ApiError("Cart not found", 404);
  }
  assertOrdinaryCart(cart);
  return cart;
}

function computeTotalCartPrice(cart) {
  const items = Array.isArray(cart.items) ? cart.items : [];

  cart.totalCartPrice = items.reduce((sum, item) => {
    const quantity = typeof item.quantity === "number" ? item.quantity : 0;
    const price = typeof item.itemPrice === "number" ? item.itemPrice : 0;
    return sum + quantity * price;
  }, 0);
}

export function mapCartToResponse(cart, { shippingFee = 0, isPrimeLocation = false } = {}) {
  assertOrdinaryCart(cart);
  const removedItems =
    Array.isArray(cart._removedItems) && cart._removedItems.length > 0
      ? cart._removedItems.map((item) => ({
          id: item.id,
          productId: item.productId,
          productType: item.productType,
          productName: item.productName ?? null,
          productImageUrl: item.productImageUrl ?? null,
          variantId: item.variantId ?? null,
          quantity: item.quantity,
          itemPrice: item.itemPrice,
        }))
      : undefined;

  const deliveryAddress = cart.deliveryAddress
    ? {
        userAddressId: cart.deliveryAddress.userAddressId || undefined,
        guestAddressId: cart.deliveryAddress.guestAddressId || undefined,
        label: cart.deliveryAddress.label || null,
        name: cart.deliveryAddress.name || null,
        governorate: cart.deliveryAddress.governorate || null,
        area: cart.deliveryAddress.area || null,
        phone: cart.deliveryAddress.phone || null,
        building: cart.deliveryAddress.building || null,
        floor: cart.deliveryAddress.floor || null,
        apartment: cart.deliveryAddress.apartment || null,
        location: cart.deliveryAddress.location
          ? {
              lat: cart.deliveryAddress.location.lat,
              lng: cart.deliveryAddress.location.lng,
            }
          : null,
        details: cart.deliveryAddress.details || null,
      }
    : null;

  return {
    id: cart._id,
    userId: cart.user || null,
    guestId: cart.guestId || null,
    warehouseId: cart.warehouse,
    currency: cart.currency,
    totalCartPrice: cart.totalCartPrice,
    shippingFee,
    isPrimeLocation,
    deliveryAddress,
    items: Array.isArray(cart.items)
      ? cart.items.map((item) => ({
          id: item._id,
          productId: item.product,
          productType: item.productType,
          productName: item.productName || null,
          productImageUrl: item.productImageUrl || null,
          variantId: item.variantId || null,
          variantOptions: Array.isArray(item.variantOptionsSnapshot)
            ? item.variantOptionsSnapshot
            : [],
          quantity: item.quantity,
          baseEffectivePrice:
            typeof item._baseEffectivePrice === "number"
              ? item._baseEffectivePrice
              : typeof item.itemPrice === "number"
                ? item.itemPrice
                : 0,
          itemPrice: item.itemPrice,
          promotion: item._promotion || null,
          promotionDiscountedPrice:
            typeof item._promotionDiscountedPrice === "number"
              ? item._promotionDiscountedPrice
              : null,
          lineTotal:
            (typeof item.quantity === "number" ? item.quantity : 0) *
            (typeof item.itemPrice === "number" ? item.itemPrice : 0),
        }))
      : [],
    removedItems,
  };
}

async function mapCustomerCartToResponse(cart) {
  const warehouse = cart.deliveryAddress?.location
    ? await WarehouseModel.findById(cart.warehouse)
      .select("active fulfillment boundaryGeometry primeBoundaryGeometry primeShippingPrice defaultShippingPrice")
      .lean()
    : null;
  const isPrimeLocation = await resolveCartPrimeLocation(cart, warehouse);
  // Preserve the legacy zero shipping fee in mutation/merge responses.
  return mapCartToResponse(cart, { isPrimeLocation });
}

function pickMainImageUrl(images) {
  if (!Array.isArray(images) || images.length === 0) {
    return null;
  }

  const main = images.find((img) => img.isMain) || images[0];
  return main && main.url ? main.url : null;
}

function findVariantById(product, variantId) {
  if (!product || !Array.isArray(product.variants)) return null;
  return product.variants.find((v) => String(v._id) === String(variantId));
}

function findSimpleWarehouseStock(product, warehouseId) {
  if (!Array.isArray(product.warehouseStocks)) return null;
  return product.warehouseStocks.find(
    (ws) => String(ws.warehouse) === String(warehouseId),
  );
}

function findVariantWarehouseStock(variant, warehouseId) {
  if (!Array.isArray(variant.warehouseStocks)) return null;
  return variant.warehouseStocks.find(
    (ws) => String(ws.warehouse) === String(warehouseId),
  );
}

function buildVariantOptionsSnapshot(variant) {
  return Array.isArray(variant?.options)
    ? variant.options.map((o) => ({
        name: typeof o.name === "string" ? o.name : "",
        value: typeof o.value === "string" ? o.value : "",
      }))
    : [];
}

function computeCartItemPricing({ price, discountedPrice, promoPercent }) {
  const pricing = computeFinalDiscountedPrice({
    price,
    discountedPrice,
    promoPercent,
  });

  const baseEffectivePrice =
    typeof pricing.baseDiscountedPrice === "number"
      ? Math.min(pricing.basePrice, pricing.baseDiscountedPrice)
      : pricing.basePrice;

  const appliedPromotion = !!pricing.appliedPromotion;
  const promotionDiscountedPrice = appliedPromotion ? pricing.promoPrice : null;
  const itemPrice =
    typeof pricing.finalEffective === "number" ? pricing.finalEffective : 0;

  return {
    baseEffectivePrice,
    appliedPromotion,
    promotionDiscountedPrice,
    itemPrice,
  };
}

function buildCartProductIds(items) {
  return [
    ...new Set(
      items
        .map((item) => (item.product ? String(item.product) : null))
        .filter(Boolean),
    ),
  ];
}

async function fetchProductsForCart(productIds, session) {
  return findProductsByIdsWithOptions(productIds, {
    select:
      "_id type isActive price discountedPrice subcategory brand name_en name_ar images warehouseStocks variants",
    lean: true,
    session,
  });
}

async function fetchPromotionsForProducts(products, now, session) {
  const promotionByProductId = new Map();

  const load = async (product) => {
    const pid = product?._id ? String(product._id) : null;
    if (!pid) return;
    const promotion = await findActivePromotionForProduct(
      {
        productId: product._id,
        subcategoryId: product.subcategory,
        brandId: product.brand,
      },
      now,
      { session },
    );
    promotionByProductId.set(pid, promotion || null);
  };
  // MongoDB transactions require sequential operations on their shared session.
  if (session) {
    for (const product of products) await load(product);
  } else {
    await Promise.all(products.map(load));
  }

  return promotionByProductId;
}

function buildRemovedItems({
  originalItems,
  keptItems,
  productById,
  normalizedLang,
}) {
  const keptIds = new Set(keptItems.map((it) => String(it._id)));
  const removedRaw = originalItems.filter((it) => !keptIds.has(String(it._id)));

  return removedRaw.map((it) => {
    const product = productById.get(String(it.product));
    const localizedName = product
      ? pickLocalizedField(product, "name", normalizedLang)
      : it.productName || null;

    return {
      id: it._id,
      productId: it.product,
      productType: it.productType,
      productName: localizedName,
      productImageUrl: it.productImageUrl || null,
      variantId: it.variantId || null,
      quantity: it.quantity,
      itemPrice: it.itemPrice,
    };
  });
}

async function finalizeActiveCartAndSave(cart, warehouseId) {
  cart.items = Array.isArray(cart.items) ? cart.items : [];
  cart.warehouse = warehouseId;
  computeTotalCartPrice(cart);
  cart.lastActivityAt = new Date();
  cart.status = cartStatusEnum.ACTIVE;
  cart.abandonedAt = undefined;
  await saveCart(cart);
  return cart;
}

async function refreshCartItemsForWarehouse(cart, warehouseId, lang = "en", session, activeOnly = false) {
  if (!cart) return null;
  assertOrdinaryCart(cart);
  const normalizedLang = normalizeLang(lang);

  const items = Array.isArray(cart.items) ? cart.items : [];
  const originalItems = [...items];

  if (!items.length) {
    cart._removedItems = undefined;
    computeTotalCartPrice(cart);
    return cart;
  }

  const productIds = buildCartProductIds(items);

  const products = await fetchProductsForCart(productIds, session);
  const productById = new Map(products.map((p) => [String(p._id), p]));

  const promoNow = new Date();
  const promotionByProductId = await fetchPromotionsForProducts(
    products,
    promoNow,
    session,
  );

  const keptItems = [];

  for (const item of items) {
    const product = productById.get(String(item.product));
    if (!product || (activeOnly && product.isActive !== true)) continue;

    if (product.type !== item.productType) continue;

    if (activeOnly) {
      const source = product.type === productTypeEnum.SIMPLE ? product : findVariantById(product, item.variantId);
      if (source && (!Number.isFinite(source.price) || source.price < 0 ||
          (source.discountedPrice != null && (!Number.isFinite(source.discountedPrice) || source.discountedPrice < 0 || source.discountedPrice > source.price)))) {
        throw new ApiError("Product pricing is unavailable", 409);
      }
    }

    const currentQuantity =
      typeof item.quantity === "number" && item.quantity > 0
        ? item.quantity
        : 0;
    if (currentQuantity <= 0) continue;

    let newItemPrice;
    let newProductImageUrl = item.productImageUrl || null;
    let newVariantId = item.variantId;
    let newVariantOptionsSnapshot = item.variantOptionsSnapshot;
    const productName = pickLocalizedField(product, "name", normalizedLang);

    const promotion = promotionByProductId.get(String(product._id)) || null;
    const promoPercent =
      promotion && typeof promotion.discountPercent === "number"
        ? promotion.discountPercent
        : null;
    let baseEffectivePrice = null;
    let promotionDiscountedPrice = null;
    let appliedPromotion = false;

    if (product.type === productTypeEnum.SIMPLE) {
      const stock = findSimpleWarehouseStock(product, warehouseId);
      if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
        continue;
      }
      if (currentQuantity > stock.quantity) {
        continue;
      }

      const price = typeof product.price === "number" ? product.price : 0;
      const discounted =
        typeof product.discountedPrice === "number"
          ? product.discountedPrice
          : null;

      const itemPricing = computeCartItemPricing({
        price,
        discountedPrice: discounted,
        promoPercent,
      });

      baseEffectivePrice = itemPricing.baseEffectivePrice;
      appliedPromotion = itemPricing.appliedPromotion;
      promotionDiscountedPrice = itemPricing.promotionDiscountedPrice;
      newItemPrice = itemPricing.itemPrice;

      newProductImageUrl = pickMainImageUrl(product.images);
      newVariantId = undefined;
      newVariantOptionsSnapshot = [];
    } else {
      const variant = findVariantById(product, item.variantId);
      if (!variant) continue;

      const stock = findVariantWarehouseStock(variant, warehouseId);
      if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
        continue;
      }
      if (currentQuantity > stock.quantity) {
        continue;
      }

      const price = typeof variant.price === "number" ? variant.price : 0;
      const discounted =
        typeof variant.discountedPrice === "number"
          ? variant.discountedPrice
          : null;

      const itemPricing = computeCartItemPricing({
        price,
        discountedPrice: discounted,
        promoPercent,
      });

      baseEffectivePrice = itemPricing.baseEffectivePrice;
      appliedPromotion = itemPricing.appliedPromotion;
      promotionDiscountedPrice = itemPricing.promotionDiscountedPrice;
      newItemPrice = itemPricing.itemPrice;

      newVariantOptionsSnapshot = buildVariantOptionsSnapshot(variant);

      if (Array.isArray(variant.images) && variant.images.length > 0) {
        newProductImageUrl = pickMainImageUrl(variant.images) || null;
      } else {
        newProductImageUrl = pickMainImageUrl(product.images);
      }

      newVariantId = variant._id;
    }

    item.itemPrice = newItemPrice;
    item.productName = productName;
    item.productImageUrl = newProductImageUrl || null;
    item.variantId = newVariantId;
    item.variantOptionsSnapshot = newVariantOptionsSnapshot;
    item._promotion = appliedPromotion ? promotion || null : null;
    item._baseEffectivePrice =
      typeof baseEffectivePrice === "number" ? baseEffectivePrice : null;
    item._promotionDiscountedPrice =
      typeof promotionDiscountedPrice === "number"
        ? promotionDiscountedPrice
        : null;

    keptItems.push(item);
  }

  cart._removedItems = buildRemovedItems({
    originalItems,
    keptItems,
    productById,
    normalizedLang,
  });

  cart.items = keptItems;
  computeTotalCartPrice(cart);

  return cart;
}

export async function rebindCartToWarehouse(cart, warehouseId, lang = "en") {
  if (!cart) return null;
  assertOrdinaryCart(cart);
  await autoHideExpiredCollectionsThrottled();
  await refreshCartItemsForWarehouse(cart, warehouseId, lang);
  await finalizeActiveCartAndSave(cart, warehouseId);
  return cart;
}

export async function getCartService({
  userId,
  guestId,
  warehouseId,
  lang = "en",
}) {
  if (!warehouseId) {
    throw new ApiError("Warehouse ID is required", 400);
  }
  // Bundle reads use the requested warehouse directly; legacy fallback must not supply another stock pool.
  if (userId && !guestId && process.env.ASSISTANT_BUNDLE_CART_ENABLED === "true") {
    const existing = await findCart({ user: userId }).select("bundles").lean();
    if (existing?.bundles !== undefined && (!Array.isArray(existing.bundles) || existing.bundles.length)) {
      return readCartWithBundles({ userId, warehouseId, lang: normalizeLang(lang) });
    }
  }
  warehouseId = await resolveCartWarehouseId(warehouseId);

  const warehouse = await WarehouseModel.findById(warehouseId)
    .select("defaultShippingPrice primeShippingPrice primeBoundaryGeometry boundaryGeometry active fulfillment")
    .lean();
  if (!warehouse) {
    throw new ApiError(`No warehouse found for this id: ${warehouseId}`, 400);
  }

  const baseCart = await getOrCreateCart({ userId, guestId, warehouseId });
  const cart = await rebindCartToWarehouse(baseCart, warehouseId, lang);

  const isPrimeLocation = await resolveCartPrimeLocation(cart, warehouse);
  const rawShipping = selectShippingPrice(warehouse, isPrimeLocation);
  const baseShippingFee =
    typeof rawShipping === "number" && rawShipping >= 0 ? rawShipping : 0;

  // Free shipping for orders with items subtotal >= threshold
  const shippingFee =
    cart.totalCartPrice >= FREE_SHIPPING_THRESHOLD ? 0 : baseShippingFee;

  return mapCartToResponse(cart, { shippingFee, isPrimeLocation });
}

// Read projection only. Existing mutation/order guards stay active until shared purchasing is complete.
export async function readCartWithBundles({ userId, warehouseId, lang, session: callerSession }) {
  const { loadBundleCartUser } = await import("../bundle/bundle.cart-transaction.js");
  const { getBundleCartView } = await import("../bundle/bundle.cart-service.js");
  const read = async session => {
      const actor = await loadBundleCartUser(String(userId), session);
      // The existing cart owner selects this projection; no new client capability header is required.
      const view = await getBundleCartView(actor, { warehouseId: String(warehouseId), language: lang },
        { bundleCartEnabled: true }, { session });
      const raw = await findCart({ user: userId }).session(session).lean();
      if (!raw || String(raw._id) !== view.id || raw.__v !== view.version) {
        throw new ApiError("Your cart changed. Please try again.", 409);
      }
      const warehouse = await WarehouseModel.findById(warehouseId)
        .select("_id active fulfillment primeBoundaryGeometry boundaryGeometry primeShippingPrice defaultShippingPrice")
        .session(session).lean();
      const isPrimeLocation = !view.warehouseChangeRequired && await resolveCartPrimeLocation(raw, warehouse, { session });
      const rawShipping = selectShippingPrice(warehouse, isPrimeLocation);
      const baseShippingFee = typeof rawShipping === "number" && rawShipping >= 0 ? rawShipping : 0;
      const shippingFee = view.pricingStatus === "ready"
        ? view.totalCartPrice >= FREE_SHIPPING_THRESHOLD ? 0 : baseShippingFee : null;
      const base = mapCartToResponse(CartModel.hydrate({ ...raw, bundles: undefined }), { shippingFee, isPrimeLocation });
      return { ...base, deliveryAddress: raw.deliveryAddress ? base.deliveryAddress : null,
        warehouseId: view.warehouseId, totalCartPrice: view.totalCartPrice, items: view.items,
        removedItems: view.removedItems.length ? view.removedItems : undefined,
        bundles: view.bundles.map(({ name, image, ...group }) => ({ ...group, productName: name, productImageUrl: image })),
        pricingStatus: view.pricingStatus, warehouseChangeRequired: view.warehouseChangeRequired,
        checkoutSupported: process.env.ASSISTANT_BUNDLE_CART_ENABLED === "true" && view.pricingStatus === "ready" };
  };
  if (callerSession) {
    if (!callerSession.inTransaction?.()) throw new ApiError("An active cart transaction is required", 500);
    return read(callerSession);
  }
  const session = await mongoose.startSession();
  try { return await session.withTransaction(() => read(session), {
    readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary", maxCommitTimeMS: 10000,
  }); } finally { await session.endSession(); }
}

async function usesBundleCart(userId, guestId) {
  if (!userId || guestId || process.env.ASSISTANT_BUNDLE_CART_ENABLED !== "true") return false;
  const cart = await findCart({ user: userId }).select("bundles").lean();
  return cart?.bundles !== undefined && (!Array.isArray(cart.bundles) || cart.bundles.length > 0);
}

async function changeBundleCart(input) {
  const { changeCartWithBundles } = await import("./cart.bundle-operations.js");
  return changeCartWithBundles(input);
}

export async function upsertCartBundleService({ userId, warehouseId, bundleId, expectedRevision, quantity, lang = "en" }) {
  return changeBundleCart({ userId, warehouseId, lang, change: { action: "add", bundleId, expectedRevision, quantity } });
}
export async function updateCartBundleService({ userId, warehouseId, groupId, quantity, lang = "en" }) {
  return changeBundleCart({ userId, warehouseId, lang, change: { action: "set", groupId, quantity } });
}
export async function removeCartBundleService({ userId, warehouseId, groupId, lang = "en" }) {
  return changeBundleCart({ userId, warehouseId, lang, change: { action: "remove", groupId } });
}
export async function rebindCartWithBundlesService({ userId, warehouseId, lang = "en" }) {
  if (!await usesBundleCart(userId, null)) throw new ApiError("A bundle cart is required for this action", 409);
  return changeBundleCart({ userId, warehouseId, lang, change: { action: "rebind" } });
}

export async function setCartAddressFromUserService({
  userId,
  userAddressId,
  warehouseId: selectedWarehouseId,
  lang = "en",
}) {
  const { findAddressByIdForUser } =
    await import("../address/address.service.js");
  const address = await findAddressByIdForUser(userAddressId, userId);
  if (!address) {
    throw new ApiError(
      "User address not found or belongs to someone else",
      404,
    );
  }

  if (!address.warehouse) {
    throw new ApiError(
      "This address does not fall within covered delivery zones or is missing a valid warehouse assignment.",
      400,
    );
  }

  if (await usesBundleCart(userId, null)) {
    return changeBundleCart({ userId, warehouseId: selectedWarehouseId, lang, change: { action: "address", userAddressId: String(userAddressId) } });
  }
  const warehouseId = await resolveCartWarehouseId(address.warehouse);

  const baseCart = await findCart({ user: userId });
  if (!baseCart) {
    throw new ApiError("Cart not found", 404);
  }

  baseCart.deliveryAddress = buildCartDeliveryAddressSnapshot(address);

  baseCart.warehouse = warehouseId;
  await saveCart(baseCart);

  return await getCartService({
    userId,
    guestId: null,
    warehouseId,
    lang,
  });
}

export async function setCartAddressForGuestService({
  guestId,
  guestAddressId,
  lang = "en",
}) {
  if (!guestId) {
    throw new ApiError("guestId is required for setting cart address", 400);
  }

  const { findAddressByIdForGuest } =
    await import("../address/address.service.js");
  const address = await findAddressByIdForGuest(guestAddressId, guestId);
  if (!address) {
    throw new ApiError(
      "Guest address not found or belongs to another guest",
      404,
    );
  }

  if (!address.warehouse) {
    throw new ApiError(
      "This address does not fall within covered delivery zones or is missing a valid warehouse assignment.",
      400,
    );
  }

  const warehouseId = await resolveCartWarehouseId(address.warehouse);

  const baseCart = await findCart({ guestId });
  if (!baseCart) {
    throw new ApiError("Cart not found", 404);
  }

  baseCart.deliveryAddress = buildCartDeliveryAddressSnapshot(address);

  baseCart.warehouse = warehouseId;
  await baseCart.save();

  return await getCartService({
    userId: null,
    guestId,
    warehouseId,
    lang,
  });
}

export async function upsertCartItemService({
  userId,
  guestId,
  warehouseId,
  productId,
  productType,
  variantId,
  quantity,
  lang = "en",
}) {
  if (quantity == null || quantity <= 0) {
    throw new ApiError(
      lang === "en"
        ? "quantity must be greater than 0"
        : "الكمية يجب أن تكون أكبر من 0",
      400,
    );
  }

  if (await usesBundleCart(userId, guestId)) {
    return changeBundleCart({ userId, warehouseId, lang, change: { action: "ordinary_add", productId: String(productId),
      productType: normalizeProductType(productType), variantId: variantId == null ? null : String(variantId), quantity: Number(quantity) } });
  }
  warehouseId = await resolveCartWarehouseId(warehouseId);

  const normalizedProductType = normalizeProductType(productType);
  if (!normalizedProductType) {
    throw new ApiError("Invalid productType. Must be SIMPLE or VARIANT", 400);
  }

  const product = await findProductById(productId);
  if (!product) {
    throw new ApiError(`No product found for this id: ${productId}`, 404);
  }

  if (product.type !== normalizedProductType) {
    throw new ApiError(
      `Product type mismatch. Expected ${product.type}, got ${productType}`,
      400,
    );
  }

  const rawCart = await getOrCreateCart({ userId, guestId, warehouseId });

  // Rebind first so stale / abandoned items are validated & pruned
  // before the stock check below runs.
  await rebindCartToWarehouse(rawCart, warehouseId, lang);

  applyCartItemAddition(rawCart, product, { variantId, quantity, lang });
  const refreshed = await rebindCartToWarehouse(rawCart, warehouseId, lang);
  return mapCustomerCartToResponse(refreshed);
}

function applyCartItemAddition(cart, product, { variantId, quantity, lang }) {
  const warehouseId = String(cart.warehouse);
  const productName = pickLocalizedField(product, "name", normalizeLang(lang));
  const items = Array.isArray(cart.items) ? cart.items : [];

  const existing = items.find((item) => {
    if (!item.product || String(item.product) !== String(product._id)) {
      return false;
    }
    if (product.type === "SIMPLE") {
      return !item.variantId;
    }
    return item.variantId && String(item.variantId) === String(variantId);
  });

  const currentQuantity =
    existing && typeof existing.quantity === "number" ? existing.quantity : 0;
  const requestedTotalQuantity = currentQuantity + quantity;

  let itemPrice;
  let variant = null;
  let variantOptionsSnapshot = [];
  let productImageUrl = null;

  if (product.type === "SIMPLE") {
    const stock = findSimpleWarehouseStock(product, warehouseId);
    if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
      throw new ApiError(
        lang === "en"
          ? "This product is not available in the selected warehouse"
          : "هذا المنتج غير متوفر في المخزن التابع لمنطقتك",
        400,
      );
    }
    if (requestedTotalQuantity > stock.quantity) {
      throw new ApiError(
        lang === "en"
          ? `Requested quantity exceeds available stock (${stock.quantity})`
          : `الكمية المطلوبة تتجاوز المخزون المتاح (${stock.quantity})`,
        400,
      );
    }

    const price = typeof product.price === "number" ? product.price : 0;
    const discounted =
      typeof product.discountedPrice === "number" && product.discountedPrice > 0
        ? product.discountedPrice
        : undefined;
    itemPrice =
      typeof discounted === "number" && discounted > 0 ? discounted : price;

    productImageUrl = pickMainImageUrl(product.images);
  } else {
    variant = findVariantById(product, variantId);
    if (!variant) {
      throw new ApiError("Variant not found on this product", 404);
    }

    const stock = findVariantWarehouseStock(variant, warehouseId);
    if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
      throw new ApiError(
        lang === "en"
          ? "This product variant is out of stock or not available in the selected warehouse"
          : "هذا الإختيار غير متوفر في المخزن التابع لمنطقتك",
        400,
      );
    }
    if (requestedTotalQuantity > stock.quantity) {
      throw new ApiError(
        lang === "en"
          ? `Requested quantity exceeds available stock (${stock.quantity})`
          : `الكمية المطلوبة تتجاوز المخزون المتاح (${stock.quantity})`,
        400,
      );
    }

    const price = typeof variant.price === "number" ? variant.price : 0;
    const discounted =
      typeof variant.discountedPrice === "number" && variant.discountedPrice > 0
        ? variant.discountedPrice
        : undefined;
    itemPrice =
      typeof discounted === "number" && discounted > 0 ? discounted : price;

    variantOptionsSnapshot = Array.isArray(variant.options)
      ? variant.options.map((o) => ({
          name: typeof o.name === "string" ? o.name : "",
          value: typeof o.value === "string" ? o.value : "",
        }))
      : [];

    if (Array.isArray(variant.images) && variant.images.length > 0) {
      productImageUrl = pickMainImageUrl(variant.images) || null;
    } else {
      productImageUrl = pickMainImageUrl(product.images);
    }
  }

  if (existing) {
    existing.quantity = requestedTotalQuantity;
    existing.itemPrice = itemPrice;
    existing.productName = productName;
    existing.productImageUrl = productImageUrl;
    existing.variantId =
      product.type === "VARIANT" && variant ? variant._id : undefined;
    existing.variantOptionsSnapshot = variantOptionsSnapshot;
  } else {
    cart.items.push({
      product: product._id,
      productType: product.type,
      productName,
      productImageUrl,
      variantId:
        product.type === "VARIANT" && variant ? variant._id : undefined,
      variantOptionsSnapshot,
      quantity: requestedTotalQuantity,
      itemPrice,
    });
  }

}

export function cartItemSnapshots(cart) {
  return mapCartToResponse(cart).items.map((item) => ({ ...item, id: String(item.id), productId: String(item.productId),
    variantId: item.variantId ? String(item.variantId) : null,
    variantOptions: item.variantOptions.map(({ name, value }) => ({ name, value })) }));
}

// Bundle coordinator only: refresh a private ordinary slice while keeping group refs outside legacy pricing.
export async function refreshOrdinaryCartSliceForBundle(cart, warehouseId, lang = "en", { session } = {}) {
  if (session != null && (typeof session.inTransaction !== "function" || !session.inTransaction())) {
    throw new ApiError("Active transaction session is required", 500);
  }
  if (!["en", "ar"].includes(lang) || !/^[a-f\d]{24}$/i.test(String(warehouseId)) ||
      !cart || !Array.isArray(cart.items) || cart.items.some(item => !/^[a-f\d]{24}$/i.test(String(item?._id)) ||
        !/^[a-f\d]{24}$/i.test(String(item?.product)) || !["SIMPLE", "VARIANT"].includes(item.productType) ||
        !Number.isSafeInteger(item.quantity) || item.quantity < 1 || !Number.isFinite(item.itemPrice) || item.itemPrice < 0 ||
        (item.productType === "VARIANT" ? !/^[a-f\d]{24}$/i.test(String(item.variantId)) : item.variantId != null))) {
    throw new ApiError("Cart items are unavailable", 409);
  }
  const draft = CartModel.hydrate({ ...cart, bundles: undefined });
  const before = cartItemSnapshots(draft);
  await refreshCartItemsForWarehouse(draft, String(warehouseId), lang, session, true);
  const after = cartItemSnapshots(draft);
  return { items: draft.items.toObject(), before, after, removedItems: mapCartToResponse(draft).removedItems ?? [] };
}

async function calculateCartAdditionWithBundles(savedCart, input, session) {
  const { loadBundleCartUser, prepareBundleCartChange } = await import("../bundle/bundle.cart-transaction.js");
  const { runBundleCartRead, bundleCartGroupView } = await import("../bundle/bundle.cart-service.js");
  return runBundleCartRead(async current => {
    const actor = await loadBundleCartUser(String(input.userId), current);
    const prepared = await prepareBundleCartChange(actor, { warehouseId: input.warehouseId, language: input.lang,
      change: { action: "ordinary_add", cartId: String(savedCart._id), expectedCartVersion: savedCart.__v,
        productId: String(input.productId), productType: input.productType, variantId: input.variantId,
        quantity: input.quantity, newItemId: String(new mongoose.Types.ObjectId()) } }, { session: current });
    if (!prepared.raw || !mongoose.mongo.BSON.serialize(savedCart).equals(mongoose.mongo.BSON.serialize(prepared.raw))) {
      throw new ApiError("Cart changed; request a new preview", 409);
    }
    const draft = CartModel.hydrate(prepared.raw);
    draft.items = prepared.slice.items;
    draft.totalCartPrice = prepared.quote.patch.totalCartPrice;
    const item = prepared.quote.ordinaryItemsAfter.find(row => row.productId === String(input.productId) && row.variantId === input.variantId);
    if (!item) throw new ApiError("Cart addition is unavailable", 409);
    if (process.env.ASSISTANT_BUNDLE_CART_ENABLED !== "true") assertOrdinaryCart(draft);
    return { savedCart: prepared.raw, draft, quote: { cartId: String(draft._id), warehouseId: input.warehouseId, currency: "EGP",
      pricingScope: "items_only", itemsBefore: prepared.quote.ordinaryItemsBefore, itemsAfter: prepared.quote.ordinaryItemsAfter,
      itemsSubtotalAfter: draft.totalCartPrice, bundles: prepared.quote.groups.map(group => bundleCartGroupView(group, group, null)),
      addition: { productId: String(input.productId), productType: input.productType, variantId: input.variantId,
        quantity: input.quantity, quantityAfter: item.quantity, unitPrice: item.itemPrice } } };
  }, session);
}

async function calculateCartAddition({ userId, warehouseId, productId, productType, variantId = null, quantity, lang = "en" }, { session } = {}) {
  if (session != null && (typeof session.inTransaction !== "function" || !session.inTransaction())) {
    throw new ApiError("Active transaction session is required", 500);
  }
  const id = (value) => value != null && /^[a-f\d]{24}$/i.test(String(value));
  const type = normalizeProductType(productType);
  if (!id(userId) || !id(warehouseId) || !id(productId) || !type || !["ar", "en"].includes(lang) ||
      !Number.isSafeInteger(quantity) || quantity < 1 ||
      (type === "VARIANT" ? !id(variantId) : variantId !== null)) throw new ApiError("Invalid cart addition", 400);
  const requestedWarehouse = String(warehouseId).toLowerCase();
  const effectiveWarehouse = await resolveCartWarehouseId(requestedWarehouse, session);
  if (effectiveWarehouse !== requestedWarehouse) throw new ApiError("Warehouse changed; refresh the app location", 409);
  const product = await findProductById(productId, { session });
  if (!product || product.isActive !== true) throw new ApiError("Product not available", 404);
  if (product.type !== type) throw new ApiError("Product type mismatch", 400);
  const source = type === "VARIANT" ? findVariantById(product, variantId) : product;
  if (!source) throw new ApiError("Variant not found on this product", 404);
  if (!Number.isFinite(source.price) || source.price < 0 ||
      (source.discountedPrice != null && (!Number.isFinite(source.discountedPrice) || source.discountedPrice < 0 || source.discountedPrice > source.price))) {
    throw new ApiError("Product pricing is unavailable", 409);
  }
  const cartQuery = findCart({ user: userId });
  if (session) cartQuery.session(session);
  const savedCart = await cartQuery.lean();
  if (process.env.ASSISTANT_BUNDLE_CART_ENABLED === "true" && Array.isArray(savedCart?.bundles) && savedCart.bundles.length) {
    return calculateCartAdditionWithBundles(savedCart, { userId, warehouseId: requestedWarehouse, productId, productType: type, variantId, quantity, lang }, session);
  }
  assertOrdinaryCart(savedCart);
  if (savedCart && String(savedCart.warehouse) !== requestedWarehouse) throw new ApiError("Cart warehouse changed; refresh the cart", 409);
  // Hydrate a private draft: refreshing it must not create/save a cart or run promotion maintenance.
  const draft = savedCart ? CartModel.hydrate(savedCart) : new CartModel({ user: userId, warehouse: requestedWarehouse, items: [] });
  const itemsBefore = cartItemSnapshots(draft);
  await refreshCartItemsForWarehouse(draft, requestedWarehouse, lang, session);
  const previous = draft.items.find((item) => String(item.product) === String(product._id) &&
    (variantId === null ? !item.variantId : String(item.variantId) === String(variantId)));
  if (!Number.isSafeInteger((previous?.quantity ?? 0) + quantity)) throw new ApiError("Cart quantity is invalid", 409);
  applyCartItemAddition(draft, product, { variantId, quantity, lang });
  const added = draft.items.find((item) => String(item.product) === String(product._id) &&
    (variantId === null ? !item.variantId : String(item.variantId) === String(variantId)));
  const expectedQuantity = added.quantity;
  await refreshCartItemsForWarehouse(draft, requestedWarehouse, lang, session);
  const response = mapCartToResponse(draft);
  const itemsAfter = cartItemSnapshots(draft);
  const item = itemsAfter.find((entry) => String(entry.productId) === String(product._id) &&
    (variantId === null ? !entry.variantId : String(entry.variantId) === String(variantId)));
  if (!item || item.quantity !== expectedQuantity || !Number.isFinite(item.itemPrice) || item.itemPrice < 0 ||
      !Number.isSafeInteger(Math.round(response.totalCartPrice * 100))) throw new ApiError("Cart changed; request a new preview", 409);
  const quote = { cartId: savedCart ? String(savedCart._id) : null, warehouseId: requestedWarehouse, currency: response.currency,
    pricingScope: "items_only", itemsBefore, itemsAfter, itemsSubtotalAfter: response.totalCartPrice,
    addition: { productId: String(product._id), productType: type, variantId: variantId === null ? null : String(variantId),
      quantity, quantityAfter: item.quantity, unitPrice: item.itemPrice } };
  return { quote, savedCart, draft };
}

// Draft-only line IDs change per calculation; existing line IDs remain material.
export function cartAdditionQuoteForComparison(quote) {
  const beforeIds = new Set(quote.itemsBefore.map((item) => item.id));
  return { ...quote, itemsAfter: quote.itemsAfter.map(({ id, ...item }) => ({ ...item, ...(beforeIds.has(id) ? { id } : {}) })) };
}

// Internal quote only: callers still need durable proposal confirmation before any cart mutation.
export async function previewCartAdditionService(input, options) {
  return (await calculateCartAddition(input, options)).quote;
}

// Private draft only: no cart creation, key backfill, address selection or promotion maintenance.
export async function previewCurrentUserCartService({ userId, warehouseId, lang = "en" }) {
  const id = (value) => value != null && /^[a-f\d]{24}$/i.test(String(value));
  if (!id(userId) || !id(warehouseId) || !["ar", "en"].includes(lang)) throw new ApiError("Invalid cart summary", 400);
  const { effectiveWarehouse: warehouse } = await resolveEffectiveWarehouse(warehouseId);
  if (String(warehouse._id) !== String(warehouseId)) throw new ApiError("Warehouse changed; refresh the app location", 409);
  const saved = await findCart({ user: userId }).lean();
  if (process.env.ASSISTANT_BUNDLE_CART_ENABLED === "true" && Array.isArray(saved?.bundles) && saved.bundles.length) {
    const { runBundleCartRead } = await import("../bundle/bundle.cart-service.js");
    return runBundleCartRead(async session => {
      const sourceCart = await findCart({ user: userId }).session(session).lean();
      if (!sourceCart || !mongoose.mongo.BSON.serialize(saved).equals(mongoose.mongo.BSON.serialize(sourceCart))) {
        throw new ApiError("Cart changed; refresh the cart", 409);
      }
      const cart = await readCartWithBundles({ userId, warehouseId, lang, session });
      if (cart.warehouseChangeRequired || !["ready", "review_required"].includes(cart.pricingStatus)) {
        throw new ApiError("Cart pricing is unavailable; refresh the cart", 409);
      }
      const currentWarehouse = await WarehouseModel.findById(warehouseId).session(session).lean();
      if (process.env.ASSISTANT_BUNDLE_CART_ENABLED !== "true") assertOrdinaryCart(sourceCart);
      return { cart, warehouse: currentWarehouse, sourceCart, changed: cart.pricingStatus === "review_required" };
    });
  }
  assertOrdinaryCart(saved);
  if (!saved) return { cart: null, warehouse, changed: false };
  if (String(saved.warehouse) !== String(warehouseId)) throw new ApiError("Cart warehouse changed; refresh the cart", 409);
  if (!id(saved._id) || !Array.isArray(saved.items) || saved.items.some((item) => !id(item._id) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 ||
      !id(item.product) || !["SIMPLE", "VARIANT"].includes(item.productType) || (item.productType === "VARIANT" && !id(item.variantId)))) {
    throw new ApiError("Cart items are unavailable", 409);
  }
  const draft = CartModel.hydrate(saved);
  const material = (items) => items.map(({ id, productId, productType, variantId, variantOptions, quantity, itemPrice }) =>
    ({ id, productId, productType, variantId, variantOptions, quantity, itemPrice }));
  const before = material(cartItemSnapshots(draft));
  await refreshCartItemsForWarehouse(draft, String(warehouseId), lang, undefined, true);
  const cart = mapCartToResponse(draft);
  if (!Number.isFinite(cart.totalCartPrice) || cart.totalCartPrice < 0 || !Number.isSafeInteger(Math.round(cart.totalCartPrice * 100))) {
    throw new ApiError("Cart pricing is unavailable", 409);
  }
  return { cart, warehouse, sourceCart: saved, changed: JSON.stringify(before) !== JSON.stringify(material(cartItemSnapshots(draft))) };
}

// Internal transaction primitive: authorization and receipt must share the caller's transaction.
export async function writeConfirmedCartAdditionService(input, expectedQuote, { session } = {}) {
  if (!session || typeof session.inTransaction !== "function" || !session.inTransaction()) {
    throw new ApiError("Active transaction session is required", 500);
  }
  let indexes;
  try { indexes = await CartModel.collection.indexes(); } catch { throw new ApiError("Cart uniqueness is not ready", 503); }
  const uniqueOwner = indexes.some((entry) => JSON.stringify(entry.key) === '{"user":1}' && entry.unique === true &&
    !entry.sparse && entry.expireAfterSeconds === undefined && (!entry.collation || entry.collation.locale === "simple") &&
    (!entry.partialFilterExpression || JSON.stringify(entry.partialFilterExpression) === '{"user":{"$type":"objectId"}}'));
  if (!uniqueOwner) throw new ApiError("Cart uniqueness is not ready", 503);
  const { quote, savedCart, draft } = await calculateCartAddition(input, { session });
  if (JSON.stringify(cartAdditionQuoteForComparison(quote)) !== JSON.stringify(cartAdditionQuoteForComparison(expectedQuote))) {
    throw new ApiError("Cart changed; request a new preview", 409);
  }
  if (savedCart && (!Number.isSafeInteger(savedCart.__v) || savedCart.__v < 0 || savedCart.__v >= Number.MAX_SAFE_INTEGER)) {
    throw new ApiError("Cart version is not ready", 503);
  }
  const now = new Date();
  draft.checkoutKey ||= generateCheckoutKey();
  draft.lastActivityAt = now;
  draft.status = cartStatusEnum.ACTIVE;
  draft.abandonedAt = undefined;
  await draft.validate();
  if (process.env.ASSISTANT_BUNDLE_CART_ENABLED !== "true") assertOrdinaryCart(draft);
  if (savedCart) {
    // The raw preimage also detects legacy/query writes that do not increment __v.
    const result = await CartModel.collection.updateOne({ _id: savedCart._id, user: savedCart.user, __v: savedCart.__v,
      $expr: { $eq: ["$$ROOT", { $literal: savedCart }] } }, {
      $set: { items: draft.items.toObject(), totalCartPrice: draft.totalCartPrice, warehouse: draft.warehouse,
        checkoutKey: draft.checkoutKey, status: draft.status, lastActivityAt: now, updatedAt: now },
      $unset: { abandonedAt: "" }, $inc: { __v: 1 },
    }, { session });
    if (result.matchedCount !== 1) throw new ApiError("Cart changed; request a new preview", 409);
  } else {
    await CartModel.create([draft.toObject()], { session });
  }
  return { ...quote, cartId: String(draft._id) };
}

export async function updateCartItemQuantityService({
  userId,
  guestId,
  warehouseId,
  itemId,
  quantity,
  lang = "en",
}) {
  if (quantity == null || quantity <= 0) {
    throw new ApiError(
      lang === "en"
        ? "quantity must be greater than 0"
        : "الكمية يجب أن تكون أكبر من 0",
      400,
    );
  }

  if (await usesBundleCart(userId, guestId)) {
    return changeBundleCart({ userId, warehouseId, lang, change: { action: "ordinary_set", itemId: String(itemId), quantity: Number(quantity) } });
  }
  warehouseId = await resolveCartWarehouseId(warehouseId);
  const cart = await getExistingCartOrThrow({ userId, guestId, warehouseId });

  const item = cart.items.id(itemId);
  if (!item) {
    throw new ApiError(
      lang === "en" ? "Cart item not found" : "العنصر غير موجود في السلة",
      404,
    );
  }

  const product = await findProductById(item.product);
  if (!product) {
    throw new ApiError(
      lang === "en" ? "Product no longer exists" : "المنتج لم يعد موجود",
      400,
    );
  }

  if (product.type !== item.productType) {
    throw new ApiError(
      lang === "en"
        ? "Product type mismatch for cart item"
        : "نوع المنتج غير متطابق مع العنصر في السلة",
      400,
    );
  }

  if (product.type === "SIMPLE") {
    const stock = findSimpleWarehouseStock(product, warehouseId);
    if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
      throw new ApiError(
        lang === "en"
          ? "This product is not available in the selected warehouse"
          : "هذا المنتج غير متوفر في المخزن التابع لمنطقتك",
        400,
      );
    }
    if (quantity > stock.quantity) {
      throw new ApiError(
        lang === "en"
          ? `Requested quantity exceeds available stock (${stock.quantity})`
          : `الكمية المطلوبة تتجاوز المخزون المتاح (${stock.quantity})`,
        400,
      );
    }
  } else if (product.type === "VARIANT") {
    const variant = findVariantById(product, item.variantId);
    if (!variant) {
      throw new ApiError(
        lang === "en"
          ? "Variant not found on this product"
          : "الإختيار غير موجود في هذا المنتج",
        404,
      );
    }

    const stock = findVariantWarehouseStock(variant, warehouseId);
    if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
      throw new ApiError(
        lang === "en"
          ? "This product variant is not available in the selected warehouse"
          : "هذا الإختيار غير متوفر في المخزن التابع لمنطقتك",
        400,
      );
    }
    if (quantity > stock.quantity) {
      throw new ApiError(
        lang === "en"
          ? `Requested quantity exceeds available stock (${stock.quantity})`
          : `الكمية المطلوبة تتجاوز المخزون المتاح (${stock.quantity})`,
        400,
      );
    }
  }

  item.quantity = quantity;

  const refreshed = await rebindCartToWarehouse(cart, warehouseId, lang);
  return mapCustomerCartToResponse(refreshed);
}

export async function removeCartItemService({
  userId,
  guestId,
  warehouseId,
  itemId,
  lang = "en",
}) {
  if (await usesBundleCart(userId, guestId)) {
    return changeBundleCart({ userId, warehouseId, lang, change: { action: "ordinary_remove", itemId: String(itemId) } });
  }
  warehouseId = await resolveCartWarehouseId(warehouseId);
  const cart = await getExistingCartOrThrow({ userId, guestId, warehouseId });

  const item = cart.items.id(itemId);
  if (!item) {
    throw new ApiError(
      lang === "en" ? "Cart item not found" : "العنصر غير موجود في السلة",
      404,
    );
  }

  item.deleteOne();

  const refreshed = await rebindCartToWarehouse(cart, warehouseId, lang);
  return mapCustomerCartToResponse(refreshed);
}

export async function clearCartService({ userId, guestId, warehouseId }) {
  if (await usesBundleCart(userId, guestId)) {
    return changeBundleCart({ userId, warehouseId, change: { action: "clear" } });
  }
  const identityFilter = buildIdentityFilter({ userId, guestId });
  const existing = await findCart(identityFilter);
  assertOrdinaryCart(existing);
  const result = await deleteCart(identityFilter);
  if (existing && result.deletedCount !== 1) throw new ApiError("Your cart changed. Please try again.", 409);

  return { success: true };
}

export async function mergeGuestCartService({ userId, guestId, warehouseId }) {
  if (!guestId) {
    throw new ApiError("guestId is required for merge", 400);
  }

  warehouseId = await resolveCartWarehouseId(warehouseId);

  const guestCart = await findCart({ guestId });
  assertOrdinaryCart(guestCart);

  // No guest cart: just return the current user cart (or an empty one)
  if (!guestCart) {
    const baseUserCart = await getOrCreateCart({
      userId,
      guestId: null,
      warehouseId,
    });
    const refreshedUserCart = await rebindCartToWarehouse(
      baseUserCart,
      warehouseId,
    );
    return mapCustomerCartToResponse(refreshedUserCart);
  }

  let userCart = await findCart({ user: userId });
  assertOrdinaryCart(userCart);

  // Case A: no existing user cart -> adopt guest cart
  if (!userCart) {
    guestCart.user = userId;
    guestCart.guestId = undefined;
    guestCart.lastActivityAt = new Date();
    guestCart.status = "ACTIVE";
    try {
      await guestCart.save();
    } catch (error) {
      if (!isUserCartConflict(error, userId)) throw error;
      // The rejected adoption wrote nothing; retain guest items for a fresh merge attempt.
      throw new ApiError("Your cart changed. Please try again.", 409);
    }

    const adoptedCart = await rebindCartToWarehouse(guestCart, warehouseId);
    return mapCustomerCartToResponse(adoptedCart);
  }

  // Case B: both guest and user carts exist -> merge with stock capping
  const refreshedGuest = await rebindCartToWarehouse(guestCart, warehouseId);
  userCart = await rebindCartToWarehouse(userCart, warehouseId);

  const guestItems = Array.isArray(refreshedGuest.items)
    ? refreshedGuest.items
    : [];
  const userItems = Array.isArray(userCart.items) ? userCart.items : [];

  if (!guestItems.length) {
    await deleteCart({ _id: refreshedGuest._id });
    const finalCart = await rebindCartToWarehouse(userCart, warehouseId);
    return mapCustomerCartToResponse(finalCart);
  }

  const allItems = [...userItems, ...guestItems];
  const productIds = [
    ...new Set(
      allItems
        .map((item) => (item.product ? String(item.product) : null))
        .filter(Boolean),
    ),
  ];

  const products = await findProductsByIdsWithOptions(productIds, {
    select:
      "_id type price discountedPrice name_en name_ar images warehouseStocks variants",
    lean: true,
  });
  const productById = new Map(products.map((p) => [String(p._id), p]));

  const userItemByKey = new Map();
  for (const item of userItems) {
    const key = `${String(item.product)}|${
      item.variantId ? String(item.variantId) : "null"
    }`;
    userItemByKey.set(key, item);
  }

  for (const gItem of guestItems) {
    const product = productById.get(String(gItem.product));
    if (!product) continue;
    if (product.type !== gItem.productType) continue;

    const key = `${String(gItem.product)}|${
      gItem.variantId ? String(gItem.variantId) : "null"
    }`;
    const uItem = userItemByKey.get(key) || null;

    const guestQty =
      typeof gItem.quantity === "number" && gItem.quantity > 0
        ? gItem.quantity
        : 0;
    const userQty =
      uItem && typeof uItem.quantity === "number" && uItem.quantity > 0
        ? uItem.quantity
        : 0;

    if (guestQty <= 0 && userQty <= 0) continue;

    let available = 0;

    if (product.type === "SIMPLE") {
      const stock = findSimpleWarehouseStock(product, warehouseId);
      if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
        // No stock at all for this product in this warehouse
        continue;
      }
      available = stock.quantity;
    } else {
      const variant = findVariantById(product, gItem.variantId);
      if (!variant) continue;

      const stock = findVariantWarehouseStock(variant, warehouseId);
      if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
        // No stock for this variant in this warehouse
        continue;
      }
      available = stock.quantity;
    }

    if (available <= 0) continue;

    const desired = userQty + guestQty;
    const finalQty = desired > available ? available : desired;

    if (uItem) {
      uItem.quantity = finalQty;
    } else {
      userCart.items.push({
        product: gItem.product,
        productType: gItem.productType,
        productName: gItem.productName,
        productImageUrl: gItem.productImageUrl,
        variantId: gItem.variantId,
        variantOptionsSnapshot: Array.isArray(gItem.variantOptionsSnapshot)
          ? gItem.variantOptionsSnapshot
          : [],
        quantity: finalQty,
        itemPrice: gItem.itemPrice,
      });
    }
  }

  await deleteCart({ _id: refreshedGuest._id });
  userCart.lastActivityAt = new Date();
  userCart.status = "ACTIVE";
  await userCart.save();

  const finalCart = await rebindCartToWarehouse(userCart, warehouseId);
  return mapCustomerCartToResponse(finalCart);
}

export async function listCartsForAdminService(query = {}) {
  const {
    page = 1,
    limit = 20,
    status,
    warehouse,
    user,
    guestId,
    from,
    to,
  } = query;

  const filter = {};

  if (status) {
    const normalizedStatus =
      typeof status === "string" ? status.trim().toUpperCase() : status;
    filter.status = normalizedStatus;
  }

  if (warehouse) {
    filter.warehouse = warehouse;
  }

  if (user) {
    filter.user = user;
  }

  if (guestId) {
    filter.guestId = guestId;
  }

  if (from || to) {
    filter.lastActivityAt = {};
    if (from) {
      const fromStr = String(from).trim();
      filter.lastActivityAt.$gte = fromStr.includes("T")
        ? new Date(fromStr)
        : new Date(fromStr + "T00:00:00");
    }
    if (to) {
      const toStr = String(to).trim();
      filter.lastActivityAt.$lte = toStr.includes("T")
        ? new Date(toStr)
        : new Date(toStr + "T23:59:59.999");
    }
  }

  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const limitNum = Math.max(parseInt(limit, 10) || 20, 1);
  const skip = (pageNum - 1) * limitNum;

  const sort = { lastActivityAt: -1 };

  const totalCount = await countCarts(filter);
  const carts = await findCarts(filter, { skip, limit: limitNum, sort });

  return {
    totalPages: Math.ceil(totalCount / limitNum) || 1,
    page: pageNum,
    results: carts.length,
    data: carts.map(mapCartToResponse),
  };
}

export async function markAbandonedCartsService(thresholdMs) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - thresholdMs);

  const filter = {
    status: "ACTIVE",
    lastActivityAt: { $lt: cutoff },
    "items.0": { $exists: true },
  };

  const candidates = await findCarts(filter, {
    populate: { path: "user", select: "email name" },
  });

  for (const cart of candidates) {
    if (cart.bundles !== undefined && (!Array.isArray(cart.bundles) || cart.bundles.length > 0)) continue;
    if (!cart.user || typeof cart.user.email !== "string") {
      continue;
    }

    const emailCount =
      typeof cart.abandonedEmailCount === "number"
        ? cart.abandonedEmailCount
        : 0;
    const lastEmailAt = cart.abandonedEmailSentAt || null;

    const cooldownPassed =
      !lastEmailAt || now - lastEmailAt >= ABANDON_EMAIL_COOLDOWN_MS;
    const hasNewActivitySinceLastEmail =
      !lastEmailAt || cart.lastActivityAt > lastEmailAt;

    const canSend =
      emailCount < MAX_ABANDON_EMAILS_PER_CART &&
      cooldownPassed &&
      hasNewActivitySinceLastEmail;

    if (!canSend) {
      continue;
    }

    const rawName =
      typeof cart.user.name === "string" && cart.user.name.trim()
        ? cart.user.name.trim()
        : "there";
    const firstName = rawName.split(" ")[0];
    const capitalizedName =
      firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();

    const itemsForEmail = Array.isArray(cart.items)
      ? cart.items.map((item) => ({
          productName: item.productName || "",
          productImageUrl: item.productImageUrl || "",
          quantity:
            typeof item.quantity === "number" && item.quantity > 0
              ? item.quantity
              : 0,
          itemPrice: typeof item.itemPrice === "number" ? item.itemPrice : 0,
        }))
      : [];

    try {
      await sendEmail({
        email: cart.user.email,
        subject: `${capitalizedName}, you left items in your cart!`,
        message: abandonedCart(
          capitalizedName,
          itemsForEmail,
          cart.currency || "EGP",
        ),
      });
    } catch (error) {
      console.error(error);
    }

    cart.abandonedEmailSentAt = now;
    cart.abandonedEmailCount = emailCount + 1;
    await cart.save();
  }

  const abandonedAt = now;
  const result = await markCartsAbandoned(filter, abandonedAt);

  return result;
}
