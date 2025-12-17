import { Router } from "express";
import { protect, allowedTo } from "../auth/auth.middleware.js";
import { roles } from "../../shared/constants/enums.js";
import {
  getLoyaltySettings,
  updateLoyaltySettings,
  redeemLoyaltyPoints,
  getLoyaltyTransactions,
  getLoyaltyTransactionsForAdmin,
} from "./loyalty.controller.js";
import { updateLoyaltySettingsValidator } from "./loyalty.validators.js";

const router = Router();

router.get("/settings", getLoyaltySettings);

router.put(
  "/settings",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  updateLoyaltySettingsValidator,
  updateLoyaltySettings
);

router.post(
  "/redeem",
  protect,
  // allowedTo(roles.USER),
  redeemLoyaltyPoints
);

router.get(
  "/transactions",
  protect,
  getLoyaltyTransactions
);

router.get(
  "/admin/:userId/transactions",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  getLoyaltyTransactionsForAdmin
);

export default router;
