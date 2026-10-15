import {
  UI_LAYOUT_SCHEMA_VERSION, UI_LAYOUT_MAX_BYTES, UI_LAYOUT_MAX_SECTIONS,
  UI_LAYOUT_MAX_ITEMS, NAVIGATION_ITEMS, BUILTIN_SECTION_TYPES,
  PROMO_VISIBILITY, PROMO_LAYOUTS, DISPLAY_TYPES, CARD_STYLES,
  UI_ASSET_MIME, UI_ASSET_MAX_BYTES, UI_ASSET_USAGES,
  UI_LAYOUT_MAX_BLOCK_DEPTH, UI_LAYOUT_MAX_BLOCK_NODES, UI_LAYOUT_MAX_BLOCK_CHILDREN,
  UI_LAYOUT_MAX_BANNER_IMAGES, UI_LAYOUT_ACTION_TYPES,
} from "./uiLayout.constants.js";
import { isUiLayoutSchedulingConfigured } from "./uiLayout.queue.js";
import { BLOCK_PROP_SCHEMAS, ID_ONLY_ITEM_SCHEMA, localizedTextSchema, ACTION_SCHEMA } from "./uiLayout.blocks.js";
import { getIdOnlyMinimumAppVersion, getExtensionsMinimumAppVersion } from "./uiLayout.compatibility.js";
import { PRODUCT_BATCH_MAX_IDS, PRODUCT_BATCH_MAX_REQUEST_BYTES,
  PRODUCT_BATCH_MAX_RESPONSE_BYTES, PRODUCT_BATCH_QUERY_TIMEOUT_MS } from "../product/productBatch.constants.js";

const ACTION_CONFIG_SCHEMA = ACTION_SCHEMA;
const blockPropsSchema = (type, properties) => ({
  type: "object", additionalProperties: false, properties,
  ...(type === "image" ? { not: { required: ["image_url", "image_urls"] } } : {}),
});
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
    component_tree_draft_storage: true,
    product_id_references: false,
    product_id_draft_storage: true,
    banner_carousel_draft_storage: true,
    banner_carousel: false,
    subcategory_actions_draft_storage: true,
    subcategory_actions: false,
    chatbot_fab_config: false,
    chatbot_fab_draft_storage: true,
  },
  limits: {
    max_sections: UI_LAYOUT_MAX_SECTIONS,
    max_navigation_items: Object.keys(NAVIGATION_ITEMS).length,
    max_dynamic_items: UI_LAYOUT_MAX_ITEMS,
    max_payload_bytes: UI_LAYOUT_MAX_BYTES,
    max_product_ids: PRODUCT_BATCH_MAX_IDS,
    max_block_depth: UI_LAYOUT_MAX_BLOCK_DEPTH,
    max_block_nodes: UI_LAYOUT_MAX_BLOCK_NODES,
    max_block_children: UI_LAYOUT_MAX_BLOCK_CHILDREN,
    max_banner_images: UI_LAYOUT_MAX_BANNER_IMAGES,
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
  // New-profile schemas are separate so legacy consumers keep their existing definitions.
  product_reference_formats: ["id_only_v1"],
  content_profiles: [{
    key: "id_only_v1", schema_version: UI_LAYOUT_SCHEMA_VERSION,
    section_name_required: false,
    localized_text_schema: localizedTextSchema(1000),
    item_schema: ID_ONLY_ITEM_SCHEMA,
    custom_text_limits: { title: 80, subtitle: 180, cta_text: 30, item_name: 80, item_subtitle: 100 },
    composed_section: { type: "object", additionalProperties: false,
      required: ["enabled", "root"], properties: {
        enabled: { type: "boolean" }, root: { $ref: "#/$defs/root" },
      }, $defs: {
        root: { allOf: [{ $ref: "#/$defs/node" }, { properties: { type: { const: "column" } } }] },
        node: { oneOf: Object.entries(BLOCK_PROP_SCHEMAS).map(([type, properties]) => ({
          type: "object", additionalProperties: false,
          required: ["id", "type", "props", ...(["row", "column"].includes(type) ? ["children"] : [])],
          properties: { id: { type: "string", format: "uuid" }, type: { const: type },
            props: blockPropsSchema(type, properties),
            ...(["row", "column"].includes(type) ? { children: { type: "array",
              maxItems: UI_LAYOUT_MAX_BLOCK_CHILDREN, items: { $ref: "#/$defs/node" } } } : {}),
          },
        })) },
      },
    },
  }],
  block_types: Object.entries(BLOCK_PROP_SCHEMAS).map(([key, properties]) => ({ key,
    config_schema: blockPropsSchema(key, properties),
  })),
  block_renderer_tokens: { unit: "logical_pixels", spacing: { none: 0, sm: 8, md: 16, lg: 24 } },
  block_renderer_defaults: {
    image: { aspect_ratio: "16:9", fit: "cover", border_radius: "none" },
    text: { max_lines: 6, styles: {
      title_large: { font_size: 28, bold: true }, title_medium: { font_size: 22, bold: true },
      body_medium: { font_size: 16 }, body_small: { font_size: 12 },
    } },
    button: { variant: "primary", size: "medium", padding_by_size: { medium: 12, large: 20 } },
    catalog_list: { limit: 10 }, row: { preset: "two_columns", gap: "md", padding: "none" },
    column: { gap: "md", padding: "none" }, spacer: { size: "md" }, divider: { height: 16 },
  },
  product_batch: { method: "POST", endpoint: "/api/v1/products/batch", max_ids: PRODUCT_BATCH_MAX_IDS,
    max_request_bytes: PRODUCT_BATCH_MAX_REQUEST_BYTES, max_response_bytes: PRODUCT_BATCH_MAX_RESPONSE_BYTES,
    query_timeout_ms: PRODUCT_BATCH_QUERY_TIMEOUT_MS, rate_limit: { requests: 60, window_seconds: 900 } },
  navigation_destinations: Object.entries(NAVIGATION_ITEMS).map(([key, value]) => ({
    key, ...value, required: key === "home",
  })),
  actions: UI_LAYOUT_ACTION_TYPES,
});

export function getUiLayoutCatalog() {
  const minimum = getIdOnlyMinimumAppVersion();
  const extensionsMinimum = getExtensionsMinimumAppVersion();
  return {
    ...UI_LAYOUT_CATALOG,
    section_types: [...UI_LAYOUT_CATALOG.section_types, { key: "composed_section", repeatable: true,
      requires_content_profile: "id_only_v1", config_schema: UI_LAYOUT_CATALOG.content_profiles[0].composed_section }],
    content_profiles: UI_LAYOUT_CATALOG.content_profiles.map((profile) => ({ ...profile,
      section_types: UI_LAYOUT_CATALOG.section_types.filter((section) => ["admin_promo", "dynamic_section"].includes(section.key))
        .map((section) => ({ ...section, config_schema: { ...section.config_schema,
          properties: { ...section.config_schema.properties,
            title: localizedTextSchema(80), subtitle: localizedTextSchema(180),
            ...(section.key === "admin_promo" ? { cta_text: localizedTextSchema(30) } : {
              items: { ...section.config_schema.properties.items, items: ID_ONLY_ITEM_SCHEMA },
            }),
          },
        } })),
    })),
    capabilities: {
      ...UI_LAYOUT_CATALOG.capabilities,
      publish_now: process.env.UI_BUILDER_PUBLISH_ENABLED === "true",
      // These remain false during FE preparation; draft storage is advertised independently.
      component_tree: process.env.UI_BUILDER_PUBLISH_ENABLED === "true" && minimum !== null,
      product_id_references: process.env.UI_BUILDER_PUBLISH_ENABLED === "true" && minimum !== null,
      banner_carousel: process.env.UI_BUILDER_PUBLISH_ENABLED === "true" &&
        minimum !== null && extensionsMinimum !== null,
      subcategory_actions: process.env.UI_BUILDER_PUBLISH_ENABLED === "true" && extensionsMinimum !== null,
      scheduled_publish: process.env.UI_BUILDER_PUBLISH_ENABLED === "true" &&
        isUiLayoutSchedulingConfigured(),
    },
    id_only_min_app_version: minimum,
    extensions_min_app_version: extensionsMinimum,
  };
}
