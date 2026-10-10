import { videoOrphanRecoveryStatusEnum } from "../../../shared/constants/enums.js";
const GUID = /^[A-Za-z0-9-]{1,128}$/;
const CLOCK_SKEW_MS = 5 * 60_000;
const CREATE_GRACE_MS = 15 * 60_000;
const BUNNY_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(Z|[+-]\d{2}:\d{2})?$/;

function parseBunnyUploadDate(value) {
  const match = typeof value === "string" ? BUNNY_DATE_TIME.exec(value) : null;
  if (!match) return NaN;
  const withoutZone = value.slice(0, value.length - (match[1]?.length ?? 0));
  const utc = Date.parse(`${withoutZone}Z`);
  // Reject calendar rollover (for example February 30 becoming a March date).
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 19) !== withoutZone.slice(0, 19)) return NaN;
  // Bunny returned UTC without a suffix. Preserve explicit offsets instead
  // of interpreting unzoned provider timestamps in the host timezone.
  return match[1] ? Date.parse(value) : utc;
}

// Shared read-only provider proof. Owner eligibility stays in each repository;
// a candidate is an observation, never authorization to delete or adopt it.
export async function inspectBunnyOrphan({ context, marker, libraryId, search, getVideo, isGuidTracked }) {
  if (context.providerTitle !== marker ||
      !(context.createdAt instanceof Date) || !Number.isFinite(context.createdAt.getTime()) ||
      !(context.failedAt instanceof Date) || !Number.isFinite(context.failedAt.getTime()) ||
      context.failedAt < context.createdAt) {
    return { status: videoOrphanRecoveryStatusEnum.AMBIGUOUS };
  }

  const page = await search({ providerTitle: marker });
  if (!Array.isArray(page?.items) || !Number.isSafeInteger(page.totalItems) ||
      page.totalItems < 0 || page.totalItems !== page.items.length ||
      page.currentPage !== 1 || page.items.length > 10) {
    return { status: videoOrphanRecoveryStatusEnum.AMBIGUOUS };
  }
  const matches = page.items.filter((item) => item?.title === marker);
  if (matches.length === 0) return { status: videoOrphanRecoveryStatusEnum.NO_MATCH_OBSERVED };
  if (matches.length !== 1 || typeof matches[0]?.guid !== "string" || !GUID.test(matches[0].guid)) {
    return { status: videoOrphanRecoveryStatusEnum.AMBIGUOUS };
  }

  const video = await getVideo(matches[0].guid);
  const uploadedAt = parseBunnyUploadDate(video?.dateUploaded);
  const emptyResolutions = video?.availableResolutions == null || video.availableResolutions === "" ||
    (Array.isArray(video.availableResolutions) && video.availableResolutions.length === 0);
  if (video?.guid !== matches[0].guid || video?.title !== marker ||
      String(video?.videoLibraryId) !== libraryId || !Number.isFinite(uploadedAt) ||
      uploadedAt < context.createdAt.getTime() - CLOCK_SKEW_MS ||
      uploadedAt > context.failedAt.getTime() + CREATE_GRACE_MS ||
      video.status !== 0 || video.length !== 0 || video.storageSize !== 0 ||
      video.encodeProgress !== 0 || !emptyResolutions) {
    return { status: videoOrphanRecoveryStatusEnum.REQUIRES_REVIEW };
  }
  if (await isGuidTracked(video.guid)) return { status: videoOrphanRecoveryStatusEnum.ALREADY_TRACKED };
  return { status: videoOrphanRecoveryStatusEnum.CANDIDATE, providerGuid: video.guid };
}
