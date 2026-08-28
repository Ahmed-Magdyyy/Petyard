import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";

import { LoyaltyTransactionModel } from "../../../src/domains/loyalty/loyaltyTransaction.model.js";
import { LoyaltySettingsModel } from "../../../src/domains/loyalty/loyaltySettings.model.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { redeemLoyaltyPointsService } from "../../../src/domains/loyalty/loyalty.service.js";
import {
  recordSignupWelcomeRewardService,
  SIGNUP_WELCOME_REWARD_POINTS,
} from "../../../src/domains/loyalty/signupWelcomeReward.service.js";

const session = { id: "txn-session" };

function makeUser(overrides = {}) {
  const _id = overrides._id ?? new mongoose.Types.ObjectId();
  return {
    _id,
    loyaltyPoints: 500,
    ...overrides,
  };
}

test("SIGNUP_WELCOME_REWARD_POINTS is exactly 500", () => {
  assert.equal(SIGNUP_WELCOME_REWARD_POINTS, 500);
});

test("welcome loyalty transaction validates with EARNED and SIGNUP_WELCOME_REWARD", async () => {
  const userId = new mongoose.Types.ObjectId();
  const doc = new LoyaltyTransactionModel({
    user: userId,
    points: SIGNUP_WELCOME_REWARD_POINTS,
    type: "EARNED",
    referenceType: "SIGNUP_WELCOME_REWARD",
    referenceId: userId,
    operationId: `loyalty:signup-welcome-reward:${userId}`,
    balanceAfter: 500,
  });

  await assert.doesNotReject(() => doc.validate());
  assert.equal(doc.type, "EARNED");
  assert.equal(doc.referenceType, "SIGNUP_WELCOME_REWARD");
});

test("reward ledger payload uses 500, user reference, deterministic operation id, and post-update balanceAfter", async () => {
  const user = makeUser({ loyaltyPoints: 750 });
  let created;
  const loyaltyTransactionModel = {
    async create(docs, options) {
      created = { docs, options };
      return docs;
    },
  };

  await recordSignupWelcomeRewardService(
    { user, session },
    {
      loyaltyTransactionModel,
      enqueue: async () => {},
    },
  );

  assert.deepEqual(created.options, { session });
  assert.equal(created.docs.length, 1);
  assert.deepEqual(created.docs[0], {
    user: user._id,
    points: 500,
    type: "EARNED",
    referenceType: "SIGNUP_WELCOME_REWARD",
    referenceId: user._id,
    operationId: `loyalty:signup-welcome-reward:${user._id}`,
    balanceAfter: 750,
    description_en: "Received 500 welcome loyalty points for completing signup",
    description_ar: "حصلت على 500 نقطة ولاء ترحيبية لإكمال التسجيل",
  });
});

test("outbox payload uses exact bilingual copy, loyalty icon, LoyaltyScreen, event, reference, dedupe key, and session", async () => {
  const user = makeUser();
  let enqueued;
  await recordSignupWelcomeRewardService(
    { user, session },
    {
      loyaltyTransactionModel: {
        async create() {
          return [];
        },
      },
      enqueue: async (payload) => {
        enqueued = payload;
      },
    },
  );

  assert.deepEqual(enqueued, {
    recipientUser: user._id,
    dedupeKey: `loyalty:signup-welcome-reward:${user._id}`,
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
  assert.equal(enqueued.session, session);
});

test("ledger creation occurs before outbox enqueue without Promise.all", async () => {
  const order = [];
  await recordSignupWelcomeRewardService(
    { user: makeUser(), session },
    {
      loyaltyTransactionModel: {
        async create() {
          order.push("ledger-start");
          await new Promise((resolve) => setImmediate(resolve));
          order.push("ledger-end");
          return [];
        },
      },
      enqueue: async () => {
        order.push("outbox");
      },
    },
  );

  assert.deepEqual(order, ["ledger-start", "ledger-end", "outbox"]);
});

test("welcome reward recording does not read loyalty settings", async (t) => {
  t.mock.method(LoyaltySettingsModel, "findOne", async () => {
    throw new Error("loyalty settings must not be read");
  });

  await assert.doesNotReject(() =>
    recordSignupWelcomeRewardService(
      { user: makeUser(), session },
      {
        loyaltyTransactionModel: {
          async create() {
            return [];
          },
        },
        enqueue: async () => {},
      },
    ),
  );
});

test("deterministic loyalty operationId and outbox dedupeKey are identical across retries", async () => {
  const user = makeUser();
  const keys = [];

  for (let i = 0; i < 2; i += 1) {
    await recordSignupWelcomeRewardService(
      { user, session },
      {
        loyaltyTransactionModel: {
          async create(docs) {
            keys.push({ operationId: docs[0].operationId });
            return docs;
          },
        },
        enqueue: async ({ dedupeKey }) => {
          keys[keys.length - 1].dedupeKey = dedupeKey;
        },
      },
    );
  }

  const expected = `loyalty:signup-welcome-reward:${user._id}`;
  assert.equal(keys.length, 2);
  assert.equal(keys[0].operationId, expected);
  assert.equal(keys[0].dedupeKey, expected);
  assert.equal(keys[1].operationId, expected);
  assert.equal(keys[1].dedupeKey, expected);
});

test("redeemLoyaltyPointsService still rejects when isActive is false", async (t) => {
  t.mock.method(LoyaltySettingsModel, "findOne", async () => ({
    pointsEarnRate: 1,
    pointsRedeemRate: 10,
    minPointsToRedeem: 500,
    isActive: false,
  }));
  t.mock.method(UserModel, "findById", () => ({
    select() {
      return {
        lean: async () => ({ loyaltyPoints: 1000, walletBalance: 0 }),
      };
    },
  }));

  await assert.rejects(
    redeemLoyaltyPointsService({ userId: new mongoose.Types.ObjectId() }),
    (error) =>
      error.statusCode === 400 &&
      error.message === "Loyalty points system is currently disabled",
  );
});

test("malformed reward input fails instead of skipping records", async () => {
  const loyaltyTransactionModel = {
    async create() {
      throw new Error("create should not run");
    },
  };
  const enqueue = async () => {
    throw new Error("enqueue should not run");
  };

  await assert.rejects(
    recordSignupWelcomeRewardService(
      { user: { loyaltyPoints: 500 }, session },
      { loyaltyTransactionModel, enqueue },
    ),
    /user\._id/,
  );
  await assert.rejects(
    recordSignupWelcomeRewardService(
      { user: makeUser({ loyaltyPoints: "500" }), session },
      { loyaltyTransactionModel, enqueue },
    ),
    /loyaltyPoints/,
  );
  await assert.rejects(
    recordSignupWelcomeRewardService(
      { user: makeUser(), session: null },
      { loyaltyTransactionModel, enqueue },
    ),
    /session/,
  );
});
