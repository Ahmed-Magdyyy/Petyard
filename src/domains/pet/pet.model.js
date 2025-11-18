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
    chronic_diseases: { type: String },
    temp_health_issues: { type: String },
  },
  { timestamps: true }
);

petSchema.index({ userId: 1 });

export const PetModel = model("Pet", petSchema);
