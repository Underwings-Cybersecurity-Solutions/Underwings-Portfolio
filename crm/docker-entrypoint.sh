#!/bin/sh
# Replace env var placeholders in built HTML
sed -i "s|__SUPABASE_URL__|${SUPABASE_URL}|g" /usr/share/nginx/html/index.html
sed -i "s|__SUPABASE_ANON_KEY__|${SUPABASE_ANON_KEY}|g" /usr/share/nginx/html/index.html
exec "$@"
