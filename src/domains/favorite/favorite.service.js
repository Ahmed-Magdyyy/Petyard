import { ApiError } from "../../shared/utils/ApiError.js";
import { FavoriteModel } from "./favorite.model.js";
import {
  findProductById,
  findProductsByIds,
  findProductsByIdsWithOptions,
} from "../product/product.repository.js";
import { pickLocalizedField } from "../../shared/utils/i18n.js";
import { computeFinalDiscountedPrice } from "../../shared/utils/pricing.js";
import { findActivePromotionsForProducts } from "../collection/collection.promotion.js";
import { productTypeEnum } from "../../shared/constants/enums.js";

function normalizeLang(lang) {
  return lang === "ar" ? "ar" : "en";
}

function buildIdentityFilter({ userId, guestId }) {
  if (userId) return { user: userId };
  if (guestId) return { guestId };
  throw new ApiError("Either userId or guestId must be provided", 400);
}

function pickMainImageUrl(images) {
  if (!Array.isArray(images) || images.length === 0) {
    return null;
  }
  const main = images.find((img) => img.isMain) || images[0];
  return main && main.url ? main.url : null;
}

function pickRepresentativeVariant(product) {
  if (!product || !Array.isArray(product.variants) || !product.variants.length) {
    return null;
  }
  const variants = product.variants;
  const def = variants.find((v) => v.isDefault);
  return def || variants[0];
}

function computeLowestVariantPricing(product, promoPercent) {
  if (!product || !Array.isArray(product.variants) || !product.variants.length) {
    return { price: null, discountedPrice: null };
  }

  let minBasePrice = Infinity;
  let minFinalEffective = Infinity;

  for (const v of product.variants) {
    const basePrice = typeof v.price === "number" ? v.price : null;
    if (basePrice == null) continue;

    const baseDiscounted =
      typeof v.discountedPrice === "number" ? v.discountedPrice : null;

    if (basePrice < minBasePrice) {
      minBasePrice = basePrice;
    }

    const pricing = computeFinalDiscountedPrice({
      price: basePrice,
      discountedPrice: baseDiscounted,
      promoPercent,
    });

    if (typeof pricing.finalEffective === "number") {
      if (pricing.finalEffective < minFinalEffective) {
        minFinalEffective = pricing.finalEffective;
      }
    }
  }

  const price = minBasePrice !== Infinity ? minBasePrice : null;
  const discountedPrice =
    price != null && minFinalEffective !== Infinity && minFinalEffective < price
      ? minFinalEffective
      : null;

  return { price, discountedPrice };
}

function pickRepresentativeVariantImage(product) {
  const variant = pickRepresentativeVariant(product);
  if (variant) {
    return pickMainImageUrl(variant.images) || pickMainImageUrl(product.images);
  }
  return pickMainImageUrl(product.images);
}

async function rebindFavoriteLocalization(favorite, lang = "en") {
  if (!favorite) return null;

  const items = Array.isArray(favorite.items) ? favorite.items : [];
  if (!items.length) return favorite;

  const normalizedLang = normalizeLang(lang);

  const productIds = [
    ...new Set(
      items
        .map((item) => (item.product ? String(item.product) : null))
        .filter(Boolean)
    ),
  ];

  if (!productIds.length) return favorite;

  const products = await findProductsByIdsWithOptions(productIds, {
    select:
      "_id type price discountedPrice subcategory brand name_en name_ar images variants",
    lean: false,
  });
  const productById = new Map(products.map((p) => [String(p._id), p]));

  const promoNow = new Date();
  const promotionByProductId = await findActivePromotionsForProducts(
    products,
    promoNow
  );

  for (const item of items) {
    const product = productById.get(String(item.product));
    if (!product) continue;

    const localizedName = pickLocalizedField(product, "name", normalizedLang);
    item.productName = localizedName;
    item.productType = product.type || productTypeEnum.SIMPLE;

    const promotion = promotionByProductId.get(String(product._id)) || null;
    const promoPercent =
      promotion && typeof promotion.discountPercent === "number"
        ? promotion.discountPercent
        : null;

    const isSimple = product.type === productTypeEnum.SIMPLE;

    if (isSimple) {
      item.productImageUrl = pickMainImageUrl(product.images);

      const pricing = computeFinalDiscountedPrice({
        price: product.price,
        discountedPrice: product.discountedPrice,
        promoPercent,
      });

      item.price =
        typeof pricing.basePrice === "number" ? pricing.basePrice : item.price;
      item.discountedPrice =
        typeof pricing.final === "number" ? pricing.final : undefined;
    } else {
      item.productImageUrl = pickRepresentativeVariantImage(product);

      const variantPricing = computeLowestVariantPricing(product, promoPercent);
      item.price =
        typeof variantPricing.price === "number"
          ? variantPricing.price
          : item.price;
      item.discountedPrice =
        typeof variantPricing.discountedPrice === "number"
          ? variantPricing.discountedPrice
          : undefined;
    }
  }

  await favorite.save();

  return favorite;
}

function mapFavoriteToResponse(favorite, lang = "en") {
  if (!favorite) {
    return {
      id: null,
      userId: null,
      guestId: null,
      items: [],
    };
  }

  return {
    id: favorite._id,
    userId: favorite.user || undefined,
    guestId: favorite.guestId || undefined,
    items: Array.isArray(favorite.items)
      ? favorite.items.map((item) => ({
          id: item._id,
          productId: item.product,
          productType: item.productType || "SIMPLE",
          productName: item.productName || null,
          productImageUrl: item.productImageUrl || null,
          price: item.price,
          discountedPrice: item.discountedPrice ?? null,
          addedAt: item.addedAt,
        }))
      : [],
  };
}

export async function getFavoriteService({ userId, guestId, lang = "en" }) {
  const filter = buildIdentityFilter({ userId, guestId });
  let favorite = await FavoriteModel.findOne(filter);
console.log("favorites", favorite);

  if (!favorite) {
    favorite = await FavoriteModel.create({
      ...filter,
      items: [],
    });
  }

  await rebindFavoriteLocalization(favorite, lang);

  return mapFavoriteToResponse(favorite, normalizeLang(lang));
}

export async function addToFavoriteService({
  userId,
  guestId,
  productId,
  lang = "en",
}) {
  if (!productId) {
    throw new ApiError("productId is required", 400);
  }

  const normalizedLang = normalizeLang(lang);
  const filter = buildIdentityFilter({ userId, guestId });

  const product = await findProductById(productId);
  if (!product) {
    throw new ApiError("Product not found", 404);
  }

  const productType = product.type || productTypeEnum.SIMPLE;
  const productName = pickLocalizedField(product, "name", normalizedLang);

  let productImageUrl;
  let price;
  let discountedPrice;

  const isSimple = productType === productTypeEnum.SIMPLE;

  if (isSimple) {
    productImageUrl = pickMainImageUrl(product.images);
    price = typeof product.price === "number" ? product.price : 0;
    discountedPrice =
      typeof product.discountedPrice === "number"
        ? product.discountedPrice
        : undefined;
  } else {
    productImageUrl = pickRepresentativeVariantImage(product);
    const variantPricing = computeLowestVariantPricing(product, null);
    price =
      typeof variantPricing.price === "number" ? variantPricing.price : 0;
    discountedPrice =
      typeof variantPricing.discountedPrice === "number"
        ? variantPricing.discountedPrice
        : undefined;
  }

  let favorite = await FavoriteModel.findOne(filter);

  if (!favorite) {
    favorite = await FavoriteModel.create({
      ...filter,
      items: [],
    });
  }

  const items = Array.isArray(favorite.items) ? favorite.items : [];

  const existingIndex = items.findIndex((item) => {
    const sameProduct = String(item.product) === String(productId);
    return sameProduct;
  });

  if (existingIndex >= 0) {
    return mapFavoriteToResponse(favorite, normalizedLang);
  }

  const newItem = {
    product: productId,
    productType,
    productName,
    productImageUrl,
    price,
    discountedPrice,
    addedAt: new Date(),
  };

  favorite.items.push(newItem);
  await favorite.save();

  return mapFavoriteToResponse(favorite, normalizedLang);
}

export async function removeFromFavoriteService({
  userId,
  guestId,
  productId,
}) {
  if (!productId) {
    throw new ApiError("productId is required", 400);
  }

  const filter = buildIdentityFilter({ userId, guestId });
  const favorite = await FavoriteModel.findOne(filter);

  if (!favorite) {
    return mapFavoriteToResponse(null);
  }

  const items = Array.isArray(favorite.items) ? favorite.items : [];

  const existingIndex = items.findIndex((item) => {
    const sameProduct = String(item.product) === String(productId);
    return sameProduct;
  });

  if (existingIndex < 0) {
    return mapFavoriteToResponse(favorite);
  }

  favorite.items.splice(existingIndex, 1);
  await favorite.save();

  return mapFavoriteToResponse(favorite);
}

export async function clearFavoriteService({ userId, guestId }) {
  const filter = buildIdentityFilter({ userId, guestId });
  const favorite = await FavoriteModel.findOne(filter);

  if (!favorite) {
    return mapFavoriteToResponse(null);
  }

  favorite.items = [];
  await favorite.save();

  return mapFavoriteToResponse(favorite);
}

export async function mergeGuestFavoriteService({ userId, guestId, lang = "en" }) {
  if (!guestId) {
    throw new ApiError("guestId is required for merge", 400);
  }

  const normalizedLang = normalizeLang(lang);

  const guestFavorite = await FavoriteModel.findOne({ guestId });

  // No guest favorites: just return/create the user favorites
  if (!guestFavorite) {
    return getFavoriteService({ userId, lang: normalizedLang });
  }

  let userFavorite = await FavoriteModel.findOne({ user: userId });

  // Case A: no existing user favorite -> adopt guest favorite
  if (!userFavorite) {
    guestFavorite.user = userId;
    guestFavorite.guestId = undefined;
    await guestFavorite.save();

    return getFavoriteService({ userId, lang: normalizedLang });
  }

  // Case B: both guest and user favorites exist -> merge
  const guestItems = Array.isArray(guestFavorite.items) ? guestFavorite.items : [];
  const userItems = Array.isArray(userFavorite.items) ? userFavorite.items : [];

  if (!guestItems.length) {
    await FavoriteModel.deleteOne({ _id: guestFavorite._id });
    return getFavoriteService({ userId, lang: normalizedLang });
  }

  const userProductIds = new Set(
    userItems
      .map((item) => (item.product ? String(item.product) : null))
      .filter(Boolean)
  );

  for (const gItem of guestItems) {
    const pid = gItem.product ? String(gItem.product) : null;
    if (!pid || userProductIds.has(pid)) {
      continue;
    }

    userFavorite.items.push({
      product: gItem.product,
      productName: gItem.productName,
      productImageUrl: gItem.productImageUrl,
      price: gItem.price,
      discountedPrice: gItem.discountedPrice,
      addedAt: gItem.addedAt || new Date(),
    });
  }

  await FavoriteModel.deleteOne({ _id: guestFavorite._id });
  await userFavorite.save();

  return getFavoriteService({ userId, lang: normalizedLang });
}
