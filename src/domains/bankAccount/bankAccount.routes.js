import { Router } from "express";
import {
  getBankAccounts,
  getBankAccount,
  createBankAccount,
  updateBankAccount,
  deleteBankAccount,
} from "./bankAccount.controller.js";
import { protect, allowedTo } from "../auth/auth.middleware.js";
import { roles } from "../../shared/constants/enums.js";
import {
  createBankAccountValidator,
  updateBankAccountValidator,
  bankAccountIdParamValidator,
} from "./bankAccount.validators.js";

const router = Router();

// Public routes — used by payment page to show bank details for instapay
router.get("/", getBankAccounts);
router.get("/:id", bankAccountIdParamValidator, getBankAccount);

// SuperAdmin-only routes
router.use(protect, allowedTo(roles.SUPER_ADMIN));

router.post("/", createBankAccountValidator, createBankAccount);
router.patch("/:id", updateBankAccountValidator, updateBankAccount);
router.delete("/:id", bankAccountIdParamValidator, deleteBankAccount);

export default router;
