import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Run the actual entry point with linked service stubs: no database, socket or job is started.
async function inspectStartup(source, environment, filename) {
  const { SourceTextModule, SyntheticModule } = await import("node:vm");
  const calls = [], listeners = [];
  const app = { set() {}, use() {}, get() {}, all() {},
    listen(...args) { listeners.push(args.slice(0, -1)); args.at(-1)(); return { close() {} }; } };
  const middleware = () => {};
  const express = Object.assign(() => app, { json: () => middleware, static: () => middleware, urlencoded: () => middleware });
  const context = (await import("node:vm")).createContext({
    process: { env: environment, on() {} }, console: { log() {}, error() {} },
  });
  const module = new SourceTextModule(source, { context, identifier: filename,
    initializeImportMeta(meta) { meta.url = filename; } });
  await module.link(async specifier => {
    if (["path", "url"].includes(specifier)) {
      const imported = await import(specifier);
      return new SyntheticModule(Object.keys(imported), function () {
        for (const [key, value] of Object.entries(imported)) this.setExport(key, value);
      }, { context });
    }
    const imports = [...source.matchAll(/import\s+([^;]+?)\s+from\s+["']([^"']+)["'];/g)]
      .filter(match => match[2] === specifier);
    const names = imports.flatMap(match => match[1].startsWith("{")
      ? match[1].slice(1, -1).split(",").map(name => name.trim()) : ["default"]);
    return new SyntheticModule(names, function () {
      for (const name of names) this.setExport(name,
        specifier === "express" ? express : name === "assistantBody" ? [] : name === "BUNNY_STREAM_WEBHOOK_PATH" ? "/webhook" :
          name.startsWith("start") ? () => calls.push(name) : () => middleware);
    }, { context });
  });
  await module.evaluate();
  return { calls, listeners };
}

const filename = new URL("../../src/app/server.js", import.meta.url);
const source = readFileSync(filename, "utf8");
const cases = [
  {},
  { HOST: "127.0.0.1", PORT: "3001", BACKGROUND_JOBS_ENABLED: "false" },
  { BACKGROUND_JOBS_ENABLED: "true" },
];

test("API startup preserves default jobs and supports isolated loopback startup without jobs", () => {
  const script = `const inspectStartup = ${inspectStartup.toString()};
    const results = [];
    for (const env of ${JSON.stringify(cases)}) results.push(await inspectStartup(${JSON.stringify(source)}, env, ${JSON.stringify(filename.href)}));
    console.log(JSON.stringify(results));`;
  const results = JSON.parse(execFileSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", script], {
    encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }));
  const jobs = ["startAbandonedCartsJob", "startNotificationJobs", "startAbandonedPaymentsJob", "startAppDownloadsJob"];
  assert.deepEqual(results[0].calls, jobs);
  assert.deepEqual(results[0].listeners, [[3000, null]]);
  assert.deepEqual(results[1].calls, []);
  assert.deepEqual(results[1].listeners, [["3001", "127.0.0.1"]]);
  assert.deepEqual(results[2].calls, jobs);
});
