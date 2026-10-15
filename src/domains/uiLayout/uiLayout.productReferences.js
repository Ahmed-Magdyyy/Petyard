import { PRODUCT_BATCH_MAX_IDS } from "../product/productBatch.constants.js";
import { OBJECT_ID, UI_LAYOUT_ENTITY_ACTION_TYPES } from "./uiLayout.constants.js";
import { add } from "./uiLayout.fields.js";

// Call only after structural validation. Action precedes items/children at each owner.
export function collectLayoutReferences(content) {
  const references = [];
  function owned(value, path) {
    if (!value) return;
    if (value.product_id) references.push({ type: "product", value: value.product_id,
      path: `${path}.product_id`, owner: value, key: "product_id" });
    if (value.image_url) references.push({ type: "asset", value: value.image_url, path: `${path}.image_url` });
    value.image_urls?.forEach((url, index) => references.push({ type: "asset", value: url,
      path: `${path}.image_urls[${index}]` }));
    if (value.action) references.push({ ...value.action, path: `${path}.action.value`, owner: value.action, key: "value" });
    value.items?.forEach((item, index) => owned(item, `${path}.items[${index}]`));
  }
  function block(node, path) {
    owned(node.props, `${path}.props`);
    node.children?.forEach((child, index) => block(child, `${path}.children[${index}]`));
  }
  content.sections?.forEach((section, index) => {
    const path = `content.sections[${index}].data`;
    if (["admin_promo", "dynamic_section"].includes(section.section_type)) owned(section.data, path);
    if (section.section_type === "composed_section") block(section.data.root, `${path}.root`);
  });
  // Current navigation/FAB destinations are fixed routes, not typed product actions.
  return references;
}

export function inspectProductManifest(content, errors) {
  const ids = content.product_ids;
  if (!Array.isArray(ids) || ids.length > PRODUCT_BATCH_MAX_IDS) {
    add(errors, "content.product_ids", "PRODUCT_MANIFEST_INVALID", `Supply a list of at most ${PRODUCT_BATCH_MAX_IDS} product IDs.`); return;
  }
  const normalized = [];
  ids.forEach((id, index) => {
    if (typeof id !== "string" || !OBJECT_ID.test(id)) {
      add(errors, `content.product_ids[${index}]`, "INVALID_PRODUCT_ID", "Must be a 24-character hexadecimal product ID.");
    } else normalized.push(id.toLowerCase());
  });
  const supplied = new Set(normalized);
  if (supplied.size !== normalized.length) add(errors, "content.product_ids", "PRODUCT_MANIFEST_DUPLICATE", "Product IDs must be unique.");
  const expected = new Set(collectLayoutReferences(content).filter((entry) => entry.type === "product")
    .map((entry) => entry.value.toLowerCase()));
  if (expected.size > PRODUCT_BATCH_MAX_IDS) add(errors, "content.product_ids", "PRODUCT_MANIFEST_LIMIT_EXCEEDED", "Maximum 50 unique explicit products per layout.");
  if (expected.size !== supplied.size || [...expected].some((id) => !supplied.has(id))) {
    add(errors, "content.product_ids", "PRODUCT_MANIFEST_MISMATCH", "The product list must match every product referenced in the layout.");
  }
}

export function canonicalizeProductReferences(content) {
  const ids = new Set();
  for (const entry of collectLayoutReferences(content)) {
    if (UI_LAYOUT_ENTITY_ACTION_TYPES.includes(entry.type)) entry.owner[entry.key] = entry.value.toLowerCase();
    if (entry.type === "product") ids.add(entry.value.toLowerCase());
  }
  content.product_ids = [...ids];
}
