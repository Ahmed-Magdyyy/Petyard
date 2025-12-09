// src/domains/auth/auth.service.js
import crypto from "crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { UserModel } from "../user/user.model.js";
import { ApiError } from "../../shared/ApiError.js";
import { sendOtpSms, normalizeEgyptianMobile } from "../../shared/utils/sms.js";
import {
  createAccessToken,
  createRefreshToken,
} from "../../shared/createToken.js";
import { roles, accountStatus } from "../../shared/constants/enums.js";
import sendEmail from "../../shared/Email/sendEmails.js";
import { forgetPasswordEmailHTML } from "../../shared/Email/emailHtml.js";
import { getRedisClient } from "../../shared/redisClient.js";

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function signupService({ name, email, phone, password }) {
  if (!name || !email || !phone || !password) {
    throw new ApiError("name, email, phone and password are required", 400);
  }

  const normalizedPhone = normalizeEgyptianMobile(phone);

  const existing = await UserModel.findOne({
    $or: [{ email }, { phone: normalizedPhone }],
  });

  if (existing) {
    throw new ApiError("User already exists with this phone or email", 409);
  }

  const user = await UserModel.create({
    name,
    email,
    phone: normalizedPhone,
    password,
    phoneVerified: false,
  });

  const otp = generateOtp();
  const hashedOtp = crypto.createHash("sha256").update(otp).digest("hex");

  user.phoneVerificationCode = hashedOtp;
  user.phoneVerificationExpires = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
  await user.save();

  try {
    await sendOtpSms(user.phone, otp);
    console.log("otp:", otp);
  } catch (err) {
    console.error("Failed to send OTP SMS", err);
    await UserModel.findByIdAndDelete(user._id);
    throw new ApiError(
      "Failed to send verification SMS, please try again later",
      502
    );
  }

  return {
    id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    phoneVerified: user.phoneVerified,
    otp: otp,
  };
}

export async function resendOtpService({ phone }) {
  if (!phone) {
    throw new ApiError("phone is required", 400);
  }

  let normalizedPhone;
  try {
    normalizedPhone = normalizeEgyptianMobile(phone);
  } catch (err) {
    throw new ApiError("Invalid Egyptian mobile format", 400);
  }

  const user = await UserModel.findOne({ phone: normalizedPhone });

  if (!user) {
    throw new ApiError("User not found", 404);
  }

  if (user.phoneVerified) {
    throw new ApiError("Phone already verified", 400);
  }

  const now = new Date();
  const RESEND_MIN_INTERVAL_MS = 60 * 1000;
  const RESEND_MAX_PER_DAY = 5;

  if (user.phoneOtpLastSentAt) {
    const diff = now.getTime() - user.phoneOtpLastSentAt.getTime();
    if (diff < RESEND_MIN_INTERVAL_MS) {
      throw new ApiError("Please wait before requesting another OTP", 429);
    }
  }

  let sendCount = user.phoneOtpSendCountToday || 0;

  if (user.phoneOtpLastSentAt) {
    const last = user.phoneOtpLastSentAt;
    const isSameDay =
      last.getUTCFullYear() === now.getUTCFullYear() &&
      last.getUTCMonth() === now.getUTCMonth() &&
      last.getUTCDate() === now.getUTCDate();

    if (!isSameDay) {
      sendCount = 0;
    }
  }

  if (sendCount >= RESEND_MAX_PER_DAY) {
    throw new ApiError("Daily OTP resend limit reached", 429);
  }

  const otp = generateOtp();
  const hashedOtp = crypto.createHash("sha256").update(otp).digest("hex");

  user.phoneVerificationCode = hashedOtp;
  user.phoneVerificationExpires = new Date(Date.now() + 5 * 60 * 1000);
  user.phoneOtpLastSentAt = now;
  user.phoneOtpSendCountToday = sendCount + 1;
  await user.save();

  await sendOtpSms(user.phone, otp);

  console.log("otp:", otp);

  return {
    id: user._id,
    phone: user.phone,
    phoneVerified: user.phoneVerified,
    otp: otp,
  };
}

export async function verifyPhoneService({ phone, otp }) {
  if (!phone || !otp) {
    throw new ApiError("phone and otp are required", 400);
  }

  let normalizedPhone;
  try {
    normalizedPhone = normalizeEgyptianMobile(phone);

    console.log("phone", phone);
    console.log("normalizedPhone", normalizedPhone);
  } catch (err) {
    throw new ApiError("Invalid Egyptian mobile format", 400);
  }

  const user = await UserModel.findOne({ phone: normalizedPhone }).select(
    "+password"
  );

  if (!user) {
    throw new ApiError("User not found", 404);
  }

  if (user.phoneVerified) {
    throw new ApiError("Phone already verified", 400);
  }

  if (!user.phoneVerificationCode || !user.phoneVerificationExpires) {
    throw new ApiError("No active OTP, please request a new code", 400);
  }

  if (user.phoneVerificationExpires.getTime() < Date.now()) {
    throw new ApiError("OTP has expired", 400);
  }

  const hashedOtp = crypto
    .createHash("sha256")
    .update(String(otp))
    .digest("hex");

  if (hashedOtp !== user.phoneVerificationCode) {
    throw new ApiError("Invalid OTP", 400);
  }

  const accessToken = createAccessToken(user._id, user.role);
  const refreshToken = createRefreshToken(user._id);

  user.phoneVerified = true;
  user.phoneVerificationCode = undefined;
  user.phoneVerificationExpires = undefined;
  user.phoneOtpLastSentAt = undefined;
  user.phoneOtpSendCountToday = 0;
  user.account_status = accountStatus.CONFIRMED;
  await user.save();

  return {
    id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    phoneVerified: user.phoneVerified,
    accessToken,
    refreshToken,
    accessTokenExpires: new Date(Date.now() + 3 * 60 * 60 * 1000),
  };
}

export async function sendGuestOtpService({ phone }) {
  if (!phone) {
    throw new ApiError("phone is required", 400);
  }

  let normalizedPhone;
  try {
    normalizedPhone = normalizeEgyptianMobile(phone);
  } catch (err) {
    throw new ApiError("Invalid Egyptian mobile format", 400);
  }

  const redisClient = getRedisClient();
  if (!redisClient || redisClient.status !== "ready") {
    throw new ApiError("OTP service is temporarily unavailable", 503);
  }

  const key = `guest:otp:${normalizedPhone}`;
  const now = Date.now();
  const RESEND_MIN_INTERVAL_MS = 60 * 1000;
  const RESEND_MAX_PER_DAY = 5;

  let lastSentAt = null;
  let sendCountToday = 0;

  try {
    const raw = await redisClient.get(key);
    if (raw) {
      const data = JSON.parse(raw);
      lastSentAt = typeof data.lastSentAt === "number" ? data.lastSentAt : null;
      sendCountToday =
        typeof data.sendCountToday === "number" ? data.sendCountToday : 0;

      if (lastSentAt) {
        const diff = now - lastSentAt;
        if (diff < RESEND_MIN_INTERVAL_MS) {
          throw new ApiError("Please wait before requesting another OTP", 429);
        }

        const lastDate = new Date(lastSentAt);
        const isSameDay =
          lastDate.getUTCFullYear() === new Date(now).getUTCFullYear() &&
          lastDate.getUTCMonth() === new Date(now).getUTCMonth() &&
          lastDate.getUTCDate() === new Date(now).getUTCDate();

        if (!isSameDay) {
          sendCountToday = 0;
        }
      }

      if (sendCountToday >= RESEND_MAX_PER_DAY) {
        throw new ApiError("Daily OTP resend limit reached", 429);
      }
    }
  } catch (err) {
    if (err instanceof ApiError) {
      throw err;
    }
    console.error("[Redis] GET error for guest OTP", err.message);
    throw new ApiError("OTP service is temporarily unavailable", 503);
  }

  sendCountToday += 1;

  const otp = generateOtp();
  const codeHash = crypto.createHash("sha256").update(otp).digest("hex");

  const expiresAt = now + 5 * 60 * 1000; // 5 minutes
  const payload = {
    codeHash,
    expiresAt,
    lastSentAt: now,
    sendCountToday,
  };

  try {
    await redisClient.set(key, JSON.stringify(payload), "EX", 5 * 60);
  } catch (err) {
    console.error("[Redis] SET error for guest OTP", err.message);
    throw new ApiError("OTP service is temporarily unavailable", 503);
  }

  try {
    await sendOtpSms(normalizedPhone, otp);
    console.log("guest otp:", otp);
  } catch (err) {
    console.error("Failed to send guest OTP SMS", err);
    throw new ApiError(
      "Failed to send verification SMS, please try again later",
      502
    );
  }

  return {
    phone: normalizedPhone,
    otp,
  };
}

export async function verifyGuestOtpService({ phone, otp }) {
  if (!phone || !otp) {
    throw new ApiError("phone and otp are required", 400);
  }

  let normalizedPhone;
  try {
    normalizedPhone = normalizeEgyptianMobile(phone);
  } catch (err) {
    throw new ApiError("Invalid Egyptian mobile format", 400);
  }

  const redisClient = getRedisClient();
  if (!redisClient || redisClient.status !== "ready") {
    throw new ApiError("OTP service is temporarily unavailable", 503);
  }

  const key = `guest:otp:${normalizedPhone}`;
  let data;

  try {
    const raw = await redisClient.get(key);
    if (!raw) {
      throw new ApiError("No active OTP, please request a new code", 400);
    }
    data = JSON.parse(raw);
  } catch (err) {
    if (err instanceof ApiError) {
      throw err;
    }
    console.error("[Redis] GET error for guest OTP", err.message);
    throw new ApiError("OTP service is temporarily unavailable", 503);
  }

  const expiresAt = typeof data.expiresAt === "number" ? data.expiresAt : 0;
  if (expiresAt < Date.now()) {
    try {
      await redisClient.del(key);
    } catch (err) {
      console.error("[Redis] DEL error for expired guest OTP", err.message);
    }
    throw new ApiError("OTP has expired", 400);
  }

  const expectedHash = data.codeHash;
  const providedHash = crypto
    .createHash("sha256")
    .update(String(otp))
    .digest("hex");

  if (!expectedHash || providedHash !== expectedHash) {
    throw new ApiError("Invalid OTP", 400);
  }

  try {
    await redisClient.del(key);
  } catch (err) {
    console.error("[Redis] DEL error for guest OTP", err.message);
  }

  return {
    phone: normalizedPhone,
    verified: true,
  };
}

export async function loginService({ identifier, password }) {
  if (!identifier || !password) {
    throw new ApiError("identifier and password are required", 400);
  }

  const trimmed = String(identifier).trim();

  const isEmail = /.+@.+\..+/.test(trimmed);
  let query = {};

  if (isEmail) {
    query = { email: trimmed.toLowerCase() };
  } else {
    // Treat identifier as phone
    let normalizedPhone;
    try {
      normalizedPhone = normalizeEgyptianMobile(trimmed);
    } catch {
      throw new ApiError(
        "Identifier must be a valid email or Egyptian phone number",
        400
      );
    }
    query = { phone: normalizedPhone };
  }

  const user = await UserModel.findOne(query).select("+password");

  if (!user || !(await bcrypt.compare(password, user.password))) {
    throw new ApiError("Incorrect email or password", 401);
  }

  if (!user.phoneVerified) {
    throw new ApiError("Please verify your phone first", 401);
  }

  if (user.account_status !== accountStatus.CONFIRMED) {
    throw new ApiError("Account is not confirmed", 401);
  }

  if (!user.active) {
    throw new ApiError(
      "Account has been deactivated. Contact customer support",
      401
    );
  }

  // Remove expired refresh tokens
  const now = Date.now();
  user.refreshTokens = user.refreshTokens.filter(
    (t) => !t.expiresAt || t.expiresAt.getTime() > now
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
  await user.save();

  return {
    user,
    accessToken,
    refreshToken,
    accessTokenExpires: new Date(Date.now() + 3 * 60 * 60 * 1000),
  };
}

export async function refreshTokenService({ refreshToken }) {
  if (!refreshToken) {
    throw new ApiError("Unauthorized", 401);
  }

  let decoded;
  try {
    decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch (err) {
    throw new ApiError("Invalid refresh token", 401);
  }

  const user = await UserModel.findById(decoded.userId);

  if (!user) {
    throw new ApiError("User not found", 401);
  }

  // Remove expired refresh tokens
  const now = Date.now();
  user.refreshTokens = user.refreshTokens.filter(
    (t) => !t.expiresAt || t.expiresAt.getTime() > now
  );

  const hashedProvidedToken = crypto
    .createHash("sha256")
    .update(refreshToken)
    .digest("hex");

  const validToken = user.refreshTokens.find(
    (t) => t.token === hashedProvidedToken
  );

  if (!validToken) {
    throw new ApiError("Invalid refresh token", 401);
  }

  const newAccessToken = createAccessToken(user._id, user.role);
  const newRefreshToken = createRefreshToken(user._id);

  user.refreshTokens = user.refreshTokens.filter(
    (t) => t.token !== validToken.token
  );

  const newHashedRefreshToken = crypto
    .createHash("sha256")
    .update(newRefreshToken)
    .digest("hex");

  user.refreshTokens.push({
    token: newHashedRefreshToken,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  await user.save();

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    accessTokenExpires: new Date(Date.now() + 3 * 60 * 60 * 1000),
  };
}

export async function logoutService({ userId, refreshToken }) {
  if (!refreshToken) {
    throw new ApiError("No active session to logout", 400);
  }

  const user = await UserModel.findById(userId);

  if (!user) {
    throw new ApiError("User not found", 404);
  }

  // Remove provided refresh token from stored list (single session logout)
  const hashedProvidedToken = crypto
    .createHash("sha256")
    .update(refreshToken)
    .digest("hex");

  const beforeCount = user.refreshTokens.length;

  user.refreshTokens = user.refreshTokens.filter(
    (t) => t.token !== hashedProvidedToken
  );

  if (user.refreshTokens.length === beforeCount) {
    // No matching stored token; treat as already logged out
    return;
  }

  await user.save();
}

export async function forgetPasswordService({ email }) {
  if (!email) {
    throw new ApiError("email is required", 400);
  }

  const user = await UserModel.findOne({ email: email.toLowerCase() });

  if (!user) {
    throw new ApiError(`No user found for this email: ${email}`, 404);
  }

  const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
  const hashedResetCode = crypto
    .createHash("sha256")
    .update(resetCode)
    .digest("hex");

  user.passwordResetCode = hashedResetCode;
  user.passwordResetCodeExpire = Date.now() + 20 * 60 * 1000; // 20 minutes
  user.passwordResetCodeVerified = false;

  await user.save();

  const firstName = (user.name || "").split(" ")[0] || "there";
  const capitalizedName =
    firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();

  // try {
  //   await sendEmail({
  //     email: user.email,
  //     subject: `${capitalizedName}, here is your reset code`,
  //     message: forgetPasswordEmailHTML(capitalizedName, resetCode),
  //   });
  // } catch (error) {
  //   user.passwordResetCode = undefined;
  //   user.passwordResetCodeExpire = undefined;
  //   user.passwordResetCodeVerified = undefined;
  //   await user.save();
  //   throw new ApiError("Sending email failed", 500);
  // }

  return {
    email: user.email,
    resetCode,
  };
}

export async function verifyPasswordResetCodeService({ resetCode }) {
  if (!resetCode) {
    throw new ApiError("resetCode is required", 400);
  }

  const hashedResetCode = crypto
    .createHash("sha256")
    .update(String(resetCode))
    .digest("hex");

  const user = await UserModel.findOne({
    passwordResetCode: hashedResetCode,
    passwordResetCodeExpire: { $gt: Date.now() },
  });

  if (!user) {
    throw new ApiError("Reset code is invalid or expired", 400);
  }

  user.passwordResetCodeVerified = true;
  await user.save();
}

export async function resetPasswordService({ email, newPassword }) {
  if (!email || !newPassword) {
    throw new ApiError("email and newPassword are required", 400);
  }

  const user = await UserModel.findOne({ email: email.toLowerCase() });

  if (!user) {
    throw new ApiError(`No user found with email ${email}`, 404);
  }

  if (!user.passwordResetCodeVerified) {
    throw new ApiError("Reset code not verified", 400);
  }

  user.password = newPassword;
  user.passwordChangedAT = Date.now();
  user.passwordResetCode = undefined;
  user.passwordResetCodeExpire = undefined;
  user.passwordResetCodeVerified = undefined;

  // Invalidate all previous refresh tokens
  user.refreshTokens = [];

  await user.save();

  return;
}
