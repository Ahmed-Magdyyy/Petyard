import mongoose from "mongoose";

const addressSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    guestId: {
      type: String,
      default: null,
      index: true,
    },
    label: String,
    name: {
      type: String,
      required: [true, "Name is required"],
    },
    governorate: {
      type: String,
      required: [true, "Governorate is required"],
    },
    area: {
      type: String,
    },
    phone: {
      type: String,
      required: [true, "Phone is required"],
    },
    building: {
      type: String,
      required: [true, "Building is required"],
    },
    floor: {
      type: String,
      required: [true, "Floor is required"],
    },
    apartment: {
      type: String,
      required: [true, "Apartment number is required"],
    },
    location: {
      lat: Number,
      lng: Number,
    },
    details: {
      type: String,
      required: [true, "Details is required"],
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

export const AddressModel = mongoose.model("Address", addressSchema);
