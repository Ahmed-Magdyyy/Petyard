import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

test("cron next runs and heartbeats survive Cairo summer/winter transitions without skipping fixed intervals", () => {
  const output = execFileSync(process.execPath, ["test/fixtures/cronDstProbe.cjs"], {
    encoding: "utf8", windowsHide: true, timeout: 15_000,
    env: { ...process.env, TZ: "Africa/Cairo" },
  });
  const result = JSON.parse(output);
  assert.equal(result.result, "PASS");
  assert.equal(result.assertions, 139);
  assert.equal(result.businessJobsRun, 0);
});

test("both scheduler module formats retain the idempotent install-time DST correction", () => {
  const require = createRequire(import.meta.url);
  const root = dirname(dirname(require.resolve("node-cron")));
  for (const name of ["_shared.cjs", "_shared.js"]) {
    const source = readFileSync(join(root, "dist", name), "utf8");
    assert(source.includes("date.setUTCMilliseconds(0);"));
    assert(!source.includes("date.setMilliseconds(0);"));
  }
  execFileSync(process.execPath, ["src/shared/jobs/patchNodeCronDst.cjs"], { windowsHide: true });
});

test("actual job starters keep daily schedules and use UTC only for fixed intervals", () => {
  const script = `
    import { readFileSync } from 'node:fs';
    import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
    const registrations = [];
    const context = createContext({
      process: { env: { APP_DOWNLOAD_SYNC_ON_STARTUP: 'false' } },
      console: { log() {}, error() {} },
    });
    const starters = [
      ['abandonedCarts.job.js', 'startAbandonedCartsJob'],
      ['notification.jobs.js', 'startNotificationJobs'],
      ['abandonedPayments.job.js', 'startAbandonedPaymentsJob'],
      ['appDownloads.job.js', 'startAppDownloadsJob'],
    ];
    for (const [file, name] of starters) {
      const source = readFileSync('src/shared/jobs/' + file, 'utf8');
      const module = new SourceTextModule(source, { context });
      await module.link(async specifier => {
        const imports = [...source.matchAll(/import\\s+([^;]+?)\\s+from\\s+["']([^"']+)["'];/g)]
          .filter(match => match[2] === specifier);
        const names = imports.flatMap(match => match[1].startsWith('{')
          ? match[1].slice(1, -1).split(',').map(name => name.trim()) : ['default']);
        return new SyntheticModule(names, function () {
          for (const key of names) this.setExport(key, specifier === 'node-cron'
            ? { schedule: (pattern, callback, options) => registrations.push([pattern, options?.timezone ?? 'Africa/Cairo']) }
            : () => Promise.resolve({}));
        }, { context });
      });
      await module.evaluate();
      module.namespace[name]();
    }
    console.log(JSON.stringify(registrations));
  `;
  const output = execFileSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", script], {
    encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.deepEqual(JSON.parse(output), [
    ["0 0,12 * * *", "Africa/Cairo"],
    ["0 * * * *", "UTC"],
    ["0 7 * * *", "Africa/Cairo"],
    ["0 22 * * *", "Africa/Cairo"],
    ["*/5 * * * *", "UTC"],
    ["* * * * *", "UTC"],
    ["30 8 * * *", "Africa/Cairo"],
  ]);
});
