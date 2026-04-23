import mongoose from "mongoose";

const { Schema, model } = mongoose;

const bankAccountSchema = new Schema(
  {
    bankName: {
      type: String,
      required: true,
      trim: true,
    },
    accountName: {
      type: String,
      required: true,
      trim: true,
    },
    accountNumber: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { timestamps: true }
);

export const BankAccountModel = model("BankAccount", bankAccountSchema);
