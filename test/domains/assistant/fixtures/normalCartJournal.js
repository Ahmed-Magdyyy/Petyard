import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { open, rename } from "node:fs/promises";

function journalPath(directory, name) {
  assert.ok(typeof name === "string" && /^normal-cart-setup-[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\.json$/.test(name));
  const url = new URL(name, directory); assert.equal(url.protocol, "file:"); return url;
}
export async function writeNormalCartJournal(directory, name, value) {
  const path = journalPath(directory, name), temporary = new URL(`${name}.tmp-${randomUUID()}`, directory);
  const raw = `${JSON.stringify(value, null, 2)}\n`; assert.ok(Buffer.byteLength(raw) <= 2_000_000);
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  let directorySynced = false;
  try {
    const parent = await open(new URL("./", path), "r");
    try { await parent.sync(); directorySynced = true; } finally { await parent.close(); }
  } catch (error) { if (!["EPERM", "EISDIR", "EINVAL", "ENOTSUP", "EBADF"].includes(error.code)) throw error; }
  // Windows directory fsync may be unavailable; file sync and atomic replacement do not promise absolute power-loss durability.
  return { fileSynced: true, atomicReplacement: true, directorySynced };
}
export async function readNormalCartJournal(directory, name) {
  const handle = await open(journalPath(directory, name), "r");
  try {
    const info = await handle.stat(); assert.ok(info.isFile() && info.size <= 2_000_000);
    const raw = await handle.readFile("utf8"); assert.ok(Buffer.byteLength(raw) <= 2_000_000); return JSON.parse(raw);
  } finally { await handle.close(); }
}
