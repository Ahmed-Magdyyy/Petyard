import { CollectionModel } from "./collection.model.js";

export function findCollectionById(id) {
  return CollectionModel.findById(id);
}
