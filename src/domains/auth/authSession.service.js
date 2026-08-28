import crypto from "crypto";
import {
  createAccessToken,
  createRefreshToken,
} from "../../shared/utils/createToken.js";

export async function issueSessionTokensForUser(user, { session } = {}) {
  const now = Date.now();

  user.refreshTokens = (user.refreshTokens || []).filter(
    (t) => !t.expiresAt || t.expiresAt.getTime() > now,
  );

  const accessToken = createAccessToken(user._id, user.role);
  const refreshToken = createRefreshToken(user._id);
  const hashedRefreshToken = crypto
    .createHash("sha256")
    .update(refreshToken)
    .digest("hex");

  user.refreshTokens.push({
    token: hashedRefreshToken,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  if (session) {
    await user.save({ session });
  } else {
    await user.save();
  }

  return {
    accessToken,
    refreshToken,
    accessTokenExpires: new Date(Date.now() + 3 * 60 * 60 * 1000),
  };
}
