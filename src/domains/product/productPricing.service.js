import { ApiError } from "../../shared/utils/ApiError.js";
import { toPiastres } from "../../shared/utils/money.js";
import { computeFinalDiscountedPrice } from "../../shared/utils/pricing.js";
import { findActivePromotionForProduct } from "../collection/collection.promotion.js";

function findExactWarehouseStock(stocks, warehouseId) {
  return (Array.isArray(stocks) ? stocks : []).find(
    (stock) => String(stock?.warehouse) === String(warehouseId),
  );
}

function pickImageUrl(product, variant) {
  const images = [
    ...(Array.isArray(variant?.images) ? variant.images : []),
    ...(Array.isArray(product?.images) ? product.images : []),
  ];
  return images.find((image) => image?.isMain)?.url || images[0]?.url || null;
}

export async function resolveActiveProductPromotion(product, now = new Date()) {
  return findActivePromotionForProduct(
    {
      productId: product._id,
      subcategoryId: product.subcategory,
      brandId: product.brand,
    },
    now,
  );
}

export function buildWarehouseSkuSnapshot({
  product,
  variantId,
  warehouseId,
  promotion,
}) {
  if (!product || !warehouseId) {
    throw new ApiError("Product and warehouse are required", 400);
  }

  const isVariant = product.type === "VARIANT";
  const variant = isVariant
    ? (product.variants || []).find(
        (item) => String(item?._id) === String(variantId || ""),
      )
    : null;

  if (isVariant && !variant) {
    throw new ApiError("Variant not found", 404);
  }

  const stock = findExactWarehouseStock(
    isVariant ? variant.warehouseStocks : product.warehouseStocks,
    warehouseId,
  );
  if (!stock || !Number.isInteger(stock.quantity) || stock.quantity <= 0) {
    throw new ApiError("Product is unavailable in the order warehouse", 409, [
      { code: "SUBSTITUTE_NOT_AVAILABLE" },
    ]);
  }

  const price = isVariant ? variant.price : product.price;
  const discountedPrice = isVariant
    ? variant.discountedPrice
    : product.discountedPrice;
  const promoPercent =
    typeof promotion?.discountPercent === "number"
      ? promotion.discountPercent
      : null;
  const pricing = computeFinalDiscountedPrice({
    price,
    discountedPrice,
    promoPercent,
  });

  return {
    product: product._id,
    variantId: variant?._id,
    productType: product.type,
    productName_en: product.name_en,
    productName_ar: product.name_ar,
    productImageUrl: pickImageUrl(product, variant),
    variantOptions: Array.isArray(variant?.options)
      ? variant.options.map((option) => ({
          name: option.name,
          value: option.value,
        }))
      : [],
    unitPricePiastres: toPiastres(pricing.finalEffective || 0),
    stockQuantity: stock.quantity,
    stockRevision:
      Number.isInteger(stock.revision) && stock.revision >= 0
        ? stock.revision
        : 0,
  };
}
