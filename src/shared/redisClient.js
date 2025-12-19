import Redis from "ioredis";

let redisClient = null;
let initialized = false;

export function getRedisClient() {
  if (initialized) {
    if (
      redisClient &&
      (redisClient.status === "end" || redisClient.status === "close")
    ) {
      try {
        redisClient.disconnect();
      } catch {}
      redisClient = null;
      initialized = false;
    } else {
      return redisClient;
    }
  }

  initialized = true;

  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    console.warn("[Redis] REDIS_URL is not set. Redis caching is disabled.");
    redisClient = null;
    return redisClient;
  }

  const client = new Redis(redisUrl, {
    // Do not keep retrying forever if Redis is down; fail fast so requests
    // can fall back to MongoDB without hanging.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });

  client.on("error", (err) => {
    console.error("[Redis] Error:", err.message);
  });

  client.on("connect", () => {
    console.log("[Redis] Connected");
  });

  redisClient = client;
  return redisClient;
}
