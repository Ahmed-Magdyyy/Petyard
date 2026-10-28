import { businessReportLimit } from "./assistant.admin-policy.js";
import { ADMIN_REPORT_LIMIT } from "./assistant.admin-plan.js";
import { reject } from "../shared/assistant.errors.js";

const periodKeys = ["month", "start", "endExclusive", "observedThroughExclusive", "partial"];
const metricKeys = ["totalSales", "totalOrders", "avgOrderValue"];
const definitionKeys = ["id", "timeField", "amountField", "excludedStatuses", "includesUnfinishedOrders", "includesShipping", "refunds",
  "currency", "currencyTreatment", "quantity", "itemValue", "eligibility", "zeroSalesIncluded", "warehouseEligibility", "stockAvailabilityAdjusted", "tieBreak"];
const invalid = () => reject("invalid_report_snapshot", 503);
const pick = (value, keys) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
};
function period(value, month) {
  if (value?.month !== month || typeof value.partial !== "boolean" ||
      ["start", "endExclusive", "observedThroughExclusive"].some((key) => typeof value[key] !== "string" || !Number.isFinite(Date.parse(value[key])))) invalid();
  return pick(value, periodKeys);
}
function finite(value, nonnegative = true) {
  if (!Number.isFinite(value) || (nonnegative && value < 0)) invalid();
  return value;
}

// Snapshot only the existing analytics DTO fields; never persist arbitrary model or database documents.
function reportData(invocation, value) {
  const { tool, arguments: args } = invocation;
  if (value?.timezone !== "Africa/Cairo" || typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt)) ||
      value.filters?.warehouse !== (args.warehouse ?? null)) invalid();
  const data = { definition: pick(value.definition, definitionKeys), timezone: value.timezone, generatedAt: value.generatedAt,
    filters: { warehouse: value.filters.warehouse } };
  if (data.definition.currency !== null || data.definition.currencyTreatment !== "not_partitioned_or_converted" ||
      Object.entries(data.definition).some(([key, item]) => key === "excludedStatuses"
        ? !Array.isArray(item) || item.length !== 2 || item.some((status) => typeof status !== "string")
        : item !== null && !["string", "boolean"].includes(typeof item))) invalid();
  if (tool === "compare_order_months") {
    if (data.definition.id !== "dashboard_order_totals_v1" || value.consistency !== "live_independent_reads") invalid();
    data.consistency = value.consistency;
    data.periods = Object.fromEntries([["current", args.month], ["baseline", args.compareTo]].map(([key, month]) => {
      const source = value.periods?.[key];
      return [key, { ...period(source, month), metrics: Object.fromEntries(metricKeys.map((metric) => [metric, finite(source.metrics?.[metric])])) }];
    }));
    data.changes = Object.fromEntries(metricKeys.map((key) => {
      const change = value.changes?.[key];
      if (!change || ![null, "zero_baseline"].includes(change.percentageUnavailableReason) ||
          (change.percentage === null) !== (change.percentageUnavailableReason === "zero_baseline")) invalid();
      return [key, { absolute: finite(change.absolute, false), percentage: change.percentage === null ? null : finite(change.percentage, false),
        percentageUnavailableReason: change.percentageUnavailableReason }];
    }));
  } else {
    const highest = tool === "highest_selling_products";
    if (data.definition.id !== (highest ? "recorded_product_sales_v1" : "active_existing_product_sales_v1") ||
        value.metric !== args.metric || value.limit !== args.limit || !Array.isArray(value.results) || value.results.length > args.limit) invalid();
    Object.assign(data, { period: period(value.period, args.month), metric: value.metric, limit: value.limit,
      results: value.results.map((row) => {
        if (typeof row.productId !== "string" || !/^[a-f\d]{24}$/i.test(row.productId) ||
            ["name_en", "name_ar", "imageUrl"].some((key) => row[key] !== null && typeof row[key] !== "string") ||
            (highest && typeof row.catalogPresent !== "boolean")) invalid();
        return { ...pick(row, ["productId", "name_en", "name_ar", "imageUrl", ...(highest ? ["catalogPresent"] : [])]),
          unitsSold: finite(row.unitsSold), recordedItemValue: finite(row.recordedItemValue) };
      }) });
  }
  return data;
}

export function unavailableCard(invocation, index, code = "analytics_unavailable", now = new Date()) {
  return { id: `report-${index + 1}`, tool: invocation.tool, arguments: { ...invocation.arguments }, status: "unavailable", code,
    generatedAt: now.toISOString(), dataJson: null };
}

export function snapshotCard(invocation, index, result, config, reportCount) {
  const data = reportData(invocation, result?.data);
  if (result.tool !== invocation.tool) invalid();
  const card = { ...unavailableCard(invocation, index), status: "success", code: null, generatedAt: data.generatedAt, dataJson: JSON.stringify(data) };
  // Leave room for every requested card, including the JSON array's commas and brackets.
  const maxBytes = Math.floor((businessReportLimit(config) - reportCount - 1) / reportCount);
  return Buffer.byteLength(JSON.stringify(card)) <= maxBytes ? card : unavailableCard(invocation, index, "report_snapshot_too_large");
}

export function assertCardBounds(cards, config) {
  if (cards.length > ADMIN_REPORT_LIMIT || Buffer.byteLength(JSON.stringify(cards)) > businessReportLimit(config)) reject("report_snapshot_too_large", 503);
}

export const reportHeader = (card) => ({ id: card.id, tool: card.tool, status: card.status,
  generatedAt: new Date(card.generatedAt).toISOString(), code: card.code ?? null });
export function reportCardDto(card) {
  const header = reportHeader(card);
  const dto = { ...header, arguments: { ...card.arguments } };
  if (card.status !== "success") return dto;
  try {
    if (typeof card.dataJson !== "string" || Buffer.byteLength(card.dataJson) > 262144) invalid();
    return { ...dto, data: reportData(dto, JSON.parse(card.dataJson)) };
  } catch { return { ...dto, status: "unavailable", code: "stored_report_unavailable" }; }
}
