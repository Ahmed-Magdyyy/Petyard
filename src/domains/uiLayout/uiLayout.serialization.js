import { publicLayoutContent } from "./uiLayout.contract.js";

export function iso(value) {
  return value ? new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
}

export function assetData(asset) {
  return {
    id: asset.id, status: asset.status, usage: asset.usage, url: asset.url,
    width: asset.width, height: asset.height, byte_size: asset.byteSize,
    created_at: asset.createdAt.toISOString(),
  };
}

export function draftData(draft) {
  return {
    id: draft.id,
    layout_id: draft.layoutId,
    layout_key: draft.layoutKey,
    name: draft.name,
    status: draft.status,
    schema_version: draft.schemaVersion,
    revision: draft.revision,
    based_on_version_id: draft.basedOnVersionId,
    targeting: draft.targeting,
    content: draft.content,
    change_note: draft.changeNote,
    scheduled_for: iso(draft.scheduledFor),
    schedule_failure: draft.scheduleFailure,
    created_at: iso(draft.createdAt),
    updated_at: iso(draft.updatedAt),
  };
}

export function versionData(version) {
  return {
    version_id: version.id,
    layout_id: version.layoutId,
    version_number: version.versionNumber,
    schema_version: version.schemaVersion,
    targeting: version.targeting,
    content: version.content,
    checksum: version.checksum,
    source_draft_id: version.sourceDraftId,
    rollback_of_version_id: version.rollbackOfVersionId,
    change_note: version.changeNote,
    published_at: iso(version.publishedAt),
    published_by: String(version.publishedBy),
  };
}

export function publicData(version) {
  return {
    layout_id: version.layoutId,
    version_id: version.id,
    version_number: version.versionNumber,
    schema_version: version.schemaVersion,
    published_at: iso(version.publishedAt),
    checksum: version.checksum,
    ...publicLayoutContent(version.content),
  };
}
