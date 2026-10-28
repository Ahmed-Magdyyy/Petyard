import { randomUUID } from "node:crypto";
import { reject } from "./assistant.errors.js";
import { customerRunFilter, isCustomerRun } from "./assistant.purpose.js";

export const REFERENCE_FLOW_VERSION = "focused-v1";
export const isFocusedReferenceRun = run => isCustomerRun(run) && run.referenceFlowVersion === REFERENCE_FLOW_VERSION;

// Admission version is durable financial history; it must not depend on today's prompt version.
export function validAttemptSequence(run, attempts = run.attempts) {
  if (!isFocusedReferenceRun(run)) return attempts.length <= 2 && !attempts.some(attempt => attempt.phase === "normalize");
  return ["", "resolve", "resolve,answer", "resolve,normalize", "resolve,normalize,answer"]
    .includes(attempts.map(attempt => attempt.phase).join(","));
}

export function queuedWorkFilter(id, snapshot) {
  return customerRunFilter({ _id: id, status: "queued", phase: snapshot.phase, generation: snapshot.generation, contextVersion: snapshot.contextVersion,
    referenceFlowVersion: snapshot.referenceFlowVersion ?? { $exists: false } });
}

export function beginAttempt(run, reservation, now = new Date()) {
  if (!isCustomerRun(run)) reject("run_not_found", 404);
  if (!validAttemptSequence(run, [...run.attempts, { phase: run.phase }]) ||
      (!isFocusedReferenceRun(run) && run.attempts.length && run.phase !== "answer")) reject("assistant_attempt_limit", 503);
  if (run.attempts.some((attempt) => attempt.accounting === "reserved")) reject("request_needs_review", 409);
  if (isFocusedReferenceRun(run) && run.attempts.some(attempt => attempt.accounting !== "settled")) reject("request_needs_review", 409);
  run.attempt = randomUUID();
  run.reservation = reservation;
  run.accounting = "reserved";
  run.chargedMicroUsd = null;
  run.usage = null;
  run.providerRequestId = null;
  run.latencyMs = null;
  run.internalCode = null;
  run.attempts.push({ id: run.attempt, number: run.attempts.length + 1, phase: run.phase, subjectId: run.subjectId,
    contextVersion: run.contextVersion, subjectFingerprint: run.subjectFingerprint, reservation,
    accounting: "reserved", dispatchedAt: now });
}

export function recordAttempt(run, now = new Date()) {
  const attempt = run.attempts.find((entry) => entry.id === run.attempt);
  if (!attempt) reject("assistant_accounting_unavailable", 503);
  for (const key of ["accounting", "usage", "chargedMicroUsd", "providerRequestId", "latencyMs", "internalCode"]) attempt[key] = run[key];
  if (run.accounting !== "reserved") attempt.settledAt = now;
}

export function queueAnswer(run, phase = "answer") {
  if (!isCustomerRun(run)) reject("run_not_found", 404);
  const fromResolve = run.phase === "resolve" && run.attempts.length === 1 &&
    (phase === "answer" || phase === "normalize" && isFocusedReferenceRun(run));
  const fromNormalize = run.phase === "normalize" && phase === "answer" && isFocusedReferenceRun(run) && run.attempts.length === 2;
  const skipNormalize = run.phase === "normalize" && phase === "answer" && isFocusedReferenceRun(run) && run.attempts.length === 1 &&
    run.status === "queued" && run.accounting === "none" && run.attempts[0].accounting === "settled";
  if ((!fromResolve && !fromNormalize && !skipNormalize) || !skipNormalize && run.accounting !== "settled" || !validAttemptSequence(run)) reject("assistant_attempt_limit", 503);
  run.phase = phase;
  run.generation = (run.generation ?? 0) + 1;
  run.status = "queued";
  run.attempt = null;
  run.reservation = null;
  run.accounting = "none";
  run.usage = null;
  run.chargedMicroUsd = null;
  run.providerRequestId = null;
  run.latencyMs = null;
  run.dispatchDeadline = null;
  run.publicCode = null;
  run.retryAt = null;
  run.internalCode = null;
}
