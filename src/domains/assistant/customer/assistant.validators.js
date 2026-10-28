import { body, checkExact, header, param, query } from "express-validator";
import { requireEnabled } from "../shared/assistant.config.js";
import { fields, memoryKeys, subjectId, text } from "../shared/assistant.validation.js";
import { assistantValidatorMiddleware } from "../shared/assistant.validators.js";
import { bookingContextInput } from "./assistant.booking-context.js";

const identifier = (chain) => chain.isString().bail().isMongoId();
const validSubject = (value, allowUser = false, allowNull = true) => {
  const selected = subjectId(value, { allowUser });
  return allowNull || selected !== null;
};
const integerQuery = (value, maximum) => typeof value === "string" &&
  Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= maximum;

// Route checks do not sanitize values; internal callers still use the domain validators.
export function customerAssistantValidators(getConfig) {
  const enabled = (_req, _res, next) => {
    try { requireEnabled(getConfig()); next(); } catch (error) { next(error); }
  };
  const exactBody = (allowed, chains) => [enabled, body().custom((value) => Boolean(fields(value, allowed))),
    ...chains, assistantValidatorMiddleware];
  const routeId = (name) => [enabled, identifier(param(name)), assistantValidatorMiddleware];
  return {
    message: [enabled, body().custom((value) => Boolean(fields(value, ["text", "subjectId", "catalogContext", "bookingContext"]))),
      body("text").custom((value) => Boolean(text(value, getConfig().maxMessageChars))),
      body("subjectId").optional().custom((value) => validSubject(value)),
      body("bookingContext").optional().custom(value => Boolean(bookingContextInput(value))),
      body("catalogContext").optional().custom((value) => Boolean(fields(value, ["warehouseId", "language"]))),
      body("catalogContext.warehouseId").if(body("catalogContext").exists()).custom((value) => value === null ||
        (typeof value === "string" && /^[a-f\d]{24}$/i.test(value))),
      body("catalogContext.language").if(body("catalogContext").exists()).isString().bail().isIn(["en", "ar"]),
      header("Idempotency-Key").isString().bail().matches(/^[a-zA-Z0-9._:-]{8,128}$/), assistantValidatorMiddleware],
    history: [enabled, checkExact([
      query("before").optional().custom((value) => integerQuery(value, Number.MAX_SAFE_INTEGER)),
      query("limit").optional().custom((value) => integerQuery(value, 100)),
    ], { locations: ["query"] }), assistantValidatorMiddleware],
    run: routeId("runId"),
    subject: exactBody(["subjectId"], [body("subjectId").custom((value) => validSubject(value))]),
    createSubject: exactBody(["name", "species"], [
      body("name").optional({ values: "null" }).custom((value) => Boolean(text(value, 80))),
      body("species").optional({ values: "null" }).custom((value) => Boolean(text(value, 80))),
    ]),
    memory: exactBody(["subjectId", "key", "value"], [
      body("subjectId").custom((value) => validSubject(value, true, false)),
      body("key").isString().bail().isIn(memoryKeys),
      body("value").custom((value) => Boolean(text(value, getConfig().memoryValueChars))),
    ]),
    forgetMemory: routeId("memoryId"),
    warnings: [enabled, checkExact([
      query("subjectId").optional().custom((value) => validSubject(value, false, false)),
      identifier(query("before").optional()),
      query("limit").optional().custom((value) => typeof value === "string" && /^\d+$/.test(value) && integerQuery(value, 100)),
    ], { locations: ["query"] }), assistantValidatorMiddleware],
    editWarning: exactBody(["expectedVersion", "text"], [identifier(param("warningId")),
      body("expectedVersion").custom((value) => Number.isSafeInteger(value) && value >= 1 && value < Number.MAX_SAFE_INTEGER),
      body("text").custom((value) => Boolean(text(value, 500))),
    ]),
    removeWarning: exactBody(["expectedVersion"], [identifier(param("warningId")),
      body("expectedVersion").custom((value) => Number.isSafeInteger(value) && value >= 1 && value < Number.MAX_SAFE_INTEGER),
    ]),
  };
}
