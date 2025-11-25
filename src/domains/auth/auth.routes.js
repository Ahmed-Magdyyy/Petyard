// src/domains/auth/auth.routes.js
import { Router } from "express";
import {
  signup,
  resendOtp,
  verifyPhone,
  login,
  refreshToken,
  logout,
  forgetPassword,
  verifyPasswordResetCode,
  resetPassword,
} from "./auth.controller.js";
import {
  signupValidator,
  resendOtpValidator,
  verifyPhoneValidator,
  loginValidator,
  forgetPasswordValidator,
  verifyResetCodeValidator,
  resetPasswordValidator,
} from "./auth.validators.js";
import { authRateLimiter } from "../../shared/middlewares/rateLimitMiddleware.js";
import { protect } from "./auth.middleware.js";

const router = Router();

// Apply rate limiter to all auth routes
router.use(authRateLimiter);

// Auth routes
router.post(
  "/signup",
  (req, res, next) => {
    console.log(
      "DEBUG /auth/signup content-type:",
      req.headers["content-type"]
    );
    console.log("DEBUG /auth/signup body:", req.body);
    next();
  },
  signupValidator,
  signup
);
router.post("/resend-otp", resendOtpValidator, resendOtp);
router.post("/verify-phone", verifyPhoneValidator, verifyPhone);
router.post("/login", loginValidator, login);
router.post("/refresh-token", refreshToken);
router.post("/logout", protect, logout);
router.post("/forget-password", forgetPasswordValidator, forgetPassword);
router.post(
  "/verify-reset-code",
  verifyResetCodeValidator,
  verifyPasswordResetCode
);
router.post("/reset-password", resetPasswordValidator, resetPassword);

export default router;
