import assert from "node:assert/strict";
import test from "node:test";

import {
  BunnyStreamProviderError,
  createBunnyStreamAdapter,
} from "../../../../src/domains/videos/provider/bunnyStreamAdapter.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function createAdapter(http, overrides = {}) {
  return createBunnyStreamAdapter({
    libraryId: "754739",
    apiKey: "stream-api-key",
    cdnHostname: "vz-75c6f60b-a70.b-cdn.net",
    tokenKey: "cdn-token-key",
    requestTimeoutMs: 20,
    now: () => 1_699_999_500_000,
    http,
    ...overrides,
  });
}

test("orphan search accepts exact Product and Reel recovery markers without broadening arbitrary search", async () => {
  const requests = [];
  const adapter = createAdapter(async (url, options) => {
    requests.push({ url, options });
    return jsonResponse(200, { items: [], totalItems: 0, currentPage: 1 });
  });
  const id = "507f1f77bcf86cd799439012";
  await adapter.searchReelReservation({ providerTitle: `petyard-reel-recovery:${id}` });
  await adapter.searchProductReservation({ providerTitle: `petyard-product-recovery:${id}` });
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[0].url).searchParams.get("search"), `petyard-reel-recovery:${id}`);
  assert.equal(new URL(requests[1].url).searchParams.get("search"), `petyard-product-recovery:${id}`);
  assert.throws(() => adapter.searchReelReservation({ providerTitle: "petyard-reel-recovery:guess" }), TypeError);
  assert.throws(() => adapter.searchProductReservation({ providerTitle: `petyard-product-unknown:${id}` }), TypeError);
});

test("TUS termination deletes only the trusted upload resource using fresh server-only authorization", async () => {
  let call;
  const adapter = createAdapter(async (url, options) => {
    call = { url, options };
    return new Response(null, { status: 204, headers: { "Tus-Resumable": "1.0.0" } });
  });
  assert.deepEqual(await adapter.terminateTusUpload({ videoId: "video-guid",
    uploadUrl: "https://video.bunnycdn.com/tusupload/abc_123-XYZ" }), { state: "terminated" });
  assert.equal(call.url, "https://video.bunnycdn.com/tusupload/abc_123-XYZ");
  assert.equal(call.options.method, "DELETE");
  assert.equal(call.options.redirect, "error");
  assert.equal(call.options.headers.AccessKey, undefined);
  assert.equal(call.options.headers["Tus-Resumable"], "1.0.0");
  assert.equal(call.options.headers.VideoId, "video-guid");
  assert.equal(call.options.headers.LibraryId, "754739");
  assert.equal(call.options.headers.AuthorizationExpire, "1699999560");
  assert.equal(call.options.headers.AuthorizationSignature,
    adapter.createTusUploadAuthorization({ videoId: "video-guid", expiresAt: 1699999560 }).headers.AuthorizationSignature);
});

test("TUS termination fails closed on untrusted URLs and unexpected provider responses", async () => {
  const noRequest = createAdapter(async () => assert.fail("untrusted URL must not be contacted"));
  for (const url of ["https://evil.example/tusupload/a", "https://video.bunnycdn.com/tusupload/a?key=x",
    "https://video.bunnycdn.com/tusupload/../a", "/tusupload/a", null]) {
    await assert.rejects(noRequest.terminateTusUpload({ videoId: "video-guid", uploadUrl: url }), TypeError);
  }
  for (const [status, version] of [[200, "1.0.0"], [202, "1.0.0"], [204, undefined], [204, "0.2.2"]]) {
    const adapter = createAdapter(async () => new Response(null,
      { status, headers: version ? { "Tus-Resumable": version } : {} }));
    await assert.rejects(adapter.terminateTusUpload({ videoId: "video-guid",
      uploadUrl: "https://video.bunnycdn.com/tusupload/a" }),
    error => error.code === "BUNNY_STREAM_INVALID_TUS_RESPONSE");
  }
});

test("TUS termination distinguishes gone resources from rejection, timeout and transient failures", async () => {
  for (const status of [404, 400, 401, 403, 409, 410, 429, 500]) {
    const adapter = createAdapter(async () => new Response(null, { status }));
    const terminate = adapter.terminateTusUpload({ videoId: "video-guid",
      uploadUrl: "https://video.bunnycdn.com/tusupload/a" });
    if (status === 404) assert.deepEqual(await terminate, { state: "not_found" });
    else await assert.rejects(terminate, error => error instanceof BunnyStreamProviderError && error.status === status);
  }
  const adapter = createAdapter(async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  }));
  await assert.rejects(adapter.terminateTusUpload({ videoId: "video-guid",
    uploadUrl: "https://video.bunnycdn.com/tusupload/a" }), error => error.code === "BUNNY_STREAM_TIMEOUT");
});

test("thumbnail downloads use a short signed CDN path without sending library credentials", async () => {
  let call;
  const adapter = createAdapter(async (url, options) => {
    call = { url, options };
    return new Response(Buffer.from("jpeg bytes"), { headers: { "Content-Type": "image/jpeg" } });
  });
  const buffer = await adapter.readThumbnail({ videoId: "video-guid", fileName: "thumbnail.jpg" });
  assert.equal(buffer.toString(), "jpeg bytes");
  assert.ok(call.url.startsWith("https://vz-75c6f60b-a70.b-cdn.net/bcdn_token="));
  assert.ok(call.url.endsWith("/video-guid/thumbnail.jpg"));
  assert.ok(call.url.includes("expires=1699999560"));
  assert.equal(call.options.redirect, "error");
  assert.equal(call.options.headers.AccessKey, undefined);
  assert.equal(JSON.stringify(call).includes("stream-api-key"), false);
});

test("thumbnail filenames cannot escape the server-selected video and CDN origin", async () => {
  let calls = 0;
  const adapter = createAdapter(async () => { calls++; });
  for (const fileName of [null, "../thumbnail.jpg", "https://evil.example/image.jpg",
    "thumbnail.jpg?token=1", "thumbnail.svg", "thumb%2fimage.jpg", "thumbnail\\image.jpg"] ) {
    assert.throws(() => adapter.readThumbnail({ videoId: "video-guid", fileName }), TypeError);
  }
  assert.equal(calls, 0);
});

test("thumbnail responses reject empty bytes, wrong MIME and declared or streamed overflow", async () => {
  for (const [body, headers] of [[Buffer.alloc(0), { "Content-Type": "image/jpeg" }],
    ["<html>", { "Content-Type": "text/html" }],
    ["bytes", { "Content-Type": "image/jpeg", "Content-Length": "5242881" }],
    [Buffer.alloc(5242881), { "Content-Type": "image/jpeg" }]]) {
    const adapter = createAdapter(async () => new Response(body, { headers }));
    await assert.rejects(adapter.readThumbnail({ videoId: "video-guid", fileName: "thumbnail.jpg" }),
      (error) => error.code === "BUNNY_STREAM_INVALID_THUMBNAIL");
  }
});

test("thumbnail HTTP failures remain typed provider failures", async () => {
  for (const status of [404, 403, 429, 500]) {
    const adapter = createAdapter(async () => new Response(null, { status }));
    await assert.rejects(adapter.readThumbnail({ videoId: "video-guid", fileName: "thumbnail.jpg" }),
      (error) => error instanceof BunnyStreamProviderError && error.status === status);
  }
});

test("thumbnail timeout covers reading the body after successful response headers", async () => {
  const adapter = createAdapter(async (url, { signal }) => ({
    ok: true, status: 200, headers: new Headers({ "Content-Type": "image/jpeg" }),
    body: { getReader() { return {
      read() { return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"),
          { name: "AbortError" })), { once: true });
      }); }, releaseLock() {},
    }; } },
  }));
  await assert.rejects(adapter.readThumbnail({ videoId: "video-guid", fileName: "thumbnail.jpg" }),
    (error) => error.code === "BUNNY_STREAM_TIMEOUT");
});

test("signed HLS probe accepts only a playable playlist without sending API keys", async () => {
  const calls = [];
  const adapter = createAdapter(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200,
      async text() { return "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n720p.m3u8\n"; } };
  });
  const grant = await adapter.probeSignedHls({ videoId: "video-guid", expiresAt: 1_700_000_000 });
  assert.ok(grant.href.startsWith("https://vz-75c6f60b-a70.b-cdn.net/bcdn_token="));
  assert.ok(grant.href.endsWith("/video-guid/playlist.m3u8"));
  assert.equal(grant.expiresAt, 1_700_000_000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, grant.href);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.AccessKey, undefined);
  assert.equal(JSON.stringify(calls).includes("stream-api-key"), false);
});

test("signed HLS probe treats missing or invalid playlists as not previewable", async () => {
  for (const [status, playlist] of [[404, ""], [200, ""], [200, "<html>error</html>"],
    [200, "#EXTM3U\n"], [200, `#EXTM3U\n#EXTINF:${"x".repeat(65536)}`]]) {
    const adapter = createAdapter(async () => ({ ok: status === 200, status,
      async text() { return playlist; } }));
    assert.equal(await adapter.probeSignedHls({ videoId: "video-guid",
      expiresAt: 1_700_000_000 }), null);
  }
});

test("signed HLS probe bounds a streamed playlist before accepting it", async () => {
  const adapter = createAdapter(async () => new Response(
    `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n${"x".repeat(70 * 1024)}`,
    { status: 200 },
  ));
  assert.equal(await adapter.probeSignedHls({ videoId: "video-guid",
    expiresAt: 1_700_000_000 }), null);
});

test("signed HLS probe does not hide authorization or provider errors", async () => {
  for (const status of [401, 403, 429, 500]) {
    const adapter = createAdapter(async () => ({ ok: false, status }));
    await assert.rejects(adapter.probeSignedHls({ videoId: "video-guid",
      expiresAt: 1_700_000_000 }), (error) =>
      error instanceof BunnyStreamProviderError && error.status === status);
  }
});

test("server creates an empty TUS resource and returns only a validated absolute Location and original expiry", async () => {
  const requests = [];
  const adapter = createAdapter(async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 201, headers: new Headers({ Location: "/tusupload/abc_123-XYZ" }) };
  });
  assert.deepEqual(await adapter.createTusUpload({ videoId: "video-guid", sizeBytes: 100,
    mimeType: "video/mp4", title: "Product video test", expiresAt: 1_700_000_000 }), {
    uploadUrl: "https://video.bunnycdn.com/tusupload/abc_123-XYZ", resourceExpiresAt: 1_700_000_000,
  });
  assert.equal(requests[0].url, "https://video.bunnycdn.com/tusupload");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.body, undefined);
  assert.equal(requests[0].options.headers.AccessKey, undefined);
  assert.equal(requests[0].options.headers["Upload-Length"], "100");
  assert.equal(requests[0].options.headers["Tus-Resumable"], "1.0.0");
  assert.equal(requests[0].options.headers["Upload-Metadata"], "filetype dmlkZW8vbXA0,title UHJvZHVjdCB2aWRlbyB0ZXN0");
  assert.equal(requests[0].options.headers.VideoId, "video-guid");
});

test("TUS creation refuses unsafe Locations and ambiguous success without retrying or leaking headers", async () => {
  for (const [status, location] of [
    [200, "/tusupload/id"], [201, null], [201, "//evil.test/tusupload/id"],
    [201, "/tusupload/../id"], [201, "/tusupload/%2e%2e"], [201, "/tusupload/id?secret=yes"],
    [201, "/tusupload/id#secret"], [201, "https://user@video.bunnycdn.com/tusupload/id"],
    [201, "http://video.bunnycdn.com/tusupload/id"], [201, "https://evil.test/tusupload/id"],
    [201, `/tusupload/${"a".repeat(2048)}`],
  ]) {
    let requests = 0;
    const adapter = createAdapter(async () => {
      requests += 1;
      return { ok: true, status, headers: new Headers(location ? { Location: location } : {}) };
    });
    await assert.rejects(adapter.createTusUpload({ videoId: "video-guid", sizeBytes: 100,
      mimeType: "video/mp4", title: "Product video test", expiresAt: 1_700_000_000 }), (error) =>
      error.code === "BUNNY_STREAM_INVALID_TUS_RESPONSE" && !/secret|evil|stream-api-key/.test(error.message));
    assert.equal(requests, 1);
  }
});

test("TUS creation validates byte count and media type before provider allocation", async () => {
  let contacted = false;
  const adapter = createAdapter(async () => { contacted = true; });
  for (const [sizeBytes, mimeType, title] of [[0, "video/mp4", "Product test"], [1.5, "video/mp4", "Product test"],
    [250 * 1024 * 1024 + 1, "video/mp4", "Product test"], [100, "video/avi", "Product test"],
    [100, "video/mp4", ""], [100, "video/mp4", "line\nbreak"]]) {
    await assert.rejects(adapter.createTusUpload({ videoId: "video-guid", sizeBytes, mimeType, title,
      expiresAt: 1_700_000_000 }), TypeError);
  }
  assert.equal(contacted, false);
});

test("uncertain TUS POST is not retried and reports a sanitized failure", async () => {
  let requests = 0;
  const adapter = createAdapter(async () => { requests += 1; throw new Error("secret signature and URL"); });
  await assert.rejects(adapter.createTusUpload({ videoId: "video-guid", sizeBytes: 100,
    mimeType: "video/mp4", title: "Product video test", expiresAt: 1_700_000_000 }), (error) =>
    error.code === "BUNNY_STREAM_PROVIDER_ERROR" && !error.message.includes("secret"));
  assert.equal(requests, 1);
});

test("TUS inspection reads upload progress using fresh scoped authorization and never the API key", async () => {
  const requests = [];
  const adapter = createAdapter(async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, headers: new Headers({ "Tus-Resumable": "1.0.0",
      "Upload-Offset": "40", "Upload-Length": "100" }) };
  });
  assert.deepEqual(await adapter.inspectTusUpload({ videoId: "video-guid",
    uploadUrl: "https://video.bunnycdn.com/tusupload/resource-123", expiresAt: 1_700_000_000 }),
  { state: "incomplete", offsetBytes: 40, sizeBytes: 100 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, "HEAD");
  assert.equal(requests[0].options.redirect, "error");
  assert.deepEqual(requests[0].options.headers, {
    "Tus-Resumable": "1.0.0", AuthorizationExpire: "1700000000",
    AuthorizationSignature: "9fa7adeb8197c4885bc91b1f7467b9723929ac534ffc4a55d16c47492b51a73a",
    LibraryId: "754739", VideoId: "video-guid",
  });
  assert.equal(JSON.stringify(requests).includes("stream-api-key"), false);
});

test("TUS inspection rejects malformed progress instead of treating it as a completed upload", async () => {
  for (const headers of [
    {}, { "Upload-Offset": "0", "Upload-Length": "100" },
    { "Tus-Resumable": "1.0.0", "Upload-Length": "100" },
    { "Tus-Resumable": "1.0.0", "Upload-Offset": "0" },
    ...["-1", "1.5", "1e2", "NaN", "9007199254740992", "101"].map((offset) => ({
      "Tus-Resumable": "1.0.0", "Upload-Offset": offset, "Upload-Length": "100",
    })),
  ]) {
    const adapter = createAdapter(async () => ({ ok: true, status: 200, headers: new Headers(headers) }));
    await assert.rejects(adapter.inspectTusUpload({ videoId: "video-guid",
      uploadUrl: "https://video.bunnycdn.com/tusupload/resource-123", expiresAt: 1_700_000_000 }),
    (error) => error instanceof BunnyStreamProviderError && error.code === "BUNNY_STREAM_INVALID_TUS_RESPONSE");
  }
});

test("TUS 404 means only resource not found, while authorization and provider failures stay errors", async () => {
  for (const status of [404, 400, 401, 403, 410, 429, 500, 302]) {
    const adapter = createAdapter(async () => ({ ok: false, status }));
    const result = adapter.inspectTusUpload({ videoId: "video-guid",
      uploadUrl: "https://video.bunnycdn.com/tusupload/resource-123", expiresAt: 1_700_000_000 });
    if (status === 404) assert.deepEqual(await result, { state: "not_found" });
    else await assert.rejects(result, (error) => error instanceof BunnyStreamProviderError && error.status === status);
  }
});

test("TUS inspection rejects untrusted or ambiguous URLs before making a request", async () => {
  let contacted = false;
  const adapter = createAdapter(async () => { contacted = true; });
  for (const uploadUrl of [
    "http://video.bunnycdn.com/tusupload/id", "https://evil.test/tusupload/id",
    "https://video.bunnycdn.com.evil.test/tusupload/id", "https://video.bunnycdn.com@evil.test/tusupload/id",
    "https://user:pass@video.bunnycdn.com/tusupload/id", "https://video.bunnycdn.com:443/tusupload/id",
    "https://video.bunnycdn.com/library/754739/videos/id", "https://video.bunnycdn.com/tusupload",
    "https://video.bunnycdn.com/tusupload/id?redirect=evil", "https://video.bunnycdn.com/tusupload/id#fragment",
    "https://video.bunnycdn.com/tusupload/../library", "https://video.bunnycdn.com/tusupload/%2e%2e",
    "https://video.bunnycdn.com/tusupload/id%2Fother", "https://video.bunnycdn.com/tusupload/id\n",
    `https://video.bunnycdn.com/tusupload/${"a".repeat(2048)}`, null,
  ]) {
    await assert.rejects(adapter.inspectTusUpload({ videoId: "video-guid", uploadUrl, expiresAt: 1_700_000_000 }), TypeError);
  }
  assert.equal(contacted, false);
});

test("TUS byte completion is reported separately from provider readiness", async () => {
  const adapter = createAdapter(async () => ({ ok: true, status: 204,
    headers: new Headers({ "Tus-Resumable": "1.0.0", "Upload-Offset": "100", "Upload-Length": "100" }) }));
  assert.deepEqual(await adapter.inspectTusUpload({ videoId: "video-guid",
    uploadUrl: "https://video.bunnycdn.com/tusupload/resource-123", expiresAt: 1_700_000_000 }),
  { state: "complete", offsetBytes: 100, sizeBytes: 100 });
});

test("TUS inspection does not send expired or overlong authorization", async () => {
  let contacted = false;
  const adapter = createAdapter(async () => { contacted = true; });
  for (const expiresAt of [1_699_999_500, 1_700_021_101]) {
    await assert.rejects(adapter.inspectTusUpload({ videoId: "video-guid",
      uploadUrl: "https://video.bunnycdn.com/tusupload/resource-123", expiresAt }), RangeError);
  }
  assert.equal(contacted, false);
});

test("TUS network failures and timeouts expose neither URL nor authorization", async () => {
  for (const timeout of [false, true]) {
    const adapter = createAdapter(async (_url, { signal }) => {
      if (!timeout) throw new Error("secret URL and AuthorizationSignature and stream-api-key");
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("secret"))));
    });
    await assert.rejects(adapter.inspectTusUpload({ videoId: "video-guid",
      uploadUrl: "https://video.bunnycdn.com/tusupload/resource-123", expiresAt: 1_700_000_000 }),
    (error) => error instanceof BunnyStreamProviderError &&
      error.code === (timeout ? "BUNNY_STREAM_TIMEOUT" : "BUNNY_STREAM_PROVIDER_ERROR") &&
      !/secret|resource-123|Authorization|stream-api-key/.test(error.message));
  }
});

test("Bunny Stream adapter creates, gets, and deletes a provider video through its HTTP seam", async () => {
  const requests = [];
  const responses = [
    jsonResponse(200, { guid: "video-guid", title: "Product video" }),
    jsonResponse(200, { guid: "video-guid", status: 4 }),
    jsonResponse(200, { success: true }),
  ];
  const adapter = createAdapter(async (url, options) => {
    requests.push({ url, options });
    return responses.shift();
  });

  assert.deepEqual(await adapter.createVideo({ title: "Product video" }), {
    guid: "video-guid",
    title: "Product video",
  });
  assert.deepEqual(await adapter.getVideo("video-guid"), {
    guid: "video-guid",
    status: 4,
  });
  assert.deepEqual(await adapter.deleteVideo("video-guid"), {
    accepted: true,
    status: 200,
  });

  assert.deepEqual(
    requests.map(({ url, options }) => [url, options.method]),
    [
      ["https://video.bunnycdn.com/library/754739/videos", "POST"],
      ["https://video.bunnycdn.com/library/754739/videos/video-guid", "GET"],
      ["https://video.bunnycdn.com/library/754739/videos/video-guid", "DELETE"],
    ],
  );
  assert.equal(requests[0].options.headers.AccessKey, "stream-api-key");
  assert.equal(requests[0].options.body, '{"title":"Product video"}');
});

test("Bunny Reel reservation search is bounded and uses only the server key", async () => {
  const requests = [];
  const adapter = createAdapter(async (url, options) => {
    requests.push({ url, options });
    return jsonResponse(200, { items: [], totalItems: 0, currentPage: 1 });
  });
  const providerTitle = "petyard-reel-session:507f1f77bcf86cd799439012";
  assert.deepEqual(await adapter.searchReelReservation({ providerTitle }),
    { items: [], totalItems: 0, currentPage: 1 });
  const url = new URL(requests[0].url);
  assert.equal(url.origin + url.pathname, "https://video.bunnycdn.com/library/754739/videos");
  assert.equal(url.searchParams.get("search"), providerTitle);
  assert.equal(url.searchParams.get("page"), "1");
  assert.equal(url.searchParams.get("itemsPerPage"), "10");
  assert.equal(requests[0].options.headers.AccessKey, "stream-api-key");
  assert.throws(() => adapter.searchReelReservation({ providerTitle: "Other video" }), TypeError);
  assert.equal(requests.length, 1);
});

test("Bunny Stream adapter accepts an empty successful deletion response", async () => {
  const adapter = createAdapter(async () => ({ ok: true, status: 204 }));
  assert.deepEqual(await adapter.deleteVideo("video-guid"), {
    accepted: true,
    status: 204,
  });
});

test("Bunny Stream adapter produces a re-signable TUS authorization without exposing the Stream API key", () => {
  const adapter = createAdapter(async () => jsonResponse(200, {}));

  const authorization = adapter.createTusUploadAuthorization({
    videoId: "video-guid",
    expiresAt: 1_700_000_000,
  });

  assert.deepEqual(authorization, {
    endpoint: "https://video.bunnycdn.com/tusupload",
    expiresAt: 1_700_000_000,
    headers: {
      AuthorizationExpire: "1700000000",
      AuthorizationSignature: "9fa7adeb8197c4885bc91b1f7467b9723929ac534ffc4a55d16c47492b51a73a",
      LibraryId: "754739",
      VideoId: "video-guid",
    },
  });
  assert.equal(JSON.stringify(authorization).includes("stream-api-key"), false);
});

test("Bunny Stream adapter refuses TUS authorizations beyond six hours", () => {
  const adapter = createAdapter(async () => jsonResponse(200, {}));
  assert.throws(
    () =>
      adapter.createTusUploadAuthorization({
        videoId: "video-guid",
        expiresAt: 1_700_021_101,
      }),
    /expiresAt exceeds configured upload authorization lifetime/,
  );
});

test("Bunny Stream adapter emits a path-style signed HLS URL and never an unsigned fallback", () => {
  const adapter = createAdapter(async () => jsonResponse(200, {}));

  const playback = adapter.createSignedHlsUrl({
    videoId: "video-guid",
    expiresAt: 1_700_000_000,
  });

  assert.equal(
    playback.href,
    "https://vz-75c6f60b-a70.b-cdn.net/bcdn_token=HS256-o17DvSYMMJ8JKUsFiwy5tz8rZt-xcBIBtvHD-hjMhYg&token_path=%2Fvideo-guid%2F&expires=1700000000/video-guid/playlist.m3u8",
  );
  assert.equal(playback.expiresAt, 1_700_000_000);
  assert.equal(playback.href.includes("cdn-token-key"), false);
});

test("Bunny Stream adapter refuses playback grants beyond fifteen minutes", () => {
  const adapter = createAdapter(async () => jsonResponse(200, {}));
  assert.throws(
    () =>
      adapter.createSignedHlsUrl({
        videoId: "video-guid",
        expiresAt: 1_700_000_401,
      }),
    /expiresAt exceeds configured playback lifetime/,
  );
});

test("Bunny Stream adapter redacts provider status failures", async () => {
  for (const status of [400, 401, 403, 404, 500]) {
    const adapter = createAdapter(async () =>
      jsonResponse(status, { message: "stream-api-key was rejected" }),
    );

    await assert.rejects(
      adapter.getVideo("video-guid"),
      (error) =>
        error instanceof BunnyStreamProviderError &&
        error.status === status &&
        error.code === "BUNNY_STREAM_PROVIDER_ERROR" &&
        error.message === `Bunny Stream request failed with status ${status}` &&
        !error.message.includes("stream-api-key"),
    );
  }
});

test("Bunny Stream adapter converts an aborted HTTP request into a redacted timeout", async () => {
  const adapter = createAdapter(
    async (_url, { signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("request aborted with stream-api-key");
          error.name = "AbortError";
          reject(error);
        });
      }),
  );

  await assert.rejects(
    adapter.deleteVideo("video-guid"),
    (error) =>
      error instanceof BunnyStreamProviderError &&
      error.code === "BUNNY_STREAM_TIMEOUT" &&
      error.message === "Bunny Stream request timed out" &&
      !error.message.includes("stream-api-key"),
  );
});
