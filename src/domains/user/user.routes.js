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
  getMyAddresses,
  addMyAddress,
  updateMyAddress,
  deleteMyAddress,
  setDefaultMyAddress,
} from "./user.controller.js";

import { oauthSendOtp, oauthVerifyPhone } from "../auth/auth.controller.js";
import { protect, allowedTo, enabledControls as enabledControlsMiddleware } from "../auth/auth.middleware.js";
import { roles, enabledControls as enabledControlsEnum } from "../../shared/constants/enums.js";
import { oauthSendOtpValidator, oauthVerifyPhoneValidator } from "../auth/auth.validators.js";
import { uploadSingleImage } from "../../shared/middlewares/uploadMiddleware.js";
import {
  createUserValidator,
  updateUserValidator,
  updateUserPasswordByAdminValidator,
  updateLoggedUserPasswordValidator,
  updateLoggedUserDataValidator,
  updateUserActiveValidator,
  addressIdParamValidator,
  addMyAddressValidator,
  updateMyAddressValidator,
  setDefaultMyAddressValidator,
} from "./user.validators.js";

const router = Router();

// ----- Logged-in User Routes -----

router.get("/me", protect, getLoggedUser);
router.patch("/me/password", protect, updateLoggedUserPasswordValidator, updateLoggedUserPassword);
router.patch(
  "/me",
  protect,
  uploadSingleImage("image"),
  updateLoggedUserDataValidator,
  updateLoggedUserData
);
router.post("/me/phone/send-otp", protect, oauthSendOtpValidator, oauthSendOtp);
router.post("/me/phone/verify", protect, oauthVerifyPhoneValidator, oauthVerifyPhone);
router.delete("/me", protect, deactivateLoggedUser);

router.get("/me/addresses", protect, getMyAddresses);
router.post("/me/addresses", protect, addMyAddressValidator, addMyAddress);
router.patch(
  "/me/addresses/:addressId",
  protect,
  addressIdParamValidator,
  updateMyAddressValidator,
  updateMyAddress
);
router.delete(
  "/me/addresses/:addressId",
  protect,
  addressIdParamValidator,
  deleteMyAddress
);
router.patch(
  "/me/addresses/:addressId/default",
  protect,
  setDefaultMyAddressValidator,
  setDefaultMyAddress
);

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
