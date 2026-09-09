import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { DeliveryApi } from '../src/delivery-api.js';
import { ShopifyAdmin } from '../src/shopify-admin.js';
import { SyncEngine } from '../src/engine.js';
import { HOST_RESET } from '../src/render.js';
import { startDeliveryStub } from './stub-delivery.js';
import { startShopifyStub } from './stub-shopify.js';

const SHOP = 'test-shop.myshopify.com';
const RICH = '01a09000-0000-7000-8000-000000000001';
const PLAIN = '01a09000-0000-7000-8000-000000000002';

let delivery;
let shopify;
before(async () => {
  delivery = await startDeliveryStub();
  shopify = await startShopifyStub({ shop: SHOP });
});
after(async () => {
  await delivery.close();
  await shopify.close();
});

function fixture({ db = openDatabase(':memory:'), publicKey = 'pk_smoke', publish = true, now = Date.now } = {}) {
  db.shops.upsert(SHOP, {
    api_base: delivery.url,
    public_key: publicKey,
    blog_id: shopify.state.blogs[0].id,
    blog_title: 'News',
    author_name: 'Test Shop',
    publish,
  });
  const engine = () => {
    const row = db.shops.get(SHOP);
    return new SyncEngine({
      db,
      shop: SHOP,
      admin: new ShopifyAdmin({ shop: SHOP, accessToken: shopify.accessToken, apiVersion: '2026-01', baseUrl: shopify.url }),
      delivery: new DeliveryApi({ apiBase: row.api_base, publicKey: row.public_key }),
      now,
    });
  };
  return { db, run: (opts) => engine().run(opts) };
}

const meta = (a, key) => a.metafields.get(key)?.value;

test('creates on first sync, skips on the second, and never touches the merchant\'s article on the same handle', async () => {
  const mine = shopify.addMerchantArticle({ handle: 'hello-md2', title: 'My own hello-md2' });
  const { run } = fixture();

  assert.equal(await run(), 'Created 2, updated 0, unchanged 0, withdrawn 0.');

  const own = shopify.state.articles.get(mine.id);
  assert.equal(own.body, '<p>MINE, hands off.</p>');
  assert.equal(own.handle, 'hello-md2');
  assert.equal(own.metafields.size, 0, 'no marker was written on the merchant\'s article');

  const [rich] = shopify.byMarker(RICH);
  assert.ok(rich, 'the rich post was mirrored');
  assert.equal(rich.handle, 'hello-md2-2', 'ours took a suffixed handle instead of the merchant\'s');
  assert.equal(rich.title, 'Hello MD2 (v1)');
  assert.equal(rich.author, 'Test Shop');
  assert.equal(rich.isPublished, true);
  assert.equal(rich.publishDate, '2026-08-19T09:00:00.000Z');
  assert.equal(rich.summary, 'A rich post.');
  assert.match(rich.body, /^<link rel="stylesheet" href="http:\/\/127\.0\.0\.1:\d+\/v1\/sdk\/md2\.css">\n<style>\n/);
  assert.ok(rich.body.includes(HOST_RESET), 'host reset rides along with the component stylesheet');
  assert.ok(rich.body.includes('--md2-bg:#0a1128'), 'the blog palette is inlined');
  assert.ok(rich.body.includes('<div class="baas-wrap md2" data-baas-theme="light">'), 'the wrapper is the shared one');
  assert.ok(rich.body.includes('<svg'), 'SVG survives untouched');
  assert.equal(meta(rich, 'dailysmith.post_id'), RICH);
  assert.equal(meta(rich, 'dailysmith.updated_at'), '2026-08-20T01:00:00.123456Z');
  assert.equal(meta(rich, 'dailysmith.base_path'), '/blog');
  assert.equal(meta(rich, 'dailysmith.locale'), 'en');
  assert.equal(meta(rich, 'dailysmith.hero_url'), 'https://media.example/hero.png');
  assert.equal(meta(rich, 'global.title_tag'), 'Hello MD2 | Smoke');
  assert.equal(meta(rich, 'global.description_tag'), 'A rich post about MD2.');
  assert.deepEqual(rich.image, { url: 'https://media.example/hero.png', altText: 'A red pixel standing alone' });
  assert.equal(rich.imageSets, 1);

  const [plain] = shopify.byMarker(PLAIN);
  assert.ok(!plain.body.includes('<link'), 'a plain post loads no component stylesheet');
  assert.ok(plain.body.includes('--md2-bg:#0a1128'), 'but still carries the palette');
  assert.ok(!plain.body.includes(HOST_RESET));
  assert.equal(plain.image, null);
  assert.equal(meta(plain, 'dailysmith.hero_url'), undefined);

  assert.equal(await run(), 'Created 0, updated 0, unchanged 2, withdrawn 0.');
  assert.equal(shopify.byMarker(RICH).length, 1, 'no duplicate');
  assert.equal(shopify.byMarker(RICH)[0].imageSets, 1, 'hero not re-sent on a skip');
});

test('updates in place after an upstream edit; the hero is re-sent only when its URL changes', async () => {
  const { run } = fixture();
  await run();
  delivery.bump(); // v2: same hero URL
  assert.equal(await run(), 'Created 0, updated 2, unchanged 0, withdrawn 0.');
  let [rich] = shopify.byMarker(RICH);
  assert.equal(rich.title, 'Hello MD2 (v2)');
  assert.equal(rich.imageSets, 1, 'same hero URL: not downloaded again');
  assert.equal(meta(rich, 'dailysmith.updated_at'), '2026-08-20T02:00:00.123456Z');

  delivery.bump(); // v3: regenerated hero, new URL
  assert.equal(await run(), 'Created 0, updated 2, unchanged 0, withdrawn 0.');
  [rich] = shopify.byMarker(RICH);
  assert.equal(rich.imageSets, 2);
  assert.equal(rich.image.url, 'https://media.example/hero-v3.png');
  assert.equal(shopify.byMarker(RICH).length, 1);
  assert.equal(shopify.byMarker(PLAIN).length, 1);
});

test('a slug renamed upstream moves the handle (with a redirect); one taken by the merchant falls back to a suffix', async () => {
  const { db, run } = fixture();
  await run();
  const [rich] = shopify.byMarker(RICH);
  assert.equal(rich.handle, 'hello-md2-2');
  shopify.addMerchantArticle({ handle: 'hello-md2-renamed', title: 'Merchant got there first' });

  delivery.state.bump = 4; // rich slug becomes hello-md2-renamed
  assert.equal(await run(), 'Created 0, updated 2, unchanged 0, withdrawn 0.');
  assert.equal(shopify.byMarker(RICH)[0].handle, 'hello-md2-renamed-2', 'the merchant keeps the exact handle; ours is suffixed');
  assert.equal(db.articles.get(SHOP, RICH).handle, 'hello-md2-renamed-2');
  const updates = shopify.callsNamed('DailySmithArticleUpdate').slice(-4);
  const plainUpdate = updates.find((c) => c.variables.id === shopify.byMarker(PLAIN)[0].id);
  assert.equal(plainUpdate.variables.article.handle, undefined, 'an unchanged slug sends no handle at all');
  const renamed = updates.filter((c) => c.variables.article.handle);
  assert.ok(renamed.every((c) => c.variables.article.redirectNewHandle === true), 'a changed handle asks for a redirect');

  delivery.state.bump = 5; // still renamed, content edited again
  assert.equal(await run(), 'Created 0, updated 2, unchanged 0, withdrawn 0.');
  assert.equal(shopify.byMarker(RICH)[0].handle, 'hello-md2-renamed-2', 'a suffix we chose is kept, not re-negotiated');
  delivery.state.bump = 1;
});

test('a cold start rebuilds the index from the markers instead of creating everything again', async () => {
  await fixture().run(); // whatever earlier tests left behind, the blog now matches the feed
  const before = shopify.articlesInBlog().length;
  const { db, run } = fixture(); // a second, empty database against a blog that already holds our articles
  assert.equal(db.articles.count(SHOP), 0);
  assert.equal(await run(), 'Created 0, updated 0, unchanged 2, withdrawn 0.');
  assert.equal(shopify.articlesInBlog().length, before);
  assert.equal(db.articles.count(SHOP), 2);
  assert.equal(db.articles.get(SHOP, RICH).article_id, shopify.byMarker(RICH)[0].id);
});

test('an article the merchant deleted is created again on the next change', async () => {
  const { run } = fixture();
  await run();
  const [plain] = shopify.byMarker(PLAIN);
  shopify.deleteArticle(plain.id);
  delivery.bump();
  assert.equal(await run(), 'Created 1, updated 1, unchanged 0, withdrawn 0.');
  assert.equal(shopify.byMarker(PLAIN).length, 1);
  assert.notEqual(shopify.byMarker(PLAIN)[0].id, plain.id);
});

test('takedown: the full walk unpublishes only our articles, and the merchant\'s stays live', async () => {
  const { db, run } = fixture();
  await run();
  db.shops.upsert(SHOP, { public_key: 'pk_empty' }); // everything archived upstream
  const summary = await run({ reconcile: true });
  assert.equal(summary, 'Created 0, updated 0, unchanged 0, withdrawn 2.');
  for (const id of [RICH, PLAIN]) assert.equal(shopify.byMarker(id)[0].isPublished, false);
  const merchant = shopify.articlesInBlog().filter((a) => a.owner === 'merchant');
  assert.ok(merchant.length >= 1);
  assert.ok(merchant.every((a) => a.isPublished), 'the merchant\'s articles are untouched');

  // A republish upstream brings the same articles back, no duplicates.
  db.shops.upsert(SHOP, { public_key: 'pk_smoke' });
  delivery.bump();
  assert.equal(await run(), 'Created 0, updated 2, unchanged 0, withdrawn 0.');
  assert.equal(shopify.byMarker(RICH)[0].isPublished, true);
  assert.equal(shopify.byMarker(RICH).length, 1);
});

test('the publish setting arrives articles hidden', async () => {
  const stub = await startShopifyStub({ shop: SHOP });
  try {
    const db = openDatabase(':memory:');
    db.shops.upsert(SHOP, { api_base: delivery.url, public_key: 'pk_smoke', blog_id: stub.state.blogs[0].id, author_name: 'X', publish: false });
    const engine = new SyncEngine({ db, shop: SHOP, admin: new ShopifyAdmin({ shop: SHOP, accessToken: stub.accessToken, apiVersion: '2026-01', baseUrl: stub.url }), delivery: new DeliveryApi({ apiBase: delivery.url, publicKey: 'pk_smoke' }) });
    await engine.run();
    assert.ok(stub.articlesInBlog().every((a) => a.isPublished === false));
  } finally {
    await stub.close();
  }
});

test('the cursor walk survives an edit landing under it', async () => {
  const { run } = fixture({ publicKey: 'pk_paged' });
  delivery.state.pagedServed = 0;
  const summary = await run();
  assert.match(summary, /^Created 3, updated \d, unchanged 0, withdrawn 0\.$/);
  const titles = ['c001', 'c002', 'c003'].map((s) => shopify.byMarker(`01a09000-0000-7000-8000-00000000${s}`)[0]?.title);
  assert.ok(titles.every(Boolean), `all three mirrored: ${titles}`);
  assert.match(titles[0], /\(edited mid-walk\)$/, 'the edited article was re-listed at its new place');
  const withCursor = delivery.requestsFor('pk_paged').filter((r) => r.query.cursor);
  assert.ok(withCursor.length >= 1, 'the walk followed next_cursor');
});

test('only the blog\'s own language is mirrored, asked for by omission', async () => {
  const { run } = fixture({ publicKey: 'pk_multi' });
  assert.equal(await run(), 'Created 1, updated 0, unchanged 0, withdrawn 0.');
  const [en] = shopify.byMarker('01a09000-0000-7000-8000-00000000ae01');
  assert.equal(en.title, 'The translated article');
  assert.equal(shopify.byMarker('01a09000-0000-7000-8000-00000000ae02').length, 0, 'the ro sibling is not mirrored');
  assert.ok(delivery.requestsFor('pk_multi').every((r) => !('locale' in r.query)), 'no ?locale= was ever sent');
  assert.equal(await run({ reconcile: true }), 'Created 0, updated 0, unchanged 1, withdrawn 0.');
  assert.equal(en.isPublished, true);
});

test('a region-tagged blog language (pt-BR) arrives, because it is asked for by omission', async () => {
  const { run } = fixture({ publicKey: 'pk_region' });
  assert.equal(await run(), 'Created 1, updated 0, unchanged 0, withdrawn 0.');
  const [a] = shopify.byMarker('01a09000-0000-7000-8000-00000000be01');
  assert.equal(meta(a, 'dailysmith.locale'), 'pt-BR');
  assert.equal(await run({ reconcile: true }), 'Created 0, updated 0, unchanged 1, withdrawn 0.');
});

test('a throttled Admin API call is retried', async () => {
  const { run } = fixture();
  shopify.throttleNext(2);
  const summary = await run();
  assert.doesNotMatch(summary, /error/);
});

test('a feed error holds the checkpoint back, and the next run picks the span up', async () => {
  const stub = await startShopifyStub({ shop: SHOP });
  try {
    const db = openDatabase(':memory:');
    db.shops.upsert(SHOP, { api_base: delivery.url, public_key: 'pk_flaky', blog_id: stub.state.blogs[0].id, author_name: 'X' });
    const engine = () => new SyncEngine({ db, shop: SHOP, admin: new ShopifyAdmin({ shop: SHOP, accessToken: stub.accessToken, apiVersion: '2026-01', baseUrl: stub.url }), delivery: new DeliveryApi({ apiBase: delivery.url, publicKey: 'pk_flaky' }) });
    assert.match(await engine().run(), /^Created 2/);
    const checkpoint = db.shops.get(SHOP).checkpoints['/blog'].default;
    assert.ok(checkpoint);

    delivery.failNext(1);
    delivery.bump();
    const failed = await engine().run();
    assert.match(failed, /1 error\(s\): \/blog: the feed fell over/);
    assert.equal(db.shops.get(SHOP).checkpoints['/blog'].default, checkpoint, 'checkpoint not advanced past the failure');
    assert.equal(db.shops.get(SHOP).last_result, failed);

    assert.match(await engine().run(), /^Created 0, updated 2/);
    assert.notEqual(db.shops.get(SHOP).checkpoints['/blog'].default, checkpoint);
  } finally {
    await stub.close();
    delivery.state.bump = 1;
  }
});

test('two blogs on one site each keep their own checkpoint', async () => {
  const stub = await startShopifyStub({ shop: SHOP });
  try {
    const db = openDatabase(':memory:');
    db.shops.upsert(SHOP, { api_base: delivery.url, public_key: 'pk_two', blog_id: stub.state.blogs[0].id, author_name: 'X' });
    const engine = new SyncEngine({ db, shop: SHOP, admin: new ShopifyAdmin({ shop: SHOP, accessToken: stub.accessToken, apiVersion: '2026-01', baseUrl: stub.url }), delivery: new DeliveryApi({ apiBase: delivery.url, publicKey: 'pk_two' }) });
    assert.equal(await engine.run(), 'Created 5, updated 0, unchanged 0, withdrawn 0.');
    const cp = db.shops.get(SHOP).checkpoints;
    assert.ok(cp['/blog']?.default && cp['/paged']?.default);
    assert.equal(db.shops.get(SHOP).theme_css['/blog'], ':where(.baas-wrap, [data-baas-blog]){--md2-bg:#0a1128}');
  } finally {
    await stub.close();
  }
});

test('an unconfigured shop reports it and does nothing', async () => {
  const db = openDatabase(':memory:');
  db.shops.upsert(SHOP, { api_base: delivery.url, public_key: '', blog_id: '' });
  const engine = new SyncEngine({ db, shop: SHOP, admin: null, delivery: null });
  assert.equal(await engine.run(), 'Not configured: set the site key and pick a Shopify blog.');
  assert.equal(db.shops.get(SHOP).last_result, 'Not configured: set the site key and pick a Shopify blog.');
});

test('a bad site key is reported with the API\'s own words', async () => {
  const { db, run } = fixture({ publicKey: 'pk_nope' });
  assert.equal(await run(), 'Could not list blogs: unknown or unverified site key');
  assert.equal(db.shops.get(SHOP).last_result, 'Could not list blogs: unknown or unverified site key');
});
