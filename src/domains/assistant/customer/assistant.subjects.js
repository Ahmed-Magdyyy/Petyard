import { randomUUID } from "node:crypto";
import { AssistantMessage } from "../shared/assistant.models.js";
import { expiry } from "../shared/assistant.config.js";
import { reject } from "../shared/assistant.errors.js";
import { subjectFingerprint } from "./assistant.context.js";

function sourcedFact(value, quote, run, config) {
  if (value === "" && quote === "") return null;
  if (!value || value !== value.trim() || value.length > 80 || !quote || quote.length > config.maxMessageChars ||
      !run.input.includes(quote) || !quote.includes(value)) reject("invalid_subject_decision", 503);
  return { value, quote };
}

export function resolveSubjectDecision(data, run, subjects, fingerprints, config) {
  // Urgent guidance is fixed and independent of a model's pet decision. Never wait for another call or persist proposed facts.
  if (data.scope === "urgent") return { kind: "urgent" };
  const action = data.subjectAction;
  const id = data.resolvedSubjectId;
  if (!["keep", "select", "clarify", "create_unsaved", "update_unsaved"].includes(action)) reject("invalid_subject_decision", 503);
  const facts = { name: sourcedFact(data.subjectName, data.subjectNameQuote, run, config),
    species: sourcedFact(data.subjectSpecies, data.subjectSpeciesQuote, run, config) };
  const hasFacts = Boolean(facts.name || facts.species);
  if (["keep", "select", "clarify"].includes(action) && hasFacts) reject("invalid_subject_decision", 503);
  if (action === "clarify") {
    if (id) reject("invalid_subject_decision", 503);
    return { kind: "clarify" };
  }
  if (action === "keep") {
    if (id && id !== run.subjectId) reject("invalid_subject_decision", 503);
    return { kind: "publish" };
  }
  let target;
  if (action === "create_unsaved") {
    if (id) reject("invalid_subject_decision", 503);
  } else {
    target = subjects.find((subject) => subject.id === id);
    if (!target) reject("subject_not_found", 404);
    if (fingerprints[id] !== subjectFingerprint(target)) reject("context_changed", 409);
    if (action === "update_unsaved" && (target.saved || !hasFacts)) reject("invalid_subject_decision", 503);
  }
  if (!["pet_care", "petyard", "health"].includes(data.scope)) reject("invalid_subject_decision", 503);
  const changesSubject = action === "create_unsaved" || id !== run.subjectId;
  const changesFacts = action === "update_unsaved" && (facts.name?.value !== undefined && facts.name.value !== target.name ||
    facts.species?.value !== undefined && facts.species.value !== target.species);
  if (run.subjectExplicit && changesSubject) return { kind: "clarify" };
  if (run.phase === "answer" && (changesSubject || changesFacts)) return { kind: "clarify" };
  if (!changesSubject && !changesFacts) return { kind: "publish" };
  return { kind: "change", targetId: target?.id ?? null, create: action === "create_unsaved", facts };
}

export function subjectClarification(language) {
  if (language === "ar" || language === "arabizi") return "تقصد أنهي حيوان؟ ممكن تقولّي اسمه أو توصفه، حتى لو مش مسجل عندك في بيتيارد.";
  return "Which pet do you mean? You can tell me its name or describe it, even if it has no saved Petyard profile.";
}

export async function bindRunSubject(run, chat, subjectId, session, { awaiting = false } = {}) {
  if (chat.activeSubject !== subjectId || chat.awaitingSubject !== awaiting) chat.contextVersion += 1;
  chat.activeSubject = subjectId;
  chat.awaitingSubject = awaiting;
  run.subjectId = subjectId;
  run.contextVersion = chat.contextVersion;
  await AssistantMessage.updateOne({ owner: run.owner, run: run._id, role: "user" }, { $set: { subjectId } }, { session });
}

export async function applySubjectChange(decision, run, chat, subjects, config, session) {
  const source = await AssistantMessage.findOne({ owner: run.owner, run: run._id, role: "user" }).session(session);
  if (!source || source.text !== run.input) reject("context_changed", 409);
  let subject;
  if (decision.create) {
    if (subjects.length >= config.maxSubjects) reject("subject_limit", 409);
    chat.subjects = chat.subjects.filter((entry) => entry.expiresAt > new Date());
    chat.subjects.push({ id: `chat:${randomUUID()}`, name: null, species: null, expiresAt: expiry(config.memoryDays) });
    subject = chat.subjects.at(-1);
  } else {
    subject = chat.subjects.find((entry) => entry.id === decision.targetId && entry.expiresAt > new Date());
    if (!subject) {
      const saved = subjects.find((entry) => entry.id === decision.targetId && entry.saved);
      if (!saved) reject("subject_not_found", 404);
      await bindRunSubject(run, chat, saved.id, session);
      run.subjectFingerprint = subjectFingerprint(saved);
      await chat.save({ session });
      return;
    }
  }
  for (const field of ["name", "species"]) {
    const fact = decision.facts[field];
    if (!fact) continue;
    subject[field] = fact.value;
    subject[`${field}SourceMessage`] = source._id;
    subject[`${field}SourceQuote`] = fact.quote;
  }
  // Refining an existing anonymous pet changes its facts, never its identity or a saved Pet record.
  chat.contextVersion += 1;
  await bindRunSubject(run, chat, subject.id, session);
  run.subjectFingerprint = subjectFingerprint({ ...subject.toObject(), saved: false });
  await chat.save({ session });
}
