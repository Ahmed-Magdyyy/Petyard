import bcrypt from "bcrypt";
import crypto from "crypto";
import { UserModel } from "./user.model.js";
import { ApiError } from "../../shared/ApiError.js";
import {
  roles,
  enabledControls as enabledControlsEnum,
  accountStatus,
} from "../../shared/constants/enums.js";
import { normalizeEgyptianMobile, sendOtpSms } from "../../shared/utils/sms.js";
import {
  buildPagination,
  buildSort,
  buildRegexFilter,
} from "../../shared/utils/apiFeatures.js";

// Admin services

export async function getUsersService(queryParams) {
  const { page, limit, ...query } = queryParams;

  // Generic filters for all keys except 'role' and 'phone'
  const filter = buildRegexFilter(query, ["role", "phone"]);

  if (query.role) {
    const roleValue = String(query.role);
    filter.role = {
      $ne: roles.SUPER_ADMIN,
      ...(roleValue ? { $regex: roleValue, $options: "i" } : {}),
    };
  } else {
    filter.role = { $ne: roles.SUPER_ADMIN };
  }

  // Normalize phone filter if provided
  if (query.phone) {
    try {
      filter.phone = normalizeEgyptianMobile(query.phone);
    } catch {
      throw new ApiError("Invalid Egyptian mobile format", 400);
    }
  }

  const totalUsersCount = await UserModel.countDocuments(filter);

  const { pageNum, limitNum, skip } = buildPagination({ page, limit }, 10);
  const sort = buildSort(queryParams, "-createdAt");

  console.log(filter);

  const usersQuery = UserModel.find(filter).skip(skip).limit(limitNum);

  if (sort) {
    usersQuery.sort(sort);
  }

  const users = await usersQuery;

  const totalPages = Math.ceil(totalUsersCount / limitNum) || 1;

  return {
    totalPages,
    page: pageNum,
    results: users.length,
    data: users,
  };
}

export async function getUserByIdService(id) {
  const user = await UserModel.findById(id);
  if (!user) {
    throw new ApiError(`No user found for this id: ${id}`, 404);
  }
  return user;
}

export async function createUserService(payload) {
  if (payload.role === roles.SUPER_ADMIN) {
    throw new ApiError("Can't create a new super admin", 400);
  }

  let normalizedPhone = payload.phone;
  if (normalizedPhone) {
    normalizedPhone = normalizeEgyptianMobile(normalizedPhone);
  }

  const doc = await UserModel.create({
    ...payload,
    phone: normalizedPhone,
    phoneVerified: true,
    active: true,
    account_status: accountStatus.CONFIRMED,
  });

  return doc;
}

export async function updateUserService(id, payload) {
  const user = await UserModel.findById(id);
  if (!user) {
    throw new ApiError(`No user found for this id: ${id}`, 404);
  }

  const { name, email, phone, role, enabledControls } = payload;

  if (name !== undefined) user.name = name;
  if (email !== undefined) user.email = email;
  if (phone !== undefined) {
    user.phone = normalizeEgyptianMobile(phone);
  }
  if (role !== undefined) {
    user.role = role;
    if (role !== roles.ADMIN) {
      user.enabledControls = [];
    }
  }
  if (enabledControls !== undefined) {
    if (role === roles.ADMIN) {
      user.enabledControls = enabledControls;
    }
  }

  const updatedUser = await user.save();

  return updatedUser;
}

export async function updateUserPasswordByAdminService(id, newPassword) {
  const user = await UserModel.findById(id).select("+password");
  if (!user) {
    throw new ApiError(`No user found for this id: ${id}`, 404);
  }

  user.password = newPassword;
  user.passwordChangedAT = Date.now();
  user.refreshTokens = [];

  const updatedUser = await user.save();
  return updatedUser;
}

export async function deleteUserService(id) {
  const user = await UserModel.findById(id);
  if (!user) {
    throw new ApiError(`No user found for this id: ${id}`, 404);
  }

  if (user.role === roles.SUPER_ADMIN) {
    throw new ApiError("Super admin can't be deleted", 400);
  }

  const deletedUser = await UserModel.findByIdAndDelete(id);
  return deletedUser;
}

export async function toggleUserActiveService(id) {
  const user = await UserModel.findById(id);
  if (!user) {
    throw new ApiError(`No user found for this id: ${id}`, 404);
  }

  if (user.role === roles.SUPER_ADMIN) {
    throw new ApiError("Super admin status can't be toggled", 400);
  }

  const isDeactivating = user.active === true;
  user.active = !user.active;

  if (isDeactivating) {
    user.refreshTokens = [];
  }

  const updatedUser = await user.save();
  return updatedUser;
}

// Logged-in user services

export async function getLoggedUserService(currentUser) {
  return currentUser;
}

export async function updateLoggedUserPasswordService({
  userId,
  currentPassword,
  newPassword,
}) {
  const user = await UserModel.findById(userId).select("+password");
  if (!user) {
    throw new ApiError("User not found", 404);
  }

  const isMatch = await bcrypt.compare(currentPassword, user.password);
  if (!isMatch) {
    throw new ApiError("Current password is incorrect", 401);
  }

  user.password = newPassword;
  user.passwordChangedAT = Date.now();
  user.refreshTokens = [];

  const updatedUser = await user.save();

  return updatedUser;
}

export async function updateLoggedUserDataService({
  userId,
  name,
  email,
  phone,
}) {
  const user = await UserModel.findById(userId);
  if (!user) {
    throw new ApiError("User not found", 404);
  }

  if (name !== undefined) user.name = name;
  if (email !== undefined) user.email = email;
  if (phone !== undefined) {
    const normalizedNewPhone = normalizeEgyptianMobile(phone);

    if (normalizedNewPhone !== user.phone) {
      const cooldownDays = Number(process.env.PHONE_CHANGE_COOLDOWN_DAYS) || 30;
      const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;

      if (
        user.phoneLastChangedAt &&
        Date.now() - user.phoneLastChangedAt.getTime() < cooldownMs
      ) {
        throw new ApiError(
          `You can only change your phone number once every ${cooldownDays} days.`,
          400
        );
      }

      const otp = String(Math.floor(100000 + Math.random() * 900000));
      const hashedOtp = crypto.createHash("sha256").update(otp).digest("hex");

      // Try sending SMS to the *new* phone number first; if this fails, abort without mutating the user
      try {
        await sendOtpSms(normalizedNewPhone, otp);
        console.log("otp:", otp);
      } catch (err) {
        console.error("Failed to send OTP SMS after phone change", err);
        throw new ApiError(
          "Failed to send verification SMS, please try again later",
          502
        );
      }

      // Only reach here if SMS was sent successfully; now persist the new phone and verification state
      user.phone = normalizedNewPhone;
      user.phoneVerified = false;
      user.account_status = accountStatus.PENDING;
      user.phoneLastChangedAt = new Date();
      user.phoneVerificationCode = hashedOtp;
      user.phoneVerificationExpires = new Date(Date.now() + 5 * 60 * 1000);
      user.phoneOtpLastSentAt = new Date();
      user.phoneOtpSendCountToday = 1;
    }
  }

  const updatedUser = await user.save();
  return updatedUser;
}

export async function deactivateLoggedUserService({ userId }) {
  const user = await UserModel.findById(userId);
  if (!user) {
    throw new ApiError("User not found", 404);
  }

  user.active = false;
  user.refreshTokens = [];

  const deletedUser = await user.save();
  return deletedUser;
}
