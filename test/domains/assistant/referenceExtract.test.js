import test from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateRawSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { extractReferenceFile } from "../../../src/domains/assistant/references/assistant.reference-extract.js";

const limits = { maxFileBytes: 1024 * 1024, maxTextBytes: 32 * 1024, maxPages: 10,
  maxArchiveEntries: 20, maxExpandedBytes: 64 * 1024, timeoutMs: 15_000 };
const file = (originalname, buffer) => ({ originalname, buffer });
const refuses = (promise, code, status = 400) => assert.rejects(promise, error => error.code === code && error.status === status);

function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const path = Buffer.from(name), data = Buffer.from(text), compressed = deflateRawSync(data);
    const header = Buffer.alloc(30), record = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(data), 14); header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22); header.writeUInt16LE(path.length, 26);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc32(data), 16); record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(data.length, 24); record.writeUInt16LE(path.length, 28); record.writeUInt32LE(offset, 42);
    local.push(header, path, compressed); central.push(record, path);
    offset += header.length + path.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function docx(text = "مرجع للقطط – رقم ١٢ / 1.25 mg", extras = []) {
  return zip([
    ["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ["_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ["word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`],
    ...extras,
  ]);
}

function pdf(texts = ["Fictional care reference 1.25 mg"], labels = "") {
  const objects = [`<< /Type /Catalog /Pages 2 0 R ${labels} >>`, `<< /Type /Pages /Kids [${texts.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${texts.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (let i = 0; i < texts.length; i++) {
    const stream = texts[i] ? `BT /F1 12 Tf 50 700 Td (${texts[i]}) Tj ET` : "";
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(source)); source += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const start = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(source);
}

test("all four formats use actual extraction and never return reviewed/ready state", async () => {
  for (const input of [file("care.pdf", pdf()), file("care.docx", docx()), file("care.md", Buffer.from("# القطط\nمرجع")),
    file("care.txt", Buffer.from("Plain reference"))]) {
    const result = await extractReferenceFile(input, limits);
    assert.ok(result.units.some(unit => unit.text.trim()));
    assert.equal(Object.hasOwn(result, "status"), false);
    assert.equal(Object.hasOwn(result, "reviewed"), false);
    assert.equal(result.sha256.length, 64);
  }
});

test("DOCX preserves Arabic and quantities; extraction returns text rather than executable HTML", async () => {
  const result = await extractReferenceFile(file("care.docx", docx()), limits);
  assert.match(result.units[0].text, /مرجع للقطط – رقم ١٢ \/ 1\.25 mg/u);
  assert.ok(result.warnings.some(warning => warning.code === "reference_layout_review_required"));
  assert.equal(Object.hasOwn(result, "html"), false);
});

test("PDF preserves numeric wording, PDF page locations and blank-page warning", async () => {
  const result = await extractReferenceFile(file("care.pdf", pdf(["Reference 1.25 mg", "", "Second case 7 kg"])), limits);
  assert.equal(result.units.length, 3);
  assert.match(result.units[0].text, /Reference 1\.25 mg/);
  assert.equal(result.units[2].page, 3);
  assert.equal(result.units[2].locator, "PDF page 3");
  assert.match(result.units[2].text, /Second case 7 kg/);
  assert.deepEqual(result.warnings.find(warning => warning.code === "reference_pages_without_text"),
    { code: "reference_pages_without_text", count: 1 });
});

test("image-only/empty PDF and empty DOCX refuse searchable readiness", async () => {
  await refuses(extractReferenceFile(file("care.pdf", pdf([""])), limits), "reference_no_readable_text");
  await refuses(extractReferenceFile(file("care.docx", docx("")), limits), "reference_no_readable_text");
});

test("embedded PDF labels remain unverified metadata, separate from the stable page locator", async () => {
  const result = await extractReferenceFile(file("care.pdf", pdf(["Printed page 1"], "/PageLabels << /Nums [0 << /S /r >>] >>")), limits);
  assert.equal(result.units[0].locator, "PDF page 1");
  assert.equal(result.units[0].pageLabel, "i");
  assert.equal(Object.hasOwn(result.units[0], "printedPage"), false);
  assert.ok(result.warnings.some(warning => warning.code === "reference_page_labels_unverified"));
});

test("encrypted PDF returns an actionable password-protection error", async () => {
  const buffer = await readFile(new URL("./fixtures/reference-password.pdf", import.meta.url));
  await refuses(extractReferenceFile(file("care.pdf", buffer), limits), "reference_password_protected");
});

test("oversized PDF metadata labels do not become unbounded manifest fields", async () => {
  const labels = `/PageLabels << /Nums [0 << /P (${"x".repeat(1000)}) >>] >>`;
  const result = await extractReferenceFile(file("care.pdf", pdf(["Fictional text"], labels)), limits);
  assert.equal(result.units[0].pageLabel, null);
  assert.equal(result.units[0].locator, "PDF page 1");
});

test("a PDF header or ZIP signature alone is insufficient", async () => {
  await refuses(extractReferenceFile(file("care.pdf", Buffer.from("%PDF-1.7\nnot valid")), limits), "reference_invalid_document");
  await refuses(extractReferenceFile(file("care.docx", Buffer.from([0x50, 0x4b, 0x03, 0x04])), limits), "reference_invalid_document");
  await refuses(extractReferenceFile(file("care.docx", zip([["word/document.xml", "incomplete archive"]])), limits), "reference_invalid_document");
});

test("PDF page count and extracted text caps are enforced", async () => {
  await refuses(extractReferenceFile(file("care.pdf", pdf(["A", "B"])), { ...limits, maxPages: 1 }), "reference_too_many_pages", 413);
  await refuses(extractReferenceFile(file("care.pdf", pdf()), { ...limits, maxTextBytes: 5 }), "reference_text_too_large", 413);
  await refuses(extractReferenceFile(file("care.docx", docx()), { ...limits, maxTextBytes: 5 }), "reference_text_too_large", 413);
});

test("DOCX expansion and archive-entry bounds are checked before XML extraction", async () => {
  const input = file("care.docx", docx("A".repeat(8000)));
  await refuses(extractReferenceFile(input, { ...limits, maxExpandedBytes: 2000 }), "reference_archive_too_large", 413);
  await refuses(extractReferenceFile(input, { ...limits, maxArchiveEntries: 2 }), "reference_archive_too_large", 413);
  const lying = docx("A".repeat(8000));
  let index = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (lying.subarray(index + 46, index + 63).toString() !== "word/document.xml") {
    index += 46 + lying.readUInt16LE(index + 28) + lying.readUInt16LE(index + 30) + lying.readUInt16LE(index + 32);
  }
  lying.writeUInt32LE(10, index + 24);
  await refuses(extractReferenceFile(file("care.docx", lying), limits), "reference_archive_too_large", 413);
});

test("DOCX macros, XML entities, duplicate entries and path traversal are refused", async () => {
  for (const extra of [["word/vbaProject.bin", "macro"], ["word/custom.xml", '<!DOCTYPE test [<!ENTITY x "data">]><test/>']]) {
    await refuses(extractReferenceFile(file("care.docx", docx("text", [extra])), limits), "reference_unsupported_content");
  }
  for (const extra of [["../escape.xml", "text"], ["word/document.xml", "duplicate"]]) {
    await refuses(extractReferenceFile(file("care.docx", docx("text", [extra])), limits), "reference_invalid_document");
  }
});

test("cancellation and timeout terminate real parser workers", async () => {
  const aborted = new AbortController(); aborted.abort();
  await refuses(extractReferenceFile(file("care.pdf", pdf()), limits, { signal: aborted.signal }), "reference_processing_cancelled", 409);
  const active = new AbortController();
  const work = extractReferenceFile(file("care.pdf", pdf()), limits, { signal: active.signal });
  active.abort();
  await refuses(work, "reference_processing_cancelled", 409);
  await refuses(extractReferenceFile(file("care.pdf", pdf()), { ...limits, timeoutMs: 1 }), "reference_processing_timeout", 504);
});

test("extraction requires explicit valid parser limits", async () => {
  for (const bounds of [{ ...limits, maxPages: 0 }, { ...limits, maxExpandedBytes: undefined },
    { ...limits, maxArchiveEntries: 1.5 }, { ...limits, timeoutMs: 60_001 }]) {
    await refuses(extractReferenceFile(file("care.docx", docx()), bounds), "reference_configuration_required", 503);
  }
});
