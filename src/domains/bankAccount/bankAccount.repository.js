import { BankAccountModel } from "./bankAccount.model.js";

export function bankAccountExists(filter = {}) {
  return BankAccountModel.exists(filter);
}
