import { videoPlaybackErrorReasonEnum } from "../../../shared/constants/enums.js";
import { ApiError } from "../../../shared/utils/ApiError.js";

export function validatePlayerError(id, body) {
  if (typeof id !== "string" || !/^[a-f\d]{24}$/i.test(id) ||
      !body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["youtubeId", "reason"].includes(key)) ||
      typeof body.youtubeId !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(body.youtubeId) ||
      ![videoPlaybackErrorReasonEnum.UNAVAILABLE, videoPlaybackErrorReasonEnum.EMBEDDING_DISABLED].includes(body.reason)) {
    throw new ApiError("Invalid player error report", 422, [{ code: "VIDEO_INVALID_PLAYER_ERROR" }]);
  }
  return { id: id.toLowerCase(), youtubeId: body.youtubeId, reason: body.reason };
}
