import { Router } from "express";
import {
  protect,
  allowedTo,
  enabledControls as enabledControlsMiddleware,
} from "../auth/auth.middleware.js";
import {
  roles,
  enabledControls as enabledControlsEnum,
} from "../../shared/constants/enums.js";
import {
  adjustWalletBalanceForAdmin,
  getWalletTransactions,
  getWalletTransactionsForAdmin,
} from "./wallet.controller.js";
import { adjustWalletBalanceValidator } from "./wallet.validators.js";

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
  enabledControlsMiddleware(enabledControlsEnum.WALLET),
  getWalletTransactionsForAdmin
);

router.post(
  "/admin/:userId/adjust",
  protect,
  allowedTo(roles.SUPER_ADMIN, roles.ADMIN),
  enabledControlsMiddleware(enabledControlsEnum.WALLET),
  adjustWalletBalanceValidator,
  adjustWalletBalanceForAdmin
);

export default router;
