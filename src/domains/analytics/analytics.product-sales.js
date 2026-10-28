import mongoose from "mongoose";
import { ApiError } from "../../shared/utils/ApiError.js";
import { orderStatusEnum } from "../../shared/constants/enums.js";
import { buildFinalFulfilledLineMatchExpression, buildFinalFulfilledLineTotalExpression,
  buildFinalFulfillmentQuantityExpression } from "../order/order.fulfillment.js";
import { cairoMonthPeriod } from "./analytics.period.js";

export function productRankingQuery(query, now) {
  const invalid = () => { throw new ApiError("Use valid month, metric, optional warehouse and limit fields", 400); };
  if (!query || typeof query !== "object" || Array.isArray(query) ||
      Object.keys(query).some((key) => !["month", "metric", "warehouse", "limit"].includes(key)) ||
      !["units", "item_value"].includes(query.metric) ||
      (query.warehouse !== undefined && (typeof query.warehouse !== "string" || !/^[a-f\d]{24}$/i.test(query.warehouse))) ||
      (query.limit !== undefined && (typeof query.limit !== "string" || !/^(?:[1-9]|[1-4]\d|50)$/.test(query.limit)))) invalid();
  let period;
  try { period = cairoMonthPeriod(query.month, now); } catch { invalid(); }
  return { period, metric: query.metric, warehouse: query.warehouse ? new mongoose.Types.ObjectId(query.warehouse) : null,
    limit: query.limit === undefined ? 5 : Number(query.limit) };
}

export function recordedProductSalesStages(match) {
  return [
    { $match: { ...match, status: { $nin: [orderStatusEnum.CANCELLED, orderStatusEnum.RETURNED] } } },
    { $unwind: "$items" }, { $match: buildFinalFulfilledLineMatchExpression() },
    { $group: { _id: "$items.product", totalIncome: { $sum: buildFinalFulfilledLineTotalExpression() },
      totalQuantitySold: { $sum: buildFinalFulfillmentQuantityExpression() } } },
  ];
}

export function productSalesStages(period, warehouse) {
  return [
    ...recordedProductSalesStages({ createdAt: { $gte: new Date(period.start), $lt: new Date(period.observedThroughExclusive) },
      ...(warehouse ? { warehouse } : {}) }),
    { $project: { _id: 1, unitsSold: "$totalQuantitySold", recordedItemValue: "$totalIncome" } },
  ];
}

export function productSalesRow(row) {
  if (!Number.isFinite(row.unitsSold) || row.unitsSold < 0 || !Number.isFinite(row.recordedItemValue) || row.recordedItemValue < 0) throw new Error("Invalid aggregate");
  return { productId: String(row._id), name_en: row.name_en, name_ar: row.name_ar, imageUrl: row.imageUrl,
    unitsSold: row.unitsSold, recordedItemValue: row.recordedItemValue };
}
