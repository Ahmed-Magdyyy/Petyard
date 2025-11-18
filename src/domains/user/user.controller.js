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
  deactivateLoggedUserService,
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
    .status(204)
    .json({ message: "user deleted successfully", deletedUser });
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
  const { name, email, phone } = req.body;

  const updatedUser = await updateLoggedUserDataService({
    userId: req.user._id,
    name,
    email,
    phone,
  });

  res.status(200).json({ data: updatedUser });
});

// DELETE /users/me
export const deactivateLoggedUser = asyncHandler(async (req, res) => {
  const deletedUser = await deactivateLoggedUserService({ userId: req.user._id });

  res.status(204).json({ message: "Success", userDeleted: deletedUser });
});
