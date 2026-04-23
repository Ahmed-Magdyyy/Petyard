import asyncHandler from "express-async-handler";
import {
  getBankAccountsService,
  getBankAccountByIdService,
  createBankAccountService,
  updateBankAccountService,
  deleteBankAccountService,
} from "./bankAccount.service.js";

// GET /bank-accounts
export const getBankAccounts = asyncHandler(async (req, res) => {
  const data = await getBankAccountsService();
  res.status(200).json({ data });
});

// GET /bank-accounts/:id
export const getBankAccount = asyncHandler(async (req, res) => {
  const data = await getBankAccountByIdService(req.params.id);
  res.status(200).json({ data });
});

// POST /bank-accounts
export const createBankAccount = asyncHandler(async (req, res) => {
  const account = await createBankAccountService(req.body);
  res.status(201).json({ data: account });
});

// PATCH /bank-accounts/:id
export const updateBankAccount = asyncHandler(async (req, res) => {
  const updated = await updateBankAccountService(req.params.id, req.body);
  res.status(200).json({ data: updated });
});

// DELETE /bank-accounts/:id
export const deleteBankAccount = asyncHandler(async (req, res) => {
  await deleteBankAccountService(req.params.id);
  res.status(200).json({ message: "Bank account deleted successfully" });
});
