import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePreviewContext, listAssetsValidator, listDraftsValidator, historyValidator,
  auditValidator, createDraftValidator, emptyDraftBodyValidator, draftIdValidator,
  versionIdValidator, previewIdValidator,
} from "../../../src/domains/uiLayout/uiLayout.validators.js";
import { decodePageCursor } from "../../../src/domains/uiLayout/uiLayout.pagination.js";

test("preview context retains supported hints without treating them as targeting", () => {
  assert.deepEqual(parsePreviewContext({
    device_profile: "mobile", locale: "en", platform: "android",
    location_id: "6e5966ec-642b-4a15-a6a0-779dd6a6274f",
  }), {
    device_profile: "mobile", locale: "en", platform: "android",
    location_id: "6e5966ec-642b-4a15-a6a0-779dd6a6274f",
  });
  assert.deepEqual(parsePreviewContext({}), {});
});

test("endpoint middleware normalizes input once and preserves query defaults and error ordering", () => {
  function run(validator, req) {
    const res = { locals: {} };
    let nextCount = 0;
    validator(req, res, () => { nextCount += 1; });
    assert.equal(nextCount, 1);
    return res.locals.uiLayoutInput;
  }
  assert.deepEqual(run(listAssetsValidator, { query: {} }), { limit: 30, before: null, status: undefined });
  assert.deepEqual(run(auditValidator, { query: {} }), { limit: 20, before: null, status: undefined });
  assert.deepEqual(run(listDraftsValidator, { query: { limit: "5", status: "scheduled" } }),
    { limit: 5, before: null, status: "scheduled" });
  assert.deepEqual(run(historyValidator, { query: { before: "18", limit: "10" } }),
    { limit: 10, before: 18 });
  assert.throws(() => run(listAssetsValidator, { query: { status: "ready" } }),
    (error) => error.statusCode === 400 && error.details[0].path === "query.status");
  assert.deepEqual(run(createDraftValidator, { body: {
    layout_key: "customer_home", name: "Home", source: { type: "blank" },
  } }), { name: "Home", source: { type: "blank" }, changeNote: null });
  assert.throws(() => run(createDraftValidator, { body: {
    layout_key: "other", name: "Home", source: { type: "blank" },
  } }), (error) => error.code === "UI_LAYOUT_UNSUPPORTED_KEY");
  const id = "8ec682ef-aacd-4639-9d23-b98ea8234dbe";
  for (const [validator, param] of [
    [draftIdValidator, "draftId"], [versionIdValidator, "versionId"], [previewIdValidator, "previewId"],
  ]) assert.deepEqual(run(validator, { params: { [param]: id } }), { id });
  assert.deepEqual(run(emptyDraftBodyValidator, { params: { draftId: id } }), { id });
  assert.throws(() => run(emptyDraftBodyValidator, { params: { draftId: "bad" }, body: { extra: true } }),
    (error) => error.details[0].path === "body.extra");
});

test("preview context rejects malformed hints at the request boundary", () => {
  for (const body of [
    { device_profile: "" }, { locale: "english" }, { platform: "desktop" },
    { location_id: "not-an-id" },
  ]) {
    assert.throws(() => parsePreviewContext(body), (error) =>
      error.code === "UI_LAYOUT_INVALID_REQUEST" && error.statusCode === 400);
  }
});

test("pagination rejects malformed and impossible timestamps", () => {
  assert.equal(decodePageCursor("2026-09-24T00:00:00Z").at.toISOString(),
    "2026-09-24T00:00:00.000Z");
  for (const cursor of ["", "not-a-cursor", "2026-09-31T00:00:00.000Z", "a".repeat(257)]) {
    assert.throws(() => decodePageCursor(cursor), (error) =>
      error.code === "UI_LAYOUT_INVALID_REQUEST" && error.statusCode === 400);
  }
});
