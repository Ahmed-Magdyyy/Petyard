import assert from "node:assert/strict";
import crypto from "crypto";
import test from "node:test";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import axios from "axios";
import { OAuth2Client } from "google-auth-library";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { UserModel } from "../../../src/domains/user/user.model.js";
import { LoyaltyTransactionModel } from "../../../src/domains/loyalty/loyaltyTransaction.model.js";
import { LoyaltySettingsModel } from "../../../src/domains/loyalty/loyaltySettings.model.js";
import { NotificationOutboxModel } from "../../../src/domains/notification/notificationOutbox.model.js";
import {
  recordSignupWelcomeRewardService,
  SIGNUP_WELCOME_REWARD_POINTS,
} from "../../../src/domains/loyalty/signupWelcomeReward.service.js";
import {
  completeInitialPhoneVerificationService,
  initialPhoneVerificationStorage,
} from "../../../src/domains/auth/phoneVerificationCompletion.service.js";
import { issueSessionTokensForUser } from "../../../src/domains/auth/authSession.service.js";
import {
  oauthAppleLoginService,
  oauthGoogleLoginService,
  oauthLinkAppleService,
  oauthLinkGoogleService,
  oauthSendOtpService,
  oauthVerifyPhoneService,
  refreshTokenService,
  resendOtpService,
  verifyPhoneService,
} from "../../../src/domains/auth/auth.service.js";
import {
  oauthVerifyPhone,
  verifyPhone,
} from "../../../src/domains/auth/auth.controller.js";
import { hashOtp } from "../../../src/domains/auth/otp.utils.js";
import {
  accountStatus,
  roles,
} from "../../../src/shared/constants/enums.js";

if (!process.env.JWT_ACCESS_SECRET) {
  process.env.JWT_ACCESS_SECRET = "test-access-secret";
}
if (!process.env.JWT_REFRESH_SECRET) {
  process.env.JWT_REFRESH_SECRET = "test-refresh-secret";
}

const OTP = "000000";
const CURRENT_HASH = "current-otp-hash";
const PENDING_HASH = "pending-otp-hash";
const CURRENT_PHONE = "201000000001";
const PENDING_PHONE = "201000000002";

let appleFixturePromise;

function getAppleFixture() {
  if (!appleFixturePromise) {
    appleFixturePromise = (async () => {
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const jwk = await exportJWK(publicKey);
      jwk.kid = "test-kid";
      jwk.use = "sig";
      jwk.alg = "RS256";
      return { privateKey, jwk };
    })();
  }
  return appleFixturePromise;
}

async function signAppleIdentityToken({
  sub,
  email,
} = {
  sub: "apple-sub-1",
  email: "apple.user@example.com",
}) {
  const { privateKey } = await getAppleFixture();
  return new SignJWT({
    sub,
    email,
    email_verified: true,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer("https://appleid.apple.com")
    .setAudience("com.petyard.app")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function mockAppleJwksFetch(t, jwk) {
  t.mock.method(globalThis, "fetch", async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input?.url || input?.href || String(input);
    if (String(url).includes("appleid.apple.com/auth/keys")) {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error("unexpected fetch");
  });
}

function createSessionTracker() {
  const session = {
    endSessionCalls: 0,
    async withTransaction(work) {
      return work();
    },
    async endSession() {
      session.endSessionCalls += 1;
    },
  };
  return session;
}

function queryResult(value) {
  const promise = Promise.resolve(value);
  return {
    then: (onFulfilled, onRejected) => promise.then(onFulfilled, onRejected),
    select: async () => value,
  };
}

function makeUser(overrides = {}) {
  return {
    _id: overrides._id ?? new mongoose.Types.ObjectId(),
    name: "test user",
    email: "user@example.com",
    phone: CURRENT_PHONE,
    role: roles.USER,
    phoneVerified: false,
    account_status: accountStatus.PENDING,
    loyaltyPoints: 0,
    refreshTokens: [],
    image: { url: "https://example.com/avatar.png" },
    save: async () => {},
    ...overrides,
  };
}

function tokens() {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    accessTokenExpires: new Date("2026-08-28T15:00:00.000Z"),
  };
}

function unexpectedRewardWrite() {
  throw new Error("unexpected welcome reward write");
}

function snapshotCompletionState(state) {
  return {
    phoneVerified: state.phoneVerified,
    accountStatus: state.accountStatus,
    loyaltyPoints: state.loyaltyPoints,
    signupWelcomeRewardGrantedAt: state.signupWelcomeRewardGrantedAt,
    ledger: [...state.ledger],
    outbox: [...state.outbox],
    tokens: [...state.tokens],
  };
}

function createTransactionalCompletionHarness({
  now = new Date("2026-08-28T12:00:00.000Z"),
  verificationMatch = true,
  signupWelcomeRewardGrantedAt,
  ledgerError,
  outboxError,
  tokenError,
} = {}) {
  const userId = new mongoose.Types.ObjectId();
  const state = {
    phoneVerified: false,
    accountStatus: accountStatus.PENDING,
    loyaltyPoints: 0,
    signupWelcomeRewardGrantedAt,
    ledger: [],
    outbox: [],
    tokens: [],
  };
  let draft;

  const userFromDraft = () =>
    makeUser({
      _id: userId,
      phoneVerified: draft.phoneVerified,
      account_status: draft.accountStatus,
      loyaltyPoints: draft.loyaltyPoints,
      ...(draft.signupWelcomeRewardGrantedAt
        ? { signupWelcomeRewardGrantedAt: draft.signupWelcomeRewardGrantedAt }
        : {}),
    });

  const session = {
    endSessionCalls: 0,
    async withTransaction(work) {
      draft = snapshotCompletionState(state);
      try {
        const result = await work();
        Object.assign(state, snapshotCompletionState(draft));
        return result;
      } finally {
        draft = undefined;
      }
    },
    async endSession() {
      session.endSessionCalls += 1;
    },
  };

  const userModel = {
    async findOneAndUpdate(filter, update) {
      if (filter.phoneVerified === false) {
        if (!verificationMatch || draft.phoneVerified) return null;
        draft.phoneVerified = update.$set.phoneVerified;
        draft.accountStatus = update.$set.account_status;
        return userFromDraft();
      }

      if (filter.signupWelcomeRewardGrantedAt) {
        if (draft.signupWelcomeRewardGrantedAt) return null;
        draft.loyaltyPoints += update.$inc.loyaltyPoints;
        draft.signupWelcomeRewardGrantedAt =
          update.$set.signupWelcomeRewardGrantedAt;
        return userFromDraft();
      }

      return null;
    },
  };

  const deps = {
    startSession: async () => session,
    userModel,
    async recordReward({ user, session: rewardSession }) {
      if (ledgerError) throw ledgerError;
      draft.ledger.push({ user: user._id, session: rewardSession });
      if (outboxError) throw outboxError;
      draft.outbox.push({ user: user._id, session: rewardSession });
    },
    async issueSessionTokens(user, { session: tokenSession }) {
      if (tokenError) throw tokenError;
      draft.tokens.push({ user: user._id, session: tokenSession });
      return tokens();
    },
  };

  return {
    userId,
    now,
    state,
    session,
    snapshot: () => snapshotCompletionState(state),
    complete: () =>
      completeInitialPhoneVerificationService(
        {
          userId,
          storage: initialPhoneVerificationStorage.CURRENT,
          expectedCodeHash: CURRENT_HASH,
          now,
        },
        deps,
      ),
  };
}

async function completeWith({
  storage = initialPhoneVerificationStorage.CURRENT,
  userId,
  expectedCodeHash = CURRENT_HASH,
  normalizedPhone,
  now = new Date("2026-08-28T12:00:00.000Z"),
  verifiedUser,
  rewardedUser,
  grantReward = true,
  verificationMatch = true,
  recordReward,
  issueSessionTokens,
  recordRewardError,
  issueError,
  enqueueError,
  ledgerError,
}) {
  const session = createSessionTracker();
  const updates = [];
  const rewardCalls = [];
  const tokenCalls = [];
  const id = userId ?? new mongoose.Types.ObjectId();
  const verified =
    verifiedUser ??
    makeUser({
      _id: id,
      phoneVerified: true,
      account_status: accountStatus.CONFIRMED,
    });
  const rewarded =
    rewardedUser ??
    makeUser({
      _id: id,
      phoneVerified: true,
      account_status: accountStatus.CONFIRMED,
      loyaltyPoints: 500,
      signupWelcomeRewardGrantedAt: now,
    });

  const userModel = {
    async findOneAndUpdate(filter, update, options) {
      updates.push({ filter, update, options });
      if (filter.phoneVerified === false) {
        return verificationMatch ? verified : null;
      }
      if (filter.signupWelcomeRewardGrantedAt) {
        return grantReward ? rewarded : null;
      }
      return null;
    },
  };

  const defaultRecordReward = async (args) => {
    if (ledgerError) throw ledgerError;
    if (enqueueError) {
      await recordSignupWelcomeRewardService(args, {
        loyaltyTransactionModel: {
          async create() {
            return [];
          },
        },
        enqueue: async () => {
          throw enqueueError;
        },
      });
      return;
    }
    rewardCalls.push(args);
  };

  const defaultIssue = async (user, opts) => {
    if (issueError) throw issueError;
    tokenCalls.push({ user, opts });
    return tokens();
  };

  let result;
  let error;
  try {
    result = await completeInitialPhoneVerificationService(
      {
        userId: id,
        storage,
        expectedCodeHash,
        normalizedPhone,
        now,
      },
      {
        startSession: async () => session,
        userModel,
        issueSessionTokens: issueSessionTokens ?? defaultIssue,
        recordReward: recordReward ?? defaultRecordReward,
      },
    );
  } catch (err) {
    error = err;
  }

  return {
    result,
    error,
    session,
    updates,
    rewardCalls,
    tokenCalls,
    verified,
    rewarded,
    userId: id,
    now,
  };
}

test("signup welcome reward marker is internal and absent by default", () => {
  const marker = UserModel.schema.path("signupWelcomeRewardGrantedAt");
  const user = new UserModel({ name: "new user", role: roles.USER });

  assert.equal(marker.options.select, false);
  assert.equal(marker.options.default, undefined);
  assert.equal(user.signupWelcomeRewardGrantedAt, undefined);
});

test("issueSessionTokensForUser prunes tokens, stores only a hash, and honors its optional session", async () => {
  const before = Date.now();
  const session = { id: "token-session" };
  const sessionSaveCalls = [];
  const activeStoredToken = {
    token: "still-valid-hash",
    expiresAt: new Date(before + 86_400_000),
  };
  const user = makeUser({
    refreshTokens: [
      { token: "expired-hash", expiresAt: new Date(before - 1) },
      activeStoredToken,
    ],
    async save(options) {
      sessionSaveCalls.push(options);
    },
  });

  const issued = await issueSessionTokensForUser(user, { session });
  const after = Date.now();
  const persistedNewToken = user.refreshTokens.find(
    (entry) => entry.token !== activeStoredToken.token,
  );

  assert.deepEqual(sessionSaveCalls, [{ session }]);
  assert.equal(user.refreshTokens.length, 2);
  assert.equal(user.refreshTokens.some((entry) => entry.token === "expired-hash"), false);
  assert.equal(persistedNewToken.token, crypto.createHash("sha256").update(issued.refreshToken).digest("hex"));
  assert.notEqual(persistedNewToken.token, issued.refreshToken);
  assert.ok(
    persistedNewToken.expiresAt.getTime() >= before + 30 * 24 * 60 * 60 * 1000 &&
      persistedNewToken.expiresAt.getTime() <= after + 30 * 24 * 60 * 60 * 1000,
  );
  assert.ok(
    issued.accessTokenExpires.getTime() >= before + 3 * 60 * 60 * 1000 &&
      issued.accessTokenExpires.getTime() <= after + 3 * 60 * 60 * 1000,
  );

  const noSessionSaveCalls = [];
  const noSessionUser = makeUser({
    async save(options) {
      noSessionSaveCalls.push(arguments.length ? options : undefined);
    },
  });
  await issueSessionTokensForUser(noSessionUser);
  assert.deepEqual(noSessionSaveCalls, [undefined]);
});

test("CURRENT storage requires unverified phone, current OTP hash, and nonexpired expiry", async () => {
  const now = new Date("2026-08-28T12:00:00.000Z");
  const { updates, userId, session } = await completeWith({
    storage: initialPhoneVerificationStorage.CURRENT,
    expectedCodeHash: CURRENT_HASH,
    now,
  });

  assert.deepEqual(updates[0].filter, {
    _id: userId,
    phoneVerified: false,
    phoneVerificationCode: CURRENT_HASH,
    phoneVerificationExpires: { $gt: now },
  });
  assert.equal(updates[0].options.session, session);
  assert.equal(updates[0].options.returnDocument, "after");
});

test("CURRENT completion confirms the account, clears OTP state, and does not overwrite phone", async () => {
  const { updates } = await completeWith({
    storage: initialPhoneVerificationStorage.CURRENT,
    normalizedPhone: PENDING_PHONE,
  });

  assert.deepEqual(updates[0].update.$set, {
    phoneVerified: true,
    account_status: accountStatus.CONFIRMED,
    phoneOtpSendCountToday: 0,
    pendingPhoneOtpSendCountToday: 0,
  });
  assert.equal(updates[0].update.$set.phone, undefined);
  assert.deepEqual(updates[0].update.$unset, {
    phoneVerificationCode: 1,
    phoneVerificationExpires: 1,
    phoneOtpLastSentAt: 1,
    pendingPhone: 1,
    pendingPhoneVerificationCode: 1,
    pendingPhoneVerificationExpires: 1,
    pendingPhoneOtpLastSentAt: 1,
  });
});

test("USER role receives exactly one 500-point increment and grant timestamp", async () => {
  const now = new Date("2026-08-28T12:00:00.000Z");
  const { updates, userId, rewardCalls } = await completeWith({ now });

  const rewardUpdate = updates.find(
    (entry) => entry.filter.signupWelcomeRewardGrantedAt,
  );
  assert.deepEqual(rewardUpdate.filter, {
    _id: userId,
    signupWelcomeRewardGrantedAt: { $exists: false },
  });
  assert.deepEqual(rewardUpdate.update, {
    $inc: { loyaltyPoints: 500 },
    $set: { signupWelcomeRewardGrantedAt: now },
  });
  assert.equal(rewardUpdate.options.select, "+signupWelcomeRewardGrantedAt");
  assert.equal(rewardCalls.length, 1);
  assert.equal(
    updates.filter((entry) => entry.update?.$inc?.loyaltyPoints === 500).length,
    1,
  );
});

test("loyalty record and outbox record receive the same transaction session", async () => {
  const session = createSessionTracker();
  const captured = [];
  const userId = new mongoose.Types.ObjectId();
  const rewarded = makeUser({
    _id: userId,
    phoneVerified: true,
    loyaltyPoints: 500,
  });

  await completeInitialPhoneVerificationService(
    {
      userId,
      storage: initialPhoneVerificationStorage.CURRENT,
      expectedCodeHash: CURRENT_HASH,
      now: new Date("2026-08-28T12:00:00.000Z"),
    },
    {
      startSession: async () => session,
      userModel: {
        async findOneAndUpdate(filter) {
          if (filter.phoneVerified === false) {
            return makeUser({ _id: userId, phoneVerified: true });
          }
          return rewarded;
        },
      },
      issueSessionTokens: async () => tokens(),
      recordReward: (args) =>
        recordSignupWelcomeRewardService(args, {
          loyaltyTransactionModel: {
            async create(docs, options) {
              captured.push({ kind: "ledger", options });
              return docs;
            },
          },
          enqueue: async (payload) => {
            captured.push({ kind: "outbox", session: payload.session });
          },
        }),
    },
  );

  assert.equal(captured[0].kind, "ledger");
  assert.equal(captured[1].kind, "outbox");
  assert.equal(captured[0].options.session, session);
  assert.equal(captured[1].session, session);
});

test("session-token issuance receives the same transaction session", async () => {
  const { tokenCalls, session, rewarded } = await completeWith({});
  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0].user, rewarded);
  assert.equal(tokenCalls[0].opts.session, session);
});

test("PENDING storage requires pending phone, hash, expiry and installs the normalized phone", async () => {
  const now = new Date("2026-08-28T12:00:00.000Z");
  const { updates, userId } = await completeWith({
    storage: initialPhoneVerificationStorage.PENDING,
    expectedCodeHash: PENDING_HASH,
    normalizedPhone: PENDING_PHONE,
    now,
  });

  assert.deepEqual(updates[0].filter, {
    _id: userId,
    phoneVerified: false,
    pendingPhone: PENDING_PHONE,
    pendingPhoneVerificationCode: PENDING_HASH,
    pendingPhoneVerificationExpires: { $gt: now },
  });
  assert.equal(updates[0].update.$set.phone, PENDING_PHONE);
});

test("credential, Google, and Apple verification use the production reward path with provider-neutral payloads", async (t) => {
  const states = [
    {
      flow: "credential",
      provider: "SYSTEM",
      userId: new mongoose.Types.ObjectId(),
      email: "credential.user@example.com",
      phone: "201000000004",
      session: createSessionTracker(),
    },
    {
      flow: "social",
      provider: "GOOGLE",
      userId: new mongoose.Types.ObjectId(),
      phone: PENDING_PHONE,
      session: createSessionTracker(),
    },
    {
      flow: "social",
      provider: "APPLE",
      userId: new mongoose.Types.ObjectId(),
      phone: "201000000003",
      session: createSessionTracker(),
    },
  ];
  const byId = new Map(states.map((state) => [String(state.userId), state]));
  const ledgers = [];
  const outboxes = [];

  for (const state of states) {
    state.loaded = makeUser({
      _id: state.userId,
      email: state.email,
      phoneVerified: false,
      phone: state.flow === "credential" ? state.phone : undefined,
      ...(state.flow === "credential"
        ? {
            phoneVerificationCode: hashOtp(OTP),
            phoneVerificationExpires: new Date(Date.now() + 60_000),
          }
        : {
            pendingPhone: state.phone,
            pendingPhoneVerificationCode: hashOtp(OTP),
            pendingPhoneVerificationExpires: new Date(Date.now() + 60_000),
          }),
      signupProvider: state.provider,
    });
  }

  function rewardedUser(state, loyaltyPoints) {
    return makeUser({
      _id: state.userId,
      phone: state.phone,
      phoneVerified: true,
      account_status: accountStatus.CONFIRMED,
      loyaltyPoints,
      refreshTokens: [],
      save: async (options) => {
        state.tokenSaveOptions = options;
      },
    });
  }

  t.mock.method(UserModel, "findById", async (userId) => byId.get(String(userId)).loaded);
  t.mock.method(UserModel, "findOne", (filter) => {
    const credential = states.find(
      (state) => state.flow === "credential" && filter.email === state.email,
    );
    return queryResult(credential?.loaded ?? null);
  });
  t.mock.method(mongoose, "startSession", async () => {
    const session = states.find((state) => !state.sessionStarted)?.session;
    const state = states.find((candidate) => candidate.session === session);
    state.sessionStarted = true;
    return session;
  });
  t.mock.method(UserModel, "findOneAndUpdate", async (filter) => {
    const state = byId.get(String(filter._id));
    if (filter.phoneVerified === false) {
      if (state.flow === "credential") {
        assert.equal(filter.phoneVerificationCode, hashOtp(OTP));
        assert.ok(filter.phoneVerificationExpires.$gt instanceof Date);
      } else {
        assert.equal(filter.pendingPhone, state.phone);
        assert.equal(filter.pendingPhoneVerificationCode, hashOtp(OTP));
        assert.ok(filter.pendingPhoneVerificationExpires.$gt instanceof Date);
      }
      return rewardedUser(state, 0);
    }
    return rewardedUser(state, SIGNUP_WELCOME_REWARD_POINTS);
  });
  t.mock.method(LoyaltyTransactionModel, "create", async (docs, options) => {
    ledgers.push({ document: docs[0], options });
    return docs;
  });
  t.mock.method(NotificationOutboxModel, "create", async (docs, options) => {
    outboxes.push({ document: docs[0], options });
    return docs;
  });

  const results = [];
  const [credential, ...socialStates] = states;
  results.push(
    await verifyPhoneService({
      identifier: credential.email,
      otp: OTP,
    }),
  );
  for (const state of socialStates) {
    results.push(
      await oauthVerifyPhoneService({
        userId: state.userId,
        phone: state.phone,
        otp: OTP,
      }),
    );
  }

  assert.equal(ledgers.length, 3);
  assert.equal(outboxes.length, 3);
  for (const [index, state] of states.entries()) {
    const operationId = `loyalty:signup-welcome-reward:${state.userId}`;
    assert.equal(results[index].phoneVerified, true);
    assert.equal(results[index].phone, state.phone);
    assert.deepEqual(ledgers[index], {
      document: {
        user: state.userId,
        points: 500,
        type: "EARNED",
        referenceType: "SIGNUP_WELCOME_REWARD",
        referenceId: state.userId,
        operationId,
        balanceAfter: 500,
        description_en: "Received 500 welcome loyalty points for completing signup",
        description_ar: "حصلت على 500 نقطة ولاء ترحيبية لإكمال التسجيل",
      },
      options: { session: state.session },
    });
    assert.deepEqual(outboxes[index], {
      document: {
        recipientUser: state.userId,
        dedupeKey: operationId,
        title_en: "Welcome to Petyard!",
        title_ar: "أهلاً بك في Petyard!",
        body_en: "You received 500 free loyalty points for completing your signup.",
        body_ar: "حصلت على 500 نقطة ولاء مجانية لإكمال تسجيلك.",
        icon: "loyalty",
        action: { type: "screen", screen: "LoyaltyScreen" },
        source: {
          domain: "loyalty",
          event: "signup_welcome_reward_granted",
          referenceId: String(state.userId),
        },
      },
      options: { session: state.session },
    });
    assert.equal(state.tokenSaveOptions.session, state.session);
  }

  assert.deepEqual(
    ledgers.map(({ document }) => ({
      points: document.points,
      type: document.type,
      referenceType: document.referenceType,
      balanceAfter: document.balanceAfter,
      description_en: document.description_en,
      description_ar: document.description_ar,
    })),
    Array.from({ length: 3 }, () => ({
      points: 500,
      type: "EARNED",
      referenceType: "SIGNUP_WELCOME_REWARD",
      balanceAfter: 500,
      description_en: "Received 500 welcome loyalty points for completing signup",
      description_ar: "حصلت على 500 نقطة ولاء ترحيبية لإكمال التسجيل",
    })),
  );
  assert.deepEqual(
    outboxes.map(({ document }) => ({
      title_en: document.title_en,
      title_ar: document.title_ar,
      body_en: document.body_en,
      body_ar: document.body_ar,
      icon: document.icon,
      action: document.action,
      source: { domain: document.source.domain, event: document.source.event },
    })),
    Array.from({ length: 3 }, () => ({
      title_en: "Welcome to Petyard!",
      title_ar: "أهلاً بك في Petyard!",
      body_en: "You received 500 free loyalty points for completing your signup.",
      body_ar: "حصلت على 500 نقطة ولاء مجانية لإكمال تسجيلك.",
      icon: "loyalty",
      action: { type: "screen", screen: "LoyaltyScreen" },
      source: { domain: "loyalty", event: "signup_welcome_reward_granted" },
    })),
  );
});

test("initially unverified current-phone OTP branch is rewarded once", async (t) => {
  const userId = new mongoose.Types.ObjectId();
  const hashedOtp = hashOtp(OTP);
  const user = makeUser({
    _id: userId,
    phoneVerified: false,
    phone: CURRENT_PHONE,
    phoneVerificationCode: hashedOtp,
    phoneVerificationExpires: new Date(Date.now() + 60_000),
  });
  const session = createSessionTracker();
  const incs = [];

  t.mock.method(UserModel, "findById", async () => user);
  t.mock.method(UserModel, "findOne", () => queryResult(null));
  t.mock.method(mongoose, "startSession", async () => session);
  t.mock.method(UserModel, "findOneAndUpdate", async (filter, update) => {
    if (filter.phoneVerified === false) {
      assert.equal(filter.phoneVerificationCode, hashedOtp);
      assert.equal(filter.pendingPhone, undefined);
      return makeUser({
        _id: userId,
        phoneVerified: true,
        phone: CURRENT_PHONE,
        save: async () => {},
      });
    }
    incs.push(update.$inc);
    return makeUser({
      _id: userId,
      phoneVerified: true,
      loyaltyPoints: 500,
      save: async () => {},
    });
  });
  t.mock.method(LoyaltyTransactionModel, "create", async (docs) => docs);
  t.mock.method(NotificationOutboxModel, "create", async (docs) => docs);

  const result = await oauthVerifyPhoneService({
    userId,
    phone: CURRENT_PHONE,
    otp: OTP,
  });

  assert.equal(result.phoneVerified, true);
  assert.equal(incs.length, 1);
  assert.deepEqual(incs[0], { loyaltyPoints: SIGNUP_WELCOME_REWARD_POINTS });
  assert.equal("rewardGranted" in result, false);
});

test("already verified credential user is rejected before completion or reward", async (t) => {
  t.mock.method(UserModel, "findOne", () => ({
    select: async () =>
      makeUser({
        phoneVerified: true,
        phoneVerificationCode: hashOtp(OTP),
      }),
  }));
  let started = false;
  t.mock.method(mongoose, "startSession", async () => {
    started = true;
    return createSessionTracker();
  });
  t.mock.method(UserModel, "findOneAndUpdate", unexpectedRewardWrite);
  t.mock.method(LoyaltyTransactionModel, "create", unexpectedRewardWrite);

  await assert.rejects(
    verifyPhoneService({ identifier: "user@example.com", otp: OTP }),
    (error) =>
      error.statusCode === 400 && error.message === "Phone already verified",
  );
  assert.equal(started, false);
});

test("already verified phone change does not call initial completion or reward", async (t) => {
  const userId = new mongoose.Types.ObjectId();
  const hashedOtp = hashOtp(OTP);
  const user = makeUser({
    _id: userId,
    phoneVerified: true,
    account_status: accountStatus.CONFIRMED,
    pendingPhone: PENDING_PHONE,
    pendingPhoneVerificationCode: hashedOtp,
    pendingPhoneVerificationExpires: new Date(Date.now() + 60_000),
    loyaltyPoints: 40,
  });
  t.mock.method(UserModel, "findById", async () => user);
  t.mock.method(UserModel, "findOne", () => queryResult(null));
  let started = false;
  t.mock.method(mongoose, "startSession", async () => {
    started = true;
    return createSessionTracker();
  });
  t.mock.method(UserModel, "findOneAndUpdate", unexpectedRewardWrite);
  t.mock.method(LoyaltyTransactionModel, "create", unexpectedRewardWrite);
  t.mock.method(NotificationOutboxModel, "create", unexpectedRewardWrite);

  const result = await oauthVerifyPhoneService({
    userId,
    phone: PENDING_PHONE,
    otp: OTP,
  });

  assert.equal(started, false);
  assert.equal(user.loyaltyPoints, 40);
  assert.equal(user.signupWelcomeRewardGrantedAt, undefined);
  assert.equal(result.phoneVerified, true);
  assert.equal(result.phone, PENDING_PHONE);
  assert.equal("rewardGranted" in result, false);
  assert.equal("rewardPoints" in result, false);
  assert.ok(result.accessToken);
  assert.ok(result.refreshToken);
});

test("non-USER role can complete verification without reward records", async () => {
  const { result, updates, rewardCalls, tokenCalls, error } = await completeWith(
    {
      verifiedUser: makeUser({
        role: roles.ADMIN,
        phoneVerified: true,
        account_status: accountStatus.CONFIRMED,
      }),
    },
  );

  assert.equal(error, undefined);
  assert.equal(result.rewardGranted, false);
  assert.equal(result.rewardPoints, 0);
  assert.equal(rewardCalls.length, 0);
  assert.equal(tokenCalls.length, 1);
  assert.equal(
    updates.some((entry) => entry.filter.signupWelcomeRewardGrantedAt),
    false,
  );
});

test("an existing reward marker skips the reward but still completes verification and token issuance", async () => {
  const marker = new Date("2026-08-01T12:00:00.000Z");
  const harness = createTransactionalCompletionHarness({
    signupWelcomeRewardGrantedAt: marker,
  });

  const result = await harness.complete();

  assert.equal(result.rewardGranted, false);
  assert.equal(result.rewardPoints, 0);
  assert.equal(harness.state.phoneVerified, true);
  assert.equal(harness.state.accountStatus, accountStatus.CONFIRMED);
  assert.equal(harness.state.signupWelcomeRewardGrantedAt, marker);
  assert.equal(harness.state.loyaltyPoints, 0);
  assert.deepEqual(harness.state.ledger, []);
  assert.deepEqual(harness.state.outbox, []);
  assert.equal(harness.state.tokens.length, 1);
  assert.equal(harness.session.endSessionCalls, 1);
});

test("Google login does not grant the welcome reward", async (t) => {
  process.env.GOOGLE_CLIENT_IDS = "test-google-client";
  t.mock.method(OAuth2Client.prototype, "verifyIdToken", async () => ({
    getPayload() {
      return {
        sub: "google-sub-1",
        email: "google.user@example.com",
        email_verified: true,
        name: "Google User",
      };
    },
  }));
  const user = makeUser({
    phoneVerified: false,
    email: "google.user@example.com",
    authProviders: [{ provider: "GOOGLE", providerUserId: "google-sub-1" }],
  });
  t.mock.method(UserModel, "findOne", () => queryResult(user));
  t.mock.method(UserModel, "findOneAndUpdate", unexpectedRewardWrite);
  t.mock.method(LoyaltyTransactionModel, "create", unexpectedRewardWrite);
  t.mock.method(NotificationOutboxModel, "create", unexpectedRewardWrite);

  const result = await oauthGoogleLoginService({ idToken: "google-id-token" });
  assert.equal(result.user._id, user._id);
  assert.ok(result.accessToken);
});

test("Apple login does not grant the welcome reward", async (t) => {
  process.env.APPLE_CLIENT_ID = "com.petyard.app";
  const { jwk } = await getAppleFixture();
  const identityToken = await signAppleIdentityToken();
  mockAppleJwksFetch(t, jwk);

  const user = makeUser({
    phoneVerified: false,
    email: "apple.user@example.com",
    authProviders: [{ provider: "APPLE", providerUserId: "apple-sub-1" }],
  });
  t.mock.method(UserModel, "findOne", () => queryResult(user));
  t.mock.method(UserModel, "findOneAndUpdate", unexpectedRewardWrite);
  t.mock.method(LoyaltyTransactionModel, "create", unexpectedRewardWrite);
  t.mock.method(NotificationOutboxModel, "create", unexpectedRewardWrite);

  const result = await oauthAppleLoginService({ identityToken });
  assert.equal(result.user._id, user._id);
  assert.ok(result.accessToken);
});

test("linking Google does not grant the welcome reward", async (t) => {
  process.env.GOOGLE_CLIENT_IDS = "test-google-client";
  t.mock.method(OAuth2Client.prototype, "verifyIdToken", async () => ({
    getPayload() {
      return {
        sub: "google-sub-2",
        email: "linked.google@example.com",
        email_verified: true,
      };
    },
  }));
  const user = makeUser({
    phoneVerified: false,
    authProviders: [],
  });
  t.mock.method(UserModel, "findById", async () => user);
  t.mock.method(UserModel, "findOne", () => queryResult(null));
  t.mock.method(UserModel, "findOneAndUpdate", unexpectedRewardWrite);
  t.mock.method(LoyaltyTransactionModel, "create", unexpectedRewardWrite);
  t.mock.method(NotificationOutboxModel, "create", unexpectedRewardWrite);

  const linked = await oauthLinkGoogleService({
    userId: user._id,
    idToken: "google-id-token",
  });
  assert.equal(linked._id, user._id);
  assert.equal(user.loyaltyPoints, 0);
});

test("linking Apple does not grant the welcome reward", async (t) => {
  process.env.APPLE_CLIENT_ID = "com.petyard.app";
  const { jwk } = await getAppleFixture();
  const identityToken = await signAppleIdentityToken({
    sub: "apple-sub-2",
    email: "linked.apple@example.com",
  });
  mockAppleJwksFetch(t, jwk);

  const user = makeUser({
    phoneVerified: false,
    authProviders: [],
  });
  t.mock.method(UserModel, "findById", async () => user);
  t.mock.method(UserModel, "findOne", () => queryResult(null));
  t.mock.method(UserModel, "findOneAndUpdate", unexpectedRewardWrite);
  t.mock.method(LoyaltyTransactionModel, "create", unexpectedRewardWrite);
  t.mock.method(NotificationOutboxModel, "create", unexpectedRewardWrite);

  const linked = await oauthLinkAppleService({
    userId: user._id,
    identityToken,
  });
  assert.equal(linked._id, user._id);
  assert.equal(user.loyaltyPoints, 0);
});

test("sending and resending OTP does not grant the welcome reward", async (t) => {
  process.env.epush_username = "u";
  process.env.epush_password = "p";
  process.env.epush_api_key = "k";
  t.mock.method(axios, "get", async () => ({ data: { new_msg_id: "msg-1" } }));
  t.mock.method(UserModel, "findOneAndUpdate", unexpectedRewardWrite);
  t.mock.method(LoyaltyTransactionModel, "create", unexpectedRewardWrite);
  t.mock.method(NotificationOutboxModel, "create", unexpectedRewardWrite);

  const sendUser = makeUser({
    phoneVerified: false,
    phone: undefined,
    pendingPhone: undefined,
  });
  const resendUser = makeUser({
    phoneVerified: false,
    phoneOtpLastSentAt: null,
    phoneOtpSendCountToday: 0,
  });
  let findOneValue = null;
  t.mock.method(UserModel, "findById", async () => sendUser);
  t.mock.method(UserModel, "findOne", () => queryResult(findOneValue));

  await oauthSendOtpService({ userId: sendUser._id, phone: PENDING_PHONE });
  assert.equal(sendUser.loyaltyPoints, 0);

  findOneValue = resendUser;
  await resendOtpService({ identifier: "user@example.com" });
  assert.equal(resendUser.loyaltyPoints, 0);
});

test("refreshing tokens does not grant the welcome reward", async (t) => {
  const refreshToken = "incoming-refresh-token";
  const hashed = crypto
    .createHash("sha256")
    .update(refreshToken)
    .digest("hex");
  const user = makeUser({
    phoneVerified: true,
    refreshTokens: [
      { token: hashed, expiresAt: new Date(Date.now() + 86_400_000) },
    ],
  });
  t.mock.method(jwt, "verify", () => ({ userId: String(user._id) }));
  t.mock.method(UserModel, "findById", async () => user);
  t.mock.method(UserModel, "findOneAndUpdate", unexpectedRewardWrite);
  t.mock.method(LoyaltyTransactionModel, "create", unexpectedRewardWrite);
  t.mock.method(NotificationOutboxModel, "create", unexpectedRewardWrite);

  const result = await refreshTokenService({ refreshToken });
  assert.ok(result.accessToken);
  assert.ok(result.refreshToken);
  assert.equal(user.loyaltyPoints, 0);
});

test("welcome reward completion succeeds without reading loyalty settings", async (t) => {
  const session = createSessionTracker();
  const userId = new mongoose.Types.ObjectId();
  const ledger = [];
  const outbox = [];
  t.mock.method(LoyaltySettingsModel, "findOne", async () => {
    throw new Error("welcome reward must not read loyalty settings");
  });

  const result = await completeInitialPhoneVerificationService(
    {
      userId,
      storage: initialPhoneVerificationStorage.CURRENT,
      expectedCodeHash: CURRENT_HASH,
      now: new Date("2026-08-28T12:00:00.000Z"),
    },
    {
      startSession: async () => session,
      userModel: {
        async findOneAndUpdate(filter) {
          if (filter.phoneVerified === false) {
            return makeUser({
              _id: userId,
              phoneVerified: true,
              account_status: accountStatus.CONFIRMED,
            });
          }
          return makeUser({
            _id: userId,
            phoneVerified: true,
            account_status: accountStatus.CONFIRMED,
            loyaltyPoints: 500,
          });
        },
      },
      issueSessionTokens: async () => tokens(),
      recordReward: (args) =>
        recordSignupWelcomeRewardService(args, {
          loyaltyTransactionModel: {
            async create(docs, options) {
              ledger.push({ docs, options });
              return docs;
            },
          },
          enqueue: async (payload) => {
            outbox.push(payload);
          },
        }),
    },
  );

  assert.equal(result.rewardGranted, true);
  assert.equal(result.rewardPoints, 500);
  assert.equal(ledger.length, 1);
  assert.equal(outbox.length, 1);
  assert.equal(ledger[0].docs[0].points, 500);
  assert.equal(ledger[0].options.session, session);
  assert.equal(outbox[0].session, session);
  assert.equal(session.endSessionCalls, 1);
});

test("verification, reward, outbox, and token failures leave no committed completion state", async () => {
  const scenarios = [
    {
      name: "no matching atomic verification update",
      options: { verificationMatch: false },
      assertError: (error) => {
        assert.equal(error.statusCode, 409);
        assert.equal(
          error.message,
          "Phone verification state changed. Please request a new OTP",
        );
      },
    },
    {
      name: "ledger failure",
      options: { ledgerError: new Error("ledger failed") },
      assertError: (error) => assert.equal(error.message, "ledger failed"),
    },
    {
      name: "outbox failure",
      options: { outboxError: new Error("outbox failed") },
      assertError: (error) => assert.equal(error.message, "outbox failed"),
    },
    {
      name: "refresh-token persistence failure",
      options: { tokenError: new Error("refresh token save failed") },
      assertError: (error) =>
        assert.equal(error.message, "refresh token save failed"),
    },
  ];

  for (const scenario of scenarios) {
    const harness = createTransactionalCompletionHarness(scenario.options);
    const before = harness.snapshot();
    await assert.rejects(harness.complete(), (error) => {
      scenario.assertError(error);
      return true;
    }, scenario.name);
    assert.deepEqual(harness.snapshot(), before, scenario.name);
    assert.equal(harness.session.endSessionCalls, 1, scenario.name);
  }
});

test("session.endSession runs on success and every failure", async () => {
  const success = await completeWith({});
  assert.equal(success.session.endSessionCalls, 1);

  const failures = await Promise.all([
    completeWith({ verificationMatch: false }),
    completeWith({ ledgerError: new Error("ledger failed") }),
    completeWith({ enqueueError: new Error("outbox failed") }),
    completeWith({ issueError: new Error("token failed") }),
  ]);
  for (const failure of failures) {
    assert.equal(failure.session.endSessionCalls, 1);
    assert.ok(failure.error);
  }
});

test("concurrent compare-and-set completion has one winner, one reward, and one token issuance", async () => {
  const userId = new mongoose.Types.ObjectId();
  const now = new Date("2026-08-28T12:00:00.000Z");
  const sessions = [];
  const state = {
    phoneVerified: false,
    loyaltyPoints: 0,
    signupWelcomeRewardGrantedAt: undefined,
  };
  const ledger = [];
  const outbox = [];
  const tokenCalls = [];
  const userModel = {
    async findOneAndUpdate(filter, update) {
      if (filter.phoneVerified === false) {
        if (state.phoneVerified) return null;
        state.phoneVerified = update.$set.phoneVerified;
        return makeUser({
          _id: userId,
          phoneVerified: true,
          account_status: accountStatus.CONFIRMED,
          loyaltyPoints: state.loyaltyPoints,
        });
      }
      if (filter.signupWelcomeRewardGrantedAt) {
        if (state.signupWelcomeRewardGrantedAt) return null;
        state.loyaltyPoints += update.$inc.loyaltyPoints;
        state.signupWelcomeRewardGrantedAt =
          update.$set.signupWelcomeRewardGrantedAt;
        return makeUser({
          _id: userId,
          phoneVerified: true,
          account_status: accountStatus.CONFIRMED,
          loyaltyPoints: state.loyaltyPoints,
        });
      }
      return null;
    },
  };

  const deps = {
    startSession: async () => {
      const session = createSessionTracker();
      sessions.push(session);
      return session;
    },
    userModel,
    issueSessionTokens: async (user, options) => {
      tokenCalls.push({ user, options });
      return tokens();
    },
    recordReward: (args) =>
      recordSignupWelcomeRewardService(args, {
        loyaltyTransactionModel: {
          async create(docs, options) {
            ledger.push({ docs, options });
            return docs;
          },
        },
        enqueue: async (payload) => {
          outbox.push(payload);
        },
      }),
  };
  const args = {
    userId,
    storage: initialPhoneVerificationStorage.CURRENT,
    expectedCodeHash: CURRENT_HASH,
    now,
  };

  const results = await Promise.allSettled([
    completeInitialPhoneVerificationService(args, deps),
    completeInitialPhoneVerificationService(args, deps),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(fulfilled[0].value.rewardGranted, true);
  assert.equal(fulfilled[0].value.rewardPoints, 500);
  assert.equal(rejected[0].reason.statusCode, 409);
  assert.equal(
    rejected[0].reason.message,
    "Phone verification state changed. Please request a new OTP",
  );
  assert.equal(state.phoneVerified, true);
  assert.equal(state.loyaltyPoints, 500);
  assert.equal(state.signupWelcomeRewardGrantedAt, now);
  assert.equal(ledger.length, 1);
  assert.equal(outbox.length, 1);
  assert.equal(tokenCalls.length, 1);
  assert.equal(ledger[0].options.session, outbox[0].session);
  assert.equal(tokenCalls[0].options.session, ledger[0].options.session);
  assert.equal(sessions.length, 2);
  assert.deepEqual(
    sessions.map((session) => session.endSessionCalls),
    [1, 1],
  );
});

test("verification service and controller return shapes remain unchanged", async (t) => {
  const userId = new mongoose.Types.ObjectId();
  const hashedOtp = hashOtp(OTP);
  const loaded = makeUser({
    _id: userId,
    phoneVerificationCode: hashedOtp,
    phoneVerificationExpires: new Date(Date.now() + 60_000),
  });
  const session = createSessionTracker();
  t.mock.method(UserModel, "findOne", () => ({
    select: async () => loaded,
  }));
  t.mock.method(mongoose, "startSession", async () => session);
  t.mock.method(UserModel, "findOneAndUpdate", async (filter) => {
    if (filter.phoneVerified === false) {
      return makeUser({
        _id: userId,
        phoneVerified: true,
        save: async () => {},
      });
    }
    return makeUser({
      _id: userId,
      phoneVerified: true,
      loyaltyPoints: 500,
      save: async () => {},
    });
  });
  t.mock.method(LoyaltyTransactionModel, "create", async (docs) => docs);
  t.mock.method(NotificationOutboxModel, "create", async (docs) => docs);

  const data = await verifyPhoneService({
    identifier: "user@example.com",
    otp: OTP,
  });
  const expectedKeys = [
    "id",
    "name",
    "email",
    "phone",
    "imageUrl",
    "role",
    "phoneVerified",
    "accessToken",
    "refreshToken",
    "accessTokenExpires",
  ];
  assert.deepEqual(Object.keys(data).sort(), [...expectedKeys].sort());
  assert.equal("rewardGranted" in data, false);
  assert.equal("rewardPoints" in data, false);
  assert.equal(data.phoneVerified, true);

  const res = {
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  await verifyPhone(
    { body: { identifier: "user@example.com", otp: OTP } },
    res,
    (err) => {
      if (err) throw err;
    },
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.message, "Phone verified successfully.");
  assert.deepEqual(Object.keys(res.body.data).sort(), [...expectedKeys].sort());

  const oauthUser = makeUser({
    _id: userId,
    phoneVerified: false,
    pendingPhone: PENDING_PHONE,
    pendingPhoneVerificationCode: hashedOtp,
    pendingPhoneVerificationExpires: new Date(Date.now() + 60_000),
  });
  t.mock.method(UserModel, "findById", async () => oauthUser);
  t.mock.method(UserModel, "findOne", () => queryResult(null));

  const oauthRes = {
    statusCode: null,
    body: null,
    status(code) {
      oauthRes.statusCode = code;
      return oauthRes;
    },
    json(payload) {
      oauthRes.body = payload;
      return oauthRes;
    },
  };
  await oauthVerifyPhone(
    {
      user: { _id: userId },
      body: { phone: PENDING_PHONE, otp: OTP },
    },
    oauthRes,
    (err) => {
      if (err) throw err;
    },
  );
  assert.equal(oauthRes.statusCode, 200);
  assert.equal(oauthRes.body.message, "Phone verified successfully.");
  assert.deepEqual(
    Object.keys(oauthRes.body.data).sort(),
    [...expectedKeys].sort(),
  );
  assert.equal("rewardGranted" in oauthRes.body.data, false);
});
