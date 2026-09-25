#!/usr/bin/env bash
# Every 15 minutes: mirror new LinkedIn ad leads from Zoho CRM into Supabase and
# email the team (see frontend/src/pages/api/admin/linkedin-sync.ts).
set -u
cd "$(dirname "$0")/.."
TOKEN=$(grep -E '^ZOHO_RESYNC_TOKEN=' .env | cut -d= -f2- | tr -d '"')
[ -n "$TOKEN" ] || { echo "$(date -u +%FT%TZ) ZOHO_RESYNC_TOKEN missing"; exit 2; }
OUT=$(docker exec -e RT="$TOKEN" underwings-frontend sh -c 'wget -qO- --header="X-Resync-Token: $RT" --post-data="" http://127.0.0.1:4321/api/admin/linkedin-sync' 2>&1)
RC=$?
# Log only when something happened or failed, so the log stays readable.
if [ "$RC" -ne 0 ] || [[ "$OUT" != *'"ok":true'* ]] || [[ "$OUT" == *'"mirrored":'[1-9]* ]]; then echo "$(date -u +%FT%TZ) rc=$RC $OUT"; fi
[ "$RC" -eq 0 ] && [[ "$OUT" == *'"ok":true'* ]]
