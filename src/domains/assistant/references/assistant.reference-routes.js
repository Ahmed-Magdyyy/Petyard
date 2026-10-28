import express from "express";
import multer from "multer";
import { protect, allowedTo } from "../../auth/auth.middleware.js";
import { roles } from "../../../shared/constants/enums.js";
import { AssistantError } from "../shared/assistant.errors.js";
import { loadReferenceConfig, requireReferences } from "./assistant.reference-config.js";
import { referenceService, referenceFailure } from "./assistant.reference-service.js";
import { referenceUploadValidator, referenceIdValidator, referenceListValidator, referenceVersionValidator, referenceEmptyQueryValidator } from "./assistant.reference.validators.js";
import { cairoTimestampReplacer } from "../../../shared/utils/egyptTimezone.js";

export function createReferenceRouter({ authenticate = protect, superAdmin = allowedTo(roles.SUPER_ADMIN),
  getConfig = loadReferenceConfig, application = referenceService } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use(authenticate, superAdmin);
  router.use((req, _res, next) => {
    try { req.referenceConfig = requireReferences(getConfig()); next(); } catch (error) { next(error); }
  });
  const handle = callback => async (req, res, next) => {
    try { await callback(req, res, req.referenceConfig); } catch (error) { next(error); }
  };
  // Convert timestamp fields only; titles and extracted source text remain verbatim.
  const reply = (res, data, status = 200) => res.status(status).type("application/json").send(JSON.stringify({ data }, cairoTimestampReplacer));
  router.get("/metadata", referenceEmptyQueryValidator, handle(async (_req, res, config) => reply(res, {
    available: true, formats: ["pdf", "docx", "md", "txt"], limits: config.limits, activationAvailable: true,
    states: ["processing", "needs_review", "ready", "failed", "disabled"],
  })));
  router.post("/", referenceEmptyQueryValidator, (req, res, next) => {
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: req.referenceConfig.limits.maxFileBytes,
      files: 1, fields: 5, fieldSize: 8192, parts: 6, headerPairs: 100 } }).single("file");
    upload(req, res, error => next(error && !(error instanceof multer.MulterError) ? new AssistantError("invalid_request", 400) : error));
  }, referenceUploadValidator, handle(async (req, res, config) => {
    const result = await application.upload(req.user, req.body, req.file, config);
    reply(res, result, result.duplicate ? 200 : 202);
  }));
  router.get("/", referenceListValidator, handle(async (req, res, config) => reply(res, await application.list(req.user, req.query, config))));
  router.get("/:referenceId", referenceIdValidator, handle(async (req, res, config) => reply(res, await application.get(req.user, req.params.referenceId, config))));
  router.post("/:referenceId/retries", referenceVersionValidator, handle(async (req, res, config) => reply(res, await application.retry(req.user, req.params.referenceId, req.body, config))));
  router.post("/:referenceId/activation", referenceVersionValidator, handle(async (req, res, config) => reply(res, await application.activate(req.user, req.params.referenceId, req.body, config))));
  router.post("/:referenceId/disabling", referenceVersionValidator, handle(async (req, res, config) => reply(res, await application.disable(req.user, req.params.referenceId, req.body, config))));
  router.use(referenceErrorHandler);
  return router;
}

export function referenceErrorHandler(error, _req, res, _next) {
  res.set("Cache-Control", "no-store");
  let status = error instanceof AssistantError ? error.status : error.statusCode === 401 ? 401 : error.statusCode === 403 ? 403 : 503;
  let code = error instanceof AssistantError ? error.code : status === 401 ? "authentication_required" : status === 403 ? "access_denied" : "reference_processing_failed";
  if (error instanceof multer.MulterError) { status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400; code = error.code === "LIMIT_FILE_SIZE" ? "reference_file_too_large" : "invalid_request"; }
  const failure = ["authentication_required", "access_denied", "invalid_request", "invalid_identifier"].includes(code)
    ? { code, message: status === 401 ? "Sign in to manage references." : status === 403 ? "Only SuperAdmins can manage references."
      : "The reference request is invalid.", retryable: false } : referenceFailure({ code });
  res.status(status).json({ status: "error", error: failure });
}
