import { validatorMiddleware } from "../../../shared/middlewares/validatorMiddleware.js";
import { AssistantError } from "./assistant.errors.js";

// Keep the assistant's safe error envelope without echoing rejected request values.
export const assistantValidatorMiddleware = (req, res, next) => validatorMiddleware(req, res,
  (error) => next(error ? new AssistantError("invalid_request", 400) : undefined));
