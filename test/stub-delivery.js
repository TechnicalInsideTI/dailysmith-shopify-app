// A stub of DailySmith's delivery API, in-process. Serves several site keys,
// each modelling one shape the real API can answer with (the same fixtures
// the WordPress plugin's smoke test uses):
//
//   pk_smoke   two published posts on /blog (one MD2-rich with a hero, one
//              plain); `bump()` edits them upstream.
//   pk_empty   the same blog with nothing published: the takedown case.
//   pk_multi   /news in en plus ro. Only the blog's own language is mirrored,
//              asked for by omission; the stub records every request so a
//              test can prove no ?locale= was ever sent.
//   pk_region  /notes, a pt-BR blog: an explicit ?locale=pt-BR would resolve
//              to the (empty) pt edition, asking by omission returns the post.
//   pk_paged   /paged, three posts served one per page, the first edited the
//              instant the walk begins. Only a cursor walk mirrors all three.
//   pk_flaky   /blog, but the feed answers 500 once per `failNext()`.
import http from 'node:http';

const CATALOG = ['de', 'en', 'es', 'fr', 'it', 'nl', 'pt', 'ro'];

export async function startDeliveryStub() {
  const state = { bump: 1, requests: [], failNext: 0, pagedServed: 0 };

  const smokePosts = () => [
    {
      id: '01a09000-0000-7000-8000-000000000001',
      slug: state.bump >= 4 ? 'hello-md2-renamed' : 'hello-md2',
      title: `Hello MD2 (v${state.bump})`,
      excerpt: 'A rich post.',
      path: '/blog/hello-md2',
      published_at: '2026-08-19T09:00:00Z',
      updated_at: `2026-08-20T0${state.bump}:00:00.123456Z`,
      reading_minutes: 3,
      body_html: '<p>Rich body.</p><div class="md2-callout md2-callout-info"><p>Callout</p></div><div class="md2-chart"><svg width="10" height="10"><rect width="10" height="10"/></svg></div>',
      seo: { title_tag: 'Hello MD2 | Smoke', meta_description: 'A rich post about MD2.' },
      focus_keyword: 'md2 components',
      hero_image_url: state.bump >= 3 ? 'https://media.example/hero-v3.png' : 'https://media.example/hero.png',
      hero_image_alt: 'A red pixel standing alone',
    },
    {
      id: '01a09000-0000-7000-8000-000000000002',
      slug: 'plain-post',
      title: `Plain post (v${state.bump})`,
      excerpt: 'No components.',
      path: '/blog/plain-post',
      published_at: '2026-08-19T10:00:00Z',
      updated_at: `2026-08-20T0${state.bump}:00:00.123456Z`,
      reading_minutes: 2,
      body_html: '<p>Just prose.</p>',
      seo: { title_tag: 'Plain | Smoke', meta_description: 'Prose only.' },
      focus_keyword: '',
    },
  ];
  const groupEn = { id: '01a09000-0000-7000-8000-00000000ae01', slug: 'translation-group', title: 'The translated article', excerpt: 'English edition.', path: '/news/translation-group', published_at: '2026-08-18T09:00:00Z', updated_at: '2026-08-18T09:30:00.500000Z', reading_minutes: 4, body_html: '<p>English body.</p>', seo: { title_tag: 'The translated article', meta_description: 'English edition.' }, focus_keyword: 'translation' };
  const groupRo = { id: '01a09000-0000-7000-8000-00000000ae02', slug: 'translation-group', title: 'Articolul tradus', excerpt: 'Ediția română.', path: '/news/translation-group', published_at: '2026-08-18T09:00:00Z', updated_at: '2026-08-18T09:45:00.500000Z', reading_minutes: 4, body_html: '<p>Corpul în română.</p>', seo: { title_tag: 'Articolul tradus', meta_description: 'Ediția română.' }, focus_keyword: 'traducere' };
  const regionPost = { id: '01a09000-0000-7000-8000-00000000be01', slug: 'artigo-regional', title: 'Artigo regional', excerpt: 'Edição pt-BR.', path: '/notes/artigo-regional', published_at: '2026-08-17T09:00:00Z', updated_at: '2026-08-17T09:30:00.500000Z', reading_minutes: 2, body_html: '<p>Corpo do artigo.</p>', seo: { title_tag: 'Artigo regional', meta_description: 'Edição pt-BR.' }, focus_keyword: '' };
  const pagedPosts = () =>
    [['c001', 'one', '09:00'], ['c002', 'two', '09:10'], ['c003', 'three', '09:20']].map(([suffix, word, minute]) => ({
      id: `01a09000-0000-7000-8000-00000000${suffix}`,
      slug: `paged-${word}`,
      title: `Paged ${word}`,
      excerpt: `Article ${word}.`,
      path: `/paged/paged-${word}`,
      published_at: `2026-08-16T${minute}:00Z`,
      updated_at: `2026-08-16T${minute}:00.000000Z`,
      reading_minutes: 1,
      body_html: `<p>Article ${word}.</p>`,
      seo: { title_tag: `Paged ${word}`, meta_description: `Article ${word}.` },
      focus_keyword: '',
    }));

  const sites = () => ({
    pk_smoke: { blog: { name: 'Smoke Blog', base_path: '/blog', default_locale: 'en' }, editions: { en: smokePosts() } },
    pk_empty: { blog: { name: 'Smoke Blog', base_path: '/blog', default_locale: 'en' }, editions: {} },
    pk_multi: { blog: { name: 'News', base_path: '/news', default_locale: 'en', locales: ['ro'] }, editions: { en: [groupEn], ro: [groupRo] } },
    pk_region: { blog: { name: 'Notes', base_path: '/notes', default_locale: 'pt-BR', locales: [] }, editions: { 'pt-BR': [regionPost] } },
    pk_paged: { blog: { name: 'Paged', base_path: '/paged', default_locale: 'en' }, editions: { en: pagedPosts() }, pageSize: 1, editAfterFirstPage: true },
    pk_flaky: { blog: { name: 'Flaky', base_path: '/blog', default_locale: 'en' }, editions: { en: smokePosts() } },
    pk_two: {
      blogs: [
        { name: 'Smoke Blog', base_path: '/blog', default_locale: 'en' },
        { name: 'Paged', base_path: '/paged', default_locale: 'en' },
      ],
      editionsByBase: { '/blog': { en: smokePosts() }, '/paged': { en: pagedPosts() } },
    },
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    const q = Object.fromEntries(url.searchParams);
    state.requests.push({ path: url.pathname, query: q });
    const json = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(JSON.stringify(body));
    };
    const problem = (status, detail) => json(status, { type: 'about:blank', title: 'err', status, detail }, 'application/problem+json');

    if (url.pathname === '/v1/sdk/md2.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      return res.end('.baas-wrap .md2-callout{border:1px solid}\n');
    }
    const m = url.pathname.match(/^\/v1\/delivery\/(pk_[a-z_]+)\/(blogs|posts\/updated)$/);
    if (!m) return problem(404, `no such route: ${url.pathname}`);
    const site = sites()[m[1]];
    if (!site) return problem(404, 'unknown or unverified site key');
    if (m[2] === 'blogs') return json(200, { blogs: site.blogs || [site.blog] });

    if (m[1] === 'pk_flaky' && state.failNext > 0) {
      state.failNext--;
      return problem(500, 'the feed fell over');
    }

    const blogs = site.blogs || [site.blog];
    const base = q.base_path || blogs[0].base_path;
    const blog = blogs.find((b) => b.base_path.replace(/\/$/, '') === String(base).replace(/\/$/, ''));
    if (!blog) return problem(404, 'no blog at that base path');
    const editions = site.editionsByBase ? site.editionsByBase[blog.base_path] : site.editions;
    const locale = resolveLocale(q.locale || '', blog.default_locale);
    let posts = [...(editions[locale] || [])];

    if (site.editAfterFirstPage) {
      state.pagedServed++;
      if (state.pagedServed > 1 && posts.length) {
        posts[0] = { ...posts[0], updated_at: '2026-08-16T23:59:00.000000Z', title: `${posts[0].title} (edited mid-walk)` };
      }
    }
    if (q.since) posts = posts.filter((p) => Date.parse(p.updated_at) >= Date.parse(q.since));

    const envelope = { base_path: blog.base_path, locale, theme_css: ':where(.baas-wrap, [data-baas-blog]){--md2-bg:#0a1128}', css_href: '/v1/sdk/md2.css' };
    const size = site.pageSize || 0;
    if (size < 1) return json(200, { ...envelope, posts, page: 1, total_pages: posts.length ? 1 : 0 });

    posts.sort((a, b) => (a.updated_at + a.id < b.updated_at + b.id ? -1 : 1));
    const total = posts.length;
    const after = decodeCursor(q.cursor || '');
    if (after) posts = posts.filter((p) => `${p.updated_at}|${p.id}` > `${after[0]}|${after[1]}`);
    else posts = posts.slice((Math.max(1, Number(q.page) || 1) - 1) * size);
    posts = posts.slice(0, size);
    const out = { ...envelope, posts, page: Math.max(1, Number(q.page) || 1), total_pages: Math.ceil(total / size) };
    if (posts.length === size) out.next_cursor = encodeCursor(posts[posts.length - 1]);
    json(200, out);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    bump: () => state.bump++,
    failNext: (n = 1) => (state.failNext = n),
    requestsFor: (key) => state.requests.filter((r) => r.path.includes(`/${key}/`)),
    close: () => new Promise((r) => server.close(r)),
  };
}

function resolveLocale(requested, fallback) {
  const tag = String(requested).trim().toLowerCase().replace('_', '-');
  if (!tag) return fallback;
  if (CATALOG.includes(tag)) return tag;
  const base = tag.split('-')[0];
  if (CATALOG.includes(base)) return base;
  return fallback;
}
function encodeCursor(p) {
  return Buffer.from(`${p.updated_at}|${p.id}`).toString('base64url');
}
function decodeCursor(raw) {
  if (!raw) return null;
  const s = Buffer.from(raw, 'base64url').toString();
  return s.includes('|') ? s.split('|', 2) : null;
}
