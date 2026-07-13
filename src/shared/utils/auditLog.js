import crypto from "crypto";

export function getHeaderValue(req, headerName) {
  const value = req.headers?.[String(headerName).toLowerCase()];
  if (typeof value !== "string") return null;

  const normalized = value.trim();
  return normalized || null;
}

export function safeIdentifierMarker(value) {
  if (typeof value !== "string") return null;

  const normalized = value.trim();
  if (!normalized) return null;

  return {
    hash: crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16),
    suffix: normalized.slice(-12),
    length: normalized.length,
  };
}

export function logAuditEvent(event, payload = {}) {
  console.info(`[Audit] ${event} ${JSON.stringify(payload)}`);
}
