export class AssistantProviderError extends Error {
  constructor(code, { status = null, providerRequestId = null, usage = null, chargeExposure = "none" } = {}) {
    super(`Assistant provider: ${code}`);
    this.name = "AssistantProviderError";
    Object.assign(this, { code, status, providerRequestId, usage, chargeExposure });
  }
}

export const capabilities = Object.freeze({
  functionCalling: true,
  outputSchema: "strict objects, bounded arrays of objects, string enums and nullable strings/bounded integers; depth 6, 100 nodes, 20 fields per object",
  schemaWithTools: false,
  streaming: false,
  reasoningEfforts: Object.freeze(["none", "low"]),
  usage: "nullable input/cached/cache-write/output/reasoning counts; reasoning is included in output",
  continuation: "opaque, adapter-instance-local and single-use",
});

export function fail(code, details) {
  throw new AssistantProviderError(code, details);
}

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const fieldType = (field) => Array.isArray(field.type) ? field.type.find((type) => type !== "null") : field.type;
const nullable = (field) => Array.isArray(field.type) && field.type.includes("null");

// shortcut: this validates only the declared schema subset; use a maintained validator before expanding beyond it.
export function validateSchema(schema, { flatOnly = false } = {}) {
  let nodes = 0;
  function visit(field, depth) {
    if (!object(field) || ++nodes > 100 || depth > 6 ||
        (flatOnly && depth > 1 && field.type !== "string")) fail("unsupported_schema");
    const type = fieldType(field);
    if (Array.isArray(field.type) && (field.type.length !== 2 || !nullable(field) ||
        !["string", "integer"].includes(type))) fail("unsupported_schema");
    let allowed;
    if (type === "object") {
      allowed = ["type", "properties", "required", "additionalProperties"];
      if (field.additionalProperties !== false || !object(field.properties) || !Array.isArray(field.required)) fail("unsupported_schema");
      const keys = Object.keys(field.properties);
      if (!keys.length || keys.length > 21 || field.required.length !== keys.length || new Set(field.required).size !== keys.length ||
          keys.some((key) => !field.required.includes(key))) fail("unsupported_schema");
      for (const child of Object.values(field.properties)) visit(child, depth + 1);
    } else if (type === "array") {
      allowed = ["type", "items", "maxItems"];
      if (!Number.isSafeInteger(field.maxItems) || field.maxItems < 0 || field.maxItems > 50 || field.items?.type !== "object") fail("unsupported_schema");
      visit(field.items, depth + 1);
    } else if (type === "string") {
      allowed = ["type", "enum"];
      if (field.enum !== undefined && (!Array.isArray(field.enum) || !field.enum.length ||
          field.enum.some((value) => typeof value !== "string" && !(value === null && nullable(field))))) fail("unsupported_schema");
    } else if (type === "integer") {
      allowed = ["type", "minimum", "maximum"];
      if (!Number.isSafeInteger(field.minimum) || !Number.isSafeInteger(field.maximum) || field.minimum > field.maximum) fail("unsupported_schema");
    } else fail("unsupported_schema");
    if (Object.keys(field).some((key) => !allowed.includes(key))) fail("unsupported_schema");
  }
  if (!object(schema) || schema.type !== "object") fail("unsupported_schema");
  visit(schema, 1);
}

export function validateObject(schema, value, code = "invalid_tool_arguments") {
  function visit(field, data) {
    if (field.enum && !field.enum.includes(data)) fail(code);
    if (data === null && nullable(field)) return;
    const type = fieldType(field);
    if (type === "object") {
      if (!object(data) || Object.keys(data).length !== field.required.length ||
          field.required.some((key) => !Object.hasOwn(data, key))) fail(code);
      for (const [key, child] of Object.entries(field.properties)) visit(child, data[key]);
    } else if (type === "array") {
      if (!Array.isArray(data) || data.length > field.maxItems) fail(code);
      for (const item of data) visit(field.items, item);
    } else if (type === "integer") {
      if (!Number.isSafeInteger(data) || data < field.minimum || data > field.maximum) fail(code);
    } else if (type !== "string" || typeof data !== "string") fail(code);
  }
  visit(schema, value);
}

export function validateRequest(request) {
  if (!object(request)) fail("invalid_request");
  const { instructions, messages, tools = [], outputSchema, limits, signal, onTextDelta } = request;
  if (onTextDelta !== undefined || request.stream !== undefined) fail("unsupported_streaming");
  if (request.model !== undefined) fail("model_is_server_configured");
  if (!object(limits) || Object.keys(limits).some((key) => !["maxOutputTokens", "timeoutMs", "reasoningEffort"].includes(key)) ||
      !Number.isInteger(limits.maxOutputTokens) || limits.maxOutputTokens < 16 ||
      limits.maxOutputTokens > 2048 || !Number.isInteger(limits.timeoutMs) || limits.timeoutMs < 1 ||
      limits.timeoutMs > 30000 || !["none", "low"].includes(limits.reasoningEffort)) fail("invalid_limits");
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail("invalid_signal");
  if (typeof instructions !== "string" || !instructions || !Array.isArray(messages) ||
      messages.length === 0 || messages.length > 30 || !Array.isArray(tools) || tools.length > 5) fail("invalid_request");
  for (const message of messages) {
    if (!object(message) || !["user", "assistant", "tool"].includes(message.role) ||
        typeof message.content !== "string" ||
        (message.role === "tool" && (typeof message.callId !== "string" || !message.callId))) fail("invalid_messages");
  }
  if (Buffer.byteLength(JSON.stringify(request, (key, value) => key === "signal" ? undefined : value)) > 24000) fail("input_limit");
  const names = new Set();
  for (const tool of tools) {
    if (!object(tool) || !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) || names.has(tool.name) ||
        typeof tool.description !== "string") fail("invalid_tools");
    names.add(tool.name);
    validateSchema(tool.parameters, { flatOnly: true });
  }
  if (outputSchema !== undefined) {
    validateSchema(outputSchema);
    if (tools.length) fail("unsupported_schema_with_tools");
  }
}

export function normalizeUsage(usage) {
  if (!usage || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 ||
      !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0 ||
      !Number.isSafeInteger(usage.input_tokens + usage.output_tokens) ||
      (usage.total_tokens !== undefined && usage.total_tokens !== usage.input_tokens + usage.output_tokens)) return null;
  const detail = (value, ceiling) => Number.isSafeInteger(value) && value >= 0 && value <= ceiling ? value : null;
  let cached = detail(usage.input_tokens_details?.cached_tokens, usage.input_tokens);
  let cacheWrites = detail(usage.input_tokens_details?.cache_write_tokens, usage.input_tokens);
  if (cached !== null && cacheWrites !== null && cached + cacheWrites > usage.input_tokens) cached = cacheWrites = null;
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrites,
    outputTokens: usage.output_tokens,
    reasoningTokens: detail(usage.output_tokens_details?.reasoning_tokens, usage.output_tokens),
    totalTokens: usage.input_tokens + usage.output_tokens,
  };
}
