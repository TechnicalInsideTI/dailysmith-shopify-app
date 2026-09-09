// The sync engine: polls the DailySmith delivery feed and mirrors posts into
// one Shopify blog.
//
// The ownership contract, shared with DailySmith's other channels: every
// article this engine creates carries the DailySmith post id in the
// `dailysmith.post_id` metafield. Updates and takedowns go ONLY to the article
// carrying the id being synced, never to one found by handle or title, because
// a handle match cannot tell our mirror from an article the merchant wrote
// themselves. When no marked article exists we create one, and if the
// merchant's own article already sits on the handle, ours takes a suffixed
// handle rather than touching theirs.
//
// Shopify's article search cannot filter on a metafield, so the engine keeps
// an index (post id to article id) in its own database and rebuilds it from
// the metafields whenever it is empty and on every reconcile. The metafield is
// the truth; the index is the cache.
//
// Only the blog's own language is mirrored. DailySmith publishes each language
// of an article as its own post with its own id; Shopify blogs are
// single-language, and mapping translation groups onto Shopify's translation
// system is a different feature. The blog's language is asked for by omission
// (no ?locale=), never by name: an explicit tag goes through the API's language
// catalog, which holds languages, not regions, so a pt-BR blog asked for by
// name would be answered with an empty pt edition and a reconcile would read
// that emptiness as a mass takedown.
import { isConfigured } from './db.js';
import { renderBody } from './render.js';
import { isHandleTaken, isNotFound } from './shopify-admin.js';

export const META_NAMESPACE = 'dailysmith';

export class SyncEngine {
  constructor({ db, shop, admin, delivery, reconcileIntervalMs = 24 * 3_600_000, now = Date.now, log = () => {} }) {
    this.db = db;
    this.shop = shop;
    this.admin = admin;
    this.delivery = delivery;
    this.reconcileIntervalMs = reconcileIntervalMs;
    this.now = now;
    this.log = log;
  }

  // One sync: every blog on the site, incremental from the stored checkpoint,
  // plus a reconcile (daily, or forced) that withdraws posts DailySmith no
  // longer publishes. Returns a one-line summary, which is also stored.
  async run({ reconcile = 'auto' } = {}) {
    const settings = this.db.shops.get(this.shop);
    if (!isConfigured(settings)) {
      return this.finish('Not configured: set the site key and pick a Shopify blog.');
    }
    this.tally = { created: 0, updated: 0, skipped: 0, withdrawn: 0, errors: [], notes: [] };

    let blogs;
    try {
      blogs = await this.delivery.blogs();
    } catch (err) {
      return this.finish(`Could not list blogs: ${err.message}`);
    }
    if (!blogs.length) {
      return this.finish('The site has no blogs yet.');
    }

    const state = { checkpoints: { ...settings.checkpoints }, theme_css: { ...settings.theme_css } };
    const doReconcile =
      reconcile === true || (reconcile === 'auto' && this.now() - settings.last_reconcile_at * 1000 > this.reconcileIntervalMs);

    // A fresh install (or a lost database) has no index. Rebuild it from the
    // markers before creating anything, or every article would be created
    // twice. The reconcile refreshes it the same way.
    let indexReady = true;
    if (doReconcile || this.db.articles.count(this.shop) === 0) {
      try {
        await this.adoptMarkedArticles(settings.blog_id);
      } catch (err) {
        this.tally.errors.push(`Could not read the Shopify blog: ${err.message}`);
        indexReady = false;
      }
    }

    if (indexReady) {
      for (const blog of blogs) {
        const base = typeof blog?.base_path === 'string' ? blog.base_path : '';
        if (!base) continue;
        const seen = new Set();
        const complete = await this.syncEdition({ settings, state, base, reconcile: doReconcile, seen });
        if (doReconcile && complete) {
          // Reached only when the whole edition arrived, so an id missing
          // from `seen` really means "archived on DailySmith", never "page
          // lost".
          await this.withdrawMissing(base, seen);
        }
      }
    }

    const patch = {
      checkpoints: state.checkpoints,
      theme_css: state.theme_css,
      last_sync_at: Math.floor(this.now() / 1000),
      last_result: this.summary(),
    };
    if (doReconcile && indexReady && this.tally.errors.length === 0) {
      patch.last_reconcile_at = Math.floor(this.now() / 1000);
    }
    this.db.shops.upsert(this.shop, patch);
    return patch.last_result;
  }

  // Walk one blog's own-language feed from its checkpoint, by cursor. The
  // feed is ordered by the very field an edit rewrites, so a post republished
  // mid-walk jumps to the end and drags its neighbours forward; a page-number
  // window steps over whatever moved into the place it already read. A cursor
  // is a position in the ordering, so the same edit costs a re-listing at
  // worst. An API without cursors is walked by page.
  async syncEdition({ settings, state, base, reconcile, seen }) {
    const since = reconcile ? '' : String(state.checkpoints?.[base]?.default || '');
    let page = 1;
    let total = 1;
    let cursor = '';
    let checkpoint = since;
    let locale = '';
    const errorsBefore = this.tally.errors.length;

    do {
      let feed;
      try {
        feed = await this.delivery.updatedPosts({ basePath: base, since, page, cursor });
      } catch (err) {
        this.tally.errors.push(`${base}: ${err.message}`);
        return false; // checkpoint stays put; the next run retries this span.
      }
      if (typeof feed.locale === 'string' && feed.locale) locale = feed.locale;
      if (page === 1) {
        // Blog-level palette, carried once per envelope. An absent value
        // clears a palette the blog no longer serves.
        state.theme_css[base] = typeof feed.theme_css === 'string' ? feed.theme_css : '';
      }
      const cssUrl = this.delivery.resolveCss(feed.css_href);

      for (const entry of Array.isArray(feed.posts) ? feed.posts : []) {
        if (!entry || typeof entry !== 'object' || !entry.id) continue;
        seen.add(String(entry.id));
        try {
          const outcome = await this.syncPost({ entry, settings, base, locale, themeCss: state.theme_css[base], cssUrl });
          this.tally[outcome]++;
        } catch (err) {
          this.tally.errors.push(`${base}/${entry.slug || entry.id}: ${err.message}`);
        }
        if (entry.updated_at) checkpoint = String(entry.updated_at);
      }

      total = Number(feed.total_pages) || 1;
      page++;
      const next = typeof feed.next_cursor === 'string' ? feed.next_cursor.trim() : '';
      // A cursor that repeats itself would loop forever on one page.
      cursor = next && next !== cursor ? next : '';
    } while (cursor || page <= total);

    const clean = this.tally.errors.length === errorsBefore;
    if (clean && checkpoint) {
      state.checkpoints[base] = { ...(state.checkpoints[base] || {}), default: checkpoint };
    }
    return clean;
  }

  // Mirror one feed entry: create, update in place, or skip.
  async syncPost({ entry, settings, base, locale, themeCss, cssUrl }) {
    const postId = String(entry.id);
    const updatedAt = typeof entry.updated_at === 'string' ? entry.updated_at : '';
    let row = this.db.articles.get(this.shop, postId);

    if (row && updatedAt && row.updated_at === updatedAt) {
      return 'skipped'; // DailySmith bumps updated_at on every change.
    }

    const hero = typeof entry.hero_image_url === 'string' ? entry.hero_image_url : '';
    const seo = entry.seo && typeof entry.seo === 'object' ? entry.seo : {};
    const article = {
      title: String(entry.title || ''),
      handle: String(entry.slug || ''),
      body: renderBody({ bodyHtml: String(entry.body_html || ''), themeCss, cssUrl }),
      summary: String(entry.excerpt || ''),
      isPublished: Boolean(settings.publish),
      metafields: markerMetafields({ postId, updatedAt, base, locale, hero, seo }),
    };
    if (entry.published_at) {
      const t = Date.parse(entry.published_at);
      if (Number.isFinite(t)) article.publishDate = new Date(t).toISOString();
    }
    // The hero is sent once per URL. Media URLs are immutable by id, so a
    // regenerated hero is a new URL and costs exactly one new download.
    if (hero && (!row || row.hero_url !== hero)) {
      article.image = { url: hero, altText: String(entry.hero_image_alt || '') };
    }

    if (row) {
      const result = await this.updateKeepingHandle(row, article);
      if (isNotFound(result)) {
        // The merchant deleted our article. Forget it and create it again.
        this.db.articles.delete(this.shop, postId);
        row = null;
      } else if (result.userErrors?.length) {
        throw new Error(describeUserErrors(result.userErrors));
      } else {
        this.db.articles.put({
          shop: this.shop,
          post_id: postId,
          article_id: row.article_id,
          handle: result.article?.handle || row.handle,
          updated_at: updatedAt,
          hero_url: hero || row.hero_url,
          base_path: base,
          locale,
        });
        return 'updated';
      }
    }

    // Create. The author is set once, here; an update keeps whatever the
    // merchant may have changed since. A handle the merchant's own article
    // already holds is never taken from them: ours gets a suffix.
    const create = { ...article, blogId: settings.blog_id, author: { name: settings.author_name || 'DailySmith' } };
    if (hero && !create.image) create.image = { url: hero, altText: String(entry.hero_image_alt || '') };
    const baseHandle = create.handle || slugify(create.title) || 'post';
    for (let n = 1; n <= 6; n++) {
      create.handle = n === 1 ? baseHandle : `${baseHandle}-${n}`;
      const result = await this.admin.createArticle(create);
      if (result.article?.id) {
        this.db.articles.put({ shop: this.shop, post_id: postId, article_id: result.article.id, handle: result.article.handle || create.handle, updated_at: updatedAt, hero_url: hero, base_path: base, locale });
        return 'created';
      }
      if (isHandleTaken(result.userErrors)) continue;
      throw new Error(describeUserErrors(result.userErrors));
    }
    throw new Error(`could not find a free handle for ${baseHandle}`);
  }

  // An update never fights over a handle. The handle is sent only when the
  // slug changed upstream: an article that took a suffixed handle at creation
  // (the merchant's own article holds the slug) keeps it, and a slug that has
  // since been taken by someone else falls back to a suffix the same way
  // creation does. A handle we do change gets a redirect from the old one.
  async updateKeepingHandle(row, article) {
    const wanted = article.handle;
    const current = row.handle || '';
    const input = { ...article };
    delete input.handle;
    const suffixedFromWanted = current === wanted || new RegExp(`^${escapeRegExp(wanted)}-\\d+$`).test(current);
    if (!wanted || !current || suffixedFromWanted) {
      return this.admin.updateArticle(row.article_id, input);
    }
    for (let n = 1; n <= 6; n++) {
      const handle = n === 1 ? wanted : `${wanted}-${n}`;
      const result = await this.admin.updateArticle(row.article_id, { ...input, handle, redirectNewHandle: true });
      if (!isHandleTaken(result.userErrors)) return result;
    }
    return this.admin.updateArticle(row.article_id, input);
  }

  // Rebuild the index from the markers on the blog's articles. Adopts only
  // articles carrying our metafield; everything else in the blog is the
  // merchant's and is never touched.
  async adoptMarkedArticles(blogId) {
    const articles = await this.admin.listBlogArticles(blogId);
    const seenIds = new Set();
    for (const a of articles) {
      const postId = a.meta?.post_id;
      if (!postId) continue;
      seenIds.add(a.id);
      const existing = this.db.articles.get(this.shop, postId);
      if (existing && existing.article_id === a.id && existing.handle === a.handle) continue;
      this.db.articles.put({
        shop: this.shop,
        post_id: postId,
        article_id: a.id,
        handle: a.handle || '',
        updated_at: a.meta.updated_at || '',
        hero_url: a.meta.hero_url || '',
        base_path: a.meta.base_path || '',
        locale: a.meta.locale || '',
      });
    }
    // Index rows whose article is no longer in the blog point at nothing;
    // the next sync of that post creates it again.
    for (const row of this.db.articles.listByShop(this.shop)) {
      if (!seenIds.has(row.article_id)) this.db.articles.delete(this.shop, row.post_id);
    }
  }

  // Unpublish (never delete) our articles whose post the full walk did not
  // list: DailySmith archived them. Unpublished, the content stays in the
  // merchant's admin and a republish updates the same article again.
  async withdrawMissing(base, seen) {
    for (const row of this.db.articles.listByBase(this.shop, base)) {
      if (seen.has(row.post_id)) continue;
      try {
        const result = await this.admin.updateArticle(row.article_id, { isPublished: false });
        if (isNotFound(result)) {
          this.db.articles.delete(this.shop, row.post_id);
        } else if (result.userErrors?.length) {
          this.tally.errors.push(`${base}: withdraw ${row.post_id}: ${describeUserErrors(result.userErrors)}`);
        } else {
          this.tally.withdrawn++;
        }
      } catch (err) {
        this.tally.errors.push(`${base}: withdraw ${row.post_id}: ${err.message}`);
      }
    }
  }

  summary() {
    const t = this.tally;
    let line = `Created ${t.created}, updated ${t.updated}, unchanged ${t.skipped}, withdrawn ${t.withdrawn}.`;
    if (t.errors.length) line += ` ${t.errors.length} error(s): ${t.errors.slice(0, 3).join(' · ')}`;
    if (t.notes.length) line += ` ${t.notes.slice(0, 3).join(' · ')}`;
    return line;
  }

  finish(message) {
    this.db.shops.upsert(this.shop, { last_sync_at: Math.floor(this.now() / 1000), last_result: message });
    return message;
  }
}

// The ownership marker and its companions (enough to rebuild the index from
// the article alone), plus Shopify's own SEO fields, which live in the
// `global` namespace: title_tag and description_tag are what the admin's
// "Search engine listing" section edits.
function markerMetafields({ postId, updatedAt, base, locale, hero, seo }) {
  const single = (key, value) => ({ namespace: META_NAMESPACE, key, type: 'single_line_text_field', value: String(value) });
  const out = [single('post_id', postId), single('updated_at', updatedAt), single('base_path', base)];
  if (locale) out.push(single('locale', locale));
  if (hero) out.push(single('hero_url', hero));
  const title = typeof seo.title_tag === 'string' ? seo.title_tag.trim() : '';
  const desc = typeof seo.meta_description === 'string' ? seo.meta_description.trim() : '';
  if (title) out.push({ namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: title });
  if (desc) out.push({ namespace: 'global', key: 'description_tag', type: 'multi_line_text_field', value: desc });
  return out;
}

function describeUserErrors(userErrors) {
  return (userErrors || []).map((e) => (Array.isArray(e.field) && e.field.length ? `${e.field.join('.')}: ${e.message}` : e.message)).join('; ') || 'unknown error';
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .slice(0, 80);
}
