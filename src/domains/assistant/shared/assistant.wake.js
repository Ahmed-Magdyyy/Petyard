import Redis from "ioredis";
import { getRedisClient } from "../../../config/redis.js";

const signal = "1";

export function assistantWakeChannel(env = process.env) {
  const prefix = env.BULLMQ_QUEUE_PREFIX;
  if (env.ASSISTANT_REDIS_WAKE_ENABLED === "false" || !env.REDIS_URL || !/^[a-zA-Z0-9:_-]{1,100}$/.test(prefix ?? "")) return null;
  return `${prefix}:assistant:queued`;
}

let publishPending = false;
export function signalAssistantWake() {
  const channel = assistantWakeChannel();
  if (!channel || publishPending) return;
  try {
    const redis = getRedisClient();
    if (redis?.status !== "ready") return;
    publishPending = true;
    void redis.publish(channel, signal).catch(() => {}).finally(() => { publishPending = false; });
  } catch { publishPending = false; }
}

export function subscribeAssistantWake(onWake, env = process.env) {
  const channel = assistantWakeChannel(env);
  if (!channel) return null;
  try {
    const client = new Redis(env.REDIS_URL, {
      connectionName: channel, enableOfflineQueue: false, maxRetriesPerRequest: 1,
      autoResubscribe: false, commandTimeout: 1000, retryStrategy: attempts => Math.min(500 * attempts, 5000),
    });
    client.on("error", () => {}); // The MongoDB poll remains available.
    client.on("ready", () => { void client.subscribe(channel).catch(() => {}); });
    client.on("message", (received, payload) => {
      if (received === channel && payload === signal) onWake();
    });
    return client;
  } catch { return null; }
}

export function createAssistantWake() {
  let pending = false;
  let finish;
  return {
    signal() {
      if (finish) finish("redis");
      else pending = true;
    },
    wait(delay) {
      if (pending) {
        pending = false;
        return Promise.resolve("redis");
      }
      return new Promise(resolve => {
        const timer = setTimeout(() => finish("poll"), delay);
        finish = reason => {
          clearTimeout(timer);
          finish = undefined;
          resolve(reason);
        };
      });
    },
    stop() { finish?.("shutdown"); },
  };
}
