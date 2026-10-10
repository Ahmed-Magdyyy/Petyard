import { ApiError } from "../../../shared/utils/ApiError.js";

function youtubeError(message, statusCode, code) {
  return new ApiError(message, statusCode, [{ code }]);
}

export function createYouTubeVerifier({ apiKey, request = fetch, timeoutMs = 5000 } = {}) {
  return async function verifyYouTube(videoId) {
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      throw youtubeError("YouTube verification is not configured", 503, "VIDEO_YOUTUBE_CHECK_UNAVAILABLE");
    }
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || "")) {
      throw youtubeError("Invalid YouTube Video", 422, "VIDEO_INVALID_YOUTUBE_URL");
    }
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,status,liveStreamingDetails");
    url.searchParams.set("id", videoId);
    let response;
    let body;
    try {
      response = await request(url, {
        headers: { "X-Goog-Api-Key": apiKey },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw youtubeError("YouTube verification is unavailable", 503, "VIDEO_YOUTUBE_CHECK_UNAVAILABLE");
      }
      body = await response.json();
    } catch {
      throw youtubeError("YouTube verification is unavailable", 503, "VIDEO_YOUTUBE_CHECK_UNAVAILABLE");
    }
    const items = body?.items;
    const video = Array.isArray(items) && items.length === 1 ? items[0] : null;
    if (!video || video.id !== videoId || video.status?.privacyStatus !== "public" ||
        video.status?.embeddable !== true || video.status?.uploadStatus !== "processed" ||
        video.snippet?.liveBroadcastContent !== "none" || video.liveStreamingDetails) {
      throw youtubeError("YouTube Video is not publicly embeddable", 422, "VIDEO_YOUTUBE_UNAVAILABLE");
    }
    return { youtubeId: videoId };
  };
}
