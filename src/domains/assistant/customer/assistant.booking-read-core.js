import { UserModel } from "../../user/user.model.js";
import { accountStatus } from "../../../shared/constants/enums.js";
import { resolveLocationByCoordinatesService } from "../../location/location.service.js";
import { AssistantAccount } from "../shared/assistant.models.js";
import { requireBookingReads } from "../shared/assistant.config.js";
import { fields, objectId } from "../shared/assistant.validation.js";
import { AssistantError, reject } from "../shared/assistant.errors.js";
import { assertAccess, transaction } from "../shared/assistant.store.js";

async function access(owner, config, session = null) {
  requireBookingReads(config);
  const user = await UserModel.findById(owner).select("active phoneVerified deletedAt account_status").maxTimeMS(5000).session(session).lean();
  if (!user || !user.active || user.deletedAt) reject("authentication_required", 401);
  if (!user.phoneVerified || [accountStatus.BANNED, accountStatus.DELETED].includes(user.account_status)) reject("access_denied", 403);
  const account = await AssistantAccount.findOne({ owner }).maxTimeMS(5000).session(session).lean();
  if (!account) reject("assistant_account_not_found", 404);
  assertAccess(account, config); return account;
}
async function admit(owner, config) {
  await transaction(async (session) => {
    const account = await access(owner, config, session), now = new Date();
    if (!Number.isSafeInteger(config.rateMax) || config.rateMax < 1 || !Number.isSafeInteger(config.rateWindowSeconds) || config.rateWindowSeconds < 1) reject("assistant_configuration_required", 503);
    const end = account.bookingReadRateStart ? new Date(new Date(account.bookingReadRateStart).getTime() + config.rateWindowSeconds * 1000) : now;
    const count = end <= now ? 0 : account.bookingReadRateCount ?? 0;
    if (!Number.isFinite(end.getTime()) || !Number.isSafeInteger(count) || count < 0) reject("booking_read_rate_unavailable", 503);
    if (count >= config.rateMax) reject("booking_request_rate_limit", 429, end);
    const updated = await AssistantAccount.updateOne({ _id: account._id, owner }, { $set: {
      bookingReadRateStart: end <= now ? now : account.bookingReadRateStart, bookingReadRateCount: count + 1,
    } }, { session });
    if (updated.matchedCount !== 1) reject("context_changed", 409);
  });
}
function input(body, preview) {
  fields(body, preview ? ["location", "language", "booking"] : ["location", "language"]);
  fields(body.location, ["lat", "lng", "governorateCode", "areaCode"]);
  if (!["en", "ar"].includes(body.language)) reject("invalid_request");
  const loc = body.location, gps = loc.lat !== undefined || loc.lng !== undefined;
  if (gps ? Object.keys(loc).length !== 2 || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng) || loc.lat < 22 || loc.lat > 31.7 || loc.lng < 24.7 || loc.lng > 36.9
    : typeof loc.governorateCode !== "string" || !/^[a-z_]{1,80}$/.test(loc.governorateCode) ||
      loc.areaCode !== undefined && (typeof loc.areaCode !== "string" || !/^[a-z0-9_]{1,80}$/.test(loc.areaCode))) reject("invalid_request");
  if (preview && (!body.booking || body.booking.constructor !== Object)) reject("invalid_request");
  return { location: { ...loc }, language: body.language, booking: body.booking };
}
const resultLimit = 65536;
async function timedRead(config, work) {
  const timeoutMs = config.timeoutMs; let timer;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) reject("assistant_configuration_required", 503);
  try {
    return await Promise.race([work(), new Promise((_resolve, rejectTimeout) => {
      timer = setTimeout(() => rejectTimeout(new AssistantError("booking_read_timeout", 503)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
// Resolve only validated current app input; callers cannot provide trusted resolver evidence.
export const bookingLocationInput = location => input({ location, language: "en" }, false).location;
export async function resolveAssistantBookingArea(ownerValue, location, config) {
  const owner = objectId(String(ownerValue)), selected = bookingLocationInput(location);
  requireBookingReads(config); await admit(owner, config);
  const result = await timedRead(config, () => resolveLocationByCoordinatesService(selected));
  await access(owner, config);
  return result;
}

export { access, admit, input, timedRead, resultLimit };
