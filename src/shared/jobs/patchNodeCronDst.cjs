const assert = require("node:assert/strict");
const { readFileSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const root = dirname(dirname(require.resolve("node-cron")));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.equal(version, "4.6.0", "Review the Cairo DST patch before changing node-cron");

// node-cron 4.6.0's local setter moves the heartbeat backward in a repeated hour.
// Keep this install-time correction until upstream floors timestamps without local setters.
for (const name of ["_shared.cjs", "_shared.js"]) {
  const path = join(root, "dist", name);
  const source = readFileSync(path, "utf8");
  const before = "date.setMilliseconds(0);";
  const after = "date.setUTCMilliseconds(0);";
  if (source.includes(after) && !source.includes(before)) continue;
  assert.equal(source.split(before).length, 2, `Unexpected node-cron heartbeat in ${name}`);
  writeFileSync(path, source.replace(before, after));
}
