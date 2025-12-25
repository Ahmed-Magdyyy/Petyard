import { ApiError } from "../../shared/utils/ApiError.js";
import { getCacheString, getOrSetCache } from "../../shared/utils/cache.js";
import { buildPetTags, resolveBreedTag } from "../../shared/utils/petTagging.js";
import { normalizeTag } from "../../shared/utils/tagging.js";
import { petLifeStageTags } from "../../shared/constants/petTags.js";
import { productTypeEnum } from "../../shared/constants/enums.js";

import { PetModel } from "../pet/pet.model.js";
import { ConditionModel } from "../condition/condition.model.js";
import { findProductById, findProducts } from "../product/product.repository.js";
import { mapProductToCardDto } from "../product/product.service.js";
import { findActivePromotionsForProducts } from "../collection/collection.promotion.js";

function normalizeLang(lang) {
  return lang === "ar" ? "ar" : "en";
}

function buildWarehouseStockFilter(warehouseId, productType) {
  if (!warehouseId) return null;

  if (productType === productTypeEnum.SIMPLE) {
    return {
      warehouseStocks: {
        $elemMatch: {
          warehouse: warehouseId,
          quantity: { $gt: 0 },
        },
      },
    };
  }

  if (productType === productTypeEnum.VARIANT) {
    return {
      variants: {
        $elemMatch: {
          warehouseStocks: {
            $elemMatch: {
              warehouse: warehouseId,
              quantity: { $gt: 0 },
            },
          },
        },
      },
    };
  }

  return {
    $or: [
      {
        type: productTypeEnum.SIMPLE,
        warehouseStocks: {
          $elemMatch: {
            warehouse: warehouseId,
            quantity: { $gt: 0 },
          },
        },
      },
      {
        type: productTypeEnum.VARIANT,
        variants: {
          $elemMatch: {
            warehouseStocks: {
              $elemMatch: {
                warehouse: warehouseId,
                quantity: { $gt: 0 },
              },
            },
          },
        },
      },
    ],
  };
}

async function fetchProductsWithStock({
  filter,
  warehouseId,
  limit,
  sort,
  lang,
  excludeIds,
}) {
  const normalizedLang = normalizeLang(lang);

  const andConditions = [{ isActive: true, ...(filter || {}) }];

  const warehouseFilter = buildWarehouseStockFilter(warehouseId);
  if (warehouseFilter) {
    andConditions.push(warehouseFilter);
  }

  if (Array.isArray(excludeIds) && excludeIds.length > 0) {
    andConditions.push({ _id: { $nin: excludeIds } });
  }

  const mongoFilter = andConditions.length === 1 ? andConditions[0] : { $and: andConditions };

  const select =
    "_id slug type name_en name_ar price discountedPrice images warehouseStocks.warehouse warehouseStocks.quantity variants.price variants.discountedPrice variants.warehouseStocks.warehouse variants.warehouseStocks.quantity ratingAverage ratingCount category subcategory brand";

  const products = await findProducts(mongoFilter, {
    limit,
    sort,
    select,
    lean: true,
  });

  const now = new Date();
  const promotionsByProductId = await findActivePromotionsForProducts(products, now);

  return products.map((p) => {
    const promotion = promotionsByProductId.get(String(p._id)) || null;
    return mapProductToCardDto(p, { lang: normalizedLang, promotion });
  });
}

async function getPetCacheVersion(userId) {
  if (!userId) return "0";
  const v = await getCacheString(`recs:petver:${String(userId)}`);
  return v || "0";
}

function pickUniqueProducts(existingIdsSet, products, limit) {
  const picked = [];

  for (const p of products) {
    const id = String(p?.id || p?._id || "");
    if (!id || existingIdsSet.has(id)) continue;
    existingIdsSet.add(id);
    picked.push(p);
    if (picked.length >= limit) break;
  }

  return picked;
}

async function resolveDefaultPetForUser(userId) {
  const pet = await PetModel.findOne({ petOwner: userId, isDefault: true }).lean();
  if (pet) return pet;
  return PetModel.findOne({ petOwner: userId }).sort({ createdAt: -1 }).lean();
}

async function loadConditionNamesBySlug(slugs) {
  const unique = [...new Set((slugs || []).map((s) => normalizeTag(s)).filter(Boolean))];
  if (!unique.length) return new Map();

  const conditions = await ConditionModel.find({ slug: { $in: unique } })
    .select("slug name_en name_ar")
    .lean();

  return new Map(conditions.map((c) => [c.slug, c]));
}

function formatTitleFromCondition(condition, lang) {
  if (!condition) return null;
  const normalizedLang = normalizeLang(lang);
  return normalizedLang === "ar" ? condition.name_ar || condition.name_en : condition.name_en;
}

export async function getHomeRecommendationsService({ userId, warehouseId, lang }) {
  if (!warehouseId) {
    throw new ApiError("warehouse is required", 400);
  }

  const normalizedLang = normalizeLang(lang);

  const petVersion = await getPetCacheVersion(userId);
  const cacheKey = `recs:home:${warehouseId}:${String(userId)}:${petVersion}:${normalizedLang}`;

  return getOrSetCache(cacheKey, 6 * 60 * 60, async () => {
    const usedIds = new Set();

    const pet = await resolveDefaultPetForUser(userId);

    if (!pet) {
      return [];
    }

    const petTags = buildPetTags(pet);
    const petType = normalizeTag(pet.type);
    const lifeStage = petTags.includes(petLifeStageTags.BABY)
      ? petLifeStageTags.BABY
      : petLifeStageTags.ADULT;

    const chronicSlugs = Array.isArray(pet.chronic_conditions) ? pet.chronic_conditions : [];
    const tempSlugs = Array.isArray(pet.temp_health_issues) ? pet.temp_health_issues : [];

    const conditionsBySlug = await loadConditionNamesBySlug([
      ...chronicSlugs,
      ...tempSlugs,
    ]);

    const sections = [];

    for (const slug of [...new Set(chronicSlugs.map((s) => normalizeTag(s)).filter(Boolean))].slice(
      0,
      2
    )) {
      const condition = conditionsBySlug.get(slug) || null;
      const title = formatTitleFromCondition(condition, normalizedLang) || slug;

      const products = await fetchProductsWithStock({
        filter: {
          tags: { $in: [slug, petType].filter(Boolean) },
        },
        warehouseId,
        limit: 14,
        sort: { ratingAverage: -1, createdAt: -1 },
        lang: normalizedLang,
      });

      const picked = pickUniqueProducts(usedIds, products, 10);
      if (picked.length) {
        sections.push({
          id: `chronic_${slug}`,
          title: `${title} Support`,
          titleAr: null,
          priority: sections.length + 1,
          reason: `Based on ${pet.name || "your pet"}`,
          products: picked,
        });
      }
    }

    for (const slug of [...new Set(tempSlugs.map((s) => normalizeTag(s)).filter(Boolean))].slice(
      0,
      2
    )) {
      const condition = conditionsBySlug.get(slug) || null;
      const title = formatTitleFromCondition(condition, normalizedLang) || slug;

      const products = await fetchProductsWithStock({
        filter: {
          tags: { $in: [slug, petType].filter(Boolean) },
        },
        warehouseId,
        limit: 14,
        sort: { ratingAverage: -1, createdAt: -1 },
        lang: normalizedLang,
      });

      const picked = pickUniqueProducts(usedIds, products, 10);
      if (picked.length) {
        sections.push({
          id: `issue_${slug}`,
          title: `For ${title}`,
          titleAr: null,
          priority: sections.length + 1,
          reason: `Based on ${pet.name || "your pet"}`,
          products: picked,
        });
      }
    }

    {
      const products = await fetchProductsWithStock({
        filter: {
          tags: { $in: [petType, lifeStage].filter(Boolean) },
        },
        warehouseId,
        limit: 14,
        sort: { ratingAverage: -1, createdAt: -1 },
        lang: normalizedLang,
      });

      const picked = pickUniqueProducts(usedIds, products, 10);
      if (picked.length) {
        const typeLabel = petType ? petType.charAt(0).toUpperCase() + petType.slice(1) : "Pet";
        const stageLabel = lifeStage === petLifeStageTags.BABY ? "Baby" : "Adult";

        sections.push({
          id: "life_stage",
          title: `${stageLabel} ${typeLabel} Essentials`,
          titleAr: null,
          priority: sections.length + 1,
          reason: "Based on age category",
          products: picked,
        });
      }
    }

    {
      const breedTag = resolveBreedTag({ petType: pet.type, breed: pet.breed });

      if (breedTag) {
        const products = await fetchProductsWithStock({
          filter: {
            tags: { $in: [petType, breedTag].filter(Boolean) },
          },
          warehouseId,
          limit: 14,
          sort: { ratingAverage: -1, createdAt: -1 },
          lang: normalizedLang,
        });

        const picked = pickUniqueProducts(usedIds, products, 10);
        if (picked.length) {
          sections.push({
            id: "breed_specific",
            title: `Perfect for ${pet.breed || "your pet"}`,
            titleAr: null,
            priority: sections.length + 1,
            reason: "Based on breed",
            products: picked,
          });
        }
      }
    }

    {
      const products = await fetchProductsWithStock({
        filter: {
          ...(petType ? { tags: petType } : {}),
          isFeatured: true,
        },
        warehouseId,
        limit: 20,
        sort: { createdAt: -1 },
        lang: normalizedLang,
        excludeIds: [...usedIds],
      });

      const picked = pickUniqueProducts(usedIds, products, 12);
      if (picked.length) {
        sections.push({
          id: "featured",
          title: "Featured",
          titleAr: "منتجات مميزة",
          priority: sections.length + 1,
          reason: "Featured products available in your area",
          products: picked,
        });
      }
    }

    return sections.sort((a, b) => a.priority - b.priority);
  });
}

export async function getRelatedProductsService({
  productId,
  warehouseId,
  userId,
  lang,
}) {
  if (!warehouseId) {
    throw new ApiError("warehouse is required", 400);
  }

  if (!productId) {
    throw new ApiError("productId is required", 400);
  }

  const normalizedLang = normalizeLang(lang);

  const userKey = userId ? String(userId) : "guest";
  const petVersion = userId ? await getPetCacheVersion(userId) : "0";
  const cacheKey = `recs:related:${warehouseId}:${productId}:${userKey}:${petVersion}:${normalizedLang}`;

  return getOrSetCache(cacheKey, 60 * 60, async () => {
    const usedIds = new Set([String(productId)]);

    const currentProduct = await findProductById(productId)
      .select("_id category subcategory tags")
      .lean();

    if (!currentProduct) {
      throw new ApiError("Product not found", 404);
    }

    const pet = userId ? await resolveDefaultPetForUser(userId) : null;

    const petTags = pet ? buildPetTags(pet) : [];
    const petType = pet ? normalizeTag(pet.type) : "";

    const results = [];

    const tier1 = await fetchProductsWithStock({
      filter: {
        subcategory: currentProduct.subcategory,
        ...(petType ? { tags: petType } : {}),
      },
      warehouseId,
      limit: 12,
      sort: { ratingAverage: -1, createdAt: -1 },
      lang: normalizedLang,
      excludeIds: [...usedIds],
    });

    results.push(...pickUniqueProducts(usedIds, tier1, 6));

    if (results.length < 10 && Array.isArray(currentProduct.tags) && currentProduct.tags.length) {
      const tier2 = await fetchProductsWithStock({
        filter: {
          category: currentProduct.category,
          tags: { $in: currentProduct.tags },
        },
        warehouseId,
        limit: 20,
        sort: { ratingAverage: -1, createdAt: -1 },
        lang: normalizedLang,
        excludeIds: [...usedIds],
      });

      results.push(...pickUniqueProducts(usedIds, tier2, 10 - results.length));
    }

    if (results.length < 10 && petTags.length) {
      const tier3 = await fetchProductsWithStock({
        filter: {
          tags: { $in: petTags },
        },
        warehouseId,
        limit: 20,
        sort: { ratingAverage: -1, createdAt: -1 },
        lang: normalizedLang,
        excludeIds: [...usedIds],
      });

      results.push(...pickUniqueProducts(usedIds, tier3, 10 - results.length));
    }

    if (results.length < 10) {
      const tier4 = await fetchProductsWithStock({
        filter: { isFeatured: true },
        warehouseId,
        limit: 20,
        sort: { createdAt: -1 },
        lang: normalizedLang,
        excludeIds: [...usedIds],
      });

      results.push(...pickUniqueProducts(usedIds, tier4, 10 - results.length));
    }

    return results.slice(0, 10);
  });
}
