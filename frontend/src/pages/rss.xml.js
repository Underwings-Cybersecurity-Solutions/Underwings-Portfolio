import { getBlogPosts } from '../lib/supabase';

// MUST stay SSR. Prerendered at build time this feed baked in zero items,
// because Supabase is unreachable from the build container — which is why
// /rss.xml served an empty channel in production despite 12 published posts.
export const prerender = false;

export async function GET() {
  const siteUrl = import.meta.env.PUBLIC_SITE_URL || 'https://underwings.org';
  const posts = await getBlogPosts(50);

  const items = posts.map(post => `
    <item>
      <title><![CDATA[${post.title}]]></title>
      <link>${siteUrl}/blog/${post.slug}</link>
      <guid isPermaLink="true">${siteUrl}/blog/${post.slug}</guid>
      <description><![CDATA[${post.excerpt || ''}]]></description>
      <pubDate>${new Date(post.published_at).toUTCString()}</pubDate>
      ${post.category ? `<category>${post.category}</category>` : ''}
    </item>`).join('');

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Underwings Cybersecurity Solutions Blog</title>
    <description>Insights on cybersecurity, compliance, penetration testing, and security best practices.</description>
    <link>${siteUrl}/blog</link>
    <atom:link href="${siteUrl}/rss.xml" rel="self" type="application/rss+xml"/>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>${items}
  </channel>
</rss>`;

  return new Response(rss.trim(), {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' }
  });
}
