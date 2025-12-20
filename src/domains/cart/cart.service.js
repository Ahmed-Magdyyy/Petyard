import {
  findProductById,
  findProductsByIds,
  findProductsByIdsWithOptions,
} from "../product/product.repository.js";
import { WarehouseModel } from "../warehouse/warehouse.model.js";
import { UserModel } from "../user/user.model.js";
import { ApiError } from "../../shared/ApiError.js";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import { normalizeProductType } from "../../shared/utils/productType.js";
import { cartStatusEnum, productTypeEnum } from "../../shared/constants/enums.js";
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

const MAX_ABANDON_EMAILS_PER_CART = 3;
const ABANDON_EMAIL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const AUTO_HIDE_EXPIRED_COLLECTIONS_COOLDOWN_MS = 60 * 1000;
let lastAutoHideExpiredCollectionsAt = 0;
let autoHideExpiredCollectionsInFlight = null;

function normalizeLang(lang) {
  return lang === "ar" ? "ar" : "en";
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
  const exists = await WarehouseModel.exists({ _id: warehouseId });
  if (!exists) {
    throw new ApiError(`No warehouse found for this id: ${warehouseId}`, 400);
  }
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
    });
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

function mapCartToResponse(cart) {
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
        userAddressId: cart.deliveryAddress.userAddressId || null,
        label: cart.deliveryAddress.label || null,
        name: cart.deliveryAddress.name || null,
        governorate: cart.deliveryAddress.governorate || null,
        area: cart.deliveryAddress.area || null,
        phone: cart.deliveryAddress.phone || null,
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
    (ws) => String(ws.warehouse) === String(warehouseId)
  );
}

function findVariantWarehouseStock(variant, warehouseId) {
  if (!Array.isArray(variant.warehouseStocks)) return null;
  return variant.warehouseStocks.find(
    (ws) => String(ws.warehouse) === String(warehouseId)
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
        .filter(Boolean)
    ),
  ];
}

async function fetchProductsForCart(productIds) {
  return findProductsByIdsWithOptions(productIds, {
    select:
      "_id type price discountedPrice subcategory brand name_en name_ar images warehouseStocks variants",
    lean: true,
  });
}

async function fetchPromotionsForProducts(products, now) {
  const promotionByProductId = new Map();

  await Promise.all(
    products.map(async (product) => {
      const pid = product?._id ? String(product._id) : null;
      if (!pid) return;
      const promotion = await findActivePromotionForProduct(
        {
          productId: product._id,
          subcategoryId: product.subcategory,
          brandId: product.brand,
        },
        now
      );
      promotionByProductId.set(pid, promotion || null);
    })
  );

  return promotionByProductId;
}

function buildRemovedItems({ originalItems, keptItems, productById, normalizedLang }) {
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
  await cart.save();
  return cart;
}

async function rebindCartToWarehouse(cart, warehouseId, lang = "en") {
  if (!cart) return null;

  await autoHideExpiredCollectionsThrottled();

  const normalizedLang = normalizeLang(lang);

  const items = Array.isArray(cart.items) ? cart.items : [];
  const originalItems = [...items];

  if (!items.length) {
    cart._removedItems = undefined;
    await finalizeActiveCartAndSave(cart, warehouseId);
    return cart;
  }

  const productIds = buildCartProductIds(items);

  const products = await fetchProductsForCart(productIds);
  const productById = new Map(products.map((p) => [String(p._id), p]));

  const promoNow = new Date();
  const promotionByProductId = await fetchPromotionsForProducts(products, promoNow);

  const keptItems = [];

  for (const item of items) {
    const product = productById.get(String(item.product));
    if (!product) continue;

    if (product.type !== item.productType) continue;

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
        typeof product.discountedPrice === "number" ? product.discountedPrice : null;

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
        typeof variant.discountedPrice === "number" ? variant.discountedPrice : null;

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
  await finalizeActiveCartAndSave(cart, warehouseId);

  return cart;
}

export async function getCartService({
  userId,
  guestId,
  warehouseId,
  lang = "en",
}) {
  await assertWarehouseExists(warehouseId);

  const baseCart = await getOrCreateCart({ userId, guestId, warehouseId });
  const cart = await rebindCartToWarehouse(baseCart, warehouseId, lang);
  return mapCartToResponse(cart);
}

export async function setCartAddressFromUserService({
  userId,
  warehouseId,
  userAddressId,
  lang = "en",
}) {
  await assertWarehouseExists(warehouseId);

  const user = await UserModel.findById(userId);
  if (!user) {
    throw new ApiError("User not found", 404);
  }

  const address = user.addresses && user.addresses.id(userAddressId);
  if (!address) {
    throw new ApiError("Address not found for this user", 404);
  }

  const baseCart = await getOrCreateCart({
    userId,
    guestId: null,
    warehouseId,
  });

  baseCart.deliveryAddress = {
    userAddressId: address._id,
    label: address.label || undefined,
    name: address.name || user.name || undefined,
    governorate: address.governorate || undefined,
    area: address.area || undefined,
    phone: address.phone || user.phone || undefined,
    location: address.location
      ? {
          lat: address.location.lat,
          lng: address.location.lng,
        }
      : undefined,
    details: address.details || undefined,
  };

  const cart = await rebindCartToWarehouse(baseCart, warehouseId, lang);
  return mapCartToResponse(cart);
}

export async function setCartAddressForGuestService({
  guestId,
  warehouseId,
  address,
  lang = "en",
}) {
  if (!guestId) {
    throw new ApiError("guestId is required for setting cart address", 400);
  }

  await assertWarehouseExists(warehouseId);

  const baseCart = await getOrCreateCart({
    userId: null,
    guestId,
    warehouseId,
  });

  const safeAddress = address || {};

  baseCart.deliveryAddress = {
    userAddressId: undefined,
    label: safeAddress.label || undefined,
    name: safeAddress.name || undefined,
    governorate: safeAddress.governorate || undefined,
    area: safeAddress.area || undefined,
    phone: safeAddress.phone || undefined,
    location:
      safeAddress.location &&
      typeof safeAddress.location === "object" &&
      safeAddress.location !== null
        ? {
            lat: safeAddress.location.lat,
            lng: safeAddress.location.lng,
          }
        : undefined,
    details: safeAddress.details || undefined,
  };

  const cart = await rebindCartToWarehouse(baseCart, warehouseId, lang);
  return mapCartToResponse(cart);
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
    throw new ApiError("quantity must be greater than 0", 400);
  }

  await assertWarehouseExists(warehouseId);

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
      400
    );
  }

  const normalizedLang = normalizeLang(lang);
  const productName = pickLocalizedField(product, "name", normalizedLang);

  const cart = await getOrCreateCart({ userId, guestId, warehouseId });
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
        "This product is not available in the selected warehouse",
        400
      );
    }
    if (requestedTotalQuantity > stock.quantity) {
      throw new ApiError(
        `Requested quantity exceeds available stock (${stock.quantity})`,
        400
      );
    }

    const price = typeof product.price === "number" ? product.price : 0;
    const discounted =
      typeof product.discountedPrice === "number"
        ? product.discountedPrice
        : undefined;
    itemPrice = typeof discounted === "number" ? discounted : price;

    productImageUrl = pickMainImageUrl(product.images);
  } else {
    variant = findVariantById(product, variantId);
    if (!variant) {
      throw new ApiError("Variant not found on this product", 404);
    }

    const stock = findVariantWarehouseStock(variant, warehouseId);
    if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
      throw new ApiError(
        "This product variant is out of stock or not available in the selected warehouse",
        400
      );
    }
    if (requestedTotalQuantity > stock.quantity) {
      throw new ApiError(
        `Requested quantity exceeds available stock (${stock.quantity})`,
        400
      );
    }

    const price = typeof variant.price === "number" ? variant.price : 0;
    const discounted =
      typeof variant.discountedPrice === "number"
        ? variant.discountedPrice
        : undefined;
    itemPrice = typeof discounted === "number" ? discounted : price;

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
  return mapCartToResponse(refreshed);
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
    throw new ApiError("quantity must be greater than 0", 400);
  }

  const cart = await getExistingCartOrThrow({ userId, guestId, warehouseId });

  const item = cart.items.id(itemId);
  if (!item) {
    throw new ApiError("Cart item not found", 404);
  }

  const product = await findProductById(item.product);
  if (!product) {
    throw new ApiError("Product no longer exists", 400);
  }

  if (product.type !== item.productType) {
    throw new ApiError("Product type mismatch for cart item", 400);
  }

  if (product.type === "SIMPLE") {
    const stock = findSimpleWarehouseStock(product, warehouseId);
    if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
      throw new ApiError(
        "This product is not available in the selected warehouse",
        400
      );
    }
    if (quantity > stock.quantity) {
      throw new ApiError(
        `Requested quantity exceeds available stock (${stock.quantity})`,
        400
      );
    }
  } else if (product.type === "VARIANT") {
    const variant = findVariantById(product, item.variantId);
    if (!variant) {
      throw new ApiError("Variant not found on this product", 404);
    }

    const stock = findVariantWarehouseStock(variant, warehouseId);
    if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
      throw new ApiError(
        "This product variant is not available in the selected warehouse",
        400
      );
    }
    if (quantity > stock.quantity) {
      throw new ApiError(
        `Requested quantity exceeds available stock (${stock.quantity})`,
        400
      );
    }
  }

  item.quantity = quantity;

  const refreshed = await rebindCartToWarehouse(cart, warehouseId, lang);
  return mapCartToResponse(refreshed);
}

export async function removeCartItemService({
  userId,
  guestId,
  warehouseId,
  itemId,
  lang = "en",
}) {
  const cart = await getExistingCartOrThrow({ userId, guestId, warehouseId });

  const item = cart.items.id(itemId);
  if (!item) {
    throw new ApiError("Cart item not found", 404);
  }

  item.deleteOne();

  const refreshed = await rebindCartToWarehouse(cart, warehouseId, lang);
  return mapCartToResponse(refreshed);
}

export async function clearCartService({ userId, guestId, warehouseId }) {
  const identityFilter = buildIdentityFilter({ userId, guestId });

  await deleteCart(identityFilter);

  return { success: true };
}

export async function mergeGuestCartService({ userId, guestId, warehouseId }) {
  if (!guestId) {
    throw new ApiError("guestId is required for merge", 400);
  }

  await assertWarehouseExists(warehouseId);

  const guestCart = await findCart({ guestId });

  // No guest cart: just return the current user cart (or an empty one)
  if (!guestCart) {
    const baseUserCart = await getOrCreateCart({
      userId,
      guestId: null,
      warehouseId,
    });
    const refreshedUserCart = await rebindCartToWarehouse(
      baseUserCart,
      warehouseId
    );
    return mapCartToResponse(refreshedUserCart);
  }

  let userCart = await findCart({ user: userId });

  // Case A: no existing user cart -> adopt guest cart
  if (!userCart) {
    guestCart.user = userId;
    guestCart.guestId = undefined;
    guestCart.lastActivityAt = new Date();
    guestCart.status = "ACTIVE";
    await guestCart.save();

    const adoptedCart = await rebindCartToWarehouse(guestCart, warehouseId);
    return mapCartToResponse(adoptedCart);
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
    return mapCartToResponse(finalCart);
  }

  const allItems = [...userItems, ...guestItems];
  const productIds = [
    ...new Set(
      allItems
        .map((item) => (item.product ? String(item.product) : null))
        .filter(Boolean)
    ),
  ];

  const products = await findProductsByIds(productIds);
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
  return mapCartToResponse(finalCart);
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
      filter.lastActivityAt.$gte = new Date(from);
    }
    if (to) {
      filter.lastActivityAt.$lte = new Date(to);
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
          cart.currency || "EGP"
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
