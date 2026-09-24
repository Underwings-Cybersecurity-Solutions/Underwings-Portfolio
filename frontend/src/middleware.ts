import { defineMiddleware } from 'astro:middleware';
import crypto from 'node:crypto';

const SITE_URL = import.meta.env.PUBLIC_SITE_URL || process.env.PUBLIC_SITE_URL || 'https://underwings.org';
const ALLOWED_ORIGINS = [
  'https://underwings.org',
  SITE_URL,
  'http://localhost:8080',
  'http://localhost:4321',
];

export const onRequest = defineMiddleware(async (context, next) => {
  // --- Trailing slash: 301 to the canonical no-slash form ---
  // astro.config sets trailingSlash: 'never', which makes the no-slash URL the
  // only one that RESOLVES — the node adapter returns a hard 404 for the slash
  // variant rather than redirecting. So every inbound link, bookmark, pasted
  // URL or directory-style link written as /about/ was a dead end, and Search
  // Console logged it under "Not found (404)".
  //
  // Handled here rather than in nginx because the deployed nginx config has
  // drifted from nginx/nginx.conf in this repo; middleware ships with the app
  // and cannot drift.
  //
  // GET/HEAD only: redirecting a POST would drop the body.
  if (context.request.method === 'GET' || context.request.method === 'HEAD') {
    const url = new URL(context.request.url);
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      const stripped = url.pathname.replace(/\/+$/, '') || '/';
      return context.redirect(stripped + url.search, 301);
    }
  }

  // --- CSRF: Origin validation on state-changing requests ---
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(context.request.method)) {
    const origin = context.request.headers.get('origin');
    const referer = context.request.headers.get('referer');
    const checkValue = origin || (referer ? new URL(referer).origin : null);

    if (checkValue && !ALLOWED_ORIGINS.some(o => checkValue.startsWith(o))) {
      return new Response(JSON.stringify({ error: 'Forbidden: invalid origin' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // --- CSP: Generate nonce ---
  const nonce = crypto.randomBytes(16).toString('base64');
  context.locals.nonce = nonce;

  const response = await next();

  // Only add CSP to HTML responses (not API JSON, images, etc.)
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    const csp = [
      `default-src 'self'`,
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://d3e54v103j8qbb.cloudfront.net https://cdn.prod.website-files.com https://js.usemessages.com https://challenges.cloudflare.com https://www.googletagmanager.com https://www.google-analytics.com`,
      `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
      `img-src 'self' data: blob: https://cdn.brandfetch.io https://www.offsec.com https://www.google-analytics.com https://www.googletagmanager.com`,
      `font-src 'self' data: https://fonts.gstatic.com`,
      `media-src 'self' blob:`,
      `connect-src 'self' https://api.anthropic.com https://challenges.cloudflare.com https://www.google-analytics.com https://analytics.google.com https://www.googletagmanager.com`,
      `frame-src 'self' https://crm.zoho.com https://challenges.cloudflare.com`,
      `frame-ancestors 'self'`,
    ].join('; ');

    response.headers.set('Content-Security-Policy', csp);
  }

  return response;
});
