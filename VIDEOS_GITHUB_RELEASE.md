# Petyard — Videos and Prime GitHub release

Prepared on 2026-10-10. The user authorized the combined GitHub commit/push and
will pull and activate the VPS personally. This document does not claim that
the VPS has been deployed or passed acceptance.

## Release contents and local verification

The release includes Videos routes, models, services, worker, tests, provider
integration, analytics, frontend handoff and Postman collection; warehouse
Prime geometry/configuration and related location, address, cart, checkout and
order changes; the existing pending UI Builder documentation updates and
project documentation/skill lockfile. Dependency and PM2 changes are included.

The combined Videos and eight warehouse/Prime regression files passed
**779 tests, zero failures, five opt-in external skips**. The run includes the
production upload guard activation/rollback test and invalid/missing readiness
configuration tests. Mocked HTTP requests needed permitted loopback access;
the restricted sandbox could not connect to the test servers.

No real provider allocation, notification send, production database write,
server restart or Bunny dashboard change was performed for this release.

### VPS deployment report and packaging corrections

The subsequent VPS-agent report states that `dded5bb` is live: all 15 model
indexes were initialized and checked; MongoDB/Redis and encrypted settings
validated; the API/provider/outbox workers remained online for over five
minutes; HTTPS listing, authentication rejection, CORS, body limits and signed
webhook validation passed. The reported server regression total is 774 passed,
zero failures, five external opt-in skips. These are reported server results,
not a new independent production acceptance run from the laptop.

The report identified two release packaging errors. The three omitted optional
peer dependency entries are restored in `package-lock.json` to match the server
repair, without changing dependency versions. The Postman checker now uses its
committed `postman/videos-route-inventory.json` instead of an ignored authoring
file. Pull the corrective commit as well; preserve the server's CORS edit and
its original patch/stash. The server lockfile repair should match the corrected
GitHub lockfile after this update.

Bunny's webhook URL remains unconfigured because the available Stream keys
cannot authorize account/library-management requests. A locally signed test
proved endpoint signature handling; it did not prove Bunny-origin delivery.
Authenticated staff, real upload/playback/cleanup, and frontend/device acceptance
remain open. No fresh provider-media or notification test approval is implied
by this packaging correction.

## Enabled encrypted settings

The tracked `.env` contains encrypted values for these settings, all set to
`true` in this release:

| Setting | Purpose | Disable behavior |
|---|---|---|
| `VIDEOS_PUBLIC_ENABLED` | Public editorial Videos, playback and analytics eligibility | Lists hide content; detail/grants fail closed |
| `PRODUCT_VIDEOS_PUBLIC_ENABLED` | Public Product Video feed, gallery, playback and analytics | Product video surfaces become unavailable |
| `REEL_UPLOADS_ENABLED` | Creation of new initial/replacement Reel upload sessions | New allocation returns 503; existing-session management remains available |
| `PRODUCT_VIDEO_UPLOADS_ENABLED` | Creation of Product upload batches and replacements | New allocation returns 503; existing-session management remains available |
| `REEL_UPLOAD_PIPELINE_READY` | Explicit release activation of Reel pipeline | Initial/replacement creation requires this and `REEL_UPLOADS_ENABLED` |
| `VIDEO_COVER_PIPELINE_READY` | Explicit release activation of cover pipeline | New cover POST returns 503; removal remains available |
| `VIDEO_PROVIDER_ORPHAN_RECOVERY_ENABLED` | Worker recovery of ambiguous allocations under exact ownership/generation checks | Automatic orphan recovery is not constructed |

Both readiness switches default to `false` when absent. They record an operator
release decision, not continuous worker health. They retain staff authorization
and all input, ownership, media-generation and provider checks.

No existing `.env` values were changed. The existing MongoDB, Redis, payment,
Firebase and image-storage settings are retained. Stream/YouTube configuration
and switches were added through dotenvx encryption. `.env.keys` is ignored and
must never be committed, shared with frontend developers or logged. The VPS
must have the matching existing private key to decrypt the release environment.

Prime has no global environment switch. With both `primeBoundaryGeometry` and
`primeShippingPrice` unconfigured, normal shipping remains in use. Configure
Prime later through the existing warehouse API after the live client/payment
acceptance described in `PRIME_LOCATION_IMPLEMENTATION_PLAN.md`.

## VPS checkout prerequisite

The read-only server check found `/root/Petyard` on `main`, revision `6f0bf36`,
and an uncommitted edit in `src/app/server.js`. It adds `http://localhost:8080`
to CORS and removes the Product batch body-parser import/mount. Preserve and
review this edit before pulling. Do not reset or overwrite it blindly.

One reversible manual sequence is:

```bash
cd /root/Petyard
git status --short
git diff -- src/app/server.js > /root/petyard-server-before-videos.patch
git stash push -m "preserve server edit before Videos and Prime release" -- src/app/server.js
git pull --ff-only origin main
git stash apply
```

Use `git stash apply` only for the newly created stash after confirming it was
created successfully. Review any conflicts and the resulting server file before
continuing. Keep the newly added Videos imports, Stream configuration validation
and raw webhook middleware. Preserve the local CORS origin if it is still
needed. Review the Product batch parser change in the context of the existing
UI Builder routes; the parser exists in the released repository. The patch and
stash retain the old edit while you resolve this intentionally. If any other
server changes appear, inspect them before pulling as well.

## Dependencies, configuration and indexes

The verified server Node runtime is 22.23.3. The PM2 ecosystem file selects
`/root/.local/opt/node-v22.23.3-linux-x64/bin/node` when present.

```bash
cd /root/Petyard
export PATH="/root/.local/opt/node-v22.23.3-linux-x64/bin:$PATH"
node --version
npm ci --omit=dev
```

Verify `.env.keys` is present and readable by the API/worker user. Do not print
it or dump decrypted environment values. Existing Redis must be reachable.
The configured public image provider must be Bunny for covers/posters. The
Stream library/API/read-only/CDN/token settings and YouTube key must decrypt.

Initialize all Videos indexes before serving frontend traffic. This creates
declared indexes without dropping existing indexes; it does not migrate,
backfill, reprice or delete business records. Stop if initialization fails:

```bash
node --input-type=module <<'NODE'
import '@dotenvx/dotenvx/config';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import mongoose from 'mongoose';
import { validateVideosStreamConfiguration } from './src/domains/videos/provider/streamConfig.js';
import { validateMediaConfiguration } from './src/shared/utils/mediaConfig.js';

try {
  validateVideosStreamConfiguration();
  validateMediaConfiguration();
  assert.ok(process.env.MONGO_URI && process.env.REDIS_URL);
  assert.ok(process.env.YOUTUBE_DATA_API_KEY);
  const root = path.resolve('src/domains/videos');
  const models = [];
  for (const file of fs.readdirSync(root, { recursive: true }).filter(file => file.endsWith('.model.js'))) {
    const module = await import(pathToFileURL(path.join(root, file)).href);
    models.push(...Object.values(module).filter(value => typeof value?.createIndexes === 'function'));
  }
  assert.equal(models.length, 15);
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000, autoIndex: false });
  for (const model of models) {
    await model.createIndexes();
    console.log(`Indexes ready: ${model.modelName}`);
  }
} catch (error) {
  console.error('Videos configuration/index initialization failed', error.code || error.name);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
NODE
```

The provider worker also creates its own 11 model indexes on startup. The
explicit step above additionally covers the analytics and saved-video models
needed by the API; do not rely on automatic index creation in production.

## Start workers and reload the API

After prerequisites pass, use the ecosystem file to start/update the provider
and notification outbox workers and reload the API. Other existing workers
remain defined in the same file:

```bash
pm2 startOrReload ecosystem.config.cjs --env production --update-env
pm2 status
```

Confirm `petyard`, `petyard-video-provider-worker` and
`petyard-notification-outbox-worker` stay online. Review logs locally for startup,
decryption, Mongo/Redis, sweep and provider errors; avoid sharing raw logs that
contain credentials, signed URLs or customer data. Only after startup and smoke
checks pass:

```bash
pm2 save
```

## Signed Bunny webhook and frontend smoke checks

Configure the Stream library's webhook in the Bunny dashboard to:

`https://api.petyardstores.com/api/v1/integrations/bunny-stream/webhook`

The backend validates Bunny's `v1` HMAC-SHA256 signature using the Stream
read-only API key. Configure signed delivery; an unsigned POST should receive
401 `VIDEO_WEBHOOK_INVALID_SIGNATURE`, not a route-not-found response. The
endpoint is public HTTPS but requires a valid provider signature.

Check protected admin routes authenticate correctly, public listing works with
the documented user/guest identity, and the actual frontend origin is allowed
by CORS. API CORS does not configure Bunny TUS/CDN CORS. Set frontend Postman's
`BASE_URL` to the server and retain credentials in local environments/Vault.

Complete one controlled staff upload through allocation, TUS, processing, poster,
protected preview, review/publication and signed playback, then verify deletion
and cleanup. Confirm a real Bunny callback and reconciliation after a missed
callback, worker supervision, cover lifecycle and notification behavior on the
deployed installation. Use only dedicated test content and an explicitly agreed
recipient for any test notification. The earlier bounded provider allowances
are consumed; this GitHub push did not run a new provider canary.

FE implementation may start from `VIDEOS_FRONTEND_HANDOFF.md` immediately.
Deployed end-to-end acceptance remains pending until the server steps above
are completed and verified.

## Operational rollback

Disable new Reel/Product creation and cover readiness first if upload problems
occur. Disable either public flag to hide the corresponding content family.
Update encrypted settings using dotenvx; do not replace secrets with plaintext.
Reload the API after flag changes and restart the provider worker if changing
its orphan-recovery setting. Keep cleanup and notification workers running to
settle existing durable work; do not drop Videos collections/indexes or delete
provider resources manually as a shortcut. Disabling new uploads does not cancel
already-issued TUS grants or in-flight sessions.

Clear Prime geometry and price together through the warehouse API if rolling
back Prime configuration. Existing orders retain their locked shipping amounts.
