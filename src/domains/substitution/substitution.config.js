import { parseBoolean } from "../../shared/utils/env.js";

export const SUBSTITUTION_EXPIRY_PRESETS = Object.freeze([15, 30, 60, 120]);
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

export function getOrderSubstitutionFeatureConfig() {
  return Object.freeze({
    enabled: substitutionsEnabled,
    warehouseAllowlist: Object.freeze([...warehouseAllowlist]),
    expiryPresets: SUBSTITUTION_EXPIRY_PRESETS,
    defaultExpiryMinutes: DEFAULT_SUBSTITUTION_EXPIRY_MINUTES,
  });
}
