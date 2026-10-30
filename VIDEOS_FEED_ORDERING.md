# Videos feed: unseen-first shuffle

Implementation date: 2026-10-30 (Africa/Cairo). This is a local backend change;
it does not claim that the VPS has pulled or accepted this feature.

## Scope and compatibility

Only customer `GET /api/v1/videos/feed` ordering changes, for all existing `kind`
values (`reel`, `product`, `all`). The URLs, query/header requirements, DTOs,
paging envelopes, status/error contracts and telemetry acknowledgements remain
unchanged. No seed, cursor, session ID or watched flag is added to the API.

The existing user token or `x-guest-id` supplies identity. Anonymous requests
retain the old public sort and create no viewer snapshot/history. No IP or
User-Agent fingerprint is persisted. YouTube, saved, gallery and admin ordering
are unchanged. Manual Reel positions remain the fallback order; the new feed
ranking deliberately takes precedence over those positions.

## Ranking and history

1. Eligible unseen current generations come first, grouped by publication day
   for Reels and active-asset readiness day for Product Videos. Days use
   `Africa/Cairo`, newest first. Consecutive sparse days (fewer than five unseen
   videos each) are merged until a group has at least five where possible; a final
   smaller group is retained. Dense days stay separate and end the preceding
   sparse group, preserving a small fresh group's priority over a large older
   day. Each group uses Fisher-Yates shuffle with Node's cryptographic
   `randomInt`. This avoids fixed ordering for a small catalog containing only
   one video per day while keeping the freshest cohorts ahead of older ones.
2. All eligible seen generations follow, shuffled together. Seen videos are
   demoted, not removed. Random shuffles may occasionally produce the same order.
3. The existing analytics ingestion derives a qualified native view once its
   accepted watch intervals reach 2,000 ms in a playback session. Only the event
   that crosses that threshold stores viewer type, viewer ID and active asset
   ID. Client input cannot supply these fields. Impressions/start/rebuffer and
   duplicate/rejected batches do not create history.
4. The viewer/generation metadata is stored on the existing raw analytics event,
   in the same transaction as the event and daily totals. There is no additional
   history collection, analytics acknowledgement change or best-effort side write.
5. Raw events already expire 30 days after acceptance. Feed history also explicitly
   checks `expiresAt > now`, so TTL deletion delay cannot extend history. No legacy
   history backfill is attempted. Guest/user namespaces stay separate, including
   after login. Account history is shared across its valid tokens.
6. History identifies content kind, record ID and active asset ID. A replacement
   asset is unseen even when the old asset was watched. Reel freshness still uses
   publication day; Product freshness follows the new active asset's ready day.

## Pagination and storage

Redis holds an ordered array of generation keys, not media URLs, content DTOs,
tokens or raw user IDs. The key hashes viewer identity, an already hashed bearer
scope for authenticated devices, feed kind and enabled content families. Guest
scope stays stable through IP/User-Agent changes.

A page-1 request rebuilds the order after a five-second retry debounce. Later
pages reuse that order and renew its 30-minute idle TTL. History/publications
arriving during scrolling take effect on rebuild. Each page independently reads
current eligible metadata and hydrates only the selected current rows, including
current language/save/cover data. Deleted/hidden/replaced generations are filtered
before slicing and checked again while hydrating; they cannot be resurrected by
the snapshot.

An atomic Redis Lua compare-and-set selects a single winning snapshot during
concurrent initialization/refresh. The same atomic path renews cached reads,
avoiding stale reads overwriting or returning a superseded snapshot. Redis
errors return the existing public ordering rather than introducing an API outage.
Database failures are not swallowed as cache failures.

The existing API has page numbers and no client browsing-session token. Its limits
remain explicit:

- Tabs sharing one identity/bearer/kind share ordering state; a refresh can restart
  that state for all of them. Auth token rotation also starts a new context.
- Snapshot expiry, eviction or Redis failure/recovery may restart ordering. Resume
  from page 1 rather than joining pages from different rounds.
- Removing eligibility while scrolling can shift offsets or shorten a page. An
  offset-based API cannot promise cursor-level continuity under those mutations.
- Page size should stay consistent while scrolling. Do not reshuffle returned
  pages on the client; deduplicate accumulated rows by kind/ID.
- Candidate ranking currently scans eligible metadata in memory. It never loads
  the whole catalog's full DTOs/covers into Redis. Indexed candidate windows are
  appropriate if measured catalog size/latency requires them; this change does
  not impose a hidden cap or truncate existing `totalResults`.

## Deployment

No new environment key, provider credential, collection, FE request or route is
required. Existing Redis must be reachable for the new ordering. Initialize the
added partial viewer-history index on `VideoAnalyticsEvent` before rollout:

```bash
node --input-type=module <<'NODE'
import '@dotenvx/dotenvx/config';
import mongoose from 'mongoose';
import { VideoAnalyticsEventModel } from './src/domains/videos/analytics/videoAnalyticsEvent.model.js';
try {
  if (!process.env.MONGO_URI) throw Error('MONGO_URI_REQUIRED');
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, serverSelectionTimeoutMS: 15000 });
  await VideoAnalyticsEventModel.createIndexes();
  console.log('Video analytics indexes ready');
} catch (error) {
  console.error('Index initialization failed', error.code || error.name);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
NODE
```

Use `createIndexes`, not `syncIndexes`: existing indexes must not be dropped.
Reload the API after deploying. Existing analytics TTL/indexes remain intact;
provider-worker and Bunny webhook behavior are unchanged. No new provider media
or notification test permission is implied by this local implementation.

## Verification

Tests cover same-day shuffling/newer-group precedence, twenty sparse days,
Cairo midnight, all seen
versus unseen ranking, replaced generations, 20-item pagination while history
and new content arrive, concurrent snapshot winners, refresh debounce, idle
expiry/renewal, corrupt state, Redis fallback versus database errors, viewer and
token/filter isolation, hidden/current media checks, unchanged DTO/localization/
saved fields, transactional history rollback and retry/idempotency, and explicit
history expiry/identity filters.

The final full Videos regression passed **745 tests, zero failures, five external
opt-in skips**. The existing Postman checker passed all 53 frontend routes,
62 saved requests and 354 response examples. Independent read-only review found
no remaining actionable issue after removal of anonymous fingerprinting and
atomic snapshot renewal. A real local Redis check was attempted against the
configured loopback instance, which refused the connection; actual Lua execution
has not yet been proven in this environment. No live MongoDB/provider/VPS writes,
notification sends, commits, pushes or deployment were performed for this change.
