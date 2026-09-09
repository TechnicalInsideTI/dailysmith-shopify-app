// Configuration from the environment. Two modes:
//
// - oauth (default): a Shopify app installed by merchants. Needs the app's
//   client id and secret from the Partner Dashboard, a public URL, and the
//   scopes. Each installed shop gets its own row and its own settings page.
// - custom: one store, one Admin API access token from a custom app the
//   merchant created in their own admin (Settings, Apps, Develop apps). No
//   OAuth, no embedded UI; the settings come from the environment and the
//   process just syncs. This is the five-minute path for a single store and
//   for self-hosted DailySmith installs.

const SHOP_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

export function loadConfig(env = process.env) {
  const customToken = env.SHOPIFY_CUSTOM_APP_TOKEN || '';
  const mode = customToken ? 'custom' : 'oauth';

  const config = {
    mode,
    port: Number(env.PORT || 3000),
    // The app's public URL, e.g. https://dailysmith-shopify.fly.dev. Shopify
    // loads the embedded page from it and the token exchange is bound to it.
    host: (env.HOST || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, ''),
    apiKey: env.SHOPIFY_API_KEY || '',
    apiSecret: env.SHOPIFY_API_SECRET || '',
    scopes: (env.SCOPES || 'read_content,write_content')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    databasePath: env.DATABASE_PATH || './data/dailysmith.sqlite',
    // The DailySmith API every shop syncs from. In oauth mode this is locked
    // unless ALLOW_CUSTOM_API_BASE=1: the app fetches whatever URL is stored
    // here, and a hosted multi-tenant process must not fetch URLs a merchant
    // typed (an internal address, say). A self-hosted operator can allow it.
    dailysmithApiBase: (env.DAILYSMITH_API_BASE || 'https://api.dailysmith.com').replace(/\/+$/, ''),
    allowCustomApiBase: env.ALLOW_CUSTOM_API_BASE === '1',
    syncIntervalMs: minutes(env.SYNC_INTERVAL_MINUTES, 60),
    reconcileIntervalMs: minutes(env.RECONCILE_INTERVAL_MINUTES, 24 * 60),
    // Tests point the Admin API client at a stub. Never set in production.
    adminUrlOverride: env.SHOPIFY_ADMIN_URL_OVERRIDE || '',
    custom: null,
  };

  if (mode === 'custom') {
    const shop = (env.SHOP || '').toLowerCase();
    if (!SHOP_RE.test(shop)) {
      throw new Error('SHOP must be the store\'s myshopify domain, e.g. my-store.myshopify.com');
    }
    config.custom = {
      shop,
      accessToken: customToken,
      publicKey: env.DAILYSMITH_PUBLIC_KEY || '',
      blogHandle: env.SHOPIFY_BLOG_HANDLE || '',
      publish: env.PUBLISH !== '0',
      authorName: env.AUTHOR_NAME || '',
      syncEnabled: env.SYNC_ENABLED !== '0',
    };
    // A self-hosting operator configures the API base directly.
    config.allowCustomApiBase = true;
  } else if (!config.apiKey || !config.apiSecret) {
    throw new Error(
      'SHOPIFY_API_KEY and SHOPIFY_API_SECRET are required (or SHOPIFY_CUSTOM_APP_TOKEN and SHOP for single-store mode)'
    );
  }
  return config;
}

function minutes(raw, fallback) {
  const n = Number(raw);
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 60_000;
}

export function isShopDomain(shop) {
  return SHOP_RE.test(shop || '');
}
