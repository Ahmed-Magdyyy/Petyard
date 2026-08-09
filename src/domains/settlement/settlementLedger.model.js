import mongoose from 'mongoose';
import {
  settlementOperationKindEnum,
  settlementOperationStatusEnum,
} from '../../shared/constants/enums.js';

const { Schema, model } = mongoose;

const settlementLedgerSchema = new Schema(
  {
    // The idempotency boundary for a single settlement side effect.
    operationId: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    order: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      index: true,
    },
    request: {
      type: Schema.Types.ObjectId,
      ref: 'SubstitutionRequest',
      index: true,
    },
    kind: {
      type: String,
      enum: Object.values(settlementOperationKindEnum),
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: Object.values(settlementOperationStatusEnum),
      default: settlementOperationStatusEnum.PENDING,
      required: true,
      index: true,
    },
    amountPiastres: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      default: 'EGP',
    },
    actor: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    providerReference: {
      type: String,
      trim: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
  },
  { timestamps: true },
);

settlementLedgerSchema.index({ order: 1, createdAt: -1 });
settlementLedgerSchema.index({ request: 1, createdAt: -1 });

export const SettlementLedgerModel = model('SettlementLedger', settlementLedgerSchema);
