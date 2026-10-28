import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, readdir, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { writeNormalCartJournal, readNormalCartJournal } from "./fixtures/normalCartJournal.js";
const prefix = join(tmpdir(), "petyard-normal-journal-test-");

test("normal setup journal atomically replaces synced snapshots and retains the last valid state", async (t) => {
  const folder = await mkdtemp(prefix), directory = pathToFileURL(`${folder}/`);
  t.after(async () => { for (const name of await readdir(folder)) await unlink(join(folder, name)); await rmdir(folder); });
  const name = `normal-cart-setup-${randomUUID()}.json`, snapshot = { status: "ready", pending: null, completed: [] };
  const result = await writeNormalCartJournal(directory, name, snapshot);
  assert.equal(result.fileSynced, true); assert.equal(result.atomicReplacement, true); assert.equal(typeof result.directorySynced, "boolean");
  assert.deepEqual(await readNormalCartJournal(directory, name), snapshot);
  const next = { ...snapshot, pending: "createIndex:carts:assistant_signed_in_user_unique" };
  await writeNormalCartJournal(directory, name, next); assert.deepEqual(await readNormalCartJournal(directory, name), next);
  await assert.rejects(writeNormalCartJournal(directory, name, { raw: "x".repeat(2_000_001) }));
  assert.deepEqual(JSON.parse(await readFile(join(folder, name), "utf8")), next);
  assert.deepEqual(await readdir(folder), [name]);
});
test("normal journal refuses traversal, wrong names, corrupt and oversized files before use", async (t) => {
  const folder = await mkdtemp(prefix), directory = pathToFileURL(`${folder}/`);
  t.after(async () => { for (const name of await readdir(folder)) await unlink(join(folder, name)); await rmdir(folder); });
  for (const name of ["../.env", "normal-cart-setup-abc.json", "cart-coordinator-setup-00000000-0000-0000-0000-000000000000.json"]) {
    await assert.rejects(readNormalCartJournal(directory, name)); await assert.rejects(writeNormalCartJournal(directory, name, {}));
  }
  const name = `normal-cart-setup-${randomUUID()}.json`;
  await writeFile(join(folder, name), "{"); await assert.rejects(readNormalCartJournal(directory, name));
  await writeFile(join(folder, name), "x".repeat(2_000_001)); await assert.rejects(readNormalCartJournal(directory, name));
});
