import mongoose from "mongoose";

const { Schema, model } = mongoose;

const petSchema = new Schema(
  {
    petOwner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    type: { type: String, required: true }, // dog/cat/other
    breed: { type: String },
    gender: { type: String }, // 'male' | 'female' | 'unknown'
    birthDate: { type: Date },
    chronic_conditions: { type: [String], default: [] }, // array of condition codes
    temp_health_issues: { type: [String], default: [] }, // array of condition codes
    image: {
      public_id: { type: String },
      url: { type: String },
    },
  },
  { timestamps: true }
);

petSchema.index({ petOwner: 1 });
petSchema.index({ chronic_conditions: 1 });
petSchema.index({ temp_health_issues: 1 });

export const PetModel = model("Pet", petSchema);
