import assert from "node:assert/strict";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { UserModel } from "../../../../src/domains/user/user.model.js";
import { CategoryModel } from "../../../../src/domains/category/category.model.js";
import { WarehouseModel } from "../../../../src/domains/warehouse/warehouse.model.js";
import { ProductModel } from "../../../../src/domains/product/product.model.js";
import { AssistantAccount, AssistantChat, AssistantRun, AssistantMessage, AssistantDietaryWarning, AssistantEvent, AssistantBudget } from "../../../../src/domains/assistant/shared/assistant.models.js";
import { periods } from "../../../../src/domains/assistant/shared/assistant.config.js";
import { financialTestTime, financialNextTime } from "./isolatedBudget.js";
import { structuredReply, knownUsage } from "./foundationPolicy.js";

export const pipelineInput = "Milo has a chicken allergy; show cat toys.";
export const pipelineQuote = "Milo has a chicken allergy";
export const pipelineAuditTypes = Object.freeze(["message_accepted", "provider_attempt_reserved", "dietary_warning_recorded", "run_completed"]);

// Validate the entire planned footprint offline; only seven application rows are seeded.
export async function catalogPipelineSeed(manifest, budgetManifest, config) {
  assert.equal(manifest.suite, "catalogPipeline");
  assert.deepEqual(manifest.records.users, budgetManifest.owners);
  assert.equal(budgetManifest.when, financialTestTime);
  manifest.subjectId ??= `chat:${randomUUID()}`;
  assert.match(manifest.subjectId, /^chat:[a-f\d-]{36}$/);
  const ids = Object.fromEntries(Object.entries(manifest.records).map(([name, values]) => [name, values.map((id) => new mongoose.Types.ObjectId(id))]));
  const owner = ids.users[0], chat = ids.assistantchats[0], run = ids.assistantruns[0];
  const now = new Date(financialTestTime), expiresAt = new Date(now.getTime() + 86400000);
  const planned = [], seed = [];
  const add = async (Model, value, initial = false, raw = null) => {
    const document = new Model({ ...value, createdAt: now, updatedAt: now }); await document.validate();
    const row = { collection: Model.collection.name, document: raw ?? document.toObject() };
    planned.push(row); if (initial) seed.push(row);
  };
  for (const _id of ids.users) {
    const raw = { _id, email: `${_id}@${manifest.marker}.invalid`, name: manifest.marker, role: "user", active: true,
      phoneVerified: true, account_status: "confirmed", deletedAt: null, createdAt: now, updatedAt: now };
    // Omission avoids collisions on deployed partial/sparse identity indexes.
    await add(UserModel, raw, true, raw);
  }
  await add(AssistantAccount, { _id: ids.assistantaccounts[0], owner }, true);
  await add(AssistantChat, { _id: chat, owner, activeSubject: manifest.subjectId,
    subjects: [{ id: manifest.subjectId, name: "Milo", species: "cat", expiresAt }] }, true);
  const label = (name) => ({ _id: ids[name][0], slug: `${manifest.marker}-${name}`, name_en: "Synthetic cat toys", name_ar: "لعبة قطط تجريبية" });
  await add(CategoryModel, label("categories"), true);
  await add(WarehouseModel, { _id: ids.warehouses[0], name: "Synthetic pipeline warehouse", code: manifest.marker,
    active: true, isDefault: false, location: { type: "Point", coordinates: [31, 30] }, fulfillment: { status: "OPERATIONAL" } }, true);
  await add(ProductModel, { ...label("products"), category: ids.categories[0], type: "SIMPLE", price: 100, isActive: true,
    desc_en: "Synthetic fixture", desc_ar: "اختبار", warehouseStocks: [{ warehouse: ids.warehouses[0], quantity: 1, revision: 0 }] }, true);
  const context = { warehouseId: String(ids.warehouses[0]), language: "en" };
  await add(AssistantRun, { _id: run, owner, chat, key: manifest.marker, hash: "synthetic-validation-only", purpose: "customer",
    status: "queued", contextVersion: 0, subjectId: manifest.subjectId, input: pipelineInput, userSequence: 1, config, catalogContext: context, deadline: expiresAt });
  for (const [index, role] of ["user", "assistant"].entries()) await add(AssistantMessage, {
    _id: ids.assistantmessages[index], owner, chat, run, sequence: index + 1, role, text: role === "user" ? pipelineInput : "Synthetic validation only",
    subjectId: manifest.subjectId, expiresAt });
  await add(AssistantDietaryWarning, { _id: ids.assistantdietarywarnings[0], owner, subjectId: manifest.subjectId,
    sourceMessage: ids.assistantmessages[0], text: pipelineQuote, source: "chat", state: "active", reportedAt: now });
  for (const [index, type] of pipelineAuditTypes.entries()) await add(AssistantEvent, { _id: ids.assistantevents[index], owner, type, expiresAt,
    run: type === "dietary_warning_recorded" ? null : run, actor: type === "dietary_warning_recorded" ? owner : null,
    detail: type === "dietary_warning_recorded" ? { warningId: String(ids.assistantdietarywarnings[0]), subjectId: manifest.subjectId, version: 1 } : {} });
  const current = periods(config, now), next = periods(config, new Date(financialNextTime));
  const ends = [new Date("9999-01-01"), current.monthReset, current.dayReset, current.dayReset, next.monthReset];
  for (const [_id, index] of budgetManifest.ids.map((id, index) => [id, index])) await add(AssistantBudget, { _id, periodEnd: ends[index],
    ...(_id === "control" ? { billingTimezone: config.timezone, openingExposure: config.openingExposure } : {}) });
  assert.equal(planned.length, 20); assert.equal(seed.length, 7);
  return { ids, seed, planned, context, classification: { version: "synthetic-pipeline-v1", foodCategoryIds: [],
    nonFoodCategoryIds: [String(ids.categories[0])], foodSubcategoryIds: [], nonFoodSubcategoryIds: [] },
    result: { structured: structuredReply({ reply: "", primaryTopic: "products", resolvedSubjectId: manifest.subjectId,
      dietaryWarningAction: "report", dietaryWarningSubjectId: manifest.subjectId, dietaryWarningQuote: pipelineQuote,
      productSearch: { action: "pet", query: "cat toys", minimumPackageWeightGrams: null, maximumPriceMinor: null, sourceQuote: "", options: [] } }),
    usage: knownUsage, serviceTier: "default", finishReason: "completed", toolCalls: [], providerRequestId: "synthetic-no-provider-call", latencyMs: 1 } };
}
