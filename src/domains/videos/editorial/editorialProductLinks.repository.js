import { ProductModel } from "../../product/product.model.js";
import { normalizedVideoProductIds, invalidVideoProductLink } from "./editorialProductLinks.validators.js";

export async function assertVideoProductsEligible(productIds, { products = ProductModel, session = null } = {}) {
  const ids = normalizedVideoProductIds(Array.isArray(productIds) ? productIds.map(String) : productIds);
  if (!ids.length) return;
  const rows = await products.find({ _id: { $in: ids }, isActive: true }).select("_id").session(session).lean();
  const eligible = new Set(rows.map(row => String(row._id)));
  const missingIndex = ids.findIndex(id => !eligible.has(id));
  if (missingIndex !== -1) throw invalidVideoProductLink(`productIds[${missingIndex}]`);
}
