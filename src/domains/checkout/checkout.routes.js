import { Router } from "express";
import { protect } from "../auth/auth.middleware.js";
import {
  getCheckoutSummaryForGuest,
  getCheckoutSummaryForUser,
} from "./checkout.controller.js";

const router = Router();

router.get("/guest/summary", getCheckoutSummaryForGuest);

router.get("/me/summary", protect, getCheckoutSummaryForUser);

export default router;
