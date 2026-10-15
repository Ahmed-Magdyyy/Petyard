import test from "node:test";
import assert from "node:assert/strict";
import { inspectLayoutReferences } from "../../../src/domains/uiLayout/uiLayout.references.js";
import { readFileSync } from "node:fs";

function model(found, seen) {
  return {
    exists(filter) {
      return { async session(session) {
        seen.push({ filter, session });
        return found ? { _id: "existing" } : null;
      } };
    },
  };
}

test("nested ID-only references use one product-set lookup and check every retained image/action", async () => {
  const content = JSON.parse(readFileSync(new URL("../../fixtures/uiLayout.idOnly.json", import.meta.url), "utf8")).content;
  content.sections[0].data.enabled = false;
  const seen = []; let calls = 0;
  const session = { id: "same-session" };
  const productModel = {
    find(filter) {
      calls++; assert.deepEqual(filter, { _id: { $in: content.product_ids }, isActive: true });
      const query = { select() { return query; }, session(value) { assert.equal(value, session); return query; },
        maxTimeMS(value) { assert.equal(value, 10000); return query; },
        async lean() { return content.product_ids.slice(0, 1).map((_id) => ({ _id })); } };
      return query;
    },
    exists() { assert.fail("Product IDs must be checked together, not per placement"); },
  };
  const catalog = {
    find(filter) {
      seen.push(filter);
      const rows = filter.url ? filter.url.$in.map((url) => ({ url })) : filter._id.$in.map((_id) => ({ _id }));
      const query = { select() { return query; }, session(value) { assert.equal(value, session); return query; },
        maxTimeMS() { return query; }, async lean() { return rows; } };
      return query;
    },
    exists() { assert.fail("New-profile references must use grouped lookups"); },
  };
  const errors = await inspectLayoutReferences(content, { productModel, session,
    categoryModel: catalog, brandModel: catalog, assetModel: catalog });
  assert.equal(calls, 1);
  assert.equal(errors.filter((error) => error.code === "PRODUCT_REFERENCE_UNAVAILABLE").length, 3);
  assert.ok(errors.some((error) => error.path.includes(".props.action.value")));
  assert.ok(errors.some((error) => error.path === "content.sections[0].data.items[1].product_id"));
  assert.equal(seen.find((filter) => filter.status === "ready").url.$in.length, 4);
});

test("publish reference checks require active products and ready/public images", async () => {
  const seen = [];
  const content = { sections: [{
    section_type: "dynamic_section",
    data: { items: [{
      image_url: "https://cdn.petyardstores.com/item.webp",
      action: { type: "product", value: "507f1f77bcf86cd799439011" },
    }] },
  }] };
  const session = { id: "same-transaction" };
  const errors = await inspectLayoutReferences(content, {
    productModel: model(false, seen),
    categoryModel: model(false, seen),
    brandModel: model(false, seen),
    assetModel: model(true, seen),
    session,
  });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "REFERENCE_NOT_PUBLIC");
  assert.equal(errors[0].path, "content.sections[0].data.items[0].action.value");
  assert.ok(seen.some((call) => call.filter.isActive === true));
  assert.ok(seen.every((call) => call.session === session));
});

test("new-profile images selected from public catalog data are approved, but missing URLs remain rejected", async () => {
  const productUrl = "https://cdn.petyardstores.com/product.webp";
  const categoryUrl = "https://cdn.petyardstores.com/category.webp";
  const missingUrl = "https://cdn.petyardstores.com/missing.webp";
  const content = { product_reference_format: "id_only_v1", product_ids: [], sections: [{
    section_type: "dynamic_section", data: { items: [productUrl, categoryUrl, missingUrl].map((image_url) => ({ image_url })) },
  }] };
  const calls = [];
  function catalog(rows) {
    return { find(filter) {
      calls.push(filter);
      const query = { select() { return query; }, session() { return query; }, maxTimeMS() { return query; },
        async lean() { return rows; } }; return query;
    }, exists() { assert.fail("No per-image reads"); } };
  }
  const errors = await inspectLayoutReferences(content, {
    assetModel: catalog([]), productModel: catalog([{ images: [{ url: productUrl }] }]),
    categoryModel: catalog([{ image: { url: categoryUrl } }]), brandModel: catalog([]), subcategoryModel: catalog([]),
  });
  assert.equal(calls.length, 5);
  assert.equal(errors.length, 1); assert.equal(errors[0].code, "ASSET_NOT_READY");
  assert.equal(errors[0].path, "content.sections[0].data.items[2].image_url");
});
