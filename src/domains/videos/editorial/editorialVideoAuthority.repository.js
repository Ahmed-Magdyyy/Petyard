import { UserModel } from "../../user/user.model.js";
import { accountStatus, enabledControls, roles } from "../../../shared/constants/enums.js";
import { ApiError } from "../../../shared/utils/ApiError.js";

export function createEditorialVideoAuthorityFence({ users = UserModel } = {}) {
  return async function assertAuthority(actor, session) {
    const forbidden = () => new ApiError("Not allowed to change Videos", 403, [{ code: "VIDEO_FORBIDDEN" }]);
    if (!actor?.id || ![roles.ADMIN, roles.SUPER_ADMIN].includes(actor.role) || !session) throw forbidden();
    // A real write makes concurrent account revocation conflict with this transaction.
    const result = await users.updateOne({ _id: actor.id, role: actor.role, active: true, deletedAt: null,
      account_status: { $ne: accountStatus.BANNED }, phoneVerified: true,
      ...(actor.role === roles.ADMIN ? { enabledControls: enabledControls.VIDEOS } : {}) },
    { $inc: { __v: 1 } }, { session, timestamps: false });
    if (result.matchedCount !== 1) throw forbidden();
  };
}
