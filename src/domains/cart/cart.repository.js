import { CartModel } from "./cart.model.js";

export async function findCart(filter = {}) {
  return CartModel.findOne(filter);
}

export async function createCart(doc) {
  return CartModel.create(doc);
}

export async function deleteCart(filter = {}) {
  return CartModel.deleteOne(filter);
}

export async function findCarts(filter = {}, { skip, limit, sort, populate } = {}) {
  const query = CartModel.find(filter);

  if (typeof skip === "number" && skip > 0) {
    query.skip(skip);
  }

  if (typeof limit === "number" && limit > 0) {
    query.limit(limit);
  }

  if (sort) {
    query.sort(sort);
  }

  if (populate) {
    query.populate(populate);
  }

  return query;
}

export async function countCarts(filter = {}) {
  return CartModel.countDocuments(filter);
}

export async function markCartsAbandoned(filter, abandonedAt) {
  return CartModel.updateMany(filter, {
    $set: {
      status: "ABANDONED",
      abandonedAt,
    },
  });
}
