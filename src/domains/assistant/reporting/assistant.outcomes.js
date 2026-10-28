import { AssistantCartReceipt } from "../shared/assistant.cart-receipt.model.js";
import { AssistantCartProposal } from "../shared/assistant.cart-proposal.model.js";
import { AssistantBookingReceipt } from "../shared/assistant.booking-receipt.model.js";
import { OrderModel } from "../../order/order.model.js";
import { orderStatusEnum, roles } from "../../../shared/constants/enums.js";
import { requireAnalyticsActor } from "../admin/assistant.admin-access.js";
import { requireEnabled } from "../shared/assistant.config.js";
import { objectId } from "../shared/assistant.validation.js";
import { reject } from "../shared/assistant.errors.js";
import { usageReportPeriod } from "./assistant.reporting.js";

const maxTimeMS = 5000;
const count = value => {
  if (!Number.isSafeInteger(value) || value < 0) reject("outcome_report_unavailable", 503);
  return value;
};
const statuses = Object.values(orderStatusEnum);

export async function getOutcomeReport(actorValue, query, config, now = new Date()) {
  requireEnabled(config);
  const actor = objectId(String(actorValue));
  const authorize = async () => {
    const { user } = await requireAnalyticsActor(actor, { allowBlocked: true });
    if (user.role !== roles.SUPER_ADMIN) reject("access_denied", 403);
  };
  await authorize();
  const period = usageReportPeriod(query, config.timezone, now);
  const window = { $gte: period.start.toJSDate(), $lt: period.observedThrough.toJSDate() };
  const required = [AssistantCartReceipt, AssistantCartProposal, AssistantBookingReceipt, OrderModel].map(model => model.collection.name);
  const stores = await OrderModel.db.db.listCollections({}, { nameOnly: true, maxTimeMS }).toArray();
  if (required.some(name => stores.filter(row => row.name === name && row.type === "collection").length !== 1)) reject("outcome_report_unavailable", 503);
  const [cart, bookings, bundles] = await Promise.all([
    AssistantCartReceipt.aggregate([
      { $match: { recordedAt: window } },
      // Public assistant preparations retain an immutable source ID; old unbound/internal reviews do not qualify.
      { $lookup: { from: AssistantCartProposal.collection.name, let: { id: "$_id", owner: "$owner" }, pipeline: [
        { $match: { $expr: { $and: [{ $eq: ["$_id", "$$id"] }, { $eq: ["$owner", "$$owner"] }] },
          inputJson: { $regex: '"sourceMessageId":"[a-f0-9]{24}"' } } }, { $project: { _id: 1 } },
      ], as: "source" } }, { $match: { "source.0": { $exists: true } } }, { $count: "count" },
    ]).option({ maxTimeMS }),
    AssistantBookingReceipt.countDocuments({ recordedAt: window }).maxTimeMS(maxTimeMS),
    OrderModel.aggregate([
      { $match: { createdAt: window, "bundleGroups.0": { $exists: true } } },
      { $facet: {
        orders: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
        units: [{ $unwind: "$bundleGroups" }, { $project: { status: 1, quantity: "$bundleGroups.quantity",
          valid: { $cond: [{ $isNumber: "$bundleGroups.quantity" }, { $and: [
            { $gt: ["$bundleGroups.quantity", 0] }, { $lte: ["$bundleGroups.quantity", Number.MAX_SAFE_INTEGER] },
            { $eq: ["$bundleGroups.quantity", { $trunc: "$bundleGroups.quantity" }] },
          ] }, false] } } }, { $group: { _id: "$status", count: { $sum: { $cond: ["$valid", "$quantity", 0] } },
            invalid: { $sum: { $cond: ["$valid", 0, 1] } } } }],
      } },
    ]).option({ maxTimeMS }),
  ]);
  const grouped = rows => {
    if (rows.some(row => !statuses.includes(row._id) || (row.invalid ?? 0) !== 0)) reject("outcome_report_unavailable", 503);
    return Object.fromEntries(statuses.map(status => [status, count(rows.find(row => row._id === status)?.count ?? 0)]));
  };
  const result = { month: period.month, timezone: config.timezone, generatedAt: now.toISOString(),
    period: { start: period.start.toUTC().toISO(), endExclusive: period.end.toUTC().toISO(), observedThrough: period.observedThrough.toUTC().toISO() },
    confirmedCartActions: count(cart[0]?.count ?? 0), confirmedBookingActions: count(bookings),
    bundleSales: { ordersByCurrentStatus: grouped(bundles[0]?.orders ?? []), unitsByCurrentStatus: grouped(bundles[0]?.units ?? []) },
    coverage: { source: "retained_durable_receipts_and_orders", completeness: "not_guaranteed", consistency: "independent_reads",
      cartDefinition: "source_bound_committed_assistant_additions_not_purchases",
      bookingDefinition: "confirmed_booking_actions_not_service_reservation_count_or_current_booking_status",
      bundleDefinition: "orders_created_in_period_grouped_by_current_status_whole_bundle_quantities_not_components",
      attributedPurchases: "unavailable", impressions: "unavailable", clicks: "unavailable" } };
  await authorize();
  requireEnabled(config);
  return result;
}
