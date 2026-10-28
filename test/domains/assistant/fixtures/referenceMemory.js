import mongoose from "mongoose";
import { matchesQuery } from "./matchesQuery.js";
import { createReferenceService } from "../../../../src/domains/assistant/references/assistant.reference-service.js";
import { createReferenceWorker } from "../../../../src/domains/assistant/references/assistant.reference-worker.js";

export const referenceTestConfig = () => ({ enabled: true, limits: { maxFileBytes: 8192, maxTextBytes: 4096,
  maxPages: 10, maxArchiveEntries: 30, maxExpandedBytes: 65536, timeoutMs: 10000 },
  storage: { zone: "fictional-private", accessKey: "synthetic-key", endpoint: "https://storage.bunnycdn.com", timeoutMs: 1000 } });
export const referenceActor = () => ({ _id: new mongoose.Types.ObjectId(), role: "superAdmin", phoneVerified: true });
export const referenceFile = () => ({ originalname: "care.md", mimetype: "text/markdown", buffer: Buffer.from("# القطط\nمرجع تجريبي 1.25") });
export const referenceBody = () => ({ title: "Fictional care reference", species: '["cat"]' });

// Only operations exercised by reference tests; this is not native MongoDB proof.
export function referenceMemory() {
  const state = { rows: [], objects: new Map(), reads: 0, puts: 0, time: new Date("2026-10-24T12:00:00Z") };
  const query = run => {
    let sort, limit;
    const value = { sort(order) { sort = order; return value; }, limit(count) { limit = count; return value; },
      async lean() {
        const result = await run();
        if (!Array.isArray(result)) return result ? { ...result } : null;
        if (sort) result.sort((a, b) => String(a._id).localeCompare(String(b._id)) * sort._id);
        return (limit ? result.slice(0, limit) : result).map(row => ({ ...row }));
      }, then(resolve, reject) { return value.lean().then(resolve, reject); } };
    return value;
  };
  const apply = (row, update) => {
    Object.assign(row, update.$set);
    for (const [key, increment] of Object.entries(update.$inc ?? {})) row[key] = (row[key] ?? 0) + increment;
    row.updatedAt = new Date(state.time);
    return row;
  };
  const model = {
    findById: id => query(() => state.rows.find(row => String(row._id) === String(id))),
    findOne: filter => query(() => state.rows.find(row => matchesQuery(row, filter))),
    find: filter => query(() => state.rows.filter(row => matchesQuery(row, filter))),
    findOneAndUpdate: (filter, update, options = {}) => query(() => {
      let row = state.rows.find(value => matchesQuery(value, filter));
      if (!row && options.upsert) {
        row = { _id: new mongoose.Types.ObjectId(), preview: "", warnings: [], authors: "", edition: "", sourceUrl: "",
          createdAt: new Date(state.time), updatedAt: new Date(state.time), ...update.$setOnInsert };
        state.rows.push(row);
      }
      return row ? apply(row, update) : null;
    }),
    async updateMany(filter, update) { state.rows.filter(row => matchesQuery(row, filter)).forEach(row => apply(row, update)); },
  };
  const storage = () => ({
    async put(key, buffer) {
      state.puts++;
      if (state.failPut) throw new Error("synthetic storage failure with private details");
      state.objects.set(key, Buffer.from(buffer));
      await state.afterPut?.(key);
    },
    async get(key, maxBytes) {
      state.reads++;
      if (state.failGet || !state.objects.has(key)) throw new Error("synthetic unavailable source");
      const buffer = state.objects.get(key);
      if (buffer.length > maxBytes) throw new Error("test download bound");
      return buffer;
    },
  });
  const dependencies = { model, ensureStore: async () => {}, storage, now: () => new Date(state.time) };
  return { state, model, dependencies, application: createReferenceService(dependencies),
    worker: () => createReferenceWorker(dependencies) };
}
