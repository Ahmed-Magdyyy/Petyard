import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { inspectLayoutContent, publicLayoutContent } from "../../../src/domains/uiLayout/uiLayout.contract.js";
import { collectLayoutReferences } from "../../../src/domains/uiLayout/uiLayout.productReferences.js";
import { inspectClientCompatibility } from "../../../src/domains/uiLayout/uiLayout.compatibility.js";
import { getUiLayoutCatalog } from "../../../src/domains/uiLayout/uiLayout.catalog.js";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/uiLayout.idOnly.json", import.meta.url), "utf8"));
const content = () => structuredClone(fixture.content);
const root = (layout) => layout.sections[1].data.root;
const block = (type, props = {}, children) => ({ id: randomUUID(), type, props,
  ...(children !== undefined ? { children } : {}) });
const failure = (layout, code, publish = false) => {
  const result = inspectLayoutContent(layout, { publish });
  assert.equal(result.valid, false, code);
  assert.ok(result.errors.some((error) => error.code === code), JSON.stringify(result.errors));
};

test("catalog exposes all FE renderer tokens and defaults without injecting source props", () => {
  const catalog = getUiLayoutCatalog();
  assert.deepEqual(catalog.block_renderer_tokens.spacing, { none: 0, sm: 8, md: 16, lg: 24 });
  assert.equal(catalog.block_renderer_tokens.unit, "logical_pixels");
  assert.deepEqual(catalog.block_renderer_defaults.text.styles, {
    title_large: { font_size: 28, bold: true }, title_medium: { font_size: 22, bold: true },
    body_medium: { font_size: 16 }, body_small: { font_size: 12 },
  });
  assert.deepEqual(catalog.block_renderer_defaults.button.padding_by_size, { medium: 12, large: 20 });
  assert.equal(catalog.block_renderer_defaults.divider.height, 16);
  const layout = content();
  root(layout).children.push(block("spacer"));
  assert.deepEqual(inspectLayoutContent(layout).content, layout);
});

test("FE revision-2 fixture round-trips all eight blocks, bilingual values and four product placements", () => {
  for (const publish of [false, true]) {
    const input = content();
    const result = inspectLayoutContent(input, { publish });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.content, input);
    const publicContent = publicLayoutContent(result.content);
    assert.equal(publicContent.product_reference_format, "id_only_v1");
    assert.deepEqual(publicContent.product_ids, input.product_ids);
    assert.deepEqual(publicContent.sections, input.sections);
    const refs = collectLayoutReferences(result.content).filter((entry) => entry.type === "product");
    assert.equal(refs.length, 5); // Four cards and one button reference three products.
    assert.equal(new Set(refs.map((entry) => entry.value)).size, 3);
  }
});

test("manifest checks exact sets, duplicates, invalid IDs and profile ownership without dropping placements", () => {
  for (const mutate of [
    (layout) => layout.product_ids.pop(),
    (layout) => layout.product_ids.push("507f1f77bcf86cd799439011"),
    (layout) => { layout.product_ids = []; },
  ]) { const layout = content(); mutate(layout); failure(layout, "PRODUCT_MANIFEST_MISMATCH"); }
  const duplicate = content(); duplicate.product_ids.push(duplicate.product_ids[0].toUpperCase());
  failure(duplicate, "PRODUCT_MANIFEST_DUPLICATE");
  const invalid = content(); invalid.product_ids[0] = "not-an-object-id";
  failure(invalid, "INVALID_PRODUCT_ID");
  const stale = content(); stale.product_reference_format = "id_only_v2";
  failure(stale, "UNSUPPORTED_PRODUCT_REFERENCE_FORMAT");
  const uppercase = content();
  uppercase.product_ids.reverse().forEach((id, index, list) => { list[index] = id.toUpperCase(); });
  uppercase.sections[0].data.items[0].product_id = uppercase.sections[0].data.items[0].product_id.toUpperCase();
  const normalized = inspectLayoutContent(uppercase);
  assert.deepEqual(normalized.content.product_ids, fixture.content.product_ids);
  assert.equal(normalized.content.sections[0].data.items.length, 2);
  assert.notEqual(normalized.content.sections[0].data.items[0].product_id, uppercase.sections[0].data.items[0].product_id);
});

test("ID-only product items reject copied product fields and manual product actions", () => {
  const copied = content(); copied.sections[0].data.items[0].name = "Stale name";
  failure(copied, "UNKNOWN_FIELD");
  const manual = content(); manual.sections[0].data.items[0] = { id: randomUUID(), name: "Product",
    action: { type: "product", value: manual.product_ids[0] } };
  failure(manual, "PRODUCT_ITEM_REQUIRES_ID");
});

test("blocks reject unknown types/props, unsafe images and invalid localization without throwing", () => {
  for (const value of [null, true, [], "text"]) {
    const layout = content(); root(layout).children = [value]; failure(layout, "INVALID_OBJECT");
  }
  const unknown = content(); root(unknown).children[0].type = "stack"; failure(unknown, "BLOCK_TYPE_UNSUPPORTED");
  const prop = content(); root(prop).children[0].props.html = "<script>"; failure(prop, "UNKNOWN_FIELD");
  const url = content(); root(url).children[0].props.image_url = "https://127.0.0.1/a.png"; failure(url, "INVALID_HTTPS_URL");
  const child = content(); root(child).children[0].children = []; failure(child, "BLOCK_CHILDREN_UNSUPPORTED");
  for (const title of [{ fr: "Hello" }, { en: 1 }, { en: "a".repeat(81) }]) {
    const layout = content(); layout.sections[0].data.title = title; failure(layout, "LOCALIZED_TEXT_INVALID");
  }
  const noText = content(); root(noText).children[1].props.value = { en: " ", ar: "" };
  failure(noText, "LOCALIZED_TEXT_INVALID", true);
  assert.equal(inspectLayoutContent(noText).valid, true);
  const cyclic = content(); root(cyclic).children.push(root(cyclic)); failure(cyclic, "INVALID_OBJECT");
});

test("depth, node, child and item boundaries are enforced before unsafe traversal", () => {
  const depth = content(); depth.sections = [depth.sections[1]]; depth.sections[0].position = 0;
  depth.product_ids = [];
  let tree = block("spacer");
  for (let level = 0; level < 5; level++) tree = block("column", {}, [tree]);
  depth.sections[0].data.root = tree;
  assert.equal(inspectLayoutContent(depth, { publish: true }).valid, true);
  depth.sections[0].data.root = block("column", {}, [tree]); failure(depth, "BLOCK_DEPTH_EXCEEDED");
  const nodes = content(); nodes.product_ids = nodes.product_ids.slice(0, 2);
  root(nodes).children = Array.from({ length: 5 }, (_v, index) =>
    block("column", {}, Array.from({ length: index === 0 ? 8 : 9 }, () => block("spacer"))));
  // The dynamic section owns the two remaining product references. This tree has exactly 50 nodes.
  assert.equal(inspectLayoutContent(nodes).valid, true);
  root(nodes).children[0].children.push(block("spacer")); failure(nodes, "BLOCK_NODE_LIMIT_EXCEEDED");
  const children = content(); root(children).children = Array.from({ length: 13 }, () => block("spacer"));
  failure(children, "BLOCK_CHILD_LIMIT_EXCEEDED");
  const items = content(); items.sections[0].data.items = Array.from({ length: 21 }, () =>
    ({ id: randomUUID(), product_id: items.product_ids[0] })); failure(items, "INVALID_ITEMS");
  const ids = content(); root(ids).children[1].id = root(ids).children[0].id.toUpperCase(); failure(ids, "DUPLICATE_ID");
});

test("all retained references count, including disabled sections, actions, and items past display limits", () => {
  const layout = content(); layout.sections[0].data.enabled = false; layout.sections[0].data.limit = 1;
  const result = inspectLayoutContent(layout, { publish: true });
  assert.equal(result.valid, true); assert.equal(result.content.product_ids.length, 3);
  layout.product_ids.splice(1, 1); failure(layout, "PRODUCT_MANIFEST_MISMATCH");
});

test("prepared profiles do not enable publishing without a confirmed client version", () => {
  const layout = content();
  assert.equal(inspectClientCompatibility(layout, {}, null)[0].code, "CLIENT_VERSION_UNSUPPORTED");
  assert.equal(inspectClientCompatibility(layout, {}, "2.0.0").length, 1);
  assert.equal(inspectClientCompatibility(layout, { min_app_version: "1.9.0" }, "2.0.0").length, 1);
  assert.deepEqual(inspectClientCompatibility(layout, { min_app_version: "2.0.0" }, "2.0.0"), []);
  assert.deepEqual(inspectClientCompatibility({ sections: [] }, {}, null), []);
  const previous = process.env.UI_BUILDER_ID_ONLY_MIN_APP_VERSION;
  try {
    delete process.env.UI_BUILDER_ID_ONLY_MIN_APP_VERSION;
    const catalog = getUiLayoutCatalog();
    assert.equal(catalog.capabilities.component_tree, false);
    assert.equal(catalog.capabilities.product_id_references, false);
    assert.equal(catalog.capabilities.product_id_draft_storage, true);
    assert.equal(catalog.limits.max_product_ids, 50);
    assert.equal(catalog.block_types.length, 8);
    assert.equal(catalog.section_types.find((entry) => entry.key === "composed_section").repeatable, true);
  } finally {
    if (previous === undefined) delete process.env.UI_BUILDER_ID_ONLY_MIN_APP_VERSION;
    else process.env.UI_BUILDER_ID_ONLY_MIN_APP_VERSION = previous;
  }
});

test("layouts accept fifty unique products and reject a fifty-first reference without truncation", () => {
  const layout = content(); layout.sections = []; layout.product_ids = [];
  for (let section = 0; section < 3; section++) {
    const count = section === 2 ? 10 : 20;
    const items = Array.from({ length: count }, () => {
      const product_id = (layout.product_ids.length + 1).toString(16).padStart(24, "0");
      layout.product_ids.push(product_id); return { id: randomUUID(), product_id };
    });
    layout.sections.push({ id: randomUUID(), section_type: "dynamic_section", position: section,
      data: { enabled: true, title: "Picks", display_type: "grid", card_style: "product_card", items } });
  }
  assert.equal(inspectLayoutContent(layout, { publish: true }).valid, true);
  layout.sections[2].data.items.push({ id: randomUUID(), product_id: "ffffffffffffffffffffffff" });
  failure(layout, "PRODUCT_MANIFEST_LIMIT_EXCEEDED");
});
