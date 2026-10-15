import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspectLayoutContent } from "../../../src/domains/uiLayout/uiLayout.contract.js";
import { collectLayoutReferences } from "../../../src/domains/uiLayout/uiLayout.productReferences.js";
import { inspectLayoutReferences } from "../../../src/domains/uiLayout/uiLayout.references.js";
import { inspectClientCompatibility } from "../../../src/domains/uiLayout/uiLayout.compatibility.js";
import { getUiLayoutCatalog } from "../../../src/domains/uiLayout/uiLayout.catalog.js";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/uiLayout.idOnly.json", import.meta.url), "utf8"));
const content = () => structuredClone(fixture.content);
const root = (layout) => layout.sections[1].data.root;
const image = (layout) => root(layout).children[0].props;
const subcategoryId = "68cf1234567890abcdef1239";
const urls = (count) => Array.from({ length: count }, (_, index) => `https://media.petyardstores.com/ui-builder/slide-${index}.webp`);
const carousel = (count = 2) => {
  const layout = content(); delete image(layout).image_url; image(layout).image_urls = urls(count); return layout;
};
const failure = (layout, code, publish = false) => {
  const result = inspectLayoutContent(layout, { publish });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === code), JSON.stringify(result.errors));
};

test("single and 1/2/10-image sources preserve every URL, order, identity and bilingual prop", () => {
  for (const layout of [content(), carousel(1), carousel(2), carousel(10)]) {
    for (const publish of [false, true]) assert.deepEqual(inspectLayoutContent(layout, { publish }).content, layout);
  }
  const layout = carousel(); layout.sections[1].data.enabled = false;
  const references = collectLayoutReferences(layout);
  assert.deepEqual(references.filter((entry) => entry.path.includes(".image_urls[")).map((entry) => entry.value), urls(2));
  assert.ok(references.some((entry) => entry.path.endsWith("image_urls[1]")));
  assert.deepEqual(inspectLayoutContent(layout).content.product_ids, content().product_ids);
});

test("image-source conflicts and invalid carousel entries fail even in disabled drafts", () => {
  const both = carousel(); image(both).image_url = urls(1)[0]; failure(both, "IMAGE_SOURCE_CONFLICT");
  const many = carousel(11); failure(many, "INVALID_IMAGE_URLS");
  for (const value of [[], null, "not-an-array"]) {
    const layout = carousel(); image(layout).image_urls = value; failure(layout, "INVALID_IMAGE_URLS");
  }
  const repeated = carousel(); image(repeated).image_urls[1] = image(repeated).image_urls[0]; failure(repeated, "DUPLICATE_IMAGE_URL");
  for (const value of ["", null, 7, {}, "http://media.petyardstores.com/image.webp", "https://127.0.0.1/image.webp", "https://user:secret@media.petyardstores.com/image.webp"]) {
    const layout = carousel(); layout.sections[1].data.enabled = false;
    image(layout).image_urls[1] = value; failure(layout, "INVALID_HTTPS_URL");
  }
  const unfinished = content(); delete image(unfinished).image_url;
  assert.equal(inspectLayoutContent(unfinished).valid, true);
  failure(unfinished, "IMAGE_REQUIRED", true);
});

test("subcategory actions work at all existing action owners without becoming manifest products", () => {
  const layout = content();
  const action = { type: "subcategory", value: subcategoryId.toUpperCase() };
  layout.sections[0].data.show_see_all = true; layout.sections[0].data.action = action;
  layout.sections[0].data.items.push({ id: randomUUID(), name: { en: "Treats", ar: "مكافآت" }, action: { ...action } });
  root(layout).children.push({ id: randomUUID(), type: "button", props: { label: "Browse", action: { ...action } } });
  layout.sections.push({ id: randomUUID(), position: 2, section_type: "admin_promo",
    data: { enabled: true, visibility: "all", layout: "text_strip", title: "Treats", cta_text: "Browse", action: { ...action } } });
  const result = inspectLayoutContent(layout, { publish: true });
  assert.equal(result.valid, true);
  assert.deepEqual(result.content.product_ids, content().product_ids);
  assert.equal(collectLayoutReferences(result.content).filter((entry) => entry.type === "subcategory").length, 4);
  assert.equal(result.content.sections[0].data.action.value, subcategoryId);
  const invalid = structuredClone(layout); invalid.sections[0].data.action.value = randomUUID();
  failure(invalid, "INVALID_REFERENCE_ID");
});

test("reference checks use subcategory set queries and report each unready slide without DB writes", async () => {
  const layout = carousel(); layout.sections[1].data.enabled = false;
  root(layout).children.push({ id: randomUUID(), type: "button", props: { label: "Browse",
    action: { type: "subcategory", value: subcategoryId } } });
  const seen = [], session = {};
  function model(type, resolve) {
    return { find(filter) {
      seen.push({ type, filter });
      const query = { select() { return query; }, session(value) { assert.equal(value, session); return query; },
        maxTimeMS(value) { assert.equal(value, 10000); return query; }, async lean() { return resolve(filter); } };
      return query;
    }, exists() { assert.fail("New-profile lookups must remain set-based"); } };
  }
  const subcategoryUrl = "https://media.petyardstores.com/catalog/subcategory.webp";
  image(layout).image_urls[0] = subcategoryUrl;
  const entities = model("entity", (filter) => filter._id?.$in.map((_id) => ({ _id })) ?? []);
  const errors = await inspectLayoutReferences(layout, { session,
    productModel: entities, categoryModel: entities, brandModel: entities,
    subcategoryModel: model("subcategory", (filter) => filter._id ? [] : [{ image: { url: subcategoryUrl } }]),
    assetModel: model("asset", (filter) => filter.url.$in.filter((url) => ![subcategoryUrl, urls(2)[1]].includes(url)).map((url) => ({ url }))),
  });
  assert.equal(errors.length, 2);
  assert.ok(errors.some((error) => error.code === "ASSET_NOT_READY" && error.path.endsWith("image_urls[1]")));
  assert.ok(errors.some((error) => error.code === "REFERENCE_NOT_PUBLIC" && error.path.endsWith(".action.value")));
  assert.deepEqual(seen.find((entry) => entry.type === "subcategory" && entry.filter._id).filter, { _id: { $in: [subcategoryId] } });
});

test("catalog and release checks distinguish extension storage from approved renderer support", () => {
  const names = ["UI_BUILDER_PUBLISH_ENABLED", "UI_BUILDER_ID_ONLY_MIN_APP_VERSION", "UI_BUILDER_EXTENSIONS_MIN_APP_VERSION"];
  const prior = names.map((name) => process.env[name]);
  try {
    process.env.UI_BUILDER_PUBLISH_ENABLED = "true";
    process.env.UI_BUILDER_ID_ONLY_MIN_APP_VERSION = "2.0.0";
    delete process.env.UI_BUILDER_EXTENSIONS_MIN_APP_VERSION;
    const catalog = getUiLayoutCatalog();
    assert.equal(catalog.capabilities.component_tree, true);
    assert.equal(catalog.capabilities.banner_carousel_draft_storage, true);
    assert.equal(catalog.capabilities.banner_carousel, false);
    assert.equal(catalog.capabilities.subcategory_actions_draft_storage, true);
    assert.equal(catalog.capabilities.subcategory_actions, false);
    assert.ok(catalog.actions.includes("subcategory"));
    assert.equal(catalog.limits.max_banner_images, 10);
    assert.equal(catalog.extensions_min_app_version, null);
    const schema = catalog.block_types.find((entry) => entry.key === "image").config_schema;
    assert.equal(schema.properties.image_urls.maxItems, 10);
    assert.deepEqual(schema.not.required, ["image_url", "image_urls"]);
    assert.equal(inspectClientCompatibility(carousel(), { min_app_version: "2.0.0" }, "2.0.0", null).length, 1);
    assert.equal(inspectClientCompatibility(carousel(), { min_app_version: "2.9.0" }, "2.0.0", "3.0.0").length, 1);
    assert.deepEqual(inspectClientCompatibility(carousel(), { min_app_version: "3.0.0" }, "2.0.0", "3.0.0"), []);
    assert.deepEqual(inspectClientCompatibility(content(), { min_app_version: "2.0.0" }, "2.0.0", null), []);
    process.env.UI_BUILDER_EXTENSIONS_MIN_APP_VERSION = "3.0.0";
    assert.equal(getUiLayoutCatalog().capabilities.banner_carousel, true);
    assert.equal(getUiLayoutCatalog().capabilities.subcategory_actions, true);
    process.env.UI_BUILDER_EXTENSIONS_MIN_APP_VERSION = "invalid";
    assert.equal(getUiLayoutCatalog().capabilities.banner_carousel, false);
  } finally {
    names.forEach((name, index) => { if (prior[index] === undefined) delete process.env[name]; else process.env[name] = prior[index]; });
  }
});
