import { ApiError } from "../../shared/utils/ApiError.js";
import { accountStatus, roles } from "../../shared/constants/enums.js";

export function requireBundleUser(actor) {
  if (!actor || !/^[a-f\d]{24}$/i.test(String(actor._id))) throw new ApiError("Authentication required", 401);
  if (![roles.USER, roles.SUPER_ADMIN, roles.ADMIN, roles.MODERATOR].includes(actor.role) || actor.active !== true || actor.phoneVerified !== true || actor.deletedAt ||
    [accountStatus.BANNED, accountStatus.DELETED].includes(actor.account_status)) {
    const error = new ApiError("An active verified account is required", 403);
    error.code = "BUNDLE_ACCESS_DENIED"; throw error;
  }
  return String(actor._id);
}

export function requireBundleSuperAdmin(actor) {
  const id = requireBundleUser(actor);
  if (actor.role !== roles.SUPER_ADMIN) {
    const error = new ApiError("Bundle management is restricted to superAdmins", 403);
    error.code = "BUNDLE_ACCESS_DENIED"; throw error;
  }
  return id;
}
