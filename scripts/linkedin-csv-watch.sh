#!/usr/bin/env bash
# Every 5 minutes: import any LinkedIn lead CSV dropped into inbox/linkedin/
# (Page → Analytics → Leads → Download, or Campaign Manager export) into Zoho CRM,
# then move it to done/ or failed/. The 15-minute linkedin-sync mirrors the new
# Leads into Supabase and emails the team.
set -u
cd "$(dirname "$0")/.."
shopt -s nullglob
for f in inbox/linkedin/*.csv inbox/linkedin/*.CSV; do
  name=$(basename "$f"); ts=$(date -u +%Y%m%dT%H%M%SZ)
  out=$(docker run --rm -v "$PWD/frontend:/app" -v "$PWD/inbox/linkedin:/inbox" -w /app --env-file .env node:24-alpine node scripts/linkedin-csv-import.mjs "/inbox/$name" 2>&1)
  rc=$?
  echo "$ts $name rc=$rc"; echo "$out" | tail -n 20
  if [ $rc -eq 0 ]; then mv "$f" "inbox/linkedin/done/$ts-$name"; else mv "$f" "inbox/linkedin/failed/$ts-$name"; fi
done
