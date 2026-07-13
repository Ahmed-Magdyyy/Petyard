import {
  bumpCacheVersion,
  deleteCachePattern,
  getCacheVersion,
} from "../../shared/utils/cache.js";
import { parseBoundedInt } from "../../shared/utils/env.js";

export const PRODUCT_LIST_CACHE_VERSION_KEY = "products:list:version";

export const productCacheConfig = {
  detailTtlSeconds: parseBoundedInt(
    process.env.PRODUCT_DETAIL_CACHE_TTL_SECONDS,
    60,
    5,
    60 * 60,
  ),
  listTtlSeconds: parseBoundedInt(
    process.env.PRODUCT_LIST_CACHE_TTL_SECONDS,
    30,
    5,
    10 * 60,
  ),
};

export async function getProductListCacheVersion() {
  return getCacheVersion(PRODUCT_LIST_CACHE_VERSION_KEY);
}

export async function bumpProductListCacheVersion() {
  return bumpCacheVersion(PRODUCT_LIST_CACHE_VERSION_KEY);
}

export async function invalidateProductCaches(productIds = []) {
  const uniqueIds = [
    ...new Set(
      (Array.isArray(productIds) ? productIds : [productIds])
        .map((id) => (id ? String(id) : null))
        .filter(Boolean),
    ),
  ];

  await Promise.all([
    bumpProductListCacheVersion(),
    ...uniqueIds.map((id) => deleteCachePattern(`product:${id}:*`)),
  ]);
}
