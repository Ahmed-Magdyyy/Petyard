import { pickLocalizedField } from "../../../shared/utils/i18n.js";
import { reject } from "../shared/assistant.errors.js";

export function bookingOptionsFromRows(definitions, locations, language) {
  if (definitions.length > 3 || locations.length > 50) reject("booking_catalog_unavailable", 503);
  const services = definitions.map((item) => {
    if (!Array.isArray(item.options) || item.options.length > 100) reject("booking_catalog_unavailable", 503);
    const keys = new Set();
    return { type: item.type, name: pickLocalizedField(item, "name", language), options: item.options.map((option) => {
      if (typeof option.key !== "string" || !option.key.trim() || option.key !== option.key.trim() || option.key.length > 128 || keys.has(option.key) ||
        !Number.isFinite(option.price) || option.price < 0) reject("booking_catalog_unavailable", 503);
      keys.add(option.key);
      return { key: option.key, name: pickLocalizedField(option, "name", language), price: option.price, currency: "EGP" };
    }) };
  });
  return { eligible: true, reason: null, governorateCode: "alexandria", services, locations: locations.map((item) => ({
    id: String(item._id), name: pickLocalizedField(item, "name", language), city: item.city, slug: item.slug, timezone: item.timezone,
  })), estimateOnly: true };
}
