#!/usr/bin/env bash
# ===========================================
# SMOKE TESTS — Underwings Portfolio
# Run against the running Docker Compose stack
# Usage: bash tests/smoke.sh [BASE_URL]
# ===========================================

set -euo pipefail

BASE="${1:-http://localhost:8080}"
PASS=0
FAIL=0

TMPFILE=$(mktemp)
trap "rm -f $TMPFILE" EXIT

check() {
  local desc="$1"
  local url="$2"
  local expected_status="${3:-200}"
  local grep_pattern="${4:-}"

  local status
  status=$(curl -s -o "$TMPFILE" -w "%{http_code}" "$url" 2>/dev/null)

  if [ "$status" != "$expected_status" ]; then
    echo "  FAIL  $desc — expected $expected_status, got $status"
    FAIL=$((FAIL + 1))
    return
  fi

  if [ -n "$grep_pattern" ] && ! grep -q "$grep_pattern" "$TMPFILE"; then
    echo "  FAIL  $desc — missing pattern: $grep_pattern"
    FAIL=$((FAIL + 1))
    return
  fi

  echo "  PASS  $desc"
  PASS=$((PASS + 1))
}

check_post() {
  local desc="$1"
  local url="$2"
  local data="$3"
  local expected_status="${4:-200}"
  local grep_pattern="${5:-}"

  local status
  status=$(curl -s -o "$TMPFILE" -w "%{http_code}" -X POST -H "Content-Type: application/json" -d "$data" "$url" 2>/dev/null)

  if [ "$status" != "$expected_status" ]; then
    echo "  FAIL  $desc — expected $expected_status, got $status"
    FAIL=$((FAIL + 1))
    return
  fi

  if [ -n "$grep_pattern" ] && ! grep -q "$grep_pattern" "$TMPFILE"; then
    echo "  FAIL  $desc — missing pattern: $grep_pattern"
    FAIL=$((FAIL + 1))
    return
  fi

  echo "  PASS  $desc"
  PASS=$((PASS + 1))
}

echo "Smoke Tests — $BASE"
echo "=========================="

echo ""
echo "Pages:"
check "Homepage returns 200" "$BASE/"
check "Homepage has hreflang" "$BASE/" 200 "hreflang"
check "Homepage has og:image:width" "$BASE/" 200 "og:image:width"
check "Homepage has cookie consent" "$BASE/" 200 "uw-cookie-banner"
check "VAPT service page" "$BASE/services/vapt"
check "ISO 27001 service page" "$BASE/services/iso-27001"
check "Training service page" "$BASE/services/training"
check "Consultation service page" "$BASE/services/consultation"
check "Blog index" "$BASE/blog"
check "About page" "$BASE/about"
check "Arabic landing page" "$BASE/ar"
check "Arabic page has og:image:width" "$BASE/ar" 200 "og:image:width"
check "Privacy policy" "$BASE/privacy-policy"
check "Brand guidelines" "$BASE/brand"
check "Software page" "$BASE/software"
check "Updates page" "$BASE/updates"
check "Careers page" "$BASE/careers"
check "Client portal page" "$BASE/portal"
# 404 test skipped — Astro SSR in hybrid mode hangs on unmatched routes through nginx proxy
# TODO: Fix 404 routing in Astro/nginx config
# check "404 page" "$BASE/nonexistent-page-12345" 404
check "RSS feed" "$BASE/rss.xml" 200 "rss"

echo ""
echo "API Endpoints:"
check_post "Chat API — valid message" "$BASE/api/chat" '{"messages":[{"role":"user","content":"hi"}]}' 200 "reply"
check_post "Chat API — empty messages" "$BASE/api/chat" '{"messages":[]}' 400 "error"
check_post "Chat API — invalid format" "$BASE/api/chat" '{"messages":"bad"}' 400 "error"
check_post "Chat API — too many messages" "$BASE/api/chat" "$(python3 -c "import json; print(json.dumps({'messages':[{'role':'user','content':'hi'}]*51}))")" 400 "Too many"
check_post "Chat API — message too long" "$BASE/api/chat" "$(python3 -c "import json; print(json.dumps({'messages':[{'role':'user','content':'x'*2001}]}))")" 400 "too long"
check_post "Chat API — invalid role" "$BASE/api/chat" '{"messages":[{"role":"system","content":"hi"}]}' 400 "Invalid role"
check_post "Newsletter API — missing email" "$BASE/api/newsletter" '{}' 400 "email"
check_post "Newsletter API — invalid email" "$BASE/api/newsletter" '{"email":"notanemail"}' 400 "email"
# With Turnstile enabled, requests without a valid token get 403
check_post "Newsletter API — no CAPTCHA token" "$BASE/api/newsletter" '{"email":"test@example.com"}' 403 "CAPTCHA"

echo ""
echo "CRM (crm.underwings.org):"
check "CRM healthz" "https://crm.underwings.org/healthz" 200 "underwings-crm ok"
check "CRM app shell serves the LeadGen view" "https://crm.underwings.org/" 200 'data-crm-view="leadgen"'
check "CRM app shell serves the Partners view" "https://crm.underwings.org/" 200 'data-crm-view="partners"'
# RLS regression guard: the anon key is public by design, so an anon read of a
# crm_* table MUST come back as an empty array — not a row, not an error.
CRM_ANON=$(curl -s "https://crm.underwings.org/env.js" | sed -n "s/.*SUPABASE_ANON_KEY *= *['\"]\([^'\"]*\).*/\1/p")
if [ -n "$CRM_ANON" ]; then
  body=$(curl -s "https://crm.underwings.org/rest/v1/crm_prospects?select=company_name" \
    -H "apikey: $CRM_ANON" -H "Authorization: Bearer $CRM_ANON")
  if [ "$body" = "[]" ]; then
    echo "  PASS  CRM prospects are not readable anonymously"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  CRM prospects leaked to anon — got: ${body:0:120}"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  FAIL  could not read the CRM anon key from env.js"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "Security Headers:"
headers=$(curl -sI "$BASE/")
for header in "X-Frame-Options" "X-Content-Type-Options" "Referrer-Policy"; do
  if echo "$headers" | grep -qi "$header"; then
    echo "  PASS  $header header present"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $header header missing"
    FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "=========================="
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "All tests passed!" || exit 1
