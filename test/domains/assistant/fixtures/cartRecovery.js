import assert from "node:assert/strict";
import { open } from "node:fs/promises";

export const cartRecoveryOptIn = "isolated-cart-recovery-only";

// Use only a private native session. The first server commit succeeds before its reply is replaced locally.
export function loseFirstCommitReply(session, { MongoNetworkError }) {
  const commit = session.commitTransaction.bind(session);
  const observed = { commitCalls: 0, injectedReplies: 0 };
  session.commitTransaction = async (...args) => {
    observed.commitCalls++;
    const result = await commit(...args);
    if (observed.injectedReplies === 0) {
      observed.injectedReplies++;
      const error = new MongoNetworkError("Synthetic lost cart commit reply");
      error.addErrorLabel("UnknownTransactionCommitResult");
      throw error;
    }
    return result;
  };
  return observed;
}

export function requireCartRecoveryOptIn(value) {
  assert.equal(value, cartRecoveryOptIn, "Fresh approval and explicit recovery-only opt-in required");
}

export function cartRecoverySetupJournalName(value) {
  assert.ok(typeof value === "string" && /^cart-approved-setup-[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\.json$/.test(value),
    "Supply only an existing approved cart setup journal basename");
  return value;
}

export async function readCartRecoverySetupJournal(directory, name) {
  const handle = await open(new URL(cartRecoverySetupJournalName(name), directory), "r");
  try {
    const metadata = await handle.stat();
    assert.ok(metadata.isFile() && metadata.size <= 2_000_000, "Setup journal exceeds its bound or is not a file");
    const raw = await handle.readFile("utf8");
    assert.ok(Buffer.byteLength(raw) <= 2_000_000, "Setup journal exceeds its bound");
    return JSON.parse(raw);
  } finally { await handle.close(); }
}
