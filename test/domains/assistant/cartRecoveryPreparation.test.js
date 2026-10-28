import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cartRecoveryOptIn, requireCartRecoveryOptIn, loseFirstCommitReply, cartRecoverySetupJournalName, readCartRecoverySetupJournal } from "./fixtures/cartRecovery.js";

test("native recovery requires its separate exact opt-in before connection", () => {
  assert.doesNotThrow(() => requireCartRecoveryOptIn(cartRecoveryOptIn));
  for (const value of [undefined, "", true, "isolated-cart-stores-only", "create-two-empty-isolated-cart-test-stores"])
    assert.throws(() => requireCartRecoveryOptIn(value));
});

test("setup journal reference cannot escape the saved credential-free setup directory", () => {
  const name = "cart-approved-setup-12345678-1234-1234-1234-123456789012.json";
  assert.equal(cartRecoverySetupJournalName(name), name);
  for (const value of [undefined, ".env", `../${name}`, `D:/${name}`, `https://example.invalid/${name}`, name + "/", "other.json"])
    assert.throws(() => cartRecoverySetupJournalName(value));
});

test("journal load checks file size before reading and rejects corrupt or oversized local metadata", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "petyard-cart-recovery-"));
  const name = "cart-approved-setup-12345678-1234-1234-1234-123456789012.json", path = join(directory, name);
  t.after(async () => { await unlink(path); await rmdir(directory); });
  const base = pathToFileURL(directory + "/");
  await writeFile(path, '{"status":"synthetic"}'); assert.deepEqual(await readCartRecoverySetupJournal(base, name), { status: "synthetic" });
  await writeFile(path, "{"); await assert.rejects(readCartRecoverySetupJournal(base, name), SyntaxError);
  await writeFile(path, Buffer.alloc(2_000_001)); await assert.rejects(readCartRecoverySetupJournal(base, name), /exceeds its bound/);
});

test("injected lost commit reply uses the installed driver's retry loop and does not rerun the transaction callback", async (t) => {
  const client = new mongoose.mongo.MongoClient("mongodb://127.0.0.1:1"), session = client.startSession();
  t.mock.method(client, "connect", () => assert.fail("Offline preparation must not connect"));
  let commits = 0, callbacks = 0;
  t.mock.method(session, "commitTransaction", async () => { commits++; });
  t.mock.method(session, "abortTransaction", async () => {});
  const observed = loseFirstCommitReply(session, mongoose.mongo);
  try {
    const result = await session.withTransaction(async () => { callbacks++; return "retained-result"; });
    assert.equal(result, "retained-result"); assert.equal(commits, 2); assert.equal(callbacks, 1);
    assert.deepEqual(observed, { commitCalls: 2, injectedReplies: 1 });
  } finally { await session.endSession(); await client.close(); }
});

test("commit wrapper never reports a synthetic lost reply when the underlying commit failed", async () => {
  const original = new Error("Synthetic underlying commit failure");
  const session = { async commitTransaction() { throw original; } }, observed = loseFirstCommitReply(session, mongoose.mongo);
  await assert.rejects(session.commitTransaction(), (error) => error === original);
  assert.deepEqual(observed, { commitCalls: 1, injectedReplies: 0 });
});

test("commit fault preserves receiver, arguments and successful retry value on the private session", async () => {
  const token = {}, args = { timeoutMS: 20 };
  const session = { async commitTransaction(value) { assert.equal(this, session); assert.equal(value, args); return token; } };
  const observed = loseFirstCommitReply(session, mongoose.mongo);
  await assert.rejects(session.commitTransaction(args), (error) => error instanceof mongoose.mongo.MongoNetworkError && error.hasErrorLabel("UnknownTransactionCommitResult"));
  assert.equal(await session.commitTransaction(args), token); assert.deepEqual(observed, { commitCalls: 2, injectedReplies: 1 });
});
