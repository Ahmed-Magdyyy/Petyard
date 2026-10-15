import { editorialVideoKindEnum, editorialVideoStatusEnum, editorialReviewStatusEnum } from "../../../shared/constants/enums.js";
import mongoose from "mongoose";
import { MAX_VIDEO_PRODUCT_LINKS } from "./editorialProductLinks.validators.js";

const { Schema, model } = mongoose;

const commonContentFields = {
  productIds: { type: [{ type: Schema.Types.ObjectId, ref: "Product" }], default: () => [], required: true,
    validate: value => value.length <= MAX_VIDEO_PRODUCT_LINKS && new Set(value.map(String)).size === value.length },
  title_en: { type: String, required: true, trim: true, maxlength: 160 },
  title_ar: { type: String, required: true, trim: true, maxlength: 160 },
  description_en: { type: String, default: "", trim: true, maxlength: 2000 },
  description_ar: { type: String, default: "", trim: true, maxlength: 2000 },
};

const pendingContentFields = {
  // The default preserves validation of existing YouTube pending changes.
  kind: { type: String, enum: Object.values(editorialVideoKindEnum), required: true, default: editorialVideoKindEnum.YOUTUBE },
  youtubeId: { type: String, required() { return this.kind === editorialVideoKindEnum.YOUTUBE; },
    match: /^[A-Za-z0-9_-]{11}$/,
    validate: { validator(value) { return this.kind !== editorialVideoKindEnum.REEL || !value; },
      message: "Reel changes cannot reference YouTube media" } },
  ...commonContentFields,
  coverId: { type: Schema.Types.ObjectId, ref: "EditorialCover" },
};

const pendingChangeSchema = new Schema({
  authorId: { type: Schema.Types.ObjectId, required: true },
  status: { type: String, enum: Object.values(editorialReviewStatusEnum), required: true },
  content: { type: new Schema(pendingContentFields, { _id: false, strict: "throw" }), required: true },
  reviewReason: { type: String, maxlength: 500 },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
  submittedAt: { type: Date },
  reviewedAt: { type: Date },
  uploadSessionId: { type: Schema.Types.ObjectId, ref: "ReelUploadSession" },
  assetId: { type: Schema.Types.ObjectId, ref: "VideoAsset" },
  autoApplyWhenReady: { type: Boolean, default: false },
  nextPreviewProbeAt: { type: Date },
  rejectedAssetExpiresAt: { type: Date },
}, { _id: false, strict: "throw" });

const editorialVideoSchema = new Schema({
  kind: { type: String, enum: Object.values(editorialVideoKindEnum), required: true, immutable: true },
  ...commonContentFields,
  youtubeId: { type: String, match: /^[A-Za-z0-9_-]{11}$/,
    required() { return this.kind === editorialVideoKindEnum.YOUTUBE; } },
  activeAssetId: { type: Schema.Types.ObjectId, ref: "VideoAsset" },
  activeUploadSessionId: { type: Schema.Types.ObjectId, ref: "ReelUploadSession" },
  activeCoverId: { type: Schema.Types.ObjectId, ref: "EditorialCover" },
  status: { type: String, enum: Object.values(editorialVideoStatusEnum),
    required: true },
  authorId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  // Captured at creation so a later worker never infers approval authority
  // from the author's current role (which may have changed).
  autoPublishWhenReady: { type: Boolean, default: false, immutable: true },
  nextPreviewProbeAt: { type: Date },
  reviewerId: { type: Schema.Types.ObjectId },
  reviewedAt: { type: Date },
  reviewReason: { type: String, maxlength: 500 },
  publishedAt: { type: Date },
  unpublishedAt: { type: Date },
  position: { type: Number, min: 0, validate: (value) => value == null || Number.isSafeInteger(value) },
  // Dashboard arrangement only; publication never promotes it to public position.
  draftPosition: { type: Number, min: 0, validate: (value) => value == null || Number.isSafeInteger(value) },
  pendingChange: { type: pendingChangeSchema, default: null },
  revision: { type: Number, required: true, default: 0, min: 0 },
  // Save/cover reservation/delete fence, independent of editorial edits.
  associationRevision: { type: Number, default: 0, select: false },
}, { timestamps: true, strict: "throw" });

editorialVideoSchema.pre("validate", function validateEditorialMediaKind() {
  if (this.kind === editorialVideoKindEnum.REEL && this.youtubeId) {
    this.invalidate("youtubeId", "Reels cannot reference YouTube media");
  }
  if (this.kind === editorialVideoKindEnum.YOUTUBE && this.activeAssetId) {
    this.invalidate("activeAssetId", "YouTube Videos cannot own a Stream asset");
  }
  if (this.pendingChange?.content && this.pendingChange.content.kind !== this.kind) {
    this.invalidate("pendingChange.content.kind", "Pending change must match its Video kind");
  }
  if (this.kind === editorialVideoKindEnum.YOUTUBE && (this.pendingChange?.assetId || this.pendingChange?.uploadSessionId)) {
    this.invalidate("pendingChange", "YouTube changes cannot own a Stream replacement");
  }
});

editorialVideoSchema.index({ kind: 1, status: 1, position: 1, publishedAt: -1 });
editorialVideoSchema.index({ status: 1, createdAt: -1 });
editorialVideoSchema.index({ activeCoverId: 1 });
editorialVideoSchema.index({ "pendingChange.content.coverId": 1 });
editorialVideoSchema.index({ kind: 1, status: 1, autoPublishWhenReady: 1,
  nextPreviewProbeAt: 1 });
editorialVideoSchema.index({ kind: 1, "pendingChange.autoApplyWhenReady": 1,
  "pendingChange.status": 1, "pendingChange.nextPreviewProbeAt": 1 });
editorialVideoSchema.index({ kind: 1, "pendingChange.status": 1, "pendingChange.rejectedAssetExpiresAt": 1 });

export const EditorialVideoModel = model("Video", editorialVideoSchema);
