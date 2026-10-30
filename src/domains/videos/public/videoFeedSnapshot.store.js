import { getRedisClient } from "../../../config/redis.js";

export const VIDEO_FEED_IDLE_TTL_MS = 30 * 60 * 1000;
export const VIDEO_FEED_REFRESH_DEBOUNCE_MS = 5000;
const replaceSnapshot = `
local current = redis.call('GET', KEYS[1])
if not current or current == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
else
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
end
return redis.call('GET', KEYS[1])`;

function parseSnapshot(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!Number.isSafeInteger(value.createdAt) || !Array.isArray(value.order) ||
        !value.order.every(key => typeof key === "string" && /^(reel|product):[a-f\d]{24}:[a-f\d]{24}$/.test(key)) ||
        new Set(value.order).size !== value.order.length) return null;
    return value;
  } catch { return null; }
}

export function createVideoFeedSnapshotStore({ client = getRedisClient, now = Date.now } = {}) {
  return Object.freeze({
    async resolve(key, { refresh, build }) {
      let redis;
      let raw;
      try {
        redis = client();
        if (!redis) return null;
        raw = await redis.get(key);
      } catch { return null; }
      const snapshot = parseSnapshot(raw);
      // Build errors are database failures, not Redis failures; preserve their error handling.
      const next = snapshot && (!refresh || now() - snapshot.createdAt < VIDEO_FEED_REFRESH_DEBOUNCE_MS)
        ? snapshot : { createdAt: now(), order: await build() };
      try {
        const winner = await redis.eval(replaceSnapshot, 1, key, raw || "",
          JSON.stringify(next), String(VIDEO_FEED_IDLE_TTL_MS));
        return parseSnapshot(winner);
      } catch { return null; }
    },
  });
}
