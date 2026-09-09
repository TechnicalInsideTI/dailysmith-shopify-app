// One SQLite file holds everything: Shopify sessions (offline access tokens),
// one settings-and-state row per shop, and the article index that maps a
// DailySmith post id to the Shopify article mirroring it.
//
// The index is the fast path of the ownership contract, not its truth. The
// truth is the `dailysmith.post_id` metafield on the article itself, which is
// what survives an uninstall and reinstall, a lost database, or a second
// deployment. The engine rebuilds the index from those metafields when it
// finds it empty and on every reconcile.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Session } from '@shopify/shopify-api';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id   TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_shop ON sessions(shop);

CREATE TABLE IF NOT EXISTS shops (
  shop              TEXT PRIMARY KEY,
  api_base          TEXT NOT NULL DEFAULT '',
  public_key        TEXT NOT NULL DEFAULT '',
  blog_id           TEXT NOT NULL DEFAULT '',
  blog_title        TEXT NOT NULL DEFAULT '',
  publish           INTEGER NOT NULL DEFAULT 1,
  author_name       TEXT NOT NULL DEFAULT '',
  sync_enabled      INTEGER NOT NULL DEFAULT 1,
  checkpoints       TEXT NOT NULL DEFAULT '{}',
  theme_css         TEXT NOT NULL DEFAULT '{}',
  last_sync_at      INTEGER NOT NULL DEFAULT 0,
  last_result       TEXT NOT NULL DEFAULT '',
  last_reconcile_at INTEGER NOT NULL DEFAULT 0,
  installed_at      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS articles (
  shop       TEXT NOT NULL,
  post_id    TEXT NOT NULL,
  article_id TEXT NOT NULL,
  handle     TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  hero_url   TEXT NOT NULL DEFAULT '',
  base_path  TEXT NOT NULL DEFAULT '',
  locale     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (shop, post_id)
);
CREATE INDEX IF NOT EXISTS articles_shop_article ON articles(shop, article_id);
`;

export function openDatabase(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const raw = new Database(file);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.exec(SCHEMA);

  const q = {
    sessionGet: raw.prepare('SELECT data FROM sessions WHERE id = ?'),
    sessionPut: raw.prepare('INSERT INTO sessions (id, shop, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET shop = excluded.shop, data = excluded.data'),
    sessionDel: raw.prepare('DELETE FROM sessions WHERE id = ?'),
    sessionsByShop: raw.prepare('SELECT data FROM sessions WHERE shop = ?'),
    shopGet: raw.prepare('SELECT * FROM shops WHERE shop = ?'),
    shopList: raw.prepare('SELECT * FROM shops ORDER BY shop'),
    shopDel: raw.prepare('DELETE FROM shops WHERE shop = ?'),
    articleGet: raw.prepare('SELECT * FROM articles WHERE shop = ? AND post_id = ?'),
    articlePut: raw.prepare(`INSERT INTO articles (shop, post_id, article_id, handle, updated_at, hero_url, base_path, locale)
      VALUES (@shop, @post_id, @article_id, @handle, @updated_at, @hero_url, @base_path, @locale)
      ON CONFLICT(shop, post_id) DO UPDATE SET article_id = excluded.article_id, handle = excluded.handle,
        updated_at = excluded.updated_at, hero_url = excluded.hero_url, base_path = excluded.base_path, locale = excluded.locale`),
    articleDel: raw.prepare('DELETE FROM articles WHERE shop = ? AND post_id = ?'),
    articlesByShop: raw.prepare('SELECT * FROM articles WHERE shop = ?'),
    articlesByBase: raw.prepare('SELECT * FROM articles WHERE shop = ? AND base_path = ?'),
    articlesCount: raw.prepare('SELECT COUNT(*) AS n FROM articles WHERE shop = ?'),
    articlesDelShop: raw.prepare('DELETE FROM articles WHERE shop = ?'),
  };

  // The SessionStorage interface @shopify/shopify-app-express expects, on the
  // same file as everything else. Sessions are stored through the library's
  // own property-array serialisation, so every field it may add in a later
  // version round-trips without a schema change here.
  const sessions = {
    async storeSession(session) {
      q.sessionPut.run(session.id, session.shop, JSON.stringify(session.toPropertyArray(true)));
      return true;
    },
    async loadSession(id) {
      const row = q.sessionGet.get(id);
      return row ? Session.fromPropertyArray(JSON.parse(row.data), true) : undefined;
    },
    async deleteSession(id) {
      q.sessionDel.run(id);
      return true;
    },
    async deleteSessions(ids) {
      const tx = raw.transaction((list) => list.forEach((id) => q.sessionDel.run(id)));
      tx(ids);
      return true;
    },
    async findSessionsByShop(shop) {
      return q.sessionsByShop.all(shop).map((row) => Session.fromPropertyArray(JSON.parse(row.data), true));
    },
  };

  const shops = {
    get(shop) {
      const row = q.shopGet.get(shop);
      return row ? hydrateShop(row) : null;
    },
    list() {
      return q.shopList.all().map(hydrateShop);
    },
    // Merge `patch` over the stored row (or the defaults for a new shop).
    upsert(shop, patch) {
      const current = shops.get(shop) || defaultShop(shop);
      const next = { ...current, ...patch, shop };
      raw
        .prepare(`INSERT INTO shops (shop, api_base, public_key, blog_id, blog_title, publish, author_name, sync_enabled,
            checkpoints, theme_css, last_sync_at, last_result, last_reconcile_at, installed_at)
          VALUES (@shop, @api_base, @public_key, @blog_id, @blog_title, @publish, @author_name, @sync_enabled,
            @checkpoints, @theme_css, @last_sync_at, @last_result, @last_reconcile_at, @installed_at)
          ON CONFLICT(shop) DO UPDATE SET api_base = excluded.api_base, public_key = excluded.public_key,
            blog_id = excluded.blog_id, blog_title = excluded.blog_title, publish = excluded.publish,
            author_name = excluded.author_name, sync_enabled = excluded.sync_enabled, checkpoints = excluded.checkpoints,
            theme_css = excluded.theme_css, last_sync_at = excluded.last_sync_at, last_result = excluded.last_result,
            last_reconcile_at = excluded.last_reconcile_at, installed_at = excluded.installed_at`)
        .run({
          ...next,
          publish: next.publish ? 1 : 0,
          sync_enabled: next.sync_enabled ? 1 : 0,
          checkpoints: JSON.stringify(next.checkpoints || {}),
          theme_css: JSON.stringify(next.theme_css || {}),
        });
      return shops.get(shop);
    },
    delete(shop) {
      q.shopDel.run(shop);
    },
  };

  const articles = {
    get(shop, postId) {
      return q.articleGet.get(shop, postId) || null;
    },
    put(row) {
      q.articlePut.run({ handle: '', updated_at: '', hero_url: '', base_path: '', locale: '', ...row });
    },
    delete(shop, postId) {
      q.articleDel.run(shop, postId);
    },
    listByShop(shop) {
      return q.articlesByShop.all(shop);
    },
    listByBase(shop, basePath) {
      return q.articlesByBase.all(shop, basePath);
    },
    count(shop) {
      return q.articlesCount.get(shop).n;
    },
    deleteByShop(shop) {
      q.articlesDelShop.run(shop);
    },
  };

  // Everything an uninstall or a shop/redact must forget.
  function forgetShop(shop) {
    const tx = raw.transaction(() => {
      raw.prepare('DELETE FROM sessions WHERE shop = ?').run(shop);
      q.shopDel.run(shop);
      q.articlesDelShop.run(shop);
    });
    tx();
  }

  return { raw, sessions, shops, articles, forgetShop, close: () => raw.close() };
}

function defaultShop(shop) {
  return {
    shop,
    api_base: '',
    public_key: '',
    blog_id: '',
    blog_title: '',
    publish: true,
    author_name: '',
    sync_enabled: true,
    checkpoints: {},
    theme_css: {},
    last_sync_at: 0,
    last_result: '',
    last_reconcile_at: 0,
    installed_at: 0,
  };
}

function hydrateShop(row) {
  return {
    ...row,
    publish: row.publish === 1,
    sync_enabled: row.sync_enabled === 1,
    checkpoints: safeJson(row.checkpoints, {}),
    theme_css: safeJson(row.theme_css, {}),
  };
}

function safeJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

export function isConfigured(shopRow) {
  return Boolean(shopRow && shopRow.api_base && shopRow.public_key && shopRow.blog_id);
}
