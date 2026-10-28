import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { UserModel } from "../../user/user.model.js";
import { PetModel } from "../../pet/pet.model.js";
import { AssistantAccount, AssistantChat } from "../shared/assistant.models.js";
import { AssistantBookingProposal, assertBookingProposalStore as storeReady } from "../shared/assistant.booking-proposal.model.js";
import { fields, objectId } from "../shared/assistant.validation.js";
import { reject } from "../shared/assistant.errors.js";
import { transaction } from "../shared/assistant.store.js";
import { subjectsFor, subjectFingerprint, subjectFromPet, PET_CONTEXT_FIELDS } from "./assistant.context.js";
import { assertBookingReadAccess, getAssistantBookingPreview, resolveAssistantBookingArea, bookingLocationInput } from "./assistant.booking-reads.js";
import { bookingPreviewForComparison, parseAssistantBookingSelection } from "../../serviceReservation/reservations/serviceReservation.preview.js";
import { assistantBookingEligibility } from "../../serviceReservation/reservations/serviceReservation.eligibility.js";
import { requireBookingActions, requireBookingReads } from "../shared/assistant.config.js";
import { stageBookingWithReceipt, recoverBookingReceipt, validateBookingReceipt } from "./assistant.booking-receipts.js";

// Stable object ordering makes a JSON field-order change an exact retry, not a different booking.
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && value.constructor === Object
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const encode = (value) => {
  const json = JSON.stringify(canonical(value));
  if (typeof json !== "string" || Buffer.byteLength(json) > 65536) reject("booking_preview_too_large", 413);
  return json;
};
const hash = (value) => createHash("sha256").update(encode(value)).digest("hex");
function input(body) {
  fields(body, ["location", "language", "booking"]);
  if (!["en", "ar"].includes(body.language) || body.location?.constructor !== Object || body.booking?.constructor !== Object) reject("invalid_request");
  // Copy before awaiting dependencies; internal callers cannot change the saved selection during a read.
  const args = structuredClone({ location: body.location, language: body.language, booking: body.booking });
  encode(args);
  return args;
}
async function context(owner, args, config, session = null) {
  const account = await assertBookingReadAccess(owner, config, session);
  const user = await UserModel.findById(owner).select("name phone").maxTimeMS(5000).session(session).lean();
  const chat = await AssistantChat.findOne({ owner }).maxTimeMS(5000).session(session).lean();
  if (!user || !chat || !Number.isSafeInteger(chat.contextVersion) || chat.contextVersion < 0) reject("context_changed", 409);
  const subjects = await subjectsFor(owner, chat, config, session);
  const active = chat.activeSubject ? subjects.find((pet) => pet.id === chat.activeSubject) : null;
  const target = args.booking.petId == null ? null : subjects.find((pet) => pet.id === `pet:${String(objectId(args.booking.petId))}`);
  if (chat.activeSubject && !active || args.booking.petId != null && !target) reject("context_changed", 409);
  const binding = hash({ owner: String(owner), chat: String(chat._id), contextVersion: chat.contextVersion,
    activeSubject: chat.activeSubject ?? null, activeProfile: subjectFingerprint(active), targetProfile: subjectFingerprint(target),
    contact: { name: user.name ?? null, phone: user.phone ?? null }, restrictionVersion: account.restrictionVersion ?? 0, config: config.signature });
  return { binding, account, chat, active, target };
}
const scope = async (...args) => (await context(...args)).binding;
const fingerprint = (record, quote) => hash({ id: String(record._id), owner: String(record.owner), requestHash: record.requestHash,
  binding: record.binding, version: record.version, expiresAt: new Date(record.expiresAt).toISOString(), quote });
function dto(record) {
  if (record.detailsRemovedAt) reject("booking_review_removed", 410);
  try {
    if (record.version !== 1 || typeof record.inputJson !== "string" || typeof record.quoteJson !== "string" ||
      Buffer.byteLength(record.inputJson) > 65536 || Buffer.byteLength(record.quoteJson) > 65536) throw new Error();
    if (hash(input(JSON.parse(record.inputJson))) !== record.requestHash) throw new Error();
    const quote = JSON.parse(record.quoteJson);
    if (quote.eligible !== true || quote.status !== "ready" || quote.slotReserved !== false || quote.estimateOnly !== true ||
      !Number.isFinite(new Date(record.expiresAt).getTime()) || fingerprint(record, quote) !== record.fingerprint) throw new Error();
    return { id: String(record._id), version: record.version, fingerprint: record.fingerprint,
      status: new Date(record.expiresAt) <= new Date() ? "expired" : "pending", expiresAt: new Date(record.expiresAt).toISOString(), quote };
  } catch { reject("booking_proposal_unavailable", 503); }
}
function ready(quote) {
  if (quote.eligible !== true) reject(quote.reason === "booking_region_unavailable" ? "booking_region_unavailable" : "booking_location_required", 409);
  if (quote.status !== "ready") reject("booking_preview_not_ready", 409);
}

// Internal only: no route, model tool, initializer or booking writer registers this store.
export async function prepareBookingProposal(ownerValue, body, key, config, { expiresAt, detailsExpireAt = new Date(Date.now() + 86400000) } = {}) {
  const owner = objectId(String(ownerValue)), args = input(body);
  if (typeof key !== "string" || !/^[a-zA-Z0-9._:-]{8,128}$/.test(key)) reject("idempotency_key_required");
  await assertBookingReadAccess(owner, config); await storeReady();
  const requestHash = hash(args), existing = await AssistantBookingProposal.findOne({ owner, key }).maxTimeMS(5000).lean();
  if (existing) {
    if (existing.requestHash !== requestHash) reject("idempotency_conflict", 409);
    const proposal = dto(existing);
    if (await scope(owner, args, config) !== existing.binding) reject("context_changed", 409);
    await assertBookingReadAccess(owner, config);
    return { proposal, duplicate: true };
  }
  const until = expiresAt instanceof Date ? new Date(expiresAt) : null;
  if (!until || !Number.isFinite(until.getTime()) || until <= new Date() || !(detailsExpireAt instanceof Date) ||
    !Number.isFinite(detailsExpireAt.getTime()) || detailsExpireAt <= until) reject("booking_proposal_expiry_required", 503);
  const initial = await scope(owner, args, config), quote = await getAssistantBookingPreview(owner, args, config);
  ready(quote);
  const record = { _id: new mongoose.Types.ObjectId(), owner, key, requestHash, inputJson: encode(args), binding: initial,
    quoteJson: encode(quote), version: 1, expiresAt: until, detailsExpireAt: new Date(detailsExpireAt),
    chatMessageExpiresAt: new Date(Date.now() + config.historyDays * 86400000) };
  record.fingerprint = fingerprint(record, quote);
  const result = await transaction(async (session) => {
    if (await scope(owner, args, config, session) !== initial) reject("context_changed", 409);
    const raced = await AssistantBookingProposal.findOne({ owner, key }).maxTimeMS(5000).session(session).lean();
    if (raced) {
      if (raced.requestHash !== requestHash) reject("idempotency_conflict", 409);
      if (raced.binding !== initial) reject("context_changed", 409);
      return { proposal: dto(raced), duplicate: true };
    }
    if (until <= new Date()) reject("booking_proposal_expired", 409);
    const [saved] = await AssistantBookingProposal.create([record], { session });
    return { proposal: dto(saved), duplicate: false };
  });
  await assertBookingReadAccess(owner, config);
  return result;
}
export async function getBookingProposal(ownerValue, idValue, config) {
  const owner = objectId(String(ownerValue)), id = objectId(idValue);
  await assertBookingReadAccess(owner, config); await storeReady();
  const record = await AssistantBookingProposal.findOne({ _id: id, owner }).maxTimeMS(5000).lean();
  if (!record) reject("booking_proposal_not_found", 404);
  await assertBookingReadAccess(owner, config);
  return { proposal: dto(record) };
}
export async function revalidateBookingProposal(ownerValue, idValue, body, config) {
  fields(body, ["expectedVersion", "fingerprint", "location"]);
  if (body.expectedVersion !== 1 || typeof body.fingerprint !== "string" || !/^[a-f\d]{64}$/.test(body.fingerprint) || body.location?.constructor !== Object) reject("invalid_request");
  const location = JSON.parse(encode(body.location));
  const owner = objectId(String(ownerValue)), { proposal } = await getBookingProposal(owner, idValue, config);
  if (proposal.version !== body.expectedVersion || proposal.fingerprint !== body.fingerprint) reject("booking_proposal_changed", 409);
  if (proposal.status === "expired") reject("booking_proposal_expired", 409);
  const record = await AssistantBookingProposal.findOne({ _id: objectId(idValue), owner }).maxTimeMS(5000).lean();
  if (!record || dto(record).fingerprint !== proposal.fingerprint) reject("booking_proposal_changed", 409);
  const args = input(JSON.parse(record.inputJson));
  if (await scope(owner, args, config) !== record.binding) reject("context_changed", 409);
  const quote = await getAssistantBookingPreview(owner, { ...args, location }, config);
  ready(quote);
  if (await scope(owner, args, config) !== record.binding) reject("context_changed", 409);
  if (hash(bookingPreviewForComparison(quote)) !== hash(bookingPreviewForComparison(proposal.quote))) reject("booking_proposal_changed", 409);
  await assertBookingReadAccess(owner, config);
  if (new Date(record.expiresAt) <= new Date()) reject("booking_proposal_expired", 409);
  return { proposal, ready: true, executed: false };
}

const operation = (owner, record, proposal) => {
  const args = input(JSON.parse(record.inputJson));
  return { owner: String(owner), proposalId: String(record._id), proposalFingerprint: record.fingerprint,
    booking: args.booking, language: args.language, expectedQuote: proposal.quote };
};
export function bookingStateFromRecords(record, retainedReceipt) {
  const proposal = dto(record);
  const saved = retainedReceipt ? validateBookingReceipt(retainedReceipt, operation(record.owner, record, proposal)) : null;
  return { proposal: { ...proposal, status: saved ? "confirmed" : proposal.status }, receipt: saved?.receipt ?? null };
}
async function retainedProposal(owner, id, config, session) {
  await assertBookingReadAccess(owner, config, session);
  const record = await AssistantBookingProposal.findOne({ _id: id, owner }).maxTimeMS(5000).session(session).lean();
  if (!record) reject("booking_proposal_not_found", 404);
  return { record, proposal: dto(record) };
}
async function fence(Model, snapshot, session) {
  if (!snapshot?._id || !Number.isSafeInteger(snapshot.__v) || snapshot.__v < 0 || snapshot.__v >= Number.MAX_SAFE_INTEGER) reject("booking_context_unavailable", 503);
  const filter = { _id: snapshot._id };
  for (const [key, value] of Object.entries(snapshot)) if (key !== "_id") filter[key] = { $eq: value, $exists: true };
  const result = await Model.collection.updateOne(filter, { $inc: { __v: 1 } }, { session });
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) reject("context_changed", 409);
}
export async function getBookingProposalState(ownerValue, idValue, config) {
  requireBookingReads(config);
  const owner = objectId(String(ownerValue)), id = objectId(idValue);
  await storeReady();
  return transaction(async session => {
    const { record, proposal } = await retainedProposal(owner, id, config, session);
    const saved = await recoverBookingReceipt(operation(owner, record, proposal), { session });
    await assertBookingReadAccess(owner, config, session);
    return { proposal: { ...proposal, status: saved ? "confirmed" : proposal.status }, receipt: saved?.receipt ?? null };
  });
}
// Internal coordinator only; the future route must authenticate the principal and obtain explicit confirmation.
export async function confirmBookingProposal(ownerValue, idValue, body, config) {
  requireBookingActions(config);
  fields(body, ["expectedVersion", "fingerprint", "location"]);
  if (body.expectedVersion !== 1 || typeof body.fingerprint !== "string" || !/^[a-f\d]{64}$/.test(body.fingerprint) || body.location?.constructor !== Object) reject("invalid_request");
  const expected = { version: body.expectedVersion, fingerprint: body.fingerprint }, location = bookingLocationInput(body.location);
  const owner = objectId(String(ownerValue)), id = objectId(idValue);
  await storeReady();
  const check = async session => {
    requireBookingActions(config);
    const retained = await retainedProposal(owner, id, config, session);
    if (retained.proposal.version !== expected.version || retained.proposal.fingerprint !== expected.fingerprint) reject("booking_proposal_changed", 409);
    const saved = await recoverBookingReceipt(operation(owner, retained.record, retained.proposal), { session });
    if (saved) { await assertBookingReadAccess(owner, config, session); return { ...retained, saved }; }
    if (retained.proposal.status === "expired") reject("booking_proposal_expired", 409);
    const args = input(JSON.parse(retained.record.inputJson)), current = await context(owner, args, config, session);
    if (current.binding !== retained.record.binding) reject("context_changed", 409);
    return { ...retained, args, current };
  };
  const initial = await transaction(check);
  if (initial.saved) return { ...initial.saved, confirmed: true };
  // Never perform external geocoding inside a write transaction or race a late booking against a read timeout.
  const resolvedLocation = await resolveAssistantBookingArea(owner, location, config);
  return transaction(async session => {
    const state = await check(session);
    if (state.saved) return { ...state.saved, confirmed: true };
    const eligibility = assistantBookingEligibility(resolvedLocation);
    if (!eligibility.eligible) reject(eligibility.reason, 409);
    // Serialize confirmation with unused-detail redaction, including older records without __v.
    const held = await AssistantBookingProposal.collection.updateOne({ _id: id, owner, fingerprint: state.record.fingerprint,
      detailsRemovedAt: { $exists: false } }, { $inc: { __v: 1 } }, { session });
    if (held.matchedCount !== 1 || held.modifiedCount !== 1) reject("booking_proposal_changed", 409);
    await fence(AssistantAccount, state.current.account, session);
    await fence(AssistantChat, state.current.chat, session);
    const pets = new Map([state.current.active, state.current.target].filter(pet => pet?.saved).map(pet => [pet.id, pet]));
    for (const subject of pets.values()) {
      const pet = await PetModel.findOne({ _id: objectId(subject.id.slice(4)), petOwner: owner }).select(`petOwner ${PET_CONTEXT_FIELDS} __v`).maxTimeMS(5000).session(session).lean();
      if (!pet || subjectFingerprint(subjectFromPet(pet)) !== subjectFingerprint(subject)) reject("context_changed", 409);
      await fence(PetModel, pet, session);
    }
    const result = await stageBookingWithReceipt({ ...operation(owner, state.record, state.proposal), resolvedLocation }, { session });
    if (await scope(owner, state.args, config, session) !== state.record.binding) reject("context_changed", 409);
    requireBookingActions(config);
    if (new Date(state.record.expiresAt) <= new Date()) reject("booking_proposal_expired", 409);
    parseAssistantBookingSelection({ userId: String(owner), resolvedLocation, payload: state.args.booking, lang: state.args.language });
    return { ...result, confirmed: true };
  });
}
