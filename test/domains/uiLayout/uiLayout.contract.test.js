import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectLayoutContent, inspectTargeting, publicLayoutContent,
} from "../../../src/domains/uiLayout/uiLayout.contract.js";
import { UI_LAYOUT_CATALOG } from "../../../src/domains/uiLayout/uiLayout.catalog.js";
import { BUILTIN_SECTION_TYPES } from "../../../src/domains/uiLayout/uiLayout.constants.js";
import {
  chooseActiveVersion, matchesTargeting, normalizeTargeting, targetingOverlaps,
} from "../../../src/domains/uiLayout/uiLayout.targeting.js";

const SECTION_ID = "b8e793a5-dcde-49a5-b207-e79cc24b6a88";
const PROMO_ID = "e3a9980d-67b0-4f23-b84b-a8b20e33a8d4";
const ITEM_ID = "cc708598-3537-414e-bf4d-3fd08a779d0e";
const ITEM_SECTION_ID = "374c9531-c397-4c14-a25b-2482667072d0";

function nav() {
  return { items: [
    { key: "videos", label_key: "videos", icon_key: "videos", destination: "videos", order: 1, enabled: true },
    { key: "home", label_key: "home", icon_key: "home", destination: "home", order: 0, enabled: true },
  ] };
}

function content() {
  return {
    sections: [
      { id: PROMO_ID, section_type: "admin_promo", name: "Promo", position: 1,
        data: { enabled: true, visibility: "all", layout: "split",
          image_url: "https://cdn.petyardstores.com/ui-builder/promo.webp", title: "Adopt",
          cta_text: "Explore", action: { type: "url", value: "https://petyardstores.com/adopt" } } },
      { id: SECTION_ID, section_type: "banners", name: "Banners", position: 0, data: {} },
      { id: ITEM_SECTION_ID, section_type: "dynamic_section", name: "Picks", position: 2,
        data: { enabled: true, title: "Picks", display_type: "grid", card_style: "product_card",
          columns_per_row: 2, limit: 4, show_see_all: false,
          items: [{ id: ITEM_ID, name: "Treats", action: { type: "product", value: "507f1f77bcf86cd799439011" } }] } },
    ],
    navigation: nav(),
    floating_action_button: { enabled: false },
  };
}

test("accepts and normalizes FE-supported sections and fixed navigation", () => {
  const result = inspectLayoutContent(content(), { publish: true });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.content.sections.map((section) => section.position), [0, 1, 2]);
  assert.deepEqual(result.content.navigation.items.map((item) => item.key), ["home", "videos"]);
  assert.equal(result.content.floating_action_button.enabled, false);
  assert.equal(publicLayoutContent(result.content).floating_action_button, undefined);
});

test("allows incomplete drafts but never publishes empty content", () => {
  const blank = { sections: [], navigation: { items: [] } };
  assert.equal(inspectLayoutContent(blank).valid, true);
  const published = inspectLayoutContent(blank, { publish: true });
  assert.equal(published.valid, false);
  assert.ok(published.errors.some((error) => error.code === "INVALID_SECTIONS"));
  assert.ok(published.errors.some((error) => error.code === "HOME_NAVIGATION_REQUIRED"));
});

test("rejects unsupported widget_group and executable-style child payloads", () => {
  const bad = content();
  bad.sections[0] = { id: PROMO_ID, section_type: "widget_group", name: "Old design",
    position: 1, data: { children: [{ type: "script" }] } };
  const result = inspectLayoutContent(bad, { publish: true });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "UNSUPPORTED_SECTION"));
});

test("each built-in section is order-only and non-repeatable", () => {
  const layout = content();
  layout.sections = BUILTIN_SECTION_TYPES.map((type, position) => ({
    id: `00000000-0000-4000-8000-${String(position + 1).padStart(12, "0")}`,
    section_type: type, name: type, position, data: {},
  }));
  assert.equal(inspectLayoutContent(layout, { publish: true }).valid, true);
  layout.sections[1].section_type = layout.sections[0].section_type;
  layout.sections[1].data = { title: "Unusable" };
  const invalid = inspectLayoutContent(layout, { publish: true });
  assert.ok(invalid.errors.some((error) => error.code === "DUPLICATE_BUILTIN"));
  assert.ok(invalid.errors.some((error) => error.code === "BUILTIN_DATA_UNSUPPORTED"));
});

test("rejects unsafe image URLs and unapproved action hosts", () => {
  const bad = content();
  bad.sections[0].data.image_url = "http://127.0.0.1/internal";
  bad.sections[0].data.action.value = "https://unapproved.example/adopt";
  const result = inspectLayoutContent(bad, { publish: true });
  assert.ok(result.errors.some((error) => error.code === "INVALID_HTTPS_URL"));
  assert.ok(result.errors.some((error) => error.code === "URL_HOST_NOT_APPROVED"));
});

test("rejects illustrative numeric catalog IDs before they reach publication", () => {
  const draft = content();
  draft.sections[2].data.items[0].action.value = "1074";
  const result = inspectLayoutContent(draft);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "INVALID_REFERENCE_ID" &&
    error.path === "content.sections[2].data.items[0].action.value"));
});

test("validates target fields and selects the highest priority compatible version", () => {
  const global = normalizeTargeting({});
  const android = normalizeTargeting({ platforms: ["android"], priority: 100 });
  assert.equal(inspectTargeting(android).valid, true);
  assert.equal(inspectTargeting({ min_app_version: "1.9.0", max_app_version: "1.10.0" }).valid, true);
  assert.equal(inspectTargeting({ min_app_version: "2.0.0", max_app_version: "2.0.0" }).valid, true);
  assert.ok(inspectTargeting({ min_app_version: "2.0.0", max_app_version: "1.10.0" }).errors.some(
    (error) => error.code === "INVALID_APP_VERSION_RANGE"));
  assert.equal(targetingOverlaps(global, android), false);
  assert.equal(matchesTargeting(android, { platform: "ios", audience: "guest" }), false);
  const selected = chooseActiveVersion([
    { versionId: "global", priority: 0, targeting: global, updatedAt: new Date("2026-01-01") },
    { versionId: "android", priority: 100, targeting: android, updatedAt: new Date("2026-01-01") },
  ], { platform: "android", audience: "guest" });
  assert.equal(selected.versionId, "android");
  assert.equal(UI_LAYOUT_CATALOG.capabilities.component_tree, false);
  assert.equal(UI_LAYOUT_CATALOG.capabilities.chatbot_fab_config, false);
  assert.equal(UI_LAYOUT_CATALOG.capabilities.chatbot_fab_draft_storage, true);
});

test("all five fixed destinations can be reordered and disabled, but home stays enabled", () => {
  const keys = ["profile", "orders", "favorites", "videos", "home"];
  const layout = content();
  layout.navigation.items = keys.map((key, order) => ({
    key, destination: key,
    label_key: key === "orders" ? "myOrders" : key,
    icon_key: key,
    order, enabled: key === "home" || key === "orders",
  }));
  assert.equal(inspectLayoutContent(layout, { publish: true }).valid, true);
  layout.navigation.items[4].enabled = false;
  assert.ok(inspectLayoutContent(layout, { publish: true }).errors.some((error) =>
    error.code === "HOME_NAVIGATION_REQUIRED"));
});

test("malformed navigation entries return validation errors without throwing", () => {
  for (const item of [null, false, "home", []]) {
    const layout = content();
    layout.navigation.items = [item, ...nav().items];
    const result = inspectLayoutContent(layout, { publish: true });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.path === "content.navigation.items[0]" &&
      error.code === "INVALID_OBJECT"));
  }
});

test("navigation destinations must be own keys in the fixed catalog", () => {
  for (const key of ["toString", "constructor", "__proto__"]) {
    const layout = content();
    layout.navigation.items = [...nav().items,
      { key, destination: key, order: 2, enabled: true }];
    for (const publish of [false, true]) {
      const result = inspectLayoutContent(layout, { publish });
      assert.equal(result.valid, false, key);
      assert.ok(result.errors.some((error) => error.code === "INVALID_NAVIGATION_ITEM"));
    }
  }
});

test("equal-priority overlapping target scopes cannot both be active", () => {
  const first = normalizeTargeting({ platforms: ["android"], priority: 50 });
  const second = normalizeTargeting({ platforms: ["android", "ios"], priority: 50 });
  const distinct = normalizeTargeting({ platforms: ["ios"], priority: 50 });
  assert.equal(targetingOverlaps(first, second), true);
  assert.equal(targetingOverlaps(first, distinct), false);
});
