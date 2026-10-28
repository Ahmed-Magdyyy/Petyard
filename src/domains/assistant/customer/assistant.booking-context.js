import { reject } from "../shared/assistant.errors.js";

// Raw app selection only; geographic eligibility always comes from the existing backend resolver.
export function bookingContextInput(value) {
  if (typeof value?.toObject === "function") value = value.toObject();
  if (!value || value.constructor !== Object || Object.keys(value).some(key => key !== "location")) reject("invalid_request");
  if (value.location === null) return { location: null };
  const location = value.location;
  if (!location || location.constructor !== Object || Object.keys(location).some(key => !["lat", "lng", "governorateCode", "areaCode"].includes(key))) reject("invalid_request");
  const gps = location.lat !== undefined || location.lng !== undefined;
  if (gps ? Object.keys(location).length !== 2 || !Number.isFinite(location.lat) || !Number.isFinite(location.lng) ||
    location.lat < 22 || location.lat > 31.7 || location.lng < 24.7 || location.lng > 36.9
    : typeof location.governorateCode !== "string" || !/^[a-z_]{1,80}$/.test(location.governorateCode) ||
      location.areaCode !== undefined && (typeof location.areaCode !== "string" || !/^[a-z0-9_]{1,80}$/.test(location.areaCode))) reject("invalid_request");
  // Stable field order makes semantically identical location retries identical.
  return { location: gps ? { lat: location.lat, lng: location.lng } : { governorateCode: location.governorateCode,
    ...(location.areaCode === undefined ? {} : { areaCode: location.areaCode }) } };
}
