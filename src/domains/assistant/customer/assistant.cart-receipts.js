import { createHash } from "node:crypto";
import { cartAdditionQuoteForComparison, writeConfirmedCartAdditionService } from "../../cart/cart.service.js";
import { AssistantCartReceipt } from "../shared/assistant.cart-receipt.model.js";
import { fields, objectId } from "../shared/assistant.validation.js";
import { reject } from "../shared/assistant.errors.js";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const maxBytes = 65536;
function resultDto(record) {
  try {
    if (typeof record.resultJson !== "string" || Buffer.byteLength(record.resultJson) > maxBytes) throw new Error();
    const result = JSON.parse(record.resultJson);
    if (hash(result) !== record.resultHash || result.cartId !== String(record.cartId)) throw new Error();
    return { proposalId: String(record._id), cartId: String(record.cartId), recordedAt: new Date(record.recordedAt).toISOString(), result };
  } catch { reject("cart_receipt_unavailable", 503); }
}

function request({ owner: ownerValue, proposalId: idValue, proposalFingerprint, addition, expectedQuote }) {
  const owner = objectId(String(ownerValue)); const id = objectId(idValue);
  if (typeof proposalFingerprint !== "string" || !/^[a-f\d]{64}$/.test(proposalFingerprint)) reject("invalid_request");
  fields(addition, ["warehouseId", "productId", "productType", "variantId", "quantity", "language"]);
  if (!Number.isSafeInteger(addition.quantity) || addition.quantity < 1 || !["ar", "en"].includes(addition.language) ||
      !["SIMPLE", "VARIANT"].includes(addition.productType) || (addition.productType === "SIMPLE" && addition.variantId != null)) reject("invalid_request");
  const args = { userId: String(owner), warehouseId: String(objectId(addition.warehouseId)), productId: String(objectId(addition.productId)),
    productType: addition.productType, variantId: addition.productType === "VARIANT" ? String(objectId(addition.variantId)) : null,
    quantity: addition.quantity, lang: addition.language };
  let comparison;
  try {
    if (Buffer.byteLength(JSON.stringify(expectedQuote)) > maxBytes) throw new Error();
    comparison = cartAdditionQuoteForComparison(expectedQuote);
  } catch { reject("invalid_request"); }
  const requestHash = hash({ owner: String(owner), proposal: String(id), proposalFingerprint, args, quote: comparison });
  return { owner, id, args, requestHash };
}

async function retained({ owner, id, requestHash }, session) {
  if (!session || typeof session.inTransaction !== "function" || !session.inTransaction()) reject("cart_transaction_required", 503);
  let indexes;
  try { indexes = await AssistantCartReceipt.collection.indexes(); } catch { reject("cart_receipt_store_unavailable", 503); }
  if (!indexes.some((entry) => entry.name === "_id_" && JSON.stringify(entry.key) === '{"_id":1}' &&
      !entry.partialFilterExpression && !entry.sparse && (!entry.collation || entry.collation.locale === "simple")) ||
      indexes.some((entry) => entry.expireAfterSeconds !== undefined)) reject("cart_receipt_store_unavailable", 503);
  const existing = await AssistantCartReceipt.findOne({ _id: id, owner }).session(session).lean();
  if (existing) {
    if (existing.requestHash !== requestHash) reject("idempotency_conflict", 409);
    return { receipt: resultDto(existing), duplicate: true };
  }
  return null;
}

// Recovery does not revalidate or reapply an already recorded addition.
export async function recoverCartAdditionReceipt(input, { session } = {}) {
  return retained(request(input), session);
}

// Internal staging only: the authenticated caller owns authorization, transaction commit and error recovery.
export async function stageCartAdditionWithReceipt(input, { session } = {}) {
  if (!session || typeof session.inTransaction !== "function" || !session.inTransaction()) reject("cart_transaction_required", 503);
  const prepared = request(input);
  const existing = await retained(prepared, session);
  if (existing) return existing;
  const { owner, id, args, requestHash } = prepared;
  const { expectedQuote } = input;
  const result = await writeConfirmedCartAdditionService(args, expectedQuote, { session });
  const resultJson = JSON.stringify(result);
  if (Buffer.byteLength(resultJson) > maxBytes) reject("cart_preview_too_large", 413);
  const [saved] = await AssistantCartReceipt.create([{ _id: id, owner, requestHash, cartId: objectId(result.cartId),
    resultJson, resultHash: hash(result), recordedAt: new Date() }], { session });
  return { receipt: resultDto(saved), duplicate: false };
}
