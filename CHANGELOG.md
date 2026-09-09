# Changelog

## 0.1.0

First release. Mirrors a DailySmith blog into one Shopify blog on a schedule:

* Every DailySmith blog on the site, walked by cursor from a per-blog
  checkpoint, so an article edited mid-walk cannot push a neighbour out of
  the walk.
* Create, update in place, or skip, keyed on the `dailysmith.post_id`
  metafield. An article the app did not create is never touched: a slug the
  merchant's own article holds gets a suffix instead. The local index is
  rebuilt from the metafields on a cold start and on every reconcile.
* Daily reconcile that unpublishes (never deletes) articles DailySmith no
  longer publishes.
* Featured image set once per hero URL, with its alt text. SEO title and
  description written to Shopify's own `global.title_tag` and
  `global.description_tag` metafields.
* Rich-content styling inside the body: the API's component stylesheet
  linked when the post uses MD2 components, the blog palette inlined, the
  shared `.baas-wrap md2` wrapper.
* Two ways to run it: as an embedded Shopify app (token exchange, offline
  sessions in SQLite, compliance webhooks), or for one store with a custom
  app token and no OAuth.
* Only the blog's own language is mirrored, asked for by omission.

Exercised against stubs of both APIs (see `test/`), not yet against a live
Shopify store.
