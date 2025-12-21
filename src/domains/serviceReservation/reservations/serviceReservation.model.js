import mongoose from "mongoose";
import {
  serviceReservationStatusEnum,
  serviceRoomTypeEnum,
  serviceTypeEnum,
} from "../../../shared/constants/enums.js";

const { Schema, model } = mongoose;

const serviceReservationSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    guestId: {
      type: String,
      index: true,
    },
    location: {
      type: Schema.Types.ObjectId,
      ref: "ServiceLocation",
      required: true,
      index: true,
    },
    serviceType: {
      type: String,
      enum: Object.values(serviceTypeEnum),
      required: true,
      index: true,
    },
    serviceOptionKey: {
      type: String,
      trim: true,
      index: true,
    },
    serviceName_en: {
      type: String,
      trim: true,
    },
    serviceName_ar: {
      type: String,
      trim: true,
    },
    serviceOptionName_en: {
      type: String,
      trim: true,
    },
    serviceOptionName_ar: {
      type: String,
      trim: true,
    },
    roomType: {
      type: String,
      enum: Object.values(serviceRoomTypeEnum),
      required: true,
      index: true,
    },
    startsAt: {
      type: Date,
      required: true,
      index: true,
    },
    endsAt: {
      type: Date,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: Object.values(serviceReservationStatusEnum),
      default: serviceReservationStatusEnum.BOOKED,
      index: true,
    },
    cancelledAt: {
      type: Date,
    },
    servicePrice: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: "EGP",
    },
    pet: {
      type: Schema.Types.ObjectId,
      ref: "Pet",
      index: true,
    },
    ownerName: {
      type: String,
      required: true,
      trim: true,
    },
    ownerPhone: {
      type: String,
      required: true,
      trim: true,
    },
    petType: {
      type: String,
      required: true,
      trim: true,
    },
    petName: {
      type: String,
      required: true,
      trim: true,
    },
    petAge: {
      type: Number,
      required: true,
      min: 0,
    },
    petGender: {
      type: String,
      required: true,
      trim: true,
    },
    comment: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

serviceReservationSchema.index({ location: 1, startsAt: 1, status: 1 });
serviceReservationSchema.index({ user: 1, startsAt: 1, status: 1 });
serviceReservationSchema.index({ guestId: 1, startsAt: 1, status: 1 });

serviceReservationSchema.index(
  { user: 1, startsAt: 1 },
  {
    unique: true,
    partialFilterExpression: { status: serviceReservationStatusEnum.BOOKED },
  }
);
serviceReservationSchema.index(
  { guestId: 1, startsAt: 1 },
  {
    unique: true,
    partialFilterExpression: { status: serviceReservationStatusEnum.BOOKED },
  }
);

export const ServiceReservationModel = model(
  "ServiceReservation",
  serviceReservationSchema
);
