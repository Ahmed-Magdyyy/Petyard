# Petyard Backend Plan (Node.js + Express + MongoDB)

Updated: 2025-11-13

Legend: [ ] not started, [~] in progress, [x] done

---

## 0) Top-level decisions

- [x] Language: TypeScript
- [ ] Architecture style: Domain-Driven modular monolith (recommended) vs MVC
- [ ] Coverage approach now: GeoJSON polygons vs city/area mapping
- [ ] Payment methods/providers: Paymob (online), InstaPay, COD (optional future Stripe/PayPal)
- [ ] Shipping providers: Local courier(s)/3PL
- [ ] Prices per warehouse or global price with only per-warehouse stock?
- [ ] Search now (Mongo text index) and later (Algolia/Meilisearch)
- [ ] Environments: dev/staging/prod and deployment target
- [ ] Roles: guest, user, moderator, admin, superAdmin

---

## 1) Foundation (M1)

- [ ] Project scaffold (Express, routes, modules, versioned `/v1`)
- [ ] Env/config loader (dotenv), config validation
- [ ] Logger (pino) + request-id middleware
- [ ] Error handling middleware (consistent `{ error: { code, message, details } }`)
- [ ] Security baseline: helmet, CORS, rate limits, input validation (zod/joi)
- [ ] Response envelope conventions and pagination
- [ ] Health (`/health`) and readiness (`/ready`) endpoints
- [ ] OpenAPI/Swagger docs (swagger-ui-express)
- [ ] MongoDB connection + retry + graceful shutdown

---

## 2) Data model & indexes (M2)

- [ ] `warehouses` (name, active, location Point)
  - [ ] Index: `{ active: 1 }` (optional `{ location: '2dsphere' }`)
- [ ] `coverage_zones` (warehouseId, GeoJSON Polygon/MultiPolygon, active)
  - [ ] Index: `{ zone: '2dsphere' }`, `{ warehouseId: 1 }`, `{ active: 1 }`
  - [ ] No-overlap policy or priority resolution
- [ ] `categories` (hierarchy, slug, active)
  - [ ] Index: `{ slug: 1, unique: true }`, `{ path: 1 }`, `{ active: 1 }`
- [ ] `brands` (name, slug)
  - [ ] Index: `{ slug: 1, unique: true }`
- [ ] `products` (sku, title, slug, description, images, categoryIds, brandId, attributes, status)
  - [ ] Index: `{ slug: 1, unique: true }`, `{ categoryIds: 1 }`, `{ brandId: 1 }`, `{ status: 1 }`
  - [ ] Text index: `title`, `description`, `attributes.keywords`
- [ ] `skus` (variants: attributes, basePrice, active)
  - [ ] Index: `{ productId: 1 }`, `{ sku: 1, unique: true }`
- [ ] `inventory` (warehouseId, productId/skuId, quantity, reserved)
  - [ ] Unique index: `{ warehouseId: 1, skuId: 1 }`
- [ ] `price_rules` (optional per-warehouse price overrides)
  - [ ] Index: `{ warehouseId: 1, skuId: 1 }`, `{ activeFrom: 1, activeTo: 1 }`
- [ ] `carts` (userId/sessionId, warehouseId, items[], expiresAt)
  - [ ] Index: `{ userId: 1 }`, `{ sessionId: 1 }`, TTL on `expiresAt`
- [ ] `orders` (userId?, warehouseId, items[], totals, address, shipping, status, payment)
  - [ ] Index: `{ userId: 1, createdAt: -1 }`, `{ warehouseId: 1, createdAt: -1 }`, `{ status: 1 }`
- [ ] `payments` (orderId, provider, intentId, status, amount)
  - [ ] Index: `{ orderId: 1 }`, `{ provider: 1, intentId: 1, unique: true }`
- [ ] `promotions` (code, rules, warehouseId?, windows, status)
  - [ ] Index: `{ code: 1, unique: true }`, `{ warehouseId: 1 }`, `{ activeFrom: 1, activeTo: 1 }`, `{ status: 1 }`
- [ ] `shipments` (orderId, carrier, trackingNumber, status)
  - [ ] Index: `{ orderId: 1 }`, `{ trackingNumber: 1 }`
- [ ] `users` (email, phone, passwordHash, roles, addresses)
  - [ ] Index: `{ email: 1, unique: true }`, `{ phone: 1, sparse: true }`
- [ ] `sessions/tokens` (userId, refreshToken, expiresAt)
  - [ ] Index: TTL on `expiresAt`, `{ userId: 1 }`
- [ ] `reviews`, `wishlists`, `notifications`, `audit_logs` (as needed)
- [ ] `wallet_ledger` (userId, type: credit/debit, amount, balance, refType/refId, createdAt)
  - [ ] Index: `{ userId: 1, createdAt: -1 }`
- [ ] `loyalty_ledger` (userId, points, balance, reason, expiresAt)
  - [ ] Index: `{ userId: 1, expiresAt: 1 }`
- [ ] `pet_profiles` (userId, type, breed, age, gender, conditions[], preferences)
  - [ ] Index: `{ userId: 1 }`
- [ ] `addresses` (if separate): userId, label, details, phone, location Point (geocoded)
  - [ ] Index: `{ userId: 1 }`, `{ location: '2dsphere' }`

---

## 3) Warehouse resolution (M2)

- [ ] Endpoint: `GET /v1/warehouse/resolve?lat=&lng=` returns `{ warehouseId }`
- [ ] Middleware: `x-warehouse-id` header or lat/lng fallback -> `res.locals.warehouseId`
- [ ] 2dsphere index on `coverage_zones.zone`
- [ ] Cache hotspot resolutions (optional Redis)
- [ ] Edge policy for boundary/overlap
- [ ] User addresses are geocoded to lat/lng and validated against coverage zones during checkout

---

## 4) Catalog (M2)

- [ ] `GET /v1/catalog/products` with filters (category, brand, text, price range, attributes)
- [ ] `GET /v1/catalog/products/:id`
- [ ] `GET /v1/catalog/categories`, `GET /v1/catalog/brands`
- [ ] Scope by `warehouseId` (hide OOS or show stock counts)
- [ ] Sorting/pagination, facets

---

## 5) Inventory (M3)

- [ ] Read stock per warehouse + sku/product
- [ ] Atomic reservation: `findOneAndUpdate({ qty >= n })` with `$inc { quantity: -n, reserved: +n }`
- [ ] Release/commit reserved on cancel/payment success
- [ ] Admin restock/adjust endpoints
- [ ] Option: reservations TTL collection

---

## 6) Cart & Pricing (M4)

- [ ] Single-warehouse cart enforcement
- [ ] Guest carts (sessionId) and user carts (merge on login)
- [ ] Add/update/remove items, validate stock atomically
- [ ] Pricing service (base price + price_rules + promos)
- [ ] Taxes and fees computation (configurable per warehouse/region)

---

## 7) Checkout & Orders (M5)

- [ ] `POST /v1/checkout/quote` (totals, shipping options, ETA)
- [ ] `POST /v1/orders` (idempotent key) -> creates order + reserves inventory (txn)
- [ ] Order status machine: `created -> paid -> picking -> shipped -> delivered` (+ `cancelled/refunded`)
- [ ] `GET /v1/orders/:id`, `GET /v1/orders`

---

## 8) Payments (M5)

- [ ] Provider abstraction: Paymob (online payments)
  - [ ] Verify HMAC/signature, amount/currency; handle success/failure callbacks
  - [ ] Webhooks endpoint(s) to update payment + order state
- [ ] COD flow: risk checks (limits, OTP), confirm and mark as `cod_pending` -> `paid` on delivery confirmation
- [ ] InstaPay flow: user transfer proof upload or auto-matching; async job to reconcile and mark order `paid`
- [ ] Refunds/voids and reconciliation job for all payment methods

---

## 9) Shipping & Delivery (M6)

- [ ] Per-warehouse shipping rules & carriers
- [ ] `POST /v1/shipping/rates`
- [ ] Create labels, track shipments, update events
- [ ] Delivery ETA logic and address validation

---

## 10) Promotions (M7)

- [ ] Coupon codes (apply/remove) with eligibility rules
- [ ] Catalog/cart rules; stacking policy; per-warehouse overrides
- [ ] Usage limits per user / global, validity windows

---

## 11) User & Auth (M1-M2)

- [ ] Signup/login with email/password (hashing, lockout, rate limit)
- [ ] Email verification, password reset
- [ ] Refresh tokens (TTL), revoke on logout
- [ ] Roles and RBAC middleware (guest implicit, user, moderator, admin, superAdmin)
  - [ ] Warehouse-scoped admin permissions; audit logging of privileged actions
- [ ] Optional: OAuth, MFA

---

## 12) Customer features (M8)

- [ ] Wishlist
- [ ] Recently viewed
- [ ] Reviews & Q&A (moderation + anti-abuse)
- [ ] Notifications: email/push (order status, promos)
- [ ] Wallet: ledger (credit/debit), top-ups, refunds, admin adjustments, withdrawal rules
- [ ] Loyalty program: points earn/burn, tiers, expiration, synergy with promotions
- [ ] Pet profiles: type, breed, age, gender, conditions, preferences; optional recommendations

---

## 13) Admin/Backoffice (M9)

- [ ] CRUD: warehouses, zones (polygon UI), categories, brands, products, skus
- [ ] Inventory adjustments, purchase orders (optional), stock reports
- [ ] Orders overview, cancellations, refunds
- [ ] Promotions management
- [ ] Users management and roles
- [ ] Audit logs for sensitive actions
- [ ] Admins can be restricted to specific warehouses; data scoped by assignment

---

## 14) Search (M2/M8)

- [ ] Mongo text index for initial search
- [ ] Faceting & sorting
- [ ] Plan migration to Algolia/Meilisearch (jobs for sync)

---

## 15) Observability (M1/M10)

- [ ] Structured logs (pino), correlation id
- [ ] Basic metrics (req count, latency, errors)
- [ ] Error tracking (Sentry or similar)
- [ ] Access logs and audit logs (admin actions)

---

## 16) Security & Compliance (ongoing)

- [ ] Input validation everywhere (zod/joi) + sanitize
- [ ] Rate limit and IP allow/deny lists for admin
- [ ] Secrets in env/secret manager; never commit
- [ ] JWT best practices, HTTPS everywhere
- [ ] PII minimization, data retention, GDPR/DSAR workflows
- [ ] Backups and restore drills

---

## 17) Testing & CI/CD (M1-M10)

- [ ] Unit tests (services, utils)
- [ ] Integration tests (supertest + mongodb-memory-server)
- [ ] E2E tests (happy paths: browse -> cart -> pay -> ship)
- [ ] Seed scripts and fixtures
- [ ] CI pipeline (lint, test, build)
- [ ] CD pipeline (staging/prod, env config)

---

## 18) Data Ops (M10)

- [ ] Backup/restore strategy and schedule
- [ ] Data migrations/versioning strategy
- [ ] Anonymization for staging data
- [ ] Archival policies (orders/logs)

---

## 19) API inventory (reference)

- [ ] `/v1/warehouse/resolve` (lat,lng)
- [ ] `/v1/catalog/products`, `/v1/catalog/products/:id`
- [ ] `/v1/catalog/categories`, `/v1/catalog/brands`
- [ ] `/v1/cart` (get/create), `/v1/cart/items` (post/patch/delete)
- [ ] `/v1/checkout/quote`
- [ ] `/v1/orders` (post, list), `/v1/orders/:id`
- [ ] `/v1/payments/paymob/*` (init, callback, webhook)
- [ ] `/v1/payments/cod` (init/confirm)
- [ ] `/v1/payments/instapay` (init/proof, verify)
- [ ] `/v1/shipping/rates`, `/v1/shipments/:id`
- [ ] `/v1/auth/*`, `/v1/users/*`
- [ ] `/v1/wallet/*` (balance, transactions)
- [ ] `/v1/loyalty/*` (points, earn/burn)
- [ ] `/v1/pets/*` (pet profiles CRUD)
- [ ] `/v1/addresses/*`
- [ ] `/v1/admin/*` for backoffice

---

## 20) Environment variables (starter list)

- [ ] `PORT`, `NODE_ENV`
- [ ] `MONGODB_URI`
- [ ] `JWT_SECRET`, `REFRESH_TOKEN_TTL`
- [ ] `CORS_ORIGIN`
- [ ] `RATE_LIMIT_MAX`
- [ ] `PAYMOB_API_KEY`, `PAYMOB_HMAC_SECRET`, `PAYMOB_INTEGRATION_ID`
- [ ] `INSTAPAY_API_KEY` (if applicable)
- [ ] `COD_MAX_ORDER_VALUE`, `COD_OTP_ENABLED`
- [ ] `REDIS_URL` (if Redis/BullMQ)
- [ ] `LOG_LEVEL`
- [ ] `WALLET_ENABLED`, `LOYALTY_ENABLED`

---

## Warehouse-specific rules (summary)

- [ ] Exactly one warehouse per order/cart
- [ ] Catalog results are scoped by resolved `warehouseId`
- [ ] Inventory is per-warehouse; use atomic reservation
- [ ] Shipping options/rates depend on warehouse origin -> destination
- [ ] Coverage zones stored as GeoJSON polygons with 2dsphere indexes
- [ ] Admin access can be restricted per-warehouse for management operations

---

## Open questions to resolve

- [ ] Do prices vary by warehouse? If yes, enable `price_rules` per warehouse.
- [ ] What’s the fallback if location permissions are denied? Manual area select?
- [ ] Do zones overlap? If so, define deterministic priority.
- [ ] Which customer features are in v1 vs later (reviews, wishlist)?
- [ ] SLA/SLI goals (latency, error rates) and limits.

---

How to use: check items as you complete them. We can keep this file updated via PRs. 
