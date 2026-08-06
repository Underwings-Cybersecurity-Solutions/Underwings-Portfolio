// Runtime config. Values are substituted by docker-entrypoint.sh on container
// start. Kept in a served file rather than an inline <script> so the CSP can
// forbid inline script entirely (script-src 'self').
window.SUPABASE_URL = "__SUPABASE_URL__";
window.SUPABASE_ANON_KEY = "__SUPABASE_ANON_KEY__";
