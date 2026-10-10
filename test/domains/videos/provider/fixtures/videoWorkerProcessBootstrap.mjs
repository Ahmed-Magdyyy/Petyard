// Isolate the actual standalone entry point without changing production defaults.
import assert from "node:assert/strict";
import mongoose from "mongoose";
import dotenvx from "@dotenvx/dotenvx";
import axios from "axios";

const prefix = process.env.VIDEOS_WORKER_ACCEPTANCE_PREFIX;
assert.match(prefix || "", /^videos_worker_acceptance_[a-f\d]{24}$/);
assert.ok(process.env.MONGO_URI);
assert.equal(process.env.BULLMQ_QUEUE_PREFIX, prefix);
// The parent supplies explicit test configuration. Never load ambient .env.
dotenvx.config = () => ({ parsed: {} });
const originalModel = mongoose.model;
mongoose.model = function (name, schema, collection, options) {
  if (schema) {
    schema.set("autoCreate", false); schema.set("autoIndex", false);
    collection = `${prefix}_${collection || schema.get("collection") || mongoose.pluralize()(name)}`;
  }
  return originalModel.call(mongoose, name, schema, collection, options);
};
const connect = mongoose.connect.bind(mongoose);
mongoose.connect = async (uri, options) => {
  assert.equal(uri, process.env.MONGO_URI);
  const result = await connect(uri, { ...options, autoCreate: false, autoIndex: false,
    serverSelectionTimeoutMS: 15_000 });
  const db = mongoose.connection.db;
  const collection = db.collection.bind(db);
  db.collection = (name, ...args) => {
    assert.ok(name.startsWith(`${prefix}_`), "Worker must use isolated collections");
    return collection(name, ...args);
  };
  const existing = new Set((await db.listCollections().toArray()).map(value => value.name));
  const owned = [];
  for (const model of Object.values(mongoose.models)) {
    const name = model.collection.name;
    assert.ok(name.startsWith(`${prefix}_`));
    // Restart reuses this run's namespace; the parent verifies initial absence.
    if (!existing.has(name)) await db.createCollection(name);
    owned.push(name);
  }
  process.send?.({ type: "collections", names: owned });
  return result;
};
const rejectHttp = () => {
  process.send?.({ type: "unexpected-http" });
  throw new Error("Worker acceptance cannot call external providers");
};
const httpMode = process.env.VIDEOS_WORKER_ACCEPTANCE_HTTP_MODE || "blocked";
assert.ok(["blocked", "hold", "replay"].includes(httpMode));
globalThis.fetch = async (url, options = {}) => {
  if (httpMode === "blocked") return rejectHttp();
  const parsed = new URL(url);
  if (parsed.origin !== "https://video.bunnycdn.com" ||
      parsed.pathname !== "/library/754739/videos/00000000-0000-4000-8000-000000000001" ||
      !["GET", "DELETE"].includes(options.method || "GET")) return rejectHttp();
  if (options.method === "DELETE") {
    if (httpMode === "hold") {
      process.send?.({ type: "provider-delete-held" });
      return new Promise(() => {});
    }
    process.send?.({ type: "provider-delete-accepted" });
    return new Response(null, { status: 204 });
  }
  process.send?.({ type: "provider-absence" });
  return new Response("{}", { status: 404 });
};
axios.defaults.adapter = async configuration => {
  const assetId = process.env.VIDEOS_WORKER_ACCEPTANCE_ASSET_ID;
  if (httpMode !== "replay" || !/^[a-f\d]{24}$/.test(assetId || "") ||
      configuration.method?.toUpperCase() !== "DELETE" ||
      configuration.url !== `https://storage.bunnycdn.com/test-worker-acceptance/petyard/video-posters/${assetId}.webp`) return rejectHttp();
  process.send?.({ type: "poster-delete-accepted" });
  return { status: 404, statusText: "Not Found", data: {}, headers: {}, config: configuration };
};
process.on("message", message => {
  if (message?.type === "shutdown") process.emit("SIGTERM");
});
await import("../../../../../src/workers/videoProvider.worker.js");
