# PetYard Bunny Stream Configuration Plan

Status: Production library provisioned and its cost, encoding, storage, and
native-HLS security settings verified in the Bunny dashboard on 2026-09-16.
Secret capture, webhook configuration, and application implementation remain
pending.

Research verified against the current official Bunny Stream documentation on
2026-09-16.

## Boundary

The existing `BUNNY_PUBLIC_*` and `BUNNY_PRIVATE_*` settings belong to Bunny
Storage/CDN image delivery. Do not reuse their zones or keys for video.

Create a dedicated Bunny Stream Video Library. PetYard's backend controls video
records, permissions, upload authorization, lifecycle, placement, and playback
grants. Admin browsers upload video bytes directly to Bunny through TUS; video
bytes never pass through Express, Multer, Sharp, or the API server's memory.

## Stage 1: Create the Video Library

In the Bunny dashboard:

1. Open **Delivery -> Stream**.
2. Choose **Create Your first Video Library** or **Add Video Library**.
3. Name it `petyard-videos-production`. Use a separate
   `petyard-videos-staging` library if a real staging environment exists.
4. Select **Frankfurt (DE)** as the main and only storage region for the
   cost-first MVP.
5. Deselect the dashboard defaults for Singapore, Los Angeles, and New York.
   Their selected rows may omit a marginal-price label, but the pricing summary
   includes them. With all four selected, the dashboard showed `$0.03/GB`.
   On the current PetYard Bunny account, Frankfurt alone shows `$0.00/GB` in
   the library-creation pricing overview, while each replication region is
   offered at an additional `$0.01/GB`.
6. Do not enable additional replication at launch. Additional regions improve
   origin resilience and uncached-read locality, but they increase storage
   cost. The CDN still delivers cached video globally. Replication regions
   cannot be removed after the storage zone is created.
7. Create the library only after the pricing overview shows storage at
   `$0.00/GB` and the interface says to select a replication region, confirming
   that none is currently enabled.

The production library was created with Video Library ID `754739` and generated
CDN hostname `vz-75c6f60b-a70.b-cdn.net`. These values are identifiers, not
secrets. The High Volume delivery tier is active at `$0.005/GB`; it is Bunny's
cost-focused tier for video and large files and uses a smaller CDN PoP set than
the Standard tier. Keep this tier for the MVP, measure startup/rebuffering in
Egypt and the intended MENA markets, and switch only if playback evidence shows
that the broader Standard network is worth its higher regional bandwidth cost.

## Stage 2: Configure Encoding

Open **Stream -> petyard-videos-production -> Encoding** and use:

- Encoding tier: Standard/free.
- Output codec: H.264/x264.
- Enabled resolutions: 360p, 480p, 720p, and 1080p. Bunny does not upscale a
  source below an enabled resolution.
- Scale by both height and width: on, so portrait and landscape sources stay
  within enabled resolution bounds without height-only scaling surprises.
- Keep Original Files: off.
- Enable MP4 Fallback: off.
- Enable Early-Play: off, because it exposes and plays the original before
  transcoding completes.
- Automatic transcription/captions: off.
- Multi-audio support: off.
- Premium codecs/JIT encoding: off for MVP.
- DRM/MediaCage: off for native HLS MVP.
- Content tagging and advertising: off unless separately approved.

Dashboard verification on 2026-09-16 confirmed these settings. It also
confirmed 240p, 1440p, and 2160p are disabled; Smart title, Smart description,
Smart chapters, and Smart moments are disabled; and the VAST tag URL is empty.

PetYard still validates its own product policy before issuing upload access:
MP4 or MOV, at most 250 MB, and at most 90 seconds for Reels. Bunny accepting a
file does not make it valid PetYard content.

## Stage 3: Configure Native-HLS Security

Open **Stream -> petyard-videos-production -> Security**:

1. Enable token authentication for the actual video files/CDN delivery.
2. Record the CDN token-authentication key as a server-only secret.
3. Do not enable IP verification. Mobile IP addresses can change between HLS
   playlist and segment requests.
4. Leave **Block Direct URL File Access** off. Native Flutter HLS requests do
   not reliably send browser referrer headers, and this setting can block
   playlists, segments, thumbnails, and previews.
5. Leave Allowed Domains empty for native-app playback; domain allowlists are
   browser-referrer controls, not mobile-app authorization.
6. Do not rely on Embed View Token Authentication for Product Videos or Reels;
   Flutter uses native HLS. PetYard must generate CDN path-style tokens so the
   master playlist and every child playlist/segment remain authorized.

Dashboard verification on 2026-09-16 confirmed Direct Play on, empty domain
lists, Block Direct URL File Access off, Embed View Token Authentication off,
and CDN Token Authentication on. No separate IP-verification control appeared
after CDN authentication was enabled. The token key remained masked and was not
revealed, copied, or rotated during verification.

Use the Bunny-generated CDN hostname for MVP. A branded custom hostname is an
optional later change, not a launch dependency.

## Stage 4: Capture Library Values

Open the library's **API** section and capture these values without posting them
in chat, source control, logs, screenshots, or client code:

| Bunny value | PetYard variable | Classification | Destination |
| --- | --- | --- | --- |
| Video Library ID | `BUNNY_STREAM_LIBRARY_ID` | identifier | encrypted server environment |
| Stream API key | `BUNNY_STREAM_API_KEY` | secret, write-capable | encrypted server environment only |
| Read-Only API key | `BUNNY_STREAM_READ_ONLY_API_KEY` | secret; webhook signing key | encrypted server environment only |
| CDN Hostname | `BUNNY_STREAM_CDN_HOSTNAME` | public hostname | server configuration |
| CDN token key | `BUNNY_STREAM_TOKEN_KEY` | secret | encrypted server environment only |

The API page was verified with both API keys masked. The Webhook URL is empty,
as required until the production endpoint in Stage 6 exists. No key was
revealed, copied, or reset during dashboard provisioning.

PetYard already loads encrypted configuration through dotenvx. Add the Stream
values with dotenvx rather than copying plaintext secrets into `.env`. The
ignored `.env.keys` remains the decryption-key location; it must never be
committed or copied into the admin or Flutter projects.

Non-secret application settings for the provisioned library (flag names
accepted in Q148):

```dotenv
BUNNY_STREAM_LIBRARY_ID=754739
BUNNY_STREAM_CDN_HOSTNAME=vz-75c6f60b-a70.b-cdn.net
BUNNY_STREAM_UPLOAD_AUTH_TTL_SECONDS=21600
BUNNY_STREAM_PLAYBACK_TTL_SECONDS=900
BUNNY_STREAM_REQUEST_TIMEOUT_MS=15000
VIDEOS_PUBLIC_ENABLED=false
REEL_UPLOADS_ENABLED=false
PRODUCT_VIDEO_UPLOADS_ENABLED=false
PRODUCT_VIDEOS_PUBLIC_ENABLED=false
```

Do not put placeholder plaintext values for the three Stream secrets into the
tracked `.env`. Add `BUNNY_STREAM_API_KEY`,
`BUNNY_STREAM_READ_ONLY_API_KEY`, and `BUNNY_STREAM_TOKEN_KEY` locally using
dotenvx encryption. Keep `.env.keys` ignored and private. The existing
`BUNNY_PUBLIC_*` and `BUNNY_PRIVATE_*` keys belong to Bunny Storage images and
must not be reused for Stream. No webhook URL variable is needed; configure
the dashboard URL only after the HTTPS endpoint exists.

On a trusted local Windows terminal, use dotenvx's `set --encrypt` command for
each secret. Prompting for each value avoids leaving it in PowerShell command
history (the CLI still receives it briefly as a process argument):

```powershell
function Set-EncryptedStreamSecret {
  param([string]$Name)
  $secureValue = Read-Host $Name -AsSecureString
  $plainValue = [System.Net.NetworkCredential]::new('', $secureValue).Password
  try {
    & .\node_modules\.bin\dotenvx.cmd set $Name $plainValue --encrypt
    if ($LASTEXITCODE -ne 0) { throw "dotenvx failed for $Name" }
  } finally {
    Remove-Variable -Name plainValue, secureValue -ErrorAction SilentlyContinue
  }
}
Set-EncryptedStreamSecret BUNNY_STREAM_API_KEY
Set-EncryptedStreamSecret BUNNY_STREAM_READ_ONLY_API_KEY
Set-EncryptedStreamSecret BUNNY_STREAM_TOKEN_KEY
Remove-Item Function:\Set-EncryptedStreamSecret
```

The first two values come from **Stream -> petyard-videos-production -> API**;
the CDN token key comes from **Security**. Verify `.env` contains
`encrypted:` values for all three names before any commit. Never print or
share the decrypted values or `.env.keys`.

The accepted six-hour TUS authorization covers slow 250 MB uploads. Bunny's
current TUS documentation says a fresh signature may resume the same upload
URL, but does not extend that resource's original expiry; after expiry an
incomplete resource returns `404`. Therefore a retry later in the 24-hour
PetYard abandonment window may need a replacement Bunny resource. Keep the
Product Video placement/position and durably clean up the old resource. Verify
this behavior in the provider canary. The accepted playback token lifetime is at
most 15 minutes. Disabling public visibility or unpublishing blocks new grants
immediately, but does not promise instant revocation of previously issued
tokens. All feature switches default false; startup validation must fail if an
enabled feature lacks required Bunny configuration, never falling back to
unsigned playback.

## Stage 5: Implement the Direct TUS Upload Flow

The admin client must not receive the Stream API key.

1. Admin selects a video.
2. Admin UI validates extension/MIME and declared size before making a request.
3. Admin UI calls PetYard's create-upload endpoint with editorial metadata,
   filename, MIME, and byte length.
4. PetYard checks authentication, `VIDEOS` permission, file policy, and quota.
5. PetYard creates a pending Video Asset and calls:

   `POST https://video.bunnycdn.com/library/{libraryId}/videos`

   with server-only `AccessKey: BUNNY_STREAM_API_KEY` and a safe internal title.
6. Bunny returns the provider video GUID. PetYard stores it only on Video Asset.
7. PetYard computes:

   `SHA256(libraryId + apiKey + expirationUnixSeconds + providerVideoGuid)`

8. PetYard returns a short-lived upload session containing the TUS endpoint,
   library ID, provider video GUID, expiry, signature, and required metadata.
9. The admin UI uses `tus-js-client` to upload directly to:

   `https://video.bunnycdn.com/tusupload`

   with `AuthorizationSignature`, `AuthorizationExpire`, `LibraryId`, and
   `VideoId` headers plus required `filetype` and `title` metadata.
10. TUS resumes interrupted uploads from its stored upload URL. Completion in
    the browser marks the upload as submitted, not as processed or publishable.

## Stage 6: Configure the Stream Webhook

Do this only after the production HTTPS endpoint exists.

The local endpoint and signed-body validation are now implemented under V2.06
(2026-10-02). This does not establish production deployment, database/worker
acceptance or authorize changing the Bunny dashboard Webhook URL. Use the
existing Read-Only API key; no new environment variable is needed.

1. Implement an endpoint such as
   `POST /api/v1/integrations/bunny-stream/webhook` using a raw JSON body.
2. In the library **API** section, set its public HTTPS URL as the Webhook URL.
3. Validate all three headers:
   `X-BunnyStream-Signature-Version: v1`,
   `X-BunnyStream-Signature-Algorithm: hmac-sha256`, and
   `X-BunnyStream-Signature`.
4. Calculate lowercase hexadecimal HMAC-SHA256 over the exact raw request body
   using `BUNNY_STREAM_READ_ONLY_API_KEY`; compare in constant time.
5. Verify `VideoLibraryId`, find the known provider GUID, store/deduplicate the
   notification, persist a Video Provider Operation, enqueue its ID through
   BullMQ, and return quickly. A MongoDB sweeper recovers the operation if
   enqueueing or queue execution fails.
6. Fetch the Video from Bunny with the write API key before changing PetYard
   asset state. A webhook is a signed hint, not the sole authority.

Relevant provider states are queued (0), processing (1), encoding (2), finished
(3), resolution finished/playable (4), failed (5), and presigned-upload states
(6-8). PetYard should require provider metadata and the chosen completion rule
before marking a Video Asset `ready`.

## Stage 7: Playback Grant

1. Flutter requests `playbackHref` from PetYard when the user opens or preloads
   a Product Video/Reel.
2. PetYard verifies the Video, placement, publication, and active ready asset.
3. PetYard creates a short-lived path-style token scoped to the provider video
   directory and returns a URL based on:

   `https://{cdnHostname}/{providerVideoGuid}/playlist.m3u8`

4. Flutter passes the signed HLS URL to its native player and refreshes it near
   `expiresAt` if playback is still active.

The raw CDN token key remains server-side only. The provider GUID is not exposed
as a separate public DTO field, although the opaque signed playback URL
necessarily contains Bunny's provider path.

## Stage 8: Canary and Rollout

Before enabling uploads for admins:

1. Upload one short portrait MP4 and one short landscape MOV through the real
   admin TUS flow.
2. Interrupt and resume one upload.
3. Verify webhook signature rejection with a modified body.
4. Confirm processing reconciliation, duration, dimensions, thumbnail, and HLS
   readiness.
5. Confirm unsigned HLS is rejected and signed path-style HLS works on both
   Android and iOS.
6. Confirm the URL still plays when the mobile IP changes and fails after
   expiry.
7. Confirm the original and MP4 fallback are not available.
8. Confirm an admin upload waits for super-admin approval and a super-admin
   upload publishes only after the asset is ready.
9. Complete the additional public release gate: Product Video replacement and
   explicit deletion, missed-webhook reconciliation, signed HLS on Android and
   iOS, and recovery from a provider-cleanup failure.
10. Enable `REEL_UPLOADS_ENABLED` for a small admin allowlist, then enable
    `PRODUCT_VIDEO_UPLOADS_ENABLED` and the two independent public-visibility
    switches in separate rollout steps. Upload switches never hide existing
    playable media; public switches gate public read/stream access.

## Wizard checkpoint

The installed wizard template's `write_env` helper writes plaintext values,
which is unsuitable for PetYard's tracked, encrypted `.env`. Use the manual
dotenvx procedure above until an encrypted-writer wizard can be built without
changing its reusable template library. Any later wizard must not create the
remote library, upload a real video, enable feature flags, or deploy by itself.

## Primary references

- https://bunny.net/docs/stream/quickstart
- https://bunny.net/docs/stream/dashboard
- https://bunny.net/docs/stream/tus-resumable-uploads
- https://bunny.net/docs/stream/security-options
- https://bunny.net/docs/stream/webhooks
- https://bunny.net/docs/stream/video-specification
- https://docs.bunny.net/reference/videolibrarypublic_update
