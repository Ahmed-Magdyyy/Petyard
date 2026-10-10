import { editorialCoverStateEnum } from "../../../shared/constants/enums.js";
import mongoose from "mongoose";

const { Schema, model } = mongoose;
const coverSchema = new Schema({
  videoId: { type: Schema.Types.ObjectId, ref: "Video", required: true, immutable: true },
  actorId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  storage: { type: new Schema({
    zone: { type: String, required: true, maxlength: 160, match: /^[^\\/?#\x00-\x1f]+$/, immutable: true },
    endpoint: { type: String, required: true, enum: ["https://storage.bunnycdn.com"], immutable: true },
    cdnBaseUrl: { type: String, required: true, maxlength: 2048, immutable: true,
      validate(value) { try { const url = new URL(value); return url.protocol === "https:" &&
        !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash; } catch { return false; } } },
  }, { _id: false, strict: "throw" }), required: true, immutable: true },
  state: { type: String, enum: Object.values(editorialCoverStateEnum),
    required: true, default: editorialCoverStateEnum.UPLOADING },
  referenceRevision: { type: Number, default: 0, required: true, min: 0 },
  descriptor: { type: new Schema({
    public_id: { type: String, required: true, match: /^petyard\/video-covers\/[a-f\d]{24}$/ },
    url: { type: String, required: true, maxlength: 2048, match: /^https:\/\/[^?#]+\.webp$/ },
  }, { _id: false, strict: "throw" }) },
  unattachedExpiresAt: { type: Date, required: true },
  uploadSettledAt: { type: Date },
  deletionRequestedAt: { type: Date },
  deletedAt: { type: Date },
}, { timestamps: true, strict: "throw" });

// Never TTL-delete unresolved media or its cleanup identity.
coverSchema.index({ state: 1, unattachedExpiresAt: 1 });
coverSchema.index({ videoId: 1, actorId: 1, createdAt: -1 });
export const EditorialCoverModel = model("EditorialCover", coverSchema);
