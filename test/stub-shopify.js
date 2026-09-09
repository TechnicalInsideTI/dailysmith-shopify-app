// A stand-in for the Shopify Admin GraphQL API: just the operations the
// engine uses, dispatched by operation name, with the behaviours the
// ownership contract depends on. Handles are unique per blog and a taken one
// is refused with the TAKEN code; metafields are upserted by namespace and
// key; an update to a deleted article answers NOT_FOUND; `throttleNext()`
// makes the next call answer THROTTLED once.
import http from 'node:http';

export async function startShopifyStub({ shop = 'test-shop.myshopify.com', accessToken = 'shpat_test' } = {}) {
  let nextId = 1000;
  const state = {
    shopName: 'Test Shop',
    blogs: [{ id: 'gid://shopify/Blog/1', title: 'News', handle: 'news' }],
    articles: new Map(), // id -> article
    calls: [],
    throttleNext: 0,
    rejectAuth: false,
  };

  const gid = () => `gid://shopify/Article/${nextId++}`;

  function applyMetafields(article, list) {
    for (const m of list || []) {
      article.metafields.set(`${m.namespace}.${m.key}`, { namespace: m.namespace, key: m.key, type: m.type, value: m.value });
    }
  }
  function handleTaken(blogId, handle, exceptId) {
    for (const a of state.articles.values()) {
      if (a.blogId === blogId && a.handle === handle && a.id !== exceptId) return true;
    }
    return false;
  }
  function articleNode(a) {
    return { id: a.id, handle: a.handle, isPublished: a.isPublished };
  }

  const ops = {
    DailySmithShopBlogs: () => ({ shop: { name: state.shopName }, blogs: { nodes: state.blogs } }),
    shopifyAppShopName: () => ({ shop: { name: state.shopName } }),
    DailySmithBlogArticles: ({ id, after }) => {
      const all = [...state.articles.values()].filter((a) => a.blogId === id);
      const start = after ? Number(after) : 0;
      const pageSize = 2; // small on purpose, so pagination is exercised
      const slice = all.slice(start, start + pageSize);
      return {
        blog: {
          articles: {
            pageInfo: { hasNextPage: start + pageSize < all.length, endCursor: String(start + pageSize) },
            nodes: slice.map((a) => ({
              ...articleNode(a),
              metafields: { nodes: [...a.metafields.values()].filter((m) => m.namespace === 'dailysmith').map((m) => ({ key: m.key, value: m.value })) },
            })),
          },
        },
      };
    },
    DailySmithArticleCreate: ({ article: input }) => {
      const errors = [];
      if (!state.blogs.some((b) => b.id === input.blogId)) errors.push({ field: ['article', 'blogId'], message: 'Blog does not exist', code: 'NOT_FOUND' });
      if (!input.title) errors.push({ field: ['article', 'title'], message: "can't be blank", code: 'BLANK' });
      if (!input.author?.name) errors.push({ field: ['article', 'author'], message: 'author is required', code: 'BLANK' });
      const handle = input.handle || String(input.title).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      if (handleTaken(input.blogId, handle)) errors.push({ field: ['article', 'handle'], message: 'Handle has already been taken', code: 'TAKEN' });
      if (errors.length) return { articleCreate: { article: null, userErrors: errors } };
      const a = { id: gid(), blogId: input.blogId, title: input.title, handle, body: input.body || '', summary: input.summary || '', author: input.author.name, isPublished: !!input.isPublished, publishDate: input.publishDate || null, image: input.image || null, imageSets: input.image ? 1 : 0, metafields: new Map(), owner: 'app' };
      applyMetafields(a, input.metafields);
      state.articles.set(a.id, a);
      return { articleCreate: { article: articleNode(a), userErrors: [] } };
    },
    DailySmithArticleUpdate: ({ id, article: input }) => {
      const a = state.articles.get(id);
      if (!a) return { articleUpdate: { article: null, userErrors: [{ field: ['id'], message: 'Article not found', code: 'NOT_FOUND' }] } };
      if (input.handle && handleTaken(a.blogId, input.handle, a.id)) return { articleUpdate: { article: null, userErrors: [{ field: ['article', 'handle'], message: 'Handle has already been taken', code: 'TAKEN' }] } };
      for (const k of ['title', 'handle', 'body', 'summary', 'publishDate']) if (input[k] !== undefined) a[k] = input[k];
      if (input.isPublished !== undefined) a.isPublished = !!input.isPublished;
      if (input.author?.name) a.author = input.author.name;
      if (input.image) { a.image = input.image; a.imageSets++; }
      applyMetafields(a, input.metafields);
      return { articleUpdate: { article: articleNode(a), userErrors: [] } };
    },
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (status, body, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      if (req.headers['x-shopify-access-token'] !== accessToken || state.rejectAuth) return send(401, { errors: 'Invalid API key or access token' });
      if (!req.url.startsWith('/admin/api/')) return send(404, { errors: 'not found' });
      if (state.throttleNext > 0) {
        state.throttleNext--;
        return send(200, { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] });
      }
      let body;
      try { body = JSON.parse(raw); } catch { return send(400, { errors: 'bad json' }); }
      const name = (String(body.query).match(/^\s*(?:query|mutation)\s+(\w+)/) || [])[1];
      state.calls.push({ name, variables: body.variables });
      const op = ops[name];
      if (!op) return send(200, { errors: [{ message: `stub has no operation ${name}` }] });
      send(200, { data: op(body.variables || {}) });
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    shop,
    accessToken,
    url: `http://127.0.0.1:${port}`,
    state,
    // A merchant's own article, written by hand in the admin.
    addMerchantArticle: ({ blogId = state.blogs[0].id, handle, title = handle, body = '<p>MINE, hands off.</p>' }) => {
      const a = { id: gid(), blogId, title, handle, body, summary: '', author: 'Merchant', isPublished: true, publishDate: null, image: null, imageSets: 0, metafields: new Map(), owner: 'merchant' };
      state.articles.set(a.id, a);
      return a;
    },
    deleteArticle: (id) => state.articles.delete(id),
    articlesInBlog: (blogId = state.blogs[0].id) => [...state.articles.values()].filter((a) => a.blogId === blogId),
    byMarker: (postId) => [...state.articles.values()].filter((a) => a.metafields.get('dailysmith.post_id')?.value === postId),
    throttleNext: (n = 1) => (state.throttleNext = n),
    callsNamed: (name) => state.calls.filter((c) => c.name === name),
    close: () => new Promise((r) => server.close(r)),
  };
}
