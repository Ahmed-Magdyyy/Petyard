import mongoose from "mongoose";
import { topicKeys } from "../reporting/assistant.topics.js";
import { runPurposes } from "./assistant.purpose.js";
import { REFERENCE_FLOW_VERSION, isFocusedReferenceRun, validAttemptSequence } from "./assistant.attempts.js";
import { adminPlanValues, ADMIN_REPORT_LIMIT } from "../admin/assistant.admin-plan.js";
const { Schema } = mongoose;
const id = Schema.Types.ObjectId;
const make = (name, shape, indexes = []) => {
  const schema = new Schema(shape, { timestamps: true, strict: "throw", minimize: false,
    autoCreate: false, autoIndex: false, bufferCommands: false });
  for (const [keys, options] of indexes) schema.index(keys, options);
  return mongoose.models[name] ?? mongoose.model(name, schema);
};
const ttl = [{ expiresAt: 1 }, { expireAfterSeconds: 0 }];
const owner = { type: id, required: true };
const messageShape = {
  owner, chat: { type: id, required: true }, run: { type: id, required: true },
  sequence: { type: Number, required: true }, role: { type: String, enum: ["user", "assistant"], required: true },
  text: { type: String, required: true }, expiresAt: { type: Date, required: true },
};
const messageIndexes = [[{ chat: 1, sequence: 1 }, { unique: true }], [{ owner: 1, sequence: -1 }, {}], [{ run: 1, role: 1 }, { unique: true }], ttl];
const adminArguments = new Schema({ month: { type: String, required: true }, compareTo: String,
  metric: { type: String, enum: ["units", "item_value"] }, warehouse: String, limit: { type: Number, min: 1, max: 50 } }, { _id: false, strict: "throw" });
const adminInvocation = new Schema({ tool: { type: String, enum: adminPlanValues.tools, required: true },
  arguments: { type: adminArguments, required: true } }, { _id: false, strict: "throw" });
const adminCardHeader = { id: { type: String, required: true }, tool: { type: String, enum: adminPlanValues.tools, required: true },
  status: { type: String, enum: ["success", "unavailable"], required: true }, generatedAt: { type: Date, required: true }, code: { type: String, default: null } };
const boundedReports = (items) => ({ type: [items], default: undefined,
  validate: { validator: (value) => value == null || value.length <= ADMIN_REPORT_LIMIT, message: "Admin report limit exceeded" } });

export const AssistantChat = make("AssistantChat", {
  owner, activeSubject: { type: String, default: null }, contextVersion: { type: Number, default: 0 },
  nextSequence: { type: Number, default: 0 }, contextAfterSequence: { type: Number, default: 0 },
  awaitingSubject: { type: Boolean, default: false },
  subjects: [{ _id: false, id: String, name: { type: String, default: null }, species: { type: String, default: null }, expiresAt: Date,
    nameSourceMessage: id, nameSourceQuote: String, speciesSourceMessage: id, speciesSourceQuote: String }],
}, [[{ owner: 1 }, { unique: true }]]);
export const AssistantMessage = make("AssistantMessage", {
  ...messageShape, subjectId: { type: String, default: null },
  catalogJson: { type: String, maxlength: 16384, default: undefined },
  checkoutJson: { type: String, maxlength: 8192, default: undefined },
  bookingJson: { type: String, maxlength: 65536, default: undefined },
  bookingSelectionJson: { type: String, maxlength: 4096, default: undefined },
  bookingReview: { type: new Schema({ proposalId: { type: id, required: true }, language: { type: String, enum: ["en", "ar"], required: true } },
    { _id: false, strict: "throw" }), default: undefined, immutable: true },
}, messageIndexes);
// Separate collections keep business messages out of owner-only customer history queries.
export const AssistantAdminChat = make("AssistantAdminChat", {
  owner, contextVersion: { type: Number, default: 0 }, nextSequence: { type: Number, default: 0 },
  contextAfterSequence: { type: Number, default: 0 },
}, [[{ owner: 1 }, { unique: true }]]);
export const AssistantAdminMessage = make("AssistantAdminMessage", { ...messageShape,
  language: { type: String, enum: adminPlanValues.languages },
  outcome: { type: String, enum: [...adminPlanValues.outcomes, "execution_error"] },
  reportHeaders: boundedReports(new Schema(adminCardHeader, { _id: false, strict: "throw" })),
  reportIntent: boundedReports(adminInvocation),
}, messageIndexes);
export const AssistantRun = make("AssistantRun", {
  owner, chat: { type: id, required: true }, key: { type: String, required: true }, hash: { type: String, required: true },
  // Do not apply an immutable default while hydrating legacy records without this field.
  purpose: { type: String, enum: Object.values(runPurposes), immutable: true,
    required() { return this.isNew; }, default() { return this.isNew ? runPurposes.customer : undefined; } },
  status: { type: String, enum: ["queued", "dispatching", "completed", "failed", "uncertain"], required: true },
  topic: { type: new Schema({ key: { type: String, enum: topicKeys, required: true },
    taxonomyVersion: { type: String, required: true } }, { _id: false }), default: null },
  contextVersion: { type: Number, required: true }, subjectId: { type: String, default: null }, subjectFingerprint: { type: String, default: null },
  subjectExplicit: { type: Boolean, default: false }, phase: { type: String, enum: ["resolve", "normalize", "answer", "plan", "reports"], default: "resolve",
    validate: function(value) { return value !== "normalize" || isFocusedReferenceRun(this); } },
  referenceFlowVersion: { type: String, enum: [REFERENCE_FLOW_VERSION], immutable: true, default: undefined,
    validate: function(value) { return value == null || isFocusedReferenceRun(this); } },
  adminWarehouseIds: { type: [String], default: undefined },
  bundleWindowEnd: { type: Date, default: undefined },
  bundleSourceJson: { type: String, maxlength: 131072, default: undefined },
  bundleDraftIds: { type: [id], default: undefined, validate: value => value == null || value.length <= 3 },
  bookingContext: { type: new Schema({ location: { type: Schema.Types.Mixed, required: false, default: null } },
    { _id: false, strict: "throw" }), default: undefined, immutable: true },
  catalogContext: { type: new Schema({ warehouseId: { type: String, default: null, match: /^[a-f\d]{24}$/i },
    language: { type: String, enum: ["ar", "en"], required: true } }, { _id: false, strict: "throw" }), default: undefined, immutable: true },
  adminPlan: { type: new Schema({ version: { type: String, required: true },
    outcome: { type: String, enum: adminPlanValues.outcomes, required: true },
    language: { type: String, enum: adminPlanValues.languages, required: true },
    clarification: { type: String, enum: adminPlanValues.clarifications, required: true },
    reports: boundedReports(adminInvocation),
  }, { _id: false, strict: "throw" }), default: undefined },
  adminReports: boundedReports(new Schema({ ...adminCardHeader, arguments: { type: adminArguments, required: true },
    dataJson: { type: String, maxlength: 262144, default: null } }, { _id: false, strict: "throw" })),
  reportLease: String, reportLeaseUntil: Date,
  generation: { type: Number, default: 0 },
  input: { type: String, required: true }, userSequence: { type: Number, required: true },
  queryEmbeddingFence: { type: Number, default: 0 },
  referencePreparationRequested: { type: Boolean, default: undefined },
  referenceContextExpiresAt: { type: Date, default: undefined },
  referenceQuery: { type: new Schema({ status: { type: String, enum: ["ready", "unclear"], required: true },
    query: { type: String, default: null, maxlength: 2000 }, sourceHash: { type: String, required: true, match: /^[a-f\d]{64}$/ },
    subjectId: { type: String, default: null }, subjectFingerprint: { type: String, default: null },
    contextVersion: { type: Number, required: true }, generation: { type: Number, required: true },
    configSignature: { type: String, default: undefined },
    contextExpiresAt: { type: Date, required: true },
  }, { _id: false, strict: "throw" }), default: undefined },
  referenceSources: { type: [new Schema({ sourceId: { type: id, required: true },
    manifestHash: { type: String, required: true, match: /^[a-f\d]{64}$/ } }, { _id: false, strict: "throw" })],
    default: undefined, validate: value => value == null || value.length <= 3 },
  config: { type: Schema.Types.Mixed, required: true }, deadline: Date, dispatchDeadline: Date,
  attempt: { type: String, default: null }, reservation: { type: Schema.Types.Mixed, default: null },
  accounting: { type: String, enum: ["none", "reserved", "settled", "charged_reservation"], default: "none" },
  usage: { type: Schema.Types.Mixed, default: null }, providerRequestId: String, latencyMs: Number,
  chargedMicroUsd: Number,
  attempts: { type: [{ _id: false, id: String, number: Number, phase: String, subjectId: String, contextVersion: Number, subjectFingerprint: String,
    reservation: Schema.Types.Mixed, accounting: String, usage: Schema.Types.Mixed, chargedMicroUsd: Number,
    providerRequestId: String, latencyMs: Number, internalCode: String, dispatchedAt: Date, settledAt: Date }],
    default: [], validate: { validator: function(value) { return validAttemptSequence(this, value); }, message: "Assistant attempt limit exceeded" } },
  internalCode: String, publicCode: String, retryAt: Date, responseMessage: { type: id, default: null },
  expiresAt: Date,
}, [[{ owner: 1, key: 1 }, { unique: true }], [{ status: 1, createdAt: 1 }, {}], [{ status: 1, dispatchDeadline: 1 }, {}],
  [{ createdAt: 1 }, {}], [{ "attempts.dispatchedAt": 1 }, {}], ttl]);
export const AssistantAccount = make("AssistantAccount", {
  owner, activeRun: { type: id, default: null }, blocked: { type: Boolean, default: false },
  restrictionVersion: { type: Number, default: 0 }, reason: String,
  reviewEvidenceVersion: { type: Number, default: 0 }, reviewDismissedBefore: Date,
  rateStart: Date, rateCount: { type: Number, default: 0 },
  cartRateStart: Date, cartRateCount: { type: Number, default: 0 },
  bookingReadRateStart: Date, bookingReadRateCount: { type: Number, default: 0 },
  bookingActionRateStart: Date, bookingActionRateCount: { type: Number, default: 0 },
  day: String, dayMessages: { type: Number, default: 0 },
}, [[{ owner: 1 }, { unique: true }]]);
export const AssistantMemory = make("AssistantMemory", {
  owner, subjectId: { type: String, required: true }, key: { type: String, required: true },
  kind: { type: String, enum: ["preference", "discussion_summary"], required: true }, value: String,
  sourceMessage: { type: id, default: null }, sourceQuote: String,
  state: { type: String, enum: ["active", "forgotten"], required: true },
  version: { type: Number, default: 1 }, validUntil: Date, expiresAt: Date,
}, [[{ owner: 1, subjectId: 1, key: 1 }, { unique: true }], [{ owner: 1, state: 1, updatedAt: -1 }, {}], ttl]);
// No TTL: dietary warnings remain until explicitly corrected/removed, independent of message retention.
export const AssistantDietaryWarning = make("AssistantDietaryWarning", {
  owner: { ...owner, immutable: true }, subjectId: { type: String, required: true, immutable: true, match: /^(pet:[a-f\d]{24}|chat:[a-f\d-]{36})$/ },
  sourceMessage: { type: id, required: true, immutable: true },
  text: { type: String, maxlength: 500, required() { return this.state === "active"; } },
  source: { type: String, enum: ["chat", "user_edit"], required: true },
  state: { type: String, enum: ["active", "removed"], default: "active", required: true },
  version: { type: Number, default: 1, min: 1, validate: Number.isSafeInteger },
  reportedAt: { type: Date, default: Date.now, immutable: true, required: true },
}, [[{ owner: 1, subjectId: 1, sourceMessage: 1 }, { unique: true }], [{ owner: 1, subjectId: 1, state: 1, _id: -1 }, {}]]);
// Budget records and unsettled run records have no TTL: retention cannot erase a financial liability or an idempotency key.
export const AssistantBudget = make("AssistantBudget", {
  _id: String, periodEnd: { type: Date, required: true }, spent: { type: Number, default: 0 },
  reserved: { type: Number, default: 0 }, frozen: { type: Boolean, default: false }, billingTimezone: String, openingExposure: Schema.Types.Mixed,
});
export const AssistantEvent = make("AssistantEvent", {
  owner, run: { type: id, default: null }, actor: { type: id, default: null },
  type: { type: String, required: true, enum: ["message_accepted", "memory_saved", "memory_forgotten", "manual_ai_block", "manual_ai_restore",
    "uncertain_run_charged_reservation", "run_failed_before_dispatch", "provider_attempt_reserved", "provider_charge_uncertain",
    "run_completed", "run_failed_after_dispatch", "interrupted_attempt_needs_review", "bundle_generation_queued", "admin_plan_ready", "subject_resolved", "admin_chat_reviewed", "admin_observations_reviewed", "admin_review_candidates_viewed", "admin_review_dismissed",
    "dietary_warning_recorded", "dietary_warning_edited", "dietary_warning_removed"] },
  detail: { type: Schema.Types.Mixed }, expiresAt: { type: Date, required: true },
}, [[{ owner: 1, createdAt: -1 }], [{ owner: 1, type: 1, _id: -1 }, {}], [{ type: 1, createdAt: -1, owner: 1 }, {}], ttl]);

export const assistantModels = Object.freeze({ AssistantChat, AssistantMessage, AssistantRun, AssistantAccount, AssistantMemory, AssistantDietaryWarning, AssistantBudget, AssistantEvent });
