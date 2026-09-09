import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Session } from '@shopify/shopify-api';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { createApp, resolveCustomBlog } from '../src/app.js';
import { startDeliveryStub } from './stub-delivery.js';
import { startShopifyStub } from './stub-shopify.js';

const SHOP = 'test-shop.myshopify.com';
const API_KEY = 'testapikey123';
const API_SECRET = 'testapisecret456';
const HOST_PARAM = Buffer.from('admin.shopify.com/store/test-shop').toString('base64');

let delivery;
let shopify;
let db;
let server;
let base;

before(async () => {
  delivery = await startDeliveryStub();
  shopify = await startShopifyStub({ shop: SHOP });
  const config = loadConfig({
    SHOPIFY_API_KEY: API_KEY,
    SHOPIFY_API_SECRET: API_SECRET,
    HOST: 'https://app.example.test',
    DAILYSMITH_API_BASE: delivery.url,
    SHOPIFY_ADMIN_URL_OVERRIDE: shopify.url,
    SYNC_INTERVAL_MINUTES: '60',
  });
  db = openDatabase(':memory:');
  const { app } = createApp({ config, db, log: () => {} });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await delivery.close();
  await shopify.close();
});

// An App Bridge session token: HS256 over the app secret, audience = the
// app's client id, dest = the shop.
function sessionToken({ secret = API_SECRET, aud = API_KEY, shop = SHOP, expiresIn = 60 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc({ iss: `https://${shop}/admin`, dest: `https://${shop}`, aud, sub: '1', exp: now + expiresIn, nbf: now - 5, iat: now, jti: crypto.randomUUID(), sid: 'sid-1' });
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

async function storeOfflineSession() {
  await db.sessions.storeSession(new Session({ id: `offline_${SHOP}`, shop: SHOP, state: '', isOnline: false, accessToken: shopify.accessToken, scope: 'read_content,write_content' }));
}

async function api(method, path, { body, token = sessionToken() } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  let json = null;
  try { json = await res.clone().json(); } catch {}
  return { status: res.status, json, headers: res.headers, text: await res.text() };
}

test('healthz', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.deepEqual(await res.json(), { ok: true, mode: 'oauth' });
});

test('the app root demands a shop, embeds itself, and serves the page inside the admin', async () => {
  assert.equal((await fetch(`${base}/`, { redirect: 'manual' })).status, 400);
  assert.equal((await fetch(`${base}/?shop=not-a-shop`, { redirect: 'manual' })).status, 422);

  const top = await fetch(`${base}/?shop=${SHOP}&host=${HOST_PARAM}`, { redirect: 'manual' });
  assert.equal(top.status, 302);
  assert.equal(top.headers.get('location'), `https://admin.shopify.com/store/test-shop/apps/${API_KEY}/`);

  const embedded = await fetch(`${base}/?shop=${SHOP}&host=${HOST_PARAM}&embedded=1`);
  assert.equal(embedded.status, 200);
  assert.match(embedded.headers.get('content-security-policy'), new RegExp(`frame-ancestors https://${SHOP} https://admin.shopify.com`));
  const html = await embedded.text();
  assert.ok(html.includes(`<meta name="shopify-api-key" content="${API_KEY}">`));
  assert.ok(html.includes('cdn.shopify.com/shopifycloud/app-bridge.js'));
  assert.ok(html.includes('Sync now'));
});

test('the settings API refuses a missing or forged session token', async () => {
  const noToken = await fetch(`${base}/api/settings`);
  assert.equal(noToken.status, 200, 'a document request without a token gets the App Bridge bounce, not data');
  assert.ok((await noToken.text()).includes('app-bridge.js'));

  const forged = await api('GET', '/api/settings', { token: sessionToken({ secret: 'wrong' }) });
  assert.equal(forged.status, 401);
  const wrongApp = await api('GET', '/api/settings', { token: sessionToken({ aud: 'someone-else' }) });
  assert.equal(wrongApp.status, 401);
});

test('settings: read with defaults, validate, save (key is write-only), test, sync', async () => {
  await storeOfflineSession();

  let r = await api('GET', '/api/settings');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.shop, SHOP);
  assert.equal(r.json.apiBase, delivery.url);
  assert.equal(r.json.apiBaseLocked, true);
  assert.equal(r.json.publicKeyMasked, '');
  assert.deepEqual(r.json.blogs, [{ id: 'gid://shopify/Blog/1', title: 'News', handle: 'news' }]);
  assert.equal(r.json.blogId, 'gid://shopify/Blog/1', 'the store\'s only blog is the default target');
  assert.equal(r.json.authorName, 'Test Shop', 'author defaults to the store name');
  assert.equal(r.json.configured, false);
  assert.equal(r.json.syncIntervalMinutes, 60);

  r = await api('PUT', '/api/settings', { body: { publicKey: 'not-a-key' } });
  assert.equal(r.status, 422);
  assert.match(r.json.errors[0], /starts with pk_/);

  r = await api('PUT', '/api/settings', { body: { publicKey: 'pk_smoke', publish: false, authorName: 'Editorial', apiBase: 'http://169.254.169.254', blogId: 'gid://shopify/Blog/1' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.publicKeyMasked, 'pk_…');
  assert.equal(r.json.publish, false);
  assert.equal(r.json.authorName, 'Editorial');
  assert.equal(r.json.apiBase, delivery.url, 'a locked API base ignores what the client sent');
  assert.equal(r.json.configured, true);
  assert.ok(r.json.nextSyncAt > 0);

  r = await api('PUT', '/api/settings', { body: { publicKey: '', publish: true } });
  assert.equal(r.json.publicKeyMasked, 'pk_…', 'an empty key field keeps the stored key');
  assert.equal(r.json.publish, true);

  r = await api('PUT', '/api/settings', { body: { blogId: 'gid://shopify/Blog/999' } });
  assert.equal(r.status, 422);

  r = await api('POST', '/api/test');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true, blogs: [{ name: 'Smoke Blog', basePath: '/blog' }] });

  r = await api('POST', '/api/sync');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.summary, 'Created 2, updated 0, unchanged 0, withdrawn 0.');
  assert.equal(r.json.lastResult, r.json.summary);
  assert.equal(shopify.byMarker('01a09000-0000-7000-8000-000000000001').length, 1);
  assert.equal(shopify.byMarker('01a09000-0000-7000-8000-000000000001')[0].author, 'Editorial');
});

function signedWebhook(topic, payload, { secret = API_SECRET, shop = SHOP } = {}) {
  const raw = JSON.stringify(payload);
  const hmac = crypto.createHmac('sha256', secret).update(raw).digest('base64');
  return fetch(`${base}/api/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': topic,
      'x-shopify-hmac-sha256': hmac,
      'x-shopify-shop-domain': shop,
      'x-shopify-api-version': '2026-01',
      'x-shopify-webhook-id': crypto.randomUUID(),
    },
    body: raw,
  });
}

test('webhooks: a forged signature is refused; compliance topics answer 200; uninstall forgets the shop', async () => {
  await storeOfflineSession();
  assert.ok(db.shops.get(SHOP), 'precondition: the shop has settings');
  assert.ok(db.articles.count(SHOP) > 0, 'precondition: the shop has an index');

  assert.equal((await signedWebhook('app/uninstalled', { id: 1 }, { secret: 'wrong' })).status, 401);
  assert.ok(db.shops.get(SHOP), 'nothing was forgotten on a forged webhook');

  assert.equal((await signedWebhook('customers/data_request', { shop_domain: SHOP })).status, 200);
  assert.equal((await signedWebhook('customers/redact', { shop_domain: SHOP })).status, 200);
  assert.ok(db.shops.get(SHOP), 'customer topics leave the shop alone (nothing to redact)');

  assert.equal((await signedWebhook('app/uninstalled', { id: 1 })).status, 200);
  assert.equal(db.shops.get(SHOP), null);
  assert.equal(db.articles.count(SHOP), 0);
  assert.deepEqual(await db.sessions.findSessionsByShop(SHOP), []);

  await storeOfflineSession();
  db.shops.upsert(SHOP, { api_base: delivery.url, public_key: 'pk_smoke', blog_id: 'gid://shopify/Blog/1' });
  assert.equal((await signedWebhook('shop/redact', { shop_domain: SHOP })).status, 200);
  assert.equal(db.shops.get(SHOP), null);
});

test('custom (single-store) mode: configured from the environment, no OAuth surface, syncs', async () => {
  const stub = await startShopifyStub({ shop: 'single.myshopify.com', accessToken: 'shpat_custom' });
  try {
    const config = loadConfig({
      SHOPIFY_CUSTOM_APP_TOKEN: 'shpat_custom',
      SHOP: 'single.myshopify.com',
      DAILYSMITH_PUBLIC_KEY: 'pk_smoke',
      DAILYSMITH_API_BASE: delivery.url,
      SHOPIFY_BLOG_HANDLE: 'news',
      SHOPIFY_ADMIN_URL_OVERRIDE: stub.url,
      AUTHOR_NAME: 'Custom Author',
    });
    assert.equal(config.mode, 'custom');
    const cdb = openDatabase(':memory:');
    const { app, runForShop, shopify: sdk } = createApp({ config, cdb, db: cdb, log: () => {} });
    assert.equal(sdk, null);
    const row = await resolveCustomBlog({ config, db: cdb });
    assert.equal(row.blog_id, 'gid://shopify/Blog/1');
    assert.equal(await runForShop('single.myshopify.com'), 'Created 2, updated 0, unchanged 0, withdrawn 0.');
    assert.equal(stub.articlesInBlog()[0].author, 'Custom Author');

    const s = app.listen(0, '127.0.0.1');
    await new Promise((r) => s.once('listening', r));
    const port = s.address().port;
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/settings`)).status, 404, 'no settings API in custom mode');
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/healthz`)).json(), { ok: true, mode: 'custom' });
    s.close();
  } finally {
    await stub.close();
  }
});

test('config: custom mode needs a myshopify domain; oauth mode needs the app credentials', () => {
  assert.throws(() => loadConfig({ SHOPIFY_CUSTOM_APP_TOKEN: 'x', SHOP: 'example.com' }), /myshopify domain/);
  assert.throws(() => loadConfig({}), /SHOPIFY_API_KEY/);
  const c = loadConfig({ SHOPIFY_API_KEY: 'k', SHOPIFY_API_SECRET: 's', SYNC_INTERVAL_MINUTES: 'garbage' });
  assert.equal(c.syncIntervalMs, 3_600_000, 'a bad interval falls back to hourly');
  assert.deepEqual(c.scopes, ['read_content', 'write_content']);
});
