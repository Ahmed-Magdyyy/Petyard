import { ApiError } from "../../shared/utils/ApiError.js";
import { orderStatusEnum } from "../../shared/constants/enums.js";
import { OrderModel } from "../order/order.model.js";
import { ProductModel } from "../product/product.model.js";
import { ANALYTICS_TIMEZONE } from "./analytics.period.js";
import { productRankingQuery, productSalesStages, productSalesRow } from "./analytics.product-sales.js";

export function highestProductsPipeline(period, { warehouse, metric, limit }) {
  return [
    ...productSalesStages(period, warehouse),
    { $sort: { [metric === "units" ? "unitsSold" : "recordedItemValue"]: -1, _id: 1 } }, { $limit: limit },
    { $lookup: { from: ProductModel.collection.name, localField: "_id", foreignField: "_id",
      pipeline: [{ $project: { name_en: 1, name_ar: 1, "images.url": 1 } }], as: "product" } },
    { $set: { catalogPresent: { $gt: [{ $size: "$product" }, 0] } } },
    { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
    { $project: { _id: 1, unitsSold: 1, recordedItemValue: 1, catalogPresent: 1,
      name_en: { $ifNull: ["$product.name_en", null] }, name_ar: { $ifNull: ["$product.name_ar", null] },
      imageUrl: { $ifNull: [{ $arrayElemAt: ["$product.images.url", 0] }, null] } } },
  ];
}

export async function getHighestProductsService(query, now = new Date()) {
  const { period, warehouse, metric, limit } = productRankingQuery(query, now);
  try {
    const rows = await OrderModel.aggregate(highestProductsPipeline(period, { warehouse, metric, limit })).option({ maxTimeMS: 5000 });
    const results = rows.map((row) => ({ ...productSalesRow(row), catalogPresent: row.catalogPresent }));
    return { definition: { id: "recorded_product_sales_v1", timeField: "order.createdAt",
      excludedStatuses: [orderStatusEnum.CANCELLED, orderStatusEnum.RETURNED], includesUnfinishedOrders: true,
      quantity: "fulfillmentQuantity_or_legacy_quantity", itemValue: "quantity_times_saved_itemPrice",
      eligibility: "recorded_sales", zeroSalesIncluded: false, stockAvailabilityAdjusted: false,
      currency: null, currencyTreatment: "not_partitioned_or_converted", tieBreak: "product_id_ascending" },
      timezone: ANALYTICS_TIMEZONE, generatedAt: now.toISOString(), period, metric,
      filters: { warehouse: query.warehouse ?? null }, limit, results };
  } catch { throw new ApiError("Highest-selling products are currently unavailable", 503); }
}
