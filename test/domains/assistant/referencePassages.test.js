import test from "node:test";
import assert from "node:assert/strict";
import { prepareReferencePassages, referencePassageVersion } from "../../../src/domains/assistant/references/assistant.reference-passages.js";
import { validateKnowledge, knowledgeBounds } from "../../../src/domains/assistant/customer/assistant.knowledge.js";

const reference = { _id: "111111111111111111111111", sha256: "a".repeat(64), title: "Fictional reference", species: ["cat", "dog"] };
const limits = { maxTextBytes: 100000, maxPages: 30 };
const extraction = units => ({ sha256: reference.sha256, units, warnings: [] });
const prepare = units => prepareReferencePassages(reference, extraction(units), limits);

test("prepared passages preserve source identity, locations and literal text without granting approval", () => {
  const result = prepare([{ locator: "PDF page 20", text: "A fictional case. Quantity: 1.25 mg." }]);
  assert.equal(result.version, referencePassageVersion);
  assert.equal(result.sourceId, reference._id); assert.equal(result.sourceVersion, reference.sha256);
  assert.deepEqual(result.species, ["cat", "dog"]); assert.equal(result.speciesScope, "source_declared");
  assert.equal(result.passages[0].locator, "PDF page 20, excerpt 1");
  assert.equal(result.passages[0].text, "A fictional case. Quantity: 1.25 mg.");
  assert.equal(Object.hasOwn(result, "reviewed"), false); assert.equal(Object.hasOwn(result.passages[0], "reviewed"), false);
  assert.equal(Object.hasOwn(result.passages[0], "species"), false);
});

test("English, Arabic and emoji split within UTF-8 evidence bounds with no lost text or broken surrogate pairs", () => {
  const text = "عنوان مرجع تجريبي 🐈\n\nDo not change 1.25 mg. لا تغيّر الأرقام أو الكلمات. ".repeat(100);
  const result = prepare([{ locator: "Document text", text }]);
  assert.ok(result.passages.length > 1);
  let coveredUntil = 0;
  for (const passage of result.passages) {
    assert.ok(Buffer.byteLength(passage.text) <= knowledgeBounds.excerptBytes);
    assert.equal(passage.text.isWellFormed(), true);
    assert.equal(passage.text, text.slice(passage.startOffset, passage.endOffset));
    assert.ok(passage.startOffset <= coveredUntil);
    assert.ok(passage.endOffset > coveredUntil);
    coveredUntil = passage.endOffset;
  }
  assert.equal(coveredUntil, text.length);
  assert.equal(result.warnings[0].code, "reference_passage_context_review_required");
});

test("paragraph boundaries and neighbouring IDs preserve context without mixing source units", () => {
  const first = "A".repeat(1300) + "\n\n" + "B".repeat(1000);
  const result = prepare([{ locator: "PDF page 1", text: first }, { locator: "PDF page 2", text: "Separate case on another page" }]);
  assert.ok(result.passages[0].text.endsWith("\n\n"));
  assert.equal(result.passages[0].previousId, null);
  assert.equal(result.passages.at(-1).nextId, null);
  for (let index = 0; index < result.passages.length - 1; index++) {
    assert.equal(result.passages[index].nextId, result.passages[index + 1].id);
    assert.equal(result.passages[index + 1].previousId, result.passages[index].id);
  }
  assert.ok(result.passages.filter(passage => passage.unitIndex === 0).every(passage => !passage.text.includes("Separate case")));
  assert.equal(result.passages.at(-1).unitIndex, 1);
});

test("IDs are deterministic and bind source version, extraction text and preparation offsets", () => {
  const units = [{ locator: "Document text", text: "Fictional text" }];
  assert.deepEqual(prepare(units), prepare(units));
  assert.notEqual(prepare(units).passages[0].id, prepare([{ locator: "Document text", text: "Corrected text" }]).passages[0].id);
  assert.notEqual(prepare(units).passages[0].id, prepare([{ locator: "Corrected location", text: "Fictional text" }]).passages[0].id);
  const next = { ...reference, sha256: "b".repeat(64) };
  assert.notEqual(prepare(units).passages[0].id,
    prepareReferencePassages(next, { sha256: next.sha256, units }, limits).passages[0].id);
});

test("exact-size text stays whole and longer text uses bounded overlap", () => {
  assert.equal(prepare([{ locator: "Document text", text: "a".repeat(2000) }]).passages.length, 1);
  const passages = prepare([{ locator: "Document text", text: "a".repeat(2001) }]).passages;
  assert.equal(passages.length, 2); assert.equal(passages[0].endOffset - passages[1].startOffset, 200);
});

test("empty pages are skipped but original unit indexes and page locators are retained", () => {
  const result = prepare([{ locator: "PDF page 1", text: "" }, { locator: "PDF page 2", text: "Readable text" }]);
  assert.equal(result.passages[0].unitIndex, 1);
  assert.equal(result.passages[0].locator, "PDF page 2, excerpt 1");
  assert.throws(() => prepare([{ locator: "Document text", text: " \n " }]), { code: "reference_no_readable_text" });
});

test("invalid source identities, malformed text, source mismatch and excessive input are refused", () => {
  for (const source of [{ ...reference, _id: "foreign" }, { ...reference, species: [] }, { ...reference, title: "" }]) {
    assert.throws(() => prepareReferencePassages(source, extraction([{ locator: "Text", text: "text" }]), limits), { code: "reference_preparation_invalid" });
  }
  assert.throws(() => prepareReferencePassages(reference, { sha256: "c".repeat(64), units: [] }, limits), { code: "reference_preparation_invalid" });
  for (const text of ["x\u0000y", "\ud800"]) assert.throws(() => prepare([{ locator: "Text", text }]), { code: "reference_preparation_invalid" });
  assert.throws(() => prepare([{ locator: "Same page", text: "A" }, { locator: "Same page", text: "B" }]),
    { code: "reference_preparation_invalid" });
  assert.throws(() => prepareReferencePassages(reference, extraction([{ locator: "Text", text: "a".repeat(100) }]),
    { ...limits, maxTextBytes: 99 }), { code: "reference_text_too_large" });
  assert.throws(() => prepareReferencePassages(reference, extraction([{ locator: "Text", text: "a" }]),
    { ...limits, maxPages: 0 }), { code: "reference_configuration_required" });
});

test("passage count has a hard bound before creating an oversized index input", () => {
  const units = Array.from({ length: 10001 }, (_, index) => ({ locator: `Unit ${index}`, text: "x" }));
  assert.throws(() => prepareReferencePassages(reference, extraction(units), { maxTextBytes: 20000, maxPages: 20000 }),
    { code: "reference_too_many_passages" });
});

test("future reviewed adapter can map distinct excerpts into the unchanged bounded knowledge contract", () => {
  const result = prepare([{ locator: "PDF page 20", text: "Fictional evidence. ".repeat(400) }]);
  // reviewed:true is a synthetic validator fixture, not an approval performed by passage preparation.
  const payload = result.passages.slice(0, 3).map(passage => ({ sourceId: result.sourceId, version: result.sourceVersion,
    title: result.title, locator: passage.locator, excerpt: passage.text, reviewed: true, species: result.species }));
  assert.deepEqual(validateKnowledge(payload, { species: "cat" }), payload);
  assert.throws(() => validateKnowledge(payload.map(passage => ({ ...passage, reviewed: false })), { species: "cat" }),
    { code: "invalid_reviewed_knowledge" });
});
