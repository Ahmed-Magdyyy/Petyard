import { randomBytes } from "node:crypto";

function copy(value) {
  if (value instanceof Date) return new Date(value);
  if (value?.toHexString) return value.toHexString();
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)]));
  return value;
}

function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some((part) => matches(row, part));
    const value = key.split(".").reduce((part, field) => part?.[field], row);
    if (Array.isArray(expected)) return Array.isArray(value) && JSON.stringify(value) === JSON.stringify(expected);
    if (expected && typeof expected === "object" && !expected.toHexString && !(expected instanceof Date)) {
      return Object.entries(expected).every(([op, operand]) => {
        if (op === "$exists") return (value !== undefined) === operand;
        if (op === "$in") return operand.some((item) => String(item) === String(value));
        if (op === "$ne") return String(value) !== String(operand);
        if (op === "$gt") return value > operand;
        if (op === "$gte") return value >= operand;
        if (op === "$lte") return value <= operand;
        throw new Error(`Unsupported fixture filter ${op}`);
      });
    }
    return String(value) === String(expected);
  });
}

export function replacementDatabase(seed, { now = Date.now } = {}) {
  const tables = {};
  function collection(name, initial = []) {
    tables[name] = copy(initial);
    const query = (read) => {
      let sorting;
      let limit;
      let skip = 0;
      const q = {
        session() { return q; }, select() { return q; },
        sort(value) { sorting = value; return q; },
        limit(value) { limit = value; return q; },
        skip(value) { skip = value; return q; },
        async lean() { return q; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            const value = copy(read());
            if (sorting && Array.isArray(value)) value.sort((a, b) => {
              for (const [key, direction] of Object.entries(sorting)) {
                if (a[key] < b[key]) return -direction;
                if (a[key] > b[key]) return direction;
              }
              return 0;
            });
            if (!Array.isArray(value)) return value;
            return limit ? value.slice(skip, skip + limit) : value.slice(skip);
          }).then(resolve, reject);
        },
      };
      return q;
    };
    function update(row, changes) {
      for (const [key, value] of Object.entries(changes.$set || {})) {
        const fields = key.split(".");
        const parent = fields.slice(0, -1).reduce((part, field) => part[field] ??= {}, row);
        parent[fields.at(-1)] = copy(value);
      }
      for (const [key, value] of Object.entries(changes.$inc || {})) {
        const fields = key.split(".");
        const parent = fields.slice(0, -1).reduce((part, field) => part[field] ??= {}, row);
        parent[fields.at(-1)] = (parent[fields.at(-1)] || 0) + value;
      }
      for (const key of Object.keys(changes.$unset || {})) {
        const fields = key.split(".");
        const parent = fields.slice(0, -1).reduce((part, field) => part?.[field], row);
        if (parent) delete parent[fields.at(-1)];
      }
      return row;
    }
    return {
      find(filter) { return query(() => tables[name].filter((row) => matches(row, filter))); },
      findOne(filter) { return query(() => tables[name].find((row) => matches(row, filter)) || null); },
      findById(id) { return this.findOne({ _id: id }); },
      countDocuments(filter) { return query(() => tables[name].filter((row) => matches(row, filter)).length); },
      async insertMany(rows) {
        return this.create(rows.map((row) => name === "placements" ? { activeSlot: true, ...row } : row));
      },
      async exists(filter) { return tables[name].some((row) => matches(row, filter)); },
      async findOneAndDelete(filter) {
        const row = tables[name].find((item) => matches(item, filter));
        if (!row) return null;
        tables[name] = tables[name].filter((item) => item !== row);
        return copy(row);
      },
      async deleteMany(filter) {
        const previous = tables[name].length;
        tables[name] = tables[name].filter((row) => !matches(row, filter));
        return { deletedCount: previous - tables[name].length };
      },
      async deleteOne(filter) {
        return { deletedCount: await this.findOneAndDelete(filter) ? 1 : 0 };
      },
      async create(rows) {
        const created = rows.map((row) => ({ _id: randomBytes(12).toString("hex"),
          createdAt: new Date(now()), updatedAt: new Date(now()), ...copy(row) }));
        tables[name].push(...created);
        return copy(created);
      },
      findOneAndUpdate(filter, changes, options = {}) {
        return query(() => {
          let row = tables[name].find((item) => matches(item, filter));
          if (!row && options.upsert) {
            row = { _id: randomBytes(12).toString("hex"), ...copy(changes.$setOnInsert) };
            tables[name].push(row);
          }
          if (!row) return null;
          const old = copy(row);
          update(row, changes);
          return options.new ? row : old;
        });
      },
      async updateOne(filter, changes, options = {}) {
        let row = tables[name].find((item) => matches(item, filter));
        if (!row && options.upsert) {
          row = { _id: randomBytes(12).toString("hex"), ...copy(changes.$setOnInsert) };
          tables[name].push(row);
        }
        if (!row) return { matchedCount: 0, modifiedCount: 0 };
        update(row, changes);
        return { matchedCount: 1, modifiedCount: 1 };
      },
      async updateMany(filter, changes) {
        for (const row of tables[name].filter((item) => matches(item, filter))) update(row, changes);
      },
    };
  }
  let tail = Promise.resolve();
  const connection = { async startSession() {
    return {
      async withTransaction(work) {
        const previous = tail;
        let unlock;
        tail = new Promise((resolve) => { unlock = resolve; });
        await previous;
        const snapshot = copy(tables);
        try { await work(); }
        catch (error) { for (const key of Object.keys(tables)) tables[key] = snapshot[key]; throw error; }
        finally { unlock(); }
      },
      async endSession() {},
    };
  } };
  return {
    connection,
    products: collection("products", seed.products),
    placements: collection("placements", seed.placements),
    assets: collection("assets", seed.assets),
    replacements: collection("replacements", seed.replacements),
    recoveries: collection("recoveries", seed.recoveries),
    batches: collection("batches", seed.batches),
    operations: collection("operations", seed.operations),
    attempts: collection("attempts"),
    covers: collection("covers", seed.covers),
    saves: collection("saves", seed.saves),
    sessions: collection("sessions", seed.sessions),
    daily: collection("daily", seed.daily),
  };
}
