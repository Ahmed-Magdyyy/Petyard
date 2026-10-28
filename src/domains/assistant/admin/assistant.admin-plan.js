import { cairoMonthPeriod } from "../../analytics/analytics.period.js";
import { fields } from "../shared/assistant.validation.js";
import { reject } from "../shared/assistant.errors.js";

export const ADMIN_PLAN_VERSION = "petyard-admin-plan-v1";
export const ADMIN_REPORT_LIMIT = 3;
export const adminPlanValues = Object.freeze({
  tools: Object.freeze(["compare_order_months", "lowest_selling_products", "highest_selling_products"]),
  outcomes: Object.freeze(["reports", "clarify", "unsupported", "identity"]),
  languages: Object.freeze(["ar", "en", "arabizi"]),
  clarifications: Object.freeze(["none", "period", "baseline_period", "metric", "warehouse", "request"]),
});
const { tools, outcomes, languages, clarifications } = adminPlanValues;
const argumentKeys = ["month", "compareTo", "metric", "warehouse", "limit"];

// One planning response; report execution and explanation belong to the backend.
export const adminPlanSchema = {
  type: "object", additionalProperties: false, required: ["outcome", "language", "clarification", "reports"],
  properties: {
    outcome: { type: "string", enum: outcomes }, language: { type: "string", enum: languages },
    clarification: { type: "string", enum: clarifications },
    reports: { type: "array", maxItems: ADMIN_REPORT_LIMIT, items: {
      type: "object", additionalProperties: false, required: ["tool", "arguments"], properties: {
        tool: { type: "string", enum: tools }, arguments: {
          type: "object", additionalProperties: false, required: argumentKeys, properties: {
            month: { type: "string" }, compareTo: { type: ["string", "null"] },
            metric: { type: ["string", "null"], enum: ["units", "item_value", null] },
            warehouse: { type: ["string", "null"] }, limit: { type: ["integer", "null"], minimum: 1, maximum: 50 },
          },
        },
      },
    } },
  },
};

function exact(value, keys) {
  fields(value, keys);
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) reject("invalid_admin_plan", 503);
}

export function validateAdminPlan(plan, { maxChars, allowedWarehouseIds = [] } = {}, now = new Date()) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 16000 || !Array.isArray(allowedWarehouseIds) ||
      allowedWarehouseIds.some((id) => typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id))) reject("admin_plan_configuration_required", 503);
  const warehouseIds = new Set(allowedWarehouseIds.map((id) => id.toLowerCase()));
  try {
    exact(plan, ["outcome", "language", "clarification", "reports"]);
    if (!outcomes.includes(plan.outcome) || !languages.includes(plan.language) || !clarifications.includes(plan.clarification) ||
        !Array.isArray(plan.reports) || plan.reports.length > ADMIN_REPORT_LIMIT || JSON.stringify(plan).length > maxChars ||
        (plan.outcome === "reports" ? plan.reports.length === 0 : plan.reports.length !== 0) ||
        (plan.outcome === "clarify" ? plan.clarification === "none" : plan.clarification !== "none")) reject("invalid_admin_plan", 503);
    const seen = new Set();
    const reports = plan.reports.map((report) => {
      exact(report, ["tool", "arguments"]);
      if (!tools.includes(report.tool)) reject("invalid_admin_plan", 503);
      const value = report.arguments; exact(value, argumentKeys);
      cairoMonthPeriod(value.month, now);
      const args = { month: value.month };
      if (report.tool === "compare_order_months") {
        cairoMonthPeriod(value.compareTo, now);
        if (value.metric !== null || value.limit !== null) reject("invalid_admin_plan", 503);
        args.compareTo = value.compareTo;
      } else {
        if (value.compareTo !== null || !["units", "item_value"].includes(value.metric) ||
            (value.limit !== null && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 50))) reject("invalid_admin_plan", 503);
        args.metric = value.metric; args.limit = value.limit ?? 5;
      }
      if (value.warehouse !== null) {
        if (typeof value.warehouse !== "string" || !warehouseIds.has(value.warehouse.toLowerCase())) reject("invalid_admin_plan", 503);
        args.warehouse = value.warehouse.toLowerCase();
      }
      const key = JSON.stringify([report.tool, args]);
      if (seen.has(key)) reject("invalid_admin_plan", 503);
      seen.add(key);
      return { tool: report.tool, arguments: args };
    });
    return { outcome: plan.outcome, language: plan.language, clarification: plan.clarification, reports };
  } catch { reject("invalid_admin_plan", 503); }
}
