import { getRedisClient } from "../../config/redis.js";

/**
 * Get a cached value from Redis if available, otherwise run `fetchFn`,
 * cache its result, and return it.
 *
 * - If Redis is not configured or is down, this will just call `fetchFn`.
 * - Values are stored as JSON strings.
 *
 * @param {string} key Redis key
 * @param {number} ttlSeconds Time to live in seconds
 * @param {() => Promise<any>} fetchFn Async function that fetches fresh data
 */
export async function getOrSetCache(key, ttlSeconds, fetchFn) {
  const redisClient = getRedisClient();
  if (!redisClient) {
    return fetchFn();
  }

  try {
    const cached = await redisClient.get(key);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (err) {
    console.error("[Redis] GET error for key", key, err.message);
    // Fall through to fetch fresh data
  }

  const fresh = await fetchFn();

  try {
    await redisClient.set(key, JSON.stringify(fresh), "EX", ttlSeconds);
  } catch (err) {
    console.error("[Redis] SET error for key", key, err.message);
    // Ignore cache write errors, return fresh data
  }

  return fresh;
}

export function isRedisEnabled() {
  return !!getRedisClient();
}

export async function getCacheString(key) {
  const redisClient = getRedisClient();
  if (!redisClient) {
    return null;
  }

  try {
    const cached = await redisClient.get(key);
    return cached || null;
  } catch (err) {
    console.error("[Redis] GET error for key", key, err.message);
    return null;
  }
}

export async function incrCacheKey(key) {
  const redisClient = getRedisClient();
  if (!redisClient) {
    return null;
  }

  try {
    return await redisClient.incr(key);
  } catch (err) {
    console.error("[Redis] INCR error for key", key, err.message);
    return null;
  }
}

export async function deleteCacheKey(key) {
  const redisClient = getRedisClient();
  if (!redisClient) {
    return;
  }

  try {
    await redisClient.del(key);
  } catch (err) {
    console.error("[Redis] DEL error for key", key, err.message);
  }
}
