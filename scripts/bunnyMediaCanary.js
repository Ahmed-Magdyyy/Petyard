import "@dotenvx/dotenvx/config";
import crypto from "crypto";
import process from "process";
import { pathToFileURL } from "url";
import sharp from "sharp";
import { buildBunnyCdnUrl, deleteBunnyObject, downloadBunnyObject, uploadBunnyObject } from "../src/shared/utils/bunnyStorage.js";
import { getPrivateImageDeliveryUrl } from "../src/shared/utils/privateImageDelivery.js";

const WRITE_CONFIRMATION = "--confirm-bunny-canary-write-and-delete";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

export function parseCanaryArguments(argv = process.argv.slice(2)) {
  const isPublic = argv.includes("--public"); const isPrivate = argv.includes("--private");
  if (isPublic === isPrivate) throw new Error("Choose exactly one of --public or --private");
  return { classification: isPublic ? "public" : "private", write: argv.includes(WRITE_CONFIRMATION) };
}

export function canaryConfiguration(env, classification) {
  const prefix = classification === "private" ? "BUNNY_PRIVATE" : "BUNNY_PUBLIC";
  const zone = env[`${prefix}_STORAGE_ZONE`]; const accessKey = env[`${prefix}_STORAGE_ACCESS_KEY`]; const cdnBaseUrl = env[`${prefix}_CDN_BASE_URL`]; const endpoint = env[`${prefix}_STORAGE_ENDPOINT`];
  if (![zone, accessKey, endpoint, cdnBaseUrl].every((value) => typeof value === "string" && value.trim())) throw new Error(`${prefix} Bunny configuration is incomplete`);
  if (classification === "private" && !env.BUNNY_PRIVATE_TOKEN_KEY) throw new Error("Private canary requires configured token signing key");
  return { zone, accessKey, cdnBaseUrl, endpoint, root: classification === "private" ? "instapay_screenshots" : "petyard" };
}

export async function createCanaryImage() { return sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 23, g: 80, b: 160, alpha: 1 } } }).png().toBuffer(); }

export async function runCanary({ classification, write, env = process.env, transport, fetchImpl = fetch } = {}) {
  const config = canaryConfiguration(env, classification); const objectKey = `${config.root}/migration-canary/petyard-canary.png`; const url = buildBunnyCdnUrl({ cdnBaseUrl: config.cdnBaseUrl, objectKey });
  if (!write) return { mode: "plan", classification, objectKey, url };
  const image = await createCanaryImage(); let uploaded = false;
  try {
    try {
      await downloadBunnyObject({ ...config, objectKey, transport });
      throw new Error("Canary object already exists; refusing to overwrite it");
    } catch (error) {
      if (error?.statusCode !== 404) throw error;
    }
    await uploadBunnyObject({ ...config, objectKey, buffer: image, contentType: "image/png", transport }); uploaded = true;
    const stored = await downloadBunnyObject({ ...config, objectKey, transport }); if (sha256(stored) !== sha256(image)) throw new Error("Canary storage hash mismatch");
    if (classification === "public") { const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000) }); if (response.status !== 200) throw new Error("Public canary CDN verification failed"); }
    else {
      const unsigned = await fetchImpl(url, { signal: AbortSignal.timeout(15000) }); if (![401, 403].includes(unsigned.status)) throw new Error("Private canary unsigned denial verification failed");
      const signed = getPrivateImageDeliveryUrl(url, { signingKey: env.BUNNY_PRIVATE_TOKEN_KEY, config: { private: { cdnBaseUrl: config.cdnBaseUrl }, privateUrlTtlSeconds: 300 } });
      const signedResponse = await fetchImpl(signed, { signal: AbortSignal.timeout(15000) }); if (signedResponse.status !== 200) throw new Error("Private canary signed URL was rejected");
      const expired = getPrivateImageDeliveryUrl(url, { now: Date.now() - 600000, signingKey: env.BUNNY_PRIVATE_TOKEN_KEY, config: { private: { cdnBaseUrl: config.cdnBaseUrl }, privateUrlTtlSeconds: 1 } });
      if (![401, 403].includes((await fetchImpl(expired, { signal: AbortSignal.timeout(15000) })).status)) throw new Error("Private canary expired denial verification failed");
    }
    return { mode: "write-delete", classification, objectKey, status: "verified" };
  } finally {
    if (uploaded) { await deleteBunnyObject({ ...config, objectKey, transport }); try { await downloadBunnyObject({ ...config, objectKey, transport }); throw new Error("Canary cleanup verification failed"); } catch (error) { if (error?.statusCode !== 404) throw error; } }
  }
}

export async function main(argv = process.argv.slice(2)) { const options = parseCanaryArguments(argv); const result = await runCanary(options); console.log(JSON.stringify({ ...result, signedUrl: undefined }, null, 2)); return result; }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
