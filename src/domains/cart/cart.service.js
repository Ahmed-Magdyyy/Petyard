import { CartModel } from "./cart.model.js";
import { ProductModel } from "../product/product.model.js";
import { WarehouseModel } from "../warehouse/warehouse.model.js";
import { ApiError } from "../../shared/ApiError.js";
import { pickLocalizedField } from "../../shared/utils/i18n.js";

function normalizeLang(lang) {
  return lang === "ar" ? "ar" : "en";
}

async function assertWarehouseExists(warehouseId) {
  const exists = await WarehouseModel.exists({ _id: warehouseId });
  if (!exists) {
    throw new ApiError(`No warehouse found for this id: ${warehouseId}`, 400);
  }
}

function buildIdentityFilter({ userId, guestId }) {
  if (userId) {
    return { user: userId };
  }
  if (guestId) {
    return { guestId };
  }
  throw new ApiError("Either userId or guestId must be provided", 400);
}

async function getOrCreateCart({ userId, guestId, warehouseId }) {
  const identityFilter = buildIdentityFilter({ userId, guestId });

  let cart = await CartModel.findOne(identityFilter);

  if (!cart) {
    cart = await CartModel.create({
      ...identityFilter,
      warehouse: warehouseId,
      items: [],
      totalCartPrice: 0,
    });
  }

  return cart;
}

async function getExistingCartOrThrow({ userId, guestId, warehouseId }) {
  const identityFilter = buildIdentityFilter({ userId, guestId });

  let cart = await CartModel.findOne(identityFilter);

  if (!cart) {
    throw new ApiError("Cart not found", 404);
  }
  return cart;
}

function computeTotalCartPrice(cart) {
  const items = Array.isArray(cart.items) ? cart.items : [];

  cart.totalCartPrice = items.reduce((sum, item) => {
    const quantity = typeof item.quantity === "number" ? item.quantity : 0;
    const price = typeof item.itemPrice === "number" ? item.itemPrice : 0;
    return sum + quantity * price;
  }, 0);
}

function mapCartToResponse(cart) {
  const removedItems =
    Array.isArray(cart._removedItems) && cart._removedItems.length > 0
      ? cart._removedItems.map((item) => ({
          id: item.id,
          productId: item.productId,
          productType: item.productType,
          productName: item.productName ?? null,
          productImageUrl: item.productImageUrl ?? null,
          variantId: item.variantId ?? null,
          quantity: item.quantity,
          itemPrice: item.itemPrice,
        }))
      : undefined;

  return {
    id: cart._id,
    userId: cart.user || null,
    guestId: cart.guestId || null,
    warehouseId: cart.warehouse,
    currency: cart.currency,
    totalCartPrice: cart.totalCartPrice,
    items: Array.isArray(cart.items)
      ? cart.items.map((item) => ({
          id: item._id,
          productId: item.product,
          productType: item.productType,
          productName: item.productName || null,
          productImageUrl: item.productImageUrl || null,
          variantId: item.variantId || null,
          variantOptions: Array.isArray(item.variantOptionsSnapshot)
            ? item.variantOptionsSnapshot
            : [],
          quantity: item.quantity,
          itemPrice: item.itemPrice,
          lineTotal:
            (typeof item.quantity === "number" ? item.quantity : 0) *
            (typeof item.itemPrice === "number" ? item.itemPrice : 0),
        }))
      : [],
    removedItems,
  };
}

function pickMainImageUrl(images) {
  if (!Array.isArray(images) || images.length === 0) {
    return null;
  }

  const main = images.find((img) => img.isMain) || images[0];
  return main && main.url ? main.url : null;
}

function findVariantById(product, variantId) {
  if (!product || !Array.isArray(product.variants)) return null;
  return product.variants.find((v) => String(v._id) === String(variantId));
}

function findSimpleWarehouseStock(product, warehouseId) {
  if (!Array.isArray(product.warehouseStocks)) return null;
  return product.warehouseStocks.find(
    (ws) => String(ws.warehouse) === String(warehouseId)
  );
}

function findVariantWarehouseStock(variant, warehouseId) {
  if (!Array.isArray(variant.warehouseStocks)) return null;
  return variant.warehouseStocks.find(
    (ws) => String(ws.warehouse) === String(warehouseId)
  );
}

async function rebindCartToWarehouse(cart, warehouseId) {
  if (!cart) return null;

  await assertWarehouseExists(warehouseId);

  const items = Array.isArray(cart.items) ? cart.items : [];
  const originalItems = [...items];

  if (!items.length) {
    cart.warehouse = warehouseId;
    computeTotalCartPrice(cart);
    await cart.save();
    return cart;
  }

  const productIds = [
    ...new Set(
      items
        .map((item) => (item.product ? String(item.product) : null))
        .filter(Boolean)
    ),
  ];

  const products = await ProductModel.find({ _id: { $in: productIds } });
  const productById = new Map(products.map((p) => [String(p._id), p]));

  const keptItems = [];

  for (const item of items) {
    const product = productById.get(String(item.product));
    if (!product) continue;

    if (product.type !== item.productType) continue;

    const currentQuantity =
      typeof item.quantity === "number" && item.quantity > 0
        ? item.quantity
        : 0;
    if (currentQuantity <= 0) continue;

    let newItemPrice;
    let newProductImageUrl = item.productImageUrl || null;
    let newVariantId = item.variantId;
    let newVariantOptionsSnapshot = item.variantOptionsSnapshot;

    if (product.type === "SIMPLE") {
      const stock = findSimpleWarehouseStock(product, warehouseId);
      if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
        continue;
      }
      if (currentQuantity > stock.quantity) {
        continue;
      }

      const price = typeof product.price === "number" ? product.price : 0;
      const discounted =
        typeof product.discountedPrice === "number"
          ? product.discountedPrice
          : undefined;
      newItemPrice =
        typeof discounted === "number" ? discounted : price;

      newProductImageUrl = pickMainImageUrl(product.images);
      newVariantId = undefined;
      newVariantOptionsSnapshot = [];
    } else {
      const variant = findVariantById(product, item.variantId);
      if (!variant) continue;

      const stock = findVariantWarehouseStock(variant, warehouseId);
      if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
        continue;
      }
      if (currentQuantity > stock.quantity) {
        continue;
      }

      const price = typeof variant.price === "number" ? variant.price : 0;
      const discounted =
        typeof variant.discountedPrice === "number"
          ? variant.discountedPrice
          : undefined;
      newItemPrice =
        typeof discounted === "number" ? discounted : price;

      newVariantOptionsSnapshot = Array.isArray(variant.options)
        ? variant.options.map((o) => ({
            name: typeof o.name === "string" ? o.name : "",
            value: typeof o.value === "string" ? o.value : "",
          }))
        : [];

      if (Array.isArray(variant.images) && variant.images.length > 0) {
        newProductImageUrl = pickMainImageUrl(variant.images) || null;
      } else {
        newProductImageUrl = pickMainImageUrl(product.images);
      }

      newVariantId = variant._id;
    }

    item.itemPrice = newItemPrice;
    item.productImageUrl = newProductImageUrl || null;
    item.variantId = newVariantId;
    item.variantOptionsSnapshot = newVariantOptionsSnapshot;

    keptItems.push(item);
  }

  const keptIds = new Set(keptItems.map((it) => String(it._id)));
  const removedRaw = originalItems.filter(
    (it) => !keptIds.has(String(it._id))
  );

  cart._removedItems = removedRaw.map((it) => ({
    id: it._id,
    productId: it.product,
    productType: it.productType,
    productName: it.productName || null,
    productImageUrl: it.productImageUrl || null,
    variantId: it.variantId || null,
    quantity: it.quantity,
    itemPrice: it.itemPrice,
  }));

  cart.items = keptItems;
  cart.warehouse = warehouseId;
  computeTotalCartPrice(cart);
  await cart.save();

  return cart;
}

export async function getCartService({ userId, guestId, warehouseId }) {
  await assertWarehouseExists(warehouseId);

  const baseCart = await getOrCreateCart({ userId, guestId, warehouseId });
  const cart = await rebindCartToWarehouse(baseCart, warehouseId);
  return mapCartToResponse(cart);
}

export async function upsertCartItemService({
  userId,
  guestId,
  warehouseId,
  productId,
  productType,
  variantId,
  quantity,
  lang = "en",
}) {
  if (quantity == null || quantity <= 0) {
    throw new ApiError("quantity must be greater than 0", 400);
  }

  await assertWarehouseExists(warehouseId);

  const product = await ProductModel.findById(productId);
  if (!product) {
    throw new ApiError(`No product found for this id: ${productId}`, 404);
  }

  if (product.type !== productType) {
    throw new ApiError(
      `Product type mismatch. Expected ${product.type}, got ${productType}`,
      400
    );
  }

  const normalizedLang = normalizeLang(lang);
  const productName = pickLocalizedField(product, "name", normalizedLang);

  let itemPrice;
  let variant = null;
  let variantOptionsSnapshot = [];
  let productImageUrl = null;

  if (product.type === "SIMPLE") {
    const stock = findSimpleWarehouseStock(product, warehouseId);
    if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
      throw new ApiError(
        "This product is not available in the selected warehouse",
        400
      );
    }
    if (quantity > stock.quantity) {
      throw new ApiError(
        `Requested quantity exceeds available stock (${stock.quantity})`,
        400
      );
    }

    const price = typeof product.price === "number" ? product.price : 0;
    const discounted =
      typeof product.discountedPrice === "number"
        ? product.discountedPrice
        : undefined;
    itemPrice = typeof discounted === "number" ? discounted : price;

    productImageUrl = pickMainImageUrl(product.images);
  } else {
    variant = findVariantById(product, variantId);
    if (!variant) {
      throw new ApiError("Variant not found on this product", 404);
    }

    const stock = findVariantWarehouseStock(variant, warehouseId);
    if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
      throw new ApiError(
        "This product variant is out of stock or not available in the selected warehouse",
        400
      );
    }
    if (quantity > stock.quantity) {
      throw new ApiError(
        `Requested quantity exceeds available stock (${stock.quantity})`,
        400
      );
    }

    const price = typeof variant.price === "number" ? variant.price : 0;
    const discounted =
      typeof variant.discountedPrice === "number"
        ? variant.discountedPrice
        : undefined;
    itemPrice = typeof discounted === "number" ? discounted : price;

    variantOptionsSnapshot = Array.isArray(variant.options)
      ? variant.options.map((o) => ({
          name: typeof o.name === "string" ? o.name : "",
          value: typeof o.value === "string" ? o.value : "",
        }))
      : [];

    if (Array.isArray(variant.images) && variant.images.length > 0) {
      productImageUrl = pickMainImageUrl(variant.images) || null;
    } else {
      productImageUrl = pickMainImageUrl(product.images);
    }
  }

  const cart = await getOrCreateCart({ userId, guestId, warehouseId });

  const items = Array.isArray(cart.items) ? cart.items : [];

  const existing = items.find((item) => {
    if (!item.product || String(item.product) !== String(product._id)) {
      return false;
    }
    if (product.type === "SIMPLE") {
      return !item.variantId;
    }
    return item.variantId && String(item.variantId) === String(variant._id);
  });

  if (existing) {
    existing.quantity = quantity;
    existing.itemPrice = itemPrice;
    existing.productName = productName;
    existing.productImageUrl = productImageUrl;
    existing.variantId =
      product.type === "VARIANT" && variant ? variant._id : undefined;
    existing.variantOptionsSnapshot = variantOptionsSnapshot;
  } else {
    cart.items.push({
      product: product._id,
      productType: product.type,
      productName,
      productImageUrl,
      variantId:
        product.type === "VARIANT" && variant ? variant._id : undefined,
      variantOptionsSnapshot,
      quantity,
      itemPrice,
    });
  }

  computeTotalCartPrice(cart);
  await cart.save();

  const refreshed = await rebindCartToWarehouse(cart, warehouseId);
  return mapCartToResponse(refreshed);
}

export async function updateCartItemQuantityService({
  userId,
  guestId,
  warehouseId,
  itemId,
  quantity,
}) {
  if (quantity == null || quantity <= 0) {
    throw new ApiError("quantity must be greater than 0", 400);
  }

  const cart = await getExistingCartOrThrow({ userId, guestId, warehouseId });

  const item = cart.items.id(itemId);
  if (!item) {
    throw new ApiError("Cart item not found", 404);
  }

  const product = await ProductModel.findById(item.product);
  if (!product) {
    throw new ApiError("Product no longer exists", 400);
  }

  if (product.type !== item.productType) {
    throw new ApiError("Product type mismatch for cart item", 400);
  }

  if (product.type === "SIMPLE") {
    const stock = findSimpleWarehouseStock(product, warehouseId);
    if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
      throw new ApiError(
        "This product is not available in the selected warehouse",
        400
      );
    }
    if (quantity > stock.quantity) {
      throw new ApiError(
        `Requested quantity exceeds available stock (${stock.quantity})`,
        400
      );
    }
  } else if (product.type === "VARIANT") {
    const variant = findVariantById(product, item.variantId);
    if (!variant) {
      throw new ApiError("Variant not found on this product", 404);
    }

    const stock = findVariantWarehouseStock(variant, warehouseId);
    if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
      throw new ApiError(
        "This product variant is not available in the selected warehouse",
        400
      );
    }
    if (quantity > stock.quantity) {
      throw new ApiError(
        `Requested quantity exceeds available stock (${stock.quantity})`,
        400
      );
    }
  }

  item.quantity = quantity;
  computeTotalCartPrice(cart);
  await cart.save();

  const refreshed = await rebindCartToWarehouse(cart, warehouseId);
  return mapCartToResponse(refreshed);
}

export async function removeCartItemService({
  userId,
  guestId,
  warehouseId,
  itemId,
}) {
  const cart = await getExistingCartOrThrow({ userId, guestId, warehouseId });

  const item = cart.items.id(itemId);
  if (!item) {
    throw new ApiError("Cart item not found", 404);
  }

  item.deleteOne();
  computeTotalCartPrice(cart);
  await cart.save();

  const refreshed = await rebindCartToWarehouse(cart, warehouseId);
  return mapCartToResponse(refreshed);
}

export async function clearCartService({ userId, guestId, warehouseId }) {
  const identityFilter = buildIdentityFilter({ userId, guestId });

  await CartModel.deleteOne(identityFilter);

  return { success: true };
}

export async function mergeGuestCartService({ userId, guestId, warehouseId }) {
  if (!guestId) {
    throw new ApiError("guestId is required for merge", 400);
  }

  await assertWarehouseExists(warehouseId);

  const guestCart = await CartModel.findOne({ guestId });

  // No guest cart: just return the current user cart (or an empty one)
  if (!guestCart) {
    const baseUserCart = await getOrCreateCart({ userId, guestId: null, warehouseId });
    const refreshedUserCart = await rebindCartToWarehouse(baseUserCart, warehouseId);
    return mapCartToResponse(refreshedUserCart);
  }

  let userCart = await CartModel.findOne({ user: userId });

  // Case A: no existing user cart -> adopt guest cart
  if (!userCart) {
    guestCart.user = userId;
    guestCart.guestId = undefined;

    const adoptedCart = await rebindCartToWarehouse(guestCart, warehouseId);
    return mapCartToResponse(adoptedCart);
  }

  // Case B: both guest and user carts exist -> merge with stock capping
  const refreshedGuest = await rebindCartToWarehouse(guestCart, warehouseId);
  userCart = await rebindCartToWarehouse(userCart, warehouseId);

  const guestItems = Array.isArray(refreshedGuest.items) ? refreshedGuest.items : [];
  const userItems = Array.isArray(userCart.items) ? userCart.items : [];

  if (!guestItems.length) {
    await CartModel.deleteOne({ _id: refreshedGuest._id });
    const finalCart = await rebindCartToWarehouse(userCart, warehouseId);
    return mapCartToResponse(finalCart);
  }

  const allItems = [...userItems, ...guestItems];
  const productIds = [
    ...new Set(
      allItems
        .map((item) => (item.product ? String(item.product) : null))
        .filter(Boolean)
    ),
  ];

  const products = await ProductModel.find({ _id: { $in: productIds } });
  const productById = new Map(products.map((p) => [String(p._id), p]));

  const userItemByKey = new Map();
  for (const item of userItems) {
    const key = `${String(item.product)}|${
      item.variantId ? String(item.variantId) : "null"
    }`;
    userItemByKey.set(key, item);
  }

  for (const gItem of guestItems) {
    const product = productById.get(String(gItem.product));
    if (!product) continue;
    if (product.type !== gItem.productType) continue;

    const key = `${String(gItem.product)}|${
      gItem.variantId ? String(gItem.variantId) : "null"
    }`;
    const uItem = userItemByKey.get(key) || null;

    const guestQty =
      typeof gItem.quantity === "number" && gItem.quantity > 0
        ? gItem.quantity
        : 0;
    const userQty =
      uItem && typeof uItem.quantity === "number" && uItem.quantity > 0
        ? uItem.quantity
        : 0;

    if (guestQty <= 0 && userQty <= 0) continue;

    let available = 0;

    if (product.type === "SIMPLE") {
      const stock = findSimpleWarehouseStock(product, warehouseId);
      if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
        // No stock at all for this product in this warehouse
        continue;
      }
      available = stock.quantity;
    } else {
      const variant = findVariantById(product, gItem.variantId);
      if (!variant) continue;

      const stock = findVariantWarehouseStock(variant, warehouseId);
      if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
        // No stock for this variant in this warehouse
        continue;
      }
      available = stock.quantity;
    }

    if (available <= 0) continue;

    const desired = userQty + guestQty;
    const finalQty = desired > available ? available : desired;

    if (uItem) {
      uItem.quantity = finalQty;
    } else {
      userCart.items.push({
        product: gItem.product,
        productType: gItem.productType,
        productName: gItem.productName,
        productImageUrl: gItem.productImageUrl,
        variantId: gItem.variantId,
        variantOptionsSnapshot: Array.isArray(gItem.variantOptionsSnapshot)
          ? gItem.variantOptionsSnapshot
          : [],
        quantity: finalQty,
        itemPrice: gItem.itemPrice,
      });
    }
  }

  await CartModel.deleteOne({ _id: refreshedGuest._id });

  const finalCart = await rebindCartToWarehouse(userCart, warehouseId);
  return mapCartToResponse(finalCart);
}
