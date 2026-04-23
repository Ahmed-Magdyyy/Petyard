import { BankAccountModel } from "./bankAccount.model.js";
import { ApiError } from "../../shared/utils/ApiError.js";

export async function getBankAccountsService() {
  const accounts = await BankAccountModel.find({}).sort({ createdAt: -1 });

  return accounts.map((a) => ({
    id: a._id,
    bankName: a.bankName,
    accountName: a.accountName,
    accountNumber: a.accountNumber,
  }));
}

export async function getBankAccountByIdService(id) {
  const account = await BankAccountModel.findById(id);
  if (!account) {
    throw new ApiError(`No bank account found for this id: ${id}`, 404);
  }

  return {
    id: account._id,
    bankName: account.bankName,
    accountName: account.accountName,
    accountNumber: account.accountNumber,
  };
}

export async function createBankAccountService(payload) {
  const { bankName, accountName, accountNumber } = payload;

  const existingAccount = await BankAccountModel.findOne({ bankName, accountNumber });
  if (existingAccount) {
    throw new ApiError(`A bank account with number ${accountNumber} at ${bankName} already exists`, 409);
  }

  const account = await BankAccountModel.create({
    bankName,
    accountName,
    accountNumber,
  });

  return account;
}

export async function updateBankAccountService(id, payload) {
  const account = await BankAccountModel.findById(id);
  if (!account) {
    throw new ApiError(`No bank account found for this id: ${id}`, 404);
  }

  const { bankName, accountName, accountNumber } = payload;

  if (bankName !== undefined || accountNumber !== undefined) {
    const checkBankName = bankName !== undefined ? bankName : account.bankName;
    const checkAccountNumber = accountNumber !== undefined ? accountNumber : account.accountNumber;
    
    const existingAccount = await BankAccountModel.findOne({ 
      _id: { $ne: id },
      bankName: checkBankName, 
      accountNumber: checkAccountNumber 
    });
    
    if (existingAccount) {
      throw new ApiError(`A bank account with number ${checkAccountNumber} at ${checkBankName} already exists`, 409);
    }
  }

  if (bankName !== undefined) account.bankName = bankName;
  if (accountName !== undefined) account.accountName = accountName;
  if (accountNumber !== undefined) account.accountNumber = accountNumber;

  const updated = await account.save();
  return updated;
}

export async function deleteBankAccountService(id) {
  const account = await BankAccountModel.findById(id);
  if (!account) {
    throw new ApiError(`No bank account found for this id: ${id}`, 404);
  }

  await BankAccountModel.deleteOne({ _id: id });
}
