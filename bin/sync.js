#!/usr/bin/env node
// Run one sync and exit. For cron-driven deployments and for trying the app
// against a store from a terminal.
//
//   node bin/sync.js                       # custom mode: the store from SHOP
//   node bin/sync.js --shop x.myshopify.com   # oauth mode: an installed store
//   node bin/sync.js --reconcile           # force the withdrawal pass too
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { createApp, resolveCustomBlog } from '../src/app.js';

const args = process.argv.slice(2);
const reconcile = args.includes('--reconcile') ? true : 'auto';
const shopArg = args[args.indexOf('--shop') + 1];

const config = loadConfig();
const db = openDatabase(config.databasePath);
const { runForShop } = createApp({ config, db, log: console.log });

let shop = config.mode === 'custom' ? config.custom.shop : shopArg;
if (!shop || shop.startsWith('--')) {
  console.error('usage: node bin/sync.js --shop <store>.myshopify.com [--reconcile]   (or set SHOPIFY_CUSTOM_APP_TOKEN and SHOP)');
  process.exit(2);
}
if (config.mode === 'custom') await resolveCustomBlog({ config, db });

const summary = await runForShop(shop, { reconcile });
console.log(`${shop}: ${summary}`);
db.close();
process.exit(/error\(s\)|^Could not|^Not configured|^Sync failed/.test(summary) ? 1 : 0);
