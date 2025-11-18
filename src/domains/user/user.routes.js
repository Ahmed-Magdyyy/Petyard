// src/domains/user/user.routes.js
import { Router } from "express";
import {
  getUsers,
  getUser,
  createUser,
  updateUser,
  updateUserPassword,
  deleteUser,
  toggleUserActive,
  getLoggedUser,
  updateLoggedUserPassword,
  updateLoggedUserData,
  deactivateLoggedUser,
} from "./user.controller.js";
import { protect, allowedTo, enabledControls as enabledControlsMiddleware } from "../auth/auth.middleware.js";
import { roles, enabledControls as enabledControlsEnum } from "../../shared/constants/enums.js";
import {
  createUserValidator,
  updateUserValidator,
  updateUserPasswordByAdminValidator,
  updateLoggedUserPasswordValidator,
  updateLoggedUserDataValidator,
  updateUserActiveValidator,
} from "./user.validators.js";

const router = Router();

// ----- Logged-in User Routes -----

router.get("/me", protect, getLoggedUser);
router.patch("/me/password", protect, updateLoggedUserPasswordValidator, updateLoggedUserPassword);
router.patch("/me", protect, updateLoggedUserDataValidator, updateLoggedUserData);
router.delete("/me", protect, deactivateLoggedUser);

// ----- Admin Routes -----
router.use(protect, allowedTo(roles.ADMIN, roles.SUPER_ADMIN), enabledControlsMiddleware(enabledControlsEnum.USERS));

router.route("/")
  .get(getUsers)
  .post(createUserValidator, createUser);

router.route("/:id")
  .get(getUser)
  .patch(updateUserValidator, updateUser)
  .delete(deleteUser);

router.patch("/:id/password", updateUserPasswordByAdminValidator, updateUserPassword);

router.patch("/:id/toggle-active", updateUserActiveValidator, toggleUserActive);

export default router;
