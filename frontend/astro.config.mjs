// ===========================================
// ASTRO CONFIGURATION
// Underwings Cybersecurity Solutions Frontend
// ===========================================

import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import sitemap from '@astrojs/sitemap';

// Pages whose source is just `return Astro.redirect(...)` to a hub section.
const RETIRED_REDIRECT_STUBS = [
  '/services/grc/continuous-compliance-subscription',
  '/services/offensive-security/ptaas-subscription',
];

export default defineConfig({
  output: 'hybrid',
  adapter: node({
    mode: 'standalone'
  }),
  // Canonicalisation: enforce a single no-trailing-slash URL form so the
  // homepage (and every page) is not indexed as both /foo and /foo/.
  trailingSlash: 'never',
  integrations: [sitemap({
    // Retired pages that only 301 to a hub section. Keeping them in the sitemap
    // makes Search Console report "URL redirects" for every submission.
    filter: (page) => !RETIRED_REDIRECT_STUBS.some((slug) => page.endsWith(slug)),
  })],
  compressHTML: true,
  server: {
    port: 4321,
    host: true
  },
  prefetch: {
    prefetchAll: false,
    defaultStrategy: 'viewport'
  },
  vite: {
    define: {
      'import.meta.env.PUBLIC_SUPABASE_URL': JSON.stringify(process.env.PUBLIC_SUPABASE_URL),
      'import.meta.env.PUBLIC_SUPABASE_ANON_KEY': JSON.stringify(process.env.PUBLIC_SUPABASE_ANON_KEY)
    },
    build: {
      cssMinify: true,
      minify: 'esbuild'
    }
  },
  site: process.env.PUBLIC_SITE_URL || 'https://underwings.org'
});
