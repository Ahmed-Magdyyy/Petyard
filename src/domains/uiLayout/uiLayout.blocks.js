import {
  UI_LAYOUT_MAX_ITEMS, UI_LAYOUT_MAX_BLOCK_DEPTH, UI_LAYOUT_MAX_BLOCK_NODES,
  UI_LAYOUT_MAX_BLOCK_CHILDREN, DISPLAY_TYPES, CARD_STYLES, OBJECT_ID,
  UI_LAYOUT_MAX_BANNER_IMAGES, UI_LAYOUT_ACTION_TYPES,
} from "./uiLayout.constants.js";
import {
  add, keys, uuid, bool, integer, localizedText, safeHttpsUrl, action,
} from "./uiLayout.fields.js";

const spacing = ["none", "sm", "md", "lg"];
const colors = ["ink", "maroon", "muted", "white"];
const enumSchema = (values) => ({ type: "string", enum: values });
export const localizedTextSchema = (maxLength) => ({ oneOf: [
  { type: "string", maxLength },
  { type: "object", additionalProperties: false, properties: {
    en: { type: "string", maxLength }, ar: { type: "string", maxLength },
  } },
] });
export const ACTION_SCHEMA = { type: "object", additionalProperties: false,
  required: ["type", "value"], properties: {
    type: enumSchema(UI_LAYOUT_ACTION_TYPES),
    value: { type: "string", minLength: 1, maxLength: 2048 },
  } };
export const ID_ONLY_ITEM_SCHEMA = { oneOf: [
  { type: "object", additionalProperties: false, required: ["id", "product_id"], properties: {
    id: { type: "string", format: "uuid" }, product_id: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
  } },
  { type: "object", additionalProperties: false, required: ["id", "name"], properties: {
    id: { type: "string", format: "uuid" }, name: localizedTextSchema(80),
    subtitle: localizedTextSchema(100), image_url: { type: "string", format: "uri" },
    action: { ...ACTION_SCHEMA, properties: {
      ...ACTION_SCHEMA.properties, type: enumSchema(UI_LAYOUT_ACTION_TYPES.filter((type) => type !== "product")),
    } },
  } },
] };
const itemsSchema = { type: "array", maxItems: UI_LAYOUT_MAX_ITEMS, items: ID_ONLY_ITEM_SCHEMA };

// These owned schemas also supply the catalog; no renderer defaults are injected into content.
export const BLOCK_PROP_SCHEMAS = Object.freeze({
  image: { image_url: { type: "string", format: "uri" },
    image_urls: { type: "array", minItems: 1, maxItems: UI_LAYOUT_MAX_BANNER_IMAGES,
      uniqueItems: true, items: { type: "string", format: "uri" } },
    aspect_ratio: enumSchema(["16:9", "4:3", "1:1"]), fit: enumSchema(["cover", "contain"]),
    border_radius: enumSchema(spacing), alt_text: localizedTextSchema(120) },
  text: { value: localizedTextSchema(1000),
    style: enumSchema(["title_large", "title_medium", "body_medium", "body_small"]),
    align: enumSchema(["start", "center", "end"]),
    max_lines: { type: "integer", minimum: 1, maximum: 12 }, color: enumSchema(colors) },
  button: { label: localizedTextSchema(30), variant: enumSchema(["primary", "secondary"]),
    size: enumSchema(["medium", "large"]), action: ACTION_SCHEMA },
  catalog_list: { display_type: enumSchema([...DISPLAY_TYPES]), card_style: enumSchema([...CARD_STYLES]),
    columns_per_row: { type: "integer", minimum: 1, maximum: 4 },
    limit: { type: "integer", minimum: 1, maximum: UI_LAYOUT_MAX_ITEMS }, items: itemsSchema },
  row: { preset: enumSchema(["two_columns", "three_columns"]),
    gap: enumSchema(spacing), padding: enumSchema(spacing) },
  column: { gap: enumSchema(spacing), padding: enumSchema(spacing) },
  spacer: { size: enumSchema(spacing) }, divider: { color: enumSchema(colors) },
});

function inspectImageSources(props, path, errors, publish) {
  const single = Object.hasOwn(props, "image_url");
  const multiple = Object.hasOwn(props, "image_urls");
  if (single && multiple) add(errors, path, "IMAGE_SOURCE_CONFLICT", "Use image_url or image_urls, not both.");
  if (publish && !single && !multiple) add(errors, path, "IMAGE_REQUIRED", "Select an image source.");
  if (single) safeHttpsUrl(props.image_url, `${path}.image_url`, errors, true);
  if (!multiple) return;
  const urls = props.image_urls;
  if (!Array.isArray(urls) || !urls.length || urls.length > UI_LAYOUT_MAX_BANNER_IMAGES) {
    add(errors, `${path}.image_urls`, "INVALID_IMAGE_URLS", "Use 1 to 10 distinct image URLs."); return;
  }
  if (new Set(urls).size !== urls.length) {
    add(errors, `${path}.image_urls`, "DUPLICATE_IMAGE_URL", "Each banner image URL must be distinct.");
  }
  urls.forEach((url, index) => safeHttpsUrl(url, `${path}.image_urls[${index}]`, errors, true));
}

function identity(value, path, errors, seen) {
  uuid(value, path, errors);
  const key = typeof value === "string" ? value.toLowerCase() : value;
  if (seen.has(key)) add(errors, path, "DUPLICATE_ID", "Node/item ID must be unique within its section.");
  seen.add(key);
}

export function inspectCatalogItems(items, path, errors, { publish = false, identities = new Set() } = {}) {
  if (items === undefined && !publish) return;
  if (!Array.isArray(items) || items.length > UI_LAYOUT_MAX_ITEMS || (publish && !items.length)) {
    add(errors, path, "INVALID_ITEMS", "Use at most 20 items; a published list needs at least one."); return;
  }
  items.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const product = item && Object.hasOwn(item, "product_id");
    if (!keys(item, product ? ["id", "product_id"] : ["id", "name", "subtitle", "image_url", "action"],
      itemPath, errors, ["id"])) return;
    identity(item.id, `${itemPath}.id`, errors, identities);
    if (product) {
      if (typeof item.product_id !== "string" || !OBJECT_ID.test(item.product_id)) {
        add(errors, `${itemPath}.product_id`, "INVALID_PRODUCT_ID", "Must be a 24-character hexadecimal product ID.");
      }
      return;
    }
    localizedText(item.name, `${itemPath}.name`, errors, { max: 80, required: publish, localized: true });
    localizedText(item.subtitle, `${itemPath}.subtitle`, errors, { max: 100, localized: true });
    safeHttpsUrl(item.image_url, `${itemPath}.image_url`, errors);
    action(item.action, `${itemPath}.action`, errors);
    if (item.action?.type === "product") {
      add(errors, `${itemPath}.action`, "PRODUCT_ITEM_REQUIRES_ID", "Use only id and product_id for product-card items.");
    }
  });
}

export function inspectComposedSection(data, path, errors, { publish = false } = {}) {
  if (!keys(data, ["enabled", "root"], path, errors, ["root"])) return;
  bool(data.enabled, `${path}.enabled`, errors, publish);
  const identities = new Set();
  let count = 0;
  function node(value, nodePath, depth) {
    if (depth > UI_LAYOUT_MAX_BLOCK_DEPTH) {
      add(errors, nodePath, "BLOCK_DEPTH_EXCEEDED", "Maximum block depth is 6, including the root."); return;
    }
    if (++count > UI_LAYOUT_MAX_BLOCK_NODES) {
      if (count === UI_LAYOUT_MAX_BLOCK_NODES + 1) add(errors, nodePath, "BLOCK_NODE_LIMIT_EXCEEDED", "Maximum 50 nodes per section.");
      return;
    }
    if (!keys(value, ["id", "type", "props", "children"], nodePath, errors, ["id", "type", "props"])) return;
    identity(value.id, `${nodePath}.id`, errors, identities);
    if (typeof value.type !== "string" || !Object.hasOwn(BLOCK_PROP_SCHEMAS, value.type)) {
      add(errors, `${nodePath}.type`, "BLOCK_TYPE_UNSUPPORTED", "Use a supported block type."); return;
    }
    const container = ["row", "column"].includes(value.type);
    if (depth === 1 && value.type !== "column") add(errors, `${nodePath}.type`, "BLOCK_ROOT_INVALID", "The root must be a column.");
    const propPath = `${nodePath}.props`;
    const schemas = BLOCK_PROP_SCHEMAS[value.type];
    if (!keys(value.props, Object.keys(schemas), propPath, errors)) return;
    if (value.type === "image") inspectImageSources(value.props, propPath, errors, publish);
    for (const [key, schema] of Object.entries(schemas)) {
      const fieldPath = `${propPath}.${key}`;
      const field = value.props[key];
      if (value.type === "image" && ["image_url", "image_urls"].includes(key)) continue;
      if (schema.enum && field !== undefined && !schema.enum.includes(field)) {
        add(errors, fieldPath, "BLOCK_PROP_INVALID", `Use one of: ${schema.enum.join(", ")}.`);
      } else if (schema.type === "integer") integer(field, fieldPath, errors, schema.minimum, schema.maximum);
      else if (schema.oneOf) localizedText(field, fieldPath, errors, {
        max: schema.oneOf[0].maxLength, localized: true,
        required: publish && ["value", "label"].includes(key),
      });
      else if (schema.format === "uri") safeHttpsUrl(field, fieldPath, errors, publish && key === "image_url");
      else if (key === "action") action(field, fieldPath, errors, publish);
      else if (key === "items") inspectCatalogItems(field, fieldPath, errors, { publish, identities });
    }
    if (!container) {
      if (value.children !== undefined) add(errors, `${nodePath}.children`, "BLOCK_CHILDREN_UNSUPPORTED", "Only rows and columns have children.");
      return;
    }
    if (!Array.isArray(value.children)) {
      add(errors, `${nodePath}.children`, "INVALID_ITEMS", "Container children must be an array."); return;
    }
    if (value.children.length > UI_LAYOUT_MAX_BLOCK_CHILDREN) {
      add(errors, `${nodePath}.children`, "BLOCK_CHILD_LIMIT_EXCEEDED", "Maximum 12 children per container."); return;
    }
    if (publish && depth === 1 && !value.children.length) add(errors, `${nodePath}.children`, "BLOCK_CONTENT_REQUIRED", "A published section needs content.");
    value.children.forEach((child, index) => node(child, `${nodePath}.children[${index}]`, depth + 1));
  }
  node(data.root, `${path}.root`, 1);
}
