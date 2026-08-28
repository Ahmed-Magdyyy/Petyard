import { LoyaltyTransactionModel } from "./loyaltyTransaction.model.js";
import { enqueueNotificationOutbox } from "../notification/notificationOutbox.service.js";

export const SIGNUP_WELCOME_REWARD_POINTS = 500;

function assertRewardRecordInput({ user, session }) {
  if (!user?._id) {
    throw new Error("signup welcome reward requires user._id");
  }
  if (
    typeof user.loyaltyPoints !== "number" ||
    !Number.isFinite(user.loyaltyPoints)
  ) {
    throw new Error("signup welcome reward requires numeric user.loyaltyPoints");
  }
  if (!session) {
    throw new Error("signup welcome reward requires a Mongo session");
  }
}

export async function recordSignupWelcomeRewardService(
  { user, session },
  {
    loyaltyTransactionModel = LoyaltyTransactionModel,
    enqueue = enqueueNotificationOutbox,
  } = {},
) {
  assertRewardRecordInput({ user, session });

  const operationId = `loyalty:signup-welcome-reward:${user._id}`;

  await loyaltyTransactionModel.create(
    [
      {
        user: user._id,
        points: SIGNUP_WELCOME_REWARD_POINTS,
        type: "EARNED",
        referenceType: "SIGNUP_WELCOME_REWARD",
        referenceId: user._id,
        operationId,
        balanceAfter: user.loyaltyPoints,
        description_en:
          "Received 500 welcome loyalty points for completing signup",
        description_ar: "حصلت على 500 نقطة ولاء ترحيبية لإكمال التسجيل",
      },
    ],
    { session },
  );

  await enqueue({
    recipientUser: user._id,
    dedupeKey: operationId,
    title_en: "Welcome to Petyard!",
    title_ar: "أهلاً بك في Petyard!",
    body_en: "You received 500 free loyalty points for completing your signup.",
    body_ar: "حصلت على 500 نقطة ولاء مجانية لإكمال تسجيلك.",
    icon: "loyalty",
    action: {
      type: "screen",
      screen: "LoyaltyScreen",
      params: {},
    },
    source: {
      domain: "loyalty",
      event: "signup_welcome_reward_granted",
      referenceId: String(user._id),
    },
    session,
  });
}
