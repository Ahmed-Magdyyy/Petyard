import ExcelJS from "exceljs";
import { PassThrough } from "node:stream";

const CELL_TEXT_LIMIT = 30000;
const LEGACY_HEADERS = [
  "Product Name EN", "Product Name AR", "Category Name EN", "Category Name AR",
  "Subcategory EN", "Subcategory AR", "Nested Subcategory EN",
  "Nested Subcategory AR", "Variant", "Price +15%",
  "Product Image URLs", "Variant Image URLs",
];
const DETAIL_HEADERS_BEFORE_TEXT = [
  "Brand EN", "Brand AR", "Product Type", "SKU", "Stored Price",
  "Discounted Price", "Stock Total", "Warehouse Stock", "Active",
  "Featured", "Default Variant", "Tags", "Product Options",
];
const DETAIL_HEADERS_AFTER_TEXT = [
  "Rating Average", "Rating Count", "Product ID", "Variant ID", "Slug",
  "Created UTC", "Updated UTC", "DB Version",
];

function splitForExcel(value) {
  const text = String(value ?? "");
  if (!text) return [""];
  const parts = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + CELL_TEXT_LIMIT, text.length);
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

function id(value) {
  return value == null ? "" : String(value);
}

function displayDate(value) {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}

function yesNo(value) {
  return value == null ? "" : value ? "Yes" : "No";
}

function optionLabel(options) {
  return (options || []).map(({ name, value }) => `${name || ""}: ${value || ""}`).join(" · ");
}

function productOptionLabel(options) {
  return (options || [])
    .map(({ name, values }) => `${name || ""}: ${(values || []).join(", ")}`)
    .join(" · ");
}

function imageUrls(images) {
  return (images || []).map(({ url }) => url).filter(Boolean).join(" | ");
}

function stockTotal(stocks) {
  return (stocks || []).reduce((total, stock) => total + (Number(stock.quantity) || 0), 0);
}

function buildLookups(data) {
  return Object.fromEntries(
    ["categories", "subcategories", "brands", "warehouses"].map((key) => [
      key,
      new Map((data[key] || []).map((item) => [id(item._id), item])),
    ]),
  );
}

function lookup(lookups, key, value) {
  return lookups[key].get(id(value)) || {};
}

function name(lookups, key, value, lang = "en") {
  const item = lookup(lookups, key, value);
  return item[`name_${lang}`] || item.name || "";
}

function subcategoryColumns(lookups, product) {
  const child = lookup(lookups, "subcategories", product.subcategory);
  const parent = lookup(lookups, "subcategories", child.parent);
  if (parent._id) {
    return [parent.name_en || "", parent.name_ar || "", child.name_en || "", child.name_ar || ""];
  }
  return [child.name_en || "", child.name_ar || "", "", ""];
}

function warehouseSummary(lookups, stocks) {
  return (stocks || []).map((stock) => {
    const warehouse = lookup(lookups, "warehouses", stock.warehouse);
    return `${warehouse.name || warehouse.code || id(stock.warehouse)}: ${stock.quantity ?? 0}`;
  }).join(" | ");
}

function partHeaders(label, count) {
  return Array.from({ length: count }, (_, index) =>
    index === 0 ? label : `${label} (part ${index + 1})`);
}

function paddedParts(value, count) {
  const parts = splitForExcel(value);
  return Array.from({ length: count }, (_, index) => parts[index] || "");
}

function ensureCellLimits(values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 32767) {
      throw new Error("A product export value exceeds Excel's cell limit");
    }
  }
}

export async function buildProductClientExport(data, generatedAt = new Date()) {
  const products = data.products || [];
  const lookups = buildLookups(data);
  const jsonById = new Map(products.map((product) => [id(product._id), JSON.stringify(product)]));
  const partCounts = {
    en: Math.max(1, ...products.map((product) => splitForExcel(product.desc_en).length)),
    ar: Math.max(1, ...products.map((product) => splitForExcel(product.desc_ar).length)),
    raw: Math.max(1, ...[...jsonById.values()].map((value) => splitForExcel(value).length)),
  };

  const headers = [
    ...LEGACY_HEADERS,
    ...DETAIL_HEADERS_BEFORE_TEXT,
    ...partHeaders("Description EN", partCounts.en),
    ...partHeaders("Description AR", partCounts.ar),
    ...DETAIL_HEADERS_AFTER_TEXT,
    ...partHeaders("Complete DB Record", partCounts.raw),
  ];
  const widths = [
    56, 56, 23, 23, 29, 29, 32, 32, 43, 16, 90, 90,
    25, 25, 15, 25, 16, 18, 16, 56, 12, 12, 17, 45, 55,
    ...Array(partCounts.en + partCounts.ar).fill(75),
    17, 15, 28, 28, 48, 25, 25, 15,
    ...Array(partCounts.raw).fill(110),
  ];
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (chunk) => chunks.push(chunk));
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: output,
    useStyles: true,
    useSharedStrings: true,
  });
  workbook.creator = "Petyard";
  workbook.subject = `Live product catalog ${generatedAt.toISOString()}`;
  workbook.created = generatedAt;
  const sheet = workbook.addWorksheet("Products", {
    views: [{ state: "frozen", xSplit: 2, ySplit: 1, topLeftCell: "C2", showGridLines: false }],
  });
  sheet.columns = headers.map((header, index) => ({ header, width: widths[index] || 18 }));
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length - partCounts.raw } };
  sheet.getRow(1).height = 34;
  sheet.getRow(1).eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF17324D" } };
    cell.font = { name: "Calibri", bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "medium", color: { argb: "FF0E7490" } } };
  });
  for (let column = headers.length - partCounts.raw + 1; column <= headers.length; column += 1) {
    sheet.getColumn(column).hidden = true;
  }
  sheet.getColumn(10).numFmt = "#,##0";
  sheet.getColumn(17).numFmt = "#,##0.00";
  sheet.getColumn(18).numFmt = "#,##0.00";
  sheet.getColumn(19).numFmt = "#,##0";

  const sorted = [...products].sort((a, b) =>
    (a.name_en || "").localeCompare(b.name_en || "") || id(a._id).localeCompare(id(b._id)));
  for (const [groupIndex, product] of sorted.entries()) {
    const variants = product.type === "VARIANT" ? product.variants || [] : [];
    const items = product.type === "VARIANT" ? (variants.length ? variants : [null]) : [null];
    const raw = jsonById.get(id(product._id));
    for (const [itemIndex, variant] of items.entries()) {
      const sellable = variant || product;
      const stock = sellable.warehouseStocks || [];
      const price = sellable.price;
      const values = [
        product.name_en || "",
        product.name_ar || "",
        name(lookups, "categories", product.category),
        name(lookups, "categories", product.category, "ar"),
        ...subcategoryColumns(lookups, product),
        variant ? optionLabel(variant.options) : "",
        typeof price === "number" ? Math.round(price * 1.15) : "",
        imageUrls(product.images),
        variant ? imageUrls(variant.images) : "",
        name(lookups, "brands", product.brand),
        name(lookups, "brands", product.brand, "ar"),
        product.type || "",
        sellable.sku || "",
        price ?? "",
        sellable.discountedPrice ?? "",
        stockTotal(stock),
        warehouseSummary(lookups, stock),
        yesNo(product.isActive),
        yesNo(product.isFeatured),
        variant ? yesNo(variant.isDefault) : "",
        (product.tags || []).join(", "),
        productOptionLabel(product.options),
        ...paddedParts(product.desc_en, partCounts.en),
        ...paddedParts(product.desc_ar, partCounts.ar),
        product.ratingAverage ?? "",
        product.ratingCount ?? "",
        id(product._id),
        variant ? id(variant._id) : "",
        product.slug || "",
        displayDate(product.createdAt),
        displayDate(product.updatedAt),
        product.__v ?? "",
        ...paddedParts(raw, partCounts.raw),
      ];
      ensureCellLimits(values);
      const row = sheet.addRow(values);
      row.height = 23;
      if (groupIndex % 2 === 1) {
        row.eachCell({ includeEmpty: true }, (cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F5FA" } };
        });
      }
      if (itemIndex === 0) {
        row.eachCell({ includeEmpty: true }, (cell) => {
          cell.border = { top: { style: "hair", color: { argb: "FFB7C7D8" } } };
        });
      }
      row.eachCell((cell) => {
        cell.alignment = { vertical: "middle" };
        cell.font = { name: "Calibri", size: 11, color: { argb: "FF243247" } };
      });
      row.commit();
    }
  }
  sheet.pageSetup = { fitToPage: true, fitToWidth: 1, orientation: "landscape" };
  sheet.commit();
  await workbook.commit();
  return Buffer.concat(chunks);
}
