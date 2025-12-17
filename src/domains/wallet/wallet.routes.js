import { Router } from "express";
import { protect, allowedTo } from "../auth/auth.middleware.js";
import { roles } from "../../shared/constants/enums.js";
import { getWalletTransactions, getWalletTransactionsForAdmin } from "./wallet.controller.js";

const router = Router();

router.get(
  "/transactions",
  protect,
  getWalletTransactions
);

router.get(
  "/admin/:userId/transactions",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  getWalletTransactionsForAdmin
);

export default router;
