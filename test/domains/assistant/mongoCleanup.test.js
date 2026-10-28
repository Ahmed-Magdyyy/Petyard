import test from "node:test";
import assert from "node:assert/strict";
import { cleanupAssistantTestCollections, cleanupAssistantTestResources } from "./fixtures/mongoCleanup.js";

test("denied collection cleanup still closes all owned servers, disconnects and restores environment without masking failure", async () => {
  const calls = [];
  const server = (name) => ({ listening: true, closeAllConnections() { calls.push(`${name}:connections`); },
    close(callback) { calls.push(`${name}:closed`); callback(); } });
  const denied = Object.assign(new Error("drop denied"), { code: 8000 });
  await assert.rejects(cleanupAssistantTestResources({ servers: new Set([server("provider"), server("app")]),
    async cleanupCollections() { calls.push("drop"); throw denied; },
    async disconnect() { calls.push("disconnect"); }, restoreEnvironment() { calls.push("restore"); },
  }), (error) => error === denied);
  assert.deepEqual(calls, ["provider:connections", "provider:closed", "app:connections", "app:closed", "drop", "disconnect", "restore"]);
});

test("multiple cleanup failures are retained while later resources still close", async () => {
  const closeFailure = new Error("close failed"); const dropFailure = new Error("drop denied");
  const calls = [];
  await assert.rejects(cleanupAssistantTestResources({
    servers: [{ listening: true, closeAllConnections() {}, close(callback) { callback(closeFailure); } },
      { listening: false, closeAllConnections() { calls.push("already-closed-server"); } }],
    async cleanupCollections() { throw dropFailure; }, async disconnect() { calls.push("disconnect"); }, restoreEnvironment() { calls.push("restore"); },
  }), (error) => error instanceof AggregateError && error.errors[0] === closeFailure && error.errors[1] === dropFailure);
  assert.deepEqual(calls, ["already-closed-server", "disconnect", "restore"]);
});

test("collection cleanup refuses a non-test name or mismatched connection before listing or dropping anything", async () => {
  let accessed = false;
  const expected = "ai_test_mvd90zfu_5a3e09d4708c";
  const database = { databaseName: expected, listCollections() { accessed = true; throw new Error("must not list"); },
    dropCollection() { accessed = true; throw new Error("must not drop"); } };
  await assert.rejects(cleanupAssistantTestCollections({ name: "petyard", db: database }, "petyard"), /Refusing cleanup/);
  await assert.rejects(cleanupAssistantTestCollections({ name: "petyard", db: database }, expected), /connection name changed/);
  await assert.rejects(cleanupAssistantTestCollections({ name: expected, db: { ...database, databaseName: "petyard" } }, expected), /database handle changed/);
  assert.equal(accessed, false);
});

test("collection cleanup lists and drops only the exact generated database and propagates a collection denial", async () => {
  const name = "ai_test_mvd90zfu_5a3e09d4708c";
  const calls = [];
  const denied = Object.assign(new Error("collection drop denied"), { code: 8000 });
  const db = { databaseName: name,
    listCollections(filter, options) { calls.push(["list", filter, options]); return { async toArray() { return [{ name: "assistant_runs" }, { name: "users" }]; } }; },
    async dropCollection(collection) { calls.push(["drop", collection]); },
  };
  await cleanupAssistantTestCollections({ name, db }, name);
  assert.deepEqual(calls, [["list", {}, { nameOnly: true }], ["drop", "assistant_runs"], ["drop", "users"]]);
  db.dropCollection = async () => { throw denied; };
  await assert.rejects(cleanupAssistantTestCollections({ name, db }, name),
    (error) => error instanceof AggregateError && error.errors.length === 2 && error.errors.every((failure) => failure === denied));
});

test("collection cleanup waits for delayed model initialization before listing collections", async () => {
  const name = "ai_test_cleanup_111111111111"; const calls = [];
  let initialized = false;
  const models = { delayed: { async init() { await Promise.resolve(); initialized = true; calls.push("initialized"); } } };
  const db = { databaseName: name,
    listCollections() { assert.equal(initialized, true); calls.push("list"); return { async toArray() { return [{ name: "late_collection" }]; } }; },
    async dropCollection(collection) { calls.push(collection); },
  };
  await cleanupAssistantTestCollections({ name, db, models }, name);
  assert.deepEqual(calls, ["initialized", "list", "late_collection"]);
});

test("failed model initialization still permits collection cleanup and remains reported", async () => {
  const name = "ai_test_cleanup_222222222222"; const failure = new Error("synthetic index failure"); let dropped = false;
  const models = { failed: { async init() { throw failure; } } };
  const db = { databaseName: name, listCollections() { return { async toArray() { return [{ name: "owned" }]; } }; },
    async dropCollection() { dropped = true; },
  };
  await assert.rejects(cleanupAssistantTestCollections({ name, db, models }, name),
    (error) => error === failure);
  assert.equal(dropped, true);
});

test("collection cleanup continues after a failed drop and retains initialization and drop failures", async () => {
  const name = "ai_test_cleanup_333333333333"; const initFailure = new Error("init failed"); const dropFailure = new Error("drop denied");
  const calls = []; const models = { failed: { async init() { throw initFailure; } } };
  const db = { databaseName: name, listCollections() { return { async toArray() { return [{ name: "first" }, { name: "second" }]; } }; },
    async dropCollection(collection) { calls.push(collection); if (collection === "first") throw dropFailure; },
  };
  await assert.rejects(cleanupAssistantTestCollections({ name, db, models }, name),
    (error) => error instanceof AggregateError && error.errors[0] === initFailure && error.errors[1] === dropFailure);
  assert.deepEqual(calls, ["first", "second"]);
});

test("collection listing failure does not mask model initialization failure", async () => {
  const name = "ai_test_cleanup_444444444444"; const initFailure = new Error("init failed"); const listFailure = new Error("list denied");
  await assert.rejects(cleanupAssistantTestCollections({ name, models: { failed: { async init() { throw initFailure; } } },
    db: { databaseName: name, listCollections() { throw listFailure; } } }, name),
  (error) => error instanceof AggregateError && error.errors[0] === initFailure && error.errors[1] === listFailure);
});
