import { UserModel } from "../../user/user.model.js";
import { roles, accountStatus, enabledControls } from "../../../shared/constants/enums.js";
import { AssistantAccount } from "../shared/assistant.models.js";
import { reject } from "../shared/assistant.errors.js";

export async function requireAnalyticsActor(actor, { session = null, allowBlocked = false } = {}) {
  const userQuery = UserModel.findById(actor).select("_id role active deletedAt account_status phoneVerified enabledControls passwordChangedAT").maxTimeMS(5000);
  const accountQuery = AssistantAccount.findOne({ owner: actor }).select("blocked").maxTimeMS(5000);
  if (session) { userQuery.session(session); accountQuery.session(session); }
  // MongoDB transactions must not run concurrent operations on the same session.
  const user = await userQuery.lean();
  const account = await accountQuery.lean();
  if (!user || user.active !== true || user.deletedAt || user.phoneVerified !== true ||
      [accountStatus.BANNED, accountStatus.DELETED].includes(user.account_status) ||
      !(user.role === roles.SUPER_ADMIN || (user.role === roles.ADMIN &&
        Array.isArray(user.enabledControls) && user.enabledControls.includes(enabledControls.ANALYTICS)))) reject("access_denied", 403);
  if (account?.blocked && !allowBlocked) reject("ai_restricted", 403);
  return { user, account };
}
