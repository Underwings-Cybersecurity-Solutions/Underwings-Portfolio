#!/usr/bin/env bash
# Tell Bing (and every IndexNow participant) which URLs changed. Run after a
# deploy or a blog publish:  scripts/indexnow-ping.sh [url ...]
# With no arguments it submits every URL in both sitemaps (max 10,000 per call).
set -euo pipefail
cd "$(dirname "$0")/.."
KEY=$(grep -E '^INDEXNOW_KEY=' .env | cut -d= -f2-)
[ -n "$KEY" ] || { echo "INDEXNOW_KEY missing in .env"; exit 2; }
if [ $# -gt 0 ]; then URLS=("$@"); else
  mapfile -t URLS < <(for sm in sitemap-0.xml sitemap-blog.xml; do curl -s -A "underwings-indexnow" "https://underwings.org/$sm" | grep -oE '<loc>[^<]+' | sed 's/<loc>//'; done | sort -u)
fi
[ ${#URLS[@]} -gt 0 ] || { echo "no URLs"; exit 1; }
BODY=$(printf '%s\n' "${URLS[@]}" | python3 -c 'import sys,json; print(json.dumps({"host":"underwings.org","key":sys.argv[1],"keyLocation":"https://underwings.org/"+sys.argv[1]+".txt","urlList":[l.strip() for l in sys.stdin if l.strip()]}))' "$KEY")
CODE=$(curl -s -o /tmp/indexnow.out -w '%{http_code}' -X POST https://api.indexnow.org/indexnow -H 'Content-Type: application/json; charset=utf-8' --data "$BODY")
echo "$(date -u +%FT%TZ) indexnow: ${#URLS[@]} urls → HTTP $CODE $(head -c 200 /tmp/indexnow.out)"
[ "$CODE" = "200" ] || [ "$CODE" = "202" ]
