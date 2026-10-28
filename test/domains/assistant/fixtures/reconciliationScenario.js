import assert from "node:assert/strict";
import { AssistantRun, AssistantAccount, AssistantChat, AssistantMessage, AssistantAdminMessage, AssistantEvent } from "../../../../src/domains/assistant/shared/assistant.models.js";
import { reconcileRun } from "../../../../src/domains/assistant/customer/assistant.service.js";
import { costMicroUsd, reservationMicroUsd } from "../../../../src/domains/assistant/shared/assistant.config.js";
import { knownUsage } from "./foundationPolicy.js";

// Exercise both serial orderings as well as a real native-transaction race, without resetting any ledger.
export async function verifyReconciliationScenario(t, { ordering, config, prepared, finish, ids, ledger, budgetManifest }) {
  const close = () => reconcileRun(ids.users[1], String(ids.assistantruns[0]), {
    resolution: "charge_reserved", reason: "Synthetic uncertain-run reconciliation test",
  }, config);
  if (ordering === "manual_first") {
    const interruption = new Error("Synthetic interruption before manual reconciliation commit");
    const failure = t.mock.method(AssistantEvent, "create", async () => { throw interruption; });
    try { await assert.rejects(close(), (error) => error === interruption); } finally { failure.mock.restore(); }
    const unchanged = await AssistantRun.findById(ids.assistantruns[0]).lean();
    assert.equal(unchanged.status, "uncertain"); assert.equal(unchanged.accounting, "reserved");
    assert.equal(unchanged.attempts[0].accounting, "reserved"); assert.equal(unchanged.responseMessage, null);
    assert.equal(String((await AssistantAccount.findById(ids.assistantaccounts[0]).lean()).activeRun), String(ids.assistantruns[0]));
    for (const id of prepared.run.reservation.budgetIds) {
      const row = await ledger.findOne({ _id: id, assistantTestRun: budgetManifest.marker });
      assert.equal(row.reserved, reservationMicroUsd(config)); assert.equal(row.spent, 0);
    }
    assert.equal((await close()).duplicate, false); assert.equal(await finish(), null);
  } else if (ordering === "worker_first") {
    assert.equal((await finish()).status, "completed");
    await assert.rejects(close(), { code: "run_not_reconcilable" });
  } else {
    assert.equal(ordering, "concurrent");
    const outcomes = await Promise.allSettled([close(), finish(), close(), finish()]);
    const manual = [outcomes[0], outcomes[2]]; const workers = [outcomes[1], outcomes[3]];
    const winner = await AssistantRun.findById(ids.assistantruns[0]).lean();
    if (winner.accounting === "charged_reservation") {
      assert.ok(manual.every((entry) => entry.status === "fulfilled"));
      assert.equal(manual.filter((entry) => entry.value.duplicate === false).length, 1);
      assert.equal(manual.filter((entry) => entry.value.duplicate === true).length, 1);
      assert.ok(workers.every((entry) => entry.status === "fulfilled" && entry.value === null));
    } else {
      assert.equal(winner.accounting, "settled");
      assert.ok(manual.every((entry) => entry.status === "rejected" && entry.reason.code === "run_not_reconcilable"));
      assert.ok(workers.every((entry) => entry.status === "fulfilled"));
      assert.equal(workers.filter((entry) => entry.value?.status === "completed").length, 1);
      assert.equal(workers.filter((entry) => entry.value === null).length, 1);
    }
    t.diagnostic(`concurrent_reconciliation_winner=${winner.accounting}`);
  }
  const committed = await AssistantRun.findById(ids.assistantruns[0]).lean();
  const manualWon = committed.accounting === "charged_reservation";
  if (ordering !== "concurrent") assert.equal(manualWon, ordering === "manual_first");
  const charge = manualWon ? reservationMicroUsd(config) : costMicroUsd(knownUsage, config);
  assert.notEqual(reservationMicroUsd(config), costMicroUsd(knownUsage, config));
  assert.equal(committed.accounting, manualWon ? "charged_reservation" : "settled");
  assert.equal(committed.status, manualWon ? "failed" : "completed");
  assert.equal(committed.publicCode, manualWon ? "request_closed_after_review" : null);
  assert.equal(committed.chargedMicroUsd, charge); assert.equal(committed.attempts.length, 1);
  assert.equal(committed.attempts[0].accounting, committed.accounting); assert.equal(committed.attempts[0].chargedMicroUsd, charge);
  assert.ok(committed.attempts[0].settledAt);
  assert.equal(committed.responseMessage === null ? null : String(committed.responseMessage), manualWon ? null : String(ids.assistantmessages[0]));
  const snapshot = JSON.stringify(committed);
  assert.equal(await finish(), null);
  if (manualWon) assert.equal((await close()).duplicate, true); else await assert.rejects(close(), { code: "run_not_reconcilable" });
  assert.equal(JSON.stringify(await AssistantRun.findById(ids.assistantruns[0]).lean()), snapshot);
  const replies = await AssistantMessage.find({ run: ids.assistantruns[0], owner: ids.users[0] }).lean();
  assert.equal(replies.length, manualWon ? 0 : 1);
  if (!manualWon) { assert.equal(String(replies[0]._id), String(ids.assistantmessages[0])); assert.equal(replies[0].sequence, 1); }
  const chat = await AssistantChat.findById(ids.assistantchats[0]).lean();
  assert.equal(chat.nextSequence, manualWon ? 0 : 1);
  const account = await AssistantAccount.findById(ids.assistantaccounts[0]).lean();
  assert.equal(account.activeRun, null); assert.equal(account.reviewEvidenceVersion, manualWon ? 0 : 1);
  for (const id of budgetManifest.ids) {
    const row = await ledger.findOne({ _id: id, assistantTestRun: budgetManifest.marker });
    assert.equal(row.reserved, 0); assert.equal(row.spent, prepared.run.reservation.budgetIds.includes(id) ? charge : 0);
    assert.equal(row.frozen, false);
  }
  assert.equal(await AssistantAdminMessage.countDocuments({ _id: { $in: ids.assistantadminmessages } }), 0);
}
