import { ApiError } from "../../shared/utils/ApiError.js";

export class UiLayoutError extends ApiError {
  constructor(code, message, statusCode, details = []) {
    super(message, statusCode, Array.isArray(details) ? details : [details]);
    this.code = code;
    this.details = details;
  }
}
