# DailySmith for Shopify

[![ci](https://github.com/TechnicalInsideTI/dailysmith-shopify-app/actions/workflows/ci.yml/badge.svg)](https://github.com/TechnicalInsideTI/dailysmith-shopify-app/actions/workflows/ci.yml)

A Shopify app that mirrors a [DailySmith](https://dailysmith.com) blog into a store's own blog. On a schedule (hourly by default) it polls DailySmith's public delivery API and creates or updates articles in the Shopify blog you pick: the rendered article, the SEO title and description, the featured image, and the stylesheet the rich components need. It never overwrites an article it did not create.

It is the Shopify counterpart of the [WordPress plugin](https://github.com/TechnicalInsideTI/dailysmith-wordpress-plugin) and follows the same ownership contract. Only the site's public `pk_` key goes in; no DailySmith credential is stored anywhere.

## Status

0.1.0 is exercised end to end against stubs of both APIs (`test/`), which model the delivery feed's fixtures and the Admin API's behaviour around handles, metafields, deleted articles and throttling. It has not yet been run against a live Shopify store. The Admin API operations it uses (`articleCreate`, `articleUpdate`, `blog.articles`, metafields in the `dailysmith` and `global` namespaces) are current as of API version 2026-01.

## Two ways to run it

**As a Shopify app.** Merchants install it from Shopify, the settings page lives in their admin, and one process serves any number of stores. Needs a Partner Dashboard app and somewhere to host this service.

**For one store, with a custom app token.** No OAuth, no Partner account, no settings page: the merchant creates a custom app in their own admin, you put its Admin API token and the DailySmith site key in the environment, and the process syncs. This is the five-minute path, and the one a self-hosted DailySmith install would use.

Both modes share the engine, the database and the scheduler.

### One store in five minutes

1. In the store's admin, open Settings, Apps and sales channels, Develop apps, and create an app. Under Admin API integration, tick `read_content` and `write_content`, install it, and copy the Admin API access token (`shpat_…`). It is shown once.
2. Put these in `.env` (see `.env.example`):

   ```
   SHOPIFY_CUSTOM_APP_TOKEN=shpat_…
   SHOP=my-store.myshopify.com
   DAILYSMITH_PUBLIC_KEY=pk_…
   SHOPIFY_BLOG_HANDLE=news
   ```

3. Run one sync:

   ```bash
   npm ci
   node --env-file=.env bin/sync.js
   ```

   Or keep the process running and let it sync hourly:

   ```bash
   node --env-file=.env server.js
   ```

`SHOPIFY_BLOG_HANDLE` is the handle of the Shopify blog to publish into (Online Store, Blog posts, Manage blogs). It can be left out when the store has exactly one blog. `PUBLISH=0` makes articles arrive hidden; `AUTHOR_NAME` sets the author on new articles and defaults to the store's name.

### As a Shopify app

1. In the Partner Dashboard create an app (or link this one with the Shopify CLI: `shopify app config link`). Copy the client id and secret into `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`, and put the service's public URL in `HOST`.
2. Fill the two placeholders in `shopify.app.toml` and run `shopify app deploy`. That pushes the scopes, the app URL, and the three compliance webhooks. The app uses Shopify managed installation, so there is no OAuth redirect to configure beyond the callback URL the file lists.
3. Deploy the service. `Dockerfile` builds it; `deploy/fly.toml.example` is a working Fly.io layout with a volume for the database. Any host that keeps one process running and one file persistent will do.
4. Install the app on a store from the Partner Dashboard. Its settings page opens inside the admin: paste the site key, pick the blog, press Test connection, then Sync now.

The settings page and the API behind it are authenticated with App Bridge session tokens, exchanged once per store for an offline access token that the scheduler uses. Sessions, settings and the article index live in one SQLite file (`DATABASE_PATH`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | | The app's client id and secret. Required in app mode |
| `HOST` | `http://localhost:3000` | The service's public URL |
| `SCOPES` | `read_content,write_content` | Access scopes requested at install |
| `SHOPIFY_CUSTOM_APP_TOKEN`, `SHOP` | | Set both to run in single-store mode |
| `DAILYSMITH_PUBLIC_KEY` | | Single-store mode: the site key |
| `SHOPIFY_BLOG_HANDLE` | the only blog | Single-store mode: which blog to publish into |
| `PUBLISH` | `1` | Single-store mode: `0` keeps new articles hidden |
| `AUTHOR_NAME` | the store's name | Single-store mode: author on new articles |
| `DAILYSMITH_API_BASE` | `https://api.dailysmith.com` | The API every store syncs from |
| `ALLOW_CUSTOM_API_BASE` | unset | `1` lets a merchant type their own API base. Leave unset when hosting for others: the process fetches whatever is stored |
| `DATABASE_PATH` | `./data/dailysmith.sqlite` | The SQLite file |
| `SYNC_INTERVAL_MINUTES` | `60` | How often each store is synced |
| `RECONCILE_INTERVAL_MINUTES` | `1440` | How often the full walk that withdraws archived posts runs |
| `PORT` | `3000` | Listen port |

## What it does

Each run walks every DailySmith blog on the site from its last checkpoint, by cursor. For each post it creates an article in the chosen Shopify blog, updates the one it created earlier, or skips it when nothing changed upstream. All DailySmith blogs on a site land in the one Shopify blog you pick; the DailySmith base path is kept on each article.

Ownership works through one metafield. Every article the app creates carries the DailySmith post id in `dailysmith.post_id`. Updates and takedowns go only to the article carrying the id being synced, never to one found by handle or title. If the merchant's own article already holds a post's slug, the mirrored article takes a suffixed handle and theirs is not touched. A slug renamed upstream moves the handle and leaves a redirect behind. Shopify cannot search articles by metafield, so the app keeps an index in its database and rebuilds it from the metafields on a fresh install and on every reconcile; the metafield is the truth, the index is the cache. An article the merchant deletes in the admin is created again the next time the post changes.

Once a day the app does a full walk and unpublishes articles whose post is no longer published in DailySmith. Unpublished, never deleted. A republish in DailySmith updates the same article again.

The SEO title and description go to `global.title_tag` and `global.description_tag`, the metafields behind the admin's "Search engine listing" section. The featured image is set from the hero URL once per URL, with its alt text; a regenerated hero is a new URL and costs exactly one new download by Shopify.

Posts that use DailySmith's rich components load the API's component stylesheet through a `<link>` at the top of the body, plus one `<style>` with the host reset and the blog's palette; plain posts carry only the palette. Everything is scoped to the `.baas-wrap` wrapper, so it cannot restyle the rest of the theme.

Only the blog's own language is mirrored. DailySmith publishes each language of an article as its own post; Shopify blogs are single-language, and mapping translation groups onto Shopify's translation system is a separate feature. The blog's language is asked for by omission rather than by name, so a region-tagged language (pt-BR) is answered with its articles instead of an empty edition.

## The wire contract

The body wrapper is `<div class="baas-wrap md2" data-baas-theme="light">`. "baas" was DailySmith's working name and is still what the API scopes its stylesheet and every blog palette to, so it stays. The `dailysmith.*` metafields are this app's own.

## Development

| Path | What |
|---|---|
| `server.js` | Process entry: config, database, app, scheduler |
| `src/app.js` | Express app: Shopify install and sessions, settings API, webhooks, the embedded page |
| `src/engine.js` | The sync: walk, create or update, adopt, reconcile |
| `src/shopify-admin.js` | Admin GraphQL client, the six operations, throttling |
| `src/delivery-api.js` | DailySmith delivery API client |
| `src/render.js` | Body wrapping and styling |
| `src/db.js` | SQLite: sessions, per-shop settings and state, article index |
| `src/scheduler.js` | The one-minute tick |
| `public/index.html` | The settings page (vanilla JS, App Bridge) |
| `bin/sync.js` | Run one sync from a terminal or cron |
| `test/` | Stubs of both APIs and the tests that run the engine and the HTTP layer against them |

```bash
npm ci
npm test
```

The tests need no network and no Shopify account. `test/stub-shopify.js` is the Admin API stand-in: it enforces unique handles per blog, upserts metafields, answers `NOT_FOUND` for a deleted article and can throttle on demand. `test/stub-delivery.js` serves the same fixtures the WordPress plugin's smoke test uses.

## CI and releases

Every push and pull request runs [ci.yml](.github/workflows/ci.yml): the tests, then a build of the container image with a check that the native SQLite module loads inside it.

A release is a version bump merged to main. Set `version` in `package.json`, add a `## <version>` section to `CHANGELOG.md`, and merge. When CI is green on main, [release.yml](.github/workflows/release.yml) sees that the version has no release yet, builds the image, pushes it as `ghcr.io/technicalinsideti/dailysmith-shopify-app:<version>` and `:latest`, and publishes a GitHub release tagged `v<version>` with the changelog section as its notes. A version that is already released is left alone, so the workflow can be re-run by hand.

## License

MIT. See [LICENSE](LICENSE).
