import assert from "node:assert/strict";
import { sharedMongoConnection } from "./sharedMongo.js";

const stores = ["carts", "assistantcartproposals", "assistantcartreceipts"];
export const ownerTypesPipeline = [{ $group: { _id: { $type: "$user" }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }];
export const duplicateOwnersPipeline = [
  { $match: { user: { $type: "objectId" } } },
  { $group: { _id: "$user", count: { $sum: 1 } } },
  { $match: { count: { $gt: 1 } } },
  { $group: { _id: null, owners: { $sum: 1 }, carts: { $sum: "$count" }, extraCarts: { $sum: { $subtract: ["$count", 1] } } } },
  { $project: { _id: 0, owners: 1, carts: 1, extraCarts: 1 } },
];
const sortedIndexes = (rows) => rows.map(({ v, ...row }) => row).sort((a, b) => a.name.localeCompare(b.name));
const simple = (index) => !index.collation || index.collation.locale === "simple";
const noTtl = (indexes) => indexes.every((index) => index.expireAfterSeconds === undefined);

// Read-only test-target inventory. Aggregate outputs contain counts and BSON type names, never owner IDs or cart contents.
export async function readCartReadiness(connection) {
  const { db, check } = sharedMongoConnection(connection);
  const snapshot = async () => {
    const result = {};
    for (const name of stores) {
      check(); const [collection] = await db.listCollections({ name }, { nameOnly: false }).toArray();
      check(); result[name] = collection ? { type: collection.type, options: collection.options ?? {},
        indexes: sortedIndexes(await db.collection(name).listIndexes().toArray()) } : null;
    }
    return result;
  };
  const before = await snapshot();
  assert.ok(before.carts && before.carts.type === "collection", "Existing normal cart collection required");
  const options = { maxTimeMS: 5000, allowDiskUse: false, readConcern: { level: "majority" } };
  check(); const rawTypes = await db.collection("carts").aggregate(ownerTypesPipeline, options).toArray();
  const ownerTypes = rawTypes.map(({ _id, count }) => {
    assert.equal(typeof _id, "string"); assert.ok(Number.isSafeInteger(count) && count >= 0);
    return { type: _id, count };
  });
  check(); const duplicates = await db.collection("carts").aggregate(duplicateOwnersPipeline, options).toArray();
  assert.ok(duplicates.length <= 1);
  const duplicateOwners = duplicates[0] ?? { owners: 0, carts: 0, extraCarts: 0 };
  assert.deepEqual(Object.keys(duplicateOwners).sort(), ["carts", "extraCarts", "owners"]);
  for (const count of Object.values(duplicateOwners)) assert.ok(Number.isSafeInteger(count) && count >= 0);
  assert.deepEqual(await snapshot(), before, "Store metadata changed during read-only inventory; inspect before planning setup");
  const cartUnique = before.carts.indexes.some((index) => JSON.stringify(index.key) === '{"user":1}' && index.unique === true &&
    !index.sparse && index.expireAfterSeconds === undefined && simple(index) &&
    (!index.partialFilterExpression || JSON.stringify(index.partialFilterExpression) === '{"user":{"$type":"objectId"}}'));
  const proposal = before.assistantcartproposals;
  const proposalReady = Boolean(proposal?.type === "collection" && noTtl(proposal.indexes) && proposal.indexes.some((index) =>
    JSON.stringify(index.key) === '{"owner":1,"key":1}' && index.unique === true && !index.sparse && !index.partialFilterExpression && simple(index)));
  const receipt = before.assistantcartreceipts;
  const receiptReady = Boolean(receipt?.type === "collection" && noTtl(receipt.indexes) && receipt.indexes.some((index) =>
    index.name === "_id_" && JSON.stringify(index.key) === '{"_id":1}' && !index.sparse && !index.partialFilterExpression && simple(index)));
  return { host: "magdy.pbupj.mongodb.net", database: "petyard", readOnly: true, metadataStable: true,
    stores: before, ownerTypes, duplicateOwners, readiness: { cartUnique, proposalReady, receiptReady },
    countsArePointInTime: true, dataWrites: 0, schemaWrites: 0 };
}
