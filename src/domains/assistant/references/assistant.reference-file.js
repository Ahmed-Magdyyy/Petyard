import { createHash } from "node:crypto";
import { reject } from "../shared/assistant.errors.js";

const formats = Object.freeze({
  pdf: ["application/pdf"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  md: ["text/markdown", "text/x-markdown", "text/plain"],
  txt: ["text/plain"],
});

function textContent(buffer, maxTextBytes) {
  if (buffer.length > maxTextBytes) reject("reference_text_too_large", 413);
  let content;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { reject("reference_invalid_encoding"); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content)) reject("reference_invalid_text");
  if (!content.trim()) reject("reference_no_readable_text");
  // Keep the actual wording and Unicode; line endings are the only normalization here.
  return content.replace(/\r\n?/gu, "\n");
}

// Preliminary file admission only. PDF/DOCX still require bounded structural parsing before preparation can succeed.
export function inspectReferenceFile(file, limits) {
  if (!limits || ![limits.maxFileBytes, limits.maxTextBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
    reject("reference_configuration_required", 503);
  }
  if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length) reject("reference_file_required");
  if (file.buffer.length > limits.maxFileBytes) reject("reference_file_too_large", 413);
  if (typeof file.originalname !== "string" || !file.originalname.trim() || file.originalname.length > 255 ||
      /[\\/\u0000-\u001f\u007f]/u.test(file.originalname)) reject("reference_invalid_filename");
  const format = /\.([a-z]+)$/iu.exec(file.originalname)?.[1].toLowerCase();
  if (!Object.hasOwn(formats, format)) reject("reference_unsupported_format");
  const mime = file.mimetype;
  if (mime != null && mime !== "" && mime !== "application/octet-stream" && !formats[format].includes(mime)) {
    reject("reference_format_mismatch");
  }
  if (format === "pdf" && !/^%PDF-(?:1\.[0-7]|2\.0)(?:\s|$)/u.test(file.buffer.subarray(0, 16).toString("latin1"))) {
    reject("reference_format_mismatch");
  }
  if (format === "docx" && !file.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    reject("reference_format_mismatch");
  }
  const content = ["md", "txt"].includes(format) ? textContent(file.buffer, limits.maxTextBytes) : null;
  return {
    filename: file.originalname,
    format,
    bytes: file.buffer.length,
    sha256: createHash("sha256").update(file.buffer).digest("hex"),
    text: content,
  };
}
