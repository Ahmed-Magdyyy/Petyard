import { performance } from "node:perf_hooks";
import { AssistantProviderError, capabilities, fail, normalizeUsage, validateObject, validateRequest } from "./providerContract.js";
import { getOpenAIModelProfile, openaiLunaProfile } from "./openaiProfile.js";

const ENDPOINT = "https://api.openai.com/v1/responses";

export function createOpenAIResponsesAdapter({ apiKey, model = openaiLunaProfile.model, endpoint = ENDPOINT } = {}) {
  const url = new URL(endpoint);
  const local = url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (endpoint !== ENDPOINT && !local)) fail("invalid_endpoint");
  const profile = getOpenAIModelProfile(model);
  if (!profile) fail("unsupported_model");
  if (!local && (typeof apiKey !== "string" || !apiKey.trim())) fail("missing_credentials");
  const continuations = new WeakMap();

  return {
    provider: local ? "openai-responses-local-mock" : "openai",
    model,
    capabilities,
    async generate(request) {
      validateRequest(request);
      const { instructions, messages, tools = [], outputSchema, limits, signal, continuation } = request;
      if (signal?.aborted) fail("cancelled");
      let input;
      if (continuation !== undefined) {
        const previous = continuations.get(continuation);
        if (!previous || previous.instructions !== instructions || previous.tools !== JSON.stringify(tools) ||
            messages.length !== previous.callIds.length || messages.some((message) => message.role !== "tool") ||
            new Set(messages.map((message) => message.callId)).size !== messages.length ||
            messages.some((message) => !previous.callIds.includes(message.callId))) fail("invalid_continuation");
        input = [...previous.input, ...previous.output, ...messages.map((message) => ({
          type: "function_call_output", call_id: message.callId, output: message.content,
        }))];
        continuations.delete(continuation);
      } else {
        if (messages.some((message) => message.role === "tool")) fail("invalid_continuation");
        input = messages.map(({ role, content }) => ({ role, content }));
      }
      const body = {
        model, instructions, input, store: false, stream: false,
        reasoning: { effort: limits.reasoningEffort }, include: ["reasoning.encrypted_content"],
        max_output_tokens: limits.maxOutputTokens, service_tier: profile.serviceTier,
        ...(tools.length ? { tools: tools.map(({ name, description, parameters }) => ({ type: "function", strict: true, name, description, parameters })), parallel_tool_calls: false } : {}),
        ...(outputSchema ? { text: { format: { type: "json_schema", name: "petyard_result", strict: true, schema: outputSchema } } } : {}),
      };
      if (Buffer.byteLength(JSON.stringify(body)) > 48000) fail("input_limit");
      const timeout = AbortSignal.timeout(limits.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let requestId = null;
      let usage = null;
      const started = performance.now();
      try {
        const response = await fetch(endpoint, {
          method: "POST", redirect: "error", signal: combined,
          headers: { "content-type": "application/json", ...(local ? {} : { authorization: `Bearer ${apiKey}` }) },
          body: JSON.stringify(body),
        });
        requestId = response.headers.get("x-request-id");
        if (!response.ok) {
          await response.body?.cancel();
          fail(response.status === 429 ? "rate_limited" : response.status === 401 || response.status === 403 ? "access_denied" : "provider_http_error",
            { status: response.status, providerRequestId: requestId, chargeExposure: "unknown" });
        }
        let bytes = 0;
        const chunks = [];
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > 256000) fail("response_limit");
          chunks.push(chunk);
        }
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("invalid_provider_json"); }
        if (!data || typeof data !== "object" || Array.isArray(data)) fail("invalid_provider_response");
        usage = normalizeUsage(data.usage);
        if (data.model !== model || !Array.isArray(data.output) || !["completed", "incomplete", "failed"].includes(data.status)) fail("invalid_provider_response");
        if (data.status === "failed" || data.error) fail("provider_response_failed");
        const toolCalls = [];
        const texts = [];
        let refused = false;
        for (const item of data.output) {
          if (item.type === "function_call") {
            const tool = tools.find((entry) => entry.name === item.name);
            if (!tool || typeof item.call_id !== "string" || !item.call_id || toolCalls.some((call) => call.id === item.call_id)) fail("unexpected_tool");
            let args;
            try { args = JSON.parse(item.arguments); } catch { fail("invalid_tool_arguments"); }
            validateObject(tool.parameters, args);
            toolCalls.push({ id: item.call_id, name: item.name, arguments: args });
          } else if (item.type === "message" && item.role === "assistant" && Array.isArray(item.content)) {
            for (const part of item.content) {
              if (part.type === "output_text" && typeof part.text === "string") texts.push(part.text);
              else if (part.type === "refusal") refused = true;
              else fail("unsupported_provider_output");
            }
          } else if (item.type !== "reasoning") fail("unsupported_provider_output");
        }
        if (toolCalls.length > 1) fail("tool_call_limit");
        const text = texts.join("");
        const finishReason = refused ? "refusal" : data.status === "incomplete" ? "truncated" : toolCalls.length ? "tool_request" : "completed";
        let structured = null;
        if (finishReason === "completed" && outputSchema) {
          try { structured = JSON.parse(text); } catch { fail("invalid_structured_output"); }
          validateObject(outputSchema, structured, "invalid_structured_output");
        }
        if (finishReason === "completed" && !text) fail("empty_provider_response");
        let next = null;
        if (finishReason === "tool_request") {
          next = Object.freeze({});
          // Keep opaque reasoning state in memory; never put it in logs, reports or frontend payloads.
          continuations.set(next, { input, output: data.output, callIds: toolCalls.map((call) => call.id), instructions, tools: JSON.stringify(tools) });
        }
        return { text, structured, toolCalls: finishReason === "tool_request" ? toolCalls : [], usage, finishReason,
          providerRequestId: requestId, serviceTier: data.service_tier ?? null, continuation: next, latencyMs: performance.now() - started };
      } catch (error) {
        const details = { providerRequestId: requestId, usage, chargeExposure: "unknown" };
        const latencyMs = performance.now() - started;
        if (signal?.aborted) throw Object.assign(new AssistantProviderError("cancelled", details), { latencyMs });
        if (timeout.aborted) throw Object.assign(new AssistantProviderError("timeout", details), { latencyMs });
        if (error instanceof AssistantProviderError) {
          if (error.chargeExposure === "none") Object.assign(error, details);
          error.latencyMs = latencyMs;
          throw error;
        }
        throw Object.assign(new AssistantProviderError("network_error", details), { latencyMs });
      }
    },
  };
}
