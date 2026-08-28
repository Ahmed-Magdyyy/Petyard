import mongoose from "mongoose";
import { ApiError } from "../../shared/utils/ApiError.js";
import { accountStatus, roles } from "../../shared/constants/enums.js";
import { UserModel } from "../user/user.model.js";
import { issueSessionTokensForUser } from "./authSession.service.js";
import {
  recordSignupWelcomeRewardService,
  SIGNUP_WELCOME_REWARD_POINTS,
} from "../loyalty/signupWelcomeReward.service.js";

export const initialPhoneVerificationStorage = Object.freeze({
  CURRENT: "current",
  PENDING: "pending",
});

function buildVerificationFilter({
  userId,
  storage,
  expectedCodeHash,
  normalizedPhone,
  now,
}) {
  if (storage === initialPhoneVerificationStorage.CURRENT) {
    return {
      _id: userId,
      phoneVerified: false,
      phoneVerificationCode: expectedCodeHash,
      phoneVerificationExpires: { $gt: now },
    };
  }

  if (storage === initialPhoneVerificationStorage.PENDING) {
    return {
      _id: userId,
      phoneVerified: false,
      pendingPhone: normalizedPhone,
      pendingPhoneVerificationCode: expectedCodeHash,
      pendingPhoneVerificationExpires: { $gt: now },
    };
  }

  throw new Error("Unsupported phone verification storage");
}

function buildVerificationUpdate({ storage, normalizedPhone }) {
  const $set = {
    phoneVerified: true,
    account_status: accountStatus.CONFIRMED,
    phoneOtpSendCountToday: 0,
    pendingPhoneOtpSendCountToday: 0,
  };

  if (storage === initialPhoneVerificationStorage.PENDING) {
    $set.phone = normalizedPhone;
  }

  return {
    $set,
    $unset: {
      phoneVerificationCode: 1,
      phoneVerificationExpires: 1,
      phoneOtpLastSentAt: 1,
      pendingPhone: 1,
      pendingPhoneVerificationCode: 1,
      pendingPhoneVerificationExpires: 1,
      pendingPhoneOtpLastSentAt: 1,
    },
  };
}

export async function completeInitialPhoneVerificationService(
  {
    userId,
    storage,
    expectedCodeHash,
    normalizedPhone,
    now,
  },
  {
    startSession = mongoose.startSession.bind(mongoose),
    userModel = UserModel,
    issueSessionTokens = issueSessionTokensForUser,
    recordReward = recordSignupWelcomeRewardService,
  } = {},
) {
  const effectiveNow = now ?? new Date();

  if (
    storage !== initialPhoneVerificationStorage.CURRENT &&
    storage !== initialPhoneVerificationStorage.PENDING
  ) {
    throw new Error("Unsupported phone verification storage");
  }

  if (
    storage === initialPhoneVerificationStorage.PENDING &&
    (normalizedPhone === undefined ||
      normalizedPhone === null ||
      normalizedPhone === "")
  ) {
    throw new Error("normalizedPhone is required for pending phone verification");
  }

  const session = await startSession();
  let finalUser;
  let rewardGranted = false;
  let accessToken;
  let refreshToken;
  let accessTokenExpires;

  try {
    await session.withTransaction(async () => {
      rewardGranted = false;

      const verifiedUser = await userModel.findOneAndUpdate(
        buildVerificationFilter({
          userId,
          storage,
          expectedCodeHash,
          normalizedPhone,
          now: effectiveNow,
        }),
        buildVerificationUpdate({ storage, normalizedPhone }),
        { session, returnDocument: "after" },
      );

      if (!verifiedUser) {
        throw new ApiError(
          "Phone verification state changed. Please request a new OTP",
          409,
        );
      }

      finalUser = verifiedUser;

      if (verifiedUser.role === roles.USER) {
        const rewardedUser = await userModel.findOneAndUpdate(
          {
            _id: userId,
            signupWelcomeRewardGrantedAt: { $exists: false },
          },
          {
            $inc: { loyaltyPoints: SIGNUP_WELCOME_REWARD_POINTS },
            $set: { signupWelcomeRewardGrantedAt: effectiveNow },
          },
          {
            session,
            returnDocument: "after",
            select: "+signupWelcomeRewardGrantedAt",
          },
        );

        if (rewardedUser) {
          rewardGranted = true;
          finalUser = rewardedUser;
          await recordReward({ user: rewardedUser, session });
        }
      }

      const tokens = await issueSessionTokens(finalUser, { session });
      accessToken = tokens.accessToken;
      refreshToken = tokens.refreshToken;
      accessTokenExpires = tokens.accessTokenExpires;
    });
  } finally {
    await session.endSession();
  }

  return {
    user: finalUser,
    rewardGranted,
    rewardPoints: rewardGranted ? SIGNUP_WELCOME_REWARD_POINTS : 0,
    accessToken,
    refreshToken,
    accessTokenExpires,
  };
}
