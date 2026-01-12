/**
 * Service Review Model
 * 
 * Allows users to rate and review completed service reservations.
 * One review per reservation, only for COMPLETED status.
 */

import mongoose from "mongoose";

const { Schema, model } = mongoose;

const serviceReviewSchema = new Schema(
  {
    reservation: {
      type: Schema.Types.ObjectId,
      ref: "ServiceReservation",
      required: true,
      unique: true, // Ensures one review per reservation
      index: true,
    },

    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },

    guestId: {
      type: String,
      index: true,
    },

    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },

    comment: {
      type: String,
      trim: true,
      maxlength: 250,
    },

    // Denormalized fields for efficient queries and aggregation
    location: {
      type: Schema.Types.ObjectId,
      ref: "ServiceLocation",
      required: true,
      index: true,
    },

    serviceType: {
      type: String,
      required: true,
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
  },
  { timestamps: true }
);

// Compound indexes for common queries
serviceReviewSchema.index({ location: 1, createdAt: -1 });
serviceReviewSchema.index({ user: 1, createdAt: -1 });
serviceReviewSchema.index({ serviceType: 1, createdAt: -1 });

export const ServiceReviewModel = model("ServiceReview", serviceReviewSchema);
