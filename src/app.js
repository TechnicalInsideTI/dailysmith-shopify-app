// The Express app: Shopify install and session handling from
// @shopify/shopify-app-express, the settings API, the webhooks, and the
// embedded settings page. Exported as a factory so the tests can build it
// against stub APIs; server.js is the thin process wrapper.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { shopifyApp, ApiVersion } from '@shopify/shopify-app-express';
import { DeliveryMethod } from '@shopify/shopify-api';
import { isConfigured } from './db.js';
import { DeliveryApi } from './delivery-api.js';
import { ShopifyAdmin } from './shopify-admin.js';
import { SyncEngine } from './engine.js';
import { isShopDomain } from './config.js';

// Pinned rather than "latest": the article mutations and the metafield
// inputs this app uses are stable from 2024-10 on, and a version bump should
// be a deliberate change here, not a side effect of a library update.
export const ADMIN_API_VERSION = ApiVersion.January26;

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = fs.readFileSync(path.join(here, '..', 'public', 'index.html'), 'utf8');

export function createApp({ config, db, log = console.log, fetch = globalThis.fetch }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // ---- what every mode shares: syncing a shop ---------------------------

  async function accessTokenFor(shop) {
    if (config.mode === 'custom') {
      return shop === config.custom.shop ? config.custom.accessToken : '';
    }
    const sessions = await db.sessions.findSessionsByShop(shop);
    const offline = sessions.find((s) => !s.isOnline && s.accessToken);
    return offline?.accessToken || '';
  }

  function adminFor(shop, accessToken) {
    return new ShopifyAdmin({ shop, accessToken, apiVersion: ADMIN_API_VERSION, baseUrl: config.adminUrlOverride, fetch });
  }

  function deliveryFor(row) {
    return new DeliveryApi({ apiBase: row.api_base, publicKey: row.public_key, fetch, userAgent: `dailysmith-shopify-app (${row.shop})` });
  }

  async function runForShop(shop, { reconcile = 'auto' } = {}) {
    const row = db.shops.get(shop);
    if (!row) throw new Error('unknown shop');
    const accessToken = await accessTokenFor(shop);
    if (!accessToken) throw new Error('no access token for this shop (was the app uninstalled?)');
    const engine = new SyncEngine({
      db,
      shop,
      admin: adminFor(shop, accessToken),
      delivery: deliveryFor(row),
      reconcileIntervalMs: config.reconcileIntervalMs,
      log,
    });
    return engine.run({ reconcile });
  }

  app.get('/healthz', (_req, res) => res.json({ ok: true, mode: config.mode }));

  if (config.mode === 'custom') {
    // One store, configured from the environment: no OAuth, no UI.
    seedCustomShop(config, db);
    return { app, shopify: null, runForShop, accessTokenFor };
  }

  // ---- oauth mode: a real Shopify app ------------------------------------

  const [hostScheme, hostName] = splitHost(config.host);
  const shopify = shopifyApp({
    api: {
      apiKey: config.apiKey,
      apiSecretKey: config.apiSecret,
      scopes: config.scopes,
      hostScheme,
      hostName,
      apiVersion: ADMIN_API_VERSION,
      isEmbeddedApp: true,
      userAgentPrefix: 'dailysmith-shopify-app',
    },
    auth: { path: '/api/auth', callbackPath: '/api/auth/callback' },
    webhooks: { path: '/api/webhooks' },
    sessionStorage: db.sessions,
    // Shopify managed installation: the merchant installs from Shopify, the
    // embedded page gets a session token from App Bridge, and the first
    // authenticated request exchanges it for an offline access token. No
    // OAuth redirect dance, no third-party cookies.
    future: { tokenExchange: true },
    hooks: {
      afterAuth: async ({ session }) => {
        db.shops.upsert(session.shop, {
          api_base: db.shops.get(session.shop)?.api_base || config.dailysmithApiBase,
          installed_at: Math.floor(Date.now() / 1000),
        });
        await shopify.registerWebhooks({ session });
      },
    },
  });

  const forget = async (_topic, shop) => {
    db.forgetShop(shop);
    log(`[webhook] forgot ${shop}`);
  };
  const webhookHandlers = {
    APP_UNINSTALLED: { deliveryMethod: DeliveryMethod.Http, callbackUrl: '/api/webhooks', callback: forget },
    // Mandatory compliance topics. This app stores no customer data at all:
    // sessions, settings and an article index, all per shop. A data request
    // has nothing to return; a shop redaction is the same forgetting as an
    // uninstall.
    CUSTOMERS_DATA_REQUEST: { deliveryMethod: DeliveryMethod.Http, callbackUrl: '/api/webhooks', callback: async () => {} },
    CUSTOMERS_REDACT: { deliveryMethod: DeliveryMethod.Http, callbackUrl: '/api/webhooks', callback: async () => {} },
    SHOP_REDACT: { deliveryMethod: DeliveryMethod.Http, callbackUrl: '/api/webhooks', callback: forget },
  };

  app.get(shopify.config.auth.path, shopify.auth.begin());
  app.get(shopify.config.auth.callbackPath, shopify.auth.callback(), shopify.redirectToShopifyOrAppRoot());
  app.post(shopify.config.webhooks.path, shopify.processWebhooks({ webhookHandlers }));

  // ---- the settings API (session-token authenticated) --------------------

  const api = express.Router();
  api.use(express.json({ limit: '64kb' }));

  api.get('/settings', async (req, res) => {
    const shop = res.locals.shopify.session.shop;
    const token = res.locals.shopify.session.accessToken;
    let row = db.shops.get(shop) || db.shops.upsert(shop, { api_base: config.dailysmithApiBase });
    let blogs = [];
    let shopName = '';
    try {
      ({ blogs, shopName } = await adminFor(shop, token).shopAndBlogs());
    } catch (err) {
      return res.status(502).json({ error: `Could not read the store's blogs: ${err.message}` });
    }
    // First visit: default the author to the store's name and the target
    // blog to the store's only blog when there is exactly one.
    const patch = {};
    if (!row.author_name && shopName) patch.author_name = shopName;
    if (!row.blog_id && blogs.length === 1) Object.assign(patch, { blog_id: blogs[0].id, blog_title: blogs[0].title });
    if (Object.keys(patch).length) row = db.shops.upsert(shop, patch);
    res.json(view(row, { blogs, shopName }));
  });

  api.put('/settings', async (req, res) => {
    const shop = res.locals.shopify.session.shop;
    const token = res.locals.shopify.session.accessToken;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (!db.shops.get(shop)) db.shops.upsert(shop, { api_base: config.dailysmithApiBase });
    const errors = [];
    const patch = {};

    if (config.allowCustomApiBase && typeof body.apiBase === 'string') {
      const base = normaliseApiBase(body.apiBase);
      if (base) patch.api_base = base;
      else errors.push('The API base URL must be a plain http(s) origin, e.g. https://api.dailysmith.com.');
    }
    // The site key is write-only: an empty field keeps the stored key.
    if (typeof body.publicKey === 'string' && body.publicKey.trim()) {
      const key = body.publicKey.trim();
      if (/^pk_[A-Za-z0-9_]+$/.test(key)) patch.public_key = key;
      else errors.push('That does not look like a site key. It starts with pk_ and is on your site\'s settings page in the DailySmith dashboard.');
    }
    if (typeof body.blogId === 'string' && body.blogId) {
      try {
        const { blogs } = await adminFor(shop, token).shopAndBlogs();
        const blog = blogs.find((b) => b.id === body.blogId);
        if (blog) Object.assign(patch, { blog_id: blog.id, blog_title: blog.title });
        else errors.push('That blog does not exist in this store any more.');
      } catch (err) {
        errors.push(`Could not read the store's blogs: ${err.message}`);
      }
    }
    if (typeof body.publish === 'boolean') patch.publish = body.publish;
    if (typeof body.syncEnabled === 'boolean') patch.sync_enabled = body.syncEnabled;
    if (typeof body.authorName === 'string') patch.author_name = body.authorName.trim().slice(0, 120);

    if (errors.length) return res.status(422).json({ errors });
    const row = db.shops.upsert(shop, patch);
    log(`[settings] ${shop}: saved (${Object.keys(patch).join(', ') || 'nothing changed'})`);
    res.json(view(row, {}));
  });

  // Test connection: list the site's blogs with the SAVED settings, so the
  // test proves what the scheduler will actually run with.
  api.post('/test', async (_req, res) => {
    const shop = res.locals.shopify.session.shop;
    const row = db.shops.get(shop);
    if (!row?.api_base || !row?.public_key) return res.status(422).json({ error: 'Save the site key first, then test.' });
    try {
      const blogs = await deliveryFor(row).blogs();
      res.json({ ok: true, blogs: blogs.map((b) => ({ name: b.name || '', basePath: b.base_path || '' })) });
    } catch (err) {
      res.status(502).json({ ok: false, error: `Connection failed: ${err.message}` });
    }
  });

  api.post('/sync', async (_req, res) => {
    const shop = res.locals.shopify.session.shop;
    if (!isConfigured(db.shops.get(shop))) return res.status(422).json({ error: 'Not configured: save the site key and pick a Shopify blog first.' });
    try {
      const summary = await runForShop(shop, { reconcile: 'auto' });
      res.json({ summary, ...view(db.shops.get(shop), {}) });
    } catch (err) {
      res.status(500).json({ error: `Sync failed: ${err.message}` });
    }
  });

  app.use('/api', shopify.validateAuthenticatedSession(), api);

  // ---- the embedded page -------------------------------------------------

  const page = INDEX_HTML.replace(/__SHOPIFY_API_KEY__/g, escapeHtml(config.apiKey));
  app.get('/', shopify.ensureInstalledOnShop(), (_req, res) => {
    res.set('content-type', 'text/html; charset=utf-8').send(page);
  });
  app.get('/exitiframe', (req, res) => {
    const redirectUri = typeof req.query.redirectUri === 'string' ? req.query.redirectUri : '/';
    const shop = typeof req.query.shop === 'string' && isShopDomain(req.query.shop) ? req.query.shop : '';
    shopify.redirectOutOfApp({ req, res, redirectUri, shop });
  });

  function view(row, { blogs = undefined, shopName = undefined }) {
    const out = {
      shop: row.shop,
      apiBase: row.api_base,
      apiBaseLocked: !config.allowCustomApiBase,
      publicKeyMasked: maskKey(row.public_key),
      blogId: row.blog_id,
      blogTitle: row.blog_title,
      publish: row.publish,
      authorName: row.author_name,
      syncEnabled: row.sync_enabled,
      configured: isConfigured(row),
      lastSyncAt: row.last_sync_at,
      lastResult: row.last_result,
      lastReconcileAt: row.last_reconcile_at,
      nextSyncAt: row.sync_enabled && isConfigured(row) ? row.last_sync_at + Math.floor(config.syncIntervalMs / 1000) : 0,
      syncIntervalMinutes: Math.round(config.syncIntervalMs / 60_000),
    };
    if (blogs !== undefined) out.blogs = blogs;
    if (shopName !== undefined) out.shopName = shopName;
    return out;
  }

  return { app, shopify, runForShop, accessTokenFor };
}

function seedCustomShop(config, db) {
  const c = config.custom;
  const current = db.shops.get(c.shop);
  db.shops.upsert(c.shop, {
    api_base: config.dailysmithApiBase,
    public_key: c.publicKey || current?.public_key || '',
    publish: c.publish,
    author_name: c.authorName || current?.author_name || '',
    sync_enabled: c.syncEnabled,
    installed_at: current?.installed_at || Math.floor(Date.now() / 1000),
  });
}

// In custom mode the target blog is named by handle in the environment and
// resolved against the store once; the resolved id is what the engine needs.
export async function resolveCustomBlog({ config, db, fetch = globalThis.fetch }) {
  const c = config.custom;
  const row = db.shops.get(c.shop);
  if (row.blog_id && !c.blogHandle) return row;
  const admin = new ShopifyAdmin({ shop: c.shop, accessToken: c.accessToken, apiVersion: ADMIN_API_VERSION, baseUrl: config.adminUrlOverride, fetch });
  const { blogs, shopName } = await admin.shopAndBlogs();
  const blog = c.blogHandle ? blogs.find((b) => b.handle === c.blogHandle) : blogs.length === 1 ? blogs[0] : null;
  if (!blog) {
    const have = blogs.map((b) => b.handle).join(', ') || 'none';
    throw new Error(`SHOPIFY_BLOG_HANDLE must name one of the store's blogs (${have})`);
  }
  return db.shops.upsert(c.shop, { blog_id: blog.id, blog_title: blog.title, author_name: row.author_name || shopName });
}

function splitHost(url) {
  const u = new URL(url);
  return [u.protocol.replace(':', ''), u.host];
}

function normaliseApiBase(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (u.pathname !== '/' || u.search || u.hash) return '';
    return u.origin;
  } catch {
    return '';
  }
}

export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 12) return `${key.slice(0, 3)}…`;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
