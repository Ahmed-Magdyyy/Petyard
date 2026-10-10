import { editorialVideoKindEnum, editorialVideoStatusEnum, editorialReviewStatusEnum, reelUploadPurposeEnum } from "../../../shared/constants/enums.js";
// One immutable session identifies either an initial upload or a pending replacement.
export function reelUploadBinding(row) {
  if (row.purpose === reelUploadPurposeEnum.REPLACEMENT) return {
    assetPath: "pendingChange.assetId",
    filter: { _id: row.videoId, kind: editorialVideoKindEnum.REEL, status: { $in: [editorialVideoStatusEnum.APPROVED, editorialVideoStatusEnum.PUBLISHED, editorialVideoStatusEnum.UNPUBLISHED] },
      activeAssetId: row.previousAssetId, "pendingChange.authorId": row.actorId,
      "pendingChange.status": { $in: Object.values(editorialReviewStatusEnum) },
      "pendingChange.uploadSessionId": row._id,
      "pendingChange.assetId": row.assetId || { $exists: false } },
    unset: { "pendingChange.uploadSessionId": "", "pendingChange.assetId": "",
      "pendingChange.autoApplyWhenReady": "", "pendingChange.nextPreviewProbeAt": "",
      "pendingChange.rejectedAssetExpiresAt": "" },
  };
  return {
    assetPath: "activeAssetId",
    filter: { _id: row.videoId, kind: editorialVideoKindEnum.REEL, status: editorialVideoStatusEnum.DRAFT, activeUploadSessionId: row._id,
      activeAssetId: row.assetId || { $exists: false } },
    unset: { activeUploadSessionId: "", activeAssetId: "", nextPreviewProbeAt: "" },
  };
}

export function isCurrentReelUpload(video, row) {
  if (!row) return false;
  if (row.purpose === reelUploadPurposeEnum.REPLACEMENT) return Boolean(row.previousAssetId &&
    [editorialVideoStatusEnum.APPROVED, editorialVideoStatusEnum.PUBLISHED, editorialVideoStatusEnum.UNPUBLISHED].includes(video.status) &&
    String(video.activeAssetId) === String(row.previousAssetId) &&
    String(video.pendingChange?.uploadSessionId) === String(row._id) &&
    String(video.pendingChange?.authorId) === String(row.actorId) &&
    Object.values(editorialReviewStatusEnum).includes(video.pendingChange?.status) &&
    (row.assetId ? String(video.pendingChange.assetId) === String(row.assetId) : !video.pendingChange.assetId));
  return String(video.activeUploadSessionId) === String(row._id) &&
    (row.assetId ? String(video.activeAssetId) === String(row.assetId) : !video.activeAssetId);
}
