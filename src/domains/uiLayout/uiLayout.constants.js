export const CUSTOMER_HOME_LAYOUT_ID = "customer_home";
export const UI_LAYOUT_SCHEMA_VERSION = 1;
export const UI_LAYOUT_MAX_BYTES = 256 * 1024;
export const UI_LAYOUT_MAX_SECTIONS = 30;
export const UI_LAYOUT_MAX_ITEMS = 20;

export const NAVIGATION_ITEMS = Object.freeze({
  home: { label_key: "home", icon_key: "home" },
  videos: { label_key: "videos", icon_key: "videos" },
  favorites: { label_key: "favorites", icon_key: "favorites" },
  orders: { label_key: "myOrders", icon_key: "orders" },
  profile: { label_key: "profile", icon_key: "profile" },
});

export const BUILTIN_SECTION_TYPES = Object.freeze([
  "banners", "services", "newArrivals", "collections", "shopByUserPet",
  "petProfileBanner", "recommended", "categories", "bestSeller", "brands",
]);
export const CONFIGURABLE_SECTION_TYPES = Object.freeze(["admin_promo", "dynamic_section"]);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const OBJECT_ID = /^[0-9a-f]{24}$/i;
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const LOCALE = /^[a-z]{2}(?:-[A-Z]{2})?$/;
export const COUNTRY = /^[A-Z]{2}$/;
export const PROMO_LAYOUTS = new Set(["card", "split", "full_banner", "text_strip"]);
export const PROMO_VISIBILITY = new Set(["all", "logged_in", "guest"]);
export const DISPLAY_TYPES = new Set(["slider", "grid"]);
export const CARD_STYLES = new Set(["product_card", "pill_avatar", "square_banner"]);
export const PLATFORMS = new Set(["android", "ios", "web"]);
export const AUDIENCES = new Set(["all", "guest", "logged_in"]);

export const UI_ASSET_MIME = Object.freeze({
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
});
export const UI_ASSET_MAX_BYTES = 5 * 1024 * 1024;
export const UI_ASSET_MAX_PIXELS = 25_000_000;

export const UI_ASSET_USAGES = Object.freeze(["promo", "dynamic_item"]);
