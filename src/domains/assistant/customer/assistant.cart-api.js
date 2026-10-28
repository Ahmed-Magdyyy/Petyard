import { UserModel } from "../../user/user.model.js";
import { AssistantCartProposal } from "../shared/assistant.cart-proposal.model.js";
import { objectId } from "../shared/assistant.validation.js";
import { fromPiastres } from "../../../shared/utils/money.js";
import { prepareBundleCartReview, getBundleCartReviewState, confirmBundleCartReview } from "./assistant.bundle-cart-proposals.js";
import { ApiError } from "../../../shared/utils/ApiError.js";
import { requireCartActions } from "../shared/assistant.config.js";
import { AssistantError, reject } from "../shared/assistant.errors.js";
import { fields } from "../shared/assistant.validation.js";
import { admitCartRequest, prepareCartAdditionProposal, getCartAdditionState, confirmCartAdditionProposal } from "./assistant.cart-proposals.js";

async function bundleActor(owner) {
  return UserModel.findById(owner).select("_id role active phoneVerified deletedAt account_status").maxTimeMS(5000).lean();
}
async function isBundleProposal(owner, id, config) {
  if (config.bundleCartEnabled !== true) return false;
  const record = await AssistantCartProposal.findOne({ _id: objectId(id), owner: objectId(String(owner)) }).select("inputJson").maxTimeMS(5000).lean();
  if (!record) reject("cart_proposal_not_found", 404);
  try {
    const value = JSON.parse(record.inputJson);
    if (value.kind !== "bundle_cart_review_v1") return false;
    if (!value.request?.sourceMessageId || value.request.change?.action !== "add") reject("cart_proposal_unavailable", 503);
    return true;
  } catch { reject("cart_proposal_unavailable", 503); }
}
function publicBundleQuote(quote) {
  const item = row => Object.fromEntries(["id", "productId", "productType", "variantId", "productName", "productImageUrl", "quantity", "itemPrice", "lineTotal", "variantOptions", "reason"]
    .filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
  const group = row => {
    const snapshot = quote.groups.find(group => group.id === row.id);
    return { id: row.id, bundleId: row.bundleId, bundleRevision: row.bundleRevision, type: "BUNDLE", quantity: row.quantity,
      itemPrice: fromPiastres(row.unitPricePiastres), name: snapshot?.name ?? null, image: snapshot?.image ?? null,
      components: (snapshot?.components ?? []).map(({ productId, productType, variantId, name, image, variantOptions, quantity }) =>
        ({ productId, productType, variantId: variantId ?? null, name, image: image ?? null, variantOptions, quantity })) };
  };
  const selected = quote.groupsAfter.find(row => row.quantity > (quote.groupsBefore.find(before => before.bundleId === row.bundleId)?.quantity ?? 0));
  return { type: "BUNDLE", action: quote.action, cartId: quote.cartId, warehouseId: quote.warehouseId, currency: quote.currency, pricingScope: quote.pricingScope,
    addition: selected ? { bundleId: selected.bundleId, quantity: selected.quantity - (quote.groupsBefore.find(row => row.bundleId === selected.bundleId)?.quantity ?? 0), itemPrice: fromPiastres(selected.unitPricePiastres) } : null,
    bundlesBefore: quote.groupsBefore.map(group), bundlesAfter: quote.groupsAfter.map(group),
    itemsBefore: (quote.ordinaryItemsBefore ?? []).map(item), itemsAfter: (quote.ordinaryItemsAfter ?? []).map(item), removedItems: (quote.removedOrdinaryItems ?? []).map(item),
    ordinarySubtotal: fromPiastres(quote.ordinarySubtotalPiastres), bundleSubtotal: fromPiastres(quote.bundleSubtotalPiastres), subtotal: fromPiastres(quote.itemsSubtotalPiastres) };
}
function publicBundleResult(result) {
  return { ...result, ...(result.proposal ? { proposal: { ...result.proposal, quote: publicBundleQuote(result.proposal.quote) } } : {}),
    ...(result.receipt ? { receipt: { proposalId: result.receipt.proposalId, cartId: result.receipt.cartId, recordedAt: result.receipt.recordedAt, result: publicBundleQuote(result.receipt.result) } } : {}) };
}

async function operation(owner, config, callback) {
  requireCartActions(config);
  await admitCartRequest(owner, config);
  try { return await callback(); } catch (error) {
    if (error instanceof AssistantError) throw error;
    if (error instanceof ApiError && [400, 404, 409].includes(error.statusCode)) reject("cart_requote_required", 409);
    throw error;
  }
}

export async function prepareCartProposal(owner, body, key, config) {
  return operation(owner, config, async () => {
    if (Object.hasOwn(body ?? {}, "bundleId")) {
      fields(body, ["sourceMessageId", "warehouseId", "bundleId", "expectedRevision", "quantity", "language"]);
      const actor = await bundleActor(owner);
      const prepared = await prepareBundleCartReview(actor, { sourceMessageId: String(objectId(body.sourceMessageId)), warehouseId: body.warehouseId, language: body.language,
        change: { action: "add", bundleId: body.bundleId, expectedRevision: body.expectedRevision, quantity: body.quantity } }, key, config);
      return publicBundleResult({ ...await getBundleCartReviewState(actor, prepared.proposal.id, config), duplicate: prepared.duplicate });
    }
    const expiresAt = new Date(Date.now() + config.cartPolicy.proposalSeconds * 1000);
    const prepared = await prepareCartAdditionProposal(owner, body, key, config, { expiresAt, boundToSource: true });
    const state = await getCartAdditionState(owner, prepared.proposal.id, config);
    return { ...state, duplicate: prepared.duplicate };
  });
}

export async function getCartProposal(owner, id, query, config) {
  fields(query, []);
  return operation(owner, config, async () => (await isBundleProposal(owner, id, config))
    ? publicBundleResult(await getBundleCartReviewState(await bundleActor(owner), id, config)) : getCartAdditionState(owner, id, config));
}

export async function confirmCartProposal(owner, id, body, config) {
  return operation(owner, config, async () => (await isBundleProposal(owner, id, config))
    ? publicBundleResult(await confirmBundleCartReview(await bundleActor(owner), id, body, config)) : confirmCartAdditionProposal(owner, id, body, config));
}
