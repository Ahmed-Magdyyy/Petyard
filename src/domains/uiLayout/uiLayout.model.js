import mongoose from "mongoose";
import { UI_LAYOUT_SCHEMA_VERSION } from "./uiLayout.constants.js";

const { Schema, model } = mongoose;
const uuid = { type: String, required: true, immutable: true };
const actor = { type: Schema.Types.ObjectId, ref: "User", required: true };

const layoutSchema = new Schema({
  id: { ...uuid, unique: true },
  key: { type: String, required: true, unique: true, immutable: true },
  name: { type: String, required: true },
  nextVersionNumber: { type: Number, default: 1, min: 1 },
  publishedEpoch: { type: Number, default: 0, min: 0 },
  createdBy: actor,
  archivedAt: { type: Date, default: null },
}, { timestamps: true });

const draftSchema = new Schema({
  id: { ...uuid, unique: true },
  layoutId: uuid,
  layoutKey: { type: String, required: true, immutable: true },
  name: { type: String, required: true },
  revision: { type: Number, required: true, default: 1, min: 1 },
  schemaVersion: { type: Number, required: true, default: UI_LAYOUT_SCHEMA_VERSION },
  basedOnVersionId: { type: String, default: null, immutable: true },
  status: { type: String, required: true, enum: ["draft", "scheduled", "published", "archived"], default: "draft" },
  targeting: { type: Schema.Types.Mixed, required: true },
  content: { type: Schema.Types.Mixed, required: true },
  changeNote: { type: String, default: null },
  scheduledFor: { type: Date, default: null },
  scheduledSnapshot: { type: Schema.Types.Mixed, default: null },
  scheduleFailure: { type: String, default: null },
  createdBy: actor,
  updatedBy: actor,
}, { timestamps: true, minimize: false });
draftSchema.index({ layoutKey: 1, status: 1, updatedAt: -1, _id: -1 });
draftSchema.index({ layoutKey: 1, updatedAt: -1, _id: -1 });
draftSchema.index({ layoutKey: 1, status: 1, scheduleFailure: 1, scheduledFor: 1 });

const versionSchema = new Schema({
  id: { ...uuid, unique: true },
  layoutId: uuid,
  layoutKey: { type: String, required: true, immutable: true },
  versionNumber: { type: Number, required: true, min: 1, immutable: true },
  schemaVersion: { type: Number, required: true, immutable: true },
  targeting: { type: Schema.Types.Mixed, required: true, immutable: true },
  content: { type: Schema.Types.Mixed, required: true, immutable: true },
  checksum: { type: String, required: true, immutable: true },
  sourceDraftId: { type: String, default: null, immutable: true },
  rollbackOfVersionId: { type: String, default: null, immutable: true },
  changeNote: { type: String, required: true, immutable: true },
  publishedBy: { ...actor, immutable: true },
  publishedAt: { type: Date, required: true, immutable: true },
}, { timestamps: false, strict: "throw", minimize: false });
versionSchema.index({ layoutId: 1, versionNumber: 1 }, { unique: true });
versionSchema.index({ layoutKey: 1, versionNumber: -1 });

const activeSchema = new Schema({
  layoutId: uuid,
  scopeKey: { type: String, required: true },
  versionId: { type: String, required: true },
  targeting: { type: Schema.Types.Mixed, required: true },
  priority: { type: Number, required: true },
}, { timestamps: true });
activeSchema.index({ layoutId: 1, scopeKey: 1 }, { unique: true });

const previewSchema = new Schema({
  id: { ...uuid, unique: true },
  draftId: { type: String, required: true },
  revision: { type: Number, required: true },
  tokenHash: { type: String, required: true, unique: true },
  snapshot: { type: Schema.Types.Mixed, required: true },
  context: { type: Schema.Types.Mixed, default: {} },
  createdBy: actor,
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
}, { timestamps: { createdAt: true, updatedAt: false }, minimize: false });
previewSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });

const auditSchema = new Schema({
  layoutId: { type: String, required: true },
  draftId: { type: String, default: null },
  versionId: { type: String, default: null },
  action: { type: String, required: true },
  actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  requestId: { type: String, default: null },
  details: { type: Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now, immutable: true },
}, { timestamps: false });
auditSchema.index({ layoutId: 1, createdAt: -1, _id: -1 });

const operationSchema = new Schema({
  scope: { type: String, required: true },
  key: { type: String, required: true },
  requestHash: { type: String, required: true },
  response: { type: Schema.Types.Mixed, required: true },
  createdAt: { type: Date, default: Date.now, immutable: true },
}, { timestamps: false, minimize: false });
operationSchema.index({ scope: 1, key: 1 }, { unique: true });

const assetSchema = new Schema({
  id: { ...uuid, unique: true },
  status: { type: String, required: true, enum: ["ready", "archived"], default: "ready" },
  usage: { type: String, required: true },
  url: { type: String, required: true },
  publicId: { type: String, required: true },
  mimeType: { type: String, required: true },
  width: { type: Number, required: true },
  height: { type: Number, required: true },
  byteSize: { type: Number, required: true },
  createdBy: actor,
}, { timestamps: true });
assetSchema.index({ status: 1, createdAt: -1, _id: -1 });

export const UiLayoutModel = model("UiLayout", layoutSchema);
export const UiLayoutDraftModel = model("UiLayoutDraft", draftSchema);
export const UiLayoutPublicationModel = model("UiLayoutPublication", versionSchema);
export const UiLayoutActiveModel = model("UiLayoutActive", activeSchema);
export const UiLayoutPreviewModel = model("UiLayoutPreview", previewSchema);
export const UiLayoutAuditModel = model("UiLayoutAudit", auditSchema);
export const UiLayoutOperationModel = model("UiLayoutOperation", operationSchema);
export const UiLayoutAssetModel = model("UiLayoutAsset", assetSchema);
