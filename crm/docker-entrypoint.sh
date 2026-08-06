#!/bin/sh
# Substitute runtime config into the served env.js (see src/public/env.js).
set -e
ENV_JS=/usr/share/nginx/html/env.js
sed -i "s|__SUPABASE_URL__|${SUPABASE_URL}|g"           "$ENV_JS"
sed -i "s|__SUPABASE_ANON_KEY__|${SUPABASE_ANON_KEY}|g" "$ENV_JS"
# Fail fast rather than serving a login page that can never authenticate.
if grep -q '__SUPABASE_' "$ENV_JS"; then
  echo "FATAL: SUPABASE_URL / SUPABASE_ANON_KEY not provided to the crm container" >&2
  exit 1
fi
exec "$@"
