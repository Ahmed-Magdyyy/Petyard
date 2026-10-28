import { body, checkExact, query } from "express-validator";
import { assistantValidatorMiddleware } from "../shared/assistant.validators.js";

export const bookingLocationValidator = () => body("location").isObject({ strict: true }).bail().custom((value) => {
    const keys = Object.keys(value), gps = keys.includes("lat") || keys.includes("lng");
    if (keys.some((key) => !["lat", "lng", "governorateCode", "areaCode"].includes(key))) return false;
    if (gps) return keys.length === 2 && typeof value.lat === "number" && Number.isFinite(value.lat) && value.lat >= 22 && value.lat <= 31.7 &&
      typeof value.lng === "number" && Number.isFinite(value.lng) && value.lng >= 24.7 && value.lng <= 36.9;
    return typeof value.governorateCode === "string" && /^[a-z_]{1,80}$/.test(value.governorateCode) &&
      (value.areaCode === undefined || typeof value.areaCode === "string" && /^[a-z0-9_]{1,80}$/.test(value.areaCode));
  });
const location = () => [
  bookingLocationValidator(),
  body("language").isString().bail().isIn(["en", "ar"]),
];
const booking = () => [body("booking").isObject({ strict: true }).bail().custom((value) => {
  const allowed = ["locationId", "petId", "date", "hour24", "serviceType", "serviceOptionKey", "services", "ownerName", "ownerPhone", "petType", "petName", "age", "gender", "comment"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
  if (typeof value.locationId !== "string" || !/^[a-f\d]{24}$/i.test(value.locationId) ||
    value.petId != null && (typeof value.petId !== "string" || !/^[a-f\d]{24}$/i.test(value.petId))) return false;
  if (typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) || !Number.isInteger(value.hour24) || value.hour24 < 0 || value.hour24 > 23) return false;
  const services = value.services ?? [{ serviceType: value.serviceType, serviceOptionKey: value.serviceOptionKey }];
  if (value.services !== undefined && (value.serviceType !== undefined || value.serviceOptionKey !== undefined)) return false;
  if (!Array.isArray(services) || services.length < 1 || services.length > 12) return false;
  if (services.some((item) => !item || item.constructor !== Object || Object.keys(item).some((key) => !["serviceType", "serviceOptionKey"].includes(key)) ||
    !["GROOMING", "SHOWERING", "CLINIC"].includes(item.serviceType) || item.serviceOptionKey != null && (typeof item.serviceOptionKey !== "string" || item.serviceOptionKey.length > 128))) return false;
  for (const key of ["ownerName", "ownerPhone", "petType", "petName", "gender", "comment"]) if (value[key] != null && (typeof value[key] !== "string" || value[key].length > 2048)) return false;
  return value.age == null || typeof value.age === "number" && Number.isFinite(value.age) && value.age >= 0;
})];
const exact = (chains) => [checkExact([...chains, query().custom((value) => Object.keys(value).length === 0)], { locations: ["body", "query"] }), assistantValidatorMiddleware];
export const bookingOptionsValidator = exact(location());
export const bookingPreviewValidator = exact([...location(), ...booking()]);
