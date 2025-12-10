import mongoose from "mongoose";
import bcrypt from "bcrypt";
import {
  roles,
  accountStatus,
} from "../../shared/constants/enums.js";

const { Schema, model } = mongoose;

const userSchema = new Schema(
  {
    name: {
      type: String,
      trim: true,
      required: [true, "Name is required"],
      lowercase: true,
    },
    email: {
      type: String,
      unique: [true, "Email must be unique"],
      required: [true, "Email is required"],
      lowercase: true,
    },
    phone: {
      type: String,
      unique: [true, "Phone must be unique"],
      required: true,
    },

    phoneVerified: {
      type: Boolean,
      default: false,
    },
    phoneVerificationCode: String,
    phoneVerificationExpires: Date,
    phoneOtpLastSentAt: Date,
    phoneOtpSendCountToday: {
      type: Number,
      default: 0,
    },
    phoneLastChangedAt: Date,

    addresses: {
      type: [
        {
          label: String,
          name: String,
          governorate: String,
          area: String,
          phone: String,
          location: {
            lat: Number,
            lng: Number,
          },
          details: String,
          isDefault: { type: Boolean, default: false },
        },
      ],
      default: [],
    },

    walletBalance: {
      type: Number,
      default: 0,
    },

    loyaltyPoints: {
      type: Number,
      default: 0,
    },

    password: {
      type: String,
      minlength: [6, "Password must be at least 6 characters"],
      select: false,
    },

    passwordChangedAT: Date,
    passwordResetCode: String,
    passwordResetCodeExpire: Date,
    passwordResetCodeVerified: Boolean,

    role: {
      type: String,
      required: true,
      enum: Object.values(roles),
      default: roles.USER,
    },

    enabledControls: { type: [String] },

    account_status: {
      type: String,
      enum: Object.values(accountStatus),
      default: accountStatus.PENDING,
    },

    active: {
      type: Boolean,
      default: true,
    },

    refreshTokens: {
      type: [
        {
          token: { type: String, required: true },
          expiresAt: { type: Date, required: true },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: { timeZone: "UTC" },
    toJSON: {
      transform: (doc, ret) => {
        delete ret.__v;
        if (ret.role !== roles.ADMIN && ret.role !== roles.SUPER_ADMIN) {
          delete ret.enabledControls;
        }
        delete ret.password;
        delete ret.passwordResetCode;
        delete ret.passwordResetCodeExpire;
        delete ret.passwordResetCodeVerified;
        delete ret.phoneVerificationCode;
        delete ret.phoneVerificationExpires;
        return ret;
      },
    },
  }
);

userSchema.index({ role: 1 });
userSchema.index({ active: 1 });
userSchema.index({ "refreshTokens.expiresAt": 1 });

userSchema.pre("save", async function () {
  // In Mongoose 8+, async middleware should not use the next callback.
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 12);
});

export const UserModel = model("User", userSchema);
