import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import axios from "axios";
import { createReferenceStorage } from "../../../src/domains/assistant/references/assistant.reference-storage.js";
import { sourceHash } from "../../../src/domains/assistant/references/assistant.reference-service.js";

test("Bunny adapter sends real HTTP with credentials/checksum and enforces download bounds and sanitized failures", async t => {
  const objects = new Map(), requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url });
    assert.equal(req.headers.accesskey, "fictional-reference-key");
    if (req.url.startsWith("/fixture-fail/")) { res.writeHead(500); return res.end("synthetic upstream private details"); }
    if (req.url.startsWith("/fixture-large/")) { res.writeHead(200); return res.end(Buffer.alloc(1024)); }
    if (req.method === "PUT") {
      const parts = []; for await (const part of req) parts.push(part);
      const buffer = Buffer.concat(parts); assert.equal(req.headers.checksum, sourceHash(buffer).toUpperCase());
      objects.set(req.url, buffer); res.writeHead(201); return res.end();
    }
    if (req.method === "GET" && objects.has(req.url)) return res.end(objects.get(req.url));
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const transport = { request(request) {
    const url = new URL(request.url); assert.equal(url.origin, "https://storage.bunnycdn.com");
    return axios.request({ ...request, url: `http://127.0.0.1:${server.address().port}${url.pathname}`, proxy: false });
  } };
  const config = { storage: { zone: "fixture-private", accessKey: "fictional-reference-key", endpoint: "https://storage.bunnycdn.com", timeoutMs: 1000 } };
  const storage = createReferenceStorage(config, { transport }), key = "assistant-references/fixture/original.txt", source = Buffer.from("Fictional text");
  await storage.put(key, source, "text/plain"); assert.deepEqual(await storage.get(key, 1024), source);
  await assert.rejects(storage.get("assistant-references/missing.txt", 1024), { message: "Bunny storage object was not found" });
  const large = createReferenceStorage({ storage: { ...config.storage, zone: "fixture-large" } }, { transport });
  await assert.rejects(large.get(key, 16), { message: "Bunny storage request failed" });
  const failed = createReferenceStorage({ storage: { ...config.storage, zone: "fixture-fail" } }, { transport });
  await assert.rejects(failed.put(key, source, "text/plain"), { message: "Bunny storage request failed" });
  assert.equal(requests.filter(value => value.path.startsWith("/fixture-fail/")).length, 3);
  assert.equal(requests.filter(value => value.path.startsWith("/fixture-large/")).length, 3);
});
