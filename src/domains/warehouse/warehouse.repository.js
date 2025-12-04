import { WarehouseModel } from "./warehouse.model.js";

export async function countWarehouses(filter = {}) {
  return WarehouseModel.countDocuments(filter);
}

export async function findWarehouses(filter = {}, { skip, limit, sort } = {}) {
  const query = WarehouseModel.find(filter);

  if (typeof skip === "number" && skip > 0) {
    query.skip(skip);
  }

  if (typeof limit === "number" && limit > 0) {
    query.limit(limit);
  }

  if (sort) {
    query.sort(sort);
  }

  return query;
}

export async function findWarehouseById(id) {
  return WarehouseModel.findById(id);
}

export async function createWarehouse(doc) {
  return WarehouseModel.create(doc);
}

export async function clearAllDefaultWarehouses() {
  return WarehouseModel.updateMany({ isDefault: true }, { $set: { isDefault: false } });
}

export async function clearDefaultForOtherWarehouses(id) {
  return WarehouseModel.updateMany(
    { _id: { $ne: id }, isDefault: true },
    { $set: { isDefault: false } }
  );
}

export async function deleteWarehouseById(id) {
  return WarehouseModel.deleteOne({ _id: id });
}
