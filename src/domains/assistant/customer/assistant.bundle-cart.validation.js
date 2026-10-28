import { fields, objectId } from "../shared/assistant.validation.js";
import { reject } from "../shared/assistant.errors.js";
import { bundleCartEditActions } from "../../bundle/bundle.cart-edits.js";

const id = value => String(objectId(value));
export function bundleCartReviewInput(body, { allowReorder = false } = {}) {
  fields(body, ["warehouseId", "language", "change", "sourceMessageId"]);
  const source = body.sourceMessageId === undefined ? {} : { sourceMessageId: id(body.sourceMessageId) };
  if (!["en", "ar"].includes(body.language) || !["add", "set", "remove", ...bundleCartEditActions].includes(body.change?.action)) reject("invalid_request");
  const value = body.change;
  if (value.action === "reorder" && !allowReorder) reject("invalid_request");
  if (bundleCartEditActions.includes(value.action)) {
    const extras = { ordinary_add: ["productId", "productType", "variantId", "quantity"], ordinary_set: ["itemId", "quantity"],
      ordinary_remove: ["itemId"], rebind: [], address: ["userAddressId"], reorder: ["orderId"] };
    fields(value, ["action", "cartId", "expectedCartVersion", ...extras[value.action]]);
    if (!Number.isSafeInteger(value.expectedCartVersion) || value.expectedCartVersion < 0 || value.expectedCartVersion >= Number.MAX_SAFE_INTEGER) reject("invalid_request");
    const change = { action: value.action, cartId: id(value.cartId), expectedCartVersion: value.expectedCartVersion };
    if (["ordinary_add", "ordinary_set"].includes(value.action)) {
      if (!Number.isSafeInteger(value.quantity) || value.quantity < 1) reject("invalid_request");
      change.quantity = value.quantity;
    }
    if (["ordinary_set", "ordinary_remove"].includes(value.action)) change.itemId = id(value.itemId);
    if (value.action === "ordinary_add") {
      if (!["SIMPLE", "VARIANT"].includes(value.productType) || value.productType === "SIMPLE" && value.variantId != null) reject("invalid_request");
      Object.assign(change, { productId: id(value.productId), productType: value.productType,
        variantId: value.productType === "VARIANT" ? id(value.variantId) : null });
    }
    if (value.action === "address") change.userAddressId = id(value.userAddressId);
    if (value.action === "reorder") change.orderId = id(value.orderId);
    return { warehouseId: id(body.warehouseId), language: body.language, change, ...source };
  }
  fields(value, value.action === "add" ? ["action", "bundleId", "expectedRevision", "quantity"] :
    value.action === "set" ? ["action", "groupId", "quantity"] : ["action", "groupId"]);
  if (value.action !== "remove" && (!Number.isSafeInteger(value.quantity) || value.quantity < 1)) reject("invalid_request");
  if (value.action === "add" && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1)) reject("invalid_request");
  const change = value.action === "add" ? { action: "add", bundleId: id(value.bundleId), expectedRevision: value.expectedRevision, quantity: value.quantity } :
    { action: value.action, groupId: id(value.groupId), ...(value.action === "set" ? { quantity: value.quantity } : {}) };
  return { warehouseId: id(body.warehouseId), language: body.language, change, ...source };
}
export function bundleCartReviewConfirmation(body) {
  fields(body, ["expectedVersion", "fingerprint", "warehouseId"]);
  if (body.expectedVersion !== 1 || typeof body.fingerprint !== "string" || !/^[a-f\d]{64}$/.test(body.fingerprint)) reject("invalid_request");
  return { expectedVersion: 1, fingerprint: body.fingerprint, warehouseId: id(body.warehouseId) };
}
