// Process entry point: load the configuration, open the database, build the
// app, start the scheduler, listen.
import { loadConfig } from './src/config.js';
import { openDatabase } from './src/db.js';
import { createApp, resolveCustomBlog } from './src/app.js';
import { startScheduler } from './src/scheduler.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
const { app, runForShop } = createApp({ config, db });

if (config.mode === 'custom') {
  await resolveCustomBlog({ config, db });
}

const scheduler = startScheduler({ db, config, runForShop });
const server = app.listen(config.port, () => {
  console.log(`dailysmith-shopify-app listening on :${config.port} (${config.mode} mode, sync every ${Math.round(config.syncIntervalMs / 60000)} min)`);
  void scheduler.tick();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    scheduler.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
