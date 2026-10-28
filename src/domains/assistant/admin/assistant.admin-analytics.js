import { ApiError } from "../../../shared/utils/ApiError.js";
import { getOrderComparisonService } from "../../analytics/analytics.order-comparison.js";
import { getLowestProductsService } from "../../analytics/analytics.lowest-products.js";
import { getHighestProductsService } from "../../analytics/analytics.highest-products.js";
import { requireAnalyticsActor } from "./assistant.admin-access.js";
import { loadAssistantConfig, requireEnabled } from "../shared/assistant.config.js";
import { AssistantError, reject } from "../shared/assistant.errors.js";
import { fields, objectId } from "../shared/assistant.validation.js";

const reports = Object.freeze({ compare_order_months: getOrderComparisonService,
  lowest_selling_products: getLowestProductsService, highest_selling_products: getHighestProductsService });

// Internal only: actor comes from authenticated backend context, never model arguments.
export async function executeAdminAnalyticsTool(actorValue, invocation, { getConfig = loadAssistantConfig } = {}) {
  try {
    requireEnabled(getConfig());
    const actor = objectId(String(actorValue));
    fields(invocation, ["tool", "arguments"]);
    if (typeof invocation.tool !== "string") reject("invalid_request");
    const tool = invocation.tool;
    if (!Object.hasOwn(reports, tool)) reject("unsupported_analytics_tool");
    if (!invocation.arguments || typeof invocation.arguments !== "object" || Array.isArray(invocation.arguments)) reject("invalid_request");
    const args = { ...invocation.arguments };
    if (Object.hasOwn(args, "limit")) {
      if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 50) reject("analytics_arguments_invalid");
      args.limit = String(args.limit);
    }
    await requireAnalyticsActor(actor);
    const data = await reports[tool](args);
    requireEnabled(getConfig());
    await requireAnalyticsActor(actor);
    return { tool, data };
  } catch (error) {
    if (error instanceof AssistantError) throw error;
    if (error instanceof ApiError && error.statusCode === 400) reject("analytics_arguments_invalid");
    reject("analytics_unavailable", 503);
  }
}
