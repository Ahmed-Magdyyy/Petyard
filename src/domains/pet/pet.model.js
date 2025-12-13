import mongoose from "mongoose";

const { Schema, model } = mongoose;

const petSchema = new Schema(
  {
    petOwner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    type: { type: String, required: true },
    breed: { type: String },
    gender: { type: String },
    birthDate: { type: Date },
    chronic_conditions: { type: [String], default: [] },
    temp_health_issues: { type: [String], default: [] },
    isDefault: { type: Boolean, default: false },
    image: {
      public_id: { type: String },
      url: { type: String },
    },
  },
  { timestamps: true }
);

petSchema.index({ petOwner: 1 });
petSchema.index(
  { petOwner: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } }
);
petSchema.index({ chronic_conditions: 1 });
petSchema.index({ temp_health_issues: 1 });

export const PetModel = model("Pet", petSchema);
