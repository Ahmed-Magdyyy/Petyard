// src/domains/user/user.controller.js
import asyncHandler from "express-async-handler";
import {
  getUsersService,
  getUserByIdService,
  createUserService,
  updateUserService,
  updateUserPasswordByAdminService,
  deleteUserService,
  toggleUserActiveService,
  getLoggedUserService,
  updateLoggedUserPasswordService,
  updateLoggedUserDataService,
  deleteLoggedUserService,
  getMyAddressesService,
  addMyAddressService,
  updateMyAddressService,
  deleteMyAddressService,
  setDefaultMyAddressService,
} from "./user.service.js";

// ----- Admin Controllers -----

// GET /users
export const getUsers = asyncHandler(async (req, res) => {
  const result = await getUsersService(req.query);
  res.status(200).json(result);
});

// GET /users/:id
export const getUser = asyncHandler(async (req, res) => {
  const user = await getUserByIdService(req.params.id);
  res.status(200).json({ message: "Success", data: user });
});

// POST /users
export const createUser = asyncHandler(async (req, res) => {
  const doc = await createUserService(req.body);
  res.status(201).json({ message: "Success", data: doc });
});

// PATCH /users/:id
export const updateUser = asyncHandler(async (req, res) => {
  const updatedUser = await updateUserService(req.params.id, req.body);
  res.status(200).json({ data: updatedUser });
});

// PATCH /users/:id/password
export const updateUserPassword = asyncHandler(async (req, res) => {
  const { password } = req.body;
  const updatedUser = await updateUserPasswordByAdminService(
    req.params.id,
    password
  );

  res.status(200).json({ data: updatedUser });
});

// DELETE /users/:id
export const deleteUser = asyncHandler(async (req, res) => {
  const deletedUser = await deleteUserService(req.params.id);
  res
    .status(200)
    .json({ message: "user deleted successfully" });
});

// PATCH /users/:id/toggle-active
export const toggleUserActive = asyncHandler(async (req, res) => {
  const updatedUser = await toggleUserActiveService(req.params.id);
  res.status(200).json({message: "user active status changed successfully", data: updatedUser });
});

// ----- Logged-in User Controllers -----

// GET /users/me
export const getLoggedUser = asyncHandler(async (req, res) => {
  const user = await getLoggedUserService(req.user);
  res.status(200).json({ data: user });
});

// PATCH /users/me/password
export const updateLoggedUserPassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  const updatedUser = await updateLoggedUserPasswordService({
    userId: req.user._id,
    currentPassword,
    newPassword,
  });

  res
    .status(200)
    .json({ message: "password changed successfully", data: updatedUser });
});

// PATCH /users/me
export const updateLoggedUserData = asyncHandler(async (req, res) => {
  const { name, email } = req.body;

  const updatedUser = await updateLoggedUserDataService({
    userId: req.user._id,
    name,
    email,
    file: req.file || null,
  });

  res.status(200).json({ data: updatedUser });
});

// DELETE /users/me
export const deleteLoggedUser = asyncHandler(async (req, res) => {
  const deletedUser = await deleteLoggedUserService({ userId: req.user._id });

  res.status(200).json({ message: "Success", userDeleted: deletedUser });
});

// ----- Logged-in User Addresses -----

export const getMyAddresses = asyncHandler(async (req, res) => {
  const addresses = await getMyAddressesService({ userId: req.user._id });
  res.status(200).json({ data: addresses });
});

export const addMyAddress = asyncHandler(async (req, res) => {
  const addresses = await addMyAddressService({
    userId: req.user._id,
    payload: req.body,
  });

  res.status(201).json({ data: addresses });
});

export const updateMyAddress = asyncHandler(async (req, res) => {
  const addresses = await updateMyAddressService({
    userId: req.user._id,
    addressId: req.params.addressId,
    payload: req.body,
  });

  res.status(200).json({ data: addresses });
});

export const deleteMyAddress = asyncHandler(async (req, res) => {
  const addresses = await deleteMyAddressService({
    userId: req.user._id,
    addressId: req.params.addressId,
  });

  res.status(200).json({ data: addresses });
});

export const setDefaultMyAddress = asyncHandler(async (req, res) => {
  const addresses = await setDefaultMyAddressService({
    userId: req.user._id,
    addressId: req.params.addressId,
  });

  res.status(200).json({ data: addresses });
});
