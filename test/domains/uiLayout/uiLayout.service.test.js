import test from "node:test";
import assert from "node:assert/strict";
import { createUiLayoutService } from "../../../src/domains/uiLayout/uiLayout.service.js";
import { UiLayoutError } from "../../../src/domains/uiLayout/uiLayout.error.js";
import { decodePageCursor } from "../../../src/domains/uiLayout/uiLayout.pagination.js";

const ACTOR = "507f1f77bcf86cd799439011";
const SECTION = "b8e793a5-dcde-49a5-b207-e79cc24b6a88";
const KEY = "ca4581f9-75da-4805-a6e3-c27ff321740b";
let sequence = 0;
let objectSequence = 0;
function uuid() {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function makeQuery(read) {
  let sorter = null;
  let limiter = null;
  const query = {
    session() { return query; },
    sort(value) { sorter = value; return query; },
    limit(value) { limiter = value; return query; },
    then(resolve, reject) {
      let result = read();
      if (Array.isArray(result) && sorter) {
        result = [...result].sort((a, b) => {
          for (const [field, direction] of Object.entries(sorter)) {
            const left = a[field] instanceof Date ? a[field].getTime() : a[field];
            const right = b[field] instanceof Date ? b[field].getTime() : b[field];
            if (left !== right) return direction * (left > right ? 1 : -1);
          }
          return 0;
        });
      }
      if (Array.isArray(result) && limiter !== null) result = result.slice(0, limiter);
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return query;
}

function matches(row, filter) {
  return Object.entries(filter).every(([field, wanted]) => {
    if (field === "$or") return wanted.some((alternative) => matches(row, alternative));
    const actual = row[field];
    if (wanted instanceof Date) return actual?.getTime() === wanted.getTime();
    if (wanted && typeof wanted === "object" && !Array.isArray(wanted)) {
      if ("$lt" in wanted) return actual instanceof Date
        ? actual.getTime() < wanted.$lt.getTime() : actual < wanted.$lt;
      if ("$lte" in wanted) return actual instanceof Date
        ? actual.getTime() <= wanted.$lte.getTime() : actual <= wanted.$lte;
      if ("$in" in wanted) return wanted.$in.includes(actual);
    }
    return actual === wanted;
  });
}

function document(value) {
  const row = { ...value, createdAt: value.createdAt ?? new Date("2026-09-24T00:00:00Z"),
    updatedAt: value.updatedAt ?? new Date("2026-09-24T00:00:00Z") };
  row.toObject = () => ({ ...row });
  return row;
}

class MemoryModel {
  rows = [];
  findOne(filter) { return makeQuery(() => this.rows.find((row) => matches(row, filter)) ?? null); }
  find(filter) { return makeQuery(() => this.rows.filter((row) => matches(row, filter))); }
  async create(value) {
    if (Array.isArray(value)) return value.map((item) => this.add(item));
    return this.add(value);
  }
  add(value) {
    objectSequence += 1;
    const row = document({ _id: objectSequence.toString(16).padStart(24, "0"), ...value });
    this.rows.push(row);
    return row;
  }
  async findOneAndUpdate(filter, update, options = {}) {
    let row = this.rows.find((candidate) => matches(candidate, filter));
    if (!row && options.upsert) row = this.add({ ...filter, ...update.$setOnInsert });
    if (!row) return null;
    const before = document(row);
    Object.assign(row, update.$set ?? {});
    for (const [field, amount] of Object.entries(update.$inc ?? {})) row[field] += amount;
    row.updatedAt = new Date("2026-09-24T00:00:01Z");
    return options.new === false ? before : row;
  }
  async updateOne(filter, update, options = {}) {
    let row = this.rows.find((candidate) => matches(candidate, filter));
    if (!row && options.upsert) row = this.add(filter);
    if (!row) return { matchedCount: 0 };
    Object.assign(row, update.$set ?? {});
    for (const [field, amount] of Object.entries(update.$inc ?? {})) row[field] += amount;
    return { matchedCount: 1 };
  }
}

function content() {
  return {
    sections: [{ id: SECTION, section_type: "banners", name: "Banners", position: 0, data: {} }],
    navigation: { items: [
      { key: "home", label_key: "home", icon_key: "home", destination: "home", order: 0, enabled: true },
    ] },
    floating_action_button: { enabled: false },
  };
}

function fixture({ getOrSet } = {}) {
  sequence = 0;
  objectSequence = 0;
  const models = {
    layoutModel: new MemoryModel(), draftModel: new MemoryModel(),
    versionModel: new MemoryModel(), activeModel: new MemoryModel(),
    previewModel: new MemoryModel(), auditModel: new MemoryModel(),
    operationModel: new MemoryModel(),
  };
  let clock = new Date("2026-09-24T00:00:00Z");
  const service = createUiLayoutService({
    ...models, inspectReferences: async () => [], uuid, now: () => clock,
    getOrSet: getOrSet ?? (async (_key, _ttl, fetchFresh) => fetchFresh()),
    startSession: async () => ({ withTransaction: async (fn) => fn(), endSession: async () => {} }),
  });
  return { service, models, setTime: (value) => { clock = new Date(value); } };
}

test("full PATCH protects revisions, deduplicates retries, and leaves public draft-free", async () => {
  const { service } = fixture();
  const draft = await service.createDraft({
    name: "Home", source: { type: "blank" }, actorId: ACTOR,
  });
  const body = { name: "Home", targeting: draft.targeting, content: content() };
  const saved = await service.saveDraft({
    id: draft.id, revision: 1, body, mutationId: KEY, actorId: ACTOR,
  });
  assert.equal(saved.revision, 2);
  assert.deepEqual(await service.saveDraft({
    id: draft.id, revision: 1, body, mutationId: KEY, actorId: ACTOR,
  }), saved);
  await assert.rejects(service.saveDraft({
    id: draft.id, revision: 1, body, mutationId: uuid(), actorId: ACTOR,
  }), (error) => error instanceof UiLayoutError && error.code === "UI_DRAFT_REVISION_CONFLICT");
  await assert.rejects(service.getPublic({ audience: "guest" }),
    (error) => error.code === "UI_LAYOUT_NOT_PUBLISHED");
  const publication = await service.publish({
    id: draft.id, revision: 2, changeNote: "First launch",
    idempotencyKey: uuid(), actorId: ACTOR,
  });
  assert.equal(publication.version_number, 1);
  const publicResult = await service.getPublic({ audience: "guest" });
  assert.equal(publicResult.sections.length, 1);
  assert.equal(publicResult.floating_action_button, undefined);
  assert.equal(publicResult.version_id, publication.version_id);
  assert.deepEqual(await service.saveDraft({
    id: draft.id, revision: 1, body, mutationId: KEY, actorId: ACTOR,
  }), saved);
});

test("scheduled snapshot publishes once after due time and rollback creates a new version", async () => {
  const { service, setTime } = fixture();
  const first = await service.createDraft({ name: "First", source: { type: "blank" }, actorId: ACTOR });
  await service.saveDraft({ id: first.id, revision: 1,
    body: { name: "First", targeting: first.targeting, content: content() }, actorId: ACTOR });
  const version1 = await service.publish({ id: first.id, revision: 2,
    changeNote: "First", idempotencyKey: uuid(), actorId: ACTOR });
  const second = await service.createDraft({ name: "Second",
    source: { type: "published", version_id: version1.version_id }, actorId: ACTOR });
  const scheduled = await service.schedule({ id: second.id, revision: 1,
    scheduledFor: "2026-09-24T00:03:00Z", changeNote: "Second",
    idempotencyKey: uuid(), actorId: ACTOR });
  assert.equal(scheduled.status, "scheduled");
  assert.equal((await service.dueSchedules()).length, 0);
  setTime("2026-09-24T00:03:01Z");
  const [due] = await service.dueSchedules();
  const version2 = await service.publishScheduledDraft(due);
  assert.equal(version2.version_number, 2);
  const rollback = await service.rollback({ versionId: version1.version_id,
    changeNote: "Return to first", idempotencyKey: uuid(), actorId: ACTOR });
  assert.equal(rollback.version_number, 3);
  assert.equal((await service.getPublic({ audience: "guest" })).version_id, rollback.version_id);
});

test("failed scheduled revalidation preserves the existing live version", async () => {
  const { service, models, setTime } = fixture();
  const first = await service.createDraft({ name: "First", source: { type: "blank" }, actorId: ACTOR });
  await service.saveDraft({ id: first.id, revision: 1,
    body: { name: "First", targeting: first.targeting, content: content() }, actorId: ACTOR });
  const live = await service.publish({ id: first.id, revision: 2,
    changeNote: "First", idempotencyKey: uuid(), actorId: ACTOR });
  const next = await service.createDraft({ name: "Next",
    source: { type: "published", version_id: live.version_id }, actorId: ACTOR });
  await service.schedule({ id: next.id, revision: 1,
    scheduledFor: "2026-09-24T00:03:00Z", changeNote: "Next",
    idempotencyKey: uuid(), actorId: ACTOR });
  models.draftModel.rows.find((row) => row.id === next.id).scheduledSnapshot.content.sections[0].section_type = "unsupported";
  setTime("2026-09-24T00:03:01Z");
  const [due] = await service.dueSchedules();
  await assert.rejects(service.publishScheduledDraft(due),
    (error) => error.code === "UI_LAYOUT_VALIDATION_FAILED");
  assert.equal((await service.getPublic({ audience: "guest" })).version_id, live.version_id);
  assert.equal(models.versionModel.rows.length, 1);
  assert.equal((await service.getDraft(next.id)).status, "scheduled");
});

test("preview is immutable, expires, and can be revoked without changing live content", async () => {
  const { service, setTime } = fixture();
  const draft = await service.createDraft({ name: "Preview", source: { type: "blank" }, actorId: ACTOR });
  const original = content();
  await service.saveDraft({ id: draft.id, revision: 1,
    body: { name: "Preview", targeting: draft.targeting, content: original }, actorId: ACTOR });
  const preview = await service.createPreview({ id: draft.id, revision: 2,
    expiresInSeconds: 60, context: { device_profile: "mobile", locale: "en",
      platform: "android" }, actorId: ACTOR });
  const changed = content();
  changed.sections[0].name = "Changed later";
  await service.saveDraft({ id: draft.id, revision: 2,
    body: { name: "Preview", targeting: draft.targeting, content: changed }, actorId: ACTOR });
  const previewResult = await service.getPreview(preview.token);
  assert.equal(previewResult.data.sections[0].name, "Banners");
  assert.deepEqual(previewResult.meta.requested_context,
    { device_profile: "mobile", locale: "en", platform: "android" });
  await service.revokePreview({ id: preview.preview_id, actorId: ACTOR });
  await assert.rejects(service.getPreview(preview.token),
    (error) => error.code === "UI_PREVIEW_EXPIRED");
  const next = await service.createPreview({ id: draft.id, revision: 3,
    expiresInSeconds: 60, actorId: ACTOR });
  setTime("2026-09-24T00:01:01Z");
  await assert.rejects(service.getPreview(next.token),
    (error) => error.code === "UI_PREVIEW_EXPIRED");
  await assert.rejects(service.getPublic({ audience: "guest" }),
    (error) => error.code === "UI_LAYOUT_NOT_PUBLISHED");
});

test("same publish key cannot be reused with a different request", async () => {
  const { service } = fixture();
  const draft = await service.createDraft({ name: "Home", source: { type: "blank" }, actorId: ACTOR });
  await service.saveDraft({ id: draft.id, revision: 1,
    body: { name: "Home", targeting: draft.targeting, content: content() }, actorId: ACTOR });
  const first = await service.publish({ id: draft.id, revision: 2,
    changeNote: "Launch", idempotencyKey: KEY, actorId: ACTOR });
  assert.deepEqual(await service.publish({ id: draft.id, revision: 2,
    changeNote: "Launch", idempotencyKey: KEY, actorId: ACTOR }), first);
  await assert.rejects(service.publish({ id: draft.id, revision: 2,
    changeNote: "Different", idempotencyKey: KEY, actorId: ACTOR }),
  (error) => error.code === "UI_IDEMPOTENCY_KEY_REUSED");
});

test("targeted versions resolve over the global fallback without replacing it", async () => {
  const { service } = fixture();
  const global = await service.createDraft({ name: "Global", source: { type: "blank" }, actorId: ACTOR });
  await service.saveDraft({ id: global.id, revision: 1,
    body: { name: "Global", targeting: global.targeting, content: content() }, actorId: ACTOR });
  const globalVersion = await service.publish({ id: global.id, revision: 2,
    changeNote: "Global", idempotencyKey: uuid(), actorId: ACTOR });
  const targeted = await service.createDraft({ name: "Android",
    source: { type: "published", version_id: globalVersion.version_id }, actorId: ACTOR });
  const androidContent = content();
  androidContent.sections[0].name = "Android banners";
  await service.saveDraft({ id: targeted.id, revision: 1,
    body: { name: "Android", targeting: { ...targeted.targeting,
      platforms: ["android"], priority: 100 }, content: androidContent }, actorId: ACTOR });
  const androidVersion = await service.publish({ id: targeted.id, revision: 2,
    changeNote: "Android", idempotencyKey: uuid(), actorId: ACTOR });
  assert.equal((await service.getPublic({ platform: "android", audience: "guest" })).version_id,
    androidVersion.version_id);
  assert.equal((await service.getPublic({ platform: "ios", audience: "guest" })).version_id,
    globalVersion.version_id);
});

test("canceling a schedule advances revision so rescheduling gets a new job identity", async () => {
  const { service } = fixture();
  const draft = await service.createDraft({ name: "Home", source: { type: "blank" }, actorId: ACTOR });
  await service.saveDraft({ id: draft.id, revision: 1,
    body: { name: "Home", targeting: draft.targeting, content: content() }, actorId: ACTOR });
  await service.schedule({ id: draft.id, revision: 2,
    scheduledFor: "2026-09-24T00:03:00Z", changeNote: "Original",
    idempotencyKey: uuid(), actorId: ACTOR });
  await service.cancelSchedule({ id: draft.id, actorId: ACTOR });
  const afterCancel = await service.getDraft(draft.id);
  assert.equal(afterCancel.status, "draft");
  assert.equal(afterCancel.revision, 3);
  const second = await service.schedule({ id: draft.id, revision: 3,
    scheduledFor: "2026-09-24T00:05:00Z", changeNote: "Replacement",
    idempotencyKey: uuid(), actorId: ACTOR });
  assert.equal(second.revision, 3);
});

test("publication changes the cache epoch before the next public read", async () => {
  const keys = [];
  const { service } = fixture({ getOrSet: async (key, _ttl, fetchFresh) => {
    keys.push(key);
    return fetchFresh();
  } });
  const first = await service.createDraft({ name: "First", source: { type: "blank" }, actorId: ACTOR });
  await service.saveDraft({ id: first.id, revision: 1,
    body: { name: "First", targeting: first.targeting, content: content() }, actorId: ACTOR });
  const version1 = await service.publish({ id: first.id, revision: 2,
    changeNote: "First", idempotencyKey: uuid(), actorId: ACTOR });
  await service.getPublic({ audience: "guest" });
  const second = await service.createDraft({ name: "Second",
    source: { type: "published", version_id: version1.version_id }, actorId: ACTOR });
  await service.publish({ id: second.id, revision: 1,
    changeNote: "Second", idempotencyKey: uuid(), actorId: ACTOR });
  await service.getPublic({ audience: "guest" });
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  assert.match(keys[0], /:epoch:1:/);
  assert.match(keys[1], /:epoch:2:/);
});

test("scheduled publish retry returns the original result after its scheduled time", async () => {
  const { service, setTime } = fixture();
  const draft = await service.createDraft({ name: "Home", source: { type: "blank" }, actorId: ACTOR });
  await service.saveDraft({ id: draft.id, revision: 1,
    body: { name: "Home", targeting: draft.targeting, content: content() }, actorId: ACTOR });
  const key = uuid();
  const request = { id: draft.id, revision: 2, scheduledFor: "2026-09-24T00:03:00Z",
    changeNote: "Weekend", idempotencyKey: key, actorId: ACTOR };
  const first = await service.schedule(request);
  setTime("2026-09-24T00:10:00Z");
  assert.deepEqual(await service.schedule(request), first);
});

test("scheduling accepts only real UTC ISO timestamps", async () => {
  const { service } = fixture();
  for (const scheduledFor of ["2026-09-24", "2026-09-24T03:00:00+03:00",
    "2026-09-31T00:03:00Z"]) {
    await assert.rejects(service.schedule({ scheduledFor, changeNote: "Campaign" }),
      (error) => error instanceof UiLayoutError && error.code === "UI_SCHEDULE_INVALID_TIME");
  }
});

test("draft and audit cursors do not skip rows with identical timestamps", async () => {
  const { service } = fixture();
  const drafts = [];
  for (const name of ["One", "Two", "Three"]) {
    drafts.push(await service.createDraft({ name, source: { type: "blank" }, actorId: ACTOR }));
  }
  const first = await service.listDrafts({ limit: 1 });
  const second = await service.listDrafts({ limit: 1, before: decodePageCursor(first.next_before) });
  const third = await service.listDrafts({ limit: 1, before: decodePageCursor(second.next_before) });
  assert.deepEqual([first.items[0].id, second.items[0].id, third.items[0].id],
    drafts.map((draft) => draft.id).reverse());
  assert.equal(third.next_before, null);

  const auditFirst = await service.listAudit({ limit: 1 });
  const auditSecond = await service.listAudit({ limit: 1,
    before: decodePageCursor(auditFirst.next_before) });
  const auditThird = await service.listAudit({ limit: 1,
    before: decodePageCursor(auditSecond.next_before) });
  assert.equal(new Set([auditFirst.items[0].draft_id, auditSecond.items[0].draft_id,
    auditThird.items[0].draft_id]).size, 3);
  assert.equal(auditThird.next_before, null);
});
