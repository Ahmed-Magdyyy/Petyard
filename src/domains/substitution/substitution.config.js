import { parseBoolean } from "../../shared/utils/env.js";

export const SUBSTITUTION_EXPIRY_PRESETS = Object.freeze([5, 10, 15, 30, 60, 120]);
export const DEFAULT_SUBSTITUTION_EXPIRY_MINUTES = 30;

const substitutionsEnabled = parseBoolean(
  process.env.ORDER_SUBSTITUTIONS_ENABLED,
  false,
);

const warehouseAllowlist = new Set(
  String(process.env.ORDER_SUBSTITUTION_WAREHOUSE_ALLOWLIST || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

const canaryOrderAllowlist = new Set(
  String(process.env.ORDER_SUBSTITUTION_CANARY_ORDER_ALLOWLIST || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-f0-9]{24}$/.test(value)),
);

export function getSubstitutionExpiryMinutes(value) {
  const parsed = Number(value);
  return SUBSTITUTION_EXPIRY_PRESETS.includes(parsed)
    ? parsed
    : DEFAULT_SUBSTITUTION_EXPIRY_MINUTES;
}

export function isOrderSubstitutionEnabledForWarehouse(warehouseId) {
  if (!substitutionsEnabled) return false;
  if (warehouseAllowlist.size === 0) return true;
  return warehouseAllowlist.has(String(warehouseId || ""));
}

export function isOrderSubstitutionEnabledForOrder(order) {
  const orderId = String(order?._id || "").toLowerCase();
  if (canaryOrderAllowlist.has(orderId)) return true;
  return isOrderSubstitutionEnabledForWarehouse(order?.warehouse);
}

export function getOrderSubstitutionFeatureConfig() {
  return Object.freeze({
    enabled: substitutionsEnabled,
    warehouseAllowlist: Object.freeze([...warehouseAllowlist]),
    canaryOrderAllowlist: Object.freeze([...canaryOrderAllowlist]),
    expiryPresets: SUBSTITUTION_EXPIRY_PRESETS,
    defaultExpiryMinutes: DEFAULT_SUBSTITUTION_EXPIRY_MINUTES,
  });
}
