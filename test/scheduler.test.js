import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { startScheduler } from '../src/scheduler.js';

test('the scheduler runs a due shop once per interval, skips the unconfigured and the paused, and survives a failure', async () => {
  const db = openDatabase(':memory:');
  db.shops.upsert('due.myshopify.com', { api_base: 'http://x', public_key: 'pk_a', blog_id: 'gid://shopify/Blog/1', last_sync_at: 0 });
  db.shops.upsert('fresh.myshopify.com', { api_base: 'http://x', public_key: 'pk_b', blog_id: 'gid://shopify/Blog/1', last_sync_at: Math.floor(Date.now() / 1000) });
  db.shops.upsert('paused.myshopify.com', { api_base: 'http://x', public_key: 'pk_c', blog_id: 'gid://shopify/Blog/1', sync_enabled: false });
  db.shops.upsert('unset.myshopify.com', { api_base: 'http://x', public_key: '', blog_id: '' });
  db.shops.upsert('broken.myshopify.com', { api_base: 'http://x', public_key: 'pk_d', blog_id: 'gid://shopify/Blog/1', last_sync_at: 0 });

  const ran = [];
  const scheduler = startScheduler({
    db,
    config: { syncIntervalMs: 3_600_000 },
    log: () => {},
    tickMs: 1_000_000,
    runForShop: async (shop) => {
      ran.push(shop);
      if (shop === 'broken.myshopify.com') throw new Error('no token');
      db.shops.upsert(shop, { last_sync_at: Math.floor(Date.now() / 1000), last_result: 'ok' });
      return 'ok';
    },
  });
  try {
    await scheduler.tick();
    assert.deepEqual(ran, ['broken.myshopify.com', 'due.myshopify.com']);
    assert.match(db.shops.get('broken.myshopify.com').last_result, /Sync failed: no token/);
    assert.ok(db.shops.get('broken.myshopify.com').last_sync_at > 0, 'a failed shop is stamped so it is not retried every minute');
    await scheduler.tick();
    assert.equal(ran.length, 2, 'nothing is due on the second tick');
  } finally {
    scheduler.stop();
  }
});
