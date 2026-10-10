import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizedYouTubeInput, normalizedReelInput, editedContent, validateDraftPosition,
  validatePublicPosition, validatePublicPositions, validatePermanentDeletion } from '../src/domains/videos/editorial/editorialVideo.validators.js';
import { validateInput } from '../src/domains/videos/reels/reelUpload.validators.js';
import { validateBatch } from '../src/domains/videos/productVideos/productVideo.validators.js';
import { validateAnalyticsBatch, validatePlaybackSessionBody } from '../src/domains/videos/analytics/videoAnalytics.validators.js';
import { processSessionEvents } from '../src/domains/videos/analytics/videoAnalyticsIngestion.service.js';
import { parseProductBatchBody } from '../src/domains/product/productBatch.contract.js';
import { createEditorialVideoService } from '../src/domains/videos/editorial/editorialVideo.service.js';

const collection = JSON.parse(fs.readFileSync(new URL('./Videos.postman_collection.json', import.meta.url), 'utf8'));
const variables = Object.fromEntries(collection.variable.map(v => [v.key, v.value]));
const requests = [];
function walk(items) { for (const item of items) item.item ? walk(item.item) : requests.push(item); }
walk(collection.item);
assert.equal(requests.length, 62);
const rawUrl = request => typeof request.url === 'string' ? request.url : request.url.raw;
const canonical = url => url.replace('{{BASE_URL}}', '').split('?')[0]
  .replace(/\{\{[^}]+\}\}/g, ':param').replace(/:[A-Za-z][A-Za-z0-9_]*/g, ':param');
const routes = JSON.parse(fs.readFileSync(new URL('./videos-route-inventory.json', import.meta.url), 'utf8'));
for (const route of routes) assert(requests.some(({ request: r }) => r.method === route.method && canonical(rawUrl(r)) === canonical(route.url)), `Missing ${route.method} ${route.url}`);
assert(requests.some(i => rawUrl(i.request).endsWith('/integrations/bunny-stream/webhook')));

const expand = value => value.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
  assert(Object.hasOwn(variables, key), `Undefined variable ${key}`); return variables[key];
});
const actor = { id: '64f000000000000000000008', role: 'admin' };
const draftOrderRequest = requests.find(i => canonical(rawUrl(i.request)).endsWith('/draft-position'));
const draftOrderBody = JSON.parse(expand(draftOrderRequest.request.body.raw));
const draftOrderService = createEditorialVideoService({
  repository: {
    create: async () => { throw new Error('Unexpected create'); },
    get: async () => ({ id: variables.video_id, kind: 'reel', status: 'draft', revision: draftOrderBody.revision }),
    setDraftPosition: async (id, revision, draftPosition) => ({ id, revision: revision + 1, draftPosition }),
  },
  verifyYouTube: async () => { throw new Error('Unexpected provider verification'); },
  enqueue: async () => { throw new Error('Unexpected enqueue'); },
});
const draftOrderResult = await draftOrderService.setDraftPosition({ id: variables.video_id, actor, input: draftOrderBody });
assert.deepEqual(JSON.parse(draftOrderRequest.response.find(r => r.code === 200).body), { data: draftOrderResult }, 'Draft-order response must match the service summary, not a full Video');
const queries = new Map([
  ['/api/v1/videos/youtube', ['page', 'limit']], ['/api/v1/videos/feed', ['page', 'limit', 'kind']],
  ['/api/v1/videos/saved', ['page', 'limit', 'kind']], ['/api/v1/videos/admin', ['page', 'limit', 'kind', 'status']],
  ['/api/v1/videos/analytics/reports/daily', ['kind', 'contentId', 'from', 'to', 'page', 'limit']],
  ['/api/v1/videos/admin/provider-operations', ['page', 'limit', 'status', 'type']],
  ['/api/v1/products/:param', ['warehouse']], ['/api/v1/products/batch', ['warehouse']],
]);
let exampleCount = 0;
let validatedBodies = 0;
let nativeTimeline;
for (const item of requests) {
  const r = item.request, url = canonical(rawUrl(r));
  expand(JSON.stringify(r));
  assert(item.response.length, `Missing response ${item.name}`);
  assert(r.description, `Missing documentation ${item.name}`);
  const expectedQueries = url.endsWith('/preview') ? ['asset'] : r.method === 'GET' || url.endsWith('/batch') ? queries.get(url) || [] : [];
  assert.deepEqual((r.url.query || []).map(q => q.key).sort(), [...expectedQueries].sort(), `Queries ${item.name}`);
  if (url.includes('/admin') || (url.includes('/products/:param/videos'))) assert.equal(r.auth.type, 'bearer');
  if (r.body?.mode === 'formdata') {
    assert.deepEqual(r.body.formdata.map(f => [f.key, f.type]), [['cover', 'file']]);
    assert(!r.header.some(h => h.key.toLowerCase() === 'content-type'), 'Multipart boundary must be generated');
  }
  if (r.body?.mode === 'raw') {
    const body = JSON.parse(expand(r.body.raw));
    assert(r.header.some(h => h.key.toLowerCase() === 'content-type' && h.value === 'application/json'));
    if (url === '/api/v1/videos/admin' && r.method === 'POST') body.kind === 'reel' ? normalizedReelInput(body) : normalizedYouTubeInput(body);
    if (url === '/api/v1/videos/admin/:param' && r.method === 'PATCH') editedContent(item.name.includes('YouTube') ? 'youtube' : 'reel', variables, body);
    if (url.endsWith('/draft-position')) validateDraftPosition(body);
    else if (url.endsWith('/positions')) validatePublicPositions(body);
    else if (url.endsWith('/position')) validatePublicPosition(body);
    if (url === '/api/v1/videos/admin/:param' && r.method === 'DELETE') validatePermanentDeletion(variables.video_id, body);
    if (url.includes('/videos/admin') && body.file) validateInput({ videoId: variables.video_id, actor, idempotencyKey: expand(r.header.find(h => h.key === 'Idempotency-Key').value), file: body.file });
    if (url.includes('/products/:param/videos') && (body.file || body.files)) validateBatch({ productId: variables.product_id, actorId: actor.id,
      idempotencyKey: expand(r.header.find(h => h.key === 'Idempotency-Key').value), files: body.files || [body.file] });
    if (url.endsWith('/playback-sessions')) validatePlaybackSessionBody(body);
    if (url.endsWith('/events')) {
      const events = validateAnalyticsBatch(body);
      if (item.name.includes('qualified watch')) nativeTimeline = processSessionEvents({ session: { issuedAt: new Date('2026-10-10T12:00:00Z') },
        events, existing: [], media: { kind: 'reel', contentId: variables.video_id, durationSeconds: 18 }, now: new Date('2026-10-10T12:00:19.100Z').getTime() });
    }
    if (url.endsWith('/products/batch')) parseProductBatchBody(body);
    validatedBodies++;
  }
  for (const response of item.response) {
    assert.equal(response.originalRequest.method, r.method);
    if (response.body) JSON.parse(response.body);
    if (url.endsWith('/reports/daily') && response.code === 200) assert(Array.isArray(JSON.parse(response.body).data));
    if (url.endsWith('/bunny-stream/webhook') && response.code === 202) assert.deepEqual(JSON.parse(response.body), { received: true });
    exampleCount++;
  }
}
assert.equal(nativeTimeline.documents.length, 11);
assert.equal(nativeTimeline.state.watchTimeMs, 17100);
assert.equal(nativeTimeline.documents.filter(e => e.qualifiedViewCounted).length, 1);
const eventTypes = new Set(requests.filter(i => canonical(rawUrl(i.request)).endsWith('/events')).flatMap(i => JSON.parse(i.request.body.raw).events.map(e => e.type)));
assert.equal(eventTypes.size, 11);
for (const key of ['admin_token', 'superadmin_token', 'user_token', 'tus_authorization_signature', 'bunny_webhook_signature']) assert.equal(variables[key], '');
assert.equal(variables.BASE_URL, '');
assert(!collection.event, 'No automatic requests or side effects');
let source = '';
function readSource(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) readSource(p); else if (p.endsWith('.js')) source += fs.readFileSync(p, 'utf8'); } }
readSource('src/domains/videos');
for (const item of requests) for (const response of item.response) if (response.code >= 400) {
  for (const error of JSON.parse(response.body).error || []) if (error.code) assert(source.includes(error.code), `Invented error ${error.code}`);
}
console.log(JSON.stringify({ frontendRoutes: routes.length, webhook: 1, relatedProductRequests: 2, tusHelpers: 2,
  requests: requests.length, responseExamples: exampleCount, validatedBodies, eventTypes: eventTypes.size,
  nativeWatchTimeMs: nativeTimeline.state.watchTimeMs, qualifiedViews: 1, errors: [] }, null, 2));
