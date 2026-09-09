// Client for DailySmith's public delivery API, keyed by a site's pk_ key.
// Same two endpoints the WordPress plugin polls, same envelope.

export class DeliveryApiError extends Error {
  constructor(message, { status = 0, code = 'delivery_api' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class DeliveryApi {
  constructor({ apiBase, publicKey, userAgent = 'dailysmith-shopify-app', fetch = globalThis.fetch }) {
    this.base = String(apiBase || '').replace(/\/+$/, '');
    this.key = String(publicKey || '');
    this.userAgent = userAgent;
    this.fetch = fetch;
  }

  // The site's blogs: name, base_path, default_locale, and the additional
  // languages fan-out publishes into (absent on an API older than fan-out).
  async blogs() {
    const body = await this.request(`/v1/delivery/${encodeURIComponent(this.key)}/blogs`, {});
    return Array.isArray(body.blogs) ? body.blogs : [];
  }

  // One page of the sync feed. An empty `locale` asks for the blog's own
  // language by omission, which the API resolves straight to the blog's
  // stored default; an explicit tag goes through its language catalog first.
  // `cursor` (echoed from the previous envelope's next_cursor) is the walk's
  // position; `page` is the older ladder an API without cursors still honours.
  async updatedPosts({ basePath, since = '', page = 1, locale = '', cursor = '' }) {
    const query = { base_path: basePath, page: String(Math.max(1, page | 0)) };
    if (since) query.since = since;
    if (locale) query.locale = locale;
    if (cursor) query.cursor = cursor;
    return this.request(`/v1/delivery/${encodeURIComponent(this.key)}/posts/updated`, query);
  }

  // Where a fragment's css_href points: relative to this API's origin.
  resolveCss(href) {
    if (!href) return `${this.base}/v1/sdk/md2.css`;
    return new URL(href, `${this.base}/`).toString();
  }

  async request(path, query) {
    if (!this.base || !this.key) {
      throw new DeliveryApiError('Set the API base URL and site key first.', { code: 'unconfigured' });
    }
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    let res;
    try {
      res = await this.fetch(url, {
        headers: { accept: 'application/json', 'user-agent': this.userAgent },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new DeliveryApiError(`could not reach the API: ${err.message}`, { code: 'network' });
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (res.status !== 200) {
      // problem+json: `detail` names the actual problem ("unknown or
      // unverified site key") better than a bare status would.
      const detail = json && typeof json.detail === 'string' && json.detail ? json.detail : `the API answered HTTP ${res.status}`;
      throw new DeliveryApiError(detail, { status: res.status, code: 'http' });
    }
    if (!json || typeof json !== 'object') {
      throw new DeliveryApiError('The API did not answer with JSON. Is the API base URL the DailySmith API origin?', { code: 'not_json' });
    }
    return json;
  }
}
