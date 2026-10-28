import { roles } from "../../../shared/constants/enums.js";
import { embeddingProfile } from "../providers/openaiEmbeddings.js";
import { MONTHLY_CEILING_MICRO_USD, periods, reservationMicroUsd } from "../shared/assistant.config.js";
import { reject } from "../shared/assistant.errors.js";
import { fields, objectId, text } from "../shared/assistant.validation.js";
import { settleCost, transaction } from "../shared/assistant.store.js";
import { AssistantEmbeddingBatch, assertEmbeddingBatchStore } from "../references/assistant.embedding-batch.model.js";
import { requireAnalyticsActor } from "./assistant.admin-access.js";

const date = value => value instanceof Date && Number.isFinite(value.getTime());
const utc = value => date(value) ? value.toISOString() : null;
const projection = "kind owner reference run sourceId offerId model dimensions status accounting reservation chargedMicroUsd providerRequestId createdAt dispatchDeadline failureCode reconciliation config";
function savedReservation(row) {
  try {
    const saved = row.reservation, config = row.config;
    if (!saved || !date(saved.reservedAt) || config?.timezone !== "Africa/Cairo" ||
        ![embeddingProfile.model, "text-embedding-3-small"].includes(row.model) || row.dimensions !== embeddingProfile.dimensions ||
        !Number.isSafeInteger(saved.amount) || saved.amount < 1 || saved.amount > MONTHLY_CEILING_MICRO_USD ||
        saved.amount !== reservationMicroUsd(config) || saved.priceVersion !== config.price.version) throw new Error();
    const period = periods(config, saved.reservedAt);
    const expected = [`global:${period.month}`, `user:${row.owner}:${period.day}`];
    if (saved.month !== period.month || saved.day !== period.day || !Array.isArray(saved.budgetIds) ||
        saved.budgetIds.length !== 2 || saved.budgetIds.some((id, index) => id !== expected[index])) throw new Error();
    return saved;
  } catch { reject("embedding_accounting_unavailable", 503); }
}
function deadline(row) {
  if (date(row.dispatchDeadline)) return row.dispatchDeadline;
  // Legacy receipts have no deadline; the adapter has always enforced at most 30 seconds, plus settlement grace.
  return date(row.reservation?.reservedAt) ? new Date(row.reservation.reservedAt.getTime() + 60_000) : null;
}
function canReconcile(row, now) {
  if (row.accounting !== "reserved" || !(row.status === "uncertain" || row.status === "dispatching" && deadline(row) && deadline(row) <= now)) return false;
  try { savedReservation(row); return true; } catch { return false; }
}
export function embeddingReviewDto(row, now = new Date()) {
  return { id: String(row._id), kind: row.kind ?? "reference", ownerId: String(row.owner),
    referenceId: row.reference ? String(row.reference) : null, runId: row.run ? String(row.run) : null,
    ...(row.kind === "catalog_offer" ? { sourceId: String(row.sourceId), offerId: row.offerId } : {}),
    model: row.model, dimensions: row.dimensions, status: row.status, accounting: row.accounting,
    reservedMicroUsd: Number.isSafeInteger(row.reservation?.amount) ? row.reservation.amount : null,
    chargedMicroUsd: row.chargedMicroUsd ?? null, providerRequestId: row.providerRequestId ?? null,
    createdAt: utc(row.createdAt), dispatchDeadline: utc(deadline(row)),
    failureCode: /^[a-z_]{1,80}$/.test(row.failureCode ?? "") ? row.failureCode : null,
    canReconcile: canReconcile(row, now), reconciliation: row.reconciliation ? {
      resolution: row.reconciliation.resolution, reason: row.reconciliation.reason,
      actorId: String(row.reconciliation.actor), at: utc(row.reconciliation.at),
    } : null };
}

export function createEmbeddingReviewService({ batches = AssistantEmbeddingBatch, ensureStore = assertEmbeddingBatchStore,
  getActor = requireAnalyticsActor, atomic = transaction, settle = settleCost, now = () => new Date() } = {}) {
  async function admit(value, session = null) {
    const actor = objectId(String(value)), { user } = await getActor(actor, { session, allowBlocked: true });
    if (user.role !== roles.SUPER_ADMIN) reject("access_denied", 403);
    return actor;
  }
  async function find(id, session = null) {
    const row = await batches.findById(id).session(session).maxTimeMS(5000);
    if (!row) reject("embedding_batch_not_found", 404);
    return row;
  }
  return {
    async list(actor, query) {
      await admit(actor); fields(query, ["before", "limit"]);
      const limit = query.limit === undefined ? 20 : Number(query.limit);
      if (query.limit !== undefined && typeof query.limit !== "string" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) reject("invalid_request");
      const before = query.before === undefined ? null : objectId(query.before);
      await ensureStore();
      const rows = await batches.find({ accounting: "reserved", status: { $in: ["dispatching", "uncertain"] },
        ...(before ? { _id: { $lt: before } } : {}) }).select(projection).sort({ _id: -1 }).limit(limit + 1).maxTimeMS(5000).lean();
      return { batches: rows.slice(0, limit).map(row => embeddingReviewDto(row, now())), nextBefore: rows.length > limit ? String(rows[limit - 1]._id) : null };
    },
    async get(actor, value) {
      await admit(actor); const id = objectId(value); await ensureStore();
      return embeddingReviewDto(await find(id), now());
    },
    async reconcile(actorValue, value, body) {
      await admit(actorValue); const id = objectId(value); fields(body, ["resolution", "reason"]);
      if (body.resolution !== "charge_reserved") reject("invalid_resolution");
      const reason = text(body.reason, 500); await ensureStore();
      return atomic(async session => {
        const actor = await admit(actorValue, session), row = await find(id, session);
        if (row.accounting === "charged_reservation" && row.reconciliation?.resolution === "charge_reserved") {
          return { batch: embeddingReviewDto(row, now()), duplicate: true };
        }
        if (row.accounting !== "reserved" || !["dispatching", "uncertain"].includes(row.status) ||
            row.status === "dispatching" && (!deadline(row) || deadline(row) > now())) reject("embedding_not_reconcilable", 409);
        savedReservation(row);
        if (!await settle(row, null, session, { chargeReservation: true })) reject("embedding_accounting_unavailable", 503);
        row.status = "failed"; row.failureCode = "embedding_closed_after_review"; row.vectors = undefined;
        row.reconciliation = { resolution: "charge_reserved", reason, actor, at: now() };
        await row.save({ session });
        return { batch: embeddingReviewDto(row, now()), duplicate: false };
      });
    },
  };
}
export const embeddingReviewService = createEmbeddingReviewService();
