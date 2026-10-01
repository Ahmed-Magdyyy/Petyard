import {
  UI_LAYOUT_SCHEMA_VERSION, UI_LAYOUT_MAX_BYTES, UI_LAYOUT_MAX_SECTIONS,
  UI_LAYOUT_MAX_ITEMS, NAVIGATION_ITEMS, BUILTIN_SECTION_TYPES,
  PROMO_VISIBILITY, PROMO_LAYOUTS, DISPLAY_TYPES, CARD_STYLES,
  UI_ASSET_MIME, UI_ASSET_MAX_BYTES, UI_ASSET_USAGES,
} from "./uiLayout.constants.js";
import { isUiLayoutSchedulingConfigured } from "./uiLayout.queue.js";

const ACTION_CONFIG_SCHEMA = {
  type: "object", additionalProperties: false, required: ["type", "value"],
  properties: {
    type: { enum: ["product", "category", "brand", "screen", "url"] },
    value: { type: "string", minLength: 1, maxLength: 2048 },
  },
};
const COLOR_CONFIG_SCHEMA = { type: "string", pattern: "^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$" };
const IMAGE_CONFIG_SCHEMA = { type: "string", format: "uri" };

export const UI_LAYOUT_CATALOG = Object.freeze({
  schema_version: UI_LAYOUT_SCHEMA_VERSION,
  capabilities: {
    remote_preview: false,
    publish_now: false,
    scheduled_publish: true,
    review_workflow: false,
    component_tree: false,
    chatbot_fab_config: false,
    chatbot_fab_draft_storage: true,
  },
  limits: {
    max_sections: UI_LAYOUT_MAX_SECTIONS,
    max_navigation_items: Object.keys(NAVIGATION_ITEMS).length,
    max_dynamic_items: UI_LAYOUT_MAX_ITEMS,
    max_payload_bytes: UI_LAYOUT_MAX_BYTES,
  },
  asset_upload: {
    mode: "multipart",
    endpoint: "/api/v1/admin/ui-builder/assets",
    image_field: "image",
    usage_field: "usage",
    usages: UI_ASSET_USAGES,
    allowed_mime_types: Object.values(UI_ASSET_MIME),
    max_bytes: UI_ASSET_MAX_BYTES,
  },
  section_types: [
    ...BUILTIN_SECTION_TYPES.map((key) => ({ key, repeatable: false, config_schema: { type: "object", additionalProperties: false, properties: {} } })),
    { key: "admin_promo", repeatable: true, config_schema: {
      type: "object", additionalProperties: false,
      required: ["enabled", "visibility", "layout", "title"],
      properties: {
        enabled: { type: "boolean" }, visibility: { enum: [...PROMO_VISIBILITY] },
        layout: { enum: [...PROMO_LAYOUTS] }, image_url: IMAGE_CONFIG_SCHEMA,
        title: { type: "string", maxLength: 80 }, subtitle: { type: "string", maxLength: 180 },
        cta_text: { type: "string", maxLength: 30 },
        background_color: COLOR_CONFIG_SCHEMA, title_color: COLOR_CONFIG_SCHEMA,
        subtitle_color: COLOR_CONFIG_SCHEMA, cta_background: COLOR_CONFIG_SCHEMA,
        cta_color: COLOR_CONFIG_SCHEMA, action: ACTION_CONFIG_SCHEMA,
      },
    } },
    { key: "dynamic_section", repeatable: true, config_schema: {
      type: "object", additionalProperties: false,
      required: ["enabled", "title", "display_type", "card_style", "items"],
      properties: {
        enabled: { type: "boolean" }, title: { type: "string", maxLength: 80 },
        subtitle: { type: "string", maxLength: 180 },
        display_type: { enum: [...DISPLAY_TYPES] }, card_style: { enum: [...CARD_STYLES] },
        columns_per_row: { type: "integer", minimum: 1, maximum: 4 },
        limit: { type: "integer", minimum: 1, maximum: UI_LAYOUT_MAX_ITEMS },
        show_see_all: { type: "boolean" }, background_color: COLOR_CONFIG_SCHEMA,
        action: ACTION_CONFIG_SCHEMA,
        items: { type: "array", minItems: 1, maxItems: UI_LAYOUT_MAX_ITEMS,
          items: { type: "object", additionalProperties: false, required: ["id", "name"],
            properties: { id: { type: "string", format: "uuid" },
              name: { type: "string", maxLength: 80 }, subtitle: { type: "string", maxLength: 100 },
              image_url: IMAGE_CONFIG_SCHEMA, action: ACTION_CONFIG_SCHEMA } } },
      },
    } },
  ],
  navigation_destinations: Object.entries(NAVIGATION_ITEMS).map(([key, value]) => ({
    key, ...value, required: key === "home",
  })),
  actions: ["product", "category", "brand", "screen", "url"],
});

export function getUiLayoutCatalog() {
  return {
    ...UI_LAYOUT_CATALOG,
    capabilities: {
      ...UI_LAYOUT_CATALOG.capabilities,
      publish_now: process.env.UI_BUILDER_PUBLISH_ENABLED === "true",
      scheduled_publish: process.env.UI_BUILDER_PUBLISH_ENABLED === "true" &&
        isUiLayoutSchedulingConfigured(),
    },
  };
}
