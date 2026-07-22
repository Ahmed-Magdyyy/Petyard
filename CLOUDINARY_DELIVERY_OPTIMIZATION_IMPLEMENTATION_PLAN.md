# Cloudinary Delivery Optimization Implementation Plan

Prepared from the active checkout and fresh Cloudinary reports on 2026-07-22.

## Document purpose

This document is the exact implementation handoff for the first Cloudinary
bandwidth-reduction release in the Petyard backend.

It is intentionally narrow. The application is live, the frontend is a released
Flutter Android/iOS application, and orders are actively being placed. The first
release must reduce the largest known source of image bandwidth without changing
the API contract, database data, upload behavior, or order behavior.

## Instructions to the implementing model (Terra)

Follow this plan exactly.

1. Inspect the current versions of every file named in this document before
   editing. Line numbers below are orientation only; use the named functions and
   cache-key strings as anchors.
2. If the current code differs materially from the behavior documented here,
   stop and report the difference. Do not invent a replacement design.
3. Make only the file changes listed in the implementation section.
4. Do not deploy anything.
5. Do not edit `.env`, `.env.keys`, PM2 configuration, Cloudinary assets, MongoDB,
   Redis data, or the Flutter application.
6. Do not call any production write endpoint.
7. Do not add a migration script, rewrite database URLs, replace originals, or
   generate eager Cloudinary transformations.
8. Do not expand optimization to products, banners, users, pets, carts,
   favorites, orders, Instapay screenshots, or any other domain in this release.
9. Run all required local verification and provide the exact command outputs in
   the handoff. Do not claim production verification.
10. At completion, report: changed files, behavior changed, behavior deliberately
    unchanged, tests run, test results, and any deviation from this plan.

The user will have Sol review the complete diff before any deployment or feature
flag activation.

---

## 1. Executive decision

Implement a backend-only, feature-flagged delivery URL optimizer for category and
subcategory GET responses.

When enabled, an eligible original Cloudinary URL from the client's current cloud
is changed only in the API response from:

```text
https://res.cloudinary.com/dxemmiorv/image/upload/v123/petyard/categories/example.png
```

to:

```text
https://res.cloudinary.com/dxemmiorv/image/upload/c_limit,w_480,q_auto:good,f_webp/v123/petyard/categories/example.png
```

The database value remains the original URL. The Cloudinary original remains
untouched. The transformation is produced on delivery and cached by Cloudinary.

The fixed preset is:

```text
c_limit,w_480,q_auto:good,f_webp
```

Why this preset:

- `c_limit,w_480` preserves aspect ratio, limits width to 480 pixels, and does
  not upscale a smaller source.
- `q_auto:good` lets Cloudinary select a sensible visual quality level.
- `f_webp` is deterministic and is supported by Flutter's image stack.
- A single fixed URL per source avoids arbitrary widths and transformation-cache
  fragmentation.
- Explicit WebP avoids `f_auto` producing multiple derived formats for different
  user agents. The current traffic is overwhelmingly Flutter/Dart mobile traffic.

Official references:

- Cloudinary transformation URL structure:
  https://cloudinary.com/documentation/image_transformations
- Cloudinary transformation parameter reference:
  https://cloudinary.com/documentation/transformation_reference
- Cloudinary transformation counting and derived-resource behavior:
  https://cloudinary.com/documentation/transformation_counts
- Flutter-supported image formats, including WebP:
  https://api.flutter.dev/flutter/painting/ImageProvider-class.html

---

## 2. Evidence and expected impact

The fresh Cloudinary reports cover 2026-06-22 through 2026-07-21.

| Metric | Observed value |
| --- | ---: |
| Total requests | 671,155 |
| Total image bandwidth | 42,809,225,003 bytes (about 42.81 decimal GB) |
| PNG bandwidth | 22,374,129,264 bytes (52.26%) |
| WebP bandwidth | 18,770,403,633 bytes (43.85%) |
| Four top category assets | 12,159,086,469 bytes (28.40%) |
| Twenty-five top subcategory assets | 10,511,044,150 bytes (24.55%) |
| Category plus subcategory total | 22,670,130,619 bytes (52.96%) |

The categories and subcategories in the top-delivered report are original PNG
deliveries with an empty transformation. They are the correct first target.

A delivery check was performed on the highest-bandwidth category image
using the exact proposed preset. Cloudinary returned:

| Property | Original | Proposed delivery |
| --- | ---: | ---: |
| Dimensions | 640 x 640 | 480 x 480 |
| Format | PNG | WebP |
| Bytes | 471,812 | 34,232 |
| Reduction | - | 92.74% |

The broader report simulation estimated that applying the 480-pixel WebP preset
to the reported category/subcategory assets would reduce their traffic by about
89.95%, lowering total account bandwidth by roughly 47.6% if request behavior
stays similar.

These are estimates, not a billing guarantee. Cloudinary analytics and billing
must be monitored after release.

The read-only Cloudinary Usage API snapshot available during analysis was last
updated on 2026-07-21 and further confirmed that bandwidth, not storage or
transformations, is the billing problem:

| Small PAYG usage component | Observed value |
| --- | ---: |
| Total credits | 43.76 of 60 (72.93%) |
| Bandwidth | 45,241,560,550 bytes / 42.13 credits |
| Transformations | 1,617 / 1.62 credits |
| Storage | 138,294,879 bytes / 0.01 credit |
| Requests | 709,682 |
| Resources / derived resources | 3,219 / 8 |

The report and Usage API windows do not have identical cutoffs, so their byte and
request totals are expected to differ slightly.

---

## 3. Non-negotiable safety invariants

### 3.1 API contract must not change

The Flutter application must receive the same endpoint paths, status codes,
envelopes, field names, object shapes, field types, null behavior, ordering,
localization behavior, and pagination/query behavior as before.

Only eligible URL string values may differ when the flag is enabled.

Do not normalize the existing inconsistency between category list and category
detail responses. It is part of the live contract.

| Endpoint | Existing image contract | Allowed change |
| --- | --- | --- |
| `GET /api/v1/categories` | `data[].image` is the existing image object, normally `{ public_id, url }`; existing `{}` or `null` behavior must remain | Change only `image.url` when eligible |
| `GET /api/v1/categories/:id` | `data.image` is a string URL or `null` | Change only the URL string when eligible |
| `GET /api/v1/subcategories` | Every root/child `image` is a string URL or `null` | Change only each URL string when eligible |
| `GET /api/v1/subcategories/:id` | `data.image` is a string URL or `null` | Change only the URL string when eligible |

The same rules apply when an authenticated admin receives the additional
language fields. The language fields themselves must not change.

### 3.2 Write responses and storage must not change

Do not change:

- `POST /api/v1/categories`
- `PATCH /api/v1/categories/:id`
- `DELETE /api/v1/categories/:id`
- `PATCH /api/v1/categories/positions`
- `POST /api/v1/subcategories`
- `PATCH /api/v1/subcategories/:id`
- `DELETE /api/v1/subcategories/:id`
- Category or subcategory Mongoose schemas
- Stored `image.public_id` or `image.url`
- Upload processing in `src/shared/utils/imageUpload.js`
- Deletion behavior in Cloudinary

### 3.3 Commerce and payment data must not change

Do not touch any product, cart, favorite, checkout, order, payment, or Instapay
code or data. Instapay screenshots in orders are explicitly out of scope.

### 3.4 Provider boundaries must be respected

Only transform URLs that meet every eligibility rule in section 5. External
images, old Cloudinary-account URLs, already transformed URLs, Bunny URLs, and
malformed values must pass through unchanged.

---

## 4. Current code anchors

These are the current read-time serializer points that need the optimizer:

- `src/domains/category/category.service.js`
  - `getCategoriesService()`: `image: c.image || null`
  - `getCategoryByIdService()`: `image: category.image?.url || null`
- `src/domains/subcategory/subcategory.service.js`
  - `formatSubcategory()`: `image: s.image?.url || null`
  - `getSubcategoryByIdService()`: `image: subcategory.image?.url || null`

The public read responses are Redis-cached as rendered JSON DTOs. Current cache
keys include:

```text
categories:list:v1:<data-version>:<lang>
categories:detail:v1:<data-version>:<id>:<lang>
subcategories:list:v1:<data-version>:<lang>:<query>
subcategories:detail:v1:<data-version>:<id>:<lang>
```

Admin responses with all languages bypass these caches, but they use the same
serializer functions and therefore must receive the same URL treatment.

---

## 5. Target architecture

### 5.1 Request flow

```text
MongoDB original image URL
        |
        v
Existing category/subcategory serializer
        |
        v
Shared image-delivery helper
        |
        +--> flag disabled or URL ineligible: return original value unchanged
        |
        +--> flag enabled and URL eligible: insert one fixed transform segment
        |
        v
Redis caches the rendered response under a delivery-specific namespace
        |
        v
Flutter receives the same JSON contract with a smaller image URL
```

### 5.2 Feature flag

Use exactly this environment variable:

```text
CLOUDINARY_DELIVERY_OPTIMIZATION_ENABLED
```

Parse it using the existing `parseBoolean()` helper from
`src/shared/utils/env.js`, with a default of `false`.

Rules:

- Missing, empty, invalid, or false-like value means disabled.
- `1`, `true`, `yes`, and `on` are enabled, case-insensitively.
- The initial code deployment must be safe when the variable does not exist.
- Changing the flag requires a process restart because configuration is read at
  module startup.

Do not add width, quality, output format, transformation string, or cloud name as
new operator-controlled environment variables. The cloud name already comes from
`CLOUDINARY_CLOUD_NAME`. Keeping the preset in source prevents production typo
variants and cache fragmentation.

### 5.3 Delivery cache namespace

The helper must export a startup-stable cache namespace:

```text
original-v1
```

when disabled, and:

```text
cloudinary-w480-webp-qauto-good-v1
```

when enabled.

This namespace must be included in category/subcategory response cache keys. It
guarantees that:

- Enabling the flag cannot serve an old cached original URL.
- Disabling the flag cannot serve a cached optimized URL.
- Rollback does not require Redis deletion or waiting for the five-minute TTL.
- A future preset change can be isolated by incrementing the namespace version.

Do not add the delivery namespace to
`subcategories:children:v1:<version>:<parentId>`. That cache contains IDs, not
image URLs.

---

## 6. Exact implementation work

### File 1: add `src/shared/utils/imageDelivery.js`

Create one dependency-free delivery helper. It may import only
`parseBoolean` from `./env.js`. It must not import the Cloudinary SDK, access the
network, access MongoDB, or mutate input values.

#### Required constants

Define the fixed transformation once:

```js
const CATEGORY_TILE_TRANSFORMATION =
  "c_limit,w_480,q_auto:good,f_webp";
```

Define semantic presets for category and subcategory tiles. Both use the same
transformation in this release, but they must have separate semantic names so a
later release can change one use case intentionally.

Recommended exported shape:

```js
export const IMAGE_DELIVERY_PRESETS = Object.freeze({
  CATEGORY_TILE: "category-tile",
  SUBCATEGORY_TILE: "subcategory-tile",
});
```

Keep the preset-to-transformation mapping private to the module.

Read startup configuration once:

```js
const optimizationEnabled = parseBoolean(
  process.env.CLOUDINARY_DELIVERY_OPTIMIZATION_ENABLED,
  false,
);

const configuredCloudName =
  typeof process.env.CLOUDINARY_CLOUD_NAME === "string"
    ? process.env.CLOUDINARY_CLOUD_NAME.trim()
    : "";
```

Export:

```js
export const IMAGE_DELIVERY_CACHE_NAMESPACE = optimizationEnabled
  ? "cloudinary-w480-webp-qauto-good-v1"
  : "original-v1";
```

#### Required public functions

Implement and export these functions:

```js
export function getImageDeliveryUrl(url, preset, options = {})
export function getImageObjectWithDeliveryUrl(image, preset, options = {})
```

`options` exists only to make the pure behavior testable without mutating the
real process environment. Support:

```js
{
  enabled = optimizationEnabled,
  cloudName = configuredCloudName,
}
```

Production service calls must not pass `options`; they use startup config.

#### URL eligibility algorithm

`getImageDeliveryUrl()` must return the input unchanged unless all checks pass.
Apply checks in this order:

1. If `enabled` is not true, return the input unchanged.
2. If `url` is not a non-empty string, return it unchanged.
3. If `cloudName` is not a non-empty string, return the URL unchanged.
4. Resolve the transformation from the supplied known preset. If the preset is
   unknown, return the URL unchanged.
5. Parse with the standard `URL` class inside `try/catch`. On parsing failure,
   return the URL unchanged.
6. Require protocol `https:` or `http:`.
7. Require hostname exactly `res.cloudinary.com`.
8. Split `parsedUrl.pathname` on `/` and require this exact leading structure:

   ```text
   /<cloudName>/image/upload/...
   ```

9. Require the first path segment to equal the configured `cloudName`. This is
   critical: do not transform old `dx5n4ekk2` URLs or any third-party Cloudinary
   URL when the configured client cloud is `dxemmiorv`.
10. Find the first segment after `upload` matching `^v\d+$`. If none exists,
    return the URL unchanged. Current stored Cloudinary `secure_url` values are
    versioned, so versionless input should fail closed.
11. Inspect the segments between `upload` and the version. Ignore empty segments
    caused by the report's observed `upload//v...` form. If any non-empty segment
    exists, the URL is already transformed or has an unknown delivery component;
    return it unchanged. Do not stack or replace transformations.
12. Replace all empty segments between `upload` and the version with exactly one
    preset transformation segment. For a normal `upload/v...` path, insert the
    segment before the version.
13. Rebuild the URL using the parsed `URL` object so query parameters and hash
    fragments remain intact.
14. Return the transformed string.

The function must be idempotent: running an already transformed result through
the helper returns the same URL, not a duplicated transformation.

#### Image-object behavior

`getImageObjectWithDeliveryUrl()` is needed only because category list responses
return an image object instead of a URL string.

Required behavior:

1. If `image` is nullish, return it unchanged.
2. If `image.url` is not a non-empty string, return the image unchanged. This
   preserves the current Mongoose nested-object serialization of `{}`.
3. Generate a delivery URL with `getImageDeliveryUrl()`.
4. If the URL did not change, return the original image value unchanged.
5. If the URL changed, create a non-mutating plain-object clone:
   - Use `image.toObject()` when it is a Mongoose subdocument and that method
     exists.
   - Otherwise use object spread.
6. Return the clone with only its `url` property replaced.
7. Preserve `public_id` and any other enumerable serialized keys exactly.
8. Never assign to `image.url` on the Mongoose document.

### File 2: modify `src/domains/category/category.service.js`

Import:

```js
import {
  IMAGE_DELIVERY_CACHE_NAMESPACE,
  IMAGE_DELIVERY_PRESETS,
  getImageDeliveryUrl,
  getImageObjectWithDeliveryUrl,
} from "../../shared/utils/imageDelivery.js";
```

Make only these serializer changes:

1. In `getCategoriesService()` replace the value of `image` with:

   ```js
   image:
     getImageObjectWithDeliveryUrl(
       c.image,
       IMAGE_DELIVERY_PRESETS.CATEGORY_TILE,
     ) || null,
   ```

   Do not change any surrounding response fields.

2. In `getCategoryByIdService()` replace the value of `image` with:

   ```js
   image: getImageDeliveryUrl(
     category.image?.url || null,
     IMAGE_DELIVERY_PRESETS.CATEGORY_TILE,
   ),
   ```

3. Change only the two URL-bearing cache keys to these exact structures:

   ```text
   categories:list:v2:<delivery-namespace>:<data-version>:<lang>
   categories:detail:v2:<delivery-namespace>:<data-version>:<id>:<lang>
   ```

   In code:

   ```js
   `categories:list:v2:${IMAGE_DELIVERY_CACHE_NAMESPACE}:${version}:${normalizedLang}`
   ```

   ```js
   `categories:detail:v2:${IMAGE_DELIVERY_CACHE_NAMESPACE}:${version}:${id}:${normalizedLang}`
   ```

Do not modify upload, update, delete, position, or cache-invalidation functions.

### File 3: modify `src/domains/subcategory/subcategory.service.js`

Import:

```js
import {
  IMAGE_DELIVERY_CACHE_NAMESPACE,
  IMAGE_DELIVERY_PRESETS,
  getImageDeliveryUrl,
} from "../../shared/utils/imageDelivery.js";
```

Make only these serializer changes:

1. In the recursive `formatSubcategory()` result, replace `image` with:

   ```js
   image: getImageDeliveryUrl(
     s.image?.url || null,
     IMAGE_DELIVERY_PRESETS.SUBCATEGORY_TILE,
   ),
   ```

   Because the same formatter is used for every node before tree construction,
   this covers root nodes and nested `children` without changing tree behavior.

2. In `getSubcategoryByIdService()`, replace `image` with:

   ```js
   image: getImageDeliveryUrl(
     subcategory.image?.url || null,
     IMAGE_DELIVERY_PRESETS.SUBCATEGORY_TILE,
   ),
   ```

3. Change only the two URL-bearing cache keys to these exact structures:

   ```text
   subcategories:list:v2:<delivery-namespace>:<data-version>:<lang>:<query>
   subcategories:detail:v2:<delivery-namespace>:<data-version>:<id>:<lang>
   ```

   In code:

   ```js
   `subcategories:list:v2:${IMAGE_DELIVERY_CACHE_NAMESPACE}:${version}:${normalizedLang}:${stableStringify(query || {})}`
   ```

   ```js
   `subcategories:detail:v2:${IMAGE_DELIVERY_CACHE_NAMESPACE}:${version}:${id}:${normalizedLang}`
   ```

Do not change `subcategories:children:v1`, query filtering, recursive tree
construction, search, localization, population, upload, update, or delete logic.

### File 4: add `test/shared/imageDelivery.test.js`

Use Node's built-in `node:test` and `node:assert/strict`. Do not install a test
framework or any new package.

Tests must call the helper with explicit options such as:

```js
const enabledClientConfig = {
  enabled: true,
  cloudName: "dxemmiorv",
};
```

Required test cases:

1. Disabled configuration returns a valid Cloudinary URL exactly unchanged.
2. A normal eligible URL receives exactly
   `c_limit,w_480,q_auto:good,f_webp` between `upload` and the version.
3. The observed `image/upload//v...` form is normalized to one transform segment
   and does not retain a double slash there.
4. Query parameters and hash fragments are preserved.
5. Calling the helper twice is idempotent.
6. A URL with any existing transformation before the version is unchanged.
7. A URL for old cloud `dx5n4ekk2` is unchanged when configured cloud is
   `dxemmiorv`.
8. A non-Cloudinary HTTPS URL is unchanged. Use a Bunny-style hostname in the
   fixture to protect future migration behavior.
9. Cloudinary `video/upload` is unchanged.
10. Cloudinary `raw/upload` is unchanged.
11. A versionless Cloudinary URL is unchanged.
12. A malformed URL is unchanged and does not throw.
13. Empty string, `null`, `undefined`, and non-string values are unchanged and do
    not throw.
14. Unknown preset is unchanged and does not throw.
15. `getImageObjectWithDeliveryUrl()` changes only `url`, preserves `public_id`
    and an extra fixture property, and does not mutate the original object.
16. The object helper preserves `null`, `undefined`, `{}`, and an object without a
    URL exactly.
17. The object helper supports a fixture exposing `toObject()` and preserves its
    serialized keys.

Use a real-shape category fixture, for example:

```js
{
  public_id: "petyard/categories/category_cats_1773192088390",
  url: "https://res.cloudinary.com/dxemmiorv/image/upload/v1773192088/petyard/categories/category_cats_1773192088390.png",
}
```

Tests must not make network calls.

### File 5: modify `package.json`

Add only this script:

```json
"test": "node --test"
```

Keep all existing scripts and dependencies unchanged. Do not edit
`package-lock.json` solely for a script addition.

---

## 7. Required local verification by Terra

Run from the repository root:

```powershell
npm test
```

Then syntax-check every changed JavaScript file:

```powershell
node --check src/shared/utils/imageDelivery.js
node --check src/domains/category/category.service.js
node --check src/domains/subcategory/subcategory.service.js
node --check test/shared/imageDelivery.test.js
```

Then inspect scope:

```powershell
git status --short -uall
git diff --check
git diff -- package.json src/shared/utils/imageDelivery.js src/domains/category/category.service.js src/domains/subcategory/subcategory.service.js test/shared/imageDelivery.test.js
Get-Content -Raw src/shared/utils/imageDelivery.js
Get-Content -Raw test/shared/imageDelivery.test.js
```

The final two reads are required because ordinary `git diff` does not display
untracked new files until they are staged. Terra must not stage, commit, push, or
deploy unless the user separately requests it.

Required result:

- All tests pass.
- All syntax checks exit zero.
- `git diff --check` reports no whitespace errors.
- No dependency or lockfile changes.
- No files outside the five implementation files are modified by Terra.
- This plan file may already exist before Terra starts and must not be rewritten.

Do not start the production server locally if the encrypted `.env` resolves to
the live MongoDB. Unit tests are intentionally pure and do not require the app,
database, Redis, or Cloudinary credentials.

---

## 8. Sol review checklist after Terra finishes

Sol's review should treat the patch as production-critical and verify:

1. The fixed transform string is exactly
   `c_limit,w_480,q_auto:good,f_webp` everywhere.
2. Only the current configured cloud is eligible.
3. Original, external, malformed, versionless, and already transformed URLs fail
   closed and remain unchanged.
4. The helper never mutates Mongoose image objects.
5. The four existing response image types remain unchanged.
6. Recursive subcategory children are covered once, in the existing formatter.
7. Admin all-language response behavior is preserved.
8. Create/update/delete responses are untouched.
9. The four URL-bearing cache keys contain both `v2` and the delivery namespace.
10. The subcategory-children ID cache is untouched.
11. The flag defaults to false.
12. No secrets, database writes, Cloudinary writes, or Flutter changes exist.
13. Unit tests cover every case in section 6.
14. Product, order, cart, favorite, payment, and Instapay files are untouched.

No deployment should happen until this review is complete.

---

## 9. Deployment runbook (operator only, after Sol approval)

These are later operator steps. Terra must not perform them.

### Stage A: deploy dark

1. Ensure the encrypted production environment either omits
   `CLOUDINARY_DELIVERY_OPTIMIZATION_ENABLED` or sets it to `false`.
2. Deploy the reviewed backend code.
3. Restart only the API process, not the notification worker, unless the normal
   deployment procedure restarts both.
4. Verify the API starts, MongoDB and Redis connect, and no new errors appear.
5. Call the four GET routes and verify their image URLs are still original.
6. Confirm ordering, localization, nested subcategory children, and admin language
   fields still work.

Because the disabled namespace is `original-v1`, the dark deployment will use new
cache keys but return original URLs. This is expected and requires no cache flush.

### Stage B: enable optimization

The repository uses an encrypted `.env`. With the normal Dotenvx key workflow,
set the flag using:

```powershell
npx dotenvx set CLOUDINARY_DELIVERY_OPTIMIZATION_ENABLED true
```

Do not expose or commit `.env.keys`. Follow the project's existing encrypted
environment deployment procedure so the production server receives the updated
encrypted `.env` and already has the matching private key.

Restart the API process so module-level config is reloaded. For the current PM2
app name, the operational command is normally:

```bash
pm2 restart petyard
```

Do not guess a different production command if the server's PM2 setup differs;
inspect `pm2 status` first.

### Stage C: immediate smoke tests

Use the actual production API base URL. Do not guess it from old comments in the
repository.

Verify:

1. `GET /api/v1/categories` returns HTTP 200.
2. Every eligible `data[].image.url` contains exactly one
   `/c_limit,w_480,q_auto:good,f_webp/` segment.
3. `data[].image` remains an object where it was an object before.
4. `GET /api/v1/categories/:id` returns an image string or `null`, not an object.
5. `GET /api/v1/subcategories` preserves its tree and every eligible root/child
   image string contains the transform once.
6. `GET /api/v1/subcategories/:id` preserves its image string/null type.
7. Arabic and English requests still return the same localized fields as before.
8. An authenticated admin still receives the additional language fields.
9. The released Android app displays categories and nested subcategories.
10. The released iOS app displays categories and nested subcategories.
11. Product browsing, add-to-cart, checkout, and order placement still work. They
    are not modified, but one smoke order is the final live confidence check.

For an optimized image URL, a header check should show:

```text
HTTP 200
Content-Type: image/webp
Content-Length substantially below the original
```

Use `curl.exe -sS -D - -o NUL "<optimized-url>"` on Windows or
`curl -sS -D - -o /dev/null "<optimized-url>"` on Linux.

### Stage D: monitoring

Monitor at these checkpoints:

- First 15 minutes: API errors, PM2 restarts, Redis errors, image 4xx/5xx, Flutter
  error reporting, and category/subcategory visual loading.
- First hour: repeat Android/iOS browsing checks and inspect API latency/error
  rates.
- 24 hours: compare Cloudinary bandwidth and top-delivered assets with the prior
  daily baseline.
- 3 to 7 days: confirm category/subcategory transformed URLs replace originals in
  the top-delivery report and estimate the new monthly run rate.

Expected Cloudinary side effect: the first request for each unique source/preset
combination creates one derived asset and counts one transformation. Repeated
requests to the identical URL reuse that derived resource. Do not vary transform
parameter order or spelling.

---

## 10. Rollback runbook

Rollback is configuration-only unless a code defect requires reverting the
commit.

1. Set the encrypted flag to false:

   ```powershell
   npx dotenvx set CLOUDINARY_DELIVERY_OPTIMIZATION_ENABLED false
   ```

2. Deliver the updated encrypted environment using the normal production process.
3. Restart the `petyard` API process.
4. Call the four GET endpoints.
5. Confirm URLs are original and contain no delivery transform segment.
6. Confirm Flutter images load.

No MongoDB restore, URL rewrite, Cloudinary deletion, or Redis flush is required.
The `original-v1` cache namespace prevents optimized cached DTOs from leaking into
the disabled response path.

Do not delete derived Cloudinary assets during an incident. They do not affect
the rollback path and deleting them adds unnecessary operational risk.

---

## 11. Acceptance criteria

The first release is complete only when all of these are true:

### Implementation

- The helper is centralized in `src/shared/utils/imageDelivery.js`.
- The feature flag defaults to false.
- The preset is exactly `c_limit,w_480,q_auto:good,f_webp`.
- Only client-cloud, versioned, original `image/upload` URLs are transformed.
- Cache namespaces separate enabled and disabled responses.
- Only four GET serializer points are changed.
- Required unit tests pass.

### Contract

- No endpoint, envelope, field name, type, null behavior, ordering, localization,
  tree structure, or authorization behavior changes.
- Category list image remains an object-shaped value.
- Category detail and subcategory images remain string/null values.
- No database document is changed.
- No upload/delete behavior is changed.
- No Flutter release is required.

### Production

- Released Android and iOS apps render category and subcategory images.
- Optimized URLs return HTTP 200 and `Content-Type: image/webp`.
- Rollback has been rehearsed conceptually and can be completed with a flag change
  plus API restart.
- Cloudinary reports show category/subcategory original bandwidth declining after
  analytics catch up.
- No increase in API errors, image failures, or commerce errors is observed.

---

## 12. Explicitly deferred work

Do not include any of this in the first Terra patch:

1. Product-list image optimization.
2. Product-detail gallery optimization.
3. Banner, brand, collection, pet, user, or service image optimization.
4. Cart, favorite, or order snapshot URL changes.
5. Instapay screenshot movement or delivery changes.
6. Converting or replacing original Cloudinary assets.
7. Rewriting MongoDB URLs.
8. Bunny Storage/CDN migration.
9. Flutter responsive image or cache-package changes.
10. A generic image proxy endpoint.
11. Arbitrary width/quality query parameters.
12. `f_auto`, AVIF, DPR automation, or responsive breakpoint generation.

Each later image surface needs its own usage evidence, visual dimensions, response
contract audit, fixed preset, cache namespace, tests, and staged rollout.

---

## 13. Direction for the later Bunny migration

Bunny remains a sensible candidate because the current workload primarily needs
object storage plus CDN delivery, while Cloudinary bandwidth is the dominant cost
and transformations are barely used. That migration is separate from this
release.

The helper introduced here becomes the provider boundary. A later migration
should preserve the same API fields while changing only returned URL strings.

Recommended later approach:

1. Put a project-owned hostname such as `images.petyardstores.com` in front of the
   chosen CDN so a future provider change does not require another app or database
   migration.
2. Copy and checksum every asset before changing any response URL.
3. Generate a small fixed variant set at upload time with Sharp, for example
   `w480.webp` for tiles and separately justified variants for product detail.
   This avoids depending on a paid dynamic image optimizer when fixed variants
   are enough.
4. Keep Cloudinary originals available during a dual-read transition.
5. Switch one low-risk response surface at a time behind a provider flag.
6. Preserve order history and Instapay screenshots until a dedicated audit and
   retention/security plan is approved.
7. Remove Cloudinary only after database references, logs, API responses, mobile
   smoke tests, and access analytics prove there are no remaining live reads.

Do not let the future Bunny design broaden the first Cloudinary optimization
patch. The safest sequence is: reduce the bill now, observe, then migrate providers
with separate controls.

---

## 14. Final Terra handoff template

Terra must finish with a report in this shape:

```text
Implemented:
- <exact behavior>

Changed files:
- <file and concise change>

Deliberately unchanged:
- Database and stored URLs
- Upload/delete flows
- API response shapes/types
- Product/cart/order/payment/Instapay domains
- Flutter app
- Production environment and deployment

Verification:
- npm test: <pass/fail and test count>
- node --check ...: <pass/fail>
- git diff --check: <pass/fail>

Deviations from plan:
- None
```

If there is any deviation, replace `None` with the exact reason and stop before
deployment. Sol will review the patch next.
