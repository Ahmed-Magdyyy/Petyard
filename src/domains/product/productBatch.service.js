import { findProducts } from "./product.repository.js";
import { mapProductToDetailDto, getFavoriteProductIdsForIdentity } from "./product.service.js";
import { findActivePromotionsForProducts } from "../collection/collection.promotion.js";
import { getRestockSubscribedProductIdsForUser } from "../restockSubscription/restockSubscription.service.js";
import { projectProductsMedia } from "../videos/public/productMedia.service.js";
import { resolveEffectiveWarehouse } from "../warehouse/warehouse.fulfillment.js";
import { roles, enabledControls } from "../../shared/constants/enums.js";
import { parseProductBatchBody } from "./productBatch.contract.js";
import { PRODUCT_BATCH_MAX_RESPONSE_BYTES, PRODUCT_BATCH_QUERY_TIMEOUT_MS } from "./productBatch.constants.js";
import { ApiError } from "../../shared/utils/ApiError.js";

export async function getProductsBatchService(ids, { lang = "en", user = null,
  warehouseId = null, guestId = null, includeStockRevisions = false, stockRevisionWarehouseScope = null } = {}) {
  const requested = parseProductBatchBody({ ids });
  if (!requested.length) return { products: [], unavailable_product_ids: [] };
  const includeAllLanguages = Boolean(user && (user.role === roles.SUPER_ADMIN ||
    (user.role === roles.ADMIN && user.enabledControls?.includes(enabledControls.PRODUCTS))));
  const allowInactive = includeAllLanguages || (user?.role === roles.MODERATOR && includeStockRevisions);
  if (warehouseId && !includeAllLanguages) {
    warehouseId = String((await resolveEffectiveWarehouse(warehouseId)).effectiveWarehouse._id);
  }
  const rows = await findProducts({ _id: { $in: requested }, ...(!allowInactive ? { isActive: true } : {}) },
    { lean: true }).maxTimeMS(PRODUCT_BATCH_QUERY_TIMEOUT_MS);
  const byId = new Map(rows.filter((row) => requested.includes(String(row._id)) &&
    (allowInactive || row.isActive !== false)).map((row) => [String(row._id), row]));
  const products = requested.filter((id) => byId.has(id)).map((id) => byId.get(id));
  const userId = user?._id || user?.id || null;
  // Reuse pricing/localization and load customer state once. No maintenance writes or detail HTTP calls.
  const [promotions, favorites, restocks] = await Promise.all([
    findActivePromotionsForProducts(products),
    getFavoriteProductIdsForIdentity({ userId, guestId }),
    (userId || guestId) && warehouseId ? getRestockSubscribedProductIdsForUser({
      userId, guestId, productIds: products.map((product) => product._id), warehouseId,
    }) : new Set(),
  ]);
  const details = products.map((product) => ({
    ...mapProductToDetailDto(product, { lang, promotion: promotions.get(String(product._id)) || null,
      includeAllLanguages, includeStockRevisions, stockRevisionWarehouseScope, warehouseId }),
    isFavorite: favorites.has(String(product._id)),
    isRestockNotificationRequested: restocks.has(String(product._id)),
  }));
  const media = await projectProductsMedia(details.map((product) => ({ productId: product.id, images: product.images })));
  details.forEach((product) => { product.media = media.get(String(product.id)); });
  const result = { products: details, unavailable_product_ids: requested.filter((id) => !byId.has(id)) };
  if (Buffer.byteLength(JSON.stringify({ data: result }), "utf8") > PRODUCT_BATCH_MAX_RESPONSE_BYTES) {
    throw new ApiError("Product batch response exceeds 2 MiB. No products were truncated.", 413);
  }
  return result;
}
