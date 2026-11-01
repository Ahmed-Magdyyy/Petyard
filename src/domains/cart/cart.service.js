import { randomUUID } from "crypto";
import mongoose from "mongoose";
import { CartModel } from "./cart.model.js";
import { UserModel } from "../user/user.model.js";
import { combineGuestCartContents } from "./cart.guest-merge.js";
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

async function resolveCartWarehouseId(warehouseId) {
  if (!warehouseId) {
    throw new ApiError('Warehouse ID is required', 400);
  }

  const { effectiveWarehouse } = await resolveEffectiveWarehouse(warehouseId);
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

async function getOrCreateCart({ userId, guestId, warehouseId }) {
  const identityFilter = buildIdentityFilter({ userId, guestId });

  let cart = await findCart(identityFilter);

  if (!cart) {
    cart = await createCart({
      ...identityFilter,
      warehouse: warehouseId,
      items: [],
      totalCartPrice: 0,
      status: cartStatusEnum.ACTIVE,
      lastActivityAt: new Date(),
      checkoutKey: generateCheckoutKey(),
    });
  } else if (!cart.checkoutKey) {
    // Backfill existing carts that were created before checkoutKey existed
    cart.checkoutKey = generateCheckoutKey();
    await cart.save();
  }

  return cart;
}

async function getExistingCartOrThrow({ userId, guestId, warehouseId }) {
  const identityFilter = buildIdentityFilter({ userId, guestId });

  let cart = await findCart(identityFilter);

  if (!cart) {
    throw new ApiError("Cart not found", 404);
  }
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
    ...(cart._stockIssues?.length ? { stockIssues: cart._stockIssues, checkoutSupported: false, pricingStatus: "unavailable" } : {}),
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
  await cart.save();
  return cart;
}

async function refreshCartItemsForWarehouse(cart, warehouseId, lang = "en", session, activeOnly = false, preserveUnavailable = false) {
  if (!cart) return null;
  const normalizedLang = normalizeLang(lang);

  const items = Array.isArray(cart.items) ? cart.items : [];
  const originalItems = [...items];
  cart._stockIssues = [];

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
  const keepIssue = (item, reason, availableQuantity = 0) => {
    if (!preserveUnavailable) return;
    keptItems.push(item);
    cart._stockIssues.push({ itemId: String(item._id), productId: String(item.product), variantId: item.variantId ? String(item.variantId) : null,
      requestedQuantity: item.quantity, availableQuantity, reason });
  };

  for (const item of items) {
    const product = productById.get(String(item.product));
    if (!product || ((activeOnly || preserveUnavailable) && product.isActive !== true)) {
      keepIssue(item, "product_unavailable"); continue;
    }

    if (product.type !== item.productType) { keepIssue(item, "product_unavailable"); continue; }

    if (activeOnly) {
      const source = product.type === productTypeEnum.SIMPLE ? product : findVariantById(product, item.variantId);
      if (source && (!Number.isFinite(source.price) || source.price < 0 ||
          (source.discountedPrice != null && (!Number.isFinite(source.discountedPrice) || source.discountedPrice < 0 || source.discountedPrice > source.price)))) {
        if (preserveUnavailable) { keepIssue(item, "price_unavailable"); continue; }
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
      if (preserveUnavailable && ((product.warehouseStocks ?? []).filter(row => String(row.warehouse) === String(warehouseId)).length !== 1 ||
          !Number.isSafeInteger(stock?.quantity))) { keepIssue(item, "out_of_stock"); continue; }
      if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
        keepIssue(item, "out_of_stock"); continue;
      }
      if (currentQuantity > stock.quantity) {
        keepIssue(item, "insufficient_stock", stock.quantity); continue;
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
      if (!variant) { keepIssue(item, "variant_unavailable"); continue; }

      const stock = findVariantWarehouseStock(variant, warehouseId);
      if (preserveUnavailable && ((variant.warehouseStocks ?? []).filter(row => String(row.warehouse) === String(warehouseId)).length !== 1 ||
          !Number.isSafeInteger(stock?.quantity))) { keepIssue(item, "out_of_stock"); continue; }
      if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
        keepIssue(item, "out_of_stock"); continue;
      }
      if (currentQuantity > stock.quantity) {
        keepIssue(item, "insufficient_stock", stock.quantity); continue;
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
  await autoHideExpiredCollectionsThrottled();
  await refreshCartItemsForWarehouse(cart, warehouseId, lang, undefined, true, true);
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

export async function setCartAddressFromUserService({
  userId,
  userAddressId,
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

  const warehouseId = await resolveCartWarehouseId(address.warehouse);

  const baseCart = await findCart({ user: userId });
  if (!baseCart) {
    throw new ApiError("Cart not found", 404);
  }

  baseCart.deliveryAddress = buildCartDeliveryAddressSnapshot(address);

  baseCart.warehouse = warehouseId;
  await baseCart.save();

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

  const normalizedLang = normalizeLang(lang);
  const productName = pickLocalizedField(product, "name", normalizedLang);

  const rawCart = await getOrCreateCart({ userId, guestId, warehouseId });

  // Rebind first so stale / abandoned items are validated & pruned
  // before the stock check below runs.
  await rebindCartToWarehouse(rawCart, warehouseId, lang);

  const cart = rawCart;
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

  const refreshed = await rebindCartToWarehouse(cart, warehouseId, lang);
  return mapCustomerCartToResponse(refreshed);
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
  const identityFilter = buildIdentityFilter({ userId, guestId });

  await deleteCart(identityFilter);

  return { success: true };
}

function isCartCreationConflict(error, userId, guestId) {
  const key = userId ? "user" : "guestId", owner = userId || guestId;
  return Boolean(owner && error?.code === 11000 && error.keyPattern?.[key] === 1 &&
    Object.keys(error.keyPattern).length === 1 &&
    (error.keyValue == null || String(error.keyValue[key]) === String(owner)));
}

export async function mergeGuestCartService({ userId, guestId, warehouseId }) {
  if (!mongoose.isObjectIdOrHexString(userId) || typeof guestId !== "string" || !guestId.trim()) {
    throw new ApiError("A valid userId and guestId are required for merge", 400);
  }
  guestId = guestId.trim();
  const guestOwner = { guestId, user: null };
  const guestBefore = await findCart(guestOwner);
  if (!guestBefore) return getCartService({ userId, warehouseId });
  if (guestBefore.bundles?.length) throw new ApiError("Bundle shopping is not available in this release", 503);
  const conflict = () => { throw new ApiError("Your cart changed. Please try again.", 409); };
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const selectedWarehouse = await resolveCartWarehouseId(warehouseId, session);
      if (selectedWarehouse !== String(warehouseId).toLowerCase()) throw new ApiError("Warehouse changed; refresh the app location", 409);
      // Serialize two guest merges into the same account, including first-cart adoption.
      const fenced = await UserModel.collection.updateOne({ _id: new mongoose.Types.ObjectId(userId), active: true,
        phoneVerified: true, deletedAt: null }, { $inc: { __v: 1 } }, { session });
      if (fenced.matchedCount !== 1) throw new ApiError("Please login first", 401);
      const guest = await findCart(guestOwner).session(session).lean();
      const account = await findCart({ user: userId }).session(session).lean();
      if (account?.guestId != null) conflict();
      // A completed earlier attempt has consumed the guest source, so never add it twice.
      if (!guest) {
        if (account?.bundles?.length) throw new ApiError("Bundle shopping is not available in this release", 503);
        if (!account || String(account.warehouse) !== selectedWarehouse) conflict();
        const current = CartModel.hydrate(account);
        await refreshCartItemsForWarehouse(current, selectedWarehouse, "en", session, true, true);
        return mapCustomerCartToResponse(current);
      }
      const { items, bundles } = combineGuestCartContents(account, guest);
      if (bundles.length) throw new ApiError("Bundle shopping is not available in this release", 503);
      const original = account ?? guest;
      const draft = CartModel.hydrate({ ...original, user: new mongoose.Types.ObjectId(userId), guestId: undefined,
        items, bundles: undefined, warehouse: selectedWarehouse });
      if (String(original.warehouse) !== selectedWarehouse) draft.deliveryAddress = undefined;
      await refreshCartItemsForWarehouse(draft, selectedWarehouse, "en", session, true, true);
      let bundleTotal = 0;
      for (const group of bundles) {
        const amount = group.quantity * group.unitPricePiastres;
        if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(bundleTotal + amount)) conflict();
        bundleTotal += amount;
      }
      draft.totalCartPrice += bundleTotal / 100;
      if (!Number.isFinite(draft.totalCartPrice) || draft.totalCartPrice < 0 || !Number.isSafeInteger(Math.round(draft.totalCartPrice * 100))) conflict();
      if (bundles.length) draft.bundles = bundles;
      draft.checkoutKey ||= generateCheckoutKey();
      draft.status = cartStatusEnum.ACTIVE; draft.lastActivityAt = new Date(); draft.abandonedAt = undefined;
      await draft.validate();
      const next = draft.toObject();
      const filter = (raw, owner) => ({ _id: raw._id, ...owner, $expr: { $eq: ["$$ROOT", { $literal: raw }] } });
      const set = { user: next.user, warehouse: next.warehouse, items: next.items, totalCartPrice: next.totalCartPrice,
        checkoutKey: next.checkoutKey, status: next.status, lastActivityAt: next.lastActivityAt, updatedAt: new Date() };
      const unset = { guestId: "", abandonedAt: "" };
      if (bundles.length) set.bundles = next.bundles; else unset.bundles = "";
      if (next.deliveryAddress) set.deliveryAddress = next.deliveryAddress; else unset.deliveryAddress = "";
      const written = await CartModel.collection.updateOne(filter(original, account ? { user: next.user } : guestOwner),
        { $set: set, $unset: unset, $inc: { __v: 1 } }, { session });
      if (written.matchedCount !== 1 || written.modifiedCount !== 1) conflict();
      if (account) {
        const removed = await CartModel.collection.deleteOne(filter(guest, guestOwner), { session });
        if (removed.deletedCount !== 1) conflict();
      }
      return mapCustomerCartToResponse(draft);
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, readPreference: "primary" });
  } catch (error) {
    if (isCartCreationConflict(error, userId, null)) conflict();
    if (error.hasErrorLabel?.("UnknownTransactionCommitResult")) {
      throw new ApiError("Cart result is unknown. Refresh the cart before retrying the merge.", 503);
    }
    throw error;
  } finally { await session.endSession(); }
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
