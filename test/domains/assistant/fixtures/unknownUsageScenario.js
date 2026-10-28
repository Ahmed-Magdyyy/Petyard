import assert from "node:assert/strict";
import { AssistantRun, AssistantAccount, AssistantMessage, AssistantAdminMessage, AssistantChat, AssistantAdminChat } from "../../../../src/domains/assistant/shared/assistant.models.js";
import { transaction, reserveCost } from "../../../../src/domains/assistant/shared/assistant.store.js";
import { reservationMicroUsd } from "../../../../src/domains/assistant/shared/assistant.config.js";
import { financialTestTime } from "./isolatedBudget.js";

export async function verifyUnknownUsageScenario({ customerMode, config, prepared, finishWork, result, ids, ledger, budgetManifest }) {
  const uncertain = await finishWork(prepared, { ...result, usage: null }, null, { currentConfig: config });
  assert.equal(uncertain.status, "uncertain"); assert.equal(uncertain.publicCode, "request_needs_review");
  const assertUnsettled = async () => {
    const run = await AssistantRun.findById(ids.assistantruns[0]).lean();
    assert.equal(run.accounting, "reserved"); assert.equal(run.status, "uncertain"); assert.equal(run.publicCode, "request_needs_review");
    assert.equal(run.phase, customerMode ? "resolve" : "plan"); assert.equal(run.responseMessage, null);
    assert.equal(run.reservation.amount, reservationMicroUsd(config)); assert.equal(run.chargedMicroUsd ?? null, null);
    assert.equal(run.usage, null); assert.equal(run.providerRequestId, result.providerRequestId);
    assert.equal(run.attempt, prepared.run.attempt); assert.equal(run.attempts.length, 1);
    assert.equal(run.attempts[0].id, prepared.run.attempt); assert.equal(run.attempts[0].accounting, "reserved");
    assert.equal(run.attempts[0].chargedMicroUsd ?? null, null); assert.equal(run.attempts[0].settledAt ?? null, null);
    assert.equal(run.adminPlan, undefined);
    const account = await AssistantAccount.findById(ids.assistantaccounts[0]).lean();
    assert.equal(String(account.activeRun), String(run._id)); assert.equal(account.reviewEvidenceVersion, 0);
    const chat = customerMode ? await AssistantChat.findById(ids.assistantchats[0]).lean()
      : await AssistantAdminChat.findById(ids.assistantadminchats[0]).lean();
    assert.equal(chat.nextSequence, 0);
    assert.equal(await AssistantMessage.countDocuments({ run: run._id, owner: ids.users[0] }), 0);
    assert.equal(await AssistantAdminMessage.countDocuments({ run: run._id, owner: ids.users[0] }), 0);
    for (const id of budgetManifest.ids) {
      const row = await ledger.findOne({ _id: id, assistantTestRun: budgetManifest.marker });
      assert.equal(row.spent, 0); assert.equal(row.frozen, false);
      assert.equal(row.reserved, run.reservation.budgetIds.includes(id) ? run.reservation.amount : 0);
    }
    return JSON.stringify(run);
  };
  const retained = await assertUnsettled();
  let adapterConstructions = 0;
  const process = customerMode ? (await import("../../../../src/domains/assistant/customer/assistant.worker.service.js")).processAssistantRun
    : (await import("../../../../src/domains/assistant/admin/assistant.admin-worker.js")).processBusinessPlan;
  const options = { getConfig: () => config, adapterFactory() {
    adapterConstructions++; throw new Error("Uncertain work must never construct a provider adapter");
  } };
  const retries = await Promise.all([1, 2, 3].map(() => process(ids.assistantruns[0], options)));
  assert.ok(retries.every((retry) => retry.skipped === true)); assert.equal(adapterConstructions, 0);
  assert.equal(await assertUnsettled(), retained);
  // The held reservation must still consume the shared allowance, even for a different owner.
  await assert.rejects(transaction((session) => reserveCost(ids.users[1], config, session, new Date(financialTestTime))), { code: "monthly_budget_limit" });
  assert.equal(await assertUnsettled(), retained);
}
