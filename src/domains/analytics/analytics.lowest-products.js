import { ApiError } from "../../shared/utils/ApiError.js";
import { orderStatusEnum, productTypeEnum } from "../../shared/constants/enums.js";
import { OrderModel } from "../order/order.model.js";
import { ProductModel } from "../product/product.model.js";
import { ANALYTICS_TIMEZONE } from "./analytics.period.js";
import { productRankingQuery, productSalesStages, productSalesRow } from "./analytics.product-sales.js";

export function lowestProductsPipeline(period, { warehouse, metric, limit }) {
  const eligible = { isActive: true, createdAt: { $type: "date", $lt: new Date(period.start) } };
  if (warehouse) eligible.$or = [
    { type: productTypeEnum.SIMPLE, "warehouseStocks.warehouse": warehouse },
    { type: productTypeEnum.VARIANT, "variants.warehouseStocks.warehouse": warehouse },
  ];
  return [
    ...productSalesStages(period, warehouse),
    // Union eligible zero rows, then group once; avoid rescanning a month's orders separately for every catalog product.
    { $unionWith: { coll: ProductModel.collection.name, pipeline: [ { $match: eligible },
      { $project: { _id: 1, eligible: { $literal: 1 }, unitsSold: { $literal: 0 }, recordedItemValue: { $literal: 0 } } } ] } },
    { $group: { _id: "$_id", eligible: { $max: "$eligible" }, unitsSold: { $sum: "$unitsSold" },
      recordedItemValue: { $sum: "$recordedItemValue" } } },
    { $match: { eligible: 1 } },
    { $sort: { [metric === "units" ? "unitsSold" : "recordedItemValue"]: 1, _id: 1 } }, { $limit: limit },
    { $lookup: { from: ProductModel.collection.name, localField: "_id", foreignField: "_id",
      pipeline: [{ $project: { name_en: 1, name_ar: 1, "images.url": 1 } }], as: "product" } },
    { $unwind: "$product" },
    { $project: { _id: 1, unitsSold: 1, recordedItemValue: 1,
      name_en: { $ifNull: ["$product.name_en", null] }, name_ar: { $ifNull: ["$product.name_ar", null] },
      imageUrl: { $ifNull: [{ $arrayElemAt: ["$product.images.url", 0] }, null] } } },
  ];
}

export async function getLowestProductsService(query, now = new Date()) {
  const { period, warehouse, limit } = productRankingQuery(query, now);
  try {
    const rows = await OrderModel.aggregate(lowestProductsPipeline(period, { warehouse, metric: query.metric, limit })).option({ maxTimeMS: 5000 });
    const results = rows.map(productSalesRow);
    return { definition: { id: "active_existing_product_sales_v1", timeField: "order.createdAt",
      excludedStatuses: [orderStatusEnum.CANCELLED, orderStatusEnum.RETURNED], includesUnfinishedOrders: true,
      quantity: "fulfillmentQuantity_or_legacy_quantity", itemValue: "quantity_times_saved_itemPrice",
      eligibility: "currently_active_created_before_period", zeroSalesIncluded: true,
      warehouseEligibility: "currently_assigned", stockAvailabilityAdjusted: false,
      currency: null, currencyTreatment: "not_partitioned_or_converted", tieBreak: "product_id_ascending" },
      timezone: ANALYTICS_TIMEZONE, generatedAt: now.toISOString(), period, metric: query.metric,
      filters: { warehouse: query.warehouse ?? null }, limit, results };
  } catch { throw new ApiError("Lowest-selling products are currently unavailable", 503); }
}
