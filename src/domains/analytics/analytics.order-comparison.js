import { cairoMonthPeriod, ANALYTICS_TIMEZONE as timezone } from "./analytics.period.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { orderStatusEnum } from "../../shared/constants/enums.js";
import { getOrdersOverviewService } from "./analytics.service.js";

const metricKeys = ["totalSales", "totalOrders", "avgOrderValue"];
const round = (value) => Math.round(value * 100) / 100;
const invalid = () => { throw new ApiError("Use valid month, compareTo and optional warehouse fields", 400); };

function period(month, now) {
  try { return cairoMonthPeriod(month, now); } catch { invalid(); }
}

export async function getOrderComparisonService(query, now = new Date()) {
  if (!query || Array.isArray(query) || typeof query !== "object" ||
      Object.keys(query).some((key) => !["month", "compareTo", "warehouse"].includes(key)) ||
      (query.warehouse !== undefined && (typeof query.warehouse !== "string" || !/^[a-f\d]{24}$/i.test(query.warehouse)))) invalid();
  const periods = { current: period(query.month, now), baseline: period(query.compareTo, now) };
  try {
    await Promise.all(Object.values(periods).map(async (value) => {
      // The overview has an inclusive end; pass explicit UTC instants, never host-local date strings.
      const overview = await getOrdersOverviewService({ from: value.start,
        to: new Date(Date.parse(value.observedThroughExclusive) - 1).toISOString(), warehouse: query.warehouse }, { maxTimeMS: 5000 });
      value.metrics = Object.fromEntries(metricKeys.map((key) => {
        if (!Number.isFinite(overview[key]) || overview[key] < 0) throw new Error("Invalid aggregate");
        return [key, overview[key]];
      }));
    }));
    const changes = Object.fromEntries(metricKeys.map((key) => {
      const current = periods.current.metrics[key]; const baseline = periods.baseline.metrics[key];
      const difference = current - baseline;
      const absolute = key === "totalOrders" ? difference : round(difference);
      const percentage = baseline === 0 ? null : round(difference / baseline * 100);
      if (!Number.isFinite(absolute) || (percentage !== null && !Number.isFinite(percentage))) throw new Error("Invalid change");
      return [key, { absolute, percentage, percentageUnavailableReason: baseline === 0 ? "zero_baseline" : null }];
    }));
    return { definition: { id: "dashboard_order_totals_v1", timeField: "createdAt", amountField: "total",
      excludedStatuses: [orderStatusEnum.CANCELLED, orderStatusEnum.RETURNED], includesUnfinishedOrders: true,
      includesShipping: true, refunds: "not_separately_subtracted", currency: null, currencyTreatment: "not_partitioned_or_converted" },
      timezone, generatedAt: now.toISOString(), filters: { warehouse: query.warehouse ?? null }, periods, changes,
      consistency: "live_independent_reads" };
  } catch {
    throw new ApiError("Order comparison is currently unavailable", 503);
  }
}
