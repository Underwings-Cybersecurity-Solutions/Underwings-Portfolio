// ===========================================
// BLOG SITEMAP
// ===========================================
//
// @astrojs/sitemap only emits PRERENDERED routes. Both /blog and /blog/[slug]
// are `prerender = false` (posts come from Supabase and are published from the
// admin dashboard without a rebuild), so every article was silently missing
// from sitemap-index.xml — twelve posts with zero sitemap coverage.
//
// Prerendering the blog would fix the sitemap but break instant publishing, and
// the site's per-request CSP nonce needs SSR anyway. So the blog gets its own
// dynamic sitemap instead, listed alongside the static one in robots.txt.
//
// Keep this in sync with robots.txt — both sitemaps must be declared there.

import { getBlogPosts } from '../lib/supabase';

// MUST stay SSR. Astro's hybrid output prerenders endpoints by default, and
// Supabase is not reachable from the Docker build container — so a prerendered
// version bakes an EMPTY sitemap at build time. This is exactly the bug that
// left /rss.xml serving zero items in production.
export const prerender = false;

// Escape the five XML predefined entities. Slugs are URL-safe, but titles and
// arbitrary DB content must never be able to break the document.
function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isoDate(value) {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

export async function GET() {
  const siteUrl = import.meta.env.PUBLIC_SITE_URL || 'https://underwings.org';

  // 500 is far above the current post count and keeps this a single request.
  const posts = await getBlogPosts(500);

  const entries = posts
    .filter((p) => p && p.slug)
    .map((post) => {
      const lastmod = isoDate(post.updated_at) || isoDate(post.published_at);
      return [
        '  <url>',
        `    <loc>${xmlEscape(`${siteUrl}/blog/${post.slug}`)}</loc>`,
        lastmod ? `    <lastmod>${lastmod}</lastmod>` : null,
        '    <changefreq>monthly</changefreq>',
        '    <priority>0.7</priority>',
        '  </url>',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      // Crawlers re-fetch often; an hour keeps this cheap without delaying
      // discovery of a newly published post for long.
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
