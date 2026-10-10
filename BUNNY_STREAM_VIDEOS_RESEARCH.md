# PetYard video-provider research

Research date: 2026-09-14. Bunny Stream upload and webhook facts were
re-verified against the rewritten official documentation on 2026-09-16.
Sources are Bunny/YouTube first-party documentation unless explicitly marked as
an open protocol specification.

## Executive finding

Bunny Stream is the appropriate provider for uploaded reels. It is a video product with transcoding, adaptive HLS, thumbnails, and resumable TUS upload; Bunny Storage is a general file/image object store and does not itself provide those video-processing features. Bunny describes Stream as API-first with TUS uploads and HLS playback, while its video specification documents generated renditions and thumbnails. ([Stream](https://bunny.net/stream/), [video specification](https://docs.bunny.net/docs/stream-best-practices))

PetYard should keep its current Bunny Storage image path unchanged and create a separate Stream Video Library for reels. The backend should create the provider video and mint short-lived upload authorization; the browser/admin client should upload bytes directly to Bunny. PetYard should persist its own editorial/publication state and treat Bunny as the asset-processing authority.

## Bunny Stream API and upload

The Stream management API is rooted at `https://video.bunnycdn.com/library/{libraryId}` and uses the library API key in the `AccessKey` header. The documented Get Video operation returns the GUID, duration (`length`, seconds), dimensions, `status`, `encodeProgress`, `availableResolutions`, `thumbnailFileName`, `hasMP4Fallback`, `hasOriginal`, and transcoding messages. ([Get Video](https://docs.bunny.net/reference/video_getvideo))

The create-video operation is a server-side `POST https://video.bunnycdn.com/library/{libraryId}/videos` with `AccessKey: <api-key>` and a JSON body containing at least a title; the response supplies the provider GUID used by subsequent upload calls. Bunny's API reference and official Stream client example establish that the video object must exist before uploading bytes. ([Bunny API reference](https://docs.bunny.net/reference/video_createvideo), [BunnyWay Stream API client](https://github.com/BunnyWay/bunnystream-api-php))

For the TUS endpoint, use `https://video.bunnycdn.com/tusupload`. The presigned upload request carries these exact headers:

```text
AuthorizationSignature: SHA256(libraryId + apiKey + authorizationExpire + videoId)
AuthorizationExpire: <future Unix timestamp in seconds>
VideoId: <created video GUID>
LibraryId: <library id>
```

The signature and expiry must be generated server-side because the API key is the signing input. Bunny's official Stream page confirms TUS resumable uploads; the header names and signature input are shown in Bunny's official API-client ecosystem/example and should be verified against the currently rendered dashboard/API reference during the implementation spike. ([Stream](https://bunny.net/stream/), [BunnyWay Stream API client](https://github.com/BunnyWay/bunnystream-api-php))

The client then follows TUS: create/resume the upload at `/tusupload`, send file chunks with `PATCH`, `Content-Type: application/offset+octet-stream`, and the current `Upload-Offset`, and resume using the upload URL/offset. These mechanics are defined by the TUS protocol specification. ([TUS protocol](https://tus.io/protocols/resumable-upload))

Bunny's updated TUS FAQ says `AuthorizationExpire` is checked at the start of
each `POST`, `HEAD`, and `PATCH`. A new signature for the same video GUID can
resume the existing upload URL, but cannot extend that upload resource's
original expiry. An incomplete resource expires at its original
`AuthorizationExpire` or after about 48 hours of inactivity, whichever comes
first, and then returns `404`. With PetYard's six-hour authorization and
24-hour local abandonment window, a later retry may therefore require a new
Bunny resource while preserving the local Product Video placement and
durably cleaning up the old resource. Verify the behavior in the provider
canary. ([Bunny TUS resumable uploads](https://bunny.net/docs/stream/tus-resumable-uploads))

Do not proxy reel bytes through Express. Validate MIME, declared byte length, and authorization in PetYard before creating a provider object; cap upload-session lifetime; record the Bunny GUID; and make session completion/reconciliation idempotent.

## Processing state and reconciliation

Bunny's current Stream webhook documentation defines queued (0), processing
(1), encoding (2), finished (3), resolution-finished/playable (4), failed (5),
and presigned-upload lifecycle states (6-8). The Get Video operation also
exposes encode progress, available resolutions, dimensions, duration, and
transcoding messages. ([Webhooks](https://bunny.net/docs/stream/webhooks), [Get
Video](https://docs.bunny.net/reference/video_getvideo)) PetYard should consume
the status as provider input but independently require the expected provider
metadata and completion rule before marking an asset ready.

Treat callbacks as hints, not proof. Authenticate the callback, persist a deduplication key/body hash, enqueue reconciliation, fetch the provider record using the server-only `AccessKey`, and apply a monotonic/idempotent state transition. A callback for an unknown GUID, wrong library, stale status, or mismatched metadata must be ignored/quarantined rather than publishing content.

## Webhook security

Bunny Stream's current webhook documentation defines signed POSTs using
`X-BunnyStream-Signature-Version: v1`,
`X-BunnyStream-Signature-Algorithm: hmac-sha256`, and a lowercase hexadecimal
`X-BunnyStream-Signature`. The signature is HMAC-SHA256 over the exact raw body
using the library Read-Only API key. PetYard must validate the version and
algorithm, preserve the raw body, and compare in constant time before parsing.
([Webhooks](https://bunny.net/docs/stream/webhooks))

The webhook remains a hint rather than publication authority: authenticate,
deduplicate, enqueue reconciliation, and fetch the provider record before
changing asset state. Delivery and retry guarantees still require a canary and
periodic reconciliation remains necessary.

## Playback URLs, thumbnails, and access control

After processing, the standard HLS URL is `https://{pullZoneHostname}/{videoGuid}/playlist.m3u8`; a standard thumbnail is `https://{pullZoneHostname}/{videoGuid}/thumbnail.jpg` (or the exact `thumbnailFileName` returned by the API). Bunny's own Stream material and official Bunny-authored examples document these URL shapes. ([Stream](https://bunny.net/stream/), [native playback article](https://bunny.net/blog/native-video-playback-with-bunny-stream-and-expo/))

For a native Flutter player, return an HLS URL rather than a Bunny embed URL. If the library enables token authentication, generate a short-lived path-style token. Bunny specifically warns that HLS path-style tokens are needed so authorization covers child playlists and media segments, not only the master playlist. ([Stream security options](https://bunny.net/docs/stream/security-options)) Keep the token-signing key on the PetYard server; never expose it in Flutter. Refresh the URL on expiry and dispose/preload only a small number of native players.

Use CDN Advanced Token Authentication for native HLS, not Stream's separate
embed-view signing recipe. Bunny documents directory/path-style
`bcdn_token=HS256-...` URLs with `token_path` scoped to the video directory.
The advanced signature is Base64URL HMAC-SHA256 using the CDN token key,
directory path, expiration, and any signed parameters; no IP lock is used for
mobile playback. The path form lets relative playlist and segment requests
inherit the token. ([CDN Advanced Token Authentication](https://bunny.net/docs/cdn/security/token-authentication/advanced),
[Stream security options](https://bunny.net/docs/stream/security-options))

MP4 fallback is optional and must be enabled at the library level; Bunny documents URLs such as `https://{pullZoneHostname}/{videoGuid}/play_1080p.mp4`, with fallback generation limited by enabled settings and generally up to 1080p. It increases storage and is not needed for a capable HLS player. ([MP4 fallback](https://github.com/BunnyWay/documentation/blob/main/stream/mp4-downloads.mdx), [video specification](https://docs.bunny.net/docs/stream-best-practices))

## Formats, portrait reels, and originals

Bunny supports portrait video and explicitly lists 1080×1920 and 720×1280. Supported input containers include MP4, MOV, MKV, WebM, AVI, TS, and others; supported codecs include H.264, H.265, VP8/9, AV1, MPEG-2, and ProRes. Bunny documents a maximum source duration of 72 hours and maximum resolution of 2160p/3840×2160 (or 2160×3840 portrait). ([video specification](https://docs.bunny.net/docs/stream-best-practices))

For PetYard's first release, enforce a much smaller product policy (for example, 60 seconds, MP4/MOV, vertical 9:16, H.264/AAC, 720p/1080p) in PetYard. Provider acceptance is not a substitute for product validation, aspect-ratio policy, moderation, or mobile playback testing.

Encoding, MP4 fallback, enabled resolutions, premium codecs, and keeping originals all increase storage use. Bunny exposes `hasOriginal`; its repackage API documents `keepOriginalFiles`, defaulting to true for that operation. ([video specification](https://docs.bunny.net/docs/stream-best-practices), [repackage video](https://docs.bunny.net/reference/video_repackage)) Recommendation: do not retain originals for the MVP unless recovery/editing requirements justify the cost; make retention an explicit library setting and deletion policy.

Deleting a video is a provider-side permanent operation in Bunny's API client documentation. PetYard should archive its editorial record first, enqueue provider deletion, and retain the provider GUID/audit result for reconciliation rather than deleting synchronously in the admin request. ([BunnyWay Stream API client](https://github.com/BunnyWay/bunnystream-api-php))

## Delivery tiers and pricing

Bunny's current public Stream pricing page displays storage at $0.01/GB for the Standard Tier example and a lower Volume Tier example calculated from the entered storage/traffic/replication inputs; it also advertises free standard transcoding and paid premium encoding options. The exact bill depends on storage, delivery, replication, encoding tier, and enabled outputs. ([Stream pricing](https://bunny.net/pricing/stream/)) Pricing is drift-prone: record the dashboard quote and selected tier at provisioning time (research date above), and do not encode a dollar estimate as an acceptance criterion.

## YouTube source videos and WebView

For YouTube content, store a validated YouTube video ID—not arbitrary iframe HTML—and generate `https://www.youtube.com/embed/{VIDEO_ID}` server-side. The IFrame Player API documents embed errors for unavailable/private/non-embeddable videos and error 153 when the request lacks an HTTP Referer or equivalent client identification. ([IFrame Player API reference](https://developers.google.com/youtube/iframe_api_reference))

Google's required-minimum-functionality page states that WebViews commonly send an empty Referer. For a local HTML player, set the WebView base URL; for direct Android/iOS WebView loading, provide the `Referer` request header; in iOS Safari View Controller, use the `origin` player parameter because Referer cannot be set. The Referer should identify the store-registered app ID/bundle ID in HTTPS form. ([YouTube API Services required functionality](https://developers.google.com/youtube/terms/required-minimum-functionality)) Flutter's WebView plugin must expose the platform-specific request/base-URL behavior needed by the chosen integration, and navigation must be constrained to the player/useful YouTube domains.

## PetYard recommendation and factual risks

Use a dedicated Bunny Stream library for reels, direct TUS uploads, server-side signing, HLS playback with path-style token authentication, Bunny thumbnails, and PetYard-owned editorial/publication state. Keep YouTube as a separate source type rendered through a compliant embed WebView. Model `Video` separately from `VideoAsset` so a failed replacement cannot unpublish a working asset.

The current official TUS signing recipe and Stream webhook signature/status
contract are now explicit and captured above. Remaining facts requiring a
dashboard/canary spike are the selected pull-zone hostname, real callback
delivery/retry behavior, chosen regions and delivery tier, path-token behavior
in the Flutter players, deletion propagation time, and Android/iOS playback plus
background/autoplay behavior. These are operational unknowns, not reasons to
route video bytes through PetYard.
