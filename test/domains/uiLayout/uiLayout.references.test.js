import test from "node:test";
import assert from "node:assert/strict";
import { inspectLayoutReferences } from "../../../src/domains/uiLayout/uiLayout.references.js";

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
