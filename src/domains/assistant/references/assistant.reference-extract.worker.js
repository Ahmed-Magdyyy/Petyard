import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { AssistantError, reject } from "../shared/assistant.errors.js";

const { format, limits } = workerData;
const buffer = Buffer.from(workerData.buffer);

// Check expanded bytes before Mammoth allocates document XML; this is not a general ZIP extractor.
function checkDocxArchive() {
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      end = offset; break;
    }
  }
  if (end < 0 || buffer.readUInt32LE(end + 4) !== 0) reject("reference_invalid_document");
  const count = buffer.readUInt16LE(end + 10);
  const directory = buffer.readUInt32LE(end + 16);
  if (!count || count === 0xffff || buffer.readUInt16LE(end + 8) !== count ||
      directory + buffer.readUInt32LE(end + 12) !== end) reject("reference_invalid_document");
  if (count > limits.maxArchiveEntries) reject("reference_archive_too_large", 413);
  let cursor = directory, expanded = 0;
  const names = new Set();
  for (let entry = 0; entry < count; entry++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) reject("reference_invalid_document");
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20), size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const next = cursor + 46 + nameLength + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
    const local = buffer.readUInt32LE(cursor + 42);
    if (next > end || flags & 0x41 || ![0, 8].includes(method) || local + 30 > directory ||
        buffer.readUInt16LE(cursor + 34) !== 0 || buffer.readUInt32LE(local) !== 0x04034b50) reject("reference_invalid_document");
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    if (!name || /[\\:\u0000]/u.test(name) || name.startsWith("/") || name.split("/").some(part => part === "." || part === "..") ||
        names.has(name)) reject("reference_invalid_document");
    names.add(name);
    if (/vbaProject\.bin$/iu.test(name)) reject("reference_unsupported_content");
    const localNameLength = buffer.readUInt16LE(local + 26);
    const start = local + 30 + localNameLength + buffer.readUInt16LE(local + 28);
    if (start + compressed > directory || buffer.readUInt16LE(local + 8) !== method ||
        buffer.readUInt16LE(local + 6) !== flags || !buffer.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)) {
      reject("reference_invalid_document");
    }
    if (size > limits.maxExpandedBytes - expanded) reject("reference_archive_too_large", 413);
    const payload = buffer.subarray(start, start + compressed);
    let decoded;
    try { decoded = method === 0 ? payload : inflateRawSync(payload, { maxOutputLength: Math.max(1, size) }); }
    catch (error) {
      if (error.code === "ERR_BUFFER_TOO_LARGE") reject("reference_archive_too_large", 413);
      throw error;
    }
    if (decoded.length !== size || crc32(decoded) !== buffer.readUInt32LE(cursor + 16)) reject("reference_invalid_document");
    // Reject entity expansion before the XML parser reads any document parts.
    if (/\.(?:xml|rels)$/iu.test(name) && /<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(decoded.toString("utf8"))) reject("reference_unsupported_content");
    expanded += decoded.length;
    cursor = next;
  }
  if (cursor !== end || !names.has("[Content_Types].xml") || !names.has("word/document.xml")) reject("reference_invalid_document");
}

async function docx() {
  checkDocxArchive();
  const mammoth = (await import("mammoth")).default;
  const result = await mammoth.extractRawText({ buffer });
  if (Buffer.byteLength(result.value) > limits.maxTextBytes) reject("reference_text_too_large", 413);
  if (!result.value.trim()) reject("reference_no_readable_text");
  return { units: [{ locator: "Document text", text: result.value }], warnings: [
    { code: "reference_layout_review_required" },
    { code: "reference_visual_content_not_interpreted" },
    ...(result.messages.length ? [{ code: "reference_parser_warning", count: result.messages.length }] : []),
  ] };
}

async function pdf() {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const require = createRequire(import.meta.url);
  // PDF.js requires a forward-slash terminator even for local Windows paths.
  const root = dirname(require.resolve("pdfjs-dist/package.json")).replaceAll("\\", "/");
  const loading = getDocument({ data: new Uint8Array(buffer), useWorkerFetch: false, useSystemFonts: false,
    disableFontFace: true, useWasm: false, stopAtErrors: true, verbosity: 0,
    cMapUrl: `${root}/cmaps/`, cMapPacked: true, standardFontDataUrl: `${root}/standard_fonts/` });
  let document;
  try {
    document = await loading.promise;
    if (document.isPureXfa) reject("reference_unsupported_content");
    if (document.numPages > limits.maxPages) reject("reference_too_many_pages", 413);
    const labels = await document.getPageLabels();
    const units = [];
    let total = 0, empty = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const reader = page.streamTextContent().getReader();
      const parts = [];
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          for (const item of chunk.value.items) {
            if (typeof item.str !== "string") continue;
            const part = item.str + (item.hasEOL ? "\n" : " ");
            total += Buffer.byteLength(part);
            if (total > limits.maxTextBytes) reject("reference_text_too_large", 413);
            parts.push(part);
          }
        }
      } finally { reader.releaseLock(); page.cleanup(); }
      const text = parts.join("").trim();
      if (!text) empty++;
      const label = labels?.[pageNumber - 1];
      units.push({ locator: `PDF page ${pageNumber}`, page: pageNumber,
        pageLabel: typeof label === "string" && Buffer.byteLength(label) <= 200 ? label : null, text });
    }
    if (empty === units.length) reject("reference_no_readable_text");
    return { units, warnings: [{ code: "reference_layout_review_required" }, { code: "reference_visual_content_not_interpreted" },
      ...(labels ? [{ code: "reference_page_labels_unverified" }] : []),
      ...(empty ? [{ code: "reference_pages_without_text", count: empty }] : [])] };
  } finally { await loading.destroy(); }
}

try {
  parentPort.postMessage({ result: format === "pdf" ? await pdf() : await docx() });
} catch (error) {
  parentPort.postMessage({ error: error instanceof AssistantError ? { code: error.code, status: error.status }
    : { code: error.name === "PasswordException" ? "reference_password_protected" : "reference_invalid_document", status: 400 } });
}
