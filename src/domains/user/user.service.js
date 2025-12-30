import bcrypt from "bcrypt";
import crypto from "crypto";
import { UserModel } from "./user.model.js";
import { ApiError } from "../../shared/utils/ApiError.js";
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
import {
  validateImageFile,
  uploadImageToCloudinary,
  deleteImageFromCloudinary,
} from "../../shared/utils/imageUpload.js";
import { PetModel } from "../pet/pet.model.js";

const DEFAULT_USER_AVATAR_URL =
  "https://res.cloudinary.com/dx5n4ekk2/image/upload/v1767069108/petyard/users/user_default_avatar_2.svg";

// Admin services

export async function getUsersService(queryParams) {
  const { page, limit, ...query } = queryParams;

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

  if (user.deletedAt) {
    user.active = false;
    user.refreshTokens = [];
    const alreadyDeletedUser = await user.save();
    return alreadyDeletedUser;
  }

  const oldAvatarPublicId = user.image?.public_id || null;

  user.deletedAt = new Date();
  user.active = false;
  user.refreshTokens = [];

  user.name = `deleted_user_${String(user._id)}`;
  user.email = null;
  user.phone = null;

  user.signupProvider = undefined;
  user.authProviders = [];

  user.phoneVerified = false;
  user.phoneVerificationCode = undefined;
  user.phoneVerificationExpires = undefined;
  user.phoneOtpLastSentAt = undefined;
  user.phoneOtpSendCountToday = 0;
  user.phoneLastChangedAt = undefined;
  user.pendingPhone = undefined;
  user.pendingPhoneVerificationCode = undefined;
  user.pendingPhoneVerificationExpires = undefined;
  user.pendingPhoneOtpLastSentAt = undefined;
  user.pendingPhoneOtpSendCountToday = 0;

  user.addresses = [];

  user.image = {
    public_id: null,
    url: DEFAULT_USER_AVATAR_URL,
  };

  const deletedUser = await user.save();

  if (oldAvatarPublicId) {
    await deleteImageFromCloudinary(oldAvatarPublicId);
  }

  await PetModel.deleteMany({ petOwner: id });

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
  file,
}) {
  const user = await UserModel.findById(userId);
  if (!user) {
    throw new ApiError("User not found", 404);
  }

  if (name !== undefined) user.name = name;
  if (email !== undefined) user.email = email;

  if (file) {
    validateImageFile(file);

    const oldPublicId = user.image?.public_id || null;

    const uploaded = await uploadImageToCloudinary(file, {
      folder: "petyard/users",
      publicId: `user_${String(user._id)}_${Date.now()}`,
    });

    user.image = uploaded;

    if (oldPublicId) {
      await deleteImageFromCloudinary(oldPublicId);
    }
  }

  const updatedUser = await user.save();
  return updatedUser;
}

export async function getMyAddressesService({ userId }) {
  const user = await UserModel.findById(userId);
  if (!user) {
    throw new ApiError("User not found", 404);
  }

  const addresses = Array.isArray(user.addresses) ? user.addresses : [];
  return addresses;
}

export async function addMyAddressService({ userId, payload }) {
  const user = await UserModel.findById(userId);
  if (!user) {
    throw new ApiError("User not found", 404);
  }

  if (!Array.isArray(user.addresses)) {
    user.addresses = [];
  }

  const {
    label,
    name,
    governorate,
    area,
    phone,
    location,
    details,
    isDefault,
  } = payload;

  const newAddress = {
    label: label !== undefined ? label : undefined,
    name: name ? name : user.name,
    governorate,
    area,
    phone: phone ? phone : user.phone,
    location:
      location && typeof location === "object" && location !== null
        ? {
            lat: location.lat,
            lng: location.lng,
          }
        : undefined,
    details,
    isDefault: isDefault === true,
  };

  if (user.addresses.length === 0 && newAddress.isDefault !== true) {
    newAddress.isDefault = true;
  }

  if (newAddress.isDefault) {
    user.addresses.forEach((addr) => {
      addr.isDefault = false;
    });
  }

  user.addresses.push(newAddress);

  const savedUser = await user.save();
  const addresses = Array.isArray(savedUser.addresses)
    ? savedUser.addresses
    : [];
  return addresses;
}

export async function updateMyAddressService({ userId, addressId, payload }) {
  const user = await UserModel.findById(userId);
  if (!user) {
    throw new ApiError("User not found", 404);
  }

  if (!Array.isArray(user.addresses)) {
    user.addresses = [];
  }

  const address = user.addresses.id(addressId);
  if (!address) {
    throw new ApiError("Address not found for this user", 404);
  }

  const { label, name, governorate, area, phone, location, details } = payload;

  if (label !== undefined) address.label = label;
  if (name !== undefined) address.name = name;
  if (governorate !== undefined) address.governorate = governorate;
  if (area !== undefined) address.area = area;
  if (phone !== undefined) address.phone = phone;
  if (details !== undefined) address.details = details;
  if (location !== undefined) {
    if (location && typeof location === "object") {
      address.location = {
        lat: location.lat,
        lng: location.lng,
      };
    } else {
      address.location = undefined;
    }
  }

  const savedUser = await user.save();
  const addresses = Array.isArray(savedUser.addresses)
    ? savedUser.addresses
    : [];
  return addresses;
}

export async function deleteMyAddressService({ userId, addressId }) {
  const user = await UserModel.findById(userId);
  if (!user) {
    throw new ApiError("User not found", 404);
  }

  if (!Array.isArray(user.addresses)) {
    user.addresses = [];
  }

  const address = user.addresses.id(addressId);
  if (!address) {
    throw new ApiError("Address not found for this user", 404);
  }

  const wasDefault = address.isDefault === true;

  address.deleteOne();

  if (wasDefault && user.addresses.length > 0) {
    user.addresses[0].isDefault = true;
  }

  const savedUser = await user.save();
  const addresses = Array.isArray(savedUser.addresses)
    ? savedUser.addresses
    : [];
  return addresses;
}

export async function setDefaultMyAddressService({ userId, addressId }) {
  const user = await UserModel.findById(userId);
  if (!user) {
    throw new ApiError("User not found", 404);
  }

  if (!Array.isArray(user.addresses)) {
    user.addresses = [];
  }

  const address = user.addresses.id(addressId);
  if (!address) {
    throw new ApiError("Address not found for this user", 404);
  }

  user.addresses.forEach((addr) => {
    addr.isDefault = String(addr._id) === String(address._id);
  });

  const savedUser = await user.save();
  const addresses = Array.isArray(savedUser.addresses)
    ? savedUser.addresses
    : [];
  return addresses;
}

export async function deleteLoggedUserService({ userId }) {
  const user = await UserModel.findById(userId);
  if (!user) {
    throw new ApiError("User not found", 404);
  }

  if (user.deletedAt) {
    user.active = false;
    user.refreshTokens = [];
    const alreadyDeletedUser = await user.save();
    return alreadyDeletedUser;
  }

  const oldAvatarPublicId = user.image?.public_id || null;

  user.deletedAt = new Date();
  user.active = false;
  user.refreshTokens = [];

  user.name = `deleted_user_${String(user._id)}`;
  user.email = null;
  user.phone = null;

  user.signupProvider = undefined;
  user.authProviders = [];

  user.phoneVerified = false;
  user.phoneVerificationCode = undefined;
  user.phoneVerificationExpires = undefined;
  user.phoneOtpLastSentAt = undefined;
  user.phoneOtpSendCountToday = 0;
  user.phoneLastChangedAt = undefined;
  user.pendingPhone = undefined;
  user.pendingPhoneVerificationCode = undefined;
  user.pendingPhoneVerificationExpires = undefined;
  user.pendingPhoneOtpLastSentAt = undefined;
  user.pendingPhoneOtpSendCountToday = 0;

  user.addresses = [];

  user.image = {
    public_id: null,
    url: DEFAULT_USER_AVATAR_URL,
  };

  const deletedUser = await user.save();

  if (oldAvatarPublicId) {
    await deleteImageFromCloudinary(oldAvatarPublicId);
  }

  await PetModel.deleteMany({ petOwner: userId });

  return deletedUser;
}
