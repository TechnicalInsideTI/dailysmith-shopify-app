// What a synced article's body looks like. Byte-compatible with what
// DailySmith's other channels write: the `.baas-wrap md2` wrapper (the API's
// component stylesheet and every blog palette are scoped to it) with the light
// token set pinned, because storefront themes are overwhelmingly light and an
// unpinned wrapper would hand OS-dark readers dark components on a light page.
//
// Shopify has no per-article stylesheet hook, so the styling rides inside the
// body: a <link> to the API's component stylesheet when the content uses MD2
// components, and one <style> for the host reset plus the blog's palette.

const WRAP_OPEN = '<div class="baas-wrap md2" data-baas-theme="light">';
const WRAP_CLOSE = '</div>';

// Hands page typography back to the theme: without it `.md2` would impose
// its own font stack and text colour on the article.
export const HOST_RESET = '.baas-wrap.md2 { font-family: inherit; color: inherit; line-height: inherit; background: transparent; }';

export function renderBody({ bodyHtml = '', themeCss = '', cssUrl = '' }) {
  const usesComponents = bodyHtml.includes('md2-');
  const parts = [];
  if (usesComponents && cssUrl) {
    parts.push(`<link rel="stylesheet" href="${escapeAttr(cssUrl)}">`);
  }
  const css = [usesComponents ? HOST_RESET : '', themeCss ? String(themeCss).trim() : ''].filter(Boolean).join('\n');
  if (css) {
    parts.push(`<style>\n${css}\n</style>`);
  }
  parts.push(WRAP_OPEN, String(bodyHtml).trim(), WRAP_CLOSE);
  return parts.join('\n');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
