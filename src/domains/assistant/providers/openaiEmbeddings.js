import { AssistantProviderError, fail } from "./providerContract.js";

const endpointUrl = "https://api.openai.com/v1/embeddings";
export const embeddingProfile = Object.freeze({ model: "text-embedding-3-large", dimensions: 1536,
  maxItems: 16, maxTextBytes: 2000, maxInputTokens: 8192, maxRequestTokens: 300000 });

export function embeddingBatchBounds(input) {
  if (!Array.isArray(input) || !input.length || input.length > embeddingProfile.maxItems || Array.from(input).some(value =>
    typeof value !== "string" || !value.trim() || !value.isWellFormed() || value.includes("\u0000") ||
    Buffer.byteLength(value) > embeddingProfile.maxTextBytes)) fail("invalid_embedding_input");
  return { items: input.length, maximumTokens: Math.min(input.length * embeddingProfile.maxInputTokens, embeddingProfile.maxRequestTokens) };
}

export function createOpenAIEmbeddingsAdapter({ apiKey, endpoint = endpointUrl } = {}) {
  let url;
  try { url = new URL(endpoint); } catch { fail("invalid_endpoint"); }
  const local = url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (endpoint !== endpointUrl && !local)) fail("invalid_endpoint");
  const credential = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!local && (!credential || credential.startsWith("encrypted:"))) fail("missing_credentials");
  return {
    provider: local ? "openai-embeddings-local-mock" : "openai",
    model: embeddingProfile.model,
    dimensions: embeddingProfile.dimensions,
    async embed({ input, timeoutMs, signal }) {
      const bounds = embeddingBatchBounds(input);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) fail("invalid_embedding_timeout");
      if (signal?.aborted) fail("cancelled");
      const timeout = AbortSignal.timeout(timeoutMs);
      let providerRequestId = null, usage = null;
      const started = performance.now();
      try {
        const response = await fetch(endpoint, { method: "POST", redirect: "error",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: { "content-type": "application/json", ...(local ? {} : { authorization: `Bearer ${credential}` }) },
          body: JSON.stringify({ model: embeddingProfile.model, dimensions: embeddingProfile.dimensions, encoding_format: "float", input }) });
        providerRequestId = response.headers.get("x-request-id");
        if (!response.ok) {
          await response.body?.cancel();
          fail(response.status === 429 ? "rate_limited" : [401, 403].includes(response.status) ? "access_denied" : "provider_http_error",
            { status: response.status });
        }
        const chunks = []; let bytes = 0;
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > 2 * 1024 * 1024) fail("response_limit");
          chunks.push(chunk);
        }
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("invalid_provider_json"); }
        const count = data?.usage?.prompt_tokens;
        if (data?.model === embeddingProfile.model && Number.isSafeInteger(count) && count > 0 && count <= bounds.maximumTokens && data.usage.total_tokens === count) {
          usage = { inputTokens: count, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, totalTokens: count };
        }
        if (data?.object !== "list" || data.model !== embeddingProfile.model || !Array.isArray(data.data) || data.data.length !== bounds.items) {
          fail("invalid_embedding_response");
        }
        const vectors = new Array(bounds.items);
        for (const row of data.data) {
          if (row?.object !== "embedding" || !Number.isInteger(row.index) || row.index < 0 || row.index >= bounds.items || vectors[row.index] ||
              !Array.isArray(row.embedding) || row.embedding.length !== embeddingProfile.dimensions ||
              row.embedding.some(value => typeof value !== "number" || !Number.isFinite(value)) || !row.embedding.some(value => value !== 0)) {
            fail("invalid_embedding_response");
          }
          vectors[row.index] = row.embedding;
        }
        if (!usage) fail("invalid_embedding_usage");
        return { vectors, usage, providerRequestId, latencyMs: performance.now() - started };
      } catch (error) {
        const details = { usage, providerRequestId, chargeExposure: "unknown" };
        const failure = signal?.aborted ? new AssistantProviderError("cancelled", details)
          : timeout.aborted ? new AssistantProviderError("timeout", details)
            : error instanceof AssistantProviderError ? Object.assign(error, details) : new AssistantProviderError("network_error", details);
        failure.latencyMs = performance.now() - started;
        throw failure;
      }
    },
  };
}
