const assert = require("node:assert/strict");
const { resolve } = require("node:path");

process.env.TZ = "Africa/Cairo";
const cron = require(process.env.CRON_DST_MODULE ? resolve(process.env.CRON_DST_MODULE) : "node-cron");
const RealDate = Date;
let clock = new RealDate("2026-10-29T20:59:59Z").getTime();
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
};
let timerId = 0;
const timers = new Map();
global.setTimeout = (fn, delay) => {
  const id = ++timerId;
  timers.set(id, { fn, delay, due: clock + delay });
  return id;
};
global.clearTimeout = id => timers.delete(id);

const intervals = [["* * * * *", 60_000], ["*/5 * * * *", 300_000], ["0 * * * *", 3_600_000]];
const calendars = ["0 7 * * *", "0 22 * * *", "0 0,12 * * *", "30 8 * * *"];
const dates = [
  "2026-10-29T20:59:59Z", "2026-10-29T21:00:00Z", "2026-10-29T21:11:59Z",
  "2026-10-29T21:59:59Z", "2026-10-29T22:00:00Z", "2026-10-29T22:59:59Z",
  "2026-10-30T00:00:00Z", "2026-04-23T21:59:59Z", "2026-04-23T22:00:00Z",
  "2026-07-01T00:00:00Z", "2026-12-01T00:00:00Z",
];
let assertions = 0;

async function main() {
  for (const [pattern, interval] of [...intervals, ...calendars.map(p => [p, null])]) {
    for (const stamp of dates) {
      clock = new RealDate(stamp).getTime();
      const task = cron.schedule(pattern, () => assert.fail("Calculation must not run a job"), {
        timezone: interval ? "UTC" : "Africa/Cairo",
      });
      const next = task.getNextRun();
      assert(next.getTime() > clock, `${pattern} did not advance at ${stamp}`);
      assert(task.match(next), `${pattern} returned a date outside its schedule`);
      if (interval) assert(next.getTime() - clock <= interval, `${pattern} skipped an interval`);
      assertions++;
      task.destroy();
      assert.equal(timers.size, 0);
    }
  }

  // Preserve actual pre-fix daily times; the old birthday/cleanup comments were inaccurate.
  const expected = [
    ["0 7 * * *", "2026-07-01T04:00:00.000Z", "2026-12-01T05:00:00.000Z"],
    ["0 22 * * *", "2026-07-01T19:00:00.000Z", "2026-12-01T20:00:00.000Z"],
    ["0 0,12 * * *", "2026-07-01T09:00:00.000Z", "2026-12-01T10:00:00.000Z"],
    ["30 8 * * *", "2026-07-01T05:30:00.000Z", "2026-12-01T06:30:00.000Z"],
  ];
  for (const [pattern, summer, winter] of expected) {
    for (const [stamp, next] of [["2026-07-01T00:00:00Z", summer], ["2026-12-01T00:00:00Z", winter]]) {
      clock = new RealDate(stamp).getTime();
      const task = cron.schedule(pattern, () => {}, { timezone: "Africa/Cairo" });
      assert.equal(task.getNextRun().toISOString(), next);
      task.destroy();
      assertions++;
    }
  }

  // Exercise real heartbeat code with fake timers and harmless callbacks only.
  for (const [pattern, interval] of intervals) {
    for (const stamp of ["2026-10-29T20:59:59Z", "2026-10-29T21:11:59Z", "2026-04-23T21:59:59Z"]) {
      clock = new RealDate(stamp).getTime();
      let calls = 0;
      const task = cron.schedule(pattern, () => { calls++; }, { timezone: "UTC" });
      for (let step = 0; step < 6; step++) {
        const [id, timer] = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        timers.delete(id);
        assert(timer.delay > 0 && timer.delay <= interval, `${pattern} armed an invalid heartbeat`);
        clock = timer.due;
        await timer.fn();
        for (let n = 0; n < 10; n++) await Promise.resolve();
        assert.equal(calls, step + 1, `${pattern} missed or duplicated a callback at ${new RealDate(clock).toISOString()}`);
        assertions++;
      }
      task.destroy();
      assert.equal(timers.size, 0);
    }
  }
  console.log(JSON.stringify({ assertions, businessJobsRun: 0, result: "PASS" }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
