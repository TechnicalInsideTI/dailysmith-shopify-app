// A small Admin GraphQL client: the six operations the sync needs, with
// throttling handled. Written against fetch rather than the library's client
// so the tests can point it at a stub with one environment variable.

export class ShopifyAdminError extends Error {
  constructor(message, { code = 'graphql', errors = [], userErrors = [] } = {}) {
    super(message);
    this.code = code;
    this.errors = errors;
    this.userErrors = userErrors;
  }
}

const ARTICLE_FIELDS = 'id handle isPublished';

export class ShopifyAdmin {
  constructor({ shop, accessToken, apiVersion, baseUrl = '', fetch = globalThis.fetch, userAgent = 'dailysmith-shopify-app' }) {
    this.shop = shop;
    this.token = accessToken;
    this.apiVersion = apiVersion;
    this.endpoint = `${(baseUrl || `https://${shop}`).replace(/\/+$/, '')}/admin/api/${apiVersion}/graphql.json`;
    this.fetch = fetch;
    this.userAgent = userAgent;
  }

  // Runs one operation. Retries a throttled call (HTTP 429, or a 200 whose
  // errors carry THROTTLED) with backoff; anything else is thrown.
  async graphql(query, variables = {}) {
    let delay = 500;
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-shopify-access-token': this.token,
          'user-agent': this.userAgent,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      const throttled =
        res.status === 429 || (body && Array.isArray(body.errors) && body.errors.some((e) => e?.extensions?.code === 'THROTTLED'));
      if (throttled && attempt < 6) {
        const retryAfter = Number(res.headers.get('retry-after')) * 1000;
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : delay);
        delay = Math.min(delay * 2, 8000);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new ShopifyAdminError(`Shopify refused the access token (HTTP ${res.status})`, { code: 'unauthorized' });
      }
      if (res.status !== 200 || !body) {
        throw new ShopifyAdminError(`Shopify answered HTTP ${res.status}${body ? '' : ' with no JSON'}`, { code: 'http' });
      }
      if (Array.isArray(body.errors) && body.errors.length) {
        throw new ShopifyAdminError(body.errors.map((e) => e.message).join('; '), { errors: body.errors });
      }
      return body.data || {};
    }
  }

  async shopAndBlogs() {
    const data = await this.graphql(`query DailySmithShopBlogs {
      shop { name }
      blogs(first: 50) { nodes { id title handle } }
    }`);
    return { shopName: data.shop?.name || '', blogs: data.blogs?.nodes || [] };
  }

  // Every article in a blog, with this app's metafields: what the engine
  // reads to rebuild its index from the markers on the articles themselves.
  async listBlogArticles(blogId) {
    const out = [];
    let after = null;
    for (;;) {
      const data = await this.graphql(
        `query DailySmithBlogArticles($id: ID!, $after: String) {
          blog(id: $id) {
            articles(first: 250, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                ${ARTICLE_FIELDS}
                metafields(namespace: "dailysmith", first: 10) { nodes { key value } }
              }
            }
          }
        }`,
        { id: blogId, after }
      );
      const conn = data.blog?.articles;
      if (!conn) break;
      for (const node of conn.nodes || []) {
        const meta = {};
        for (const m of node.metafields?.nodes || []) meta[m.key] = m.value;
        out.push({ id: node.id, handle: node.handle, isPublished: node.isPublished, meta });
      }
      if (!conn.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    return out;
  }

  async createArticle(article) {
    const data = await this.graphql(
      `mutation DailySmithArticleCreate($article: ArticleCreateInput!) {
        articleCreate(article: $article) {
          article { ${ARTICLE_FIELDS} }
          userErrors { field message code }
        }
      }`,
      { article }
    );
    return data.articleCreate || { article: null, userErrors: [{ message: 'empty articleCreate response' }] };
  }

  async updateArticle(id, article) {
    const data = await this.graphql(
      `mutation DailySmithArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
        articleUpdate(id: $id, article: $article) {
          article { ${ARTICLE_FIELDS} }
          userErrors { field message code }
        }
      }`,
      { id, article }
    );
    return data.articleUpdate || { article: null, userErrors: [{ message: 'empty articleUpdate response' }] };
  }
}

// Shopify names a taken handle in the error's field path or its code.
export function isHandleTaken(userErrors) {
  return (userErrors || []).some(
    (e) =>
      (Array.isArray(e.field) && e.field.includes('handle') && /taken|already/i.test(e.message || '')) ||
      String(e.code || '').toUpperCase() === 'TAKEN'
  );
}

// An update aimed at an article the merchant has since deleted.
export function isNotFound(payload) {
  if (!payload) return false;
  if (payload.article) return false;
  return (payload.userErrors || []).some(
    (e) => String(e.code || '').toUpperCase() === 'NOT_FOUND' || /not found|does not exist|doesn't exist/i.test(e.message || '')
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
