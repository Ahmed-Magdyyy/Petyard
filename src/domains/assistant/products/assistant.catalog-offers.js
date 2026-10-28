import { createHash } from "node:crypto";
import { normalizeOfferAttributes } from "./assistant.product-attributes.js";
import { previewFixedBundle } from "../../bundle/bundle.components.js";
import { supportedBundleOrigin } from "../../bundle/bundle.model.js";

const objectId = value => /^[a-f\d]{24}$/i.test(String(value ?? ""));
const id = value => String(value).toLowerCase();
export const catalogSourceFields = "_id type isActive name_en name_ar desc_en desc_ar tags sku brand category subcategory price warehouseStocks.warehouse warehouseStocks.quantity variants._id variants.options variants.price variants.discountedPrice variants.sku variants.warehouseStocks.warehouse variants.warehouseStocks.quantity";

function offerStocks(source) {
  if (!Array.isArray(source?.warehouseStocks)) return [];
  const byWarehouse = new Map();
  for (const row of source.warehouseStocks) {
    const warehouse = objectId(row?.warehouse) ? id(row.warehouse) : null;
    if (!warehouse) continue;
    const rows = byWarehouse.get(warehouse) ?? [];
    rows.push(row); byWarehouse.set(warehouse, rows);
  }
  return [...byWarehouse].flatMap(([warehouse, rows]) => rows.length === 1 &&
    Number.isSafeInteger(rows[0]?.quantity) && rows[0].quantity > 0 ? [warehouse] : []);
}

function label(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    const names = [value.name_en, value.name_ar].filter(v => typeof v === "string" && v.trim()).join(" / ");
    if (names) return names;
    if (objectId(value._id)) return id(value._id);
  }
  return "";
}

function utf8Prefix(value, bytes) {
  let out = "", used = 0;
  for (const point of value) {
    const size = Buffer.byteLength(point);
    if (used + size > bytes) break;
    out += point; used += size;
  }
  return out;
}

function document({ sourceId, kind, variantId = null, text, warehouseIds }) {
  if (!objectId(sourceId) || typeof text !== "string" || !text.trim() || !text.isWellFormed() || text.includes("\u0000") || Buffer.byteLength(text, "utf8") > 2000) return null;
  return { _id: `${kind}:${id(sourceId)}:${kind === "bundle" ? "" : variantId ?? "simple"}`.replace(/:$/, ""),
    kind, sourceId: id(sourceId), variantId, text, textHash: createHash("sha256").update(text, "utf8").digest("hex"), warehouseIds };
}

function offerText(product, variant, { bundleLines = [] } = {}) {
  const taxonomy = ["brand", "category", "subcategory"].map(key => label(product[key])).filter(Boolean);
  const heading = [product.name_en, product.name_ar, product.type, ...taxonomy].filter(v => typeof v === "string" && v.trim());
  const lines = [...heading];
  if (typeof (variant ?? product).sku === "string" && (variant ?? product).sku.trim()) lines.push(`SKU: ${(variant ?? product).sku}`);
  if (Array.isArray(product.tags)) lines.push(...product.tags.filter(value => typeof value === "string" && value.trim()));
  if (variant) {
    for (const option of variant.options) lines.push(`Option (unverified): ${option.name}: ${option.value}`);
  }
  for (const [name, fact] of normalizeOfferAttributes(product, variant)) if (fact.state === "known" &&
    ["weight", "size", "color", "flavor", "pieces", "scent"].includes(name)) lines.push(`Known ${name}: ${fact.value}`);
  lines.push(...bundleLines);
  const fixed = lines.join("\n");
  if (Buffer.byteLength(fixed, "utf8") > 2000) return null;
  const descriptions = [product.desc_en, product.desc_ar].filter(v => typeof v === "string" && v.trim()).join("\n");
  return descriptions ? `${fixed}${fixed ? "\n" : ""}${utf8Prefix(descriptions, 2000 - Buffer.byteLength(fixed + (fixed ? "\n" : "")))}` : fixed;
}

export function catalogOffers(product) {
  if (!product || !objectId(product._id) || product.isActive !== true) return [];
  if (product.type === "SIMPLE") {
    const text = offerText(product, null);
    const row = document({ sourceId: product._id, kind: "product", text, warehouseIds: offerStocks(product) });
    return row ? [row] : [];
  }
  if (product.type !== "VARIANT" || !Array.isArray(product.variants) || product.variants.length > 500) return [];
  const counts = new Map();
  for (const variant of product.variants) if (variant?._id) counts.set(id(variant._id), (counts.get(id(variant._id)) ?? 0) + 1);
  return product.variants.flatMap(variant => {
    if (!variant || !objectId(variant._id) || !Array.isArray(variant.options) || variant.options.length > 100 ||
        counts.get(id(variant._id)) !== 1 ||
        variant.options.some(option => !option || typeof option.name !== "string" || typeof option.value !== "string")) return [];
    const text = offerText(product, variant);
    const row = document({ sourceId: product._id, kind: "product", variantId: id(variant._id), text, warehouseIds: offerStocks(variant) });
    return row ? [row] : [];
  });
}

function exactOfferName(product, component) {
  if (component.productType === "SIMPLE") return [product.name_en, product.name_ar].filter(value => typeof value === "string" && value.trim()).join(" / ");
  const variant = product.variants.find(row => id(row?._id) === component.variantId);
  if (!variant || !Array.isArray(variant.options) || variant.options.some(option => !option || typeof option.name !== "string" || typeof option.value !== "string")) return "";
  const name = [product.name_en, product.name_ar].filter(value => typeof value === "string" && value.trim()).join(" / ");
  const options = variant.options.map(option => `option (unverified) ${option.name}: ${option.value}`).join(", ");
  return [name, options].filter(Boolean).join(" — ");
}

export function bundleCatalogOffer(bundle, products) {
  if (!bundle || !objectId(bundle._id) || bundle.status !== "published" || !supportedBundleOrigin(bundle) || !Array.isArray(products)) return null;
  let preview, components;
  try {
    components = bundle.components.map(component => ({ ...component, productId: String(component.productId),
      variantId: component.variantId == null ? null : String(component.variantId) }));
    const first = components[0];
    const firstProduct = products.find(product => id(product?._id) === id(first?.productId));
    const firstOffer = first?.productType === "VARIANT" ? firstProduct?.variants?.find(row => id(row?._id) === id(first.variantId)) : firstProduct;
    const candidates = offerStocks(firstOffer ?? {}).filter(warehouse => components.every(component => {
      const product = products.find(row => id(row?._id) === id(component.productId));
      const offer = component.productType === "VARIANT" ? product?.variants?.find(row => id(row?._id) === id(component.variantId)) : product;
      return offerStocks(offer ?? {}).includes(warehouse);
    }));
    const warehouseIds = candidates.filter(warehouse => previewFixedBundle({ components,
      pricePiastres: bundle.pricePiastres, warehouseId: warehouse, products }).availableBundles > 0);
    preview = { warehouseIds };
  } catch { return null; }
  if (!preview.warehouseIds.length) return null;
  const lines = components.map(component => {
    const product = products.find(row => id(row?._id) === id(component.productId));
    const name = exactOfferName(product ?? {}, component);
    return name ? `${component.quantity} × ${name}` : "";
  });
  if (lines.some(line => !line)) return null;
  const text = offerText(bundle, null, { bundleLines: lines });
  return document({ sourceId: bundle._id, kind: "bundle", text, warehouseIds: preview.warehouseIds });
}
