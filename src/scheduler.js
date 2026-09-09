// A one-minute tick that runs each due shop's sync in turn. Serial on purpose:
// the process serves the settings page too, and one shop's sync at a time
// keeps the Admin API's rate limits and this process's memory predictable.
import { isConfigured } from './db.js';

export function startScheduler({ db, config, runForShop, log = console.log, tickMs = 60_000, now = Date.now }) {
  const running = new Set();
  let timer = null;
  let ticking = false;

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      for (const shop of db.shops.list()) {
        if (!shop.sync_enabled || !isConfigured(shop)) continue;
        if (now() - shop.last_sync_at * 1000 < config.syncIntervalMs) continue;
        if (running.has(shop.shop)) continue;
        running.add(shop.shop);
        try {
          const summary = await runForShop(shop.shop);
          log(`[sync] ${shop.shop}: ${summary}`);
        } catch (err) {
          log(`[sync] ${shop.shop}: failed: ${err.message}`);
          // Stamp the attempt so a shop whose token is gone is not retried
          // every minute.
          db.shops.upsert(shop.shop, { last_sync_at: Math.floor(now() / 1000), last_result: `Sync failed: ${err.message}` });
        } finally {
          running.delete(shop.shop);
        }
      }
    } finally {
      ticking = false;
    }
  }

  timer = setInterval(() => void tick(), tickMs);
  timer.unref?.();
  return {
    tick,
    isRunning: (shop) => running.has(shop),
    stop() {
      clearInterval(timer);
    },
  };
}
