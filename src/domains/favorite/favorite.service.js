import { ApiError } from "../../shared/utils/ApiError.js";
import { FavoriteModel } from "./favorite.model.js";
import { findProductById, findProductsByIds } from "../product/product.repository.js";
import { pickLocalizedField } from "../../shared/utils/i18n.js";

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

  const products = await findProductsByIds(productIds);
  const productById = new Map(products.map((p) => [String(p._id), p]));

  for (const item of items) {
    const product = productById.get(String(item.product));
    if (!product) continue;

    const localizedName = pickLocalizedField(product, "name", normalizedLang);
    item.productName = localizedName;

    const isSimple = product.type === "SIMPLE";

    if (isSimple) {
      item.productImageUrl = pickMainImageUrl(product.images);
      item.price =
        typeof product.price === "number" ? product.price : item.price;
      item.discountedPrice =
        typeof product.discountedPrice === "number"
          ? product.discountedPrice
          : undefined;
    } else {
      const variant = pickRepresentativeVariant(product);

      if (variant) {
        item.productImageUrl =
          pickMainImageUrl(variant.images) || pickMainImageUrl(product.images);
        item.price =
          typeof variant.price === "number" ? variant.price : item.price;
        item.discountedPrice =
          typeof variant.discountedPrice === "number"
            ? variant.discountedPrice
            : undefined;
      } else {
        // Fallback to product-level price/image if no variants found
        item.productImageUrl = pickMainImageUrl(product.images);
        item.price =
          typeof product.price === "number" ? product.price : item.price;
        item.discountedPrice =
          typeof product.discountedPrice === "number"
            ? product.discountedPrice
            : undefined;
      }
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

  let productName;
  let productImageUrl;
  let price;
  let discountedPrice;

  const isSimple = product.type === "SIMPLE";

  if (isSimple) {
    productName = pickLocalizedField(product, "name", normalizedLang);
    productImageUrl = pickMainImageUrl(product.images);
    price = typeof product.price === "number" ? product.price : 0;
    discountedPrice =
      typeof product.discountedPrice === "number"
        ? product.discountedPrice
        : undefined;
  } else {
    const variant = pickRepresentativeVariant(product);

    if (variant) {
      productImageUrl = pickMainImageUrl(variant.images) || pickMainImageUrl(product.images);
      price = typeof variant.price === "number" ? variant.price : 0;
      discountedPrice =
        typeof variant.discountedPrice === "number"
          ? variant.discountedPrice
          : undefined;
    } else {
      // Fallback to product-level price/image if no variants found
      productImageUrl = pickMainImageUrl(product.images);
      price = typeof product.price === "number" ? product.price : 0;
      discountedPrice =
        typeof product.discountedPrice === "number"
          ? product.discountedPrice
          : undefined;
    }
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
