import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("standalone assistant worker registers the product taxonomy without loading credentials or connecting when disabled", () => {
  const env = { ...process.env, ASSISTANT_ENABLED: "false", ASSISTANT_BOOKING_RETENTION_ENABLED: "false", ASSISTANT_REFERENCES_ENABLED: "false" };
  for (const key of Object.keys(env)) if (/^(?:MONGO|OPENAI|DOTENV)/.test(key)) delete env[key];
  const script = `
    import assert from 'node:assert/strict';
    import mongoose from 'mongoose';
    mongoose.connect = () => assert.fail('Disabled worker must not connect');
    await import('./src/workers/assistant.worker.js');
    const { ProductModel } = await import('./src/domains/product/product.model.js');
    for (const path of ['brand', 'category', 'subcategory']) {
      const ref = ProductModel.schema.path(path).options.ref;
      assert.ok(mongoose.models[ref], path + ' populate schema missing');
    }
    console.log('taxonomy schemas registered without a connection');
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", windowsHide: true });
  assert.match(output, /taxonomy schemas registered without a connection/);
  assert.match(output, /Assistant Worker.*Disabled/);
});
