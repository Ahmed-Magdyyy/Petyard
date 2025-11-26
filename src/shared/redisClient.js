import Redis from "ioredis";

let redisClient = null;
let initialized = false;

export function getRedisClient() {
  if (initialized) {
    return redisClient;
  }

  initialized = true;

  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    console.warn("[Redis] REDIS_URL is not set. Redis caching is disabled.");
    redisClient = null;
    return redisClient;
  }

  const client = new Redis(redisUrl);

  client.on("error", (err) => {
    console.error("[Redis] Error:", err.message);
  });

  client.on("connect", () => {
    console.log("[Redis] Connected");
  });

  redisClient = client;
  return redisClient;
}
