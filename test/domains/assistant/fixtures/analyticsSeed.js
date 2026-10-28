import mongoose from "mongoose";

export function analyticsSeed(manifest) {
  const id = (value) => new mongoose.Types.ObjectId(value);
  const actor = id(manifest.records.users[0]); const warehouse = id(manifest.warehouse);
  const [sold, zero] = manifest.records.products.map(id);
  const seed = [{ collection: "users", document: { _id: actor, email: `${actor}@assistant-test.invalid`,
    name: manifest.marker, role: "admin", enabledControls: ["analytics"], active: true,
    phoneVerified: true, account_status: "confirmed", deletedAt: null } }];
  for (const [index, product] of [sold, zero].entries()) seed.push({ collection: "products", document: {
    _id: product, slug: `${manifest.marker}-${index}`, name_en: `Synthetic ${index}`, type: "SIMPLE", isActive: true,
    createdAt: new Date("2026-01-01"), warehouseStocks: [{ warehouse, quantity: 0 }],
  } });
  for (const [index, date] of ["2026-09-15", "2026-08-15"].entries()) seed.push({ collection: "orders", document: {
    _id: id(manifest.records.orders[index]), orderNumber: `${manifest.marker}-${index}`, user: actor, warehouse,
    createdAt: new Date(date), status: "delivered", total: index ? 100 : 240, paymentMethod: "cod",
    items: [{ product: sold, quantity: index ? 1 : 2, itemPrice: index ? 90 : 100 }],
  } });
  return { actor, warehouse, sold, zero, seed };
}
