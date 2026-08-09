import mongoose from "mongoose";
import { inventoryAuditReasonEnum } from "../../shared/constants/enums.js";

const { Schema, model } = mongoose;

const inventoryAuditSchema = new Schema(
  {
    operationId: { type: String, required: true, trim: true },
    skuKey: { type: String, required: true, trim: true },
    action: {
      type: String,
      enum: Object.values(inventoryAuditReasonEnum),
      required: true,
    },
    product: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    variantId: { type: Schema.Types.ObjectId },
    warehouse: {
      type: Schema.Types.ObjectId,
      ref: "Warehouse",
      required: true,
      index: true,
    },
    quantity: { type: Number, required: true, min: 1 },
    quantityBefore: { type: Number, required: true, min: 0 },
    quantityAfter: { type: Number, required: true, min: 0 },
    revisionBefore: { type: Number, required: true, min: 0 },
    revisionAfter: { type: Number, required: true, min: 0 },
    actor: { type: Schema.Types.ObjectId, ref: "User" },
    order: { type: Schema.Types.ObjectId, ref: "Order" },
    request: { type: Schema.Types.ObjectId, ref: "SubstitutionRequest" },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

inventoryAuditSchema.index(
  { operationId: 1, skuKey: 1, action: 1 },
  { unique: true },
);
inventoryAuditSchema.index({ warehouse: 1, createdAt: -1 });
inventoryAuditSchema.index({ order: 1, createdAt: -1 });
inventoryAuditSchema.index({ request: 1, createdAt: -1 });

export const InventoryAuditModel = model("InventoryAudit", inventoryAuditSchema);
