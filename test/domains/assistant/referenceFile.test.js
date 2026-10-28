import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspectReferenceFile } from "../../../src/domains/assistant/references/assistant.reference-file.js";

const limits = { maxFileBytes: 1024, maxTextBytes: 512 };
const file = (originalname, content, mimetype = "application/octet-stream") => ({
  originalname, buffer: Buffer.isBuffer(content) ? content : Buffer.from(content), mimetype,
});
const refuses = (callback, code, status = 400) => assert.throws(callback, error => error.code === code && error.status === status);

test("UTF-8 Arabic and English text preserve wording, numbers and source checksum", () => {
  const input = file("care.TXT", "\ufeffنص مرجعي ١٢\r\nDose 1.25 mg\rSection 2", "text/plain");
  const original = Buffer.from(input.buffer);
  const result = inspectReferenceFile(input, limits);
  assert.equal(result.text, "نص مرجعي ١٢\nDose 1.25 mg\nSection 2");
  assert.equal(result.bytes, original.length);
  assert.equal(result.sha256, createHash("sha256").update(original).digest("hex"));
  assert.deepEqual(input.buffer, original);
  assert.deepEqual(Object.keys(result), ["filename", "format", "bytes", "sha256", "text"]);
});

test("Markdown retains headings and links as inert text", () => {
  const text = "# القطط\n\n[reference](https://example.invalid/book)\n<script>sample</script>";
  const result = inspectReferenceFile(file("care.md", text, "text/markdown"), limits);
  assert.equal(result.format, "md");
  assert.equal(result.text, text);
});

test("PDF and DOCX preliminary admission never claims readable text or readiness", () => {
  for (const input of [file("care.pdf", "%PDF-1.7\n%fixture only"),
    file("care.docx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))]) {
    const result = inspectReferenceFile(input, limits);
    assert.equal(result.text, null);
    assert.equal(Object.hasOwn(result, "status"), false);
    assert.equal(Object.hasOwn(result, "reviewed"), false);
  }
});

test("renamed image/archive bytes and incompatible MIME types cannot pass admission", () => {
  for (const input of [file("care.pdf", "not a PDF"), file("care.docx", "not a ZIP"),
    file("care.txt", "text", "application/pdf"), file("care.pdf", "%PDF-1.7\n", "image/png"),
    file("care.pdf", "%PDF-1.70\n")]) {
    refuses(() => inspectReferenceFile(input, limits), "reference_format_mismatch");
  }
});

test("actual byte count governs file and text limits instead of supplied size", () => {
  const input = { ...file("care.txt", "a".repeat(1025)), size: 1 };
  refuses(() => inspectReferenceFile(input, limits), "reference_file_too_large", 413);
  refuses(() => inspectReferenceFile(file("care.md", "a".repeat(513)), limits), "reference_text_too_large", 413);
  assert.equal(inspectReferenceFile(file("care.txt", "a".repeat(512)), limits).bytes, 512);
  assert.equal(inspectReferenceFile(file("care.pdf", "%PDF-1.7\n" + "a".repeat(1015)), limits).bytes, 1024);
});

test("invalid UTF-8, UTF-16 and binary control bytes are refused", () => {
  refuses(() => inspectReferenceFile(file("care.txt", Buffer.from([0xc3, 0x28])), limits), "reference_invalid_encoding");
  refuses(() => inspectReferenceFile(file("care.txt", Buffer.from("test", "utf16le")), limits), "reference_invalid_text");
  refuses(() => inspectReferenceFile(file("care.md", "text\u0000data"), limits), "reference_invalid_text");
});

test("empty, whitespace-only and missing files have explicit failures", () => {
  for (const input of [undefined, file("care.txt", ""), { originalname: "care.txt", buffer: "text" }]) {
    refuses(() => inspectReferenceFile(input, limits), "reference_file_required");
  }
  refuses(() => inspectReferenceFile(file("care.txt", "\ufeff \r\n\t"), limits), "reference_no_readable_text");
});

test("unsupported extensions and path-like filenames are refused", () => {
  for (const name of ["care.epub", "care.doc", "care.docm", "care.zip", "care.pdf.exe", "care"]) {
    refuses(() => inspectReferenceFile(file(name, "text"), limits), "reference_unsupported_format");
  }
  for (const name of ["../care.txt", "C:\\care.txt", "care\u0000.txt", "a".repeat(256) + ".txt"]) {
    refuses(() => inspectReferenceFile(file(name, "text"), limits), "reference_invalid_filename");
  }
});

test("missing or invalid processing limits fail closed", () => {
  for (const bounds of [undefined, {}, { ...limits, maxFileBytes: 0 }, { ...limits, maxTextBytes: NaN },
    { ...limits, maxFileBytes: 1.5 }, { ...limits, maxTextBytes: "512" }]) {
    refuses(() => inspectReferenceFile(file("care.txt", "text"), bounds), "reference_configuration_required", 503);
  }
});
